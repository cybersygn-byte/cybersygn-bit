/**
 * Cross-device sign-in for CyberSygn senders.
 *
 * Identity is still the localStorage `senderId` capability. This module adds
 * two recovery paths on top of it, so a workspace follows the person across
 * their phone and computer without a password:
 *
 *   1. Sign-in key  - the senderId itself, copied on one device and pasted on
 *      another. Handled entirely client-side (setSenderId); no endpoint here.
 *   2. Email magic link - `POST /api/auth/request-link` emails a single-use
 *      link, `POST /api/auth/verify` exchanges it for a senderId.
 *
 * Trust model: possession of the senderId already equals control of the
 * account. The email->senderId binding is created ONLY at verify time, and
 * ONLY to the senderId presented by the device that proved control of the
 * inbox (the one holding the link). It is never created from an unverified
 * signup and never from a caller-supplied senderId, so an attacker cannot
 * pre-seed a victim's email with the attacker's senderId. Both request-link
 * branches (recover an existing binding, or enroll a new one) do identical
 * work and return an identical body, so neither the response nor its timing
 * reveals whether an account exists.
 *
 * Storage (CYBERSYGN_DOCS):
 *   login:email:<emailHash> -> { v, senderId, boundAt }              (first-bind-wins)
 *   login:token:<token>     -> { v, mode, senderId?, emailHash, exp } (TTL 15m, single-use)
 */

import { sha256Hex } from './audit.js';
import { deliver } from './email.js';
import { getStorage } from './storage.js';
import { checkRateLimit, ipKey, rateLimitedResponse } from './rate-limit.js';

const EMAIL_KEY = 'login:email:';
const TOKEN_KEY = 'login:token:';
const TOKEN_TTL_SECONDS = 15 * 60;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const SENDER_RE = /^[a-f0-9]{24,64}$/i;

// Shared storage abstraction: real KV in production, in-memory Map in dev and
// the test harness. Same surface either way (get supports { json: true }).
function store(env) {
  return getStorage(env).docs;
}

function randomTokenHex(byteLength = 32) {
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
}

async function hashEmail(email) {
  const lower = String(email || '').trim().toLowerCase();
  return sha256Hex(new TextEncoder().encode(lower));
}

/** True when `email` is a plausible address. */
export function isValidAuthEmail(email) {
  const e = String(email || '').trim();
  return e.length >= 3 && e.length <= 200 && EMAIL_RE.test(e);
}

/** True when `senderId` is a well-formed capability token. */
export function isValidSenderId(senderId) {
  return typeof senderId === 'string' && SENDER_RE.test(senderId.trim());
}


/** Bind by emailHash (first-bind-wins). Returns the effective senderId. */
async function bindHashToSender(env, emailHash, senderId) {
  const key = EMAIL_KEY + emailHash;
  const existing = await store(env).get(key, { json: true });
  if (existing && isValidSenderId(existing.senderId)) return existing.senderId;
  await store(env).put(key, { v: 1, senderId: String(senderId).trim(), boundAt: new Date().toISOString() });
  return String(senderId).trim();
}

/**
 * `POST /api/auth/request-link { email }`
 *
 * Emails a single-use link. Two modes, chosen server-side and never revealed:
 *   - the email already owns a workspace  -> a RECOVERY link (verify returns
 *     the bound senderId).
 *   - the email is not bound yet          -> an ENROLL link (verify binds THIS
 *     device's senderId to the email, so the person who proves control of the
 *     inbox is the one whose workspace the email will recover).
 *
 * Both modes do the same work (one read, one write, one email) and return the
 * same body, so neither the response nor its timing reveals whether an account
 * exists. Binding is never created here and never uses a caller-supplied
 * senderId, which is what prevents an attacker from pre-seeding a victim's
 * email with the attacker's own senderId.
 */
export async function handleRequestLink(request, env) {
  const limit = await checkRateLimit(env, `authlink:${ipKey(request)}`, [
    { windowSec: 60 * 15, max: 5 },
    { windowSec: 60 * 60 * 24, max: 20 },
  ]);
  if (!limit.ok) return rateLimitedResponse(limit, { endpoint: '/api/auth/request-link' });

  let email = '';
  try {
    const body = await request.json();
    email = String((body && body.email) || '').trim();
  } catch (e) {}

  const generic = { ok: true, message: 'Check your inbox. If you can receive mail at that address, a sign-in link is on the way.' };
  if (!isValidAuthEmail(email)) return jsonOk(generic);

  try {
    // Per-email limit on top of per-IP so one address cannot be flooded.
    const emailHash = await hashEmail(email);
    const perEmail = await checkRateLimit(env, `authlinkmail:${emailHash.slice(0, 32)}`, [
      { windowSec: 60 * 15, max: 3 },
    ]);
    if (!perEmail.ok) return jsonOk(generic);

    const rec = await store(env).get(EMAIL_KEY + emailHash, { json: true });
    const bound = rec && isValidSenderId(rec.senderId) ? rec.senderId : null;

    const token = randomTokenHex();
    const exp = Date.now() + TOKEN_TTL_SECONDS * 1000;
    const tokenRec = bound
      ? { v: 1, mode: 'recover', senderId: bound, emailHash, exp }
      : { v: 1, mode: 'enroll', emailHash, exp };
    await store(env).put(TOKEN_KEY + token, tokenRec, { expirationTtl: TOKEN_TTL_SECONDS });

    const origin = safeOrigin(request);
    const link = `${origin}/?signin=${token}`;
    await sendSignInEmail(env, { to: email, link, mode: bound ? 'recover' : 'enroll' });
    return jsonOk(generic);
  } catch (e) {
    // Never leak internal failure shape; keep the response uniform.
    return jsonOk(generic);
  }
}

