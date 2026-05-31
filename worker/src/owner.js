/**
 * Owner backdoor.
 *
 * The owner phrase is never stored in source. At deploy time the owner sets
 *
 *   wrangler secret put CYBERSYGN_OWNER_HASH
 *
 * and pastes the SHA-256 hex digest of their chosen phrase. The Worker
 * compares candidate phrases against this hash in constant time. On match,
 * it mints a long-lived owner token (32 bytes hex) and persists it in KV
 * under the key `owner:token:<token>` with a 365-day TTL.
 *
 * Owner tokens carry an `unmetered: true` flag that the rest of the Worker
 * checks before applying tier limits. The client stores the token in
 * localStorage under `cybersygn.owner.token` and includes it in
 * `X-CyberSygn-Owner` headers on every authenticated request.
 *
 * If CYBERSYGN_OWNER_HASH is unset, a dev fallback hash is used so local
 * development works. The dev hash corresponds to a phrase printed in
 * DEPLOY.md; rotate it before going to production.
 */

import { sha256Hex } from './audit.js';

// Dev fallback: SHA-256 of "cybersygn-dev-owner". Documented in DEPLOY.md.
// Production owners MUST override this via the CYBERSYGN_OWNER_HASH secret.
const DEV_OWNER_HASH = 'db4620902e87f722ffe92d06b1d013e58a09aacceae9fce7899456da072698b5';

const TOKEN_BYTES = 32;
const TOKEN_TTL_SECONDS = 60 * 60 * 24 * 365;  // 365 days

// Process-lifetime token store. Used when KV bindings are unavailable
// (local dev, tests). Resets when the Worker restarts; production
// always reads through the KV namespace.
const memoryOwnerTokens = new Map();

function constantTimeEquals(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

function randomTokenHex(byteLength = TOKEN_BYTES) {
  const buf = new Uint8Array(byteLength);
  crypto.getRandomValues(buf);
  return Array.from(buf, (b) => b.toString(16).padStart(2, '0')).join('');
}

function expectedHash(env) {
  if (env && typeof env.CYBERSYGN_OWNER_HASH === 'string' && env.CYBERSYGN_OWNER_HASH.length === 64) {
    return env.CYBERSYGN_OWNER_HASH.toLowerCase();
  }
  return DEV_OWNER_HASH;
}

/**
 * Hash a candidate phrase and constant-time compare against the configured
 * owner hash. Returns true on match.
 */
export async function isOwnerPhrase(candidate, env) {
  if (typeof candidate !== 'string' || candidate.length === 0) return false;
  if (candidate.length > 256) return false;
  const bytes = new TextEncoder().encode(candidate);
  const candidateHash = await sha256Hex(bytes);
  return constantTimeEquals(candidateHash, expectedHash(env));
}

/**
 * Mint a fresh owner token. Persists it in KV so future requests carrying
 * the token validate without re-hashing the phrase.
 */
export async function issueOwnerToken(env) {
  const token = randomTokenHex();
  const record = {
    token,
    issuedAt: new Date().toISOString(),
    unmetered: true,
    role: 'owner',
  };
  const serialized = JSON.stringify(record);
  const docsBinding = env && (env.CYBERSYGN_DOCS);
  if (docsBinding && typeof docsBinding.put === 'function') {
    try {
      await docsBinding.put(
        `owner:token:${token}`,
        serialized,
        { expirationTtl: TOKEN_TTL_SECONDS },
      );
    } catch (err) {
      // KV unavailable: fall back to memory.
      memoryOwnerTokens.set(token, serialized);
    }
  } else {
    memoryOwnerTokens.set(token, serialized);
  }
  return record;
}

/**
 * Validate a candidate owner token. Returns the record on success,
 * null otherwise. Caller passes the token as a header on every request
 * (X-CyberSygn-Owner) or as a query param (?owner=token).
 */
export async function validateOwnerToken(token, env) {
  if (typeof token !== 'string' || token.length !== TOKEN_BYTES * 2) return null;
  if (!/^[a-f0-9]+$/.test(token)) return null;
  let raw = null;
  const docsBinding = env && (env.CYBERSYGN_DOCS);
  if (docsBinding && typeof docsBinding.get === 'function') {
    try {
      raw = await docsBinding.get(`owner:token:${token}`);
    } catch (err) {
      raw = null;
    }
  }
  if (!raw) {
    raw = memoryOwnerTokens.get(token) || null;
  }
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    if (parsed && parsed.unmetered) return parsed;
  } catch (err) {
    return null;
  }
  return null;
}

/**
 * Extract owner token from a request, checking the header first then the
 * URL query string. Returns null if no token present.
 */
export function extractOwnerToken(request, url) {
  const header = request.headers.get('x-cybersygn-owner')
              || request.headers.get('X-CyberSygn-Owner');
  if (header && header.length === TOKEN_BYTES * 2) return header;
  if (url && url.searchParams) {
    const qp = url.searchParams.get('owner');
    if (qp && qp.length === TOKEN_BYTES * 2) return qp;
  }
  return null;
}

/**
 * Top-level helper used by route handlers: does this request carry a
 * valid owner token? Returns the owner record (truthy) or null.
 */
export async function getOwnerForRequest(request, env, url) {
  const token = extractOwnerToken(request, url);
  if (!token) return null;
  return await validateOwnerToken(token, env);
}

/**
 * Username + password login for the /control/ portal. Compares
 * username against env.OWNER_USERNAME, and sha256(username + ':' +
 * password + ':' + salt) against env.OWNER_PASSWORD_HASH where the
 * salt is env.OWNER_PASSWORD_SALT (public). On match, mints the
 * same long-lived token that the URL-phrase activation issues, so
 * downstream auth (getOwnerForRequest) doesn't need a separate path.
 *
 * If OWNER_USERNAME or OWNER_PASSWORD_HASH is unset, the login
 * endpoint refuses every attempt with 503 'login_not_configured'.
 */
export async function loginWithCredentials(username, password, env) {
  if (!env || !env.OWNER_USERNAME || !env.OWNER_PASSWORD_HASH) {
    return { ok: false, error: 'login_not_configured' };
  }
  if (typeof username !== 'string' || username.length === 0 || username.length > 64) {
    return { ok: false, error: 'invalid_username' };
  }
  if (typeof password !== 'string' || password.length === 0 || password.length > 256) {
    return { ok: false, error: 'invalid_password' };
  }
  if (!constantTimeEquals(username, env.OWNER_USERNAME)) {
    return { ok: false, error: 'invalid_credentials' };
  }
  const salt = (env.OWNER_PASSWORD_SALT || '').slice(0, 64);
  const candidate = username + ':' + password + ':' + salt;
  const bytes = new TextEncoder().encode(candidate);
  const hash = await sha256Hex(bytes);
  if (!constantTimeEquals(hash, env.OWNER_PASSWORD_HASH.toLowerCase())) {
    return { ok: false, error: 'invalid_credentials' };
  }
  const record = await issueOwnerToken(env);
  return { ok: true, token: record.token, issuedAt: record.issuedAt };
}

export const __forTests = {
  DEV_OWNER_HASH,
  constantTimeEquals,
};
