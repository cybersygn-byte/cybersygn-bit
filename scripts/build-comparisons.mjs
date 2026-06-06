#!/usr/bin/env node
/**
 * Generate "CyberSygn vs <competitor>" comparison pages from a matrix.
 *
 * Each competitor has its own pricing, positioning, and weak points.
 * The generator emits a page per competitor at
 *   web/alternatives/cybersygn-vs-<competitor-slug>/index.html
 * with Article + BreadcrumbList + FAQPage JSON-LD, a hero, an 11-row
 * comparison table, a migration CTA, and the standard CyberSygn voice.
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const OUT_ROOT = join(ROOT, 'web/alternatives');
const SITEMAP = join(ROOT, 'web/sitemap.xml');

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

const COMPETITORS = [
  {
    slug: 'adobe-sign',
    name: 'Adobe Sign',
    fullName: 'Adobe Acrobat Sign',
    soloPrice: '$24.99',
    soloPriceUnit: '/mo',
    soloPriceNotes: 'Individual plan, formerly Adobe Sign Solo',
    accountsRequired: 'Optional for signers (Adobe ID encouraged)',
    fieldPlacement: 'Manual drag-and-drop, ~20–25 min per contract',
    auditCert: 'Included in higher tiers',
    freeTier: '7-day trial, then paid only',
    weakness: 'Bundled inside the broader Adobe Creative Cloud workflow. Solo professionals pay for capabilities they\'ll never use. The UX assumes you live in Adobe.',
    keyword: 'Adobe Sign alternative, Adobe Acrobat Sign alternative',
  },
  {
    slug: 'dropbox-sign',
    name: 'Dropbox Sign',
    fullName: 'Dropbox Sign (formerly HelloSign)',
    soloPrice: '$20',
    soloPriceUnit: '/mo',
    soloPriceNotes: 'Essentials plan, single user',
    accountsRequired: 'Yes (Dropbox account, increasingly enforced)',
    fieldPlacement: 'Manual drag-and-drop, ~20 min per contract',
    auditCert: 'Included',
    freeTier: '3 documents/month, then locked',
    weakness: 'Tightly bound to Dropbox. If you don\'t use Dropbox for storage, the receiver UX gets confused: "create a Dropbox account to sign?"',
    keyword: 'Dropbox Sign alternative, HelloSign alternative',
  },
  {
    slug: 'pandadoc',
    name: 'PandaDoc',
    fullName: 'PandaDoc',
    soloPrice: '$19',
    soloPriceUnit: '/mo',
    soloPriceNotes: 'Essentials plan',
    accountsRequired: 'Optional for signers',
    fieldPlacement: 'Manual drag-and-drop with template library',
    auditCert: 'Included',
    freeTier: '14-day trial only, no free tier',
    weakness: 'Built for sales teams sending proposals, not for solo professionals sending contracts. The template editor is heavy and the workflow assumes a CRM behind it.',
    keyword: 'PandaDoc alternative, e-signature alternative to PandaDoc',
  },
  {
    slug: 'signnow',
    name: 'signNow',
    fullName: 'signNow (airSlate)',
    soloPrice: '$8',
    soloPriceUnit: '/mo',
    soloPriceNotes: 'Business plan, annual billing',
    accountsRequired: 'Optional for signers',
    fieldPlacement: 'Manual drag-and-drop',
    auditCert: 'Included',
    freeTier: '7-day trial only',
    weakness: 'Cheapest of the bunch but the field-placement UX is the same dragging exercise. The savings vs. CyberSygn ($1/month) disappear the first time you spend 30 minutes placing fields by hand.',
    keyword: 'signNow alternative, airSlate alternative',
  },
  {
    slug: 'acrobat-sign',
    name: 'Acrobat Sign',
    fullName: 'Adobe Acrobat Sign',
    soloPrice: '$24.99',
    soloPriceUnit: '/mo',
    soloPriceNotes: 'Same as Adobe Sign Individual',
    accountsRequired: 'Optional for signers',
    fieldPlacement: 'Manual drag-and-drop in Acrobat',
    auditCert: 'Included in higher tiers',
    freeTier: '7-day trial only',
    weakness: 'Lives inside Acrobat Pro. If you don\'t need the full Acrobat editing suite, you\'re paying for a lot you won\'t use. Field placement is the same drag-and-drop as Adobe Sign — they\'re the same product.',
    keyword: 'Acrobat Sign alternative, Adobe Sign alternative',
  },
  {
    slug: 'signwell',
    name: 'SignWell',
    fullName: 'SignWell (formerly DocSketch)',
    soloPrice: '$8',
    soloPriceUnit: '/mo',
    soloPriceNotes: 'Personal plan, annual billing',
    accountsRequired: 'Yes (signer signup)',
    fieldPlacement: 'Manual drag-and-drop with template library',
    auditCert: 'Included',
    freeTier: '3 documents/month',
    weakness: 'Modern UI, transparent pricing. The detection step is missing — same drag-and-drop wall as the others. SignWell\'s receivers also have to create accounts, which is the universal complaint about DocuSign-style flows.',
    keyword: 'SignWell alternative, DocSketch alternative',
  },
];

function renderPage(c) {
  const canonical = `https://cybersygn.io/alternatives/cybersygn-vs-${c.slug}/`;
  const title = `CyberSygn vs ${c.name}. Side by side.`;
  const description = `How CyberSygn compares to ${c.name} on speed, price, signer experience, and field placement. Automatic field detection vs. drag-and-drop, all the trade-offs honestly.`;

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${esc(title)}</title>
  <meta name="description" content="${esc(description)}" />
  <meta name="keywords" content="${esc(c.keyword)}, CyberSygn vs ${esc(c.name)}, e-signature comparison" />
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
          { "@type": "ListItem", "position": 3, "name": ${JSON.stringify(`vs ${c.name}`)}, "item": ${JSON.stringify(canonical)} }
        ]
      },
      {
        "@type": "Article",
        "headline": ${JSON.stringify(`CyberSygn vs ${c.name} — side-by-side comparison`)},
        "description": ${JSON.stringify(description)},
        "author": { "@type": "Organization", "name": "CyberSygn", "url": "https://cybersygn.io/" },
        "publisher": { "@type": "Organization", "name": "CyberSygn", "logo": { "@type": "ImageObject", "url": "https://cybersygn.io/brand/lockup-navy@2x.png" } },
        "datePublished": "${new Date().toISOString().slice(0,10)}",
        "mainEntityOfPage": ${JSON.stringify(canonical)}
      },
      {
        "@type": "FAQPage",
        "mainEntity": [
          {
            "@type": "Question",
            "name": ${JSON.stringify(`How is CyberSygn different from ${c.name}?`)},
            "acceptedAnswer": { "@type": "Answer", "text": ${JSON.stringify(`CyberSygn finds every signature line, initial, date, and checkbox automatically in about 3 seconds. ${c.name} makes you drag each box into place by hand. CyberSygn signers click a magic link and sign without creating an account. Same ESIGN Act and UETA compliance; very different time investment.`)} }
          },
          {
            "@type": "Question",
            "name": ${JSON.stringify(`Is CyberSygn cheaper than ${c.name}?`)},
            "acceptedAnswer": { "@type": "Answer", "text": ${JSON.stringify(`${c.name} starts at ${c.soloPrice}${c.soloPriceUnit}. CyberSygn Solo is $12/month for unlimited documents. CyberSygn Origin is $9/month locked for the life of your account, available to the first 100 founders. The Origin rate disappears once the cap is filled.`)} }
          },
          {
            "@type": "Question",
            "name": ${JSON.stringify(`Can I migrate from ${c.name} to CyberSygn?`)},
            "acceptedAnswer": { "@type": "Answer", "text": ${JSON.stringify(`Yes. Cancel your ${c.name} subscription, save your templates as PDFs, and upload them to CyberSygn. We detect the fields automatically. Past signed PDFs from ${c.name} remain valid signatures — they don't need to be re-signed.`)} }
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
      <a class="wordmark" href="../../" aria-label="CyberSygn home">
        <img class="wordmark__img" src="../../brand/lockup-navy@2x.png" alt="CYBERSYGN" /><span class="wordmark__context">vs ${esc(c.name)}</span>
      </a>
      <nav class="masthead__nav" aria-label="Compare">
        <a class="masthead__link" href="../../">Home</a>
        <a class="masthead__link masthead__link--cta" href="../../preview/">Try the demo</a>
      </nav>
    </div>
  </header>

  <main>

    <section class="hero">
      <div class="container">
        <div class="hero__grid">
          <div>
            <p class="kicker hero__kicker">CyberSygn vs ${esc(c.name)}.</p>
            <h1 class="h-display hero__title">
              Same legal weight<span class="dot">.</span><br>
              <span class="accent">Three seconds, not thirty minutes</span><span class="dot">.</span>
            </h1>
            <p class="lede hero__lede">
              ${esc(c.name)} is a capable signing platform. CyberSygn solves the part ${esc(c.name)}
              never did: locating signature lines, initials, dates, and checkboxes automatically in
              about three seconds. ${esc(c.weakness)}
            </p>
            <div class="hero__actions">
              <a class="btn btn--primary btn--lg" href="../../preview/">
                Try the demo, free
                <span class="btn-arrow" aria-hidden="true">→</span>
              </a>
              <a class="btn btn--ghost btn--lg" href="#compare">See the comparison</a>
            </div>
          </div>
          <aside class="demo-doc" aria-hidden="true">
            <span class="demo-doc__filename">SAMPLE.PDF</span>
            <h3 class="demo-doc__title">Field detection in your browser</h3>
            <p class="caption" style="margin-top:8px">Drop a PDF. Watch every field appear. No drag, no place, no manual work.</p>
          </aside>
        </div>
      </div>
    </section>

    <section class="section" id="compare">
      <div class="container">
        <header class="section__head">
          <div>
            <p class="kicker kicker--muted">Side by side.</p>
            <h2 class="h-section section__title">Pick the one that <em>respects your time.</em></h2>
          </div>
          <p class="lede section__lede">
            CyberSygn is the wedge — built around automatic field detection. ${esc(c.name)} sits in
            the same incumbents' category that all the dragging-boxes tools share.
          </p>
        </header>

        <div class="compare-table">
          <table class="compare">
            <thead>
              <tr>
                <th scope="col">&nbsp;</th>
                <th scope="col" class="compare__us">CyberSygn</th>
                <th scope="col">${esc(c.name)}</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <th scope="row">Field placement</th>
                <td class="compare__us"><span class="check">Auto-detected, ~3 seconds</span></td>
                <td>${esc(c.fieldPlacement)}</td>
              </tr>
              <tr>
                <th scope="row">Signer account required</th>
                <td class="compare__us"><span class="check">No. Click a link and sign.</span></td>
                <td>${esc(c.accountsRequired)}</td>
              </tr>
              <tr>
                <th scope="row">Solo plan price</th>
                <td class="compare__us">$12/mo (Solo) or $9/mo locked for life (Origin)</td>
                <td>${esc(c.soloPrice)}${esc(c.soloPriceUnit)} <small>(${esc(c.soloPriceNotes)})</small></td>
              </tr>
              <tr>
                <th scope="row">Free tier</th>
                <td class="compare__us"><span class="check">3 documents lifetime, every paid feature unlocked</span></td>
                <td>${esc(c.freeTier)}</td>
              </tr>
              <tr>
                <th scope="row">Templates</th>
                <td class="compare__us"><span class="check">Auto-apply on every repeat upload of the same PDF</span></td>
                <td>Manual template management</td>
              </tr>
              <tr>
                <th scope="row">In-person signing</th>
                <td class="compare__us"><span class="check">Built in, pass-the-device flow</span></td>
                <td>Varies by tier</td>
              </tr>
              <tr>
                <th scope="row">Camera scan upload</th>
                <td class="compare__us"><span class="check">Phone camera turns paper into signable PDF</span></td>
                <td>Varies by tier</td>
              </tr>
              <tr>
                <th scope="row">Audit certificate</th>
                <td class="compare__us"><span class="check">SHA-256 fingerprint, every signed doc, built in</span></td>
                <td>${esc(c.auditCert)}</td>
              </tr>
              <tr>
                <th scope="row">Browser-local processing</th>
                <td class="compare__us"><span class="check">Detection runs in your browser; bytes don't leave until send</span></td>
                <td>Files uploaded to servers from the start</td>
              </tr>
              <tr>
                <th scope="row">Founder rate, locked for life</th>
                <td class="compare__us">$9/mo Origin, capped at 100 founders</td>
                <td><span class="cross">No</span></td>
              </tr>
              <tr>
                <th scope="row">Direct line to the founder</th>
                <td class="compare__us"><span class="check">Yes, replies within a day</span></td>
                <td><span class="cross">No</span></td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>
    </section>

    <section class="section section--alt" id="migrate">
      <div class="container">
        <header class="section__head">
          <div>
            <p class="kicker">Switching takes 5 minutes.</p>
            <h2 class="h-section section__title">
              Cancel ${esc(c.name)}. Upload your templates.<br>
              <em>We find the fields. The rest stays the same.</em>
            </h2>
          </div>
          <p class="lede section__lede">
            Past signed PDFs from ${esc(c.name)} keep their legal weight — they're signed bytes, the
            audit attached to the document, not to the platform. Your new contracts run through
            CyberSygn from now on, faster and cheaper.
          </p>
        </header>

        <div class="hero__actions" style="margin-top: var(--s-5);">
          <a class="btn btn--primary btn--lg" href="../../preview/">
            Try the demo now
            <span class="btn-arrow" aria-hidden="true">→</span>
          </a>
          <a class="btn btn--ghost btn--lg" href="../../#founding">Claim an Origin spot →</a>
        </div>
      </div>
    </section>

  </main>

  <footer class="colophon">
    <div class="container colophon__inner">
      <span>CyberSygn. Built in Colorado.</span>
      <nav class="colophon__links" aria-label="Legal">
        <a href="../../">Home</a>
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
  const urls = [];
  for (const c of COMPETITORS) {
    const dir = join(OUT_ROOT, `cybersygn-vs-${c.slug}`);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'index.html'), renderPage(c), 'utf8');
    urls.push(`https://cybersygn.io/alternatives/cybersygn-vs-${c.slug}/`);
    console.log(`  wrote alternatives/cybersygn-vs-${c.slug}/`);
  }

  // Sitemap update
  let sitemap = await readFile(SITEMAP, 'utf8');
  const OPEN = '<!-- COMPARISONS_OPEN -->';
  const CLOSE = '<!-- COMPARISONS_CLOSE -->';
  const oi = sitemap.indexOf(OPEN);
  const ci = sitemap.indexOf(CLOSE);
  if (oi >= 0 && ci > oi) sitemap = sitemap.slice(0, oi) + sitemap.slice(ci + CLOSE.length);
  const block = OPEN + '\n' + urls.map(u =>
    `  <url>\n    <loc>${u}</loc>\n    <changefreq>monthly</changefreq>\n    <priority>0.85</priority>\n  </url>`,
  ).join('\n') + '\n' + CLOSE;
  const insertAt = sitemap.lastIndexOf('</urlset>');
  sitemap = sitemap.slice(0, insertAt) + block + '\n' + sitemap.slice(insertAt);
  await writeFile(SITEMAP, sitemap, 'utf8');
  console.log(`  sitemap.xml updated with ${urls.length} comparison URLs`);
}

main().catch(err => { console.error(err); process.exit(1); });
