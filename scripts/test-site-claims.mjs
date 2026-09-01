/**
 * Live-copy honesty tests.
 *
 * Every case here is a claim that shipped to cybersygn.io and was not true on
 * the day it shipped:
 *  - signed PDFs "land in R2" and are mirrored forever, with a 30-day KV TTL,
 *    no R2 binding, and the PDF namespace outside the backup prefix list
 *  - a daily KV backup sold as disaster recovery that has never run
 *  - an embed mode documented against customer-hosted PDFs that our own
 *    connect-src 'self' blocks before the request leaves the browser
 *  - extra Studio seats at $9 each, from a retired SKU checkout refuses,
 *    against a seat count nothing enforces
 *  - a field-detection demo pointed at a PNG, which has no fields
 *
 * These assert the SOURCE under web/ and scripts/, never web/dist, because
 * dist is regenerated from both.
 */
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { TIERS, purchasableTiers } from '../worker/src/stripe.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(join(ROOT, p), 'utf8');

let pass = 0, fail = 0;
const results = [];
function t(name, fn) {
  try { fn(); pass++; results.push(`OK   ${name}`); }
  catch (e) { fail++; results.push(`FAIL ${name}\n       ${e.message.split('\n')[0]}`); }
}

/** Every hand-maintained source page, dist and vendored assets excluded. */
function sourcePages() {
  const out = [];
  const walk = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      const rel = relative(ROOT, p);
      if (rel.startsWith('web/dist') || rel.startsWith('web/vendor')) continue;
      if (e.isDirectory()) walk(p);
      // .js too. The embed widget's own JSDoc header is the first thing a
      // developer reads (it is served at /embed.js), and it carried a
      // my-site.com example that connect-src 'self' makes impossible. Scanning
      // only .html and .txt meant the third-party-origin test could not see the
      // one file most likely to be copied from.
      else if (/\.(html|txt|js)$/.test(e.name)) out.push(rel);
    }
  };
  walk(join(ROOT, 'web'));
  return out;
}

// ---- retention and backup -------------------------------------------------

t('no page claims documents land in R2 or are mirrored forever', () => {
  // The blog corpus is generated from the matrix, so check both.
  const sources = sourcePages().map(p => [p, read(p)]);
  sources.push(['scripts/blog-matrix.json', read('scripts/blog-matrix.json')]);
  const banned = [
    /move to \*\*Cloudflare R2\*\*/i,
    /(is|are|stay|stays|already) mirrored (across|in) /i,
    /replicated across (multiple|many) R2 data centers/i,
    /land in R2/i,
    /stores your signed PDFs and audit certificates indefinitely/i,
    /daily backup archive/i,
    /encrypted backups roll off/i,
  ];
  const hits = [];
  for (const [p, body] of sources) {
    for (const re of banned) if (re.test(body)) hits.push(`${p}: ${re}`);
  }
  assert.deepEqual(hits, [], hits.join('\n'));
});

t('the daily KV backup is described as unbound, not as running', () => {
  const matrix = read('scripts/blog-matrix.json');
  const post = JSON.parse(matrix).posts.find(p => p.slug === 'backup-and-disaster-recovery');
  const body = [post.intro, post.metaDescription, ...post.sections.map(s => s.content)].join('\n');
  assert.ok(/no automated backup running|has never (run|executed)/i.test(body),
    'the post must say the job has never run');
  assert.ok(!/runs every single day|runs hands-off, every single day/i.test(body),
    'the post must not still sell a nightly job');
});

t('the compliance page describes retention and backups as they actually are', () => {
  // This test used to assert the OPPOSITE: that the page says "There is no
  // backup archive" and never mentions R2. That was true when written and
  // became false the moment the R2 bucket was bound and the daily backup
  // started running, so the test was pinning a claim into place after it had
  // stopped being true. A test can enforce a lie as easily as a truth.
  const html = read('web/compliance/index.html');
  assert.ok(/\bR2\b/.test(html), 'the page must disclose the R2 backup target now that one exists');
  assert.ok(/35 day|35-day/.test(html), 'and the retention window callers are told about');
  // Check the CLAIM, not the one sentence that happened to carry it.
  // The first pass at this rewrote only the bolded lead of the backup bullet
  // and left the trailing clause, so the page asserted both that daily R2
  // backups are retained 35 days AND that "there is no backup for us to
  // restore from". I verified by grepping the exact string I had deleted,
  // which is why the contradiction survived a green build.
  for (const lie of [
    /There is no backup archive/i,
    /no object store or long-term archive/i,
    /no backup for us to restore from/i,
    /Nothing is copied to secondary storage/i,
  ]) {
    assert.ok(!lie.test(html), `compliance page still denies the backup: ${lie}`);
  }
  // Completed documents are kept, not expired: docRetention() returns {} once
  // completedAt is set, and signed:/audit: are written with no expirationTtl.
  assert.ok(!/Every document.{0,40}30-day KV expiry/s.test(html),
    'the page must not claim a 30-day expiry covers completed documents');
  assert.ok(/completed document is kept/i.test(html),
    'the page must say completed documents are retained');
});

