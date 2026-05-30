/**
 * Run field detection against every PDF in test-pdfs/ and print a summary.
 *
 * Exit code is 0 if every PDF returned at least one field, 1 otherwise.
 * That is the bar for "the heuristic finds something on every shape of
 * document," not a measure of correctness; correctness is spot-checked
 * by reading the per-document output.
 */

import { readFile, readdir, writeFile } from 'node:fs/promises';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { detectFields } from '../worker/src/detect.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const PDF_DIR = resolve(HERE, '..', 'test-pdfs');
const OUT_PATH = resolve(HERE, '..', 'detection-results.json');

const EXPECTED = {
  '01-simple-signature.pdf': { types: ['signature', 'date', 'text'], min: 3 },
  '02-legal-slash-s.pdf':    { types: ['signature', 'text'], min: 4 },
  '03-multi-party.pdf':      { types: ['signature', 'date', 'text'], min: 8 },
  '04-initials-margins.pdf': { types: ['initial', 'signature', 'date'], min: 6 },
  '05-checkboxes.pdf':       { types: ['checkbox', 'signature', 'date'], min: 7 },
  '06-date-fields.pdf':      { types: ['date', 'signature'], min: 6 },
  '07-acroform.pdf':         { types: ['signature', 'text', 'date', 'checkbox'], min: 5 },
  '08-multi-page.pdf':       { types: ['initial', 'signature', 'date', 'text'], min: 8 },
  '09-mixed.pdf':            { types: ['checkbox', 'initial', 'signature', 'date'], min: 7 },
  '10-no-label.pdf':         { types: ['signature', 'date'], min: 2 },
};

function summarize(fields) {
  const tally = {};
  for (const f of fields) tally[f.type] = (tally[f.type] || 0) + 1;
  return tally;
}

function checkExpected(name, fields) {
  const exp = EXPECTED[name];
  if (!exp) return { ok: true, notes: ['no expectation set'] };
  const notes = [];
  let ok = true;
  if (fields.length < exp.min) {
    ok = false;
    notes.push(`expected at least ${exp.min} fields, got ${fields.length}`);
  }
  const types = new Set(fields.map(f => f.type));
  for (const t of exp.types) {
    if (!types.has(t)) {
      ok = false;
      notes.push(`missing expected type "${t}"`);
    }
  }
  return { ok, notes };
}

async function main() {
  const entries = (await readdir(PDF_DIR))
    .filter(n => n.endsWith('.pdf'))
    .sort();

  const all = {};
  let overallOk = true;

  for (const name of entries) {
    const path = join(PDF_DIR, name);
    const data = new Uint8Array(await readFile(path));
    let result;
    try {
      result = await detectFields(data);
    } catch (e) {
      console.error(`FAIL: ${name} threw ${e.message}`);
      overallOk = false;
      all[name] = { error: e.message };
      continue;
    }

    const tally = summarize(result.fields);
    const { ok, notes } = checkExpected(name, result.fields);
    const tag = ok ? 'OK ' : 'WARN';
    console.log(
      `${tag}  ${name}  pages=${result.pageCount}  ` +
      `fields=${result.fields.length}  ${JSON.stringify(tally)}` +
      (notes.length ? `  (${notes.join('; ')})` : ''),
    );
    if (!ok) overallOk = false;
    all[name] = { ...result, expectedNotes: notes };
  }

  await writeFile(OUT_PATH, JSON.stringify(all, null, 2));
  console.log(`\nWrote per-document results to ${OUT_PATH}`);

  if (!overallOk) {
    console.log('\nSome documents missed expected types. Review and tune heuristics.');
    process.exit(1);
  }
  console.log('\nAll documents met minimum expectations.');
}

main().catch(e => {
  console.error('harness failed:', e);
  process.exit(2);
});
