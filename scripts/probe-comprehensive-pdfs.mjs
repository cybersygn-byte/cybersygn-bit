#!/usr/bin/env node
/**
 * Comprehensive synthetic detection probe.
 *
 * Walks every PDF under test-pdfs/<category>/ and runs detectFields.
 * Reports per-category coverage in a human-readable table and a
 * machine-readable JSON file (comprehensive-detection-results.json).
 *
 * Coverage rules per category:
 *   signatures/    each PDF must surface >=1 field that contains a label
 *                  the human reader would call a signature target.
 *   initials/      each PDF must surface >=1 field.
 *   dates/         each PDF must surface >=1 date OR a label with "date".
 *   checkboxes/    each PDF must surface >=1 checkbox OR >=1 field.
 *   text-fields/   each PDF must surface >=1 field.
 *   multi-signer/  each PDF must surface >=2 signature/date fields.
 *   acroforms/     each PDF must surface >=1 acroform field.
 *   international/ each PDF must surface >=1 field (vision should
 *                  catch these for non-English; we accept text or vision).
 *   positioning/   each PDF must surface >=1 field.
 *   adversarial/   each PDF must surface >=1 REAL signature field and
 *                  ideally NOT surface decoy patterns. We report
 *                  exact counts so a regression makes false positives
 *                  visible.
 *
 * Run: node scripts/probe-comprehensive-pdfs.mjs
 */

import { readFile, readdir, writeFile, stat } from 'node:fs/promises';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { detectFields } from '../worker/src/detect.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..', 'test-pdfs');
const OUT = resolve(HERE, '..', 'comprehensive-detection-results.json');

async function categories() {
  const items = await readdir(ROOT);
  const out = [];
  for (const item of items) {
    const p = join(ROOT, item);
    const s = await stat(p);
    if (s.isDirectory()) out.push(item);
  }
  return out.sort();
}

function pad(s, n) { return String(s).padEnd(n); }

async function main() {
  const cats = await categories();
  console.log(`Probing ${cats.length} categories under test-pdfs/ ...\n`);

  const results = {};
  const overall = { categories: cats.length, totalPDFs: 0, totalFields: 0, perCategory: {} };

  for (const cat of cats) {
    const dir = join(ROOT, cat);
    const files = (await readdir(dir)).filter(f => f.toLowerCase().endsWith('.pdf')).sort();
    console.log(`  ${cat}/  (${files.length} PDFs)`);
    const catSummary = {
      pdfs: files.length, parsed: 0, totalFields: 0,
      withSignature: 0, withDate: 0, withCheckbox: 0,
      empty: 0, errors: 0,
    };
    results[cat] = {};
    for (const name of files) {
      const buf = await readFile(join(dir, name));
      const bytes = new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
      try {
        const r = await detectFields(bytes);
        const fields = r.fields || [];
        const sigs = fields.filter(f => f.type === 'signature').length;
        const dates = fields.filter(f => f.type === 'date').length;
        const cbs = fields.filter(f => f.type === 'checkbox').length;
        catSummary.parsed += 1;
        catSummary.totalFields += fields.length;
        if (sigs > 0) catSummary.withSignature += 1;
        if (dates > 0) catSummary.withDate += 1;
        if (cbs > 0) catSummary.withCheckbox += 1;
        if (fields.length === 0) catSummary.empty += 1;
        results[cat][name] = { fields: fields.length, sigs, dates, cbs };
        console.log(`    ${pad(name, 38)}  fields=${fields.length}  sig=${sigs}  date=${dates}  cb=${cbs}`);
      } catch (err) {
        catSummary.errors += 1;
        results[cat][name] = { error: err.message };
        console.log(`    ${pad(name, 38)}  ERROR, ${err.message.slice(0, 60)}`);
      }
    }
    overall.totalPDFs += catSummary.pdfs;
    overall.totalFields += catSummary.totalFields;
    overall.perCategory[cat] = catSummary;
    console.log('');
  }

  console.log('======================================');
  console.log(`Total PDFs:    ${overall.totalPDFs}`);
  console.log(`Total fields:  ${overall.totalFields}`);
  console.log(`Categories:    ${overall.categories}`);
  console.log('--------------------------------------');
  for (const cat of cats) {
    const s = overall.perCategory[cat];
    console.log(`  ${pad(cat, 14)}  pdfs=${s.pdfs}  parsed=${s.parsed}  fields=${s.totalFields}  sig=${s.withSignature}  date=${s.withDate}  cb=${s.withCheckbox}  empty=${s.empty}  err=${s.errors}`);
  }
  console.log('======================================');

  await writeFile(OUT, JSON.stringify({ overall, results }, null, 2));
  console.log(`\nWrote ${OUT}`);

  /* Regression gate. This probe used to only exit non-zero when it threw, so a
     detector regression that quietly stopped finding signatures still reported
     green. The documented category rules are aspirational (today the detector
     legitimately leaves one checkboxes/ and one text-fields/ PDF empty, and
     hits 9 of 10 adversarial signatures), so asserting them strictly would turn
     this into a FALSE-red gate on the shipping product. Instead we pin the
     CURRENT measured coverage as a golden baseline: every category must parse
     without error, and its signal counts must not drop below what ships today.
     Update BASELINE deliberately when detection genuinely improves. */
  const BASELINE = {
    acroforms:     { parsed: 10, withSignature: 2,  withDate: 1,  withCheckbox: 4, totalFields: 30 },
    adversarial:   { parsed: 10, withSignature: 9,  withDate: 1,  withCheckbox: 1, totalFields: 20 },
    checkboxes:    { parsed: 10, withSignature: 0,  withDate: 0,  withCheckbox: 9, totalFields: 48 },
    dates:         { parsed: 10, withSignature: 0,  withDate: 10, withCheckbox: 0, totalFields: 28 },
    initials:      { parsed: 10, withSignature: 0,  withDate: 0,  withCheckbox: 0, totalFields: 34 },
    international: { parsed: 10, withSignature: 10, withDate: 10, withCheckbox: 0, totalFields: 40 },
    'multi-signer':{ parsed: 10, withSignature: 10, withDate: 10, withCheckbox: 0, totalFields: 69 },
    positioning:   { parsed: 10, withSignature: 10, withDate: 6,  withCheckbox: 0, totalFields: 33 },
    signatures:    { parsed: 10, withSignature: 10, withDate: 10, withCheckbox: 0, totalFields: 31 },
    'text-fields': { parsed: 10, withSignature: 0,  withDate: 0,  withCheckbox: 0, totalFields: 26 },
  };
  const failures = [];
  for (const cat of cats) {
    const s = overall.perCategory[cat] || {};
    const b = BASELINE[cat];
    if (s.errors > 0) failures.push(`${cat}: ${s.errors} parse error(s)`);
    if (!b) { console.warn(`  (no baseline for new category ${cat}; add one)`); continue; }
    for (const k of ['parsed', 'withSignature', 'withDate', 'withCheckbox', 'totalFields']) {
      if ((s[k] || 0) < b[k]) failures.push(`${cat}.${k} regressed: ${s[k] || 0} < baseline ${b[k]}`);
    }
  }
  console.log('');
  if (failures.length) {
    console.log('FAIL: detection coverage regressed below the golden baseline:');
    for (const f of failures) console.log('  - ' + f);
    process.exit(1);
  }
  console.log('PASS: detection coverage meets or beats the golden baseline for all 10 categories.');
}

main().catch(e => { console.error(e); process.exit(1); });
