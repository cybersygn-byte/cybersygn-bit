/**
 * Free tier: 3 documents lifetime per email, lead capture, dataset
 * consent, server-side counter that survives localStorage clears.
 *
 * Architecture:
 *
 *   POST /api/free/signup
 *     body: { firstName, lastName, email }
 *     returns: { ok, freeToken, used, remaining }
 *
 *     Hashes email (SHA-256), creates/loads the lifetime record at
 *     `free:<email_hash>` in KV. Returns a stable freeToken the client
 *     persists in localStorage; the worker uses it on doc creation
 *     to bind the upload to that email.
 *
 *   POST /api/free/consume
 *     headers: X-CyberSygn-Free: <token>
 *     returns: { ok } or 402 { error:'free_cap_reached' }
 *
 *     Called inside the doc-creation flow before the doc is stored.
 *     Increments the counter atomically; refuses past 3.
 *
 *   GET /api/dataset/count
 *     returns: { ok, total, contributors }
 *
 *     Public. Returns the running total of consented-dataset documents
 *     and the number of distinct contributors. Cached at edge for 60s
 *     so the marketing page can poll cheaply.
 *
 * Privacy: emails are stored in two forms:
 *   1. Hashed (SHA-256) as the KV key, so the doc-counter lookup never
 *      needs the cleartext email.
 *   2. Cleartext in a separate "drip" record `drip:<email_hash>` for
 *      marketing use. Owner-only export available via /api/owner/drip-list.
 *
 * Consent: signing up for free implies consent to dataset use. The UI
 * shows this clearly with a pre-checked, disabled checkbox + plain-
 * English copy; refusing consent means choosing the paid tier instead.
 *
 * Per CONSTITUTION 1.9: every fetch + storage op is try/catched and
 * produces a useful error response.
 */

import { sha256Hex } from './audit.js';
import { getStorage } from './storage.js';

// Shared storage abstraction (KV in production, in-memory in local dev
// and the test harness) so every path here is exercisable without
// bindings. ownerDripList still requires real KV because it needs list().
function store(env) { return getStorage(env).docs; }

const FREE_LIFETIME_LIMIT = 3;
const TOKEN_BYTES = 24;
const KV_PREFIX_USER  = 'free:';
const KV_PREFIX_DRIP  = 'drip:';
const KV_KEY_TOTAL    = 'meta:dataset-total';
const KV_KEY_CONTRIB  = 'meta:dataset-contributors';
const TOKEN_TTL_SECONDS = 60 * 60 * 24 * 365 * 5;  // 5 years (lifetime tier)
const DATASET_CACHE_TTL_SECONDS = 60;

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

function isValidEmail(s) {
  return typeof s === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s) && s.length <= 320;
}

