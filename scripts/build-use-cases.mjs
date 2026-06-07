#!/usr/bin/env node
/**
 * Programmatic SEO generator.
 *
 * Reads scripts/seo-matrix.json and produces a landing page at
 *   web/use-cases/<doc-slug>/<vertical-slug>/index.html
 * for every (doc-type, vertical) pair where the vertical's `ideal`
 * list mentions that doc-type.
 *
 * Each page is search-intent-targeted: title and meta align with
 * what a buyer would type ("photography contract e-signature for
 * photographers"), copy speaks to that vertical's pain language,
 * and the FAQ explains how CyberSygn handles that doc type.
 *
 * Sitemap.xml gets updated with every generated URL.
 *
 * Run:
 *   node scripts/build-use-cases.mjs
 *
 * Idempotent: regenerating only rewrites what the template + matrix
 * produces. To stop generating a page, remove the (doc, vertical)
 * pairing from the matrix and delete the directory.
 */

import { readFile, writeFile, mkdir, readdir, rm } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const MATRIX = join(ROOT, 'scripts/seo-matrix.json');
const OUT_ROOT = join(ROOT, 'web/use-cases');
const SITEMAP = join(ROOT, 'web/sitemap.xml');

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function cap(s) { return s ? s.charAt(0).toUpperCase() + s.slice(1) : s; }

