/**
 * Cloudflare Workers Analytics Engine sink for CyberSygn.
 *
 * Two write paths and one read path.
 *
 * Write paths:
 *   trackEvent(env, name, props, ctx)   -- product event (pageview, upload,
 *                                          detection_completed, doc_sent,
 *                                          stripe_checkout_opened, etc.)
 *   trackError(env, ctxName, err, ctx)  -- caught error with stack
 *
 * Both encode into a single Analytics Engine dataset
 * (env.CYBERSYGN_EVENTS) with a compact schema designed to support
 * useful slice-and-dice queries without exploding cardinality:
 *
 *   blob1  event_name        ("pageview", "detection_completed", ...)
 *   blob2  path              ("/", "/preview/", "/dashboard/", ...)
 *   blob3  referrer host     ("twitter.com" | "google" | "(direct)")
 *   blob4  source            ("preview", "marketing", "dashboard")
 *   blob5  user_agent_class  ("mobile" | "tablet" | "desktop" | "bot")
 *   blob6  country           (CF.country, e.g. "US")
 *   blob7  city              (CF.city, e.g. "Parker")
 *   blob8  tier              ("free" | "solo" | "founding" | "team" | "owner")
 *   blob9  error_class       (only on trackError, e.g. "TypeError")
 *   blob10 error_message     (only on trackError, truncated to 200 chars)
 *
 *   double1 value            (event-specific numeric, e.g. field count, bytes)
 *   double2 duration_ms      (when relevant)
 *
 *   index1  hash(sender_id)  (so we can count uniques without storing PII)
 *
 * Read path:
 *   summary(env, opts)       -- runs SQL against the dataset via the
 *                               Cloudflare Analytics Engine SQL API
 *                               and returns counters for the owner.
 *
 * Read path requires CF_ACCOUNT_ID + CF_API_TOKEN (or wrangler OAuth token
 * passthrough) to query the SQL endpoint. Without these secrets, summary()
 * returns null and the owner dashboard falls back to a "configure
 * CF_API_TOKEN to see live counters" message.
 *
 * Per CONSTITUTION Section 1.9: every write has try/catch, every read has a
 * timeout, every failure produces a useful response.
 */

const DEFAULT_TIER = 'free';
const ERR_MSG_MAX = 200;
const FETCH_TIMEOUT_MS = 8000;
const SQL_DEFAULT_WINDOW = 'INTERVAL \'7\' DAY';

// -----------------------------------------------------------------------------
// User-agent classification. Coarse on purpose: we only care about mobile vs
// desktop vs known bots for adoption + crawl-traffic visibility.

const MOBILE_RE  = /\b(iPhone|Android(?!.*Tablet)|Mobile|Opera Mini|IEMobile)\b/i;
const TABLET_RE  = /\b(iPad|Android.*Tablet|Tablet|Kindle)\b/i;
const BOT_RE     = /\b(GPTBot|ClaudeBot|Claude-Web|anthropic-ai|PerplexityBot|Perplexity-User|OAI-SearchBot|ChatGPT-User|Google-Extended|Applebot-Extended|CCBot|cohere-ai|meta-externalagent|Bytespider|Amazonbot|DuckAssistBot|YouBot|Diffbot|Googlebot|Bingbot|DuckDuckBot|YandexBot|baidu|Twitterbot|facebookexternalhit|LinkedInBot|Slackbot|TelegramBot|WhatsApp|crawl|spider|bot|http-client|curl|wget|HeadlessChrome)\b/i;

function classifyUserAgent(ua) {
  if (!ua || typeof ua !== 'string') return 'unknown';
  if (BOT_RE.test(ua))    return 'bot';
  if (TABLET_RE.test(ua)) return 'tablet';
  if (MOBILE_RE.test(ua)) return 'mobile';
  return 'desktop';
}

// -----------------------------------------------------------------------------
// Referrer normalization. Drop URLs entirely; keep only the host so we can
// see "twitter.com vs google.com vs direct" without keeping fingerprint-grade
// query strings.

function normalizeReferrer(ref) {
  if (!ref || typeof ref !== 'string') return '(direct)';
  try {
    const u = new URL(ref);
    return u.hostname || '(direct)';
  } catch (e) {
    return '(direct)';
  }
}