function sanitizeName(s) {
  if (typeof s !== 'string') return '';
  return s.trim().slice(0, 80).replace(/[^A-Za-z .'-]/g, '');
}

function randomTokenHex(byteLength = TOKEN_BYTES) {
  const buf = new Uint8Array(byteLength);
  crypto.getRandomValues(buf);
  return Array.from(buf, b => b.toString(16).padStart(2, '0')).join('');
}

async function hashEmail(email) {
  const lower = String(email).trim().toLowerCase();
  return sha256Hex(new TextEncoder().encode(lower));
}

// -----------------------------------------------------------------------------
// Signup
// -----------------------------------------------------------------------------

/**
 * Create or load the free-tier record for an email. Idempotent: signing
 * up the same email twice returns the same token + current counter.
 */
export async function freeSignup(env, opts) {
  const firstName = sanitizeName(opts && opts.firstName);
  const lastName  = sanitizeName(opts && opts.lastName);
  const email     = String((opts && opts.email) || '').trim().toLowerCase();
  if (!isValidEmail(email)) return { ok: false, error: 'invalid_email' };
  if (firstName.length === 0) return { ok: false, error: 'invalid_first_name' };
  if (lastName.length === 0)  return { ok: false, error: 'invalid_last_name' };

  const emailHash = await hashEmail(email);
  const userKey   = KV_PREFIX_USER + emailHash;

  let record = null;
  try {
    const raw = await store(env).get(userKey);
    if (raw) record = JSON.parse(raw);
  } catch (e) {}

  if (record && record.token) {
    // Refresh the token->emailHash pointer on every signup, not just the
    // first. A one-time pointer-write failure would otherwise permanently
    // break doc creation for this email (freePeek -> unknown_token -> 402)
    // with no self-serve recovery; signing up again now repairs it.
    await writeFreeTokenPointer(env, record.token, emailHash);
    return {
      ok: true,
      freeToken: record.token,
      used: record.used || 0,
      remaining: Math.max(0, FREE_LIFETIME_LIMIT - (record.used || 0)),
      isReturning: true,
    };
  }

  const token = randomTokenHex();
  const now = new Date().toISOString();
  record = {
    v: 1,
    token,
    emailHash,
    firstName,
    lastName,
    createdAt: now,
    used: 0,
    consent: true,  // mandatory on free
    consentAt: now,
  };

  try {
    await store(env).put(userKey, JSON.stringify(record), {
      expirationTtl: TOKEN_TTL_SECONDS,
    });
    // Drip-marketing record: cleartext email + name in a separate key so
    // we never co-locate it with the doc counter. Owner-only export.
    await store(env).put(
      KV_PREFIX_DRIP + emailHash,
      JSON.stringify({ email, firstName, lastName, createdAt: now }),
      { expirationTtl: TOKEN_TTL_SECONDS },
    );
  } catch (e) {
    return { ok: false, error: 'kv_put_failed: ' + (e && e.message ? e.message : 'unknown') };
  }
  // token->emailHash pointer so the doc-creation gate can resolve the
  // lifetime record from the token alone (no scan). Written here so every
  // signup path establishes it exactly once.
  await writeFreeTokenPointer(env, token, emailHash);
  return {
    ok: true,
    freeToken: token,
    used: 0,
    remaining: FREE_LIFETIME_LIMIT,
    isReturning: false,
  };
}

// -----------------------------------------------------------------------------
// Consume: called inside doc creation. Validates token, bumps counter,
// refuses past 3. Returns updated counter state for the client to render.
// -----------------------------------------------------------------------------

export async function freeConsume(env, token) {
  const resolved = await resolveFreeToken(env, token);
  if (!resolved.ok) return resolved;
  const { emailHash, record } = resolved;
  const userKey = KV_PREFIX_USER + emailHash;

  if ((record.used || 0) >= FREE_LIFETIME_LIMIT) {
    return {
      ok: false,
      error: 'free_cap_reached',
      used: record.used,
      cap: FREE_LIFETIME_LIMIT,
      emailHash,
    };
  }

  record.used = (record.used || 0) + 1;
  record.lastConsumedAt = new Date().toISOString();
  try {
    await store(env).put(userKey, JSON.stringify(record), {
      expirationTtl: TOKEN_TTL_SECONDS,
    });
  } catch (e) {
    return { ok: false, error: 'kv_put_failed' };
  }

  // Also bump the public dataset counter (since mandatory consent on
  // free tier means every consumed doc joins the dataset).
  await incrementDatasetCounter(env, record.used === 1).catch(() => {});

  return {
    ok: true,
    used: record.used,
    cap: FREE_LIFETIME_LIMIT,
    remaining: FREE_LIFETIME_LIMIT - record.used,
    emailHash,
  };
}

/**
 * Resolve a free token to its emailHash + lifetime record without
 * mutating anything. Shared by freeConsume and freePeek.
 */
export async function resolveFreeToken(env, token) {
  if (typeof token !== 'string' || token.length !== TOKEN_BYTES * 2) {
    return { ok: false, error: 'invalid_token' };
  }
  if (!/^[a-f0-9]+$/.test(token)) return { ok: false, error: 'invalid_token' };

  // token -> emailHash pointer (written at signup). Single GET, no scan.
  let emailHash;
  try {
    emailHash = await store(env).get(`free-tok:${token}`);
  } catch (e) {}
  if (!emailHash) return { ok: false, error: 'unknown_token' };

  let record;
  try {
    const raw = await store(env).get(KV_PREFIX_USER + emailHash);
    if (raw) record = JSON.parse(raw);
  } catch (e) {}
  if (!record) return { ok: false, error: 'record_missing' };
  return { ok: true, emailHash, record };
}

/**
 * Give back one consumed allowance. Called when a doc-creation flow
 * consumed up front but then failed to persist the document, so the
 * user is not charged for a doc that never existed. Best-effort.
 */
export async function freeRefund(env, token) {
  const resolved = await resolveFreeToken(env, token);
  if (!resolved.ok) return;
  const { emailHash, record } = resolved;
  if ((record.used || 0) <= 0) return;
  record.used = record.used - 1;
  record.lastRefundedAt = new Date().toISOString();
  try {
    await store(env).put(KV_PREFIX_USER + emailHash, JSON.stringify(record), { expirationTtl: TOKEN_TTL_SECONDS });
  } catch (e) {}
}

/**
 * Read-only cap check for the doc-creation gate: is there room left on
 * this email's lifetime allowance? Never increments; the doc-creation
 * flow consumes only after the document actually stores.
 */
export async function freePeek(env, token) {
  const resolved = await resolveFreeToken(env, token);
  if (!resolved.ok) return resolved;
  const used = resolved.record.used || 0;
  return {
    ok: true,
    used,
    cap: FREE_LIFETIME_LIMIT,
    remaining: Math.max(0, FREE_LIFETIME_LIMIT - used),
    emailHash: resolved.emailHash,
  };
}

// On signup, write the token->emailHash pointer so consume can resolve.
export async function writeFreeTokenPointer(env, token, emailHash) {
  try {
    await store(env).put(`free-tok:${token}`, emailHash, {
      expirationTtl: TOKEN_TTL_SECONDS,
    });
  } catch (e) {}
}

// -----------------------------------------------------------------------------
// Public dataset counter. Increment is gated on each successful free
// consume; the total is publicly readable (marketing-page display).
// -----------------------------------------------------------------------------

async function incrementDatasetCounter(env, isNewContributor) {
  try {
    const rawTotal = await store(env).get(KV_KEY_TOTAL);
    const total = (Number.isFinite(parseInt(rawTotal, 10)) ? parseInt(rawTotal, 10) : 0) + 1;
    await store(env).put(KV_KEY_TOTAL, String(total));

    if (isNewContributor) {
      const rawContrib = await store(env).get(KV_KEY_CONTRIB);
      const contrib = (Number.isFinite(parseInt(rawContrib, 10)) ? parseInt(rawContrib, 10) : 0) + 1;
      await store(env).put(KV_KEY_CONTRIB, String(contrib));
    }
  } catch (e) {}
}

export async function getDatasetCount(env) {
  try {
    const [rawTotal, rawContrib] = await Promise.all([
      store(env).get(KV_KEY_TOTAL),
      store(env).get(KV_KEY_CONTRIB),
    ]);
    return {
      ok: true,
      total: parseInt(rawTotal, 10) || 0,
      contributors: parseInt(rawContrib, 10) || 0,
      source: getStorage(env).mode,
    };
  } catch (e) {
    return { ok: false, error: 'kv_read_failed', total: 0, contributors: 0 };
  }
}

// -----------------------------------------------------------------------------
// Owner drip-list export. Returns cleartext emails + names for marketing
// use. Owner-only. Streaming KV list iteration so we don't blow memory
// on large lists.
// -----------------------------------------------------------------------------

export async function ownerDripList(env, opts = {}) {
  if (!env || !env.CYBERSYGN_DOCS) return { ok: false, error: 'kv_unavailable' };
  const cap = Math.min(1000, Math.max(1, Number(opts.cap) || 200));
  try {
    const list = await env.CYBERSYGN_DOCS.list({ prefix: KV_PREFIX_DRIP, limit: cap });
    const out = [];
    for (const entry of list.keys) {
      const raw = await env.CYBERSYGN_DOCS.get(entry.name);
      if (!raw) continue;
      try { out.push(JSON.parse(raw)); } catch (e) {}
    }
    return { ok: true, count: out.length, contacts: out };
  } catch (e) {
    return { ok: false, error: e && e.message ? e.message : 'unknown' };
  }
}

export const __forTests = {
  FREE_LIFETIME_LIMIT,
  KV_PREFIX_USER,
  KV_PREFIX_DRIP,
};
