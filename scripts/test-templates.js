/**
 * Template round-trip test.
 *
 * Every template the library ships must pass through the full pipeline
 * cleanly: docx -> docxToPdfFile -> detectFields -> at least
 * signatureCount signatures and signatureCount dates detected.
 *
 * The point of this test is that the templates and the detector stay in
 * sync. If someone edits a template and the new structure no longer
 * detects, CI fails. If someone changes the detector and a shipped
 * template stops detecting, CI fails. Either side can move; this test
 * is the guardrail.
 *
 * Run:
 *   npm run test:templates
 *
 * Prerequisite:
 *   npm run build:templates   # regenerates templates/generated/*.docx
 */

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { TEMPLATES } from '../templates/agreements/index.js';
import { docxToPdfFile } from '../web/preview/docx-to-pdf.js';
import { detectFields } from '../worker/src/detect.js';

if (typeof globalThis.File === 'undefined') {
  globalThis.File = class File extends Blob {
    constructor(parts, name, opts = {}) {
      super(parts, opts);
      this.name = name;
      this.lastModified = (opts && opts.lastModified) || Date.now();
    }
  };
}

const HERE = dirname(fileURLToPath(import.meta.url));
const GENERATED_DIR = resolve(HERE, '..', 'templates', 'generated');

let passed = 0;
let failed = 0;

function tally(fields) {
  const t = {};
  for (const f of fields) t[f.type] = (t[f.type] || 0) + 1;
  return t;
}

async function checkTemplate(tpl) {
  const docxPath = join(GENERATED_DIR, `${tpl.id}.docx`);
  let bytes;
  try {
    bytes = await readFile(docxPath);
  } catch {
    throw new Error(
      `${tpl.id}: ${docxPath} not found. Run "npm run build:templates" first.`,
    );
  }

  // Round-trip through the docx ingestion path, exactly as a user upload
  // would. The detector is the last stop; if it does not find the
  // expected fields here, real users will not see the right fields when
  // they upload this template either.
  const docxFile = new File([bytes], `${tpl.id}.docx`);
  const pdfFile = await docxToPdfFile(docxFile);
  const pdfBytes = new Uint8Array(await pdfFile.arrayBuffer());
  const result = await detectFields(pdfBytes);
  const t = tally(result.fields);

  const sigs = t.signature || 0;
  const dates = t.date || 0;
  const expected = tpl.signatureCount;

  assert.ok(
    sigs >= expected,
    `${tpl.id}: expected >=${expected} signatures, got ${sigs}. Tally: ${JSON.stringify(t)}`,
  );
  assert.ok(
    dates >= expected,
    `${tpl.id}: expected >=${expected} dates, got ${dates}. Tally: ${JSON.stringify(t)}`,
  );

  return { sigs, dates, pages: result.pageCount, total: result.fields.length };
}

console.log(`Template round-trip test: ${TEMPLATES.length} templates`);
console.log('');

for (const tpl of TEMPLATES) {
  try {
    const r = await checkTemplate(tpl);
    console.log(
      `  OK   ${tpl.id} v${tpl.version}  pages=${r.pages}  ` +
        `sigs=${r.sigs}/${tpl.signatureCount}  dates=${r.dates}/${tpl.signatureCount}  ` +
        `total=${r.total}`,
    );
    passed += 1;
  } catch (err) {
    console.log(`  FAIL ${tpl.id}: ${err.message}`);
    failed += 1;
  }
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