/**
 * `POST /api/auth/verify { token, senderId }`
 *
 * Exchanges a single-use link token for a senderId. RECOVER returns the bound
 * senderId. ENROLL binds the caller-supplied senderId (this device's own,
 * validated) to the email the token proves control of, first-bind-wins, then
 * returns the effective senderId. The token is deleted on use.
 */
export async function handleVerifyLink(request, env) {
  const limit = await checkRateLimit(env, `authverify:${ipKey(request)}`, [
    { windowSec: 60 * 15, max: 30 },
  ]);
  if (!limit.ok) return rateLimitedResponse(limit, { endpoint: '/api/auth/verify' });

  let token = '', senderId = '';
  try {
    const body = await request.json();
    token = String((body && body.token) || '').trim();
    senderId = String((body && body.senderId) || '').trim();
  } catch (e) {}

  if (!/^[a-f0-9]{32,128}$/i.test(token)) {
    return jsonErr(400, 'invalid_token');
  }
  try {
    const key = TOKEN_KEY + token;
    const rec = await store(env).get(key, { json: true });
    if (!rec || (rec.exp && Date.now() > rec.exp)) {
      return jsonErr(400, 'expired_or_used');
    }
    // Single use: best-effort delete before doing anything else.
    try { await store(env).delete(key); } catch (e) {}

    if (rec.mode === 'enroll') {
      if (!isValidSenderId(senderId)) return jsonErr(400, 'need_sender');
      const effective = await bindHashToSender(env, rec.emailHash, senderId);
      return jsonOk({ ok: true, senderId: effective, mode: 'enroll' });
    }
    // recover
    if (!isValidSenderId(rec.senderId)) return jsonErr(400, 'expired_or_used');
    return jsonOk({ ok: true, senderId: rec.senderId, mode: 'recover' });
  } catch (e) {
    return jsonErr(400, 'expired_or_used');
  }
}

// ---------------------------------------------------------------------------

function safeOrigin(request) {
  try {
    const o = new URL(request.url).origin;
    if (/^https:\/\/([a-z0-9-]+\.)*cybersygn\.io$/i.test(o) || /^http:\/\/localhost(:\d+)?$/i.test(o)) {
      return o;
    }
  } catch (e) {}
  return 'https://cybersygn.io';
}

async function sendSignInEmail(env, { to, link, mode }) {
  const enroll = mode === 'enroll';
  const subject = enroll ? 'Confirm your CyberSygn email' : 'Your CyberSygn sign-in link';
  const heading = enroll ? 'Turn on one-tap sign-in' : 'Open your workspace';
  const lede = enroll
    ? 'Tap the button to confirm this email and turn on sign-in for the device you are using now. No password needed.'
    : 'Tap the button to sign in to CyberSygn on this device. No password needed.';
  const text = [
    enroll
      ? 'Tap the link below to confirm this email and turn on one-tap sign-in.'
      : 'Tap the link below to open your CyberSygn workspace on this device.',
    '',
    link,
    '',
    'This link works once and expires in 15 minutes. If you did not ask for it,',
    'you can ignore this email. Nothing changes until you tap it.',
    '',
    'CyberSygn',
  ].join('\n');
  const html = `<!doctype html><html><head><meta charset="utf-8"/><meta name="color-scheme" content="light dark"/>
  <style>.cs-logo-dark{display:none}@media (prefers-color-scheme: dark){body{background:#0A0E1A !important;color:#EAF0FA !important}.cs-logo-light{display:none !important}.cs-logo-dark{display:inline !important}}</style></head>
  <body style="margin:0;background:#F7F8FB;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#0B1B34;">
  <div style="max-width:480px;margin:0 auto;padding:32px 24px;">
    <a href="https://cybersygn.io/" style="text-decoration:none;display:inline-block;margin:0 0 22px;">
      <img class="cs-logo-light" src="https://cybersygn.io/brand/lockup-navy@2x.png" alt="CyberSygn" height="24" style="height:24px;width:auto;border:0;" />
      <img class="cs-logo-dark" src="https://cybersygn.io/brand/lockup-white@2x.png" alt="CyberSygn" height="24" style="height:24px;width:auto;border:0;" />
    </a>
    <p style="font-size:18px;font-weight:600;margin:0 0 8px;">${heading}</p>
    <p style="font-size:15px;line-height:1.5;color:#3A4A63;margin:0 0 24px;">${lede}</p>
    <a href="${link}" style="display:inline-block;background:#0B1B34;color:#fff;text-decoration:none;font-weight:600;font-size:16px;padding:14px 28px;border-radius:12px;">Open CyberSygn</a>
    <p style="font-size:13px;line-height:1.5;color:#6B7A92;margin:24px 0 0;">This link works once and expires in 15 minutes. If you did not ask for it, ignore this email. Nothing changes until you tap it.</p>
  </div></body></html>`;
  return deliver(env, { to, subject, text, html });
}

function jsonOk(body) {
  return jsonResponse(200, body);
}
function jsonErr(status, error) {
  return jsonResponse(status, { ok: false, error });
}

// A local mirror of index.js jsonResponse so auth.js stays self-contained and
// still carries the baseline security headers on every response.
function jsonResponse(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
      'referrer-policy': 'strict-origin-when-cross-origin',
      'x-frame-options': 'DENY',
      'strict-transport-security': 'max-age=31536000; includeSubDomains',
    },
  });
}
