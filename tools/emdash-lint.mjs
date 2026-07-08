#!/usr/bin/env node
/**
 * Em-dash lint (brand rule enforcement).
 *
 * CyberSygn's own voice rule, inherited from the Vyan spine CONTRACT
 * (section 7.2), is: NO em-dashes (U+2014, ", ") on any customer-facing
 * surface. En-dashes (U+2013) in numeric ranges are allowed; only the em-dash
 * is banned. The launch audit found em-dashes had shipped against this rule,
 * so this lint exists to catch them before they go out again.
 *
 * What it scans:
 *   1. Customer-facing HTML source under web/ (everything a visitor reads).
 *   2. The built static site under web/dist/, HTML plus the shipped JS/CSS/
 *      text assets that render visible copy.
 *
 * What it skips:
 *   - Third-party vendored libraries (web/**\/vendor/, .min.js, .bundle.js):
 *     not our copy, not governed by our brand voice.
 *   - node_modules, .git, fonts.
 *
 * Behavior:
 *   - Prints every offending file with its em-dash count and the first few
 *     line numbers, then a total.
 *   - Exits 0 if zero em-dashes are found, non-zero otherwise, so it can gate
 *     `npm run lint` / `npm run deploy` the way css-check / smoke-check do.
 *
 * Flags:
 *   --count-only   Print only the integer total (useful for audits/CI math).
 *   --dist-only    Scan only web/dist (the shipped artifact).
 *   --quiet        Suppress per-line detail; still prints per-file + total.
 *
 * Zero dependencies. Runs in well under a second on the current tree.
 */

import { readdir, stat, readFile } from 'node:fs/promises';
import { join, dirname, relative, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

const EM_DASH = ', '; //, 

const args = new Set(process.argv.slice(2));
const COUNT_ONLY = args.has('--count-only');
const DIST_ONLY = args.has('--dist-only');
const QUIET = args.has('--quiet') || COUNT_ONLY;

// Roots to scan, relative to ROOT. web/dist is the built artifact; web/ (minus
// dist) is the customer-facing source. --dist-only narrows to just the build.
const SCAN_ROOTS = DIST_ONLY ? ['web/dist'] : ['web'];

// Directories never scanned (third-party / not customer-facing copy).
const SKIP_DIRS = new Set(['vendor', 'node_modules', '.git', 'fonts']);

// File extensions that carry customer-facing copy. dist JS/CSS render visible
// text; .txt covers llms.txt / robots-style files. Binary assets (pdf, woff,
// png, zip, ...) are never read.
const TEXT_EXTS = new Set(['.html', '.htm', '.js', '.mjs', '.css', '.txt', '.json', '.xml', '.svg']);

// Within those, third-party bundles we don't author.
const SKIP_FILES = [/\.min\.js$/, /\.bundle\.js$/, /\.min\.css$/];

async function walk(absDir, out) {
  let entries;
  try {
    entries = await readdir(absDir);
  } catch {
    return; // dir may not exist (e.g. dist before a build), silently skip
  }
  for (const name of entries) {
    if (SKIP_DIRS.has(name)) continue;
    const abs = join(absDir, name);
    let s;
    try { s = await stat(abs); } catch { continue; }
    if (s.isDirectory()) {
      await walk(abs, out);
    } else if (s.isFile()) {
      const ext = extname(name).toLowerCase();
      if (!TEXT_EXTS.has(ext)) continue;
      if (SKIP_FILES.some((re) => re.test(name))) continue;
      out.push(abs);
    }
  }
}

function countEmDashes(text) {
  let n = 0;
  let idx = text.indexOf(EM_DASH);
  while (idx !== -1) {
    n += 1;
    idx = text.indexOf(EM_DASH, idx + 1);
  }
  return n;
}

function firstLineNumbers(text, limit = 5) {
  const lines = text.split('\n');
  const hits = [];
  for (let i = 0; i < lines.length && hits.length < limit; i++) {
    if (lines[i].includes(EM_DASH)) hits.push(i + 1);
  }
  return hits;
}

async function main() {
  const files = [];
  for (const r of SCAN_ROOTS) {
    await walk(join(ROOT, r), files);
  }
  files.sort();

  let total = 0;
  const offenders = [];
  for (const abs of files) {
    let text;
    try { text = await readFile(abs, 'utf8'); } catch { continue; }
    const c = countEmDashes(text);
    if (c > 0) {
      total += c;
      offenders.push({ file: relative(ROOT, abs), count: c, lines: firstLineNumbers(text) });
    }
  }

  if (COUNT_ONLY) {
    process.stdout.write(String(total) + '\n');
    process.exit(total === 0 ? 0 : 1);
  }

  if (offenders.length === 0) {
    console.log(`emdash-lint: clean, 0 em-dashes (U+2014) across ${files.length} customer-facing file(s).`);
    process.exit(0);
  }

  console.error(`emdash-lint: FAIL, ${total} em-dash(es) (U+2014) in ${offenders.length} file(s).`);
  console.error('The brand rule (spine CONTRACT 7.2) bans the em-dash on customer-facing surfaces.');
  console.error('Replace ", " with a comma, a colon, parentheses, two sentences, or an en-dash (numeric ranges only).\n');
  for (const o of offenders) {
    const where = QUIET || o.lines.length === 0 ? '' : `  (lines ${o.lines.join(', ')}${o.count > o.lines.length ? ', …' : ''})`;
    console.error(`  ${o.count.toString().padStart(5)}  ${o.file}${where}`);
  }
  console.error(`\n  total: ${total}`);
  process.exit(1);
}

main().catch((err) => {
  console.error('emdash-lint: crashed:', err && err.stack ? err.stack : err);
  process.exit(2);
});
