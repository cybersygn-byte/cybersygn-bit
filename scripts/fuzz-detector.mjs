#!/usr/bin/env node
/**
 * Adversarial fuzz harness for the field detector (worker/src/detect.js).
 *
 * Throws a battery of pathological inputs at detectFields() and records, for
 * each, whether it: returned cleanly (ok), threw (CRASH), or exceeded a time
 * budget (HANG). The money-maker must NEVER crash or hang on any input — the
 * worst acceptable outcome is "returned zero fields."
 *
 * Run: node scripts/fuzz-detector.mjs
 */

import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { detectFields } from '../worker/src/detect.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const TIMEOUT_MS = 20000;

function withTimeout(promise, ms, label) {
  let t;
  const timeout = new Promise((_, rej) => { t = setTimeout(() => rej(new Error(`HANG > ${ms}ms`)), ms); });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(t));
}

function u8(...bytes) { return new Uint8Array(bytes); }
function ascii(s) { return new TextEncoder().encode(s); }
function randomBytes(n) {
  const a = new Uint8Array(n);
  // deterministic pseudo-random so runs are reproducible
  let x = 0x9e3779b9;
  for (let i = 0; i < n; i++) { x ^= x << 13; x ^= x >>> 17; x ^= x << 5; a[i] = x & 0xff; }
  return a;
}

async function buildCases() {
  const cases = [];

  cases.push(['empty Uint8Array', new Uint8Array(0)]);
  cases.push(['one byte', u8(0x25)]);
  cases.push(['1KB random garbage', randomBytes(1024)]);
  cases.push(['PDF header then garbage', new Uint8Array([...ascii('%PDF-1.4\n'), ...randomBytes(512)])]);
  cases.push(['PNG magic bytes', u8(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13)]);
  cases.push(['plain text file', ascii('This is a contract.\nSignature: ____\nDate: ____\n')]);
  cases.push(['null byte soup', randomBytes(4096).map(() => 0)]);
  cases.push(['xref-less PDF stub', ascii('%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF')]);

  // A real, valid template PDF — must still return fields (regression).
  const validPdf = join(ROOT, 'web', 'templates-pdf', 'master-services-agreement.pdf');
  if (existsSync(validPdf)) {
    const buf = await readFile(validPdf);
    const bytes = new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
    cases.push(['VALID master-services-agreement (regression)', bytes]);
    // Truncated real PDF — header valid, body cut off.
    cases.push(['truncated real PDF (first 300 bytes)', bytes.slice(0, 300)]);
    // Real PDF with a flipped byte mid-stream.
    const corrupt = bytes.slice();
    corrupt[Math.floor(corrupt.length / 2)] ^= 0xff;
    cases.push(['real PDF with corrupted mid-byte', corrupt]);
    // Real PDF with truncated tail (xref/trailer removed).
    cases.push(['real PDF, tail truncated', bytes.slice(0, Math.floor(bytes.length * 0.8))]);
  }

  // A deliberately huge stress PDF if present (generated separately).
  const stress = join(ROOT, 'web', 'templates-pdf', '_stress-huge.pdf');
  if (existsSync(stress)) {
    const buf = await readFile(stress);
    cases.push(['STRESS huge PDF (many fields/pages)', new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength)]);
  }

  return cases;
}

async function main() {
  const cases = await buildCases();
  console.log(`Running ${cases.length} adversarial cases (timeout ${TIMEOUT_MS}ms)...\n`);

  let crashes = 0, hangs = 0, ok = 0;
  for (const [name, input] of cases) {
    const start = Date.now();
    let status, detail = '';
    try {
      const r = await withTimeout(detectFields(input), TIMEOUT_MS, name);
      const n = (r && r.fields) ? r.fields.length : 0;
      // Detect NaN / Infinity garbage in output coordinates.
      const bad = (r && r.fields || []).some(f =>
        ![f.x, f.y, f.width, f.height].every(v => Number.isFinite(v)));
      status = bad ? 'OK-BUT-NAN' : 'ok';
      detail = `pages=${r ? r.pageCount : '?'} fields=${n}${bad ? ' <-- NaN/Inf coords' : ''}`;
      if (bad) crashes++; else ok++;
    } catch (e) {
      const msg = String(e && e.message || e);
      if (/HANG/.test(msg)) { status = 'HANG'; hangs++; }
      else { status = 'CRASH'; crashes++; }
      detail = msg.slice(0, 110);
    }
    const ms = Date.now() - start;
    const tag = status === 'ok' ? 'ok   ' : status === 'OK-BUT-NAN' ? 'NAN  ' : status === 'HANG' ? 'HANG ' : 'CRASH';
    console.log(`  [${tag}] ${name.padEnd(46)} ${String(ms).padStart(6)}ms  ${detail}`);
  }

  console.log(`\n${ok} clean, ${crashes} crash/garbage, ${hangs} hang, of ${cases.length}.`);
  console.log(crashes + hangs === 0
    ? 'DETECTOR SURVIVED EVERY INPUT.'
    : `DETECTOR BROKE on ${crashes + hangs} input(s) — diagnose and harden.`);
  process.exit(crashes + hangs === 0 ? 0 : 1);
}

main().catch(e => { console.error('harness error:', e); process.exit(2); });
