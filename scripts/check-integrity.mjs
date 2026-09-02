/**
 * Repo self-audit: catch SILENT loss of wiring.
 *
 * Why this exists. Twelve concurrent Claude processes shared one working tree
 * during a long build session, none isolated in a git worktree, and one of
 * them ran a git-hygiene routine (stash, branch, reset --hard). Edits vanished
 * three times. Two were caught only by luck:
 *
 *   check:dist   was referenced by the deploy gate but its definition was
 *                gone. That failed LOUDLY, so it got fixed.
 *   test:signed  was dropped from the gate entirely. That failed SILENTLY:
 *                the gate would have run green forever while the
 *                signed-document tests never executed again.
 *
 * The second kind is the one that matters. A capability can be deleted from
 * the build without anything turning red. So this asserts the wiring itself:
 * every test that exists must run, every script the gate calls must exist,
 * every module that must be reachable must be routed, and every binding the
 * code depends on must be declared.
 *
 * Add a check here whenever you add a capability whose ABSENCE would be quiet.
 */
import { readFile, readdir } from 'node:fs/promises';

const problems = [];
const ok = [];
function check(cond, label, detail) {
  if (cond) ok.push(label);
  else problems.push(`${label}${detail ? '\n      ' + detail : ''}`);
}

const pkg = JSON.parse(await readFile('package.json', 'utf8'));
const scripts = pkg.scripts || {};
// The gate lives in `verify`; `deploy` is just verify + wrangler.
const deploy = (scripts.verify || '') + ' && ' + (scripts.deploy || '');

// ---- 1. Gate references only scripts that exist -------------------------
for (const ref of deploy.split('&&').map(s => s.trim())) {
  const m = /^npm run ([\w:-]+)$/.exec(ref);
  if (!m) continue;
  check(Object.prototype.hasOwnProperty.call(scripts, m[1]),
    `gate calls "${m[1]}" and it is defined`,
    `The deploy gate runs "npm run ${m[1]}" but package.json has no such script. The deploy will abort.`);
}

// ---- 2. Every test script on disk actually RUNS in the gate -------------
// This is the check that would have caught test:signed disappearing.
// .js as well as .mjs. Globbing only .mjs left test-docx-pipeline.js and
// test-templates.js invisible to this whole section: both were on disk, wired
// to nothing, and test-templates.js was FAILING, which is precisely the
// "a test that does not run is worse than no test" case this check exists for.
const testFiles = (await readdir('scripts')).filter(f => /^test-.*\.(mjs|js)$/.test(f));
for (const f of testFiles) {
  const runsIt = Object.entries(scripts).some(([name, body]) =>
    body.includes(`scripts/${f}`) && (deploy.includes(`npm run ${name}`) || name === 'deploy'));
  check(runsIt, `scripts/${f} runs in the deploy gate`,
    `scripts/${f} exists but no script in the deploy chain executes it. It would silently stop protecting the build.`);
}

// ---- 3. Modules that must be reachable are actually routed -------------
const index = await readFile('worker/src/index.js', 'utf8');
const ROUTES = [
  ["'/api/e'", 'funnel telemetry endpoint'],
  ["'/api/owner/funnel'", 'owner funnel tile data'],
  ["'/api/erase/request'", 'self-serve erasure, step 1'],
  ["'/api/erase/confirm'", 'self-serve erasure, step 2'],
  ["'/api/owner/backup/run'", 'on-demand KV backup'],
  ['/signed$', 'canonical signed-PDF delivery'],
];
for (const [needle, what] of ROUTES) {
  check(index.includes(needle), `${what} is routed`,
    `worker/src/index.js no longer contains ${needle}. The capability exists but is unreachable.`);
}

// ---- 4. Modules imported where they must be ----------------------------
const IMPORTS = [
  ['./signed-pdf.js', 'canonical flatten engine'],
  ['./erasure.js', 'erasure engine'],
  ['./events.js', 'funnel instrument'],
  ['./atomic-do.js', 'atomic Durable Object'],
];
for (const [mod, what] of IMPORTS) {
  check(index.includes(mod), `${what} imported by the worker`,
    `worker/src/index.js does not import ${mod}.`);
}

