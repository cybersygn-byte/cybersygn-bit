#!/usr/bin/env node
/**
 * Blog cache generator (slice 103).
 *
 * Reads scripts/blog-matrix.json and emits:
 *   - web/blog/<slug>/index.html for every post whose publishDate <= today
 *   - web/blog/index.html (rebuilt blog landing with category filter, search,
 *     latest-on-top ordering)
 *   - Updates web/sitemap.xml inside <!-- BLOG_OPEN/CLOSE --> markers
 *     to include ONLY published posts
 *
 * Future-dated posts are tracked but NOT written to disk, so the worker
 * can never serve them. The blog index also excludes them.
 *
 * Per-post HTML includes Article JSON-LD, BreadcrumbList, OpenGraph,
 * canonical, dark-mode meta, related-posts grid, and a Solo/Studio CTA
 * chosen by the entry's audienceTier.
 *
 * Run via: npm run build:blog-cache  (or as part of npm run build)
 */

import { readFile, writeFile, mkdir, readdir, rm } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const MATRIX = join(ROOT, 'scripts/blog-matrix.json');
const BLOG_OUT = join(ROOT, 'web/blog');
const SITEMAP = join(ROOT, 'web/sitemap.xml');

const TODAY = new Date().toISOString().slice(0, 10);

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function formatDate(iso) {
  const d = new Date(iso + 'T12:00:00Z');
  return d.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric', timeZone: 'UTC' });
}

function buildCta(post) {
  if (post.audienceTier === 'studio') {
    return {
      kicker: 'For teams that sign together.',
      title: 'Studio plan, $29/month, 3 seats included.',
      body: post.cta || 'CyberSygn Studio gives 3 partners or staff a shared workspace, member roles, and an aggregated dashboard across every signer. Built for firms that send 50+ documents a month.',
      href: '/#pricing',
      label: 'See Studio pricing →',
    };
  }
  return {
    kicker: 'Ready to try it?',
    title: 'CyberSygn Solo. $12/month. Unlimited.',
    body: post.cta || 'Drop a PDF, watch every signature field appear in 3 seconds, send for signing. Solo gives you unlimited documents, templates that auto-apply, and a full audit certificate on every sign.',
    href: '/preview/',
    label: 'Try It Out →',
  };
}

function renderSections(post) {
  return post.sections.map(s =>
    `<h2 class="post__h2">${esc(s.heading)}</h2>\n<p class="post__p">${esc(s.content)}</p>`,
  ).join('\n');
}

function renderRelated(post, allPosts) {
  const related = (post.relatedSlugs || [])
    .map(slug => allPosts.find(p => p.slug === slug))
    .filter(Boolean)
    .filter(p => p.publishDate <= TODAY);
  if (related.length === 0) return '';
  return `
    <section class="post__related">
      <p class="kicker kicker--muted">Related reading</p>
      <ul class="post__related-list">
        ${related.map(r =>
          `<li><a href="/blog/${esc(r.slug)}/"><strong>${esc(r.title)}</strong><span>${esc(r.metaDescription.slice(0, 100))}</span></a></li>`,
        ).join('\n')}
      </ul>
    </section>`;
}

const DISCLAIMER_HTML = `
  <aside class="post__disclaimer">
    <strong>Not legal advice.</strong> This article describes how e-signature workflows
    and tools work, in general terms. It is not legal advice for any specific
    document, jurisdiction, or transaction. Talk to a licensed attorney in your
    state for guidance on your specific situation.
  </aside>`;

