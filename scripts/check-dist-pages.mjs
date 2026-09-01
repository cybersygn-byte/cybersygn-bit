/**
 * Every page that exists in source must exist in the build.
 *
 * This bug has now shipped twice, both times the same shape: a page was
 * authored or generated under web/, the build's hand-maintained copy list did
 * not know about it, and the page 404'd in production while every local check
 * passed.
 *   - /erase/       the self-serve deletion page the privacy policy links to.
 *                   Found only because a live curl returned 404.
 *   - /use-cases/   the hub plus 10 document hubs. The copy loop descended
 *                   straight to the leaf level and silently dropped every file
 *                   above it, orphaning all 48 landing pages. Found only
 *                   because Google Search Console reported "Referring page:
 *                   None detected".
 *
 * A hand-maintained copy list will keep drifting from what exists. This turns
 * that drift into a failed build instead of a silent 404.
 */
import { readdir, stat } from 'node:fs/promises';
import { join, relative } from 'node:path';

const SRC = 'web';
const OUT = 'web/dist';

// Directories under web/ that are deliberately NOT shipped as pages.
const SKIP = new Set(['dist', 'vendor', 'brand', 'shared', 'i18n', 'templates-pdf', 'node_modules']);

async function exists(p) { try { await stat(p); return true; } catch { return false; } }

async function findPages(dir, base = '') {
  const out = [];
  let entries;
  try { entries = await readdir(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    if (e.name.startsWith('.')) continue;
    const rel = base ? `${base}/${e.name}` : e.name;
    if (e.isDirectory()) {
      if (!base && SKIP.has(e.name)) continue;
      out.push(...await findPages(join(dir, e.name), rel));
    } else if (e.name === 'index.html') {
      out.push(base);   // '' means the root index
    } else if (e.name.endsWith('.html')) {
      // NON-INDEX PAGES TOO. Discovering only index.html left four real pages
      // invisible to this check: offline.html (the service worker's fallback),
      // 404.html, and the dashboard's join and bulk-send pages. Any of them
      // could stop being copied into the build and nothing would say so, which
      // is the exact failure this file exists to prevent.
      out.push({ file: rel });
    }
  }
  return out;
}

const pages = await findPages(SRC);
const missing = [];
for (const p of pages) {
  if (p && typeof p === 'object' && p.file) {
    if (!await exists(join(OUT, p.file))) missing.push('/' + p.file);
    continue;
  }
  const distPath = p ? join(OUT, p, 'index.html') : join(OUT, 'index.html');
  if (!await exists(distPath)) missing.push('/' + (p ? p + '/' : ''));
}

if (missing.length) {
  console.error(`\ncheck-dist-pages: ${missing.length} page(s) exist in ${SRC}/ but NOT in ${OUT}/`);
  console.error('These would 404 in production while every local check passes.\n');
  for (const m of missing) console.error('  MISSING FROM BUILD  ' + m);
  console.error('\nFix scripts/build-web.js so the build copies them, then re-run.\n');
  process.exit(1);
}

console.log(`check-dist-pages: all ${pages.length} source pages are present in the build.`);
