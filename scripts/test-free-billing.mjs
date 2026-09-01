/**
 * One document costs one free credit.
 *
 * A free account has three documents for life. Downloading a signed PDF and
 * sending that same document for signature are two separate calls into
 * freeConsume, and each one burned a credit, so a single piece of work cost a
 * THIRD of the lifetime allowance and three credits bought one and a half
 * documents.
 *
 * The client had already been written for the fix: web/preview/app.js sends
 * X-CyberSygn-Doc-Sha on the download path and its comment describes settling
 * both paths against a free-doc:<emailHash>:<sha256> marker. Only the server
 * half was missing, so the header was sent to an endpoint that ignored it.
 *
 * The identity is the SHA-256 of the original PDF bytes, which is also how the
 * client derives docState.docId. On the create path the Worker computes it from
 * the bytes it was handed rather than reading it from the body, so a caller
 * cannot claim a document was already paid for.
 */
import assert from 'node:assert';
import { freeSignup, freeConsume } from '../worker/src/free-tier.js';

let pass = 0, fail = 0; const out = [];
async function t(name, fn) {
  try { await fn(); out.push('OK   ' + name); pass++; }
  catch (e) { out.push('FAIL ' + name + '\n     ' + e.message); fail++; }
}

function mkEnv() {
  const kv = new Map();
  const st = {
    get: async (k, ty) => { const v = kv.get(k); if (v == null) return null; return (ty === 'json' || (ty && ty.type === 'json')) ? JSON.parse(v) : v; },
    put: async (k, v) => { kv.set(k, typeof v === 'string' ? v : JSON.stringify(v)); },
    delete: async (k) => kv.delete(k),
    list: async () => ({ keys: [], list_complete: true }),
  };
  return { env: { CYBERSYGN_DOCS: st, CYBERSYGN_PDFS: st }, kv };
}
const sha = (c) => c.repeat(64);
async function signup(env) {
  return (await freeSignup(env, { email: 'a@b.com', firstName: 'A', lastName: 'B', consent: true })).freeToken;
}

await t('download then send of ONE document costs ONE credit', async () => {
  const { env } = mkEnv();
  const tok = await signup(env);
  const first = await freeConsume(env, tok, sha('a'));
  assert.equal(first.used, 1);
  assert.ok(!first.deduped, 'the first call pays');
  const second = await freeConsume(env, tok, sha('a'));
  assert.equal(second.ok, true);
  assert.equal(second.deduped, true, 'the second call on the same document is free');
  assert.equal(second.used, 1, 'and must not advance the counter');
});

await t('three documents still fit, and a fourth is refused', async () => {
  const { env } = mkEnv();
  const tok = await signup(env);
  for (const c of ['a', 'b', 'c']) {
    assert.equal((await freeConsume(env, tok, sha(c))).ok, true, `document ${c} must be allowed`);
    assert.equal((await freeConsume(env, tok, sha(c))).deduped, true, `document ${c} must settle once`);
  }
  const fourth = await freeConsume(env, tok, sha('d'));
  assert.equal(fourth.ok, false, 'the cap must still hold');
  assert.equal(fourth.error, 'free_cap_reached');
  assert.equal(fourth.used, 3, 'exactly three documents were paid for');
});

await t('DIFFERENT documents are billed separately', async () => {
  // The dedup must key on the document, not merely on "seen before".
  const { env } = mkEnv();
  const tok = await signup(env);
  assert.equal((await freeConsume(env, tok, sha('a'))).used, 1);
  assert.equal((await freeConsume(env, tok, sha('b'))).used, 2, 'a different document costs its own credit');
});

await t('a missing or malformed sha still bills, it never grants a free pass', async () => {
  // Fail toward charging. An unkeyed document that deduped against a shared
  // sentinel would let every later document download free.
  const { env } = mkEnv();
  const tok = await signup(env);
  assert.equal((await freeConsume(env, tok, null)).used, 1);
  assert.equal((await freeConsume(env, tok, null)).used, 2, 'no sha means no dedup');
  assert.equal((await freeConsume(env, tok, 'not-a-sha')).used, 3, 'a malformed sha must not dedup either');
});

await t('the marker is scoped to the user, not global', async () => {
  const { env } = mkEnv();
  const tok1 = await signup(env);
  await freeConsume(env, tok1, sha('a'));
  const tok2 = (await freeSignup(env, { email: 'c@d.com', firstName: 'C', lastName: 'D', consent: true })).freeToken;
  const other = await freeConsume(env, tok2, sha('a'));
  assert.ok(!other.deduped, 'another user signing the same document pays their own credit');
  assert.equal(other.used, 1);
});

console.log(out.join('\n'));
console.log(`\nfree billing: ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