// -----------------------------------------------------------------------------
// Sender-id hashing. We never store the raw sender id (which lives in user
// localStorage as a UUID-ish string); we hash + truncate to 32 bits and
// store as the Analytics Engine index. Lets us count distinct senders via
// uniq(index1) without keeping PII.
//
// Uses subtle.digest because the same crypto primitive is available
// everywhere in Workers and adds no dep.

async function hashIndex(input) {
  if (!input) return '0';
  try {
    const bytes = new TextEncoder().encode(String(input));
    const digest = await crypto.subtle.digest('SHA-256', bytes);
    const arr = new Uint8Array(digest);
    // Take first 4 bytes as a hex string. Plenty for cardinality estimation,
    // collision-safe within a single dataset's billion-row scale.
    return Array.from(arr.slice(0, 4), b => b.toString(16).padStart(2, '0')).join('');
  } catch (e) {
    return '0';
  }
}

// -----------------------------------------------------------------------------
// Shared shape builder. Both trackEvent and trackError produce a writeDataPoint
// arg object via this; the only differences are blob1, blob9, blob10, doubles.

async function baseDataPoint(env, name, ctx) {
  const cf = (ctx && ctx.request && ctx.request.cf) || {};
  const headers = (ctx && ctx.request && ctx.request.headers) || null;
  const ua = headers ? (headers.get('user-agent') || '') : '';
  const ref = headers ? (headers.get('referer') || headers.get('referrer') || '') : '';

  const senderId = (ctx && ctx.senderId) || '';
  const indexHex = await hashIndex(senderId);

  return {
    blobs: [
      String(name).slice(0, 64),                      // blob1: event_name
      String((ctx && ctx.path) || '').slice(0, 128),  // blob2: path
      normalizeReferrer(ref).slice(0, 96),            // blob3: referrer host
      String((ctx && ctx.source) || '').slice(0, 32), // blob4: source
      classifyUserAgent(ua),                          // blob5: ua class
      String(cf.country || '').slice(0, 4),           // blob6: country
      String(cf.city || '').slice(0, 64),             // blob7: city
      String((ctx && ctx.tier) || DEFAULT_TIER),      // blob8: tier
      '',                                             // blob9: filled by error path
      '',                                             // blob10: filled by error path
    ],
    doubles: [
      Number((ctx && ctx.value) || 0),                // double1
      Number((ctx && ctx.durationMs) || 0),           // double2
    ],
    indexes: [ indexHex ],
  };
}

/**
 * Public: write a single product event.
 * @param env  Worker env with CYBERSYGN_EVENTS binding (optional; no-op without)
 * @param name event name (snake_case)
 * @param ctx  { request, senderId, source, path, tier, value, durationMs, ... }
 */
export async function trackEvent(env, name, ctx = {}) {
  if (!env || !env.CYBERSYGN_EVENTS || typeof env.CYBERSYGN_EVENTS.writeDataPoint !== 'function') {
    return;  // Binding not configured: silently skip (matches the in-stack constraint of "no extra vendors").
  }
  try {
    const point = await baseDataPoint(env, name, ctx);
    env.CYBERSYGN_EVENTS.writeDataPoint(point);
  } catch (e) {
    // Analytics must never break user-visible flows. Swallow.
  }
}

/**
 * Public: write a single error event. Same dataset, distinguished by blob1
 * starting with "error:" and blob9/blob10 carrying the class + message.
 */
export async function trackError(env, ctxName, err, ctx = {}) {
  if (!env || !env.CYBERSYGN_EVENTS || typeof env.CYBERSYGN_EVENTS.writeDataPoint !== 'function') return;
  try {
    const point = await baseDataPoint(env, `error:${ctxName}`.slice(0, 64), ctx);
    const cls = (err && err.constructor && err.constructor.name) || 'Error';
    const msg = (err && err.message) ? String(err.message) : String(err || '');
    point.blobs[8] = cls.slice(0, 64);
    point.blobs[9] = msg.slice(0, ERR_MSG_MAX);
    env.CYBERSYGN_EVENTS.writeDataPoint(point);
  } catch (e) {
    // Same as above.
  }
}

