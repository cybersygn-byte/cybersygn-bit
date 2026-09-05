/**
 * The public detection numbers must equal what the detector actually does.
 *
 * llms-full.txt said "120 of 120 synthetic test PDFs" and the homepage rendered
 * 120/120 under "Regression tests passed." Running the CURRENT detector over the
 * committed corpus, five return no field at all: blank ruled lines with no
 * label, stylized X marks, a rotated landscape page, a circle-style radio
 * group, and a long free-text comment block. The copy also said 12 detection
 * categories; the generator makes 10.
 *
 * This recomputes the numerator from the corpus rather than trusting a stored
 * result, so the claim cannot drift away from the engine again. It is the
 * CLAUDE.md rule 6 case: copy must be true against the code on the day it ships.
 */
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { detectFields } from '../worker/src/detect.js';

const ROOT = new URL('..', import.meta.url).pathname;
let pass = 0, fail = 0; const out = [];
async function t(name, fn) {
  try { await fn(); out.push('OK   ' + name); pass++; }
  catch (e) { out.push('FAIL ' + name + '\n     ' + e.message); fail++; }
}
const read = (p) => readFileSync(join(ROOT, p), 'utf8');

function corpusFiles(dir) {
  const files = [];
  const walk = (d) => {
    for (const e of readdirSync(d)) {
      const p = join(d, e);
      if (statSync(p).isDirectory()) walk(p);
      else if (e.endsWith('.pdf')) files.push(p);
    }
  };
  walk(join(ROOT, dir));
  return files.sort();
}

let measured = null;
await t('measure the synthetic corpus with the real detector', async () => {
  const files = corpusFiles('test-pdfs');
  let ok = 0;
  const misses = [];
  for (const f of files) {
    let n = 0;
    try {
      const r = await detectFields(new Uint8Array(readFileSync(f)));
      n = ((r && (r.fields || r)) || []).length;
    } catch (e) { n = 0; }
    if (n > 0) ok++; else misses.push(f.replace(ROOT, ''));
  }
  measured = { total: files.length, ok, misses };
  assert.ok(files.length > 0, 'the corpus must exist; run npm run generate-pdfs:all');
});

await t('the published synthetic numbers match the measurement', () => {
  assert.ok(measured, 'measurement must have run');
  const { total, ok } = measured;
  const llms = read('web/llms-full.txt');
  const home = read('web/index.html');

  // Whatever figures ship, they must be THESE figures.
  assert.ok(llms.includes(`${ok} of ${total} synthetic`),
    `llms-full.txt must say "${ok} of ${total} synthetic"; measured ${ok}/${total}. Misses: ${measured.misses.join(', ')}`);
  assert.ok(home.includes(`>${ok}<span class="unit">/${total}</span>`),
    `the homepage proof tile must read ${ok}/${total}`);

  // And the retired perfect-score claims must not come back in any form.
  for (const lie of [/120 of 120/, /120\/120/, />120<span class="unit">\/120</]) {
    assert.ok(!lie.test(llms) && !lie.test(home), `a 120/120 claim is back: ${lie}`);
  }
});

await t('the README numbers match the measurement too', () => {
  assert.ok(measured, 'measurement must have run');
  const { total, ok } = measured;
  const readme = read('README.md');

  // README was outside this check's scope, which is exactly why it went stale:
  // it advertised "10/10 synthetic" and "37/37 (100%)" long after the corpus
  // had grown to 120 and 499 files. It is the first document a reader opens,
  // so its numbers matter more than most, not less.
  assert.ok(readme.includes(`${ok} of ${total} synthetic`) || readme.includes(`${ok}/${total}`),
    `README.md must carry the measured synthetic figure ${ok}/${total}`);

  // The real-document corpus is too slow to detect on every gate run, so assert
  // the SIZE it claims against the files actually on disk. That is what went
  // wrong before: the rate was stale because the corpus had grown underneath it.
  const realCount = readdirSync(join(ROOT, 'real-pdfs')).filter(f => f.toLowerCase().endsWith('.pdf')).length;
  assert.ok(readme.includes(String(realCount)),
    `README.md cites a real-document corpus size that is not ${realCount}, the number of PDFs in real-pdfs/`);

  // No perfect-score claim for the real corpus. scripts/run-real-detection.js
  // used Math.round, which printed 497/499 as "100 percent", and that number
  // was copied into the README as "37/37 (100%)".
  for (const lie of [/\(100%\)/, /100 percent/, /100% of real/]) {
    assert.ok(!lie.test(readme), `README.md claims a perfect real-document score: ${lie}`);
  }
});

await t('the category count matches the generator', () => {
  // The copy said 12; scripts/generate-comprehensive-pdfs.py builds 10.
  const dirs = readdirSync(join(ROOT, 'test-pdfs'))
    .filter(e => statSync(join(ROOT, 'test-pdfs', e)).isDirectory());
  const llms = read('web/llms-full.txt');
  assert.ok(llms.includes(`${dirs.length} detection categories`),
    `llms-full.txt must say "${dirs.length} detection categories", the number of category folders in the corpus`);
});

console.log(out.join('\n'));
if (measured) console.log(`\nmeasured: ${measured.ok}/${measured.total} synthetic PDFs return at least one field`);
console.log(`\ndetection claims: ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
