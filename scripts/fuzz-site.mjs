#!/usr/bin/env node
/**
 * fuzz-site.mjs
 *
 * Site, asset, and link integrity fuzzer for CyberSygn.
 *
 * Crawls the BUILT output in web/dist exhaustively (not by sampling) and
 * optionally live-checks production.
 *
 * Checks:
 *   1. link graph: every internal href/src resolves against the dist tree
 *   2. sitemap: every URL live-200, no 3xx/4xx  (--live)
 *   3. subresources: img/css/js/font/manifest/icon all exist in dist
 *   4. template PDFs: exist, non-zero, %PDF magic
 *   5. canonical: exactly one, absolute, https, self-consistent
 *   6. sitemap hygiene: no 404s, no missing indexable pages, no future lastmod, valid XML
 *   7. robots.txt validity, does not block indexable URLs
 *   8. titles / meta descriptions: missing, empty, duplicate, over-long
 *   9. mixed content: http:// subresources
 *  10. JSON-LD blocks parse
 *
 * Usage:
 *   node scripts/fuzz-site.mjs                 # offline dist audit only
 *   node scripts/fuzz-site.mjs --live          # + live sitemap + sampled targets
 *   node scripts/fuzz-site.mjs --live --full-live   # live-check every distinct target
 */

import { readdir, readFile, stat, open } from 'node:fs/promises';
import { join, resolve, dirname, relative, extname, posix } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const DIST = join(ROOT, 'web', 'dist');
const ORIGIN = 'https://cybersygn.io';

const ARGV = process.argv.slice(2);
const LIVE = ARGV.includes('--live');
const FULL_LIVE = ARGV.includes('--full-live');
const CONCURRENCY = 3;
const DELAY_MS = 120;

const counts = {};
const bump = (k, n = 1) => { counts[k] = (counts[k] || 0) + n; };
const findings = [];
const report = (severity, check, message, extra) => {
  findings.push({ severity, check, message, ...(extra || {}) });
};

/* ------------------------------------------------------------------ utils */

async function walk(dir, out = []) {
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) await walk(p, out);
    else out.push(p);
  }
  return out;
}

const exists = async (p) => { try { await stat(p); return true; } catch { return false; } };
const isFile = async (p) => { try { return (await stat(p)).isFile(); } catch { return false; } };

function urlPathOf(file) {
  // dist absolute path -> canonical URL path
  const rel = relative(DIST, file).split(/[\\/]/).join('/');
  if (rel === 'index.html') return '/';
  if (rel.endsWith('/index.html')) return '/' + rel.slice(0, -'index.html'.length);
  return '/' + rel;
}

/* --------------------------------------------------------- HTML extraction */

const ATTR_RE = /<([a-zA-Z0-9-]+)\b([^>]*)>/g;
function attrsOf(raw) {
  const out = {};
  const re = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/g;
  let m;
  while ((m = re.exec(raw))) out[m[1].toLowerCase()] = m[2] ?? m[3] ?? m[4] ?? '';
  return out;
}

function extractTags(html) {
  const tags = [];
  let m;
  ATTR_RE.lastIndex = 0;
  while ((m = ATTR_RE.exec(html))) {
    tags.push({ name: m[1].toLowerCase(), attrs: attrsOf(m[2]), index: m.index });
  }
  return tags;
}

function decodeEntities(s) {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&#x27;/gi, "'");
}

/* -------------------------------------------------- reference resolution */

// Paths handled by the Worker, not by the static asset tree.
const WORKER_PATH_RE = [
  /^\/api\//,
  /^\/detect$/,
  /^\/t\//,           // short template links, if any
];

function isWorkerPath(p) {
  return WORKER_PATH_RE.some((re) => re.test(p));
}

