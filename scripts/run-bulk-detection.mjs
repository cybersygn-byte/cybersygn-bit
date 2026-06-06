#!/usr/bin/env node
/**
 * Bulk-detection runner. Walks every PDF in real-pdfs/ and runs detection
 * via worker/src/detect.js. Reports counts and writes a summary JSON.
 *
 * Run: node scripts/run-bulk-detection.mjs
 *
 * Output: bulk-detection-results.json + a console summary.
 *
 * "Successfully processed" means detection ran without throwing and
 * returned at least one field. Documents that returned zero fields are
 * still counted in the total — they just did not have detectable
 * signature/date/checkbox patterns in the text layer. Vision-fallback
 * is not invoked here (intentionally — this is the text-layer pass).
 */

import { readFile, readdir, writeFile } from 'node:fs/promises';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { detectFields } from '../worker/src/detect.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const PDF_DIR = resolve(HERE, '..', 'real-pdfs');
const OUT_PATH = resolve(HERE, '..', 'bulk-detection-results.json');

async function main() {
  const entries = (await readdir(PDF_DIR)).filter(f => f.toLowerCase().endsWith('.pdf')).sort();
  console.log(`Scanning ${entries.length} PDFs from real-pdfs/ ...`);

  const results = {};
  const summary = {
    total: entries.length,
    parsedOk: 0,
    withAnyField: 0,
    withSignatureField: 0,
    withDateField: 0,
    withCheckboxField: 0,
    avgFieldsPerDoc: 0,
    totalFields: 0,
    parseErrors: 0,
    errors: [],
  };

  for (const name of entries) {
    const path = join(PDF_DIR, name);
    try {
      const buf = await readFile(path);
      const bytes = new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
      const result = await detectFields(bytes);
      const fields = result.fields || [];
      const sigCount = fields.filter(f => f.type === 'signature').length;
      const dateCount = fields.filter(f => f.type === 'date').length;
      const cbCount = fields.filter(f => f.type === 'checkbox').length;
      results[name] = {
        pageCount: result.pageCount,
        fieldCount: fields.length,
        signatureCount: sigCount,
        dateCount,
        checkboxCount: cbCount,
      };
      summary.parsedOk += 1;
      summary.totalFields += fields.length;
      if (fields.length > 0) summary.withAnyField += 1;
      if (sigCount > 0) summary.withSignatureField += 1;
      if (dateCount > 0) summary.withDateField += 1;
      if (cbCount > 0) summary.withCheckboxField += 1;
    } catch (err) {
      summary.parseErrors += 1;
      summary.errors.push({ file: name, error: String(err).slice(0, 200) });
      results[name] = { error: String(err).slice(0, 200) };
    }
  }

  summary.avgFieldsPerDoc = summary.parsedOk > 0
    ? Math.round((summary.totalFields / summary.parsedOk) * 10) / 10
    : 0;
  summary.successRate = summary.total > 0
    ? Math.round((summary.withAnyField / summary.total) * 1000) / 10  // one decimal place
    : 0;

  await writeFile(OUT_PATH, JSON.stringify({ summary, results }, null, 2));

  console.log('');
  console.log('Summary:');
  console.log(`  Total PDFs scanned:        ${summary.total}`);
  console.log(`  Parsed without error:      ${summary.parsedOk}`);
  console.log(`  At least one field found:  ${summary.withAnyField}  (${summary.successRate}%)`);
  console.log(`  With a signature field:    ${summary.withSignatureField}`);
  console.log(`  With a date field:         ${summary.withDateField}`);
  console.log(`  With a checkbox field:     ${summary.withCheckboxField}`);
  console.log(`  Avg fields per parsed doc: ${summary.avgFieldsPerDoc}`);
  if (summary.parseErrors > 0) {
    console.log(`  Parse errors:              ${summary.parseErrors}`);
  }
  console.log(`Wrote ${OUT_PATH}`);
}

main().catch(err => { console.error(err); process.exit(1); });
