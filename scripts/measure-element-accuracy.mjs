#!/usr/bin/env node
/**
 * Per-element-type detection accuracy + confidence measurement.
 *
 * Runs detection on the comprehensive synthetic suite (test-pdfs/<category>/)
 * and reports, for each element type, the detection rate and the confidence of
 * the detections. The goal: every element type detects its expected field with
 * 90%+ confidence on well-formed inputs.
 *
 * Each category folder maps to the element type its PDFs are built to exercise.
 * For adversarial/, the goal is the inverse — the ONE real signature is found,
 * decoys are not — so we measure the real-signature detection rate.
 *
 * Run: node scripts/measure-element-accuracy.mjs
 */

import { readFile, readdir, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { detectFields } from '../worker/src/detect.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', 'test-pdfs');

// category -> the element type its PDFs should surface
const EXPECT = {
  signatures: 'signature',
  initials: 'initial',
  dates: 'date',
  checkboxes: 'checkbox',
  'text-fields': 'text',
  'multi-signer': 'signature',
  acroforms: null,          // any field type (widgets); measure "any detected"
  international: 'signature',
  positioning: 'signature',
  adversarial: 'signature',  // the one real signature must be found
};

const TARGET = 0.90;

async function main() {
  const cats = (await readdir(ROOT)).filter(async () => true);
  const dirs = [];
  for (const c of cats) {
    const p = join(ROOT, c);
    if ((await stat(p)).isDirectory()) dirs.push(c);
  }
  dirs.sort();

  console.log(`Per-element detection accuracy (target: detect + >=${TARGET} confidence)\n`);
  console.log('  category'.padEnd(18) + 'detect%  avgConf  >=0.90%  n');
  console.log('  ' + '-'.repeat(52));

  let categoriesBelow = 0;
  const report = {};

  for (const cat of dirs) {
    const want = EXPECT[cat];
    const files = (await readdir(join(ROOT, cat))).filter(f => f.endsWith('.pdf')).sort();
    let detected = 0;
    const confs = [];
    for (const f of files) {
      const buf = await readFile(join(ROOT, cat, f));
      const bytes = new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
      const r = await detectFields(bytes);
      const fields = r.fields || [];
      const relevant = want ? fields.filter(x => x.type === want) : fields;
      if (relevant.length > 0) {
        detected++;
        // Use the best (max-confidence) relevant field for this PDF.
        const best = Math.max(...relevant.map(x => x.confidence || 0));
        confs.push(best);
      }
    }
    const n = files.length;
    const detectRate = n ? detected / n : 0;
    const avgConf = confs.length ? confs.reduce((a, b) => a + b, 0) / confs.length : 0;
    const highConf = confs.filter(c => c >= TARGET).length;
    const highPct = confs.length ? highConf / confs.length : 0;
    report[cat] = { detectRate, avgConf, highPct, n, detected };

    const pass = detectRate >= TARGET && avgConf >= TARGET;
    if (!pass) categoriesBelow++;
    const flag = pass ? 'ok ' : '<<<';
    console.log(
      `  ${flag} ${cat.padEnd(14)}` +
      `${(detectRate * 100).toFixed(0).padStart(5)}%  ` +
      `${avgConf.toFixed(2).padStart(6)}  ` +
      `${(highPct * 100).toFixed(0).padStart(5)}%  ` +
      `${String(n).padStart(3)}`,
    );
  }

  console.log('  ' + '-'.repeat(52));
  console.log(`\n${dirs.length - categoriesBelow}/${dirs.length} categories at target. ${categoriesBelow} below.`);
  process.exit(categoriesBelow === 0 ? 0 : 1);
}

main().catch(e => { console.error(e); process.exit(1); });
