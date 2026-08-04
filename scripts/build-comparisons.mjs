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

// Fixed "available since" anchor for these evergreen landing pages. Using a
// stable date instead of the build-day clock keeps datePublished honest and
// idempotent, so every deploy does not re-stamp datePublished to "today".
const CRAWLABLE_SINCE = '2026-05-26';

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
    soloPrice: '$12.99',
    soloPriceUnit: '/mo',
    soloPriceNotes: 'Acrobat Standard individual with e-sign, billed annually; Adobe restructured its Acrobat lineup in 2025-26, verify current pricing on adobe.com',
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
    soloPrice: '$15',
    soloPriceUnit: '/mo',
    soloPriceNotes: 'Essentials plan, single user, month-to-month; about $10 per month billed annually (as of August 2026)',
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
    soloPriceNotes: 'Starter plan, per seat, billed annually; month-to-month is materially higher (as of August 2026)',
    accountsRequired: 'Optional for signers',
    fieldPlacement: 'Manual drag-and-drop with template library',
    auditCert: 'Included',
    freeTier: 'Free plan capped at 60 documents per year for the whole team',
    weakness: 'Built for sales teams sending proposals, not for solo professionals sending contracts. The template editor is heavy and the workflow assumes a CRM behind it.',
    keyword: 'PandaDoc alternative, e-signature alternative to PandaDoc',
  },
  {
    slug: 'signnow',
    name: 'signNow',
    fullName: 'signNow (airSlate)',
    soloPrice: '$8',
    soloPriceUnit: '/mo',
    soloPriceNotes: 'Business plan, annual billing; every signNow plan reportedly caps 100 signature invites per user per year with per-invite overage fees, verify on signNow checkout',
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
    soloPrice: '$19.99',
    soloPriceUnit: '/mo',
    soloPriceNotes: 'Acrobat Pro individual with e-sign, billed annually; team plans carry transaction caps, verify current pricing on adobe.com',
    accountsRequired: 'Optional for signers',
    fieldPlacement: 'Manual drag-and-drop in Acrobat',
    auditCert: 'Included in higher tiers',
    freeTier: '7-day trial only',
    weakness: 'Lives inside Acrobat Pro. If you don\'t need the full Acrobat editing suite, you\'re paying for a lot you won\'t use. Field placement is the same drag-and-drop as Adobe Sign, they\'re the same product.',
    keyword: 'Acrobat Sign alternative, Adobe Sign alternative',
  },
  {
    slug: 'signwell',
    name: 'SignWell',
    fullName: 'SignWell (formerly DocSketch)',
    soloPrice: '$12',
    soloPriceUnit: '/mo',
    soloPriceNotes: 'Light plan, month-to-month; $10 per month billed annually, unlimited documents, one sender (as of August 2026)',
    accountsRequired: 'Yes (signer signup)',
    fieldPlacement: 'Manual drag-and-drop with template library',
    auditCert: 'Included',
    freeTier: '3 documents/month',
    weakness: 'Modern UI, transparent pricing. The detection step is missing, same drag-and-drop wall as the others. SignWell\'s receivers also have to create accounts, which is the universal complaint about DocuSign-style flows.',
    keyword: 'SignWell alternative, DocSketch alternative',
  },
  {
    slug: "zoho-sign",
    name: "Zoho Sign",
    fullName: "Zoho Sign",
    soloPrice: "$10",
    soloPriceUnit: "/mo",
    soloPriceNotes: "Standard plan, per user, billed annually (about $12 month-to-month), capped at 25 envelopes per user per month; verified August 2026 on Zoho's site",
    accountsRequired: "Signers can sign from an email link without creating an account",
    fieldPlacement: "Fields are dragged and dropped onto the document by hand, roughly 1 to 3 minutes per document",
    auditCert: "Yes, provides a completion certificate and audit trail on finished documents",
    freeTier: "Yes, a free plan capped at a small number of requests per month",
    weakness: "The entry plan carries monthly request limits and delivers most of its value once you already work inside the Zoho ecosystem. Every field is placed manually.",
    keyword: "cybersygn vs zoho sign",
  },
  {
    slug: "signeasy",
    name: "SignEasy",
    fullName: "SignEasy",
    soloPrice: "$10",
    soloPriceUnit: "/mo",
    soloPriceNotes: "Starts at roughly $10 on the Essential plan billed annually; exact figure varies by region, verify on SignEasy's pricing page",
    accountsRequired: "Signers can sign via a link without an account",
    fieldPlacement: "Signature and date fields are positioned manually on each document, roughly 1 to 3 minutes",
    auditCert: "Yes, includes an audit trail on completed documents",
    freeTier: "No permanent free plan, only a time-limited free trial",
    weakness: "With no ongoing free tier, a solo user who signs only occasionally pays a subscription from day one, and every field is positioned by hand.",
    keyword: "cybersygn vs signeasy",
  },
  {
    slug: "xodo-sign",
    name: "Xodo Sign",
    fullName: "Xodo Sign (formerly eversign)",
    soloPrice: "$10",
    soloPriceUnit: "/mo",
    soloPriceNotes: "Starts at approximately $10 on the entry paid plan; verify current pricing on Xodo Sign's site",
    accountsRequired: "Signers can sign from an email link without an account",
    fieldPlacement: "Fields are dragged onto documents manually, roughly 1 to 3 minutes each",
    auditCert: "Yes, provides an audit trail on completed documents",
    freeTier: "Yes, a free plan limited to a few documents per month",
    weakness: "Field placement is fully manual, and rising document volume pushes a solo user up through the paid tiers quickly.",
    keyword: "cybersygn vs xodo sign",
  },
  {
    slug: "foxit-esign",
    name: "Foxit eSign",
    fullName: "Foxit eSign (formerly eSign Genie)",
    soloPrice: "$10",
    soloPriceUnit: "/mo",
    soloPriceNotes: "Starts at roughly $10 per user on the entry plan billed annually; verify current pricing on Foxit's site",
    accountsRequired: "Signers can sign via a link without creating an account",
    fieldPlacement: "Every field is dropped onto the document by hand, roughly 1 to 3 minutes per document",
    auditCert: "Yes, includes an audit trail on completed documents",
    freeTier: "No standing free plan, a free trial is offered",
    weakness: "The interface leans toward multi-party business document workflows and manual field setup, which is more overhead than a solo user typically needs.",
    keyword: "cybersygn vs foxit esign",
  },
  {
    slug: "getaccept",
    name: "GetAccept",
    fullName: "GetAccept",
    soloPrice: "$15",
    soloPriceUnit: "/mo",
    soloPriceNotes: "Starts at approximately $15 per user on the e-signing entry plan billed annually; verify current pricing on GetAccept's site",
    accountsRequired: "Signers can sign from a link without an account",
    fieldPlacement: "Fields are placed manually within the document editor, roughly 1 to 3 minutes",
    auditCert: "Yes, provides an audit trail on completed documents",
    freeTier: "A limited free e-signing tier has been offered at times; verify current availability on GetAccept's site",
    weakness: "It is built as a sales engagement and proposal platform, so a solo user who only needs signatures pays for deal-room features they may not use.",
    keyword: "cybersygn vs getaccept",
  },
  {
    slug: "jotform-sign",
    name: "Jotform Sign",
    fullName: "Jotform Sign",
    soloPrice: "$34",
    soloPriceUnit: "/mo",
    soloPriceNotes: "Signing is bundled into Jotform plans starting around $34 on the Bronze tier billed annually; verify current pricing on Jotform's site",
    accountsRequired: "Signers can sign from a link without an account",
    fieldPlacement: "Fields are added through the form and document builder by hand, roughly 1 to 3 minutes",
    auditCert: "Yes, provides an audit trail on signed documents",
    freeTier: "Yes, a free plan with limited monthly signed documents",
    weakness: "It works best paired with Jotform forms, and standalone signing sits behind bundled plans with monthly signature limits.",
    keyword: "cybersygn vs jotform sign",
  },
  {
    slug: "dochub",
    name: "DocHub",
    fullName: "DocHub",
    soloPrice: "$14",
    soloPriceUnit: "/mo",
    soloPriceNotes: "Pro plan around $14 month-to-month, closer to $10 per month billed annually; verify current pricing on DocHub's site",
    accountsRequired: "Signers can sign via a shared link without an account",
    fieldPlacement: "Signature fields are drawn and positioned by hand, roughly 1 to 3 minutes",
    auditCert: "Yes, provides an audit trail on completed documents",
    freeTier: "Yes, a comparatively generous free plan",
    weakness: "It is primarily a PDF editor with signing added on, so there is no automatic field detection and multi-signer flows feel more manual.",
    keyword: "cybersygn vs dochub",
  },
  {
    slug: "signaturely",
    name: "Signaturely",
    fullName: "Signaturely",
    soloPrice: "$20",
    soloPriceUnit: "/mo",
    soloPriceNotes: "Personal plan around $20 month-to-month, lower billed annually; verify current pricing on Signaturely's site",
    accountsRequired: "Signers can sign from an email link without an account",
    fieldPlacement: "Fields are dragged onto the document manually, roughly 1 to 3 minutes",
    auditCert: "Yes, provides an audit trail on completed documents",
    freeTier: "Yes, a free plan limited to a few documents per month",
    weakness: "Field placement is manual and the free plan caps you at a handful of documents per month, so regular use quickly requires a paid tier.",
    keyword: "cybersygn vs signaturely",
  },
  {
    slug: "docsketch",
    name: "Docsketch",
    fullName: "Docsketch",
    soloPrice: "$10",
    soloPriceUnit: "/mo",
    soloPriceNotes: "Personal plan around $10 month-to-month, closer to $8 billed annually; verify current pricing on Docsketch's site",
    accountsRequired: "Signers can sign from a link without an account",
    fieldPlacement: "Signature fields are placed by hand, roughly 1 to 3 minutes per document",
    auditCert: "Yes, provides an audit trail on completed documents",
    freeTier: "Yes, a free plan limited to a few documents per month",
    weakness: "It doubles as a document tracking tool, but signature fields are positioned manually and the free plan allows only a few documents per month.",
    keyword: "cybersygn vs docsketch",
  },
  {
    slug: "yousign",
    name: "Yousign",
    fullName: "Yousign",
    soloPrice: "$9",
    soloPriceUnit: "/mo",
    soloPriceNotes: "Starts at roughly the euro equivalent of $9 per user on the entry plan billed annually; billed in euros, verify current pricing on Yousign's site",
    accountsRequired: "Signers can sign from a link without an account",
    fieldPlacement: "Fields are dropped onto the document manually, roughly 1 to 3 minutes",
    auditCert: "Yes, provides an audit trail on completed documents",
    freeTier: "No standing free plan, a free trial is offered",
    weakness: "It is a European eIDAS-focused provider billed in euros, which adds currency conversion and setup friction for a US-based solo user.",
    keyword: "cybersygn vs yousign",
  },
  {
    slug: "skribble",
    name: "Skribble",
    fullName: "Skribble",
    soloPrice: "$10",
    soloPriceUnit: "/mo",
    soloPriceNotes: "Per-signature pricing (a few dollars per signature) alongside subscription business plans; billed in euros or Swiss francs, verify current pricing on Skribble's site",
    accountsRequired: "Signers may need identity verification to sign, which can require an account or extra step for higher signature levels",
    fieldPlacement: "Signature positions are set manually, roughly 1 to 3 minutes per document",
    auditCert: "Yes, provides an audit trail and signature evidence on completed documents",
    freeTier: "Free to create an account, with paid per-signature or plan costs to send",
    weakness: "It is oriented to EU and Swiss qualified signatures with per-signature costs and identity steps, which is more process and expense than a simple US agreement needs.",
    keyword: "cybersygn vs skribble",
  },
  {
    slug: "boldsign",
    name: "BoldSign",
    fullName: "BoldSign",
    soloPrice: "$15",
    soloPriceUnit: "/mo",
    soloPriceNotes: "Starts at roughly $15 per user on the entry paid plan; verify current pricing on BoldSign's site",
    accountsRequired: "Signers can sign from a link without an account",
    fieldPlacement: "Fields are placed onto the document manually, roughly 1 to 3 minutes",
    auditCert: "Yes, provides an audit trail on completed documents",
    freeTier: "Yes, a free plan with limited monthly documents",
    weakness: "Its strongest fit is as a developer-friendly API, so a non-technical solo user taps less of its value and still places every field by hand.",
    keyword: "cybersygn vs boldsign",
  },
  {
    slug: "rightsignature",
    name: "RightSignature",
    fullName: "RightSignature",
    soloPrice: "$12",
    soloPriceUnit: "/mo",
    soloPriceNotes: "Starts at roughly $12 on the entry plan; increasingly sold alongside ShareFile, verify current standalone pricing on RightSignature's site",
    accountsRequired: "Signers can sign from a link without an account",
    fieldPlacement: "Fields are dragged onto documents by hand, roughly 1 to 3 minutes",
    auditCert: "Yes, provides an audit trail on completed documents",
    freeTier: "No standing free plan, a free trial is offered",
    weakness: "It is now positioned mainly as an add-on to ShareFile, so the standalone offering gets less focus for a solo user and fields are placed manually.",
    keyword: "cybersygn vs rightsignature",
  },
  {
    slug: "signable",
    name: "Signable",
    fullName: "Signable",
    soloPrice: "$30",
    soloPriceUnit: "/mo",
    soloPriceNotes: "Entry plan is priced in GBP at roughly the equivalent of $30 per month for a set document allowance, with pay-as-you-go also offered; verify current pricing on Signable's site",
    accountsRequired: "Signers can sign from an email link without an account",
    fieldPlacement: "Fields are positioned onto the document manually, roughly 1 to 3 minutes",
    auditCert: "Yes, provides an audit trail on completed documents",
    freeTier: "No standing free plan, a free trial is offered",
    weakness: "It is UK-based with GBP billing and a document-allowance model that can surprise a solo user who sends in occasional bursts.",
    keyword: "cybersygn vs signable",
  },
  {
    slug: "fill",
    name: "Fill",
    fullName: "Fill",
    soloPrice: "$10",
    soloPriceUnit: "/mo",
    soloPriceNotes: "Starts at roughly $10 on the entry paid plan; verify current pricing on Fill's site",
    accountsRequired: "Signers can sign from a link without an account",
    fieldPlacement: "Signature fields are placed onto the document by hand, roughly 1 to 3 minutes",
    auditCert: "Yes, provides an audit trail on completed documents",
    freeTier: "Yes, a free plan with limited monthly documents",
    weakness: "Lower tiers cap the number of documents per month and every signature field is positioned manually, adding setup time per document.",
    keyword: "cybersygn vs fill",
  },
];