// ---- embed / CSP ----------------------------------------------------------

t('no embed doc points data-cybersygn-sign at a third-party origin', () => {
  // connect-src 'self' blocks the signing page from fetching any PDF that is
  // not on cybersygn.io, so a customer-hosted example documents a dead feature.
  const bad = [];
  for (const p of sourcePages()) {
    for (const m of read(p).matchAll(/data-cybersygn-sign=(?:"|&quot;)(https?:\/\/[^"&]+)/g)) {
      if (!/^https:\/\/cybersygn\.io\//.test(m[1])) bad.push(`${p}: ${m[1]}`);
    }
  }
  assert.deepEqual(bad, [], bad.join('\n'));
});

t('the embed and developer docs say the PDF must be same-origin', () => {
  for (const p of ['web/embed/index.html', 'web/developers/index.html']) {
    assert.ok(/connect-src 'self'/.test(read(p)), `${p} must name the policy that blocks it`);
  }
});

t('the embed live demo loads a PDF, not an image', () => {
  const html = read('web/embed/index.html');
  const m = html.match(/data-cybersygn-sign="([^"]+)"\s*\n?\s*data-cybersygn-source="embed-docs"/);
  assert.ok(m, 'demo button found');
  assert.equal(m[1], 'https://cybersygn.io/templates-pdf/consulting-agreement.pdf');
});

// ---- retired add-ons ------------------------------------------------------

t('seat and white-label are retired, so nothing may offer them', () => {
  assert.equal(TIERS.seat.retired, true);
  assert.equal(TIERS.whitelabel.retired, true);
  // Priced in Stripe and still not purchasable: retirement wins.
  const cfg = purchasableTiers({ STRIPE_PRICE_SEAT: 'price_x', STRIPE_PRICE_WHITELABEL: 'price_y' });
  assert.equal(cfg.seat, false);
  assert.equal(cfg.whitelabel, false);
});

t('the dashboard never labels a retired add-on "Opening soon"', () => {
  const js = read('web/dashboard/app.js');
  // The phrase survives only in the comment explaining why it was removed.
  const code = js.split('\n').filter(l => !/^\s*(\*|\/\/)/.test(l)).join('\n');
  assert.ok(!/Opening soon/.test(code), 'no live "Opening soon" label');
  assert.ok(/seatRow.remove\(\)/.test(code) && /wlRow.remove\(\)/.test(code),
    'an unavailable add-on row is removed, not relabelled');
  assert.ok(/purchasable = \{ seat: false, whitelabel: false \}/.test(code),
    'purchasability defaults to nothing offered');
});

t('the homepage does not sell per-seat Studio pricing', () => {
  const html = read('web/index.html');
  assert.ok(!/add more at \$9 each/.test(html));
  assert.ok(!/Three seats included/.test(html));
  assert.ok(!/3-seat team/.test(html));
});

t('no page advertises the retired add-ons for sale', () => {
  const bad = [];
  for (const p of sourcePages()) {
    if (p.startsWith('web/terms') || p.startsWith('web/ambassador')) continue; // record of withdrawal
    const body = read(p);
    if (/extra seat \$9 per month/i.test(body)) bad.push(`${p}: seat add-on`);
    if (/white-label \$19 per month/i.test(body)) bad.push(`${p}: white-label add-on`);
  }
  assert.deepEqual(bad, [], bad.join('\n'));
});

// ---- head hygiene ---------------------------------------------------------

t('preview and dashboard ship an absolute og:image and an og:url', () => {
  for (const [p, url] of [['web/preview/index.html', 'https://cybersygn.io/preview/'],
    ['web/dashboard/index.html', 'https://cybersygn.io/dashboard/']]) {
    const html = read(p);
    assert.ok(html.includes('<meta property="og:image" content="https://cybersygn.io/brand/og-image.png" />'), `${p} og:image`);
    assert.ok(html.includes(`<meta property="og:url" content="${url}" />`), `${p} og:url`);
  }
});

t('control ships no empty meta description', () => {
  assert.ok(!/<meta name="description" content="" ?\/?>/.test(read('web/control/index.html')));
});

t('the dashboard links bulk send without the .html extension', () => {
  const html = read('web/dashboard/index.html');
  assert.ok(html.includes('href="./bulk-send"'));
  assert.ok(!html.includes('href="./bulk-send.html"'), 'the .html form costs a 307');
});

console.log(results.join('\n'));
console.log(`\nsite claims: ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
