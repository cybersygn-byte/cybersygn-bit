#!/usr/bin/env node
/**
 * Generate "best e-signature for <vertical>" landing pages from a matrix.
 *
 * Reads scripts/best-for-matrix.json and emits one page per vertical at
 *   web/alternatives/best-e-signature-for-<slug>/index.html
 * with Article + BreadcrumbList + FAQPage JSON-LD, a hero, why-cards,
 * a contracts strip, an FAQ, and an internal-links block that ties the
 * money-page network together (comparisons, use-cases, hub, blog).
 *
 * web/alternatives/ is already copied into web/dist by build-web.js, so no
 * extra copy step is needed. The sitemap gains a BEST_OPEN/BEST_CLOSE section.
 *
 * Run: node scripts/build-best-for.mjs   (or npm run build:best)
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fitTitle, fitDescription } from './seo-meta.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const MATRIX = join(ROOT, 'scripts/best-for-matrix.json');
const OUT_ROOT = join(ROOT, 'web/alternatives');
const SITEMAP = join(ROOT, 'web/sitemap.xml');

// Fixed "available since" anchor: stable datePublished keeps the build idempotent.
const CRAWLABLE_SINCE = '2026-05-26';

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// A few evergreen internal targets that exist on the site. Kept deliberately
// short so every link resolves and the block stays scannable.
const RELATED_COMPARISONS = [
  ['../cybersygn-vs-docusign/', 'CyberSygn vs DocuSign'],
  ['../cybersygn-vs-pandadoc/', 'CyberSygn vs PandaDoc'],
  ['../cybersygn-vs-signwell/', 'CyberSygn vs SignWell'],
];
const RELATED_READING = [
  ['/blog/are-electronic-signatures-legally-binding/', 'Are electronic signatures legally binding?'],
  ['/blog/what-is-an-electronic-signature/', 'What is an electronic signature?'],
  ['/blog/audit-certificates-explained/', 'Audit certificates explained'],
];

function renderPage(v) {
  const slug = `best-e-signature-for-${v.slug}`;
  const canonical = `https://cybersygn.io/alternatives/${slug}/`;
  // Vertical names run from "lawyers" to "interior designers", so the copy is
  // written short and fitTitle / fitDescription enforce the SERP ceiling.
  const title = fitTitle(`The best e-signature for ${v.name}`, { suffix: '. CyberSygn.' });
  const description = fitDescription(`The e-signature tool built for ${v.name}. Every signature, date, and initial field found automatically. No signer account, audit trail on every document.`);

  const whyCards = (v.whyPoints || []).map(p => `
          <article class="doc-card">
            <h3 class="doc-card__title">${esc(p.title)}</h3>
            <p class="doc-card__body">${esc(p.body)}</p>
          </article>`).join('');

  const docChips = (v.docExamples || []).map(d => `<li class="best-doc">${esc(d)}</li>`).join('');

  const faqs = (v.faqs || []).slice(0, 3);

  const compLinks = RELATED_COMPARISONS.map(([h, t]) => `<li><a href="${h}">${esc(t)}</a></li>`).join('');
  const readLinks = RELATED_READING.map(([h, t]) => `<li><a href="${h}">${esc(t)}</a></li>`).join('');

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${esc(title)}</title>
  <meta name="description" content="${esc(description)}" />
  <meta name="keywords" content="${esc(v.keyword)}, e-signature for ${esc(v.name)}, best e-signature tool" />
  <meta name="robots" content="index, follow, max-image-preview:large" />
  <link rel="canonical" href="${esc(canonical)}" />
  <meta name="color-scheme" content="light dark" />
  <meta name="theme-color" content="#F7F8FB" media="(prefers-color-scheme: light)" />
  <meta name="theme-color" content="#011434" media="(prefers-color-scheme: dark)" />

  <link rel="icon" type="image/x-icon" href="../../brand/favicon.ico" sizes="any" />
  <link rel="icon" type="image/png" href="../../brand/favicon-32.png" sizes="32x32" />
  <link rel="apple-touch-icon" href="../../brand/favicon-180.png" />

  <meta property="og:title" content="${esc(title)}" />
  <meta property="og:description" content="${esc(description)}" />
  <meta property="og:image" content="https://cybersygn.io/brand/og-image.png" />
  <meta property="og:url" content="${esc(canonical)}" />
  <meta property="og:type" content="article" />
  <meta name="twitter:card" content="summary_large_image" />

  <link rel="stylesheet" href="../../vendor/fonts.css" />
  <link rel="stylesheet" href="../../styles.css" />

  <script type="application/ld+json">
  {
    "@context": "https://schema.org",
    "@graph": [
      {
        "@type": "BreadcrumbList",
        "itemListElement": [
          { "@type": "ListItem", "position": 1, "name": "CyberSygn", "item": "https://cybersygn.io/" },
          { "@type": "ListItem", "position": 2, "name": "Alternatives", "item": "https://cybersygn.io/alternatives/" },
          { "@type": "ListItem", "position": 3, "name": ${JSON.stringify(`Best for ${v.name}`)}, "item": ${JSON.stringify(canonical)} }
        ]
      },
      {
        "@type": "Article",
        "headline": ${JSON.stringify(v.headline)},
        "description": ${JSON.stringify(description)},
        "author": { "@type": "Organization", "name": "CyberSygn", "url": "https://cybersygn.io/" },
        "publisher": { "@type": "Organization", "name": "CyberSygn", "logo": { "@type": "ImageObject", "url": "https://cybersygn.io/brand/lockup-navy@2x.png" } },
        "datePublished": "${CRAWLABLE_SINCE}",
        "mainEntityOfPage": ${JSON.stringify(canonical)}
      },
      {
        "@type": "FAQPage",
        "mainEntity": ${JSON.stringify(faqs.map(f => ({ '@type': 'Question', name: f.q, acceptedAnswer: { '@type': 'Answer', text: f.a } })))}
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
      <a class="wordmark" href="../../" aria-label="CyberSygn home">
        <img class="wordmark__img" src="../../brand/lockup-navy@2x.png" alt="CYBERSYGN" /><span class="wordmark__context">for ${esc(v.name)}</span>
      </a>
      <nav class="masthead__nav" aria-label="Best for">
        <a class="masthead__link" href="../../">Home</a>
        <a class="masthead__link" href="../">Alternatives</a>
        <a class="masthead__link masthead__link--cta" href="../../preview/">Try It Out</a>
      </nav>
    </div>
  </header>

  <main>

    <section class="hero">
      <div class="container">
        <p class="kicker hero__kicker">For ${esc(v.name)}.</p>
        <h1 class="h-display hero__title">${esc(v.headline)}</h1>
        <p class="lede hero__lede">${esc(v.painLine)} CyberSygn finds every signature line, date, and initial automatically in about three seconds, your client signs from a link with no account, and each completed document carries a tamper-evident audit trail.</p>
        <div class="hero__actions">
          <a class="btn btn--primary btn--lg" href="../../preview/">Try It Out <span class="btn-arrow" aria-hidden="true">&#8594;</span></a>
          <a class="btn btn--ghost btn--lg" href="../../#pricing">See pricing</a>
        </div>
      </div>
    </section>

    <section class="section">
      <div class="container">
        <header class="section__head">
          <div>
            <p class="kicker kicker--muted">Why CyberSygn.</p>
            <h2 class="h-section section__title">Built for how ${esc(v.name)} actually work.</h2>
          </div>
        </header>
        <div class="doc-grid">${whyCards}
        </div>
      </div>
    </section>

    <section class="section section--alt">
      <div class="container">
        <header class="section__head">
          <div>
            <p class="kicker kicker--muted">Every agreement.</p>
            <h2 class="h-section section__title">The contracts ${esc(v.name)} send, signed in seconds.</h2>
          </div>
        </header>
        <ul class="best-docs">${docChips}
        </ul>
        <p class="lede" style="margin-top:20px">Drop any of them in as a PDF. CyberSygn detects the fields, you send, they sign. No dragging boxes, no accounts, no per-document setup tax.</p>
      </div>
    </section>

    <section class="section" id="faq" aria-labelledby="faq-title">
      <div class="container container--prose">
        <header class="section__head">
          <div>
            <p class="kicker kicker--muted">Common questions.</p>
            <h2 class="h-section section__title" id="faq-title">Questions ${esc(v.name)} ask.</h2>
          </div>
        </header>
        <div class="faq">
${faqs.map(f => `          <details class="faq__item">
            <summary class="faq__q">${esc(f.q)}</summary>
            <div class="faq__a"><p>${esc(f.a)}</p></div>
          </details>`).join('\n')}
        </div>
      </div>
    </section>

    <section class="section section--alt">
      <div class="container">
        <header class="section__head">
          <div>
            <p class="kicker kicker--muted">Keep reading.</p>
            <h2 class="h-section section__title">Compare, and dig in.</h2>
          </div>
        </header>
        <div class="best-related">
          <div class="best-related__col">
            <h3 class="best-related__title">See the comparisons</h3>
            <ul class="best-related__list">${compLinks}
              <li><a href="../">All e-signature alternatives</a></li>
            </ul>
          </div>
          <div class="best-related__col">
            <h3 class="best-related__title">Understand the basics</h3>
            <ul class="best-related__list">${readLinks}
            </ul>
          </div>
        </div>
      </div>
    </section>

    <section class="section">
      <div class="container" style="text-align:center">
        <h2 class="h-section">Send your first contract in about 30 seconds.</h2>
        <p class="lede" style="margin:12px auto 24px;max-width:52ch">Your first one's on us (three free, no card). If CyberSygn saves you time, Solo is $12 a month, unlimited.</p>
        <a class="btn btn--primary btn--lg" href="../../preview/">Try It Out <span class="btn-arrow" aria-hidden="true">&#8594;</span></a>
      </div>
    </section>

  </main>

  <footer class="colophon">
    <div class="container colophon__inner">
      <span>CyberSygn. Built in Colorado.</span>
      <nav class="colophon__links" aria-label="Legal">
        <a href="../../">Home</a>
        <a href="/developers/">Developers</a>
        <a href="/privacy/">Privacy</a>
        <a href="/terms/">Terms</a>
        <a href="/compliance/">Compliance</a>
      </nav>
    </div>
  </footer>

</body>
</html>
`;
}

async function updateSitemap(slugs) {
  let sitemap = await readFile(SITEMAP, 'utf8');
  const OPEN = '<!-- BEST_OPEN -->';
  const CLOSE = '<!-- BEST_CLOSE -->';
  const oi = sitemap.indexOf(OPEN);
  const ci = sitemap.indexOf(CLOSE);
  if (oi >= 0 && ci > oi) sitemap = sitemap.slice(0, oi) + sitemap.slice(ci + CLOSE.length);
  const block = OPEN + '\n' + slugs.map(s =>
    `  <url>\n    <loc>https://cybersygn.io/alternatives/best-e-signature-for-${s}/</loc>\n    <changefreq>monthly</changefreq>\n    <priority>0.8</priority>\n  </url>`,
  ).join('\n') + '\n' + CLOSE;
  const insertAt = sitemap.lastIndexOf('</urlset>');
  sitemap = sitemap.slice(0, insertAt) + block + '\n' + sitemap.slice(insertAt);
  // Collapse accumulated blank lines so re-running the build is idempotent.
  sitemap = sitemap.replace(/\n{3,}/g, '\n\n');
  await writeFile(SITEMAP, sitemap, 'utf8');
  console.log(`  sitemap.xml updated with ${slugs.length} best-for URLs`);
}

async function main() {
  const matrix = JSON.parse(await readFile(MATRIX, 'utf8'));
  const verticals = matrix.verticals || [];
  for (const v of verticals) {
    const dir = join(OUT_ROOT, `best-e-signature-for-${v.slug}`);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'index.html'), renderPage(v), 'utf8');
  }
  console.log(`Wrote ${verticals.length} best-for pages.`);
  await updateSitemap(verticals.map(v => v.slug));
}

main().catch(err => { console.error(err); process.exit(1); });
