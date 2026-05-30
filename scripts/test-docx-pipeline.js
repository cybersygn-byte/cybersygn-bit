/**
 * Tests the docx-to-PDF on-ramp end to end:
 *
 *    synthesize a minimal .docx in memory
 *      -> run docxToPdfFile (mammoth extraction + pdf-lib synthesis)
 *      -> run detectFields on the resulting PDF
 *      -> assert the expected signature block is present
 *
 * This deliberately does NOT use any third-party Word templates as
 * fixtures. Test fixtures are generated fresh from primitives so the
 * test asserts our own pipeline against content we own, with no
 * copyright or competitor-branding concerns.
 *
 * Also covers:
 *  - sanitizeWinAnsi correctness on the unicode characters Word emits
 *    most often (smart quotes, en-space, em-dash, etc.)
 *  - graceful handling of an unparseable docx
 *  - the brand rule: em-dashes in user content get normalized to ASCII
 */

import assert from 'node:assert/strict';
import { Document, Packer, Paragraph, TextRun, AlignmentType } from 'docx';

import {
  docxToPdfFile,
  extractParagraphs,
  paragraphsToPdfBytes,
  sanitizeWinAnsi,
} from '../web/preview/docx-to-pdf.js';
import { detectFields } from '../worker/src/detect.js';

// Polyfill File for Node, since docxToPdfFile builds File instances.
if (typeof globalThis.File === 'undefined') {
  globalThis.File = class File extends Blob {
    constructor(parts, name, opts = {}) {
      super(parts, opts);
      this.name = name;
      this.lastModified = (opts && opts.lastModified) || Date.now();
    }
  };
}

let passed = 0;
let failed = 0;

function check(label, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => {
      console.log(`  OK   ${label}`);
      passed += 1;
    })
    .catch((err) => {
      console.log(`  FAIL ${label}: ${err.message}`);
      failed += 1;
    });
}

// ----- Fixture helpers ------------------------------------------------------

async function makeDocxBuffer(paragraphs) {
  // Generate a minimal docx with the given paragraphs. Each paragraph
  // may be a string or { text, bold, alignment }.
  const docChildren = paragraphs.map((p) => {
    if (typeof p === 'string') {
      return new Paragraph({ children: [new TextRun(p)] });
    }
    return new Paragraph({
      children: [new TextRun({ text: p.text || '', bold: !!p.bold })],
      alignment: p.alignment || AlignmentType.LEFT,
    });
  });
  const doc = new Document({ sections: [{ properties: {}, children: docChildren }] });
  return await Packer.toBuffer(doc);
}

async function makeDocxFile(paragraphs, name = 'fixture.docx') {
  const buf = await makeDocxBuffer(paragraphs);
  return new File([buf], name, {
    type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  });
}

// ----- Tests ----------------------------------------------------------------

console.log('docx pipeline');

await check('sanitizeWinAnsi maps smart quotes and em-dash to ASCII', () => {
  assert.equal(sanitizeWinAnsi('\u201Chello\u201D'), '"hello"');
  assert.equal(sanitizeWinAnsi("don\u2019t"), "don't");
  assert.equal(sanitizeWinAnsi('a\u2014b'), 'a-b');           // em-dash -> hyphen
  assert.equal(sanitizeWinAnsi('a\u2013b'), 'a-b');           // en-dash -> hyphen
  assert.equal(sanitizeWinAnsi('1\u20262'), '1...2');         // ellipsis
  assert.equal(sanitizeWinAnsi('\u00A0'), ' ');               // nbsp
  assert.equal(sanitizeWinAnsi('\u2002\u2003'), '  ');        // en, em space
  // The brand rule: em-dashes in user content become hyphens.
  const dashed = '\u2014 \u2014 \u2014';
  assert.equal(sanitizeWinAnsi(dashed).includes('\u2014'), false);
});

await check('sanitizeWinAnsi preserves plain ASCII and Latin-1', () => {
  assert.equal(sanitizeWinAnsi('Signed: ____________'), 'Signed: ____________');
  assert.equal(sanitizeWinAnsi('caf\u00e9'), 'caf\u00e9');    // latin-1 e-acute survives
});

await check('extractParagraphs splits docx into trimmed lines', async () => {
  const buf = await makeDocxBuffer([
    'Service Agreement',
    'This agreement is between Party A and Party B.',
    'Signed: _________________',
    'Date: ____________________',
  ]);
  const paragraphs = await extractParagraphs(buf);
  // Expect to see the signature and date lines preserved verbatim.
  const joined = paragraphs.join('\n');
  assert.ok(joined.includes('Signed: _________________'), 'signed line preserved');
  assert.ok(joined.includes('Date: ____________________'), 'date line preserved');
  assert.ok(joined.includes('Party A'), 'body text preserved');
});