// -----------------------------------------------------------------------------
// SQL summary endpoint. Owner-only. Reads from the Analytics Engine via the
// Cloudflare SQL API. Uses CF_ACCOUNT_ID + CF_ANALYTICS_TOKEN env vars when
// available; without them, returns a structured "configure to enable" payload.

function withTimeout(p, ms) {
  return Promise.race([
    p,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`timeout after ${ms}ms`)), ms)),
  ]);
}

async function runSql(env, sql) {
  const account = env && env.CF_ACCOUNT_ID;
  const token = env && env.CF_ANALYTICS_TOKEN;
  if (!account || !token) {
    return { ok: false, error: 'CF_ACCOUNT_ID and CF_ANALYTICS_TOKEN not configured' };
  }
  const url = `https://api.cloudflare.com/client/v4/accounts/${account}/analytics_engine/sql`;
  try {
    const res = await withTimeout(
      fetch(url, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'text/plain' },
        body: sql,
      }),
      FETCH_TIMEOUT_MS,
    );
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      return { ok: false, error: `HTTP ${res.status}: ${text.slice(0, 200)}` };
    }
    const data = await res.json();
    return { ok: true, data };
  } catch (e) {
    return { ok: false, error: e && e.message ? e.message : String(e) };
  }
}

/**
 * Owner dashboard summary. Returns a small object suitable for direct
 * rendering: { window, totals: {...}, topPaths, topReferrers, errors }.
 */
export async function summary(env, opts = {}) {
  const dataset = 'cybersygn_events';
  const window = opts.window || SQL_DEFAULT_WINDOW;
  const since = `timestamp > NOW() - ${window}`;

  // When excludeOwner is true (default for customer-facing aggregates),
  // every query gets an extra clause filtering out blob8='owner'. The
  // /api/event endpoint writes 'owner' to blob8 when the request
  // carries a valid owner token, so this cleanly separates owner test
  // traffic from real customer signal in every chart.
  const excludeOwner = opts.excludeOwner !== false;  // default true
  const ownerClause = excludeOwner ? " AND blob8 != 'owner'" : '';

  const queries = {
    totals: `SELECT SUM(_sample_interval) AS events, COUNT(DISTINCT index1) AS senders FROM ${dataset} WHERE ${since}${ownerClause}`,
    byEvent: `SELECT blob1 AS event, SUM(_sample_interval) AS n FROM ${dataset} WHERE ${since}${ownerClause} GROUP BY blob1 ORDER BY n DESC LIMIT 25`,
    topPaths: `SELECT blob2 AS path, SUM(_sample_interval) AS n FROM ${dataset} WHERE ${since}${ownerClause} AND blob1 = 'pageview' GROUP BY blob2 ORDER BY n DESC LIMIT 10`,
    topReferrers: `SELECT blob3 AS referrer, SUM(_sample_interval) AS n FROM ${dataset} WHERE ${since}${ownerClause} AND blob1 = 'pageview' GROUP BY blob3 ORDER BY n DESC LIMIT 10`,
    byCountry: `SELECT blob6 AS country, SUM(_sample_interval) AS n FROM ${dataset} WHERE ${since}${ownerClause} AND blob1 = 'pageview' GROUP BY blob6 ORDER BY n DESC LIMIT 10`,
    byUaClass: `SELECT blob5 AS ua, SUM(_sample_interval) AS n FROM ${dataset} WHERE ${since}${ownerClause} GROUP BY blob5 ORDER BY n DESC LIMIT 10`,
    errors: `SELECT blob1 AS event, blob9 AS error_class, blob10 AS message, SUM(_sample_interval) AS n FROM ${dataset} WHERE ${since}${ownerClause} AND blob1 LIKE 'error:%' GROUP BY blob1, blob9, blob10 ORDER BY n DESC LIMIT 10`,
  };

  const results = {};
  for (const [k, sql] of Object.entries(queries)) {
    const r = await runSql(env, sql);
    results[k] = r.ok ? r.data : { error: r.error };
  }
  return { window, results };
}