// ---- 5. Bindings the code depends on are declared -----------------------
const wrangler = await readFile('wrangler.jsonc', 'utf8');
const BINDINGS = [
  ['CYBERSYGN_BACKUPS', 'R2 backup bucket (without it the daily backup writes nothing)'],
  ['AtomicCounter', 'Durable Object class (without it the free-tier cap and email guard lose atomicity)'],
  ['CYBERSYGN_DOCS', 'primary KV namespace'],
  ['CYBERSYGN_PDFS', 'PDF KV namespace'],
];
for (const [b, what] of BINDINGS) {
  check(wrangler.includes(b), `${b} is bound`, `wrangler.jsonc no longer declares ${b}: ${what}.`);
}
check(wrangler.includes('new_sqlite_classes'), 'Durable Object migration is declared',
  'wrangler.jsonc has a durable_objects binding but no migration, so deploys will fail.');

// ---- 6. Load-bearing constants that are easy to lose quietly -----------
const CONSTS = [
  ['worker/src/ambassador.js', 'STATE_REPORTING_THRESHOLD', 'Colorado $600 filing threshold'],
  ['worker/src/signed-pdf.js', 'updateMetadata: false', 'pdf-lib determinism (without it every rebuilt hash differs)'],
  ['worker/src/kv-backup.js', 'BACKUP_RETENTION_DAYS', 'backup rotation that makes erasure propagate'],
  ['worker/src/verify.js', 'signedSha256', 'dual-hash verify lookup'],
];
for (const [file, needle, what] of CONSTS) {
  let body = '';
  try { body = await readFile(file, 'utf8'); } catch { /* reported below */ }
  check(body.includes(needle), `${file} still defines ${needle}`,
    `${what} is missing from ${file}.`);
}

// ---- 6a. pdf.js worker wiring (server-side detection) ------------------
//
// Server-side detection was dead for the life of the product. pdf.js parses
// through a worker it loads with a DYNAMIC import of a runtime string, which
// esbuild cannot see, so wrangler never bundled it and every /detect call in
// production answered "unreadable PDF". Node hid it completely, because there
// the same specifier resolves off disk, so the whole test suite passed.
//
// worker/src/detect-server.js fixes that by importing the worker STATICALLY
// and parking its handler on globalThis.pdfjsWorker, where pdf.js looks before
// it falls back to the dynamic import. These checks are DISCOVERY-BASED: they
// read the imports rather than a list, so a new Worker module that reaches for
// the raw detector tomorrow fails the gate without anyone remembering to add it.
{
  const shim = await readFile('worker/src/detect-server.js', 'utf8').catch(() => '');
  check(/^import\s*\{[^}]*WorkerMessageHandler[^}]*\}\s*from\s*['"]pdfjs-dist\/legacy\/build\/pdf\.worker\.min\.mjs['"]/m.test(shim),
    'detect-server.js statically imports pdf.worker.min.mjs',
    'The static worker import is what makes wrangler bundle pdf.js\'s worker. Without it ' +
    'server-side detection returns "No such module pdf.worker.mjs" for every document. ' +
    'A dynamic import() will NOT work: esbuild cannot see it.');
  // The worker module publishes globalThis.pdfjsWorker itself, so this
  // assignment is not what makes detection work. It is what keeps the import
  // above from being tree-shaken: a static import whose binding is never
  // referenced is fair game for a bundler to drop, and dropping it restores
  // the original bug with no other visible change.
  check(/globalThis\.pdfjsWorker\s*\|\|=\s*\{\s*WorkerMessageHandler\s*\}/.test(shim),
    'detect-server.js references WorkerMessageHandler so the import cannot be tree-shaken',
    'Nothing in worker/src/detect-server.js uses the WorkerMessageHandler binding. An unused ' +
    'static import is exactly what a bundler is allowed to drop, which would silently take ' +
    'server-side detection back to "No such module pdf.worker.mjs".');

  // detect.js is copied VERBATIM to dist/preview/detect.js by build-web.js and
  // runs in the browser, where the bare worker specifier is unmapped (the page
  // breaks) and where pdf.js should keep using its real off-main-thread Worker.
  const detectSrc = await readFile('worker/src/detect.js', 'utf8').catch(() => '');
  check(!/pdf\.worker/.test(detectSrc),
    'detect.js stays runtime-neutral (no worker import)',
    'worker/src/detect.js is copied byte-for-byte into the browser bundle. A pdf.worker import ' +
    'here is an unmapped specifier that breaks the preview page, and if mapped it would replace ' +
    'the browser\'s real Worker with the in-process fake one and freeze the UI on every parse. ' +
    'Put Workers-only setup in worker/src/detect-server.js instead.');

  // Every Worker module must go through the shim. Reaching past it silently
  // reintroduces the original bug on that one code path.
  const workerDir = 'worker/src';
  for (const f of await readdir(workerDir)) {
    if (!f.endsWith('.js') || f === 'detect.js' || f === 'detect-server.js') continue;
    const body = await readFile(`${workerDir}/${f}`, 'utf8').catch(() => '');
    check(!/from\s*['"]\.\/detect\.js['"]/.test(body),
      `${f} imports the detector through detect-server.js`,
      `worker/src/${f} imports ./detect.js directly, bypassing the pdf.js worker wiring. ` +
      'Detection from that path will fail in the Workers runtime while passing every Node test. ' +
      "Import { detectFields } from './detect-server.js' instead.");
  }
}

