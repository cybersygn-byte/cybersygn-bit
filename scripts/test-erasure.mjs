/**
 * Erasure tests. This module destroys data permanently, so the cases that
 * matter are the ones where it must NOT act, or must not over-reach.
 */
import assert from 'node:assert';
import {
  mintErasureToken, consumeErasureToken, eraseIdentity,
  writeErasureReceipt, emailHashOf, normalizeEmail,
} from '../worker/src/erasure.js';
import { pruneOldBackups, BACKUP_RETENTION_DAYS } from '../worker/src/kv-backup.js';

let pass = 0, fail = 0; const out = [];
async function t(name, fn) {
  try { await fn(); out.push('OK   ' + name); pass++; }
  catch (e) { out.push('FAIL ' + name + '\n     ' + e.message); fail++; }
}

function makeEnv(seed = {}) {
  const kv = new Map(Object.entries(seed));
  const pdfs = new Map();
  const mk = (m) => ({
    get: async (k, o) => {
      const v = m.get(k);
      if (v == null) return null;
      return (o && o.json) ? (typeof v === 'string' ? JSON.parse(v) : v) : v;
    },
    put: async (k, v) => { m.set(k, typeof v === 'string' ? v : JSON.stringify(v)); },
    delete: async (k) => { m.delete(k); },
    list: async ({ prefix } = {}) => ({ keys: [...m.keys()].filter(k => !prefix || k.startsWith(prefix)).map(name => ({ name })), list_complete: true }),
  });
  return { CYBERSYGN_DOCS: mk(kv), CYBERSYGN_PDFS: mk(pdfs), _kv: kv, _pdfs: pdfs };
}

async function seeded(email = 'a@x.com', senderId = 'snd_1') {
  const h = await emailHashOf(email);
  const env = makeEnv({
    [`login:email:${h}`]: JSON.stringify({ senderId }),
    [`sender:${senderId}:docs`]: JSON.stringify({ docs: ['d1', 'd2'] }),
    [`doc:d1`]: JSON.stringify({ senderId, pdfSha256: 'a'.repeat(64), signers: [{ id: 's1' }] }),
    [`doc:d2`]: JSON.stringify({ senderId, pdfSha256: 'b'.repeat(64), signers: [{ id: 's1' }, { id: 's2' }] }),
    [`signer-fills:d1:s1`]: '{}',
    [`signer-fills:d2:s1`]: '{}',
    [`signer-fills:d2:s2`]: '{}',
    [`brand:${senderId}`]: '{}',
    [`webhook:${senderId}`]: '{}',
    [`free:${h}`]: JSON.stringify({ used: 2, tokens: ['tok1'] }),
    [`free-tok:tok1`]: h,
    [`verify:${'a'.repeat(64)}`]: JSON.stringify({ fingerprint: 'a'.repeat(64) }),
    [`verify:${'b'.repeat(64)}`]: JSON.stringify({ fingerprint: 'b'.repeat(64) }),
  });
  env._pdfs.set('pdf:d1', 'x'); env._pdfs.set('audit:d1', 'x');
  return { env, h, senderId };
}

// ---------------------------------------------------------------- identity
await t('the email hash matches the rest of the product, case and space insensitive', async () => {
  assert.equal(await emailHashOf('  A@X.com '), await emailHashOf('a@x.com'));
  assert.equal(normalizeEmail(' A@X.COM '), 'a@x.com');
});

// ---------------------------------------------------------------- token
await t('an unknown email mints no token (and cannot be used to probe accounts)', async () => {
  const env = makeEnv();
  assert.equal(await mintErasureToken(env, 'nobody@nowhere.com', 'account'), null);
});

await t('a known email mints a 64-hex single-use token', async () => {
  const { env } = await seeded();
  const tok = await mintErasureToken(env, 'a@x.com', 'account');
  assert.match(tok, /^[a-f0-9]{64}$/);
});

await t('a token can be consumed exactly once', async () => {
  const { env } = await seeded();
  const tok = await mintErasureToken(env, 'a@x.com', 'account');
  assert.ok(await consumeErasureToken(env, tok), 'first use works');
  assert.equal(await consumeErasureToken(env, tok), null, 'second use is refused');
});

await t('a forged or malformed token is refused', async () => {
  const { env } = await seeded();
  for (const bad of ['', 'x', 'z'.repeat(64), 'A'.repeat(64), '../../etc', null, undefined]) {
    assert.equal(await consumeErasureToken(env, bad), null, `refused: ${bad}`);
  }
});

