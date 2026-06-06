#!/usr/bin/env node
/**
 * Probe the 10 vision-fallback synthetic PDFs against the text-based detector.
 * Vision-fallback PDFs are SUPPOSED to confuse the text detector. We want them
 * to return few or zero high-confidence signature/date fields — that is what
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
      console.log(`  ERROR   ${name}  ${err.message.slice(0, 80)}`);
    }
  }

  console.log('');
  console.log(`Vision-fallback gate: ${visionRequired} of ${all.length} PDFs would trigger vision in production.`);
  console.log(visionRequired === all.length ? 'All vision-fallback cases gated correctly.' : 'WARNING — some text detection succeeded where vision was expected.');
}

main().catch(e => { console.error(e); process.exit(1); });
