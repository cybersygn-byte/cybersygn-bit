/**
 * F4 public verification records.
 *
 * When a document completes, we write a PII-FREE proof record keyed by the
 * SHA-256 fingerprint of the signed PDF. Anyone holding that fingerprint can
 * confirm it matches a completed CyberSygn signing, WITHOUT the record ever
 * exposing a name, email, title, or any document content.
 *
 * What this proves: a document with this exact fingerprint was completed on
 * CyberSygn by this many signers, on these timestamps. It is tamper-evident
 * evidence, NOT a claim of legal validity.
 *
 * Storage: `verify:<pdfSha256>` in the docs namespace (CYBERSYGN_DOCS).
 * Shape: { v:1, fingerprint, signerCount, createdAt, completedAt, status:'completed' }.
 * TTL: NONE. These records are tiny, PII-free by construction, and their
 * entire value is permanence: the homepage stakes the brand on "proof anyone
 * can check", and the audit certificate tells signers the record is retained.
 * A record that quietly evaporates after a year turns that promise into
 * "record not found" for the exact person a certificate exists to protect.
 */

import { getStorage } from './storage.js';
const HEX64 = /^[0-9a-f]{64}$/;

/**
 * True when `hash` is a lowercase 64-char hex string (a SHA-256 digest).
 * The public endpoint uses this to reject junk before touching KV.
 */
export function isValidFingerprint(hash) {
  return typeof hash === 'string' && HEX64.test(hash);
}

/**
 * Best-effort write of a PII-FREE verify record. Callers invoke this from the
 * completion path and MUST NOT let a failure block completion, so this never
 * throws: it returns true on write, false otherwise.
 *
 * @param {object} env
 * @param {object} rec
 * @param {string} rec.pdfSha256   64-hex fingerprint of the signed PDF.
 * @param {number} rec.signerCount number of signers on the completed doc.
 * @param {string} rec.createdAt   ISO timestamp the doc was created.
 * @param {string} rec.completedAt ISO timestamp the doc completed.
 * @returns {Promise<boolean>}
 */
export async function writeVerifyRecord(env, {
  pdfSha256, signedPdfSha256 = null, signerCount, createdAt, completedAt,
} = {}) {
  if (!isValidFingerprint(pdfSha256)) return false;

  // TWO KEYS, TWO NEAR-IDENTICAL RECORDS.
  //
  // A holder of a signed document will hash the file in their hand, which is
  // the SIGNED artifact. A holder of the source will hash the ORIGINAL. Both
  // are legitimate questions and both must resolve, so the record is written
  // under each hash.
  //
  // Two full records rather than an alias pointer: every existing reader
  // (and scripts/test-erasure.mjs) relies on record.fingerprint equalling the
  // hash in its own key, and an alias would add a second KV read on a public
  // endpoint plus a dangling-pointer state where a half-written pair returns
  // "found" with no data. Each record is about 200 bytes and PII-free.
  //
  // The record must NEVER gain a docId: the doc id is a capability that other
  // endpoints accept, so putting one here would turn an anonymous fingerprint
  // into a lookup for signer names and emails.
  const signed = isValidFingerprint(signedPdfSha256) ? signedPdfSha256 : null;
  const base = {
    v: 2,
    signerCount: Number.isFinite(signerCount) ? signerCount : 0,
    createdAt: typeof createdAt === 'string' ? createdAt : null,
    completedAt: typeof completedAt === 'string' ? completedAt : null,
    status: 'completed',
    originalSha256: pdfSha256,
    signedSha256: signed,
  };

  // How many records this pair is SUPPOSED to produce, decided before any
  // write, so the result can be judged against the intent rather than against
  // whatever happened to land.
  const expected = (signed && signed !== pdfSha256) ? 2 : 1;
  const wrote = [];
  try {
    const storage = getStorage(env);
    // No expirationTtl: verify records are permanent by design (see header).
    await storage.docs.put(`verify:${pdfSha256}`, { ...base, fingerprint: pdfSha256, kind: 'original' });
    wrote.push(pdfSha256);
    // Skip when equal, so a degenerate case can never write a contradictory
    // record under the same key.
    if (signed && signed !== pdfSha256) {
      await storage.docs.put(`verify:${signed}`, { ...base, fingerprint: signed, kind: 'signed' });
      wrote.push(signed);
    }
  } catch (e) {
    console.warn('[verify] record write failed', e && e.message);
  }
  // A HALF-WRITTEN PAIR IS A FAILURE, NOT A SUCCESS.
  //
  // The audit certificate prints both fingerprints and tells the holder that
  // either one will verify. If only one record landed, that sentence is false
  // for whichever hash is missing, and returning true would report the promise
  // as backed when half of it is not: a failure presenting itself as a valid
  // answer, on the one surface whose entire job is to be trustworthy.
  //
  // The record that did land is deliberately kept rather than rolled back. It
  // is correct on its own terms, and a counterparty holding that file is
  // better served by a fingerprint that resolves than by neither. The caller
  // gets false so it can retry or log; nothing here silently pretends.
  return wrote.length === expected;
}

/**
 * Read a verify record by fingerprint. Returns the stored record object or
 * null when absent / invalid. Never throws.
 */
export async function getVerifyRecord(env, hash) {
  if (!isValidFingerprint(hash)) return null;
  try {
    const storage = getStorage(env);
    const raw = await storage.docs.get(`verify:${hash}`, { json: true });
    return raw || null;
  } catch (e) {
    return null;
  }
}
