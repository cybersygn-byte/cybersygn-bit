/**
 * Every inline script must have its sha256 in web/_headers, and vice versa.
 *
 * CLAUDE.md rule 8: the CSP is hash-based with no 'unsafe-inline', so editing
 * ANY inline script means recomputing its hash, or that page silently stops
 * executing under CSP. "Silently" is the whole problem: the page still renders,
 * the script just never runs, and nothing in the build ever said so. Twenty
 * three hashes were being maintained entirely by hand.
 *
 * A hash mismatch cannot be caught by looking at the page in a browser with the
 * CSP disabled, which is how most local checking happens, so this has to be in
 * the gate.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, relative } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname;
const HEADERS = join(ROOT, 'web/_headers');

function pages(dir) {
  const out = [];
  const walk = (d) => {
    for (const e of readdirSync(d)) {
      const p = join(d, e);
      const rel = relative(ROOT, p);
      if (rel.startsWith('web/dist') || rel.startsWith('web/vendor') || rel.includes('node_modules')) continue;
      if (statSync(p).isDirectory()) walk(p);
      else if (e.endsWith('.html')) out.push(p);
    }
  };
  walk(join(ROOT, 'web'));
  return out.sort();
}

// A src= script is fetched, not inlined, so it needs no hash.
//
// IMPORTMAP IS INCLUDED ON PURPOSE. script-src governs <script type="importmap">
// like any other script element, and web/preview/index.html carries one that
// maps pdfjs to the vendored copy. My first version of this filter treated it
// as inert data, which made its real hash in _headers look like an orphan and
// would have "cleaned up" the one line holding the PDF viewer together.
// application/ld+json and text/template are structured data that browsers do
// not execute or hash.
const INLINE = /<script(?![^>]*\bsrc=)([^>]*)>([\s\S]*?)<\/script>/gi;
const NON_EXEC = /type\s*=\s*["']?(application\/ld\+json|text\/template|application\/json)/i;

const headers = readFileSync(HEADERS, 'utf8');
const declared = new Set(headers.match(/sha256-[A-Za-z0-9+/=]+/g) || []);

const found = new Map();   // hash -> [page...]
const missing = [];
for (const file of pages('web')) {
  const html = readFileSync(file, 'utf8');
  for (const m of html.matchAll(INLINE)) {
    const attrs = m[1] || '';
    if (NON_EXEC.test(attrs)) continue;
    const body = m[2];
    if (!body.trim()) continue;
    const hash = 'sha256-' + createHash('sha256').update(body, 'utf8').digest('base64');
    const rel = relative(ROOT, file);
    if (!found.has(hash)) found.set(hash, []);
    found.get(hash).push(rel);
    if (!declared.has(hash)) missing.push({ file: rel, hash, preview: body.trim().slice(0, 60).replace(/\s+/g, ' ') });
  }
}

const orphans = [...declared].filter(h => !found.has(h));

let bad = false;
if (missing.length) {
  bad = true;
  console.error('check:csp-hashes FAILED: inline scripts with no hash in web/_headers\n');
  for (const m of missing) {
    console.error(`  ${m.file}`);
    console.error(`    ${m.hash}`);
    console.error(`    starts: ${m.preview}`);
    console.error(`    This script will NOT run under CSP. Add the hash above to web/_headers.\n`);
  }
}
if (orphans.length) {
  bad = true;
  console.error(`check:csp-hashes: ${orphans.length} hash(es) in web/_headers match no inline script.\n`);
  for (const h of orphans) console.error(`  ${h}`);
  console.error('\nEither the script was edited (recompute and replace) or deleted (remove the hash).');
}
if (bad) process.exit(1);

console.log(`check:csp-hashes: ${found.size} inline script(s) across ${pages('web').length} pages, all hashed in web/_headers.`);