function renderPost(post, allPosts) {
  const canonical = `https://cybersygn.io/blog/${post.slug}/`;
  const cta = buildCta(post);
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${esc(post.title)} — CyberSygn</title>
  <meta name="description" content="${esc(post.metaDescription)}" />
  <meta name="keywords" content="${esc([post.primaryKeyword, ...(post.secondaryKeywords || [])].join(', '))}" />
  <meta name="robots" content="index, follow, max-image-preview:large" />
  <link rel="canonical" href="${esc(canonical)}" />
  <meta name="color-scheme" content="light dark" />
  <meta name="theme-color" content="#F7F8FB" media="(prefers-color-scheme: light)" />
  <meta name="theme-color" content="#011434" media="(prefers-color-scheme: dark)" />
  <link rel="icon" type="image/x-icon" href="../../brand/favicon.ico" sizes="any" />
  <link rel="icon" type="image/png" href="../../brand/favicon-32.png" sizes="32x32" />
  <link rel="apple-touch-icon" href="../../brand/favicon-180.png" />
  <meta property="og:title" content="${esc(post.title)}" />
  <meta property="og:description" content="${esc(post.metaDescription)}" />
  <meta property="og:image" content="https://cybersygn.io/brand/og-image.png" />
  <meta property="og:url" content="${esc(canonical)}" />
  <meta property="og:type" content="article" />
  <meta property="article:published_time" content="${esc(post.publishDate)}T12:00:00Z" />
  <meta name="twitter:card" content="summary_large_image" />
  <link rel="stylesheet" href="../../vendor/fonts.css" />
  <link rel="stylesheet" href="../../styles.css" />
  <script type="application/ld+json">
${JSON.stringify({
  "@context": "https://schema.org",
  "@graph": [
    {
      "@type": "BreadcrumbList",
      "itemListElement": [
        { "@type": "ListItem", "position": 1, "name": "CyberSygn", "item": "https://cybersygn.io/" },
        { "@type": "ListItem", "position": 2, "name": "Blog", "item": "https://cybersygn.io/blog/" },
        { "@type": "ListItem", "position": 3, "name": post.title, "item": canonical },
      ],
    },
    {
      "@type": "Article",
      "headline": post.title,
      "description": post.metaDescription,
      "datePublished": post.publishDate + 'T12:00:00Z',
      "dateModified": post.publishDate + 'T12:00:00Z',
      "author": { "@type": "Organization", "name": "CyberSygn", "url": "https://cybersygn.io/" },
      "publisher": { "@type": "Organization", "name": "CyberSygn", "logo": { "@type": "ImageObject", "url": "https://cybersygn.io/brand/lockup-navy@2x.png" } },
      "mainEntityOfPage": canonical,
      "articleSection": post.category,
      "keywords": [post.primaryKeyword, ...(post.secondaryKeywords || [])].join(', '),
    },
  ],
}, null, 2)}
  </script>
  <script src="/telemetry.js"></script>
</head>
<body>

  <header class="masthead">
    <div class="container masthead__inner">
      <a class="wordmark" href="../../" aria-label="CyberSygn home">
        <img class="wordmark__img" src="../../brand/lockup-navy@2x.png" alt="CYBERSYGN" /><span class="wordmark__context">blog</span>
      </a>
      <nav class="masthead__nav" aria-label="Blog">
        <a class="masthead__link" href="../">Blog index</a>
        <a class="masthead__link masthead__link--cta" href="../../preview/">Try It Out</a>
      </nav>
    </div>
  </header>

  <main class="post">
    <article class="post__article">
      <div class="container container--prose">
        <p class="post__crumb"><a href="../">Blog</a> · <span class="post__category">${esc(post.category)}</span></p>
        <h1 class="post__title">${esc(post.title)}</h1>
        <p class="post__date"><time datetime="${esc(post.publishDate)}">${esc(formatDate(post.publishDate))}</time></p>
        ${post.hook ? `<p class="post__hook">${esc(post.hook)}</p>` : ''}
        <p class="post__intro">${esc(post.intro)}</p>
        ${renderSections(post)}
        ${post.disclaimerNeeded ? DISCLAIMER_HTML : ''}

        <section class="post__cta">
          <p class="kicker">${esc(cta.kicker)}</p>
          <h3 class="post__cta-title">${esc(cta.title)}</h3>
          <p>${esc(cta.body)}</p>
          <a class="btn btn--primary btn--lg" href="${esc(cta.href)}">
            ${esc(cta.label)}
          </a>
        </section>

        ${renderRelated(post, allPosts)}
      </div>
    </article>
  </main>

  <footer class="colophon">
    <div class="container colophon__inner">
      <span>CyberSygn. Built in Colorado.</span>
      <nav class="colophon__links" aria-label="Legal">
        <a href="../../">Home</a>
        <a href="../">Blog</a>
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

function renderIndex(published) {
  // Group by category for the filter chips.
  const categories = [...new Set(published.map(p => p.category))].sort();
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>CyberSygn blog. Sharper signatures. Faster contracts. Fewer surprises.</title>
  <meta name="description" content="Field guides, compliance deep-dives, and contract workflow playbooks for independent operators and small teams. Read the post, ship the contract, get back to work." />
  <meta name="robots" content="index, follow, max-image-preview:large" />
  <link rel="canonical" href="https://cybersygn.io/blog/" />
  <meta name="color-scheme" content="light dark" />
  <meta name="theme-color" content="#F7F8FB" media="(prefers-color-scheme: light)" />
  <meta name="theme-color" content="#011434" media="(prefers-color-scheme: dark)" />
  <link rel="icon" type="image/x-icon" href="../brand/favicon.ico" sizes="any" />
  <link rel="icon" type="image/png" href="../brand/favicon-32.png" sizes="32x32" />
  <link rel="apple-touch-icon" href="../brand/favicon-180.png" />
  <meta property="og:title" content="CyberSygn blog" />
  <meta property="og:description" content="Field guides, compliance deep-dives, and workflow playbooks for the people who actually send the contract." />
  <meta property="og:image" content="https://cybersygn.io/brand/og-image.png" />
  <meta property="og:url" content="https://cybersygn.io/blog/" />
  <link rel="stylesheet" href="../vendor/fonts.css" />
  <link rel="stylesheet" href="../styles.css" />
  <script src="/telemetry.js"></script>
</head>
<body>

  <header class="masthead">
    <div class="container masthead__inner">
      <a class="wordmark" href="../" aria-label="CyberSygn home">
        <img class="wordmark__img" src="../brand/lockup-navy@2x.png" alt="CYBERSYGN" /><span class="wordmark__context">blog</span>
      </a>
      <nav class="masthead__nav" aria-label="Blog">
        <a class="masthead__link" href="../">Home</a>
        <a class="masthead__link masthead__link--cta" href="../preview/">Try It Out</a>
      </nav>
    </div>
  </header>

  <main>
    <section class="hero">
      <div class="container">
        <p class="kicker hero__kicker">CyberSygn blog.</p>
        <h1 class="h-display hero__title">Sharper signatures. Faster contracts. <em>Fewer surprises.</em></h1>
        <p class="lede hero__lede">Field guides, compliance deep-dives, and workflow playbooks for the people who actually send the contract — independents, photographers, coaches, founders, small studios. Read it, ship the contract, get back to work.</p>
        <p class="lede hero__lede" style="font-size: var(--t-sm); color: var(--muted); margin-top: var(--s-3);">New post every Tuesday and Thursday. Built by an operator, written for operators.</p>
      </div>
    </section>

    <section class="section">
      <div class="container">

        <div class="blog-controls">
          <input id="blog-search" class="blog-search" type="search" placeholder="Search the archive." />
          <div class="blog-cats" role="tablist" aria-label="Categories">
            <button class="blog-cat is-active" data-cat="all" type="button">All ${published.length}</button>
            ${categories.map(c => `<button class="blog-cat" data-cat="${esc(c)}" type="button">${esc(c)}</button>`).join('')}
          </div>
        </div>

        <ol class="blog-grid" id="blog-grid">
          ${published.map(p => `
          <li class="blog-card" data-cat="${esc(p.category)}" data-search="${esc((p.title + ' ' + p.metaDescription + ' ' + p.primaryKeyword).toLowerCase())}">
            <a class="blog-card__link" href="/blog/${esc(p.slug)}/">
              <p class="blog-card__cat">${esc(p.category)}</p>
              <h3 class="blog-card__title">${esc(p.title)}</h3>
              <p class="blog-card__desc">${esc(p.metaDescription)}</p>
              <p class="blog-card__date"><time datetime="${esc(p.publishDate)}">${esc(formatDate(p.publishDate))}</time></p>
            </a>
          </li>`).join('')}
        </ol>

        <p id="blog-empty" class="blog-empty" hidden>No posts match.</p>
      </div>
    </section>
  </main>

  <footer class="colophon">
    <div class="container colophon__inner">
      <span>CyberSygn. Built in Colorado.</span>
      <nav class="colophon__links" aria-label="Legal">
        <a href="../">Home</a>
        <a href="/privacy/">Privacy</a>
        <a href="/terms/">Terms</a>
        <a href="/compliance/">Compliance</a>
      </nav>
    </div>
  </footer>

  <script>
    (function () {
      var search = document.getElementById('blog-search');
      var grid = document.getElementById('blog-grid');
      var empty = document.getElementById('blog-empty');
      var cats = document.querySelectorAll('.blog-cat');
      var cards = grid.querySelectorAll('.blog-card');
      var state = { cat: 'all', q: '' };
      function refresh() {
        var visible = 0;
        cards.forEach(function (c) {
          var matchCat = state.cat === 'all' || c.dataset.cat === state.cat;
          var matchQ = !state.q || c.dataset.search.indexOf(state.q) !== -1;
          var show = matchCat && matchQ;
          c.style.display = show ? '' : 'none';
          if (show) visible++;
        });
        empty.hidden = visible > 0;
      }
      if (search) search.addEventListener('input', function () {
        state.q = search.value.trim().toLowerCase();
        refresh();
      });
      cats.forEach(function (b) {
        b.addEventListener('click', function () {
          cats.forEach(function (x) { x.classList.remove('is-active'); });
          b.classList.add('is-active');
          state.cat = b.dataset.cat;
          refresh();
        });
      });
    })();
  </script>

</body>
</html>
`;
}

async function main() {
  const raw = await readFile(MATRIX, 'utf8');
  const matrix = JSON.parse(raw);
  const all = matrix.posts || [];

  // Filter to published (publishDate <= today).
  const published = all
    .filter(p => p.publishDate && p.publishDate <= TODAY)
    .sort((a, b) => b.publishDate.localeCompare(a.publishDate));

  // Clean blog directory but keep the index — we rebuild it.
  try { await rm(BLOG_OUT, { recursive: true, force: true }); } catch (e) {}
  await mkdir(BLOG_OUT, { recursive: true });

  // Per-post pages.
  for (const post of published) {
    const dir = join(BLOG_OUT, post.slug);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'index.html'), renderPost(post, all), 'utf8');
  }

  // Blog index.
  await writeFile(join(BLOG_OUT, 'index.html'), renderIndex(published), 'utf8');

  console.log(`Generated ${published.length} blog post pages + index.`);
  console.log(`Future-dated posts pending: ${all.length - published.length}`);

  // Update sitemap.
  await updateSitemap(published);
}

async function updateSitemap(published) {
  const raw = await readFile(SITEMAP, 'utf8');
  const MARK_OPEN = '<!-- BLOG_OPEN -->';
  const MARK_CLOSE = '<!-- BLOG_CLOSE -->';
  const openIdx = raw.indexOf(MARK_OPEN);
  const closeIdx = raw.indexOf(MARK_CLOSE);
  if (openIdx < 0 || closeIdx <= openIdx) {
    console.warn('sitemap.xml missing BLOG_OPEN/CLOSE markers — skipping sitemap update');
    return;
  }
  const entries = [
    `  <url>\n    <loc>https://cybersygn.io/blog/</loc>\n    <changefreq>weekly</changefreq>\n    <priority>0.75</priority>\n  </url>`,
    ...published.map(p =>
      `  <url>\n    <loc>https://cybersygn.io/blog/${p.slug}/</loc>\n    <lastmod>${p.publishDate}</lastmod>\n    <changefreq>monthly</changefreq>\n    <priority>0.65</priority>\n  </url>`,
    ),
  ];
  const block = MARK_OPEN + '\n' + entries.join('\n') + '\n' + MARK_CLOSE;
  const updated = raw.slice(0, openIdx) + block + raw.slice(closeIdx + MARK_CLOSE.length);
  await writeFile(SITEMAP, updated, 'utf8');
  console.log(`Sitemap updated with ${published.length} blog URLs.`);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
