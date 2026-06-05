#!/usr/bin/env node
/**
 * Pre-deploy smoke check.
 *
 * Walks every .js file under web/ and worker/src/ (excluding vendor/
 * and dist/) and runs `node --check` on each. Fails the build on any
 * SyntaxError so a parse-time regression can't reach production
 * silently — the way the slice-86 duplicate `escapeHtml` did before
 * the audit caught it.
 *
 * Runs as the first step of `npm run build` and `npm run build:web`.
 *
 * Why we need this: ES modules with duplicate identifier names, missing
 * brackets, malformed template literals, etc. fail at the parse stage,
 * which means the file never executes. The user sees a working static
 * shell + broken interactivity. Console reveals it but few of our
 * visitors will open devtools.
 */

import { readdir, stat } from 'node:fs/promises';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { cpus } from 'node:os';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

// Directories to scan, relative to ROOT.
const SCAN_ROOTS = ['web', 'worker/src', 'scripts'];

// Skip these — third-party code we don't author + build output.
const SKIP_DIRS = new Set(['vendor', 'dist', 'node_modules', '.git', 'fonts']);

// Skip files matching these patterns.
const SKIP_FILES = [
  /\.min\.js$/,
  /\.bundle\.js$/,
  /\.test\.js$/,        // tests are run by npm test; we don't parse-check them here
];

async function* walk(dir) {
  let entries;
  try { entries = await readdir(dir, { withFileTypes: true }); }
  catch (e) { return; }
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name)) continue;
      yield* walk(p);
    } else if (e.isFile()) {
      if (!/\.(m?js)$/.test(e.name)) continue;
      if (SKIP_FILES.some(re => re.test(e.name))) continue;
      yield p;
    }
  }
}

function check(file) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ['--check', file], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stderr = '';
    child.stderr.on('data', d => { stderr += d.toString(); });
    child.on('close', (code) => {
      resolve({ file, ok: code === 0, stderr: stderr.trim() });
    });
  });
}

async function main() {
  const files = [];
  for (const root of SCAN_ROOTS) {
    for await (const f of walk(join(ROOT, root))) {
      files.push(f);
    }
  }

  if (files.length === 0) {
    console.warn('[smoke] no JS files found — that\'s suspicious');
    process.exit(2);
  }

  // Bounded parallelism.
  const concurrency = Math.max(2, Math.min(8, cpus().length));
  const queue = [...files];
  const results = [];
  async function worker() {
    while (queue.length > 0) {
      const f = queue.shift();
      const r = await check(f);
      results.push(r);
    }
  }
  await Promise.all(Array.from({ length: concurrency }, worker));

  const failed = results.filter(r => !r.ok);
  if (failed.length > 0) {
    console.error(`\n[smoke] FAIL — ${failed.length} of ${results.length} JS files have parse errors:\n`);
    for (const r of failed) {
      // Trim node's verbose error output to the salient SyntaxError line.
      const lines = r.stderr.split('\n');
      const synLine = lines.find(l => /SyntaxError/.test(l)) || lines[0] || '(no stderr)';
      console.error(`  ${relative(ROOT, r.file)}`);
      console.error(`    ${synLine}`);
    }
    console.error('');
    process.exit(1);
  }

  console.log(`[smoke] OK — ${results.length} JS files parse cleanly`);
}

main().catch(err => {
  console.error('[smoke] runner error:', err && err.message ? err.message : err);
  process.exit(2);
});
