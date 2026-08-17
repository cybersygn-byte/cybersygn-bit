#!/usr/bin/env node
/**
 * Probe the 10 vision-fallback synthetic PDFs against the text-based detector.
 * Vision-fallback PDFs are SUPPOSED to confuse the text detector. We want them
 * to return few or zero high-confidence signature/date fields, that is what
 * forces the vision pipeline to fire in production.
 *
 * Pass criterion: each PDF returns at most 1 detected SIGNATURE field via
 * text-only detection. That confirms vision needs to handle them.
 *
 * Run: node scripts/probe-vision-pdfs.mjs
 */

import { readFile, readdir } from 'node:fs/promises';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { detectFields } from '../worker/src/detect.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const PDF_DIR = resolve(HERE, '..', 'test-pdfs');

async function main() {
  const all = (await readdir(PDF_DIR)).filter(f => /^(1[1-9]|20)-/.test(f) && f.endsWith('.pdf')).sort();
  console.log(`Probing ${all.length} vision-fallback PDFs ...`);
  console.log('');

  let visionRequired = 0;
  let errored = 0;
  for (const name of all) {
    const buf = await readFile(join(PDF_DIR, name));
    const bytes = new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
    try {
      const result = await detectFields(bytes);
      const fields = result.fields || [];
      const sigs = fields.filter(f => f.type === 'signature').length;
      const dates = fields.filter(f => f.type === 'date').length;
      const cbs = fields.filter(f => f.type === 'checkbox').length;
      const willInvokeVision = sigs <= 1; // text-only is weak → vision will fire
      if (willInvokeVision) visionRequired += 1;
      const tag = willInvokeVision ? 'VISION ' : 'TEXT-OK';
      console.log(`  ${tag}  ${name.padEnd(34)}  sigs=${sigs}  dates=${dates}  cb=${cbs}  total=${fields.length}`);
    } catch (err) {
      errored += 1;
      console.log(`  ERROR   ${name}  ${err.message.slice(0, 80)}`);
    }
  }

  console.log('');
  console.log(`Vision-fallback gate: ${visionRequired} of ${all.length} PDFs would trigger vision in production.`);
  /* This corpus (files 11-20) is designed so EVERY PDF must fall back to vision.
     The pass criterion in this file's header is real, so enforce it: a PDF that
     the text detector handled on its own, or that threw, is a regression that
     must turn the gate red. Previously the warning branch only printed and
     main() returned 0, so this probe could never fail its own stated rule. */
  const passed = errored === 0 && visionRequired === all.length && all.length > 0;
  if (passed) {
    console.log('PASS: all vision-fallback cases gated correctly.');
  } else {
    console.log(`FAIL: ${all.length - visionRequired} case(s) did not need vision, ${errored} errored. Vision fallback is not gating as designed.`);
  }
  process.exit(passed ? 0 : 1);
}

main().catch(e => { console.error(e); process.exit(1); });
