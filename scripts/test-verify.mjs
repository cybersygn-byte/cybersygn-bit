/**
 * Verify-record tests.
 *
 * The audit certificate now tells a counterparty "check EITHER fingerprint at
 * cybersygn.io/verify". That sentence is only true if both hashes actually
 * resolve, and until now nothing tested that: check-integrity.mjs greps
 * verify.js for the string "signedSha256", which passes whether or not the
 * lookup works. A promise printed on the trust surface deserves a behavioural
 * test, not a grep.
 */
import assert from 'node:assert';
import { writeVerifyRecord, getVerifyRecord, isValidFingerprint } from '../worker/src/verify.js';

let pass = 0, fail = 0; const out = [];
async function t(name, fn) {
  try { await fn(); out.push('OK   ' + name); pass++; }
  catch (e) { out.push('FAIL ' + name + '\n     ' + e.message); fail++; }
}

const ORIG = 'a'.repeat(64);
const SIGNED = 'b'.repeat(64);

function makeEnv({ failOn = null } = {}) {
  const kv = new Map();
  return {
    CYBERSYGN_DOCS: {
      /* Cloudflare KV's real signature is get(key, type) where type is the
         STRING 'json' | 'text' | 'arrayBuffer'. Mocking it as an options
         object silently returns the raw string and every field reads
         undefined, which looks exactly like a broken lookup. */
      get: async (k, type) => {
        const v = kv.get(k);
        if (v == null) return null;
        return type === 'json' ? (typeof v === 'string' ? JSON.parse(v) : v) : v;
      },
      put: async (k, v) => {
        if (failOn && k.includes(failOn)) throw new Error('kv down');
        kv.set(k, typeof v === 'string' ? v : JSON.stringify(v));
      },
      delete: async (k) => { kv.delete(k); },
      list: async ({ prefix } = {}) => ({ keys: [...kv.keys()].filter(k => !prefix || k.startsWith(prefix)).map(name => ({ name })), list_complete: true }),
    },
    CYBERSYGN_PDFS: { get: async () => null, put: async () => {}, delete: async () => {}, list: async () => ({ keys: [], list_complete: true }) },
    _kv: kv,
  };
}

const base = { signerCount: 2, createdAt: '2026-08-01T00:00:00Z', completedAt: '2026-08-02T00:00:00Z' };

await t('BOTH fingerprints resolve, which is what the certificate promises', async () => {
  const env = makeEnv();
  assert.strictEqual(await writeVerifyRecord(env, { pdfSha256: ORIG, signedPdfSha256: SIGNED, ...base }), true);
  const a = await getVerifyRecord(env, ORIG);
  const b = await getVerifyRecord(env, SIGNED);
  assert.ok(a, 'original hash did not resolve');
  assert.ok(b, 'signed hash did not resolve');
  assert.strictEqual(a.fingerprint, ORIG);
  assert.strictEqual(b.fingerprint, SIGNED);
});

await t('each record names which FILE it belongs to, so a reader knows what to hash', async () => {
  const env = makeEnv();
  await writeVerifyRecord(env, { pdfSha256: ORIG, signedPdfSha256: SIGNED, ...base });
  assert.strictEqual((await getVerifyRecord(env, ORIG)).kind, 'original');
  assert.strictEqual((await getVerifyRecord(env, SIGNED)).kind, 'signed');
});

await t('a verify record NEVER carries a docId (it would deanonymise the fingerprint)', async () => {
  const env = makeEnv();
  await writeVerifyRecord(env, { pdfSha256: ORIG, signedPdfSha256: SIGNED, ...base, docId: 'doc_secret' });
  for (const h of [ORIG, SIGNED]) {
    const r = await getVerifyRecord(env, h);
    const keys = Object.keys(r).join(',');
    assert.ok(!/docid/i.test(keys), 'record leaked a doc id: ' + keys);
    assert.ok(!JSON.stringify(r).includes('doc_secret'), 'record leaked the doc id value');
  }
});

await t('no signed artifact writes exactly one record, not a placeholder second', async () => {
  const env = makeEnv();
  assert.strictEqual(await writeVerifyRecord(env, { pdfSha256: ORIG, signedPdfSha256: null, ...base }), true);
  assert.ok(await getVerifyRecord(env, ORIG));
  assert.strictEqual(env._kv.size, 1, 'wrote more than one record with no signed artifact');
  assert.strictEqual((await getVerifyRecord(env, ORIG)).signedSha256, null);
});

await t('a degenerate equal-hash pair writes one record, never two contradictory ones', async () => {
  const env = makeEnv();
  await writeVerifyRecord(env, { pdfSha256: ORIG, signedPdfSha256: ORIG, ...base });
  assert.strictEqual(env._kv.size, 1);
});

await t('a junk signed hash is treated as absent, never stored as a fingerprint', async () => {
  const env = makeEnv();
  await writeVerifyRecord(env, { pdfSha256: ORIG, signedPdfSha256: 'not-a-hash', ...base });
  assert.strictEqual(env._kv.size, 1);
  assert.strictEqual((await getVerifyRecord(env, ORIG)).signedSha256, null);
});

await t('v1 records still verify, so already-issued certificates keep working', async () => {
  const env = makeEnv();
  await env.CYBERSYGN_DOCS.put(`verify:${ORIG}`, JSON.stringify({
    v: 1, fingerprint: ORIG, signerCount: 3,
    createdAt: '2026-01-01T00:00:00Z', completedAt: '2026-01-02T00:00:00Z', status: 'completed',
  }));
  const r = await getVerifyRecord(env, ORIG);
  assert.ok(r && r.fingerprint === ORIG && r.signerCount === 3 && r.status === 'completed');
});

await t('an invalid original is refused outright', async () => {
  const env = makeEnv();
  assert.strictEqual(await writeVerifyRecord(env, { pdfSha256: 'nope', ...base }), false);
  assert.strictEqual(env._kv.size, 0);
});

/* THE ONE THAT MATTERS. If only half the pair lands, the certificate still
   prints both fingerprints and tells the holder either will verify. Reporting
   success on a partial write is the failure-as-valid-answer shape: the caller
   is told the promise is backed when half of it is not. */
await t('a HALF-written pair reports failure, not success', async () => {
  const env = makeEnv({ failOn: SIGNED });
  const ok = await writeVerifyRecord(env, { pdfSha256: ORIG, signedPdfSha256: SIGNED, ...base });
  assert.strictEqual(ok, false, 'a partial write reported success; the certificate would promise a fingerprint that does not resolve');
  assert.ok(await getVerifyRecord(env, ORIG), 'the record that did land should still be readable');
  assert.strictEqual(await getVerifyRecord(env, SIGNED), null);
});

await t('isValidFingerprint rejects the shapes an attacker would try', async () => {
  for (const bad of ['', null, undefined, 'A'.repeat(64), 'a'.repeat(63), 'a'.repeat(65), 'a'.repeat(63) + 'g', '../etc', 'a'.repeat(64) + ' ']) {
    assert.strictEqual(isValidFingerprint(bad), false, 'accepted: ' + JSON.stringify(bad));
  }
  assert.strictEqual(isValidFingerprint(ORIG), true);
});

console.log(out.join('\n'));
console.log(`\nverify: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
