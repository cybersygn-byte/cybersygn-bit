/**
 * Affiliate program.
 *
 * Solo SaaS rocket fuel. Existing customers get a unique referral URL
 * like `https://cybersygn.io/?ref=abc123` (where `abc123` is their
 * affiliateCode). The visitor's browser stores ?ref in a cookie + the
 * client passes it as Stripe checkout metadata. When the resulting
 * subscription is created, the webhook attributes the conversion.
 *
 * Payout: $20 per converted (first-paid-month) subscription. Tracked
 * in KV under affiliate:<code>:<docId> records so we never double-pay.
 *
 * Surface:
 *   POST /api/affiliate/register  → mint code for a sender (idempotent)
 *   GET  /api/affiliate/:code     → public stats (clicks, conversions)
 *   GET  /api/affiliate/me        → my dashboard (owner of the code)
 *
 * Cookie:
 *   `cybersygn_ref=<code>` for 60 days. Set by client-side script
 *   when the visitor lands on cybersygn.io/?ref=...
 *
 * Stripe attribution:
 *   The /api/checkout/create-session handler includes
 *   `metadata: {ref: <code>}` so the resulting subscription carries
 *   the referrer through every webhook payload.
 */

import { sha256Hex } from './audit.js';

const KV_PREFIX = 'affiliate:';
const PAYOUT_USD = 20;
const COOKIE_DAYS = 60;
const CODE_LEN = 8;  // base36 chars; ~2.8 trillion address space

// ---- Code minting ---------------------------------------------------------

function randomCode() {
  // base36 8 chars from a random Uint8Array. Strong enough for non-
  // sensitive identifiers; collisions are vanishingly rare.
  const buf = new Uint8Array(8);
  crypto.getRandomValues(buf);
  let out = '';
  for (let i = 0; i < CODE_LEN; i++) {
    out += (buf[i] % 36).toString(36);
  }
  return out;
}

function isValidCode(s) {
  return typeof s === 'string' && /^[a-z0-9]{4,16}$/.test(s);
}

// ---- Registration ---------------------------------------------------------

/**
 * Register (or look up) an affiliate code for a senderId. Idempotent:
 * the same senderId always returns the same code.
 */
export async function registerAffiliate(env, { senderId, email }) {
  if (!env || !env.CYBERSYGN_DOCS) return { ok: false, error: 'kv_unavailable' };
  if (!senderId) return { ok: false, error: 'missing_sender' };

  // Map sender -> code (so a known sender returns their existing code).
  const senderKey = `${KV_PREFIX}sender:${senderId}`;
  try {
    const existing = await env.CYBERSYGN_DOCS.get(senderKey);
    if (existing) {
      const code = existing.trim();
      const rec = await loadCode(env, code);
      if (rec) return { ok: true, code, record: rec, isNew: false };
    }
  } catch (e) {}

  // Mint a fresh code with a small collision check.
  let code = randomCode();
  for (let attempt = 0; attempt < 5; attempt++) {
    const claim = await env.CYBERSYGN_DOCS.get(`${KV_PREFIX}code:${code}`);
    if (!claim) break;
    code = randomCode();
  }
  const now = new Date().toISOString();
  const record = {
    v: 1,
    code,
    senderId,
    email: typeof email === 'string' ? email.trim().slice(0, 320) : '',
    createdAt: now,
    clicks: 0,
    signups: 0,
    conversions: 0,
    earnedUsd: 0,
    payouts: [],  // [{ amount, paidAt, method }]
  };
  await env.CYBERSYGN_DOCS.put(`${KV_PREFIX}code:${code}`, JSON.stringify(record));
  await env.CYBERSYGN_DOCS.put(senderKey, code);
  return { ok: true, code, record, isNew: true };
}

async function loadCode(env, code) {
  if (!env || !env.CYBERSYGN_DOCS || !isValidCode(code)) return null;
  try {
    const raw = await env.CYBERSYGN_DOCS.get(`${KV_PREFIX}code:${code}`);
    if (!raw) return null;
    return JSON.parse(raw);
  } catch (e) { return null; }
}

// ---- Counters -------------------------------------------------------------

/**
 * Increment the click counter for an affiliate code. Public — fired
 * when a visitor lands with ?ref=<code>. Cheap KV read + write.
 */
export async function bumpClick(env, code) {
  if (!isValidCode(code)) return;
  const rec = await loadCode(env, code);
  if (!rec) return;
  rec.clicks = (rec.clicks || 0) + 1;
  rec.lastClickAt = new Date().toISOString();
  try { await env.CYBERSYGN_DOCS.put(`${KV_PREFIX}code:${code}`, JSON.stringify(rec)); } catch (e) {}
}

/**
 * Mark a signup attributed to this affiliate. Called by /api/free/signup
 * when the request carries a ref code.
 */
export async function bumpSignup(env, code) {
  if (!isValidCode(code)) return;
  const rec = await loadCode(env, code);
  if (!rec) return;
  rec.signups = (rec.signups || 0) + 1;
  rec.lastSignupAt = new Date().toISOString();
  try { await env.CYBERSYGN_DOCS.put(`${KV_PREFIX}code:${code}`, JSON.stringify(rec)); } catch (e) {}
}

/**
 * Mark a paid conversion. Called by the Stripe webhook when a subscription
 * is created with metadata.ref set. Idempotent on (code, customerId) so
 * a customer's renewals don't double-credit.
 */
export async function recordConversion(env, code, customerId, tier) {
  if (!isValidCode(code)) return { ok: false, error: 'invalid_code' };
  if (!customerId) return { ok: false, error: 'missing_customer' };
  const dedupeKey = `${KV_PREFIX}conv:${code}:${customerId}`;
  try {
    const seen = await env.CYBERSYGN_DOCS.get(dedupeKey);
    if (seen) return { ok: true, alreadyCounted: true };
  } catch (e) {}
  const rec = await loadCode(env, code);
  if (!rec) return { ok: false, error: 'unknown_code' };
  rec.conversions = (rec.conversions || 0) + 1;
  rec.earnedUsd = (rec.earnedUsd || 0) + PAYOUT_USD;
  rec.lastConversionAt = new Date().toISOString();
  try {
    await env.CYBERSYGN_DOCS.put(`${KV_PREFIX}code:${code}`, JSON.stringify(rec));
    await env.CYBERSYGN_DOCS.put(dedupeKey, JSON.stringify({ at: new Date().toISOString(), tier }), {
      expirationTtl: 60 * 60 * 24 * 365 * 5,
    });
  } catch (e) {}
  return { ok: true, alreadyCounted: false, payoutUsd: PAYOUT_USD };
}

// ---- Public read endpoints ------------------------------------------------

export async function getCodeStats(env, code) {
  const rec = await loadCode(env, code);
  if (!rec) return { ok: false, error: 'not_found' };
  return {
    ok: true,
    code: rec.code,
    clicks: rec.clicks || 0,
    signups: rec.signups || 0,
    conversions: rec.conversions || 0,
    earnedUsd: rec.earnedUsd || 0,
    createdAt: rec.createdAt,
  };
}

export const __forTests = {
  randomCode,
  isValidCode,
  PAYOUT_USD,
  COOKIE_DAYS,
  KV_PREFIX,
};
