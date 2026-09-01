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
import { readFileSync } from 'node:fs';
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

const DL = { mark: true };      // download: reserves a settlement
const SEND = { redeem: true };  // send: redeems one, if the download paid

await t('download then send of ONE document costs ONE credit', async () => {
  const { env } = mkEnv();
  const tok = await signup(env);
  const first = await freeConsume(env, tok, sha('a'), DL);
  assert.equal(first.used, 1);
  assert.ok(!first.deduped, 'the download pays');
  const second = await freeConsume(env, tok, sha('a'), SEND);
  assert.equal(second.ok, true);
  assert.equal(second.deduped, true, 'the send settles against it');
  assert.equal(second.used, 1, 'and must not advance the counter');
});

await t('sending the SAME document repeatedly still costs one credit each', async () => {
  // The settlement has to be one-shot. A permanent "this sha is paid" marker
  // would let one document be sent to counterparty after counterparty forever,
  // so the three-document cap would never bind again: a bigger hole than the
  // double-charge it was meant to close. The money fuzz suite caught exactly
  // this, by posting the same payload four times.
  const { env } = mkEnv();
  const tok = await signup(env);
  for (let i = 1; i <= 3; i++) {
    const r = await freeConsume(env, tok, sha('a'), SEND);
    assert.equal(r.ok, true, `send ${i} must be allowed`);
    assert.equal(r.used, i, `send ${i} must cost its own credit`);
  }
  const fourth = await freeConsume(env, tok, sha('a'), SEND);
  assert.equal(fourth.ok, false, 'the cap must bind on the same document too');
  assert.equal(fourth.error, 'free_cap_reached');
});

await t('three documents still fit, and a fourth is refused', async () => {
  const { env } = mkEnv();
  const tok = await signup(env);
  for (const c of ['a', 'b', 'c']) {
    assert.equal((await freeConsume(env, tok, sha(c), DL)).ok, true, `document ${c} must be allowed`);
    assert.equal((await freeConsume(env, tok, sha(c), SEND)).deduped, true, `document ${c} must settle once`);
  }
  const fourth = await freeConsume(env, tok, sha('d'), DL);
  assert.equal(fourth.ok, false, 'the cap must still hold');
  assert.equal(fourth.error, 'free_cap_reached');
  assert.equal(fourth.used, 3, 'exactly three documents were paid for');
});

await t('DIFFERENT documents are billed separately', async () => {
  const { env } = mkEnv();
  const tok = await signup(env);
  assert.equal((await freeConsume(env, tok, sha('a'), DL)).used, 1);
  assert.equal((await freeConsume(env, tok, sha('b'), DL)).used, 2, 'a different document costs its own credit');
});

await t('a missing or malformed sha still bills, it never grants a free pass', async () => {
  // Fail toward charging. An unkeyed document that settled against a shared
  // sentinel would let every later document go free.
  const { env } = mkEnv();
  const tok = await signup(env);
  assert.equal((await freeConsume(env, tok, null, SEND)).used, 1);
  assert.equal((await freeConsume(env, tok, null, SEND)).used, 2, 'no sha means no settlement');
  assert.equal((await freeConsume(env, tok, 'not-a-sha', SEND)).used, 3, 'a malformed sha must not settle either');
});

await t('the reservation is scoped to the user, not global', async () => {
  const { env } = mkEnv();
  const tok1 = await signup(env);
  await freeConsume(env, tok1, sha('a'), DL);
  const tok2 = (await freeSignup(env, { email: 'c@d.com', firstName: 'C', lastName: 'D', consent: true })).freeToken;
  const other = await freeConsume(env, tok2, sha('a'), SEND);
  assert.ok(!other.deduped, 'another user sending the same document pays their own credit');
  assert.equal(other.used, 1);
});

// ---- AI entitlement --------------------------------------------------------

function aiEnv() {
  const kv = new Map();
  const st = {
    get: async (k, ty) => { const v = kv.get(k); if (v == null) return null; return (ty === 'json' || (ty && ty.type === 'json')) ? JSON.parse(v) : v; },
    put: async (k, v) => { kv.set(k, typeof v === 'string' ? v : JSON.stringify(v)); },
    delete: async (k) => kv.delete(k),
    list: async () => ({ keys: [], list_complete: true }),
  };
  return { env: { CYBERSYGN_DOCS: st, CYBERSYGN_PDFS: st, ANTHROPIC_API_KEY: 'sk-test' }, kv };
}
let ipCounter = 0;
async function draft(worker, env, headers = {}, body = {}) {
  ipCounter += 1;
  return worker.fetch(new Request('https://x/api/draft/generate', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'cf-connecting-ip': `9.9.${Math.floor(ipCounter / 250)}.${ipCounter % 250}`, ...headers },
    body: JSON.stringify({ kind: 'freelance', description: 'Build a website for 5k', ...body }),
  }), env, { waitUntil() {} });
}
function stubProvider() {
  const real = globalThis.fetch;
  globalThis.fetch = async (u) => String(u).includes('anthropic')
    ? new Response(JSON.stringify({ content: [{ type: 'text', text: JSON.stringify({ title: 'Freelance Agreement', body: 'AGREEMENT terms' }) }] }), { status: 200 })
    : new Response('{}', { status: 200 });
  return () => { globalThis.fetch = real; };
}

