/**
 * The funnel instrument. POST /api/e plus permanent KV counters.
 *
 * Why this exists: Analytics Engine data expires (90 days), so a successful
 * use of the product is invisible a season later. This module gives every
 * funnel step a permanent, lifetime counter in KV alongside the existing
 * Analytics Engine write, so the control panel can always show real numbers.
 *
 * Exports:
 *   handleEvent(request, env)        POST /api/e handler. Always 204.
 *   getFunnel(env, days)             read lifetime + daily counters
 *   countCrawler(env, request)       server-side crawler visibility
 *   handleOwnerFunnel(request, env, url)  GET /api/owner/funnel (owner only)
 *
 * Design rules:
 *  - Telemetry must NEVER break the product. handleEvent catches everything
 *    and returns 204 no matter what came in. Unknown event names are
 *    silently dropped (204, never 4xx noise in the client console).
 *  - Only the 11 canonical event names are counted. The whitelist is the
 *    single source of truth shared with web/telemetry.js.
 *  - KV counters use read-modify-write increments. Those race under
 *    concurrency and KV allows about 1 write/sec/key, so simultaneous hits
 *    can drop a count. At current volume (about 2 free signups, zero paying
 *    customers) that loss is acceptable and honest to accept; Analytics
 *    Engine still records every point for the 90-day window. Failures are
 *    clamped silently.
 */

import { trackEvent } from './analytics.js';
import { checkRateLimit, ipKey } from './rate-limit.js';
import { getOwnerForRequest } from './owner.js';

// The canonical funnel, in order. Shared with the client transport. Do not
// rename or add without updating every producer.
export const CANONICAL_EVENTS = Object.freeze([
  'app_open',
  'pdf_loaded',
  'detect_done',
  'fields_confirmed',
  'signer_added',
  'send_started',
  'doc_created',
  'signed_downloaded',
  'sign_link_opened',
  'signer_completed',
  'cert_verified',
]);
const EVENT_SET = new Set(CANONICAL_EVENTS);

// The day the counters started existing. Zeros before this date are honest:
// nothing was counted, not nothing happened.
export const COUNTING_SINCE = '2026-08-17';

// Crawlers we count on HTML page serves: the two classic search engines plus
// every AI crawler named in web/robots.txt. Key is the KV slug; test is a
// case-insensitive substring of the user-agent. Order matters only for
// first-match; none of these substrings shadow another.
export const CRAWLERS = Object.freeze([
  ['googlebot', 'googlebot'],
  ['bingbot', 'bingbot'],
  ['gptbot', 'gptbot'],
  ['chatgpt-user', 'chatgpt-user'],
  ['oai-searchbot', 'oai-searchbot'],
  ['claudebot', 'claudebot'],
  ['claude-web', 'claude-web'],
  ['anthropic-ai', 'anthropic-ai'],
  ['perplexitybot', 'perplexitybot'],
  ['perplexity-user', 'perplexity-user'],
  ['google-extended', 'google-extended'],
  ['applebot-extended', 'applebot-extended'],
  ['ccbot', 'ccbot'],
  ['cohere-ai', 'cohere-ai'],
  ['meta-externalagent', 'meta-externalagent'],
  ['bytespider', 'bytespider'],
  ['amazonbot', 'amazonbot'],
  ['duckassistbot', 'duckassistbot'],
  ['youbot', 'youbot'],
  ['diffbot', 'diffbot'],
]);

const RATE_POLICIES = [{ windowSec: 60, max: 120 }];

// Generic bot sniff for the PERMANENT counters only. The lifetime KV numbers
// are the evidence base for the HANDOFF kill criteria ("10+ documents sent by
// humans who are not Nathan"), and they are aggregates that can never be
// re-filtered after the fact, so bots and the owner must be kept out at write
// time. Analytics Engine still records every point (it carries its own bot
// classification and the tier blob), so nothing is lost, only kept clean.
const GENERIC_BOT_RE = /\b(bot|spider|crawl|slurp|curl|wget|http-client|headlesschrome|facebookexternalhit|twitterbot|linkedinbot|slackbot|telegrambot|whatsapp)\b/i;

function noContent() {
  return new Response(null, { status: 204 });
}

function jsonResponse(status, obj) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/** UTC day stamp, YYYY-MM-DD, for the dated buckets. */
function dayStamp(d) {
  return (d || new Date()).toISOString().slice(0, 10);
}

/**
 * Increment the lifetime and today's daily counter for a slug. No TTL on
 * either key: these are the permanent record. Read-modify-write races and
 * the 1 write/sec/key KV limit can lose a concurrent increment; acceptable
 * at current volume (see module comment). Failures are swallowed.
 */