// ---- 6a2. Detection error codes are documented ------------------------
//
// The public API reported an engine that had never worked as "422
// no_fields_detected: No signature fields were found in this PDF", which told
// integrators their contract was empty when the truth was that we never parsed
// it. The codes now say which of the two happened, and the developer docs have
// to keep saying so. Rule 6: copy must be true against the code that ships.
//
// CURATED on purpose, and narrow. 14 other api-v1 codes are undocumented for
// reasons that predate this list; widening it is real work, not a default.
{
  const devDocs = await readFile('web/developers/index.html', 'utf8').catch(() => '');
  const apiSrc = await readFile('worker/src/api-v1.js', 'utf8').catch(() => '');
  const DETECTION_CODES = [
    ['no_fields_detected', 'the PDF was read and has no fields'],
    ['detection_failed', 'the detector threw'],
    ['detection_unavailable', 'the PDF could not be parsed at all, so we claim nothing about it'],
  ];
  for (const [code, meaning] of DETECTION_CODES) {
    check(apiSrc.includes(`'${code}'`), `api-v1.js still emits ${code}`,
      `worker/src/api-v1.js no longer returns ${code} (${meaning}). If that is deliberate, ` +
      'remove it from this list and from web/developers/index.html together.');
    check(devDocs.includes(`<code>${code}</code>`), `${code} is documented for API callers`,
      `web/developers/index.html never mentions ${code}, which the API can return (${meaning}). ` +
      'An integrator cannot handle a response they are not told about.');
  }
}

// ---- 6b. DISCOVERED route + binding coverage ---------------------------
//
// The lists in sections 3 to 6 are CURATED: they only catch what someone
// remembered to add, which is the same drift that let nine test suites go
// quiet. These checks are DISCOVERY-BASED instead. They read what the code
// actually contains, so a capability added tomorrow is covered without anyone
// updating this file.

const workerFiles = (await readdir('worker/src')).filter(f => f.endsWith('.js'));
const sources = new Map();
for (const f of workerFiles) sources.set(f, await readFile(`worker/src/${f}`, 'utf8'));
const allWorkerSrc = [...sources.values()].join('\n');
const testSources = [];
for (const f of (await readdir('scripts')).filter(f => /^test-.*\.mjs$/.test(f))) {
  testSources.push(await readFile(`scripts/${f}`, 'utf8'));
}

// (a) Every exported handler must be reachable from somewhere.
//     This is what "the capability exists but nothing routes it" looks like
//     before it becomes a 404 nobody sees.
for (const [file, body] of sources) {
  if (file === 'index.js') continue;
  for (const m of body.matchAll(/export\s+(?:async\s+)?function\s+([A-Za-z0-9_]+)/g)) {
    const fn = m[1];
    // Referenced by ANY worker module (including its own, since an internal
    // caller is a real caller) or by a test. Restricting this to handle* used
    // to miss every capability that is not an HTTP handler: cron entry points,
    // engines, and helpers can all go dead just as quietly.
    // A REFERENCE, not a mention. The old test was
    // `stripped.includes(fn) && (f2 !== file || stripped.includes(fn))`, whose
    // right conjunct is implied by the left, so it reduced to a bare substring
    // search over raw source INCLUDING COMMENTS. A function could go dead and
    // stay "reachable" because its own doc comment, or a note explaining why it
    // was removed, still named it. Strip comments, then require a call site, an
    // import/export list entry, or a property-style reference.
    // Match on the SHAPE of a reference, and do NOT try to strip comments
    // first. Stripping needs a real JS lexer: a `/*` inside a string or a regex
    // literal makes a naive stripper swallow everything to the next `*/`, which
    // silently ate the dynamic-import call site for setPayoutBlock and reported
    // a live capability as dead. Prose almost never takes these shapes, and a
    // false BROKEN is worse than a rare missed one, because it is the failure
    // that teaches people to distrust the gate.
    const REF = new RegExp(`\\b${fn}\\s*\\(|\\b${fn}\\s*[,}]|\\.\\s*${fn}\\b|\\b${fn}\\s*:`);
    const inWorker = [...sources].some(([f2, b2]) => {
      const stripped = b2.replace(new RegExp(`export\\s+(?:async\\s+)?function\\s+${fn}\\b`, 'g'), '');
      return REF.test(stripped);
    });
    const inTests = testSources.some(b => REF.test(b));
    check(inWorker || inTests, `${fn} (worker/src/${file}) is reachable`,
      `worker/src/${file} exports ${fn} but nothing in worker/src or scripts/test-* references it. Either it is dead code, or a capability lost its caller.`);
  }
}

