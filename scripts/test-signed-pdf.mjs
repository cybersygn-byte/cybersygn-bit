/**
 * The signed-document chain. The property that matters is that the hash we
 * PUBLISH equals the hash of the bytes we SERVE, under every path that can
 * produce those bytes. A test that builds once proves almost nothing.
 */
import assert from 'node:assert';
import { PDFDocument } from 'pdf-lib';
import { createHash } from 'node:crypto';
import {
  buildSignedPdf, ensureSignedPdf, collectFills, sanitizeWinAnsi,
  signedPdfKey, SIGNED_MAX_SOURCE_BYTES,
} from '../worker/src/signed-pdf.js';
import { writeVerifyRecord, getVerifyRecord } from '../worker/src/verify.js';

let pass = 0, fail = 0; const out = [];
async function t(name, fn) {
  try { await fn(); out.push('OK   ' + name); pass++; }
  catch (e) { out.push('FAIL ' + name + '\n     ' + e.message); fail++; }
}
const sha = (b) => createHash('sha256').update(Buffer.from(b)).digest('hex');

async function sourcePdf(pages = 1) {
  const d = await PDFDocument.create();
  for (let i = 0; i < pages; i++) d.addPage([612, 792]);
  return await d.save();
}
function docFixture(extra = {}) {
  return {
    id: 'd1', createdAt: '2026-08-01T00:00:00.000Z', completedAt: '2026-08-31T12:00:00.000Z',
    pdfSha256: 'a'.repeat(64),
    fields: [
      { id: 'f1', page: 1, x: 72, y: 700, width: 180, height: 24, type: 'text' },
      { id: 'f2', page: 1, x: 72, y: 650, width: 180, height: 24, type: 'date' },
      { id: 'f3', page: 1, x: 72, y: 600, width: 20, height: 20, type: 'checkbox' },
    ],
    assignments: { f1: 'p1', f2: 'p1', f3: 'p1' },
    signers: [{ id: 'p1', token: 'b'.repeat(64), fills: {
      f1: { kind: 'text', text: 'Nathan Vogt' },
      f2: { kind: 'date', text: '2026-08-31' },
      f3: { kind: 'checkbox', checked: true },
    } }],
    ...extra,
  };
}
function makeEnv(seedPdf) {
  const docs = new Map(), pdfs = new Map();
  if (seedPdf) pdfs.set('pdf:d1', seedPdf);
  const mk = (m) => ({
    get: async (k, type) => {
      const v = m.get(k); if (v == null) return null;
      if (type === 'arrayBuffer') return v.buffer ? v.buffer : v;
      if (type === 'json') return typeof v === 'string' ? JSON.parse(v) : v;
      return v;
    },
    put: async (k, v) => { m.set(k, v); },
    delete: async (k) => { m.delete(k); },
    list: async () => ({ keys: [], list_complete: true }),
  });
  return { CYBERSYGN_DOCS: mk(docs), CYBERSYGN_PDFS: mk(pdfs, true), _docs: docs, _pdfs: pdfs };
}

// ------------------------------------------------------------- determinism
await t('rebuilding the same document produces byte-identical output', async () => {
  const src = await sourcePdf();
  const doc = docFixture();
  const a = await buildSignedPdf({ originalBytes: src, doc });
  await new Promise(r => setTimeout(r, 1100));   // cross a wall-clock second
  const b = await buildSignedPdf({ originalBytes: src, doc });
  assert.equal(sha(a), sha(b),
    'nondeterminism here means /verify tells a legitimate holder their real file is wrong');
});

await t('field ORDER, not fill insertion order, drives the output', async () => {
  const src = await sourcePdf();
  const a = await buildSignedPdf({ originalBytes: src, doc: docFixture() });
  // Same data, fills object rebuilt in a different insertion order.
  const d2 = docFixture();
  const f = d2.signers[0].fills;
  d2.signers[0].fills = { f3: f.f3, f1: f.f1, f2: f.f2 };
  const b = await buildSignedPdf({ originalBytes: src, doc: d2 });
  assert.equal(sha(a), sha(b), 'hash must not depend on the order signatures arrived');
});

