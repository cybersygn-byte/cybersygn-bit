/**
 * Server-side detection wiring test.
 *
 * The defect this guards against shipped and survived every existing test.
 * pdf.js parses PDFs in a worker it loads with a DYNAMIC import of
 * GlobalWorkerOptions.workerSrc. esbuild cannot see a runtime string, so
 * wrangler never bundled the module and the Cloudflare Workers runtime
 * answered every /detect call with:
 *
 *     Setting up fake worker failed: "No such module "pdf.worker.mjs"."
 *
 * Node never reproduced it, because there the same relative specifier
 * resolves off disk next to pdf.mjs. So the entire suite stayed green while
 * server-side detection had never once worked in production.
 *
 * A test that just calls detectFields() in Node therefore proves NOTHING: it
 * passes with the fix and without it. This one instead reproduces the Workers
 * condition by pointing workerSrc at a module that cannot resolve, which is
 * exactly the state the Workers runtime is in. Detection must still succeed,
 * because worker/src/detect-server.js publishes the handler on
 * globalThis.pdfjsWorker and pdf.js checks that BEFORE the dynamic import.
 *
 * Scenario 2 is the control, and it is the point of the file. It runs the same
 * sabotage against the raw detector and asserts it FAILS. Without it, scenario
 * 1 could be passing because the sabotage never bit, which is the same shape
 * of mistake as the mock that honored an option real Workers KV ignores.
 *
 * pdf.js memoizes the resolved handler with shadow() on first use, so each
 * scenario needs its own process.
 */

import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

const PDF = 'test-pdfs/01-simple-signature.pdf';
// Mirrors the Workers runtime: a bare relative specifier with nothing behind it.
const BAD_SRC = './pdf.worker.__nonexistent__.mjs';

let failures = 0;
function check(ok, name, detail) {
  if (ok) { console.log(`  ok    ${name}`); return; }
  failures++;
  console.log(`  FAIL  ${name}`);
  if (detail) console.log(`        ${detail}`);
}

/** Run one scenario in a clean process and return its parsed verdict. */
function scenario(label, moduleUnderTest) {
  const src = `
    import { GlobalWorkerOptions } from 'pdfjs-dist/legacy/build/pdf.mjs';
    // Sabotage the dynamic-import path the way the Workers runtime does.
    GlobalWorkerOptions.workerSrc = ${JSON.stringify(BAD_SRC)};
    const mod = await import(${JSON.stringify(pathToFileURL(resolve(moduleUnderTest)).href)});
    const { readFile } = await import('node:fs/promises');
    const bytes = new Uint8Array(await readFile(${JSON.stringify(PDF)}));
    const r = await mod.detectFields(bytes);
    process.stdout.write('@@' + JSON.stringify({
      fields: (r.fields || []).length,
      pageCount: r.pageCount || 0,
      error: r.error || null,
      ready: typeof mod.pdfWorkerReady === 'function' ? mod.pdfWorkerReady() : null,
    }) + '@@');
  `;
  const run = spawnSync(process.execPath, ['--input-type=module', '-e', src], {
    encoding: 'utf8', timeout: 60_000,
  });
  const out = `${run.stdout || ''}`;
  const m = out.match(/@@(.*)@@/s);
  if (!m) {
    return { crashed: true, detail: (run.stderr || out || 'no output').trim().slice(0, 300) };
  }
  return JSON.parse(m[1]);
}

console.log('test-pdf-worker: server-side detection wiring\n');

// ---- Scenario 1: the shim. Must parse despite an unresolvable workerSrc. ----
const shim = scenario('shim', 'worker/src/detect-server.js');
check(!shim.crashed, 'detect-server.js loads with an unresolvable workerSrc', shim.detail);
if (!shim.crashed) {
  check(shim.error === null,
    'detect-server.js parses a PDF the Workers runtime could not',
    `detectFields returned error: ${shim.error}. The static worker import or the ` +
    'globalThis.pdfjsWorker assignment in worker/src/detect-server.js is not taking effect.');
  check(shim.fields === 3,
    'detect-server.js finds all 3 fields in 01-simple-signature.pdf',
    `expected 3 fields, got ${shim.fields}`);
  check(shim.pageCount === 1, 'detect-server.js reports the page count',
    `expected 1 page, got ${shim.pageCount}`);
  check(shim.ready === true, 'pdfWorkerReady() reports the engine as wired',
    `pdfWorkerReady() returned ${shim.ready}`);
}

// ---- Scenario 2: CONTROL. The raw detector must FAIL the same sabotage. ----
// If this passes, the sabotage is not reproducing the Workers condition and
// scenario 1 proves nothing.
const raw = scenario('raw', 'worker/src/detect.js');
// A crash is NOT evidence: a bad path or a missing fixture also crashes, and
// counting that as proof is how a control quietly stops controlling anything.
// Demand the exact pdf.js signature the Workers runtime produced.
check(!raw.crashed,
  'CONTROL: the raw detector runs (a crash would prove nothing either way)',
  `worker/src/detect.js could not even be loaded: ${raw.detail}. This test cannot ` +
  'validate the fix until the harness itself runs.');
if (!raw.crashed) {
  check(/fake worker|No such module/i.test(raw.error || ''),
    'CONTROL: raw detect.js fails without the shim, so scenario 1 is meaningful',
    `worker/src/detect.js returned error=${JSON.stringify(raw.error)} (fields=${raw.fields}). ` +
    'Expected the "Setting up fake worker failed" error that Cloudflare Workers produced. ' +
    'The unresolvable workerSrc is no longer reproducing that failure, so scenario 1 would ' +
    'pass even with the fix reverted. Fix this test before trusting it.');
}

// ---- Scenario 3: the browser copy must stay free of the worker import. ----
// build-web.js copies worker/src/detect.js verbatim into dist/preview/detect.js.
// A bare pdf.worker specifier there is unmapped by the importmap and takes the
// whole preview page down.
let dist = '';
try { dist = await readFile('web/dist/preview/detect.js', 'utf8'); } catch { /* not built */ }
if (dist) {
  check(!dist.includes('pdf.worker'),
    'the browser copy of the detector carries no worker import',
    'web/dist/preview/detect.js references pdf.worker. That specifier is not in the preview ' +
    'importmap, so the preview page fails to load its module graph.');
} else {
  console.log('  skip  browser copy check (web/dist not built yet)');
}

console.log('');
if (failures) {
  console.error(`test-pdf-worker: ${failures} check(s) failed.`);
  process.exit(1);
}
console.log('test-pdf-worker: all checks passed.');
