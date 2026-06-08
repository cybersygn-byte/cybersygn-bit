#!/usr/bin/env node
/**
 * Run CyberSygn field detection against every rendered proprietary template PDF.
 *
 * A template PASSES if detection parses it and finds at least one signature
 * field (every authored template has a signature block, so detection finding it
 * is the meaningful "our tool detects our own deliverable" check). We also report
 * date/checkbox coverage for visibility.
 *
 * Run: node scripts/test-template-detection.mjs
 * Writes template-detection-results.json. Exit 0 if all rendered pass.
 */

import { readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { detectFields } from '../worker/src/detect.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const PDF_DIR = join(ROOT, 'web', 'templates-pdf');
const CATALOG = join(HERE, 'templates-catalog.json');
const OUT = join(ROOT, 'template-detection-results.json');

async function main() {
  const catalog = JSON.parse(await readFile(CATALOG, 'utf8'));
  const totalCatalog = catalog.templates.length;
  const files = (await readdir(PDF_DIR)).filter(f => f.endsWith('.pdf')).sort();

  const results = {};
  let pass = 0, fail = 0, parseErr = 0;
  let totalFields = 0, withSig = 0, withDate = 0, withCb = 0;
  const failures = [];

  for (const f of files) {
    const slug = f.replace(/\.pdf$/, '');
    try {
      const buf = await readFile(join(PDF_DIR, f));
      const bytes = new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
      const r = await detectFields(bytes);
      const fields = r.fields || [];
      const sig = fields.filter(x => x.type === 'signature').length;
      const date = fields.filter(x => x.type === 'date').length;
      const cb = fields.filter(x => x.type === 'checkbox').length;
      totalFields += fields.length;
      if (sig > 0) withSig++;
      if (date > 0) withDate++;
      if (cb > 0) withCb++;
      const passed = sig >= 1;
      if (passed) pass++; else { fail++; failures.push({ slug, sig, date, fields: fields.length }); }
      results[slug] = { pages: r.pageCount, fields: fields.length, sig, date, cb, pass: passed };
    } catch (e) {
      parseErr++; fail++;
      failures.push({ slug, error: String(e).slice(0, 120) });
      results[slug] = { error: String(e).slice(0, 120), pass: false };
    }
  }

  const rendered = files.length;
  const summary = {
    catalogTotal: totalCatalog,
    rendered,
    pass,
    fail,
    parseErrors: parseErr,
    passRate: rendered ? Math.round((pass / rendered) * 1000) / 10 : 0,
    avgFields: rendered ? Math.round((totalFields / rendered) * 10) / 10 : 0,
    withSignature: withSig,
    withDate,
    withCheckbox: withCb,
  };
  await writeFile(OUT, JSON.stringify({ summary, failures, results }, null, 2));

  console.log(`Proprietary template PDFs rendered: ${rendered} / ${totalCatalog}`);
  console.log(`PASS (>=1 signature field detected): ${pass}  (${summary.passRate}%)`);
  console.log(`FAIL: ${fail}  (parse errors: ${parseErr})`);
  console.log(`Coverage: signature ${withSig}, date ${withDate}, checkbox ${withCb}`);
  console.log(`Avg fields/doc: ${summary.avgFields}`);
  if (failures.length) {
    console.log('\nFailures:');
    for (const x of failures.slice(0, 30)) console.log(`  ${x.slug}: ${x.error || ('sig=' + x.sig + ' fields=' + x.fields)}`);
  }
  process.exit(fail === 0 ? 0 : 1);
}

main().catch(e => { console.error(e); process.exit(1); });
