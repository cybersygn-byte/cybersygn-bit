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
const testFiles = (await readdir('scripts')).filter(f => /^test-.*\.mjs$/.test(f));
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
