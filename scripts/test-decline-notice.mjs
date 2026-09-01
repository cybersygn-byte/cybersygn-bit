/**
 * A decline the sender never hears about.
 *
 * Two independent faults made every decline notification silently fail:
 *
 *   1. deliverDeclineNotice was called in index.js but never imported from
 *      email.js. The reference threw a ReferenceError, the surrounding
 *      try/catch swallowed it into a console.error, and senderNotified came
 *      back false. No decline notice had ever been delivered, in any mode.
 *   2. The notify target was chosen with
 *      `signers.find(s => s.id !== signer.id)`, which in single-signer mode
 *      can never match, so even with the import fixed there was nobody to
 *      email. Documents store only senderEmailHash, so the sender's address
 *      is resolved from the drip record.
 *
 * Meanwhile the signing page told the signer "The sender has been notified"
 * unconditionally. Both parties believed the other knew.
 */
import assert from 'node:assert';
import { readFileSync } from 'node:fs';

let pass = 0, fail = 0; const out = [];
async function t(name, fn) {
  try { await fn(); out.push('OK   ' + name); pass++; }
  catch (e) { out.push('FAIL ' + name + '\n     ' + e.message); fail++; }
}

const TOK = 't'.repeat(64), HASH = 'b'.repeat(64);

async function declineWith(signers) {
  const worker = (await import('../worker/src/index.js')).default;
  const sent = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (u, o) => {
    if (String(u).includes('resend')) { sent.push(JSON.parse(o.body)); return new Response(JSON.stringify({ id: 'e1' }), { status: 200 }); }
    return new Response('{}', { status: 200 });
  };
  try {
    const doc = { id: 'd1', title: 'NDA', senderName: 'Sender', senderEmailHash: HASH, senderToken: 's'.repeat(64), signers, events: [] };
    const kv = new Map([['doc:d1', JSON.stringify(doc)], ['drip:' + HASH, JSON.stringify({ email: 'sender@example.com', firstName: 'S' })]]);
    const st = {
      get: async (k, ty) => { const v = kv.get(k); if (v == null) return null; return ty === 'json' ? JSON.parse(v) : v; },
      put: async (k, v) => { kv.set(k, typeof v === 'string' ? v : JSON.stringify(v)); },
      delete: async (k) => kv.delete(k),
      list: async () => ({ keys: [], list_complete: true }),
    };
    const env = { CYBERSYGN_DOCS: st, CYBERSYGN_PDFS: st, RESEND_API_KEY: 're_test', CYBERSYGN_FROM: 'hello@cybersygn.io' };
    const res = await worker.fetch(new Request(`https://x/api/docs/d1/signer/${TOK}/decline`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'cf-connecting-ip': '1.2.3.4' },
      body: JSON.stringify({ reason: 'Terms unacceptable' }),
    }), env, { waitUntil() {} });
    return { body: await res.json(), sent };
  } finally { globalThis.fetch = realFetch; }
}

await t('a SINGLE-signer decline actually reaches the sender', async () => {
  const { body, sent } = await declineWith([{ id: 'sg1', name: 'Only', email: 'signer@example.com', token: TOK }]);
  assert.equal(body.senderNotified, true, 'senderNotified must be true');
  assert.equal(sent.length, 1, 'exactly one notice must go out');
  assert.deepEqual(sent[0].to, ['sender@example.com'], 'it must go to the sender, resolved from senderEmailHash');
});

await t('a MULTI-signer decline notifies the other party', async () => {
  const { body, sent } = await declineWith([
    { id: 'sg1', name: 'Decliner', email: 'signer@example.com', token: TOK },
    { id: 'sg2', name: 'Other', email: 'other@example.com', token: 'u'.repeat(64) },
  ]);
  assert.equal(body.senderNotified, true);
  assert.deepEqual(sent[0].to, ['other@example.com']);
});

await t('deliverDeclineNotice is imported, not just called', () => {
  // The original defect: called at one site, imported at none. node --check
  // cannot see it and the try/catch hid it at runtime.
  const src = readFileSync(new URL('../worker/src/index.js', import.meta.url), 'utf8');
  const importsIt = /import\s*\{[^}]*\bdeliverDeclineNotice\b[^}]*\}\s*from\s*'\.\/email\.js'/.test(src);
  assert.ok(importsIt, 'index.js must import deliverDeclineNotice from ./email.js');
});

await t('the signer is never told of a notification that did not happen', () => {
  const src = readFileSync(new URL('../web/preview/app.js', import.meta.url), 'utf8');
  const idx = src.indexOf('The sender has been notified');
  assert.ok(idx > 0, 'the success wording should still exist');
  // It must be guarded by the server's own answer, not asserted unconditionally.
  assert.ok(/result\.senderNotified\s*\?/.test(src),
    'the toast must branch on result.senderNotified rather than always claiming success');
});

console.log(out.join('\n'));
console.log(`\ndecline notice: ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
