/**
 * Detector geometry tests (worker/src/detect.js).
 *
 * Every field the detector returns has to be drawable on the page it claims.
 * Two ways that broke, both found by scripts/fuzz-logic.mjs:
 *  - a widget annotation whose /Rect entries are not numbers (a Name, a
 *    string, a nested array) produced NaN x/y/width/height, which JSON
 *    serializes as null: the preview drew nothing and the flatten step
 *    stamped nothing, while the sidebar still counted the field
 *  - a widget with /Rect [1e9 1e9 -1e9 -1e9] produced a 2e9-wide field on a
 *    612x792 page
 *
 * Same plain-assert pattern as scripts/test-payout.mjs.
 * Run: node scripts/test-detect-geometry.mjs
 */
import assert from 'node:assert/strict';
import { detectFields } from '../worker/src/detect.js';

let pass = 0, fail = 0;
const results = [];
async function t(name, fn) {
  try { await fn(); pass++; results.push(`OK   ${name}`); }
  catch (e) { fail++; results.push(`FAIL ${name}\n       ${e.message.split('\n')[0]}`); }
}

const PAGE_W = 612;
const PAGE_H = 792;

/**
 * Hand-build a one-page PDF carrying a single widget annotation with the
 * given raw /Rect text. Hand-built rather than generated because pdf-lib
 * will not emit a malformed rect, and a malformed rect is the whole point.
 */
function pdfWithRect(rect) {
  const objs = [];
  objs[1] = '<< /Type /Catalog /Pages 2 0 R /AcroForm << /Fields [4 0 R] >> >>';
  objs[2] = '<< /Type /Pages /Kids [3 0 R] /Count 1 >>';
  objs[3] = `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PAGE_W} ${PAGE_H}] /Resources << >> /Annots [4 0 R] >>`;
  objs[4] = `<< /Type /Annot /Subtype /Widget /FT /Tx /T (sig1) /Rect ${rect} /F 4 >>`;
  let out = '%PDF-1.7\n';
  const offsets = [];
  for (let i = 1; i <= 4; i++) { offsets[i] = out.length; out += `${i} 0 obj\n${objs[i]}\nendobj\n`; }
  const xref = out.length;
  out += 'xref\n0 5\n0000000000 65535 f \n';
  for (let i = 1; i <= 4; i++) out += `${String(offsets[i]).padStart(10, '0')} 00000 n \n`;
  out += `trailer\n<< /Size 5 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new TextEncoder().encode(out);
}

/** The invariants the preview and the flatten step both depend on. */
function violations(res, pageW, pageH) {
  const v = [];
  for (const f of res.fields) {
    for (const k of ['x', 'y', 'width', 'height']) {
      if (!Number.isFinite(f[k])) v.push(`${k} not finite: ${f[k]} (src=${f.source})`);
    }
    if (!Number.isFinite(f.x) || !Number.isFinite(f.y)) continue;
    if (!Number.isFinite(f.width) || !Number.isFinite(f.height)) continue;
    const eps = 1;
    if (f.x < -eps || f.y < -eps || f.x + f.width > pageW + eps || f.y + f.height > pageH + eps) {
      v.push(`out of bounds: [${f.x},${f.y},${f.width},${f.height}] on ${pageW}x${pageH} (src=${f.source})`);
    }
    if (!(f.width > 0) || !(f.height > 0)) v.push(`zero-area field (src=${f.source})`);
  }
  return v;
}

const MALFORMED_RECTS = [
  ['a Name entry', '[/Foo 0 100 100]'],
  ['a null', '[null 0 100 100]'],
  ['a string', '[(abc) 0 100 100]'],
  ['two entries', '[0 0]'],
  ['six entries', '[0 0 100 100 5 5]'],
  ['a nested array', '[[0 0] 100 100 0]'],
  ['a dict instead of an array', '<< /a 1 >>'],
];

for (const [what, rect] of MALFORMED_RECTS) {
  await t(`widget /Rect with ${what} yields no NaN geometry`, async () => {
    const res = await detectFields(pdfWithRect(rect));
    assert.deepEqual(violations(res, PAGE_W, PAGE_H), [], `rect ${rect}`);
  });
}

await t('reversed, page-sized-times-a-million /Rect is clamped onto the page', async () => {
  const res = await detectFields(pdfWithRect('[1e9 1e9 -1e9 -1e9]'));
  assert.deepEqual(violations(res, PAGE_W, PAGE_H), []);
  // Clamped, not discarded: the annotation covers the page, so the field
  // that survives should still be the page.
  const widget = res.fields.find(f => f.source === 'acroform');
  if (widget) {
    assert.ok(widget.width <= PAGE_W && widget.height <= PAGE_H, 'field fits the page');
  }
});

await t('a widget entirely off the page is dropped, not reported at zero size', async () => {
  const res = await detectFields(pdfWithRect('[-500 -500 -100 -100]'));
  assert.deepEqual(violations(res, PAGE_W, PAGE_H), []);
  assert.equal(res.fields.filter(f => f.source === 'acroform').length, 0);
});

await t('a well-formed widget is untouched', async () => {
  const res = await detectFields(pdfWithRect('[100 200 300 224]'));
  assert.deepEqual(violations(res, PAGE_W, PAGE_H), []);
  const widget = res.fields.find(f => f.source === 'acroform');
  assert.ok(widget, 'the widget is still detected');
  assert.deepEqual(
    { x: widget.x, y: widget.y, width: widget.width, height: widget.height },
    { x: 100, y: 200, width: 200, height: 24 },
  );
});

await t('a real template still detects the same fields it always did', async () => {
  const { readFile } = await import('node:fs/promises');
  const { dirname, join } = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const root = join(dirname(fileURLToPath(import.meta.url)), '..');
  const buf = await readFile(join(root, 'web', 'templates-pdf', 'master-services-agreement.pdf'));
  const res = await detectFields(new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength));
  assert.ok(res.fields.length >= 15, `expected the usual field haul, got ${res.fields.length}`);
  for (const f of res.fields) {
    for (const k of ['x', 'y', 'width', 'height']) {
      assert.ok(Number.isFinite(f[k]), `${k} finite on a real document`);
    }
  }
});

console.log(results.join('\n'));
console.log(`\ndetector geometry: ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
