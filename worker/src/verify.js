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
export async function writeVerifyRecord(env, { pdfSha256, signerCount, createdAt, completedAt } = {}) {
  if (!isValidFingerprint(pdfSha256)) return false;

  // Zero PII by construction: only the fingerprint, a count, timestamps, and
  // a fixed status. No name, email, title, or content ever lands here.
  const record = {
    v: 1,
    fingerprint: pdfSha256,
    signerCount: Number.isFinite(signerCount) ? signerCount : 0,
    createdAt: typeof createdAt === 'string' ? createdAt : null,
    completedAt: typeof completedAt === 'string' ? completedAt : null,
    status: 'completed',
  };

  try {
    const storage = getStorage(env);
    // No expirationTtl: verify records are permanent by design (see header).
    await storage.docs.put(`verify:${pdfSha256}`, record);
    return true;
  } catch (e) {
    return false;
  }
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