// ---------------------------------------------------------------- erasure
await t('account erasure removes documents, PDFs, fills, branding, and the binding', async () => {
  const { env, h, senderId } = await seeded();
  const tally = await eraseIdentity(env, { emailHash: h, senderId, scope: 'account' });
  assert.equal(tally.documents, 2);
  for (const k of [`doc:d1`, `doc:d2`, `signer-fills:d1:s1`, `signer-fills:d2:s2`,
                   `brand:${senderId}`, `webhook:${senderId}`, `login:email:${h}`,
                   `free:${h}`, `free-tok:tok1`, `sender:${senderId}:docs`]) {
    assert.equal(env._kv.get(k), undefined, `${k} should be gone`);
  }
  assert.equal(env._pdfs.get('pdf:d1'), undefined);
  assert.equal(env._pdfs.get('audit:d1'), undefined);
});

await t('PII-FREE verify records SURVIVE, so a counterparty keeps their evidence', async () => {
  const { env, h, senderId } = await seeded();
  const tally = await eraseIdentity(env, { emailHash: h, senderId, scope: 'account' });
  assert.equal(env._kv.has(`verify:${'a'.repeat(64)}`), true, 'fingerprint kept');
  assert.equal(env._kv.has(`verify:${'b'.repeat(64)}`), true, 'fingerprint kept');
  assert.equal(tally.keptVerifyRecords, 2, 'and it is reported honestly');
});

await t('documents-only scope keeps the account and the free-tier record', async () => {
  const { env, h, senderId } = await seeded();
  await eraseIdentity(env, { emailHash: h, senderId, scope: 'documents' });
  assert.equal(env._kv.get('doc:d1'), undefined, 'documents gone');
  assert.ok(env._kv.has(`login:email:${h}`), 'account binding kept');
  assert.ok(env._kv.has(`free:${h}`), 'free record kept');
  assert.ok(env._kv.has(`brand:${senderId}`), 'branding kept');
});

await t('erasure NEVER deletes a document owned by someone else', async () => {
  const { env, h, senderId } = await seeded();
  // A poisoned index claiming a document that belongs to another sender.
  env._kv.set(`sender:${senderId}:docs`, JSON.stringify({ docs: ['d1', 'victim'] }));
  env._kv.set('doc:victim', JSON.stringify({ senderId: 'snd_OTHER', signers: [] }));
  await eraseIdentity(env, { emailHash: h, senderId, scope: 'account' });
  assert.ok(env._kv.has('doc:victim'), 'another senders document must survive a poisoned index');
});

await t('erasure is idempotent and safe to re-run', async () => {
  const { env, h, senderId } = await seeded();
  await eraseIdentity(env, { emailHash: h, senderId, scope: 'account' });
  const second = await eraseIdentity(env, { emailHash: h, senderId, scope: 'account' });
  assert.equal(second.documents, 0);
  assert.equal(second.errors.length, 0);
});

await t('erasure with no senderId still clears email-keyed data', async () => {
  const h = await emailHashOf('free@x.com');
  const env = makeEnv({ [`free:${h}`]: JSON.stringify({ used: 1, tokens: ['t9'] }), 'free-tok:t9': h });
  await eraseIdentity(env, { emailHash: h, senderId: null, scope: 'account' });
  assert.equal(env._kv.get(`free:${h}`), undefined);
  assert.equal(env._kv.get('free-tok:t9'), undefined);
});

await t('the receipt records the act without re-storing personal data', async () => {
  const { env, h, senderId } = await seeded();
  const tally = await eraseIdentity(env, { emailHash: h, senderId, scope: 'account' });
  const r = await writeErasureReceipt(env, { emailHash: h, scope: 'account', tally });
  const blob = JSON.stringify(r);
  assert.ok(r.id && r.completedAt, 'receipt is identifiable and timestamped');
  assert.ok(!/a@x\.com/.test(blob), 'no raw email in the receipt');
  assert.ok(!/snd_1/.test(blob), 'no senderId in the receipt');
});

await t('a sender with MORE documents than the 200-entry index cap is fully erased', async () => {
  // Regression: addToSenderIndex caps the index at 200, so walking only the
  // index deleted the newest 200 and reported success while the rest survived.
  const kv = new Map(), pdfs = new Map();
  const ids = [...Array(250)].map((_, i) => 'd' + i);
  for (const id of ids) kv.set('doc:' + id, JSON.stringify({ senderId: 'snd_1', signers: [] }));
  for (let i = 0; i < 10; i++) kv.set('doc:other' + i, JSON.stringify({ senderId: 'snd_OTHER', signers: [] }));
  kv.set('sender:snd_1:docs', JSON.stringify({ docs: ids.slice(0, 200) }));
  const mk = (m) => ({
    get: async (k, o) => { const v = m.get(k); if (v == null) return null; return (o && o.json) ? JSON.parse(v) : v; },
    put: async (k, v) => { m.set(k, typeof v === 'string' ? v : JSON.stringify(v)); },
    delete: async (k) => { m.delete(k); },
    list: async ({ prefix } = {}) => ({ keys: [...m.keys()].filter(k => !prefix || k.startsWith(prefix)).map(name => ({ name })), list_complete: true }),
  });
  const env = { CYBERSYGN_DOCS: mk(kv), CYBERSYGN_PDFS: mk(pdfs) };
  const tally = await eraseIdentity(env, { emailHash: 'h', senderId: 'snd_1', scope: 'account' });
  assert.equal(tally.documents, 250, 'every document deleted, not just the indexed 200');
  assert.equal([...kv.keys()].filter(k => /^doc:d\d+$/.test(k)).length, 0, 'none left behind');
  assert.equal([...kv.keys()].filter(k => k.startsWith('doc:other')).length, 10, 'another tenant untouched');
  assert.equal(tally.scanComplete, true);
});

