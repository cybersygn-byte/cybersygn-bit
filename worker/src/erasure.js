/**
 * Self-serve erasure. GDPR Article 17, handled by the software, not by a human
 * reading hello@.
 *
 * WHY THIS IS EMAIL-CONFIRMED AND NOT senderId-AUTHENTICATED.
 * senderId lives in localStorage and is sent as a plain field on ordinary API
 * calls. It identifies, it does not authenticate. An endpoint that erased data
 * on a bare senderId would let anyone who ever saw one destroy that person's
 * documents. So erasure proves control of the mailbox instead: request a link,
 * click it, and only then does anything get deleted. That is also the standard
 * shape regulators expect, because it verifies the requester is the data
 * subject before acting on an irreversible request.
 *
 * WHAT SURVIVES, AND WHY IT IS NOT A GDPR PROBLEM.
 * `verify:<sha256>` records are PII-free by construction: a fingerprint of the
 * file, a signer count, and a timestamp. No name, no email, no content, and
 * nothing that can be reversed into any of those. They are kept because a
 * counterparty holding their own copy of a contract must still be able to
 * prove it is genuine, and one party must not be able to destroy the other
 * party's evidence. Erasing the data subject's personal data while keeping an
 * anonymous hash is the outcome Article 17 is designed to produce, not a
 * loophole around it.
 *
 * Billing records are also kept. Retention of invoices has an independent
 * lawful basis (a legal obligation to keep tax records), and Article 17(3)(b)
 * carves it out explicitly.
 */

import { sha256Hex } from './audit.js';

const TOKEN_KEY   = 'erase:token:';
const TOKEN_TTL   = 30 * 60;            // 30 minutes
const RECEIPT_KEY = 'erase:receipt:';
const RECEIPT_TTL = 60 * 60 * 24 * 365; // a year, so a receipt outlives a dispute

function store(env) { return env.CYBERSYGN_DOCS; }

function randomToken() {
  const b = new Uint8Array(32);
  crypto.getRandomValues(b);
  return [...b].map(x => x.toString(16).padStart(2, '0')).join('');
}

/** Normalize an email the same way the rest of the product does. */
export function normalizeEmail(raw) {
  return String(raw || '').trim().toLowerCase();
}

/**
 * MUST match hashEmail() in auth.js and free-tier.js byte for byte, or an
 * erasure request silently resolves to a different identity and deletes
 * nothing while reporting success. Same normalization, same encoding.
 */
export async function emailHashOf(email) {
  return await sha256Hex(new TextEncoder().encode(normalizeEmail(email)));
}

/**
 * Mint a single-use erasure token for a verified mailbox.
 * Returns the token, or null when this email owns nothing (the caller must
 * still answer identically either way, so the endpoint cannot be used to test
 * whether an account exists).
 */
export async function mintErasureToken(env, email, scope) {
  const emailHash = await emailHashOf(email);
  const bound = await store(env).get(`login:email:${emailHash}`, { json: true });
  const freeRec = await store(env).get(`free:${emailHash}`);
  // Nothing to erase: no workspace binding and no free-tier record.
  if (!bound && !freeRec) return null;

  const token = randomToken();
  await store(env).put(TOKEN_KEY + token, JSON.stringify({
    v: 1,
    emailHash,
    senderId: (bound && bound.senderId) || null,
    scope: scope === 'documents' ? 'documents' : 'account',
    createdAt: new Date().toISOString(),
  }), { expirationTtl: TOKEN_TTL });
  return token;
}

/** Consume a token. Single use: it is deleted before any erasure runs. */
export async function consumeErasureToken(env, token) {
  if (typeof token !== 'string' || !/^[a-f0-9]{64}$/.test(token)) return null;
  const key = TOKEN_KEY + token;
  const raw = await store(env).get(key);
  if (!raw) return null;
  // Delete FIRST. If erasure then fails halfway, the user re-requests rather
  // than a live token sitting around able to fire a second destructive run.
  await store(env).delete(key);
  try { return JSON.parse(raw); } catch (e) { return null; }
}

async function safeDelete(kv, key, tally) {
  try { await kv.delete(key); tally.deleted++; }
  catch (e) { tally.errors.push(key); }
}

/**
 * Erase everything personal tied to one identity.
 *
 * Deliberately conservative about what it touches: it walks the sender's own
 * document index rather than scanning by prefix, so a bug here can only ever
 * delete documents that index already claimed belonged to this person.
 */
export async function eraseIdentity(env, { emailHash, senderId, scope }) {
  const kv = store(env);
  const tally = { documents: 0, deleted: 0, keptVerifyRecords: 0, errors: [] };

  // 1. Documents owned by this sender.
  if (senderId) {
    const idx = (await kv.get(`sender:${senderId}:docs`, { json: true })) || { docs: [] };
    for (const docId of (idx.docs || [])) {
      let doc = null;
      try { doc = await kv.get(`doc:${docId}`, { json: true }); } catch (e) {}
      // Ownership re-check. The index is a convenience, not an authority.
      if (doc && doc.senderId && senderId && doc.senderId !== senderId) continue;

      if (doc && doc.pdfSha256) tally.keptVerifyRecords++;  // verify: record stays, it is PII-free
      await safeDelete(kv, `doc:${docId}`, tally);
      await safeDelete(kv, `meta:doc-complete-fired:${docId}`, tally);
      if (env.CYBERSYGN_PDFS) {
        try { await env.CYBERSYGN_PDFS.delete(`pdf:${docId}`); tally.deleted++; } catch (e) { tally.errors.push(`pdf:${docId}`); }
        try { await env.CYBERSYGN_PDFS.delete(`audit:${docId}`); tally.deleted++; } catch (e) { tally.errors.push(`audit:${docId}`); }
      }
      for (const s of ((doc && doc.signers) || [])) {
        await safeDelete(kv, `signer-fills:${docId}:${s.id}`, tally);
      }
      tally.documents++;
    }
    await safeDelete(kv, `sender:${senderId}:docs`, tally);
  }

  if (scope === 'documents') return tally;

  // 2. Account-level personal data.
  if (senderId) {
    await safeDelete(kv, `brand:${senderId}`, tally);
    await safeDelete(kv, `webhook:${senderId}`, tally);
  }
  await safeDelete(kv, `login:email:${emailHash}`, tally);

  // Free-tier record plus every token pointing at it.
  const freeRaw = await kv.get(`free:${emailHash}`);
  if (freeRaw) {
    let rec = null;
    try { rec = JSON.parse(freeRaw); } catch (e) {}
    for (const t of ((rec && rec.tokens) || [])) await safeDelete(kv, `free-tok:${t}`, tally);
    await safeDelete(kv, `free:${emailHash}`, tally);
  }

  return tally;
}

/**
 * Write a PII-FREE receipt. It records that an erasure happened and what it
 * touched, which is what demonstrates compliance, without re-storing the very
 * identifiers the request existed to remove. The emailHash is a one-way digest
 * and is the only linkage kept.
 */
export async function writeErasureReceipt(env, { emailHash, scope, tally }) {
  const id = randomToken().slice(0, 32);
  const receipt = {
    v: 1,
    id,
    emailHash,
    scope,
    documents: tally.documents,
    keysDeleted: tally.deleted,
    verifyRecordsKept: tally.keptVerifyRecords,
    errors: tally.errors.length,
    completedAt: new Date().toISOString(),
  };
  try {
    await store(env).put(RECEIPT_KEY + id, JSON.stringify(receipt), { expirationTtl: RECEIPT_TTL });
  } catch (e) { /* the response still carries the receipt */ }
  return receipt;
}