// ------------------------------------------------------------- robustness
await t('an unencodable glyph is sanitized instead of throwing', async () => {
  assert.equal(sanitizeWinAnsi('hi 🎉'), 'hi ?');
  assert.equal(sanitizeWinAnsi('“q” — d'), '"q" - d');
  assert.equal(sanitizeWinAnsi('Renée'), 'Renée', 'Latin-1 survives');
  const src = await sourcePdf();
  const doc = docFixture();
  doc.signers[0].fills.f1 = { kind: 'text', text: 'Emoji 🎉 and 中文' };
  const bytes = await buildSignedPdf({ originalBytes: src, doc });
  assert.ok(bytes.byteLength > 0, 'a document with exotic text still produces an artifact');
});

await t('a malformed signature dataUrl is skipped, not fatal', async () => {
  const src = await sourcePdf();
  const doc = docFixture();
  doc.signers[0].fills.f1 = { kind: 'signature', dataUrl: 'data:image/png;base64,NOT_REAL!!' };
  const bytes = await buildSignedPdf({ originalBytes: src, doc });
  assert.ok(bytes.byteLength > 0);
});

await t('an oversized source is refused rather than exhausting Worker memory', async () => {
  const huge = new Uint8Array(SIGNED_MAX_SOURCE_BYTES + 1);
  await assert.rejects(
    () => buildSignedPdf({ originalBytes: huge, doc: docFixture() }),
    (e) => e.code === 'too_large');
});

await t('a missing original is refused', async () => {
  await assert.rejects(() => buildSignedPdf({ originalBytes: null, doc: docFixture() }),
    (e) => e.code === 'no_original');
});

// ------------------------------------------------------------- ensureSignedPdf
await t('ensureSignedPdf NEVER throws, whatever it is handed', async () => {
  for (const bad of [null, undefined, {}, { completedAt: 'x' }]) {
    const r = await ensureSignedPdf(makeEnv(), bad);
    assert.equal(typeof r.ok, 'boolean');
  }
});

await t('an incomplete document produces no artifact', async () => {
  const doc = docFixture({ completedAt: null });
  const r = await ensureSignedPdf(makeEnv(await sourcePdf()), doc);
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'not_completed');
});

await t('the artifact is built once, stored, and reused', async () => {
  const env = makeEnv(await sourcePdf());
  const first = await ensureSignedPdf(env, docFixture());
  assert.equal(first.ok, true);
  assert.equal(first.source, 'built');
  assert.ok(env._pdfs.has(signedPdfKey('d1')), 'stored under signed:<docId>');
  const second = await ensureSignedPdf(env, docFixture());
  assert.equal(second.source, 'stored', 'second call reuses rather than rebuilding');
  assert.equal(first.sha256, second.sha256, 'and reports the same hash');
});

await t('THE CORE INVARIANT: the hash published equals the hash of the bytes served', async () => {
  const env = makeEnv(await sourcePdf());
  const r = await ensureSignedPdf(env, docFixture());
  assert.equal(r.sha256, sha(r.bytes), 'served bytes must hash to the published value');
  // And again from storage, which is the path a later download takes.
  const again = await ensureSignedPdf(env, docFixture());
  assert.equal(again.sha256, sha(again.bytes));
  assert.equal(again.sha256, r.sha256);
});

await t('a lazy rebuild for an old document reproduces the original hash', async () => {
  // The backfill path depends entirely on this: bytes produced now must equal
  // bytes that would have been produced at completion.
  const src = await sourcePdf();
  const envA = makeEnv(src);
  const atCompletion = await ensureSignedPdf(envA, docFixture());
  const envB = makeEnv(src);                      // nothing stored: cold rebuild
  const later = await ensureSignedPdf(envB, docFixture());
  assert.equal(later.sha256, atCompletion.sha256);
});