await t('the sweep ignores non-document keys even if the listing misbehaves', async () => {
  // Defense in depth: a list() that ignores its prefix must not let the sweep
  // destroy an auth binding or a brand record just because it carries a
  // matching senderId field. This is exactly what happened before the guard.
  const kv = new Map([
    ['doc:d1', JSON.stringify({ senderId: 'snd_1', signers: [] })],
    ['login:email:deadbeef', JSON.stringify({ senderId: 'snd_1' })],
    ['brand:snd_1', JSON.stringify({ senderId: 'snd_1' })],
    ['doc:../../etc/passwd', JSON.stringify({ senderId: 'snd_1', signers: [] })],
  ]);
  const mk = (m) => ({
    get: async (k, o) => { const v = m.get(k); if (v == null) return null; return (o && o.json) ? JSON.parse(v) : v; },
    put: async (k, v) => { m.set(k, typeof v === 'string' ? v : JSON.stringify(v)); },
    delete: async (k) => { m.delete(k); },
    // Deliberately BROKEN: ignores the prefix entirely.
    list: async () => ({ keys: [...m.keys()].map(name => ({ name })), list_complete: true }),
  });
  const env = { CYBERSYGN_DOCS: mk(kv), CYBERSYGN_PDFS: mk(new Map()) };
  await eraseIdentity(env, { emailHash: 'deadbeef', senderId: 'snd_1', scope: 'documents' });
  assert.equal(kv.has('doc:d1'), false, 'real documents still erased');
  assert.equal(kv.has('login:email:deadbeef'), true, 'auth binding untouched by the doc sweep');
  assert.equal(kv.has('brand:snd_1'), true, 'brand record untouched by the doc sweep');
  assert.equal(kv.has('doc:../../etc/passwd'), true, 'a traversal-shaped id is skipped, not processed');
});

// ---------------------------------------------------------------- backups
await t('backup pruning deletes only snapshots past the retention window', async () => {
  const objects = [
    { key: 'backups/2026-01-01.ndjson' },   // ancient, prune
    { key: 'backups/2026-07-20.ndjson' },   // 42 days old, past the 35 day window, prune
    { key: 'backups/2026-08-01.ndjson' },   // 30 days old, INSIDE the window, keep
    { key: 'backups/2026-08-30.ndjson' },   // yesterday, keep
    { key: 'backups/not-a-date.txt' },      // unrecognized, never touch
  ];
  const deleted = [];
  const env = { CYBERSYGN_BACKUPS: {
    list: async () => ({ objects, truncated: false }),
    delete: async (k) => { deleted.push(k); },
  } };
  const r = await pruneOldBackups(env, new Date('2026-08-31T03:00:00Z'));
  assert.equal(r.ok, true);
  assert.ok(deleted.includes('backups/2026-01-01.ndjson'), 'old snapshot pruned');
  assert.ok(deleted.includes('backups/2026-07-20.ndjson'), 'past-window snapshot pruned');
  assert.ok(!deleted.includes('backups/2026-08-01.ndjson'), 'a 30 day old snapshot is inside the 35 day window and must be kept');
  assert.ok(!deleted.includes('backups/2026-08-30.ndjson'), 'recent snapshot kept');
  assert.equal(r.cutoff, '2026-07-27', 'cutoff is exactly 35 days back');
  assert.ok(!deleted.includes('backups/not-a-date.txt'), 'unrecognized key never touched');
});

await t('pruning is a no-op, not a crash, with no R2 bound', async () => {
  const r = await pruneOldBackups({}, new Date());
  assert.equal(r.ok, false);
  assert.equal(r.pruned, 0);
});

await t('the retention window matches what /erase/ promises users', async () => {
  assert.equal(BACKUP_RETENTION_DAYS, 35, 'the page says up to 35 days');
});

console.log(out.join('\n'));
console.log(`\nerasure: ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
