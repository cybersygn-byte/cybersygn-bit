/**
 * Preview-app contract tests (web/preview/app.js).
 *
 * app.js is a browser module that touches the DOM at import time, so there is
 * nothing to import here. These are source-level assertions, which is a blunt
 * instrument, chosen because each of the three regressions below is a matter
 * of ORDER or PRESENCE in the source and each one shipped silently:
 *
 *  - enterEmbedMode wrote an error and then called resetApp(), whose last two
 *    acts are setStatus('idle') + hideError(). Every failed ?pdf= load was a
 *    silent dead end, on the homepage's primary CTA path.
 *  - the finishing modal built "Send for signature" only when the load-time
 *    status probe had succeeded. That probe times out at 2.5s and caches the
 *    failure, so one slow moment removed the button for the rest of the
 *    session while the lede above it still promised "Two ways to finish".
 *  - the free-tier download call named no document, so a download and a send
 *    of the SAME PDF billed two of the three free documents.
 *
 * Run: node scripts/test-preview-contracts.mjs
 */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const src = await readFile(join(ROOT, 'web', 'preview', 'app.js'), 'utf8');

let pass = 0, fail = 0;
const results = [];
function t(name, fn) {
  try { fn(); pass++; results.push(`OK   ${name}`); }
  catch (e) { fail++; results.push(`FAIL ${name}\n       ${e.message.split('\n')[0]}`); }
}

/** The body of a top-level `async function NAME(` / `function NAME(`. */
function bodyOf(name) {
  const start = src.search(new RegExp(`(async )?function ${name}\\s*\\(`));
  assert.ok(start >= 0, `${name} not found in app.js`);
  let i = src.indexOf('{', start);
  let depth = 0;
  for (let j = i; j < src.length; j++) {
    if (src[j] === '{') depth++;
    else if (src[j] === '}') { depth--; if (depth === 0) return src.slice(i, j + 1); }
  }
  throw new Error(`could not find the end of ${name}`);
}

t('enterEmbedMode resets BEFORE it reports the failure', () => {
  const body = bodyOf('enterEmbedMode');
  const cat = body.indexOf('catch');
  assert.ok(cat > 0, 'enterEmbedMode still has a catch');
  const tail = body.slice(cat);
  const reset = tail.indexOf('resetApp()');
  const err = tail.indexOf('showError(');
  const stat = tail.search(/setStatus\(\s*'error'/);
  assert.ok(reset >= 0, 'the failure path still resets the app');
  assert.ok(err >= 0, 'the failure path still shows an error');
  assert.ok(stat >= 0, "the failure path still sets an 'error' status");
  assert.ok(reset < err, 'resetApp() runs before showError(), or the banner is wiped');
  assert.ok(reset < stat, "resetApp() runs before setStatus('error'), or the pill is wiped");
});

t('enterEmbedMode passes showError the one argument it takes', () => {
  const body = bodyOf('enterEmbedMode');
  const call = body.slice(body.indexOf('showError('));
  // Count top-level commas inside the showError(...) argument list.
  let depth = 0, commas = 0;
  for (let i = call.indexOf('(') ; i < call.length; i++) {
    const c = call[i];
    if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']' || c === '}') { depth--; if (depth === 0) break; }
    else if (c === ',' && depth === 1) commas++;
  }
  // A trailing comma before the closing paren is allowed, a second argument
  // is not: showError(msg) drops anything after the first argument, which is
  // where the reason for the failure used to go.
  // (A trailing comma also counts as one, hence <= 1 rather than == 0.)
  assert.ok(commas <= 1, 'showError called with more than one argument');
});

t('the finishing modal builds the send button unconditionally', () => {
  const body = bodyOf('openSendModal');
  assert.ok(
    !/if\s*\(\s*workerStatus\.ok\s*&&/.test(body),
    'the send button is gated on workerStatus.ok again, so a failed probe hides it',
  );
  assert.ok(/const sendBtn = document\.createElement\('button'\)/.test(body), 'send button still built');
  assert.ok(/refreshWorkerStatus\(\)/.test(body), 'the modal re-probes the Worker when it opens');
  assert.ok(/Retry connection/.test(body), 'an offline modal offers a retry');
  assert.ok(/sendBtn\.disabled = offline/.test(body), 'an unreachable Worker disables rather than removes');
});

t('the on-demand probe outlives the 2.5s load-time budget', () => {
  const m = src.match(/const STATUS_REPROBE_MS = (\d+);/);
  assert.ok(m, 'STATUS_REPROBE_MS is defined');
  assert.ok(Number(m[1]) > 2500, `re-probe budget ${m[1]}ms must beat the 2500ms load probe`);
  const body = bodyOf('refreshWorkerStatus');
  assert.ok(/_statusReprobe = null/.test(body), 'a failed probe is not cached, or Retry does nothing');
});

t('both billing call sites name the document', () => {
  const consume = bodyOf('ensureFreeDownloadCredit');
  assert.ok(/X-CyberSygn-Doc-Sha/.test(consume), 'the download path sends the document hash');
  const sendSites = src.match(/createDoc\(\{[\s\S]*?\n\s*\}\);/g) || [];
  assert.equal(sendSites.length, 2, `expected 2 createDoc call sites, found ${sendSites.length}`);
  for (const site of sendSites) {
    assert.ok(/sha256: billingDocSha\(\)/.test(site), 'a send path does not name the document');
  }
});

t('the billing hash is a hash, never the unkeyed sentinel', () => {
  const body = bodyOf('billingDocSha');
  assert.ok(/\[0-9a-f\]\{64\}/.test(body), 'billingDocSha shape-checks the hash');
  assert.ok(/unkeyed/.test(bodyOf('freeCreditKey')), 'the unkeyed sentinel still exists to be excluded');
});

console.log(results.join('\n'));
console.log(`\npreview contracts: ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