// ------------------------------------------------------------- verify records
await t('a verify record resolves by EITHER hash', async () => {
  const env = makeEnv();
  const orig = 'a'.repeat(64), signed = 'c'.repeat(64);
  await writeVerifyRecord(env, { pdfSha256: orig, signedPdfSha256: signed, signerCount: 2, completedAt: 'x' });
  const byOriginal = await getVerifyRecord(env, orig);
  const bySigned = await getVerifyRecord(env, signed);
  assert.ok(byOriginal && bySigned, 'both hashes must resolve');
  assert.equal(byOriginal.kind, 'original');
  assert.equal(bySigned.kind, 'signed');
  assert.equal(byOriginal.fingerprint, orig, 'fingerprint always equals its own key');
  assert.equal(bySigned.fingerprint, signed);
  assert.equal(bySigned.signedSha256, signed);
});

await t('a LEGACY record with no signed hash still resolves exactly as before', async () => {
  const env = makeEnv();
  const orig = 'd'.repeat(64);
  await writeVerifyRecord(env, { pdfSha256: orig, signerCount: 1, completedAt: 'x' });
  const rec = await getVerifyRecord(env, orig);
  assert.ok(rec);
  assert.equal(rec.fingerprint, orig);
  assert.equal(rec.signedSha256, null, 'absent, not fabricated');
});

await t('the record carries no docId, which would be a capability leak', async () => {
  const env = makeEnv();
  await writeVerifyRecord(env, { pdfSha256: 'e'.repeat(64), signedPdfSha256: 'f'.repeat(64), signerCount: 1 });
  const rec = await getVerifyRecord(env, 'e'.repeat(64));
  const blob = JSON.stringify(rec);
  assert.ok(!/docId/i.test(blob), 'a doc id here would turn a fingerprint into a name lookup');
  assert.ok(!/@/.test(blob), 'and no email may ever appear');
});

await t('an unknown hash returns nothing, leaking no distinction', async () => {
  assert.equal(await getVerifyRecord(makeEnv(), '9'.repeat(64)), null);
});

await t('a degenerate equal-hash case cannot write a contradictory record', async () => {
  const env = makeEnv();
  const h = 'b'.repeat(64);
  await writeVerifyRecord(env, { pdfSha256: h, signedPdfSha256: h, signerCount: 1 });
  const rec = await getVerifyRecord(env, h);
  assert.equal(rec.kind, 'original', 'the original write wins, no second contradictory put');
});

await t('a paid plan gets the footer-free PDF it was sold', async () => {
  // "No footer." is sold from Solo up and drawSignedFooter was called
  // unconditionally, so every paying customer's canonical signed PDF carried
  // the footer and a clickable cybersygn.io annotation on every page. The
  // browser path was no better: its only gate was a localStorage flag that
  // nothing wrote and any free user could set.
  const base = await PDFDocument.create();
  base.addPage([300, 200]); base.addPage([300, 200]);
  const orig = await base.save();
  const build = async (footer) => buildSignedPdf({ originalBytes: orig, doc: { id: 'd', footer, signers: [], fields: [] } });
  const countAnnots = async (bytes) => {
    const d = await PDFDocument.load(bytes);
    return d.getPages().reduce((n, pg) => n + ((pg.node.Annots() && pg.node.Annots().size()) || 0), 0);
  };
  const free = await build(true);
  const paid = await build(false);
  assert.ok(paid.byteLength < free.byteLength, 'the paid artifact must omit the footer');
  assert.equal(await countAnnots(paid), 0, 'and its clickable cybersygn.io annotations');
  assert.equal(await countAnnots(free), 2, 'while the free tier keeps one per page');

  // A record written before the field existed must keep the footer: unknown
  // tier defaults to free, which is the safe direction to be wrong in.
  const legacy = await build(undefined);
  assert.equal(legacy.byteLength, free.byteLength, 'legacy records keep the footer');
});

console.log(out.join('\n'));
console.log(`\nsigned document chain: ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
