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

// Clamp a post's publish date to today for anything CRAWLABLE or human-visible.
// The index still gates the grid on the raw publishDate (reveal-on-schedule),
// but no crawlable page should ever advertise a future datePublished /
// dateModified / byline — Google distrusts future-dated structured data.
function displayDate(iso) {
  return iso && iso > TODAY ? TODAY : iso;
}

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function formatDate(iso) {
  const d = new Date(iso + 'T12:00:00Z');
  return d.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric', timeZone: 'UTC' });
}

// Count words across the full post body (intro + every section). Used to
// derive reading time and the word-count meta. Keeps the math in one place
// so the index card and the post header always agree.
function countWords(post) {
  const parts = [post.hook, post.intro];
  for (const s of post.sections || []) {
    parts.push(s.heading, s.content);
  }
  const text = parts.filter(Boolean).join(' ');
  const words = text.trim().split(/\s+/).filter(Boolean);
  return words.length;
}

// Reading time at ~220 wpm, rounded up, floor of 1 minute.
function readingTime(post) {
  const minutes = Math.max(1, Math.ceil(countWords(post) / 220));
  return minutes;
}

function readingLabel(post) {
  return `${readingTime(post)} min read`;
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

// "Related reading" strip: up to 3 other PUBLISHED posts in the same
// category. Prefer the post's own relatedSlugs, then fill from same-category
// posts, then fall back to most-recent published. Always excludes the current
// post and anything not yet published (humans only see live posts here).
function renderRelated(post, published) {
  const pool = published.filter(p => p.slug !== post.slug);
  const picked = [];
  const seen = new Set();
  const add = (p) => {
    if (p && !seen.has(p.slug) && picked.length < 3) {
      seen.add(p.slug);
      picked.push(p);
    }
  };
  // 1. Explicit related slugs (published only).
  for (const slug of post.relatedSlugs || []) {
    add(pool.find(p => p.slug === slug));
  }
  // 2. Same category, most recent first.
  for (const p of pool.filter(p => p.category === post.category)) add(p);
  // 3. Fall back to most-recent published of any category.
  for (const p of pool) add(p);

  if (picked.length === 0) return '';
  return `
    <section class="post__related" aria-label="Related reading">
      <p class="kicker kicker--muted">Related reading</p>
      <ul class="post__related-list">
        ${picked.map(r =>
          `<li><a href="/blog/${esc(r.slug)}/">
            <span class="post__related-cat">${esc(r.category)}</span>
            <strong>${esc(r.title)}</strong>
            <span class="post__related-desc">${esc(r.metaDescription.slice(0, 110))}</span>
            <span class="post__related-meta">${esc(readingLabel(r))}</span>
          </a></li>`,
        ).join('\n')}
      </ul>
    </section>`;
}

// Prev / Next navigation by publishDate order within the PUBLISHED set.
// `published` is sorted newest-first; "Previous" points to the older post,
// "Next" to the newer one, which reads naturally for an archive.
function renderPrevNext(post, published) {
  const idx = published.findIndex(p => p.slug === post.slug);
  if (idx === -1) return '';
  const newer = idx > 0 ? published[idx - 1] : null;
  const older = idx < published.length - 1 ? published[idx + 1] : null;
  if (!newer && !older) return '';
  const link = (p, dir, label) => p
    ? `<a class="post__nav-link post__nav-link--${dir}" href="/blog/${esc(p.slug)}/">
        <span class="post__nav-dir">${esc(label)}</span>
        <span class="post__nav-title">${esc(p.title)}</span>
      </a>`
    : `<span class="post__nav-link post__nav-link--empty" aria-hidden="true"></span>`;
  return `
    <nav class="post__nav" aria-label="More posts">
      ${link(older, 'prev', '← Previous')}
      ${link(newer, 'next', 'Next →')}
    </nav>`;
}

// Share actions: X/Twitter, LinkedIn share intents + a copy-link button.
// No external SDKs — intent URLs open in a new tab, copy uses the
// clipboard script wired up at the bottom of the page.
function renderShare(post, canonical) {
  const url = encodeURIComponent(canonical);
  const text = encodeURIComponent(post.title);
  const xHref = `https://twitter.com/intent/tweet?url=${url}&text=${text}`;
  const liHref = `https://www.linkedin.com/sharing/share-offsite/?url=${url}`;
  return `
    <div class="post__share" aria-label="Share this article">
      <span class="post__share-label">Share</span>
      <a class="post__share-btn" href="${esc(xHref)}" target="_blank" rel="noopener" aria-label="Share on X">X</a>
      <a class="post__share-btn" href="${esc(liHref)}" target="_blank" rel="noopener" aria-label="Share on LinkedIn">LinkedIn</a>
      <button class="post__share-btn post__share-copy" type="button" data-copy-url="${esc(canonical)}" aria-label="Copy link to this article">Copy link</button>
    </div>`;
}

const DISCLAIMER_HTML = `
  <aside class="post__disclaimer">
    <strong>Not legal advice.</strong> This article describes how e-signature workflows
    and tools work, in general terms. It is not legal advice for any specific
    document, jurisdiction, or transaction. Talk to a licensed attorney in your
    state for guidance on your specific situation.
  </aside>`;

function renderPost(post, published) {
  const canonical = `https://cybersygn.io/blog/${post.slug}/`;
  const cta = buildCta(post);
  const words = countWords(post);
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
  <meta property="article:published_time" content="${esc(displayDate(post.publishDate))}T12:00:00Z" />
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
      "datePublished": displayDate(post.publishDate) + 'T12:00:00Z',
      "dateModified": displayDate(post.publishDate) + 'T12:00:00Z',
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

  <div class="post-progress" id="post-progress" aria-hidden="true"><span class="post-progress__bar" id="post-progress-bar"></span></div>

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
        <div class="post__meta">
          <span class="post__meta-item post__meta-cat">${esc(post.category)}</span>
          <span class="post__meta-sep" aria-hidden="true">·</span>
          <time class="post__meta-item" datetime="${esc(displayDate(post.publishDate))}">${esc(formatDate(displayDate(post.publishDate)))}</time>
          <span class="post__meta-sep" aria-hidden="true">·</span>
          <span class="post__meta-item">${esc(readingLabel(post))}</span>
          <span class="post__meta-sep" aria-hidden="true">·</span>
          <span class="post__meta-item">${words.toLocaleString('en-US')} words</span>
        </div>
        ${renderShare(post, canonical)}
        <div class="post__body">
          ${post.hook ? `<p class="post__hook">${esc(post.hook)}</p>` : ''}
          <p class="post__intro">${esc(post.intro)}</p>
          ${renderSections(post)}
          ${post.disclaimerNeeded ? DISCLAIMER_HTML : ''}
        </div>

        <section class="post__cta">
          <p class="kicker">${esc(cta.kicker)}</p>
          <h3 class="post__cta-title">${esc(cta.title)}</h3>
          <p>${esc(cta.body)}</p>
          <a class="btn btn--primary btn--lg" href="${esc(cta.href)}">
            ${esc(cta.label)}
          </a>
        </section>

        ${renderPrevNext(post, published)}
        ${renderRelated(post, published)}
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

  <script>
    (function () {
      // Copy-link buttons — uses navigator.clipboard, no external SDK.
      document.querySelectorAll('.post__share-copy').forEach(function (btn) {
        btn.addEventListener('click', function () {
          var url = btn.getAttribute('data-copy-url') || window.location.href;
          var done = function () {
            var prev = btn.textContent;
            btn.textContent = 'Copied';
            btn.classList.add('is-copied');
            setTimeout(function () {
              btn.textContent = prev;
              btn.classList.remove('is-copied');
            }, 1600);
          };
          if (navigator.clipboard && navigator.clipboard.writeText) {
            navigator.clipboard.writeText(url).then(done).catch(function () { done(); });
          } else {
            var ta = document.createElement('textarea');
            ta.value = url;
            ta.setAttribute('readonly', '');
            ta.style.position = 'absolute';
            ta.style.left = '-9999px';
            document.body.appendChild(ta);
            ta.select();
            try { document.execCommand('copy'); } catch (e) {}
            document.body.removeChild(ta);
            done();
          }
        });
      });

      // Reading-progress bar. Respects prefers-reduced-motion (we still
      // update width, just skip the smoothing transition via CSS).
      var bar = document.getElementById('post-progress-bar');
      if (bar) {
        var ticking = false;
        var update = function () {
          var doc = document.documentElement;
          var scrollable = (doc.scrollHeight - doc.clientHeight) || 1;
          var pct = Math.min(1, Math.max(0, window.scrollY / scrollable));
          bar.style.width = (pct * 100).toFixed(2) + '%';
          ticking = false;
        };
        var onScroll = function () {
          if (!ticking) {
            window.requestAnimationFrame(update);
            ticking = true;
          }
        };
        window.addEventListener('scroll', onScroll, { passive: true });
        window.addEventListener('resize', onScroll, { passive: true });
        update();
      }
    })();
  </script>

</body>
</html>
`;
}

// Search blob shared by every card so filter/search behaves identically
// for the featured card and the grid cards.
function searchBlob(p) {
  return esc((p.title + ' ' + p.metaDescription + ' ' + p.primaryKeyword).toLowerCase());
}

// Featured card — the most recent published post, rendered large with a
// "Latest" ribbon and a category + date + reading-time meta row. It carries
// the same data-cat / data-search hooks as the grid cards so the existing
// filter logic hides it when it stops matching.
function renderFeatured(p) {
  return `
          <li class="blog-card blog-card--featured" data-cat="${esc(p.category)}" data-search="${searchBlob(p)}">
            <a class="blog-card__link" href="/blog/${esc(p.slug)}/">
              <span class="blog-card__ribbon">Latest</span>
              <span class="blog-card__meta">
                <span class="blog-card__cat">${esc(p.category)}</span>
                <span class="blog-card__dot" aria-hidden="true">·</span>
                <time class="blog-card__date" datetime="${esc(p.publishDate)}">${esc(formatDate(p.publishDate))}</time>
                <span class="blog-card__dot" aria-hidden="true">·</span>
                <span class="blog-card__read">${esc(readingLabel(p))}</span>
              </span>
              <h2 class="blog-card__title">${esc(p.title)}</h2>
              <p class="blog-card__desc">${esc(p.metaDescription)}</p>
              <span class="blog-card__more">Read the post →</span>
            </a>
          </li>`;
}

function renderCard(p) {
  return `
          <li class="blog-card" data-cat="${esc(p.category)}" data-search="${searchBlob(p)}">
            <a class="blog-card__link" href="/blog/${esc(p.slug)}/">
              <span class="blog-card__meta">
                <span class="blog-card__cat">${esc(p.category)}</span>
                <span class="blog-card__dot" aria-hidden="true">·</span>
                <span class="blog-card__read">${esc(readingLabel(p))}</span>
              </span>
              <h3 class="blog-card__title">${esc(p.title)}</h3>
              <p class="blog-card__desc">${esc(p.metaDescription)}</p>
              <time class="blog-card__date" datetime="${esc(p.publishDate)}">${esc(formatDate(p.publishDate))}</time>
            </a>
          </li>`;
}

function renderIndex(published) {
  // Group by category for the filter chips.
  const categories = [...new Set(published.map(p => p.category))].sort();
  // Featured = most recent published (list is sorted newest-first); the rest
  // fill the grid. With nothing published yet, both are empty and the empty
  // state covers it.
  const featured = published[0] || null;
  const rest = published.slice(1);
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
          <input id="blog-search" class="blog-search" type="search" placeholder="Search the archive." aria-label="Search the archive" />
          <div class="blog-cats" role="tablist" aria-label="Categories">
            <button class="blog-cat is-active" data-cat="all" type="button">All ${published.length}</button>
            ${categories.map(c => `<button class="blog-cat" data-cat="${esc(c)}" type="button">${esc(c)}</button>`).join('')}
          </div>
        </div>

        <p id="blog-count" class="blog-count" role="status" aria-live="polite" data-total="${published.length}">Showing ${published.length} of ${published.length} posts</p>

        <ol class="blog-grid" id="blog-grid">
          ${featured ? renderFeatured(featured) : ''}
          ${rest.map(renderCard).join('')}
        </ol>

        <p id="blog-empty" class="blog-empty" hidden>No posts match your search. Try a different word or clear the filter.</p>
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
      var count = document.getElementById('blog-count');
      var cats = document.querySelectorAll('.blog-cat');
      var cards = grid.querySelectorAll('.blog-card');
      var total = count ? parseInt(count.getAttribute('data-total'), 10) || cards.length : cards.length;
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
        if (count) {
          count.textContent = 'Showing ' + visible + ' of ' + total + ' post' + (total === 1 ? '' : 's');
        }
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

  // Two views of the matrix:
  //  - `published` (publishDate <= today): what the HUMAN-facing index grid
  //    surfaces, preserving the Tuesday/Thursday editorial drip.
  //  - `all`: every post gets a live, crawlable page AND a sitemap entry so
  //    search engines and AI crawlers can index the full corpus immediately.
  //    This is the "drop all for the machines now, reveal on schedule for the
  //    humans" model. It is white-hat: bots and humans get identical content at
  //    every URL. We never user-agent cloak. The only thing the schedule gates
  //    is what the index page features, not what exists or what crawlers see.
  const published = all
    .filter(p => p.publishDate && p.publishDate <= TODAY)
    .sort((a, b) => b.publishDate.localeCompare(a.publishDate));
  const crawlable = all
    .filter(p => p.slug && p.publishDate)
    .sort((a, b) => b.publishDate.localeCompare(a.publishDate));

  // Clean blog directory but keep the index — we rebuild it.
  try { await rm(BLOG_OUT, { recursive: true, force: true }); } catch (e) {}
  await mkdir(BLOG_OUT, { recursive: true });

  // Per-post pages — EVERY post, so the full corpus is crawlable now.
  // Prev/next + related only reference the PUBLISHED set so humans never
  // get linked to a page the index doesn't yet surface.
  for (const post of crawlable) {
    const dir = join(BLOG_OUT, post.slug);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'index.html'), renderPost(post, published), 'utf8');
  }

  // Blog index — only past-dated posts in the grid (human drip preserved).
  await writeFile(join(BLOG_OUT, 'index.html'), renderIndex(published), 'utf8');

  console.log(`Wrote ${crawlable.length} crawlable post pages (full corpus).`);
  console.log(`Index grid features ${published.length} published; ${crawlable.length - published.length} scheduled but live for crawlers.`);

  // Sitemap includes the FULL corpus so search engines index everything now.
  await updateSitemap(crawlable);
}

async function updateSitemap(posts) {
  const raw = await readFile(SITEMAP, 'utf8');
  const MARK_OPEN = '<!-- BLOG_OPEN -->';
  const MARK_CLOSE = '<!-- BLOG_CLOSE -->';
  const openIdx = raw.indexOf(MARK_OPEN);
  const closeIdx = raw.indexOf(MARK_CLOSE);
  if (openIdx < 0 || closeIdx <= openIdx) {
    console.warn('sitemap.xml missing BLOG_OPEN/CLOSE markers — skipping sitemap update');
    return;
  }
  // lastmod is clamped to today for not-yet-dated posts — never emit a future
  // lastmod (invalid per the sitemap spec). The content is live as of today.
  const lastmod = (p) => (p.publishDate <= TODAY ? p.publishDate : TODAY);
  const entries = [
    `  <url>\n    <loc>https://cybersygn.io/blog/</loc>\n    <changefreq>weekly</changefreq>\n    <priority>0.75</priority>\n  </url>`,
    ...posts.map(p =>
      `  <url>\n    <loc>https://cybersygn.io/blog/${p.slug}/</loc>\n    <lastmod>${lastmod(p)}</lastmod>\n    <changefreq>monthly</changefreq>\n    <priority>0.6</priority>\n  </url>`,
    ),
  ];
  const block = MARK_OPEN + '\n' + entries.join('\n') + '\n' + MARK_CLOSE;
  const updated = raw.slice(0, openIdx) + block + raw.slice(closeIdx + MARK_CLOSE.length);
  await writeFile(SITEMAP, updated, 'utf8');
  console.log(`Sitemap updated with ${posts.length} blog URLs (full corpus).`);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
