/**
 * API-key authentication + provisioning for the public CyberSygn API (/api/v1/*).
 *
 * Three kinds of key, distinguished by flags on the record:
 *
 *   - metered (default)  — standalone cybersygn.io customers. Document creation
 *                          is gated by the bound account's plan (free cap, etc.).
 *   - unmetered          — issued to a customer who builds on a partner platform
 *                          (e.g. Vyan). Full open access, no free-tier roadblock.
 *                          Individualized: one key per tenant, independently
 *                          attributable + revocable. NOT a shared master key.
 *   - partner master     — `canProvision: true`. Held server-side by the partner
 *                          (Vyan) only. Used to mint the individualized unmetered
 *                          tenant keys above via POST /api/v1/keys. Never shared
 *                          with end users.
 *
 * A key looks like `cs_live_<43 url-safe chars>` (or `cs_test_…`). We store only
 * its SHA-256, so a store dump can't reconstruct a key. Each key is bound to a
 * senderId (the account it acts as), so v1 requests inherit that identity.
 *
 * Storage (getStorage(env).docs — real KV in prod, memory in tests):
 *   apikey:<sha256hex(key)>  -> full record (incl. flags)
 *   apikeys:<senderId>       -> [ public index entries (+hash) ]
 *   apikeys:partner:<pid>    -> [ public index entries for a partner's tenant keys (+hash) ]
 *
 * listApiKeys()/listApiKeysByPartner() strip `hash` before returning.
 */

import { sha256Hex } from './audit.js';
import { getStorage } from './storage.js';

const KEY_PREFIX = 'apikey:';
const INDEX_PREFIX = 'apikeys:';
const PARTNER_PREFIX = 'apikeys:partner:';

function docs(env) {
  try { return getStorage(env).docs; } catch { return null; }
}
function sanitizeId(id) {
  return String(id || '').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 64);
}