function renderPage(doc, vert) {
  const title = `${cap(doc.name)} e-signature for ${vert.name}. CyberSygn.`;
  const description = `Send and sign ${doc.indefinite || 'a'} ${doc.name} in minutes, not days. CyberSygn finds every signature line, initial, date, and checkbox for ${vert.name}. No manual placement, no signer accounts.`;
  const canonical = `https://cybersygn.io/use-cases/${doc.slug}/${vert.slug}/`;
  const h1 = `The fastest way for ${vert.name} to sign ${doc.indefinite || 'a'} ${doc.name}.`;
  const ogImage = 'https://cybersygn.io/brand/og-image.png';

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${esc(title)}</title>
  <meta name="description" content="${esc(description)}" />
  <meta name="keywords" content="${esc(doc.name)} e-signature, ${esc(doc.name)} signing, ${esc(doc.longName)} for ${esc(vert.name)}, electronic signature for ${esc(vert.name)}, sign ${esc(doc.name)} online, ${esc(vert.name)} contract software" />
  <meta name="robots" content="index, follow, max-image-preview:large" />
  <link rel="canonical" href="${esc(canonical)}" />
  <meta name="color-scheme" content="light dark" />
  <meta name="theme-color" content="#F7F8FB" media="(prefers-color-scheme: light)" />
  <meta name="theme-color" content="#011434" media="(prefers-color-scheme: dark)" />

  <link rel="icon" type="image/x-icon" href="../../../brand/favicon.ico" sizes="any" />
  <link rel="icon" type="image/png" href="../../../brand/favicon-32.png" sizes="32x32" />
  <link rel="apple-touch-icon" href="../../../brand/favicon-180.png" />

  <meta property="og:title" content="${esc(title)}" />
  <meta property="og:description" content="${esc(description)}" />
  <meta property="og:image" content="${esc(ogImage)}" />
  <meta property="og:url" content="${esc(canonical)}" />
  <meta property="og:type" content="article" />
  <meta name="twitter:card" content="summary_large_image" />

  <link rel="stylesheet" href="../../../vendor/fonts.css" />
  <link rel="stylesheet" href="../../../styles.css" />

  <script type="application/ld+json">
  {
    "@context": "https://schema.org",
    "@graph": [
      {
        "@type": "BreadcrumbList",
        "itemListElement": [
          { "@type": "ListItem", "position": 1, "name": "CyberSygn", "item": "https://cybersygn.io/" },
          { "@type": "ListItem", "position": 2, "name": "Use cases", "item": "https://cybersygn.io/use-cases/" },
          { "@type": "ListItem", "position": 3, "name": "${esc(cap(doc.name))}", "item": "https://cybersygn.io/use-cases/${esc(doc.slug)}/" },
          { "@type": "ListItem", "position": 4, "name": "For ${esc(vert.name)}", "item": "${esc(canonical)}" }
        ]
      },
      {
        "@type": "Article",
        "headline": ${JSON.stringify(`${cap(doc.name)} e-signature for ${vert.name}`)},
        "description": ${JSON.stringify(description)},
        "author": { "@type": "Organization", "name": "CyberSygn", "url": "https://cybersygn.io/" },
        "publisher": { "@type": "Organization", "name": "CyberSygn", "logo": { "@type": "ImageObject", "url": "https://cybersygn.io/brand/lockup-navy@2x.png" } },
        "datePublished": "${new Date().toISOString().slice(0, 10)}",
        "mainEntityOfPage": "${esc(canonical)}"
      },
      {
        "@type": "FAQPage",
        "mainEntity": [
          {
            "@type": "Question",
            "name": ${JSON.stringify(`How does CyberSygn handle ${doc.indefinite || 'a'} ${doc.name}?`)},
            "acceptedAnswer": { "@type": "Answer", "text": ${JSON.stringify(`${cap(doc.description)} CyberSygn locates every field automatically — typically ${doc.fields} — without manual placement. Signers receive a magic link, sign in their browser, and the signed PDF returns to you with a SHA-256 audit certificate.`)} }
          },
          {
            "@type": "Question",
            "name": ${JSON.stringify(`Is this legally binding for ${vert.name}?`)},
            "acceptedAnswer": { "@type": "Answer", "text": "Yes. CyberSygn is ESIGN Act (United States) and UETA-compliant. The audit certificate captures every signing event, IP address, timestamp, and the SHA-256 fingerprint of the original document. Same legal weight as DocuSign or HelloSign." }
          },
          {
            "@type": "Question",
            "name": "Do the signers need an account?",
            "acceptedAnswer": { "@type": "Answer", "text": "No. Signers click a unique magic link and sign in the browser. No signup, no password, no app to install." }
          },
          {
            "@type": "Question",
            "name": "What does this cost?",
            "acceptedAnswer": { "@type": "Answer", "text": "Demo: 3 documents lifetime, free, no credit card. Solo: $12 a month unlimited. Studio: $29 a month for a 3-seat team. Early-adopter tiers (Origin and Lifetime) are available while founding spots remain." }
          }
        ]
      }
    ]
  }
  </script>

  <script src="/telemetry.js"></script>
  <script src="/polish.js" defer></script>
</head>
<body>

  <header class="masthead">
    <div class="container masthead__inner">
      <a class="wordmark" href="../../../" aria-label="CyberSygn home">
        <img class="wordmark__img" src="../../../brand/lockup-navy@2x.png" alt="CYBERSYGN" /><span class="wordmark__context">${esc(doc.name)} · ${esc(vert.name)}</span>
      </a>
      <nav class="masthead__nav" aria-label="Use case">
        <a class="masthead__link" href="../../../">Home</a>
        <a class="masthead__link masthead__link--cta" href="../../../preview/">Try It Out</a>
      </nav>
    </div>
  </header>

  <main>

    <section class="hero">
      <div class="container">
        <div class="hero__grid">
          <div>
            <p class="kicker hero__kicker">${esc(cap(doc.name))} · For ${esc(vert.name)}.</p>
            <h1 class="h-display hero__title">${esc(h1)}</h1>
            <p class="lede hero__lede">
              ${esc(vert.audienceLine)} CyberSygn reads your ${esc(doc.name)} and places every signature line,
              initial, date, and checkbox — automatically, in about three seconds. Send it. Sign it. Done.
            </p>
            <div class="hero__actions">
              <a class="btn btn--primary btn--lg" href="../../../preview/">
                Try It Out
                <span class="btn-arrow" aria-hidden="true">→</span>
              </a>
              <a class="btn btn--ghost btn--lg" href="#how">How it works</a>
            </div>
          </div>
          <aside class="demo-doc" aria-hidden="true">
            <span class="demo-doc__filename">${esc(doc.slug.toUpperCase())}.PDF</span>
            <h3 class="demo-doc__title">${esc(cap(doc.longName))}</h3>
            <p class="caption" style="margin-top:8px">${esc(doc.fields)}</p>
          </aside>
        </div>
      </div>
    </section>

    <section class="section" id="how">
      <div class="container">
        <header class="section__head">
          <div>
            <p class="kicker kicker--muted">The flow.</p>
            <h2 class="h-section section__title">Three steps. Field detection does the placement.</h2>
          </div>
          <p class="lede section__lede">
            ${esc(doc.description)} CyberSygn was built so the slowest part of signing — finding and placing
            every field — disappears.
          </p>
        </header>

        <ol class="step-list">
          <li>
            <p class="kicker">Step 1</p>
            <h3 class="h-card">Drop your ${esc(doc.name)}.</h3>
            <p>Upload the PDF in any browser. Detection runs in your browser; the file does not leave the page until you choose to send it.</p>
          </li>
          <li>
            <p class="kicker">Step 2</p>
            <h3 class="h-card">Every field appears.</h3>
            <p>In about three seconds, CyberSygn places overlays on every signature line, initial, date, and checkbox. Review, adjust, and assign signers.</p>
          </li>
          <li>
            <p class="kicker">Step 3</p>
            <h3 class="h-card">Send and sign.</h3>
            <p>Each signer receives a unique magic link. They click, sign in their browser, and submit. You receive the signed PDF and the audit certificate.</p>
          </li>
        </ol>
      </div>
    </section>

    <section class="section section--alt">
      <div class="container">
        <header class="section__head">
          <div>
            <p class="kicker">Pricing.</p>
            <h2 class="h-section section__title">Pricing that respects ${esc(vert.singular)}.</h2>
          </div>
          <p class="lede section__lede">
            Demo is free for three documents lifetime. Solo is $12 a month, unlimited. Studio is $29
            a month for three seats. Early-adopter Origin and Lifetime tiers are available while
            founding spots remain.
          </p>
        </header>
        <div class="hero__actions" style="margin-top: var(--s-5);">
          <a class="btn btn--primary btn--lg" href="../../../preview/">Start free →</a>
          <a class="btn btn--ghost btn--lg" href="../../../#pricing">See plans →</a>
        </div>
      </div>
    </section>

  </main>

  <footer class="colophon">
    <div class="container colophon__inner">
      <span>CyberSygn. Built in Colorado.</span>
      <nav class="colophon__links" aria-label="Legal">
        <a href="../../../">Home</a>
        <a href="/privacy/">Privacy</a>
        <a href="/terms/">Terms</a>
        <a href="mailto:hello@cybersygn.io">Contact</a>
      </nav>
    </div>
  </footer>

</body>
</html>
`;
}

async function main() {
  const raw = await readFile(MATRIX, 'utf8');
  const matrix = JSON.parse(raw);
  const docs = new Map(matrix.docTypes.map(d => [d.slug, d]));
  const verts = matrix.verticals;

  // Pairs to generate: (doc, vertical) where vertical.ideal contains doc.slug.
  const pairs = [];
  for (const vert of verts) {
    for (const docSlug of vert.ideal || []) {
      const doc = docs.get(docSlug);
      if (!doc) continue;
      pairs.push({ doc, vert });
    }
  }

  // Clean out the use-cases dir before regen (idempotent).
  try { await rm(OUT_ROOT, { recursive: true, force: true }); } catch (e) {}

  const sitemapUrls = [];
  for (const { doc, vert } of pairs) {
    const dir = join(OUT_ROOT, doc.slug, vert.slug);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'index.html'), renderPage(doc, vert), 'utf8');
    const url = `https://cybersygn.io/use-cases/${doc.slug}/${vert.slug}/`;
    sitemapUrls.push(url);
    console.log(`  ${doc.slug}/${vert.slug}/`);
  }
  console.log(`Generated ${pairs.length} pages under web/use-cases/.`);

  // Update sitemap.xml: keep existing entries, add the use-case URLs.
  const sitemapRaw = await readFile(SITEMAP, 'utf8');
  const existing = sitemapRaw;
  // Strip prior use-cases entries (between MARK_OPEN and MARK_CLOSE comments).
  const MARK_OPEN = '<!-- USE_CASES_OPEN -->';
  const MARK_CLOSE = '<!-- USE_CASES_CLOSE -->';
  let cleaned;
  const openIdx = existing.indexOf(MARK_OPEN);
  const closeIdx = existing.indexOf(MARK_CLOSE);
  if (openIdx >= 0 && closeIdx > openIdx) {
    cleaned = existing.slice(0, openIdx) + existing.slice(closeIdx + MARK_CLOSE.length);
  } else {
    cleaned = existing;
  }
  const block = MARK_OPEN + '\n' + sitemapUrls.map(u =>
    `  <url>\n    <loc>${u}</loc>\n    <changefreq>monthly</changefreq>\n    <priority>0.6</priority>\n  </url>`,
  ).join('\n') + '\n' + MARK_CLOSE;
  const insertBefore = cleaned.lastIndexOf('</urlset>');
  if (insertBefore < 0) {
    console.error('sitemap.xml has no </urlset> closing tag; aborting sitemap update.');
    process.exit(2);
  }
  const updated = cleaned.slice(0, insertBefore) + block + '\n' + cleaned.slice(insertBefore);
  await writeFile(SITEMAP, updated, 'utf8');
  console.log(`Updated sitemap.xml with ${sitemapUrls.length} use-case URLs.`);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