async function bumpCounters(env, slug) {
  const kv = env && env.CYBERSYGN_DOCS;
  if (!kv || typeof kv.get !== 'function') return;
  const keys = [`e:life:${slug}`, `e:day:${dayStamp()}:${slug}`];
  for (const key of keys) {
    try {
      const raw = await kv.get(key);
      const current = Number.parseInt(raw, 10);
      const next = (Number.isFinite(current) ? current : 0) + 1;
      await kv.put(key, String(next));  // NO TTL: lifetime record
    } catch (e) {
      // Clamp silently. A lost count must never surface to a user.
    }
  }
}

/** Read one integer counter; absent or unreadable is an honest 0. */
async function readCount(kv, key) {
  try {
    const raw = await kv.get(key);
    const n = Number.parseInt(raw, 10);
    return Number.isFinite(n) && n > 0 ? n : 0;
  } catch (e) {
    return 0;
  }
}

/**
 * POST /api/e handler.
 *
 * Accepts JSON {e: string, p?: object}. navigator.sendBeacon sends a bare
 * string as text/plain, so we read text and parse ourselves rather than
 * trusting a content-type. Validates against the canonical 11, rate-limits
 * per IP, then writes BOTH sinks: Analytics Engine (rich, expiring) and the
 * KV lifetime counters (flat, permanent).
 *
 * Returns 204 in every case, including garbage input, unknown names, and
 * rate-limited requests. Telemetry never throws to the caller.
 */
export async function handleEvent(request, env) {
  try {
    let raw = '';
    try { raw = await request.text(); } catch (e) { return noContent(); }
    let data = null;
    try { data = JSON.parse(raw); } catch (e) { return noContent(); }
    if (!data || typeof data !== 'object') return noContent();

    const name = typeof data.e === 'string' ? data.e : '';
    if (!EVENT_SET.has(name)) return noContent();  // reject quietly, no 4xx noise

    // Per-IP rate limit, reusing the shared limiter (its KV-read failure
    // mode is fail-closed, which is what we want for a public write path).
    // A limited request is dropped with the same silent 204.
    try {
      const rl = await checkRateLimit(env, `events:${ipKey(request)}`, RATE_POLICIES);
      if (!rl.ok) return noContent();
    } catch (e) {
      return noContent();
    }

    const p = (data.p && typeof data.p === 'object' && !Array.isArray(data.p)) ? data.p : {};

    // Sink a: Analytics Engine, matching the existing blob/index conventions
    // via the shared trackEvent builder. detect_done carries {count}; map it
    // into double1 (value) so it is queryable.
    const value = typeof p.count === 'number' ? p.count
                : typeof p.value === 'number' ? p.value : 0;
    await trackEvent(env, name, {
      request,
      senderId: typeof p.senderId === 'string' ? p.senderId : '',
      source:   typeof p.source   === 'string' ? p.source   : '',
      path:     typeof p.path     === 'string' ? p.path     : '',
      tier:     typeof p.tier     === 'string' ? p.tier     : 'free',
      value,
      durationMs: typeof p.durationMs === 'number' ? p.durationMs : 0,
    });

    // Sink b: permanent KV counters, HUMAN traffic only.
    // - Bots and crawlers are excluded entirely: a Googlebot-rendered
    //   app_open is not a person, and the counter can never be cleaned later.
    // - Owner traffic goes to a parallel e:life:owner:<event> key so the
    //   control panel can show human-only numbers next to QA numbers.
    //   The tier claim is client-asserted (sendBeacon cannot carry the owner
    //   header), which is safe here because spoofing tier=owner only
    //   UNDER-counts the spoofer, it can never inflate the human numbers.
    const ua = (request.headers && request.headers.get('user-agent')) || '';
    const isBot = classifyCrawler(ua) !== null || GENERIC_BOT_RE.test(ua);
    if (!isBot) {
      const isOwner = typeof p.tier === 'string' && p.tier === 'owner';
      await bumpCounters(env, isOwner ? `owner:${name}` : name);
    }

    return noContent();
  } catch (e) {
    // Absolute backstop: telemetry never breaks the product.
    return noContent();
  }
}

/** Classify a user-agent against the crawler table. Returns slug or null. */
export function classifyCrawler(ua) {
  if (!ua || typeof ua !== 'string') return null;
  const hay = ua.toLowerCase();
  for (const [slug, needle] of CRAWLERS) {
    if (hay.includes(needle)) return slug;
  }
  return null;
}

/**
 * Server-side crawler visibility. Called from index.js on HTML page serves
 * only. Cheap: one lowercase substring scan, then two counter bumps when a
 * known crawler matched, nothing otherwise. Never throws.
 */
export async function countCrawler(env, request) {
  try {
    const ua = (request && request.headers && request.headers.get('user-agent')) || '';
    const slug = classifyCrawler(ua);
    if (!slug) return null;
    await bumpCounters(env, `crawler:${slug}`);
    return slug;
  } catch (e) {
    return null;
  }
}

/** The last N day stamps, today first. */
function lastDays(n) {
  const out = [];
  const now = Date.now();
  for (let i = 0; i < n; i++) {
    out.push(dayStamp(new Date(now - i * 86400000)));
  }
  return out;
}

