/**
 * SEO meta-fitting tests, plus a corpus sweep over the built site.
 *
 * The corpus regressed to 131 titles over 65 characters and ~100 descriptions
 * over 160 because every generator pasted a fixed brand suffix onto
 * hand-written copy of unbounded length. These tests lock the fitter's
 * behaviour and then assert the property that actually matters: no GENERATED
 * indexable page ships an over-length title or description.
 */
import assert from 'node:assert/strict';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fitTitle, fitDescription, TITLE_MAX, DESCRIPTION_MAX } from './seo-meta.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

let pass = 0, fail = 0;
const results = [];
function t(name, fn) {
  try { fn(); pass++; results.push(`OK   ${name}`); }
  catch (e) { fail++; results.push(`FAIL ${name}\n       ${e.message.split('\n')[0]}`); }
}

// Pages that come out of scripts/build-*.mjs. Hand-written pages are out of
// scope here: a generator fix cannot reach them.
const GENERATED = [
  'web/blog/',
  'web/use-cases/',
  'web/alternatives/best-e-signature-for-',
  'web/alternatives/cybersygn-vs-',
];

// ---- fitTitle -------------------------------------------------------------

t('a short title keeps its brand suffix', () => {
  assert.equal(fitTitle('Audit certificates explained', { suffix: ', CyberSygn' }),
    'Audit certificates explained, CyberSygn');
});

t('the brand suffix is dropped before the title is ever cut', () => {
  // Over the ceiling only because of the suffix: the copy must survive whole.
  const title = 'What Is on an Audit Certificate (and Why It Wins Disputes)';
  assert.ok(title.length <= TITLE_MAX && title.length + ', CyberSygn'.length > TITLE_MAX);
  assert.equal(fitTitle(title, { suffix: ', CyberSygn' }), title, 'suffix dropped, copy intact');
});

t('an over-length title is cut at its colon, not mid-phrase', () => {
  assert.equal(
    fitTitle('Florida Electronic Signature Law: What Changes When Your Client Is in Florida',
      { suffix: ', CyberSygn' }),
    'Florida Electronic Signature Law');
});

t('a parenthetical is dropped rather than truncated', () => {
  // Two boundaries qualify here; the fitter keeps the longest that fits.
  assert.equal(
    fitTitle('Electronic Contract Retention: How Long to Keep Signed Contracts (and Why)',
      { suffix: ', CyberSygn' }),
    'Electronic Contract Retention: How Long to Keep Signed Contracts');
});

t('a title with no punctuation falls back to a whole-word cut', () => {
  const out = fitTitle("How CyberSygn's PDF Field Detection Finds Every Signature Line in 3 Seconds",
    { suffix: ', CyberSygn' });
  assert.ok(out.length <= TITLE_MAX, `got ${out.length}`);
  assert.ok(!out.endsWith(' in'), 'no dangling preposition');
  assert.ok('How CyberSygn\'s PDF Field Detection Finds Every Signature Line in 3 Seconds'.startsWith(out),
    'cut is a prefix of the original');
});

t('a cut never leaves trailing punctuation or a dangling connector', () => {
  for (const s of ['A Very Long Headline That Runs On, and On, and On, and Keeps Running Past The Limit',
    'Something Long: with a clause that is itself far too long to fit inside the ceiling here']) {
    const out = fitTitle(s, { suffix: ', CyberSygn' });
    assert.ok(out.length <= TITLE_MAX, `${out.length} for ${s}`);
    assert.ok(!/[\s,;:.\-(]$/.test(out), `trailing separator: ${out}`);
  }
});

// ---- fitDescription -------------------------------------------------------

t('a short description is untouched', () => {
  const d = 'Send and sign a contract in minutes.';
  assert.equal(fitDescription(d), d);
});

t('an over-length description ends on a whole sentence', () => {
  const out = fitDescription('Download signed PDF files plus a SHA-256 audit certificate after every send, because the PDF is the contract and the certificate is your proof. Here is how to grab both.');
  assert.equal(out, 'Download signed PDF files plus a SHA-256 audit certificate after every send, because the PDF is the contract and the certificate is your proof.');
  assert.ok(out.length <= DESCRIPTION_MAX);
});

t('a single over-length sentence falls back to a clause cut', () => {
  const out = fitDescription('A signature reminder done right closes contracts when it stays short and gentle with the link inside, so you can nudge a busy signer without ever sounding pushy.');
  assert.ok(out.length <= DESCRIPTION_MAX, `got ${out.length}`);
  assert.ok(!/[\s,;:.\-(]$/.test(out), `trailing separator: ${out}`);
});

t('fitting is idempotent', () => {
  const once = fitDescription('x'.repeat(40) + '. ' + 'y '.repeat(90));
  assert.equal(fitDescription(once), once);
  const t1 = fitTitle('Some Long Title: with a tail that will not fit inside sixty five characters');
  assert.equal(fitTitle(t1), t1);
});

// ---- corpus sweep ---------------------------------------------------------

function indexablePages() {
  const out = [];
  const walk = (d) => {
    if (!existsSync(d)) return;
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name === 'index.html') out.push(p);
    }
  };
  walk(join(ROOT, 'web/blog'));
  walk(join(ROOT, 'web/use-cases'));
  walk(join(ROOT, 'web/alternatives'));
  return out.filter(p => GENERATED.some(g => p.startsWith(join(ROOT, g))));
}

// Meta values are HTML-escaped in the source; a search engine sees the decoded
// text, so measure that.
function decode(s) {
  return s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'");
}

t('no generated indexable page exceeds the title or description ceiling', () => {
  const pages = indexablePages();
  assert.ok(pages.length > 200, `expected the generated corpus, found ${pages.length} pages`);
  const bad = [];
  for (const p of pages) {
    const html = readFileSync(p, 'utf8');
    if (/name="robots"[^>]*noindex/.test(html)) continue;
    const title = html.match(/<title>([\s\S]*?)<\/title>/);
    const desc = html.match(/<meta name="description" content="([^"]*)"/);
    if (title && decode(title[1]).trim().length > TITLE_MAX) {
      bad.push(`title ${decode(title[1]).trim().length} ${p}`);
    }
    if (desc && decode(desc[1]).length > DESCRIPTION_MAX) {
      bad.push(`desc ${decode(desc[1]).length} ${p}`);
    }
  }
  assert.deepEqual(bad, [], `${bad.length} over-length:\n${bad.slice(0, 10).join('\n')}`);
});

console.log(results.join('\n'));
console.log(`\nseo meta: ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
