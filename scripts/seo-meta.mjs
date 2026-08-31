/**
 * Shared title / meta-description fitting for the generated SEO corpus.
 *
 * Google truncates a title around 65 characters and a description around 160,
 * and a cut that lands mid-phrase reads as broken rather than as a summary.
 * The generators feed hand-written copy of wildly different lengths through
 * fixed templates, so trimming has to happen at build time in one place
 * instead of being policed page by page.
 *
 * The order of preference is deliberate: keep the copy whole, then drop the
 * decorative brand suffix, then cut at a real clause or sentence boundary, and
 * only fall back to a word-boundary cut when the string offers nothing better.
 * Cutting at punctuation is what keeps "Florida Electronic Signature Law: What
 * Changes When Your Client Is in Florida" from becoming "Florida Electronic
 * Signature Law: What Changes When Your".
 */

export const TITLE_MAX = 65;
export const DESCRIPTION_MAX = 160;

// Words that must never end a trimmed string: one left dangling reads as a
// truncation bug rather than as a shortened headline.
const DANGLING = new Set([
  'a', 'an', 'and', 'as', 'at', 'but', 'by', 'for', 'from', 'in', 'into', 'is',
  'of', 'on', 'or', 'that', 'the', 'to', 'up', 'via', 'with', 'when', 'what',
  'which', 'who', 'why', 'how', 'your', 'you', 'their', 'its', 'it', 'not',
]);

/** Strip trailing separators and any dangling connector left by a cut. */
function tidy(s) {
  let out = String(s).trim();
  for (;;) {
    const before = out;
    out = out.replace(/[\s,;:.\-(\[]+$/, '').trim();
    const last = out.split(/\s+/).pop() || '';
    if (DANGLING.has(last.toLowerCase())) {
      out = out.slice(0, out.length - last.length).trim();
    }
    if (out === before) return out;
  }
}

/**
 * Longest prefix of `s` that ends just before one of `boundaries`, fits in
 * `max`, and is still substantial enough to stand alone. Returns null when no
 * cut qualifies, so the caller can fall back to a word-boundary trim.
 */
function cutAtBoundary(s, max, boundaries, minKeep) {
  let best = null;
  for (const b of boundaries) {
    for (let idx = s.indexOf(b); idx !== -1 && idx <= max; idx = s.indexOf(b, idx + 1)) {
      const head = tidy(s.slice(0, idx));
      if (head.length >= minKeep && head.length <= max && (!best || head.length > best.length)) {
        best = head;
      }
    }
  }
  return best;
}

/** Longest whole-word prefix that fits. */
function cutAtWord(s, max) {
  if (s.length <= max) return tidy(s);
  const window = s.slice(0, max + 1);
  const sp = window.lastIndexOf(' ');
  return tidy(sp > 0 ? window.slice(0, sp) : window.slice(0, max));
}

/**
 * Fit a page title, optionally with a brand suffix such as ", CyberSygn".
 * The suffix is decoration: it is the first thing dropped when the title is
 * already at the limit, because the brand is in the domain either way.
 */
export function fitTitle(title, { suffix = '', max = TITLE_MAX } = {}) {
  const base = String(title || '').trim();
  const withSuffix = suffix ? base + suffix : base;
  if (withSuffix.length <= max) return withSuffix;
  if (base.length <= max) return base;
  return cutAtBoundary(base, max, [': ', ' (', ', ', ' and ', ' that '], 24) || cutAtWord(base, max);
}

/**
 * Fit a meta description. Prefers ending on a complete sentence, terminal
 * punctuation kept, since a description that stops mid-clause looks truncated
 * in the SERP rather than deliberately short.
 */
export function fitDescription(description, { max = DESCRIPTION_MAX } = {}) {
  const base = String(description || '').trim();
  if (base.length <= max) return base;

  // Sentence cut: keep everything through the terminal mark.
  let sentence = null;
  for (const m of base.matchAll(/[.?!](?=\s)/g)) {
    const end = m.index + 1;
    if (end > max) break;
    if (end >= 80) sentence = base.slice(0, end);
  }
  if (sentence) return sentence;

  return cutAtBoundary(base, max, [', ', '; ', ' and ', ': '], 80) || cutAtWord(base, max);
}