function randomToken(bytes = 32) {
  const a = new Uint8Array(bytes);
  crypto.getRandomValues(a);
  let bin = '';
  for (const b of a) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function generateApiKey(mode = 'live') {
  const m = mode === 'test' ? 'test' : 'live';
  return `cs_${m}_${randomToken(32)}`;
}

async function hashKey(key) {
  return sha256Hex(new TextEncoder().encode(String(key)));
}

/**
 * Mint a key for `senderId`. The RAW key is returned exactly once (never
 * persisted in plaintext). Flags:
 *   unmetered    — bypass the free-tier gate on document creation.
 *   canProvision — may mint individualized tenant keys (partner master only).
 *   partnerId    — provenance (e.g. 'vyan'); indexes the key under the partner.
 *   tenantId     — the partner's end-customer; individualizes the key.
 */
export async function createApiKey(env, senderId, opts = {}) {
  const store = docs(env);
  const sid = sanitizeId(senderId);
  if (!store || !sid) return null;

  const { label = 'default', mode = 'live', unmetered = false, canProvision = false,
          partnerId = null, tenantId = null } = opts;
  const key = generateApiKey(mode);
  const hash = await hashKey(key);
  const id = 'key_' + randomToken(8);
  const now = new Date().toISOString();
  const safeMode = mode === 'test' ? 'test' : 'live';
  const pid = partnerId ? sanitizeId(partnerId) : null;

  const rec = {
    id, senderId: sid, label: String(label).slice(0, 80), mode: safeMode,
    unmetered: !!unmetered, canProvision: !!canProvision,
    partnerId: pid, tenantId: tenantId ? String(tenantId).slice(0, 80) : null,
    createdAt: now, lastUsedAt: null, revoked: false,
  };
  await store.put(KEY_PREFIX + hash, rec);

  const pub = {
    id, label: rec.label, mode: safeMode, unmetered: rec.unmetered, canProvision: rec.canProvision,
    partnerId: pid, tenantId: rec.tenantId, senderId: sid, createdAt: now, last4: key.slice(-4),
    revoked: false, hash,
  };
  const idx = (await store.get(INDEX_PREFIX + sid, { json: true })) || [];
  idx.push(pub);
  await store.put(INDEX_PREFIX + sid, idx);

  if (pid) {
    const pidx = (await store.get(PARTNER_PREFIX + pid, { json: true })) || [];
    pidx.push(pub);
    await store.put(PARTNER_PREFIX + pid, pidx);
  }

  return { id, key, mode: safeMode, unmetered: rec.unmetered, canProvision: rec.canProvision,
           partnerId: pid, tenantId: rec.tenantId, last4: key.slice(-4), createdAt: now };
}

/**
 * Authenticate an inbound request by its API key. Returns the resolved key
 * context on success, else null.
 */
export async function authenticateApiKey(request, env) {
  const store = docs(env);
  if (!store) return null;

  let presented = '';
  const auth = request.headers.get('authorization');
  if (auth && /^bearer\s+/i.test(auth)) presented = auth.replace(/^bearer\s+/i, '').trim();
  if (!presented) presented = (request.headers.get('x-api-key') || '').trim();
  if (!presented || !/^cs_(live|test)_[A-Za-z0-9_-]{20,}$/.test(presented)) return null;

  let hash;
  try { hash = await hashKey(presented); } catch { return null; }
  const rec = await store.get(KEY_PREFIX + hash, { json: true });
  if (!rec || rec.revoked || !rec.senderId) return null;

  // NOTE: deliberately do NOT write lastUsedAt here. A KV put on every
  // authenticated request would burn the daily KV write quota fast (and is
  // pure overhead for a partner integration that calls the API constantly).
  // Authentication is a READ-only path.

  return {
    senderId: rec.senderId, keyId: rec.id, mode: rec.mode,
    unmetered: !!rec.unmetered, canProvision: !!rec.canProvision,
    partnerId: rec.partnerId || null, tenantId: rec.tenantId || null,
  };
}

export async function listApiKeys(env, senderId) {
  const store = docs(env);
  const sid = sanitizeId(senderId);
  if (!store || !sid) return [];
  const idx = await store.get(INDEX_PREFIX + sid, { json: true });
  if (!Array.isArray(idx)) return [];
  return idx.map(({ hash, ...pub }) => pub);
}

export async function listApiKeysByPartner(env, partnerId) {
  const store = docs(env);
  const pid = sanitizeId(partnerId);
  if (!store || !pid) return [];
  const idx = await store.get(PARTNER_PREFIX + pid, { json: true });
  if (!Array.isArray(idx)) return [];
  return idx.map(({ hash, ...pub }) => pub);
}

async function flagRevoked(store, idxKey, keyId) {
  const idx = await store.get(idxKey, { json: true });
  if (!Array.isArray(idx)) return null;
  const entry = idx.find(e => e.id === keyId);
  if (!entry) return null;
  entry.revoked = true;
  await store.put(idxKey, idx);
  return entry;
}

/** Revoke by senderId + keyId (owner path). */
export async function revokeApiKey(env, senderId, keyId) {
  const store = docs(env);
  const sid = sanitizeId(senderId);
  if (!store || !sid) return false;
  const entry = await flagRevoked(store, INDEX_PREFIX + sid, keyId);
  if (!entry) return false;
  await markKeyRecordRevoked(store, entry);
  if (entry.partnerId) await flagRevoked(store, PARTNER_PREFIX + sanitizeId(entry.partnerId), keyId);
  return true;
}

/** Revoke a partner-owned tenant key by partnerId + keyId (partner path). */
export async function revokePartnerKey(env, partnerId, keyId) {
  const store = docs(env);
  const pid = sanitizeId(partnerId);
  if (!store || !pid) return false;
  const entry = await flagRevoked(store, PARTNER_PREFIX + pid, keyId);
  if (!entry) return false;
  await markKeyRecordRevoked(store, entry);
  if (entry.senderId) await flagRevoked(store, INDEX_PREFIX + sanitizeId(entry.senderId), keyId);
  return true;
}

async function markKeyRecordRevoked(store, entry) {
  if (!entry.hash) return;
  const rec = await store.get(KEY_PREFIX + entry.hash, { json: true });
  if (rec) { rec.revoked = true; await store.put(KEY_PREFIX + entry.hash, rec); }
}