/** Return {kind, detail} where kind is ok | missing | worker | external | skip */
async function resolveRef(fromFile, rawRef) {
  let ref = decodeEntities(String(rawRef || '').trim());
  if (!ref) return { kind: 'skip', reason: 'empty' };
  if (/^(mailto:|tel:|sms:|javascript:|data:|blob:|#)/i.test(ref)) return { kind: 'skip', reason: 'scheme' };

  let pathname;
  if (/^https?:\/\//i.test(ref)) {
    let u;
    try { u = new URL(ref); } catch { return { kind: 'badurl' }; }
    if (u.host !== 'cybersygn.io' && u.host !== 'www.cybersygn.io') return { kind: 'external', href: ref, insecure: u.protocol === 'http:' };
    pathname = u.pathname;
  } else if (ref.startsWith('//')) {
    return { kind: 'external', href: ref };
  } else if (ref.startsWith('/')) {
    pathname = ref.split('#')[0].split('?')[0];
  } else {
    // A ref that is only a query and/or fragment ("?pdf=x", "#top") targets the
    // current document. Joining its empty path would wrongly produce the parent
    // directory without a trailing slash.
    const relPath = ref.split('#')[0].split('?')[0];
    if (!relPath) return { kind: 'ok', path: urlPathOf(fromFile), file: fromFile };
    const base = posix.dirname(urlPathOf(fromFile).endsWith('/') ? urlPathOf(fromFile) + 'index.html' : urlPathOf(fromFile));
    pathname = posix.normalize(posix.join(base, relPath));
  }
  if (!pathname) return { kind: 'skip', reason: 'nopath' };
  if (isWorkerPath(pathname)) return { kind: 'worker', path: pathname };

  const candidates = [];
  const clean = pathname.replace(/\/+$/, '/');
  if (clean.endsWith('/')) {
    candidates.push(join(DIST, clean, 'index.html'));
  } else {
    candidates.push(join(DIST, clean));
    if (!extname(clean)) {
      candidates.push(join(DIST, clean + '.html'));
      candidates.push(join(DIST, clean, 'index.html'));
    }
  }
  for (const c of candidates) if (await isFile(c)) return { kind: 'ok', path: pathname, file: c };
  return { kind: 'missing', path: pathname, tried: candidates.map((c) => relative(DIST, c)) };
}

/* ------------------------------------------------------------------- main */

async function main() {
  const started = Date.now();
  const allFiles = await walk(DIST);
  const htmlFiles = allFiles.filter((f) => f.endsWith('.html')).sort();
  const pdfFiles = allFiles.filter((f) => f.toLowerCase().endsWith('.pdf')).sort();

  counts.dist_files = allFiles.length;
  counts.html_pages = htmlFiles.length;
  counts.pdf_files = pdfFiles.length;

  /* ---------- 4. PDF integrity (all of them) ---------- */
  for (const f of pdfFiles) {
    bump('pdf_checked');
    const st = await stat(f);
    if (st.size === 0) {
      report('high', 'pdf', `zero-byte PDF: ${relative(ROOT, f)}`);
      bump('pdf_zero');
      continue;
    }
    const fh = await open(f, 'r');
    const buf = Buffer.alloc(8);
    await fh.read(buf, 0, 8, 0);
    // tail check for %%EOF within last 1024 bytes
    const tailLen = Math.min(1024, st.size);
    const tail = Buffer.alloc(tailLen);
    await fh.read(tail, 0, tailLen, st.size - tailLen);
    await fh.close();
    if (buf.subarray(0, 5).toString('latin1') !== '%PDF-') {
      report('high', 'pdf', `not a PDF (bad magic ${JSON.stringify(buf.subarray(0, 8).toString('latin1'))}): ${relative(ROOT, f)}`);
      bump('pdf_bad_magic');
    }
    if (!tail.toString('latin1').includes('%%EOF')) {
      report('medium', 'pdf', `truncated PDF (no %%EOF in last ${tailLen} bytes, size ${st.size}): ${relative(ROOT, f)}`);
      bump('pdf_truncated');
    }
    if (st.size < 400) {
      report('medium', 'pdf', `suspiciously small PDF (${st.size} bytes): ${relative(ROOT, f)}`);
      bump('pdf_tiny');
    }
  }

  /* ---------- 3a. JS module graph + CSS url() references ---------- */
  {
    // Bare specifiers are only resolvable through an <script type="importmap">.
    // Collect every mapping declared anywhere in dist and treat those as satisfied.
    const importMapKeys = new Set();
    for (const f of htmlFiles) {
      const h = await readFile(f, 'utf8');
      for (const m of h.matchAll(/<script[^>]+type=["']importmap["'][^>]*>([\s\S]*?)<\/script>/gi)) {
        try {
          const map = JSON.parse(m[1]);
          for (const k of Object.keys(map.imports || {})) importMapKeys.add(k);
        } catch (e) {
          report('high', 'importmap', `importmap does not parse in ${relative(DIST, f)}: ${e.message}`);
          bump('importmap_bad');
        }
      }
    }
    counts.importmap_keys = importMapKeys.size;

    // Statement-position imports only, so string literals containing the word
    // "from" are not mistaken for module specifiers.
    const SPEC_RES = [
      /(?:^|[;\}\)]|\n)\s*import\s+(?:[\w${}\s*,]+\s+from\s+)?['"]([^'"]+)['"]/g,
      /(?:^|[;\}\)]|\n)\s*export\s+(?:\*|\{[^}]*\})\s+from\s+['"]([^'"]+)['"]/g,
      /(?:^|[^\w.$])import\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
    ];
    for (const f of allFiles.filter((x) => x.endsWith('.js') || x.endsWith('.mjs'))) {
      if (f.includes('/vendor/')) continue; // third-party bundles, not ours
      const src = await readFile(f, 'utf8');
      const specs = new Set();
      for (const re of SPEC_RES) for (const m of src.matchAll(re)) specs.add(m[1]);
      for (const spec of specs) {
        bump('js_import_checked');
        if (/^https?:/i.test(spec)) { bump('js_import_remote'); continue; }
        if (!/^[.\/]/.test(spec)) {
          if (importMapKeys.has(spec)) { bump('js_import_bare_mapped'); }
          else {
            bump('js_import_bare_unmapped');
            report('low', 'js-import', `bare specifier "${spec}" in ${relative(DIST, f)} has no importmap entry (fine only if the call site is Node-only)`);
          }
          continue;
        }
        const abs = spec.startsWith('/') ? join(DIST, spec) : join(dirname(f), spec);
        if (await isFile(abs)) bump('js_import_ok');
        else { report('blocker', 'js-import', `module import "${spec}" from ${relative(DIST, f)} resolves to a missing file (${relative(DIST, abs)})`); bump('js_import_dead'); }
      }
    }

    for (const f of allFiles.filter((x) => x.endsWith('.css'))) {
      const src = await readFile(f, 'utf8');
      for (const m of src.matchAll(/url\(\s*['"]?([^'")]+)['"]?\s*\)/g)) {
        const v = m[1].trim();
        if (/^(data:|https?:)/i.test(v)) continue;
        bump('css_url_checked');
        const p2 = v.split('#')[0].split('?')[0];
        const abs = p2.startsWith('/') ? join(DIST, p2) : join(dirname(f), p2);
        if (await isFile(abs)) bump('css_url_ok');
        else { report('high', 'css-url', `url("${v}") in ${relative(DIST, f)} resolves to a missing file (${relative(DIST, abs)})`); bump('css_url_dead'); }
      }
    }
  }

  /* ---------- 3b. manifest + service-worker referenced assets ---------- */
  {
    const manifestPath = join(DIST, 'manifest.webmanifest');
    if (await isFile(manifestPath)) {
      let mf = null;
      try { mf = JSON.parse(await readFile(manifestPath, 'utf8')); }
      catch (e) { report('high', 'manifest', `manifest.webmanifest does not parse: ${e.message}`); }
      if (mf) {
        const refs = [];
        for (const i of mf.icons || []) refs.push(['icons[].src', i.src]);
        for (const sc of mf.shortcuts || []) {
          refs.push(['shortcuts[].url', sc.url]);
          for (const i of sc.icons || []) refs.push(['shortcuts[].icons[].src', i.src]);
        }
        for (const k of ['start_url', 'scope']) if (mf[k]) refs.push([k, mf[k]]);
        for (const [where, v] of refs) {
          bump('manifest_refs_checked');
          const res = await resolveRef(join(DIST, 'index.html'), v);
          if (res.kind === 'missing') { report('high', 'manifest', `manifest ${where} points at a missing asset: ${v}`); bump('manifest_dead'); }
          else bump('manifest_ok');
        }
      }
    }
    const swPath = join(DIST, 'sw.js');
    if (await isFile(swPath)) {
      const sw = await readFile(swPath, 'utf8');
      const block = (sw.match(/const\s+PRECACHE\s*=\s*\[([\s\S]*?)\]/) || [])[1] || '';
      const lits = [...block.matchAll(/['"]([^'"]+)['"]/g)].map((m) => m[1]);
      const offline = (sw.match(/const\s+OFFLINE_URL\s*=\s*['"]([^'"]+)['"]/) || [])[1];
      const list = [...new Set([...(offline ? [offline] : []), ...lits.filter((l) => l.startsWith('/'))])];
      for (const v of list) {
        bump('sw_precache_checked');
        const res = await resolveRef(join(DIST, 'index.html'), v);
        if (res.kind === 'missing') { report('high', 'service-worker', `sw.js PRECACHE entry has no file in dist: ${v}`); bump('sw_precache_dead'); }
        else bump('sw_precache_ok');
      }
      counts.sw_precache_list = list.join(' ');
    }
  }

  /* ---------- pages ---------- */
  const pages = [];
  const titleMap = new Map();
  const descMap = new Map();
  const linkTargets = new Map(); // resolved url path -> Set(source pages)

  for (const file of htmlFiles) {
    bump('pages_parsed');
    const html = await readFile(file, 'utf8');
    const url = urlPathOf(file);
    const tags = extractTags(html);
    const page = { file, url, html };
    pages.push(page);

    /* --- 1 + 3. references --- */
    const refs = [];
    for (const t of tags) {
      const a = t.attrs;
      const push = (attr, val, kind) => { if (val) refs.push({ tag: t.name, attr, val, kind }); };
      if (t.name === 'a') push('href', a.href, 'link');
      else if (t.name === 'link') push('href', a.href, `link:${a.rel || '?'}`);
      else if (t.name === 'script') push('src', a.src, 'script');
      else if (t.name === 'img') push('src', a.src, 'img');
      else if (t.name === 'source') { push('src', a.src, 'source'); push('srcset', a.srcset, 'srcset'); }
      else if (t.name === 'iframe') push('src', a.src, 'iframe');
      else if (t.name === 'video' || t.name === 'audio') { push('src', a.src, t.name); push('poster', a.poster, t.name); }
      else if (t.name === 'embed') push('src', a.src, 'embed');
      else if (t.name === 'form') push('action', a.action, 'form');
      else if (t.name === 'meta' && (a.property === 'og:image' || a.name === 'twitter:image')) push('content', a.content, 'og:image');
      else if (t.name === 'use') push('href', a.href || a['xlink:href'], 'svg-use');
    }
    // CSS url(...) inside inline <style> and style="" attributes
    for (const m of html.matchAll(/url\(\s*['"]?([^'")]+)['"]?\s*\)/g)) {
      const v = m[1].trim();
      if (v && !/^data:/i.test(v)) refs.push({ tag: 'css', attr: 'url()', val: v, kind: 'css-url' });
    }

    for (const r of refs) {
      const vals = r.kind === 'srcset'
        ? r.val.split(',').map((s) => s.trim().split(/\s+/)[0]).filter(Boolean)
        : [r.val];
      for (const v of vals) {
        if (v.startsWith('#')) continue;
        bump('refs_checked');
        bump('kind_' + r.kind.replace(/[^a-z0-9]+/gi, '_'));
        /* --- query-string asset references, e.g. /preview/?pdf=/templates-pdf/x.pdf --- */
        const qm = v.match(/[?&](pdf|file|src|doc)=([^&#"']+)/i);
        if (qm && qm[2].startsWith('/')) {
          bump('qs_asset_refs');
          const qres = await resolveRef(file, decodeEntities(qm[2]));
          if (qres.kind === 'missing') {
            report('high', 'dead-ref', `query-string asset missing: ${qres.path} referenced from ${url} (${v})`);
            bump('qs_asset_dead');
          } else bump('qs_asset_ok');
        }
        /* --- 9. mixed content --- */
        if (/^http:\/\//i.test(v)) {
          const sub = r.kind !== 'link';
          report(sub ? 'high' : 'low', 'mixed-content',
            `${sub ? 'insecure subresource' : 'insecure link'} ${v} on ${url} (<${r.tag} ${r.attr}>)`);
          bump('mixed_content');
        }
        const res = await resolveRef(file, v);
        if (res.kind === 'ok') {
          bump('refs_internal_ok');
          if (!linkTargets.has(res.path)) linkTargets.set(res.path, new Set());
          linkTargets.get(res.path).add(url);
        } else if (res.kind === 'missing') {
          bump('refs_dead');
          const sub = r.kind !== 'link';
          report(sub ? 'high' : 'medium', 'dead-ref',
            `${sub ? 'MISSING SUBRESOURCE' : 'dead link'} ${res.path} referenced from ${url} (<${r.tag} ${r.attr}="${v}">)`);
          if (!linkTargets.has(res.path)) linkTargets.set(res.path, new Set());
          linkTargets.get(res.path).add(url);
        } else if (res.kind === 'worker') {
          bump('refs_worker');
          if (!linkTargets.has(res.path)) linkTargets.set(res.path, new Set());
          linkTargets.get(res.path).add(url);
        } else if (res.kind === 'external') {
          bump('refs_external');
        } else if (res.kind === 'badurl') {
          bump('refs_badurl');
          report('low', 'dead-ref', `unparseable URL "${v}" on ${url}`);
        } else bump('refs_skipped');
      }
    }

    /* --- 5. canonical --- */
    const canons = tags.filter((t) => t.name === 'link' && (t.attrs.rel || '').toLowerCase() === 'canonical');
    page.canonicals = canons.map((c) => c.attrs.href || '');
    bump('canonical_pages_checked');
    const metaNoindex = /<meta[^>]+name=["']robots["'][^>]*content=["'][^"']*noindex/i.test(html);
    page.metaNoindex = metaNoindex;
    const indexable = !metaNoindex
      && !/^\/(dashboard|control|preview|embed|draft)\//.test(url)
      && url !== '/404.html' && url !== '/offline.html';
    if (canons.length === 0) {
      if (indexable) { report('medium', 'canonical', `no canonical tag on ${url}`); bump('canonical_missing'); }
    } else if (canons.length > 1) {
      report('medium', 'canonical', `${canons.length} canonical tags on ${url}: ${JSON.stringify(page.canonicals)}`);
      bump('canonical_duplicate');
    } else {
      const href = decodeEntities(page.canonicals[0]).trim();
      if (!/^https:\/\//i.test(href)) {
        report('medium', 'canonical', `canonical is not an absolute https URL on ${url}: "${href}"`);
        bump('canonical_not_absolute');
      } else {
        let cu; try { cu = new URL(href); } catch { cu = null; }
        if (!cu) { report('medium', 'canonical', `unparseable canonical on ${url}: "${href}"`); bump('canonical_bad'); }
        else {
          if (cu.host !== 'cybersygn.io') {
            report('high', 'canonical', `canonical points off-host on ${url}: ${href}`);
            bump('canonical_offhost');
          } else if (cu.pathname !== url) {
            report('high', 'canonical', `canonical mismatch: page ${url} canonicalizes to ${cu.pathname}`);
            bump('canonical_mismatch');
          } else bump('canonical_ok');
        }
      }
    }

    /* --- 8. title / description --- */
    const tm = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
    const title = tm ? decodeEntities(tm[1]).trim() : null;
    page.title = title;
    bump('title_checked');
    if (title === null) { report('medium', 'title', `no <title> on ${url}`); bump('title_missing'); }
    else if (!title) { report('medium', 'title', `empty <title> on ${url}`); bump('title_empty'); }
    else {
      if (title.length > 65) { report('low', 'title', `title ${title.length} chars (>65) on ${url}: "${title}"`); bump('title_long'); }
      if (indexable) {
        if (!titleMap.has(title)) titleMap.set(title, []);
        titleMap.get(title).push(url);
      }
    }

    const dm = tags.find((t) => t.name === 'meta' && (t.attrs.name || '').toLowerCase() === 'description');
    const desc = dm ? decodeEntities(dm.attrs.content || '').trim() : null;
    page.desc = desc;
    bump('desc_checked');
    const descTags = tags.filter((t) => t.name === 'meta' && (t.attrs.name || '').toLowerCase() === 'description');
    if (descTags.length > 1) { report('low', 'meta-description', `${descTags.length} meta descriptions on ${url}`); bump('desc_duplicate_tag'); }
    if (desc === null) { if (indexable) { report('medium', 'meta-description', `no meta description on ${url}`); bump('desc_missing'); } }
    else if (!desc) { report('medium', 'meta-description', `empty meta description on ${url}`); bump('desc_empty'); }
    else {
      if (desc.length > 160) { report('low', 'meta-description', `meta description ${desc.length} chars (>160) on ${url}`); bump('desc_long'); }
      if (indexable) {
        if (!descMap.has(desc)) descMap.set(desc, []);
        descMap.get(desc).push(url);
      }
    }

    /* --- 9b. Open Graph absoluteness + html lang --- */
    for (const prop of ['og:image', 'og:url']) {
      const t = tags.find((x) => x.name === 'meta' && (x.attrs.property || '').toLowerCase() === prop);
      const hasOgTitle = tags.some((x) => x.name === 'meta' && (x.attrs.property || '').toLowerCase() === 'og:title');
      if (!t) {
        if (hasOgTitle) { report('medium', 'opengraph', `page has og:title but no ${prop}: ${url}`); bump('og_missing'); }
        continue;
      }
      bump('og_checked');
      const v = decodeEntities(t.attrs.content || '').trim();
      if (!/^https:\/\//i.test(v)) {
        report('medium', 'opengraph', `${prop} is not an absolute https URL on ${url}: "${v}"`);
        bump('og_relative');
      } else bump('og_ok');
    }
    bump('lang_checked');
    const htmlTag = tags.find((t) => t.name === 'html');
    if (!htmlTag || !htmlTag.attrs.lang) { report('low', 'lang', `<html> has no lang attribute on ${url}`); bump('lang_missing'); }

    /* --- 10. JSON-LD --- */
    for (const m of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)) {
      const a = attrsOf(m[1]);
      if ((a.type || '').toLowerCase() !== 'application/ld+json') continue;
      bump('jsonld_blocks');
      const body = m[2];
      try {
        const parsed = JSON.parse(body);
        if (parsed === null || typeof parsed !== 'object') {
          report('low', 'jsonld', `JSON-LD on ${url} is not an object/array`);
          bump('jsonld_notobject');
        }
      } catch (err) {
        report('medium', 'jsonld', `JSON-LD parse error on ${url}: ${err.message} :: ${body.trim().slice(0, 160)}`);
        bump('jsonld_bad');
      }
    }
  }

  /* --- 8b. duplicate titles / descriptions --- */
  for (const [t, urls] of titleMap) {
    if (urls.length > 1) {
      report('low', 'title', `duplicate title across ${urls.length} pages: "${t}" -> ${urls.slice(0, 6).join(', ')}${urls.length > 6 ? ' ...' : ''}`);
      bump('title_duplicate_groups');
    }
  }
  for (const [d, urls] of descMap) {
    if (urls.length > 1) {
      report('low', 'meta-description', `duplicate meta description across ${urls.length} pages: "${d.slice(0, 80)}..." -> ${urls.slice(0, 6).join(', ')}${urls.length > 6 ? ' ...' : ''}`);
      bump('desc_duplicate_groups');
    }
  }

  /* ---------- 6. sitemap ---------- */
  const sitemapRaw = await readFile(join(DIST, 'sitemap.xml'), 'utf8');
  const sitemapUrls = [];
  const urlBlocks = [...sitemapRaw.matchAll(/<url>([\s\S]*?)<\/url>/g)];
  for (const b of urlBlocks) {
    const loc = (b[1].match(/<loc>([\s\S]*?)<\/loc>/) || [])[1];
    const lastmod = (b[1].match(/<lastmod>([\s\S]*?)<\/lastmod>/) || [])[1];
    if (loc) sitemapUrls.push({ loc: decodeEntities(loc.trim()), lastmod: lastmod && lastmod.trim() });
  }
  counts.sitemap_urls = sitemapUrls.length;

  // XML wellformedness: crude but catches unescaped & and stray < in text
  const xmlIssues = [];
  const bareAmp = [...sitemapRaw.matchAll(/&(?!(amp|lt|gt|quot|apos|#\d+|#x[0-9a-fA-F]+);)/g)];
  if (bareAmp.length) xmlIssues.push(`${bareAmp.length} unescaped & characters`);
  if (!/^\s*<\?xml/.test(sitemapRaw)) xmlIssues.push('missing XML declaration');
  if (!/<urlset\b[^>]*xmlns=/.test(sitemapRaw)) xmlIssues.push('urlset missing xmlns');
  const opens = (sitemapRaw.match(/<url>/g) || []).length, closes = (sitemapRaw.match(/<\/url>/g) || []).length;
  if (opens !== closes) xmlIssues.push(`<url> ${opens} vs </url> ${closes}`);
  if (xmlIssues.length) { report('medium', 'sitemap-xml', `sitemap.xml issues: ${xmlIssues.join('; ')}`); bump('sitemap_xml_issues', xmlIssues.length); }

  const seenLoc = new Set();
  const now = Date.now();
  const sitemapPaths = new Set();
  for (const { loc, lastmod } of sitemapUrls) {
    bump('sitemap_checked');
    let u; try { u = new URL(loc); } catch { report('medium', 'sitemap', `unparseable <loc>: ${loc}`); bump('sitemap_badloc'); continue; }
    if (u.protocol !== 'https:') { report('medium', 'sitemap', `non-https <loc>: ${loc}`); bump('sitemap_http'); }
    if (u.host !== 'cybersygn.io') { report('medium', 'sitemap', `off-host <loc>: ${loc}`); bump('sitemap_offhost'); }
    if (seenLoc.has(loc)) { report('low', 'sitemap', `duplicate <loc>: ${loc}`); bump('sitemap_dupe'); }
    seenLoc.add(loc);
    sitemapPaths.add(u.pathname);
    // resolve against dist
    const res = await resolveRef(join(DIST, 'index.html'), loc);
    if (res.kind !== 'ok') { report('high', 'sitemap', `sitemap URL has no file in dist: ${loc} (${res.kind})`); bump('sitemap_nofile'); }
    if (lastmod) {
      const t = Date.parse(lastmod);
      if (Number.isNaN(t)) { report('low', 'sitemap', `unparseable <lastmod> "${lastmod}" for ${loc}`); bump('sitemap_badlastmod'); }
      else if (t > now + 86400000) { report('medium', 'sitemap', `future <lastmod> ${lastmod} for ${loc}`); bump('sitemap_future'); }
    }
  }

  /* --- 7. robots.txt --- */
  const robotsRaw = await readFile(join(DIST, 'robots.txt'), 'utf8');
  const groups = [];
  let cur = null;
  let lastWasUA = false;
  for (const line0 of robotsRaw.split(/\r?\n/)) {
    const line = line0.replace(/#.*$/, '').trim();
    if (!line) { lastWasUA = false; continue; }
    const m = line.match(/^([A-Za-z-]+)\s*:\s*(.*)$/);
    if (!m) { report('low', 'robots', `unparseable robots.txt line: ${JSON.stringify(line0)}`); bump('robots_badline'); continue; }
    const field = m[1].toLowerCase(), value = m[2].trim();
    if (field === 'user-agent') {
      if (!cur || !lastWasUA) { cur = { agents: [], allow: [], disallow: [], other: [] }; groups.push(cur); }
      cur.agents.push(value.toLowerCase());
      lastWasUA = true;
      continue;
    }
    lastWasUA = false;
    if (!cur) { if (field !== 'sitemap') { report('low', 'robots', `directive before any User-agent: ${line}`); bump('robots_orphan'); } cur = null; }
    if (field === 'allow' && cur) cur.allow.push(value);
    else if (field === 'disallow' && cur) cur.disallow.push(value);
    else if (field === 'sitemap') {
      bump('robots_sitemap_decl');
      try { const su = new URL(value); if (su.host !== 'cybersygn.io' || su.protocol !== 'https:') { report('medium', 'robots', `Sitemap directive points elsewhere: ${value}`); bump('robots_sitemap_bad'); } }
      catch { report('medium', 'robots', `unparseable Sitemap directive: ${value}`); bump('robots_sitemap_bad'); }
    } else if (cur) cur.other.push([field, value]);
  }
  counts.robots_groups = groups.length;
  const star = groups.find((g) => g.agents.includes('*'));
  if (!star) { report('medium', 'robots', 'no User-agent: * group in robots.txt'); }
  const robotsMatch = (rule, path) => {
    if (rule === '') return false;
    // treat * as wildcard and $ as anchor per the de-facto spec
    const hasWild = rule.includes('*') || rule.endsWith('$');
    if (!hasWild) return path.startsWith(rule);
    let pat = rule.endsWith('$') ? rule.slice(0, -1) : rule;
    const re = new RegExp('^' + pat.split('*').map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*') + (rule.endsWith('$') ? '$' : ''));
    return re.test(path);
  };
  const blocksIndexable = (group) => {
    const hits = [];
    for (const p of sitemapPaths) {
      const dis = group.disallow.filter((r) => robotsMatch(r, p)).sort((a, b) => b.length - a.length)[0];
      if (!dis) continue;
      const allow = group.allow.filter((r) => robotsMatch(r, p)).sort((a, b) => b.length - a.length)[0];
      if (!allow || allow.length < dis.length) hits.push({ p, dis });
    }
    return hits;
  };
  for (const g of groups) {
    bump('robots_groups_checked');
    const hits = blocksIndexable(g);
    for (const h of hits.slice(0, 5)) {
      report('high', 'robots', `robots.txt group [${g.agents.join(', ')}] blocks sitemap URL ${h.p} via "Disallow: ${h.dis}"`);
      bump('robots_blocks_indexable');
    }
    if (hits.length > 5) report('high', 'robots', `...and ${hits.length - 5} more sitemap URLs blocked for [${g.agents.join(', ')}]`);
  }

  /* --- 6b. indexable dist pages missing from sitemap --- */
  const NOINDEX_URL_RE = /^\/(dashboard|control|preview|embed|draft)\//;
  for (const p of pages) {
    if (p.url === '/404.html' || p.url === '/offline.html') continue;
    if (NOINDEX_URL_RE.test(p.url)) continue;
    if (p.metaNoindex) { bump('pages_noindex_meta'); continue; }
    bump('pages_indexable');
    if (!sitemapPaths.has(p.url)) {
      report('medium', 'sitemap', `indexable page not in sitemap: ${p.url}`);
      bump('sitemap_page_missing');
    }
  }

  /* ---------- LIVE ---------- */
  const live = { sitemap: [], targets: [] };
  if (LIVE) {
    const head = async (u) => {
      const t0 = Date.now();
      try {
        const r = await fetch(u, { redirect: 'manual', headers: { 'user-agent': 'cybersygn-selfaudit/1.0' } });
        return { url: u, status: r.status, location: r.headers.get('location'), ct: r.headers.get('content-type'), ms: Date.now() - t0 };
      } catch (e) { return { url: u, status: 0, error: String(e && e.message || e), ms: Date.now() - t0 }; }
    };
    const runPool = async (urls, sink) => {
      let i = 0;
      const worker = async () => {
        while (i < urls.length) {
          const u = urls[i++];
          sink.push(await head(u));
          await new Promise((r) => setTimeout(r, DELAY_MS));
        }
      };
      await Promise.all(Array.from({ length: CONCURRENCY }, worker));
    };

    process.stderr.write(`live-checking ${sitemapUrls.length} sitemap URLs...\n`);
    await runPool(sitemapUrls.map((s) => s.loc), live.sitemap);
    for (const r of live.sitemap) {
      bump('live_sitemap_checked');
      if (r.status === 200) { bump('live_sitemap_200'); continue; }
      if (r.status >= 300 && r.status < 400) { report('high', 'live-sitemap', `sitemap URL redirects ${r.status} -> ${r.location}: ${r.url}`); bump('live_sitemap_3xx'); }
      else if (r.status >= 400) { report('blocker', 'live-sitemap', `sitemap URL returns ${r.status}: ${r.url}`); bump('live_sitemap_4xx'); }
      else { report('medium', 'live-sitemap', `sitemap URL fetch failed (${r.error}): ${r.url}`); bump('live_sitemap_err'); }
    }

    /* --- live spot-check of template PDFs: served, application/pdf, %PDF magic --- */
    const pdfSampleN = Number(process.env.FUZZ_PDF_SAMPLE || 0);
    if (pdfSampleN > 0) {
      const slugs = pdfFiles.map((f) => relative(DIST, f).split('/').pop());
      const step = Math.max(1, Math.floor(slugs.length / pdfSampleN));
      const picked = [];
      for (let i = 0; i < slugs.length && picked.length < pdfSampleN; i += step) picked.push(slugs[i]);
      process.stderr.write(`live-checking ${picked.length} template PDFs...\n`);
      for (const name of picked) {
        const u = `${ORIGIN}/templates-pdf/${name}`;
        bump('live_pdf_checked');
        try {
          const r = await fetch(u, { headers: { 'user-agent': 'cybersygn-selfaudit/1.0', range: 'bytes=0-1023' } });
          const buf = Buffer.from(await r.arrayBuffer());
          const localSize = (await stat(join(DIST, 'templates-pdf', name))).size;
          if (r.status !== 200 && r.status !== 206) {
            report('high', 'live-pdf', `template PDF returns ${r.status}: ${u}`); bump('live_pdf_bad_status');
          } else if (buf.subarray(0, 5).toString('latin1') !== '%PDF-') {
            report('high', 'live-pdf', `template PDF does not start with %PDF live: ${u} (first bytes ${JSON.stringify(buf.subarray(0, 12).toString('latin1'))})`);
            bump('live_pdf_bad_magic');
          } else {
            const ct = (r.headers.get('content-type') || '').toLowerCase();
            if (!ct.includes('pdf')) { report('medium', 'live-pdf', `template PDF served as ${ct}: ${u}`); bump('live_pdf_bad_ct'); }
            else bump('live_pdf_ok');
            const cl = Number(r.headers.get('content-range') ? String(r.headers.get('content-range')).split('/')[1] : r.headers.get('content-length'));
            if (Number.isFinite(cl) && cl > 0 && cl !== localSize) {
              report('medium', 'live-pdf', `live PDF size ${cl} != dist size ${localSize}: ${u}`); bump('live_pdf_size_mismatch');
            }
          }
        } catch (e) { report('medium', 'live-pdf', `template PDF fetch failed (${e.message}): ${u}`); bump('live_pdf_err'); }
        await new Promise((r) => setTimeout(r, DELAY_MS));
      }
    }

    /* --- live vs dist parity: every JS/CSS asset + a page sample --- */
    {
      const assets = allFiles
        .filter((f) => /\.(js|css|webmanifest)$/.test(f))
        .map((f) => urlPathOf(f));
      const pageSample = [];
      const step = Math.max(1, Math.floor(htmlFiles.length / Number(process.env.FUZZ_PAGE_PARITY || 20)));
      for (let i = 0; i < htmlFiles.length; i += step) pageSample.push(urlPathOf(htmlFiles[i]));
      const parityList = [...new Set([...assets, ...pageSample])];
      process.stderr.write(`parity-checking ${parityList.length} live files against dist...\n`);
      for (const path of parityList) {
        bump('parity_checked');
        const localFile = path.endsWith('/') ? join(DIST, path, 'index.html') : join(DIST, path);
        let localBody; try { localBody = await readFile(localFile, 'utf8'); } catch { bump('parity_nolocal'); continue; }
        try {
          const r = await fetch(ORIGIN + path, { headers: { 'user-agent': 'cybersygn-selfaudit/1.0' } });
          const body = await r.text();
          if (r.status !== 200) { report('high', 'parity', `${path} returns ${r.status} live but exists in dist`); bump('parity_status'); }
          else if (body !== localBody) {
            report('medium', 'parity', `live ${path} differs from dist (live ${body.length} bytes vs dist ${localBody.length}) - deployed build is not this dist`);
            bump('parity_drift');
          } else bump('parity_ok');
        } catch (e) { report('medium', 'parity', `${path} fetch failed: ${e.message}`); bump('parity_err'); }
        await new Promise((r) => setTimeout(r, DELAY_MS));
      }
    }

    /* --- live vs dist parity for the machine-readable files --- */
    for (const f of ['/sitemap.xml', '/robots.txt', '/manifest.webmanifest', '/templates-data.json', '/llms.txt']) {
      bump('live_meta_checked');
      try {
        const r = await fetch(ORIGIN + f, { headers: { 'user-agent': 'cybersygn-selfaudit/1.0' } });
        const body = await r.text();
        if (r.status !== 200) { report('high', 'live-meta', `${f} returns ${r.status}`); bump('live_meta_bad'); continue; }
        let localBody = null;
        try { localBody = await readFile(join(DIST, f.slice(1)), 'utf8'); } catch {}
        if (localBody !== null && localBody !== body) {
          report('medium', 'live-meta', `${f} live body differs from dist (live ${body.length} bytes vs dist ${localBody.length} bytes) - dist may be stale or the Worker rewrites it`);
          bump('live_meta_drift');
        } else bump('live_meta_ok');
      } catch (e) { report('medium', 'live-meta', `${f} fetch failed: ${e.message}`); bump('live_meta_err'); }
      await new Promise((r) => setTimeout(r, DELAY_MS));
    }

    // distinct internal link targets, deduped
    const allTargets = [...linkTargets.keys()].filter((p) => !p.startsWith('/api/')).sort();
    let sample = allTargets;
    if (!FULL_LIVE) {
      // one representative per top-level section, plus every non-sitemap target,
      // plus every dead-ref target
      const bySection = new Map();
      const must = new Set();
      for (const p of allTargets) {
        if (!sitemapPaths.has(p)) must.add(p);
        const sec = '/' + (p.split('/')[1] || '');
        if (!bySection.has(sec)) bySection.set(sec, p);
      }
      sample = [...new Set([...must, ...bySection.values()])].sort();
    }
    process.stderr.write(`live-checking ${sample.length} distinct link targets...\n`);
    await runPool(sample.map((p) => ORIGIN + p), live.targets);
    for (const r of live.targets) {
      bump('live_target_checked');
      const path = new URL(r.url).pathname;
      const sources = [...(linkTargets.get(path) || [])].slice(0, 4);
      if (r.status === 200) { bump('live_target_200'); continue; }
      if (r.status >= 300 && r.status < 400) { report('medium', 'live-link', `link target redirects ${r.status} -> ${r.location}: ${r.url} (linked from ${sources.join(', ')})`); bump('live_target_3xx'); }
      else if (r.status >= 400) { report('high', 'live-link', `link target returns ${r.status}: ${r.url} (linked from ${sources.join(', ')})`); bump('live_target_4xx'); }
      else { report('medium', 'live-link', `link target fetch failed (${r.error}): ${r.url}`); bump('live_target_err'); }
    }
  }

  /* ---------- output ---------- */
  const order = { blocker: 0, high: 1, medium: 2, low: 3 };
  findings.sort((a, b) => order[a.severity] - order[b.severity] || a.check.localeCompare(b.check) || a.message.localeCompare(b.message));

  console.log('='.repeat(78));
  console.log('CyberSygn site fuzz report');
  console.log('='.repeat(78));
  console.log('\nCOUNTS');
  for (const k of Object.keys(counts).sort()) console.log(`  ${k.padEnd(32)} ${counts[k]}`);

  console.log(`\nFINDINGS (${findings.length})`);
  const bySeverity = {};
  for (const f of findings) (bySeverity[f.severity] ||= []).push(f);
  for (const sev of ['blocker', 'high', 'medium', 'low']) {
    const list = bySeverity[sev] || [];
    if (!list.length) continue;
    console.log(`\n--- ${sev.toUpperCase()} (${list.length}) ---`);
    for (const f of list) console.log(`  [${f.check}] ${f.message}`);
  }
  console.log(`\ndone in ${((Date.now() - started) / 1000).toFixed(1)}s`);

  const jsonOut = process.env.FUZZ_JSON;
  if (jsonOut) {
    const { writeFile } = await import('node:fs/promises');
    await writeFile(jsonOut, JSON.stringify({ counts, findings, live }, null, 2));
    console.log(`wrote ${jsonOut}`);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