/**
 * Read the funnel: lifetime counters plus the last N daily buckets for all
 * 11 events, and the crawler counters. Absent keys read as 0, never a
 * placeholder.
 *
 * Shape:
 *   {
 *     since, days,
 *     lifetime: { app_open: 0, ... },                    // all 11, always
 *     daily:    [{ date, counts: { app_open: 0, ... } }],// newest first
 *     crawlers: { lifetime: { googlebot: 0, ... },       // all known slugs
 *                 daily: [{ date, counts: {...} }] }     // seen slugs only
 *   }
 *
 * KV-read budget, with real arithmetic because Cloudflare caps a request at
 * 1000 KV operations: 11 lifetimes + 11 x N dailies + 20 crawler lifetimes,
 * plus crawler dailies ONLY for crawlers actually seen and ONLY for the last
 * 7 days (the table's 7-day column is the only consumer; a 30-day crawler
 * column would cost 20 x 30 = 600 reads once the common crawlers have all
 * been seen, and blow the cap). Worst case at N=30: 11 + 330 + 20 + 140 =
 * 501 reads, honest headroom even if every crawler shows up.
 */
export async function getFunnel(env, days = 30) {
  const kv = env && env.CYBERSYGN_DOCS;
  const n = Math.max(1, Math.min(90, (Number(days) | 0) || 30));
  const dates = lastDays(n);

  const empty = () => {
    const counts = {};
    for (const ev of CANONICAL_EVENTS) counts[ev] = 0;
    return counts;
  };
  const result = {
    since: COUNTING_SINCE,
    days: n,
    lifetime: empty(),
    daily: dates.map((date) => ({ date, counts: empty() })),
    crawlers: { lifetime: {}, daily: dates.map((date) => ({ date, counts: {} })) },
  };
  for (const [slug] of CRAWLERS) result.crawlers.lifetime[slug] = 0;
  if (!kv || typeof kv.get !== 'function') return result;

  // Event lifetimes + dailies.
  await Promise.all(CANONICAL_EVENTS.map(async (ev) => {
    result.lifetime[ev] = await readCount(kv, `e:life:${ev}`);
    await Promise.all(dates.map(async (date, i) => {
      result.daily[i].counts[ev] = await readCount(kv, `e:day:${date}:${ev}`);
    }));
  }));

  // Crawler lifetimes, then dailies only for crawlers actually seen.
  await Promise.all(CRAWLERS.map(async ([slug]) => {
    result.crawlers.lifetime[slug] = await readCount(kv, `e:life:crawler:${slug}`);
  }));
  const seen = CRAWLERS.map(([slug]) => slug).filter((s) => result.crawlers.lifetime[s] > 0);
  // Last 7 days only: see the KV-read budget in the doc comment above.
  const crawlerDates = dates.slice(0, Math.min(7, dates.length));
  await Promise.all(seen.map(async (slug) => {
    await Promise.all(crawlerDates.map(async (date, i) => {
      result.crawlers.daily[i].counts[slug] = await readCount(kv, `e:day:${date}:crawler:${slug}`);
    }));
  }));

  return result;
}

/** Sum the first `upTo` daily buckets for one key. */
function sumDaily(daily, key, upTo) {
  let total = 0;
  const limit = Math.min(upTo, daily.length);
  for (let i = 0; i < limit; i++) {
    total += Number(daily[i].counts[key]) || 0;
  }
  return total;
}

/**
 * GET /api/owner/funnel. Owner-gated (same X-CyberSygn-Owner token every
 * other owner endpoint uses). Returns rows pre-shaped for the control
 * panel table: one row per canonical event in funnel order, columns
 * lifetime / last 7 days / last 30 days, plus a crawler row group for
 * crawlers that have actually been seen.
 */
export async function handleOwnerFunnel(request, env, url) {
  const owner = await getOwnerForRequest(request, env, url);
  if (!owner) return jsonResponse(401, { error: 'unauthorized' });
  try {
    const funnel = await getFunnel(env, 30);
    const rows = CANONICAL_EVENTS.map((name) => ({
      name,
      lifetime: funnel.lifetime[name] || 0,
      last7: sumDaily(funnel.daily, name, 7),
      last30: sumDaily(funnel.daily, name, 30),
    }));
    const crawlers = CRAWLERS
      .map(([slug]) => slug)
      .filter((slug) => (funnel.crawlers.lifetime[slug] || 0) > 0)
      .map((slug) => ({
        name: slug,
        lifetime: funnel.crawlers.lifetime[slug] || 0,
        last7: sumDaily(funnel.crawlers.daily, slug, 7),
        last30: sumDaily(funnel.crawlers.daily, slug, 30),
      }));
    return jsonResponse(200, { ok: true, countingSince: COUNTING_SINCE, rows, crawlers });
  } catch (e) {
    return jsonResponse(200, { ok: false, error: 'funnel_read_failed' });
  }
}
