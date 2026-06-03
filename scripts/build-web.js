#!/usr/bin/env node
/**
 * CyberSygn build script.
 *
 * Produces a self-contained static bundle in web/dist/ deployable to any
 * static host (Cloudflare Pages, Netlify, Vercel, GitHub Pages, S3,
 * nginx, anything that serves files over HTTP).
 *
 * Layout under web/dist/ after a successful build:
 *
 *   index.html               marketing landing
 *   marketing.js
 *   styles.css
 *   preview/
 *     index.html             field-preview app
 *     app.js                 (rewritten to import ./detect.js)
 *     detect.js              (copied from worker/src/detect.js)
 *   vendor/
 *     pdf.mjs
 *     pdf.worker.mjs
 *     fonts.css
 *     fonts/
 *       *.woff2
 *
 * Detection logic is single-source: dev imports it directly from
 * worker/src/, production reads the same file copied alongside the
 * preview bundle. The build never edits detect.js itself.
 *
 * Vendor assets (pdf.js and font woff2 files) are populated by
 * scripts/vendor.js. We run vendor here too, so a fresh checkout can
 * go from `npm install` to `npm run build` to a deployable bundle in
 * one command.
 */

import { readFile, writeFile, mkdir, rm, copyFile, readdir, stat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const SRC = join(ROOT, 'web');
const SHARED_DETECT = join(ROOT, 'worker', 'src', 'detect.js');
const OUT = join(SRC, 'dist');
const VENDOR = join(SRC, 'vendor');

const PREVIEW_IMPORT_IN_DEV = "from '../../worker/src/detect.js'";
const PREVIEW_IMPORT_IN_DIST = "from './detect.js'";

async function main() {
  console.log('CyberSygn build');
  console.log('  source     :', SRC);
  console.log('  shared     :', SHARED_DETECT);
  console.log('  output     :', OUT);
  console.log('');

  // 1. Ensure vendor assets exist before we copy them.
  if (!(await exists(VENDOR))) {
    console.log('Vendor directory missing. Running vendor step first.');
    runVendor();
    console.log('');
  }

  await rm(OUT, { recursive: true, force: true });
  await mkdir(OUT, { recursive: true });
  await mkdir(join(OUT, 'preview'), { recursive: true });
  await mkdir(join(OUT, 'vendor', 'fonts'), { recursive: true });

  // 2. Marketing root files copy through unchanged.
  await copyFile(join(SRC, 'index.html'), join(OUT, 'index.html'));
  console.log('  wrote dist/index.html');
  await copyFile(join(SRC, 'marketing.js'), join(OUT, 'marketing.js'));
  console.log('  wrote dist/marketing.js');
  await copyFile(join(SRC, 'checkout.js'), join(OUT, 'checkout.js'));
  console.log('  wrote dist/checkout.js');

  // First-party telemetry. Loaded synchronously from every HTML page so it
  // installs window.cybersygn.track/report before page scripts read them.
  await copyFile(join(SRC, 'telemetry.js'), join(OUT, 'telemetry.js'));
  console.log('  wrote dist/telemetry.js');
  await copyFile(join(SRC, 'polish.js'), join(OUT, 'polish.js'));
  console.log('  wrote dist/polish.js');
  await copyFile(join(SRC, 'cinematic-hero.js'), join(OUT, 'cinematic-hero.js'));
  console.log('  wrote dist/cinematic-hero.js');
  await copyFile(join(SRC, 'styles.css'), join(OUT, 'styles.css'));
  console.log('  wrote dist/styles.css');
  // 404.html surfaces when not_found_handling: '404-page' fires in Workers.
  const fourOhFour = join(SRC, '404.html');
  if (await exists(fourOhFour)) {
    await copyFile(fourOhFour, join(OUT, '404.html'));
    console.log('  wrote dist/404.html');
  }

  // 2a. .assetsignore tells Workers Static Assets which files to skip when
  // uploading. Without it, .DS_Store and similar noise files would be served.
  const ignoreSrc = join(SRC, '.assetsignore');
  if (await exists(ignoreSrc)) {
    await copyFile(ignoreSrc, join(OUT, '.assetsignore'));
    console.log('  wrote dist/.assetsignore');
  }

  // 2b. SEO and AI-crawler files. robots.txt advertises the sitemap and
  // explicitly welcomes AI assistant crawlers. llms.txt and llms-full.txt
  // follow the emerging convention for AI-grounding crawlers.
  for (const f of ['robots.txt', 'sitemap.xml', 'llms.txt', 'llms-full.txt']) {
    const p = join(SRC, f);
    if (await exists(p)) {
      await copyFile(p, join(OUT, f));
      console.log(`  wrote dist/${f}`);
    }
  }

  // 2c. Alternatives subtree: programmatic landing pages targeting
  // "DocuSign alternative for [profession]" queries. Each is a static
  // HTML file with its own breadcrumb + Article + FAQPage schema.
  const altSrc = join(SRC, 'alternatives');
  const altOut = join(OUT, 'alternatives');
  if (await exists(altSrc)) {
    await mkdir(altOut, { recursive: true });
    await copyFile(join(altSrc, 'index.html'), join(altOut, 'index.html'));
    console.log('  wrote dist/alternatives/index.html');
    for (const entry of await readdir(altSrc, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const sub = join(altSrc, entry.name);
      const dst = join(altOut, entry.name);
      await mkdir(dst, { recursive: true });
      for (const f of await readdir(sub)) {
        await copyFile(join(sub, f), join(dst, f));
      }
      console.log(`  wrote dist/alternatives/${entry.name}/`);
    }
  }

  // 2d. Legal pages. Privacy, Terms, Refund. Each in its own subdirectory
  // with a clean trailing-slash URL.
  for (const name of ['privacy', 'terms', 'refund']) {
    const src = join(SRC, name);
    const dst = join(OUT, name);
    if (await exists(join(src, 'index.html'))) {
      await mkdir(dst, { recursive: true });
      await copyFile(join(src, 'index.html'), join(dst, 'index.html'));
      console.log(`  wrote dist/${name}/index.html`);
    }
  }

  // 3. Preview subfolder: index.html unchanged (it already uses ../ paths
  //    that match the dist structure), app.js gets its detect.js import
  //    rewritten so the bundle is self-contained.
  const previewHtml = await readFile(join(SRC, 'preview', 'index.html'), 'utf8');
  await writeFile(join(OUT, 'preview', 'index.html'), previewHtml);
  console.log('  wrote dist/preview/index.html');

  const appSrc = await readFile(join(SRC, 'preview', 'app.js'), 'utf8');
  if (!appSrc.includes(PREVIEW_IMPORT_IN_DEV)) {
    throw new Error(
      `Expected to find ${PREVIEW_IMPORT_IN_DEV} in preview/app.js so the build could ` +
      `rewrite it. Update scripts/build-web.js if the import path has changed.`,
    );
  }
  const appDist = appSrc.replace(PREVIEW_IMPORT_IN_DEV, PREVIEW_IMPORT_IN_DIST);
  await writeFile(join(OUT, 'preview', 'app.js'), appDist);
  console.log('  wrote dist/preview/app.js (import path rewritten for production)');

  await copyFile(SHARED_DETECT, join(OUT, 'preview', 'detect.js'));
  console.log('  wrote dist/preview/detect.js (from worker/src/detect.js)');

  // signing.js: signature pad, modals, and pdf-lib flatten. Pure browser
  // module, no rewrites needed.
  await copyFile(join(SRC, 'preview', 'signing.js'), join(OUT, 'preview', 'signing.js'));
  console.log('  wrote dist/preview/signing.js');

  // signers.js: multi-signer assignment and signing-as perspective.
  await copyFile(join(SRC, 'preview', 'signers.js'), join(OUT, 'preview', 'signers.js'));
  console.log('  wrote dist/preview/signers.js');

  // api.js: client wrapper over the Worker endpoints.
  await copyFile(join(SRC, 'preview', 'api.js'), join(OUT, 'preview', 'api.js'));
  console.log('  wrote dist/preview/api.js');

  // identity.js: localStorage-backed sender identity, shared with the dashboard.
  await copyFile(join(SRC, 'preview', 'identity.js'), join(OUT, 'preview', 'identity.js'));
  console.log('  wrote dist/preview/identity.js');

  // owner.js: client-side owner mode. Loaded by marketing, preview, and
  // dashboard pages to validate any saved owner token and surface the
  // owner pill.
  await copyFile(join(SRC, 'preview', 'owner.js'), join(OUT, 'preview', 'owner.js'));
  console.log('  wrote dist/preview/owner.js');

  // docx-to-pdf.js: lazy-loaded .docx ingestion. Only fetched when the
  // user uploads a Word document, so PDF-only sessions pay zero bytes.
  await copyFile(join(SRC, 'preview', 'docx-to-pdf.js'), join(OUT, 'preview', 'docx-to-pdf.js'));
  console.log('  wrote dist/preview/docx-to-pdf.js');

  // cv-detect.js: Phase 2a classical computer-vision pass on rendered
  // canvas. Finds unlabeled signature lines, underscore runs, and
  // checkbox outlines the text-heuristic detector misses.
  await copyFile(join(SRC, 'preview', 'cv-detect.js'), join(OUT, 'preview', 'cv-detect.js'));
  console.log('  wrote dist/preview/cv-detect.js');

  // Dashboard subfolder: imports from ../preview/, so the relative
  // paths work both in dev (web/dashboard/ -> web/preview/) and in
  // dist (dist/dashboard/ -> dist/preview/).
  await mkdir(join(OUT, 'dashboard'), { recursive: true });
  await copyFile(join(SRC, 'dashboard', 'index.html'), join(OUT, 'dashboard', 'index.html'));
  console.log('  wrote dist/dashboard/index.html');
  await copyFile(join(SRC, 'dashboard', 'app.js'), join(OUT, 'dashboard', 'app.js'));
  console.log('  wrote dist/dashboard/app.js');
  await copyFile(join(SRC, 'dashboard', 'owner-panel.js'), join(OUT, 'dashboard', 'owner-panel.js'));
  console.log('  wrote dist/dashboard/owner-panel.js');
  await copyFile(join(SRC, 'dashboard', 'join.html'), join(OUT, 'dashboard', 'join.html'));
  console.log('  wrote dist/dashboard/join.html');

  // /control/: hidden owner workbench (login + analytics + demo + tools).
  // robots-blocked, noindex meta. Copy index.html + control.js verbatim.
  const ctrlSrc = join(SRC, 'control');
  if (await exists(ctrlSrc)) {
    const ctrlOut = join(OUT, 'control');
    await mkdir(ctrlOut, { recursive: true });
    for (const f of ['index.html', 'control.js']) {
      const src = join(ctrlSrc, f);
      if (await exists(src)) {
        await copyFile(src, join(ctrlOut, f));
        console.log(`  wrote dist/control/${f}`);
      }
    }
  }

  // 4. Vendor: copy pdf.mjs, pdf.worker.mjs, pdf-lib.mjs, mammoth, fonts.css, font files.
  await copyFile(join(VENDOR, 'pdf.mjs'), join(OUT, 'vendor', 'pdf.mjs'));
  await copyFile(join(VENDOR, 'pdf.worker.mjs'), join(OUT, 'vendor', 'pdf.worker.mjs'));
  await copyFile(join(VENDOR, 'pdf-lib.mjs'), join(OUT, 'vendor', 'pdf-lib.mjs'));
  await copyFile(join(VENDOR, 'mammoth.browser.min.js'), join(OUT, 'vendor', 'mammoth.browser.min.js'));
  await copyFile(join(VENDOR, 'fonts.css'), join(OUT, 'vendor', 'fonts.css'));
  console.log('  copied vendor pdf.mjs, pdf.worker.mjs, pdf-lib.mjs, mammoth.browser.min.js, fonts.css');

  const fonts = await readdir(join(VENDOR, 'fonts'));
  for (const file of fonts) {
    await copyFile(join(VENDOR, 'fonts', file), join(OUT, 'vendor', 'fonts', file));
  }
  console.log(`  copied ${fonts.length} font files`);

  // 4a. pdf.js CMaps and standard_fonts. Needed at runtime when pdf.js
  // encounters CJK fonts (Hiragino common on macOS exports) or PDFs that
  // reference the 14 standard PostScript fonts without embedding them.
  for (const subdir of ['cmaps', 'standard_fonts']) {
    const src = join(VENDOR, subdir);
    if (await exists(src)) {
      const dst = join(OUT, 'vendor', subdir);
      await mkdir(dst, { recursive: true });
      const files = await readdir(src);
      for (const f of files) await copyFile(join(src, f), join(dst, f));
      console.log(`  copied ${files.length} ${subdir} files`);
    } else {
      console.log(`  skip ${subdir} (run \`npm run vendor\` to populate)`);
    }
  }

  // 4b. Brand assets: logos, lockups, favicons, OG card. Lives at
  // web/brand/ in source and is shipped verbatim to dist/brand/. The
  // HTML <head> blocks reference these paths directly; CSS resolves
  // ./brand/lockup-*.png relative to styles.css which is at the same
  // depth in both source and dist.
  const BRAND_SRC = join(SRC, 'brand');
  const BRAND_OUT = join(OUT, 'brand');
  await mkdir(BRAND_OUT, { recursive: true });
  const brandFiles = await readdir(BRAND_SRC);
  for (const file of brandFiles) {
    await copyFile(join(BRAND_SRC, file), join(BRAND_OUT, file));
  }
  console.log(`  copied ${brandFiles.length} brand assets`);

  // Update the preview HTML stylesheet links so they resolve correctly
  // inside dist/preview/ (../vendor/, ../styles.css already work).
  // Nothing else to rewrite, the dev paths happen to match dist.

  // 5. Summary.
  const bytes = await directorySizeBytes(OUT);
  console.log('');
  console.log(`Bundle is ready in web/dist/. Total: ${formatBytes(bytes)}.`);
  console.log('To preview locally:');
  console.log('  python3 -m http.server -d web/dist 5174');
}

function runVendor() {
  const result = spawnSync(process.execPath, [join(HERE, 'vendor.js')], {
    stdio: 'inherit',
  });
  if (result.status !== 0) throw new Error('vendor step failed');
}

async function exists(p) {
  try { await stat(p); return true; } catch { return false; }
}

async function directorySizeBytes(dir) {
  let total = 0;
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) total += await directorySizeBytes(p);
    else total += (await stat(p)).size;
  }
  return total;
}

function formatBytes(n) {
  if (n >= 1024 * 1024) return `${(n / 1024 / 1024).toFixed(2)} MB`;
  if (n >= 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${n} B`;
}

main().catch(err => {
  console.error('build failed:', err);
  process.exit(1);
});