await t('an anonymous stranger cannot spend the AI budget', async () => {
  // The endpoint ran on an IP rate limit alone: no account, no tier, no
  // identity. Anyone could POST and bill us for an Anthropic call.
  const worker = (await import('../worker/src/index.js')).default;
  const { env } = aiEnv();
  const restore = stubProvider();
  try {
    const res = await draft(worker, env);
    assert.equal(res.status, 402);
    assert.equal((await res.json()).error, 'free_signup_required');
  } finally { restore(); }
});

await t('a free account gets three AI drafts, then is asked to upgrade', async () => {
  const worker = (await import('../worker/src/index.js')).default;
  const { env } = aiEnv();
  const restore = stubProvider();
  try {
    const tok = (await freeSignup(env, { email: 'a@b.com', firstName: 'A', lastName: 'B', consent: true })).freeToken;
    for (let i = 1; i <= 3; i++) {
      const j = await (await draft(worker, env, { 'X-CyberSygn-Free': tok })).json();
      assert.equal(j.ok, true, `draft ${i} must succeed`);
      assert.equal(j.aiUsage.used, i);
    }
    const res = await draft(worker, env, { 'X-CyberSygn-Free': tok });
    assert.equal(res.status, 402);
    const j = await res.json();
    assert.equal(j.error, 'ai_cap_reached');
    assert.ok(j.upgrade && j.upgrade.tiers.includes('pro'), 'and must point at Pro');
  } finally { restore(); }
});

await t('Pro gets the AI co-pilot unmetered, which is what it is sold as', async () => {
  const worker = (await import('../worker/src/index.js')).default;
  const { env, kv } = aiEnv();
  const restore = stubProvider();
  try {
    kv.set('sub:snd_pro', JSON.stringify({ tier: 'pro', status: 'active' }));
    for (let i = 0; i < 5; i++) {
      const j = await (await draft(worker, env, {}, { senderId: 'snd_pro' })).json();
      assert.equal(j.ok, true, 'a Pro subscriber is never capped');
      assert.deepEqual(j.aiUsage, { unmetered: true });
    }
  } finally { restore(); }
});

await t('the draft response is FLAT, which is the shape the page reads', async () => {
  // web/draft/app.js required payload.draft.body, a wrapper the Worker has
  // never sent, so every successful generation fell through to the retry
  // screen and the page never once displayed a draft.
  const worker = (await import('../worker/src/index.js')).default;
  const { env } = aiEnv();
  const restore = stubProvider();
  try {
    const tok = (await freeSignup(env, { email: 'c@d.com', firstName: 'C', lastName: 'D', consent: true })).freeToken;
    const j = await (await draft(worker, env, { 'X-CyberSygn-Free': tok })).json();
    assert.equal(typeof j.body, 'string', 'body must be top level');
    assert.equal(j.draft, undefined, 'there is no draft wrapper');
    // Strip comments first: the fix documents the old wrong shape in prose,
    // and an assertion that cannot tell code from a comment is not an
    // assertion about behaviour.
    const app = readFileSync(new URL('../web/draft/app.js', import.meta.url), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, ' ')
      .replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');
    assert.ok(!/payload\.draft\.body/.test(app), 'the page must not read a wrapper that does not exist');
    assert.ok(/typeof payload\.body === 'string'/.test(app), 'and must read the flat shape the Worker sends');
  } finally { restore(); }
});

await t('a failed generation costs no credit', async () => {
  const worker = (await import('../worker/src/index.js')).default;
  const { env } = aiEnv();
  const real = globalThis.fetch;
  globalThis.fetch = async (u) => String(u).includes('anthropic')
    ? new Response('upstream on fire', { status: 500 })
    : new Response('{}', { status: 200 });
  try {
    const tok = (await freeSignup(env, { email: 'e@f.com', firstName: 'E', lastName: 'F', consent: true })).freeToken;
    await draft(worker, env, { 'X-CyberSygn-Free': tok });
    globalThis.fetch = async (u) => String(u).includes('anthropic')
      ? new Response(JSON.stringify({ content: [{ type: 'text', text: JSON.stringify({ title: 'T', body: 'B' }) }] }), { status: 200 })
      : new Response('{}', { status: 200 });
    const j = await (await draft(worker, env, { 'X-CyberSygn-Free': tok })).json();
    assert.equal(j.aiUsage.used, 1, 'the failed attempt must not have been billed');
  } finally { globalThis.fetch = real; }
});

console.log(out.join('\n'));
console.log(`\nfree billing: ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
