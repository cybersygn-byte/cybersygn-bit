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

import { readdir, stat, readFile } from 'node:fs/promises';
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

async function exists(p) {
  try { await stat(p); return true; } catch { return false; }
}

/**
 * Templates-library integrity check.
 *
 * A missing or out-of-sync templates library is an audit-blocker: the
 * /templates/ page silently falls back to a tiny stub list and every PDF
 * download 404s into a generated wireframe. This asserts the source library
 * under web/ is complete and internally consistent BEFORE build-web.js copies
 * it into dist. Any violation exits the process non-zero.
 */
async function checkTemplatesLibrary() {
  const errors = [];

  const dataPath = join(ROOT, 'web', 'templates-data.json');
  const pdfDir = join(ROOT, 'web', 'templates-pdf');
  const zipPath = join(ROOT, 'web', 'templates-all.zip');

  // 1. templates-data.json exists and parses.
  let data = null;
  if (!(await exists(dataPath))) {
    errors.push('web/templates-data.json is missing');
  } else {
    try {
      data = JSON.parse(await readFile(dataPath, 'utf8'));
    } catch (e) {
      errors.push(`web/templates-data.json does not parse as JSON: ${e.message}`);
    }
  }

  // Resolve the template list. Support either a bare array or an object with a
  // `templates` array.
  let templates = null;
  if (data !== null) {
    if (Array.isArray(data)) templates = data;
    else if (Array.isArray(data.templates)) templates = data.templates;
    else errors.push('web/templates-data.json has no templates array');
  }

  // 2. Count *.pdf files in web/templates-pdf/.
  let pdfFiles = [];
  if (!(await exists(pdfDir))) {
    errors.push('web/templates-pdf/ is missing');
  } else {
    pdfFiles = (await readdir(pdfDir)).filter(f => f.toLowerCase().endsWith('.pdf'));
  }

  // 3. templates length === number of PDFs (expect 502).
  if (templates !== null && pdfFiles.length > 0) {
    if (templates.length !== pdfFiles.length) {
      errors.push(
        `templates-data.json has ${templates.length} templates but web/templates-pdf/ ` +
        `has ${pdfFiles.length} PDFs — they must match`,
      );
    }
    if (templates.length !== 502) {
      errors.push(`expected 502 templates, found ${templates.length} in templates-data.json`);
    }
    if (pdfFiles.length !== 502) {
      errors.push(`expected 502 PDFs in web/templates-pdf/, found ${pdfFiles.length}`);
    }
  }

  // 4. Every slug in templates-data.json has a matching web/templates-pdf/<slug>.pdf.
  if (templates !== null && (await exists(pdfDir))) {
    const pdfSet = new Set(pdfFiles);
    const missing = [];
    for (const t of templates) {
      const slug = t && typeof t === 'object' ? t.slug : null;
      if (!slug) { missing.push('(template with no slug)'); continue; }
      if (!pdfSet.has(`${slug}.pdf`)) missing.push(slug);
    }
    if (missing.length > 0) {
      const shown = missing.slice(0, 10).join(', ');
      errors.push(
        `${missing.length} template slug(s) have no matching web/templates-pdf/<slug>.pdf: ` +
        `${shown}${missing.length > 10 ? ', …' : ''}`,
      );
    }
  }

  // 5. templates-all.zip exists.
  if (!(await exists(zipPath))) {
    errors.push('web/templates-all.zip is missing');
  }

  if (errors.length > 0) {
    console.error('\n[smoke] FAIL — templates library integrity:');
    for (const e of errors) console.error(`  - ${e}`);
    console.error('');
    process.exit(1);
  }

  console.log(`[smoke] OK — templates library: ${templates.length} templates, ${pdfFiles.length} PDFs, zip present`);
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

  // Templates library integrity (audit-blocker #3): assert the owned library is
  // present and internally consistent before build-web.js copies it into dist.
  await checkTemplatesLibrary();
}

main().catch(err => {
  console.error('[smoke] runner error:', err && err.message ? err.message : err);
  process.exit(2);
});