function renderPage(c) {
  const canonical = `https://cybersygn.io/alternatives/cybersygn-vs-${c.slug}/`;
  const title = `CyberSygn vs ${c.name}. Side by side.`;
  const description = `How CyberSygn compares to ${c.name} on speed, price, signer experience, and field placement. Automatic field detection vs. drag-and-drop, all the trade-offs honestly.`;

  // Single source of truth for the FAQ: rendered visibly on the page AND
  // emitted as FAQPage JSON-LD (Google requires marked-up FAQs to be visible).
  const faqs = [
    {
      q: `How is CyberSygn different from ${c.name}?`,
      a: `CyberSygn finds every signature line, initial, date, and checkbox automatically in about 3 seconds. ${c.name} makes you drag each box into place by hand. CyberSygn signers click a magic link and sign without creating an account. Same ESIGN Act and UETA compliance; very different time investment.`,
    },
    {
      q: `Is CyberSygn cheaper than ${c.name}?`,
      a: `CyberSygn is unlimited at every plan, from $12 (Solo), $19 (Pro, with the AI co-pilot), $29 (Studio, 3 seats), to $79 (Business, white-label + SSO + API). ${c.name} starts at ${c.soloPrice}${c.soloPriceUnit}. Every CyberSygn plan starts with 3 free documents and no card. Origin is $9/month locked for the life of your account for the first 100 founders, and that rate disappears once the cap is filled.`,
    },
    {
      q: `Can I migrate from ${c.name} to CyberSygn?`,
      a: `Yes. Cancel your ${c.name} subscription, save your templates as PDFs, and upload them to CyberSygn. We detect the fields automatically. Past signed PDFs from ${c.name} remain valid signatures; they don't need to be re-signed.`,
    },
  ];

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
        "headline": ${JSON.stringify(`CyberSygn vs ${c.name}, side-by-side comparison`)},
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
        <img class="wordmark__img" src="../../brand/lockup-navy@2x.png" alt="CYBERSYGN" /><span class="wordmark__context">vs ${esc(c.name)}</span>
      </a>
      <nav class="masthead__nav" aria-label="Compare">
        <a class="masthead__link" href="../../">Home</a>
        <a class="masthead__link masthead__link--cta" href="../../preview/">Try It Out</a>
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
                Try It Out
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
            CyberSygn is the wedge, built around automatic field detection. ${esc(c.name)} sits in
            the same incumbents' category that all the dragging-boxes tools share.
          </p>
        </header>

        <div class="compare-table-wrap">
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
                <th scope="row">Plan pricing</th>
                <td class="compare__us">Unlimited at every plan: $12 Solo, $19 Pro (AI co-pilot), $29 Studio (3 seats), $79 Business (white-label, SSO, API)</td>
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
            Past signed PDFs from ${esc(c.name)} keep their legal weight, they're signed bytes, the
            audit attached to the document, not to the platform. Your new contracts run through
            CyberSygn from now on, faster and cheaper.
          </p>
        </header>

        <div class="hero__actions" style="margin-top: var(--s-5);">
          <a class="btn btn--primary btn--lg" href="../../preview/">
            Try It Out now
            <span class="btn-arrow" aria-hidden="true">→</span>
          </a>
          <a class="btn btn--ghost btn--lg" href="../../#founding">Claim an Origin spot →</a>
        </div>
      </div>
    </section>

    <section class="section" id="faq" aria-labelledby="faq-title">
      <div class="container">
        <header class="section__head">
          <div>
            <p class="kicker kicker--muted">Questions.</p>
            <h2 class="h-section section__title" id="faq-title">Common questions.</h2>
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
            <p class="kicker kicker--muted">Keep exploring.</p>
            <h2 class="h-section section__title">More ways CyberSygn fits your work.</h2>
          </div>
        </header>
        <div class="best-related">
          <div class="best-related__col">
            <h3 class="best-related__title">Best e-signature by profession</h3>
            <ul class="best-related__list">
              <li><a href="/alternatives/best-e-signature-for-real-estate-agents/">Real estate agents</a></li>
              <li><a href="/alternatives/best-e-signature-for-lawyers/">Lawyers</a></li>
              <li><a href="/alternatives/best-e-signature-for-accountants/">Accountants</a></li>
              <li><a href="/alternatives/">All alternatives and guides</a></li>
            </ul>
          </div>
          <div class="best-related__col">
            <h3 class="best-related__title">The basics</h3>
            <ul class="best-related__list">
              <li><a href="/blog/are-electronic-signatures-legally-binding/">Are e-signatures legally binding?</a></li>
              <li><a href="/blog/what-is-an-electronic-signature/">What is an electronic signature?</a></li>
              <li><a href="/blog/audit-certificates-explained/">Audit certificates explained</a></li>
            </ul>
          </div>
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
  // Collapse any accumulated blank lines so re-running the build is idempotent
  // (strip-then-insert otherwise leaves one extra newline before </urlset> each run).
  sitemap = sitemap.replace(/\n{3,}/g, '\n\n');
  await writeFile(SITEMAP, sitemap, 'utf8');
  console.log(`  sitemap.xml updated with ${urls.length} comparison URLs`);
}

main().catch(err => { console.error(err); process.exit(1); });