// (b) Every binding DECLARED in wrangler.jsonc must actually be used.
//     A declared-but-unused binding is either dead config or a capability that
//     silently stopped being called.
const declared = [...wrangler.matchAll(/"(?:binding|name)"\s*:\s*"([A-Z][A-Z0-9_]*)"/g)].map(m => m[1]);
for (const b of new Set(declared)) {
  check(allWorkerSrc.includes(`env.${b}`) || allWorkerSrc.includes(b),
    `binding ${b} is used by the worker`,
    `wrangler.jsonc declares ${b} but no worker source references it.`);
}

// (c) Every binding USED as an object must be declared, or consciously optional.
//     env.X.get(...) against an undeclared binding is undefined at runtime.
//     OPTIONAL_BINDINGS is deliberately tiny: adding one is a decision, not a
//     default, and each needs a reason.
const OPTIONAL_BINDINGS = {
  SIGNUPS: 'legacy dedicated signups namespace; index.js falls back to CYBERSYGN_DOCS under a signup: prefix, so nothing is dropped',
};
const usedAsObject = new Set(
  [...allWorkerSrc.matchAll(/env\.([A-Z][A-Z0-9_]+)\.(?:get|put|delete|list|fetch|writeDataPoint|idFromName)\b/g)].map(m => m[1]),
);
for (const b of usedAsObject) {
  check(declared.includes(b) || b in OPTIONAL_BINDINGS,
    `binding ${b} is declared`,
    `worker code calls env.${b} as an object but wrangler.jsonc does not declare it, so it is undefined at runtime. If that is intentional, add it to OPTIONAL_BINDINGS with a reason.`);
}

// (d) No duplicate API route paths. A second arm for the same method+path is
//     unreachable dead code, and the reader cannot tell which one is live.
const seenRoutes = new Map();
for (const m of index.matchAll(/request\.method === '([A-Z]+)' && url\.pathname === '(\/api\/[^']+)'/g)) {
  const key = `${m[1]} ${m[2]}`;
  seenRoutes.set(key, (seenRoutes.get(key) || 0) + 1);
}
// REGEX routes too. 24 of this file's routes are matched by pattern rather
// than equality, and a duplicated pattern is just as dead as a duplicated
// string while being harder to spot by eye.
for (const m of index.matchAll(/url\.pathname\.match\((\/\^[^\n]*?\/)\)/g)) {
  const key = `PATTERN ${m[1]}`;
  seenRoutes.set(key, (seenRoutes.get(key) || 0) + 1);
}
for (const [route, count] of seenRoutes) {
  check(count === 1, `route ${route} is declared once`,
    `${route} is matched ${count} times in index.js. Only the first can ever run; the rest are dead code.`);
}

// ---- 7. CI runs the SAME gate as deploy ---------------------------------
// Without this, CI drifts back to a short hand-listed set and a merge can be
// green while the real checks never run. That is the same "looks like
// coverage" failure this file exists to prevent, one level up.
let ci = '';
try { ci = await readFile('.github/workflows/ci.yml', 'utf8'); } catch { /* reported below */ }
check(!!ci, 'CI workflow exists', '.github/workflows/ci.yml is missing, so nothing guards a merge.');
if (ci) {
  check(ci.includes('npm run verify'), 'CI runs the shared verify gate',
    'CI does not call `npm run verify`, so it can pass while the deploy gate fails.');
}
check((scripts.deploy || '').includes('npm run verify'),
  'deploy runs the shared verify gate',
  'package.json deploy no longer calls `npm run verify`, so deploy and CI can diverge.');

if (problems.length) {
  console.error(`\ncheck-integrity: ${problems.length} wiring problem(s) found\n`);
  for (const p of problems) console.error('  BROKEN  ' + p);
  console.error(`\n(${ok.length} checks passed)\n`);
  process.exit(1);
}
console.log(`check-integrity: all ${ok.length} wiring checks passed.`);