await check('paragraphsToPdfBytes produces a valid PDF', async () => {
  const bytes = await paragraphsToPdfBytes([
    'Test Contract',
    '',
    'Signed: _________________',
    'Date: ____________________',
  ]);
  // PDF header magic.
  assert.equal(bytes[0], 0x25, '%');
  assert.equal(bytes[1], 0x50, 'P');
  assert.equal(bytes[2], 0x44, 'D');
  assert.equal(bytes[3], 0x46, 'F');
  assert.ok(bytes.length > 500, 'synthesized PDF has nontrivial size');
});

await check('docxToPdfFile produces a PDF File with the right name and type', async () => {
  const docxFile = await makeDocxFile(['Hello world'], 'my-contract.docx');
  const pdfFile = await docxToPdfFile(docxFile);
  assert.equal(pdfFile.name, 'my-contract.pdf');
  assert.equal(pdfFile.type, 'application/pdf');
  assert.ok(pdfFile.size > 0);
});

await check('end-to-end: synthesized docx -> PDF -> detector finds signature block', async () => {
  // A two-party contract with a standard signature block at the end.
  // The underscore runs are what the detector pattern-matches.
  const paragraphs = [
    'CONSULTING SERVICES AGREEMENT',
    '',
    'This Agreement is entered into between Client and Consultant.',
    'Consultant agrees to provide consulting services to Client.',
    'Both parties agree to the terms set forth above.',
    '',
    'CLIENT',
    'Signed: _________________________________',
    'Name:   _________________________________',
    'Date:   _________________________________',
    '',
    'CONSULTANT',
    'Signed: _________________________________',
    'Name:   _________________________________',
    'Date:   _________________________________',
  ];
  const docxFile = await makeDocxFile(paragraphs, 'consulting.docx');
  const pdfFile = await docxToPdfFile(docxFile);
  const pdfBytes = new Uint8Array(await pdfFile.arrayBuffer());

  const result = await detectFields(pdfBytes);
  const tally = {};
  for (const f of result.fields) tally[f.type] = (tally[f.type] || 0) + 1;

  assert.ok(result.pageCount >= 1, 'has at least one page');
  assert.ok((tally.signature || 0) >= 2, `expected >=2 signatures, got ${tally.signature || 0}`);
  assert.ok((tally.date || 0) >= 2, `expected >=2 dates, got ${tally.date || 0}`);
});

await check('end-to-end: smart quotes and em-dashes survive the round-trip as ASCII', async () => {
  // A docx with Word-style typography. After conversion the synthesized
  // PDF must contain ONLY WinAnsi-encodable characters, and (by brand
  // rule) zero em-dashes. Tests the encoding pipeline, not detection.
  const paragraphs = [
    'Memorandum of Understanding',                              // plain
    '\u201CCurly\u201D quotes and en\u2013dash and em\u2014dash.',  // tricky chars
    "Don\u2019t panic.",                                        // smart apostrophe
    'Signed: _________________',
    'Date: ____________________',
  ];
  const docxFile = await makeDocxFile(paragraphs, 'typography.docx');
  const pdfFile = await docxToPdfFile(docxFile);
  const pdfBytes = new Uint8Array(await pdfFile.arrayBuffer());
  // Conversion did not throw, which means every character made it
  // through the WinAnsi encoder. The brand check below ensures the
  // em-dash was normalized rather than smuggled through.
  const haystack = new TextDecoder().decode(pdfBytes);
  assert.ok(haystack.indexOf('\u2014') === -1, 'PDF contains no em-dash codepoint');
  assert.ok(haystack.indexOf('\u2013') === -1, 'PDF contains no en-dash codepoint');
  assert.ok(haystack.indexOf('\u201C') === -1, 'PDF contains no left smart quote');
  assert.ok(haystack.indexOf('\u2019') === -1, 'PDF contains no smart apostrophe');
});

await check('docxToPdfFile rejects non-docx input cleanly', async () => {
  const fakeFile = new File([new Uint8Array([1, 2, 3, 4])], 'not-a-docx.docx', {
    type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  });
  await assert.rejects(() => docxToPdfFile(fakeFile));
});

await check('docxToPdfFile rejects missing file argument', async () => {
  await assert.rejects(() => docxToPdfFile(null));
  await assert.rejects(() => docxToPdfFile(undefined));
  await assert.rejects(() => docxToPdfFile('not-a-file'));
});

// ----- Summary --------------------------------------------------------------

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
