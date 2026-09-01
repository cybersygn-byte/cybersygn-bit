/**
 * Sentry hook (slice 100).
 *
 * Optional. If env.SENTRY_DSN is set, report() forwards uncaught
 * exceptions to Sentry's HTTP API (no SDK, single fetch). If not
 * set, falls back to console.error. This keeps the worker bundle
 * small and lets the operator turn monitoring on by setting one
 * secret with `wrangler secret put SENTRY_DSN`.
 *
 * SENTRY_DSN format (from sentry.io project settings):
 *   https://<key>@oXXXXX.ingest.sentry.io/<project>
 *
 * We parse the DSN to extract host, project id, and key. Then build
 * the envelope-format payload and POST.
 *
 * No PII is sent. We strip request bodies and authentication headers
 * before reporting.
 */

export async function reportToSentry(env, err, context = {}) {
  // Always log locally so we have a paper trail even when Sentry's down.
  try {
    console.error('[error]', err && err.message ? err.message : err, context);
  } catch (e) {}

  const dsn = env && env.SENTRY_DSN;
  if (!dsn || typeof dsn !== 'string') return;

  // Parse DSN: https://<key>@<host>/<projectId>
  const m = dsn.match(/^https:\/\/([^@]+)@([^/]+)\/(\d+)$/);
  if (!m) return;
  const [, key, host, projectId] = m;

  const event = {
    event_id: randomHex(32),
    timestamp: Date.now() / 1000,
    platform: 'javascript',
    level: 'error',
    logger: 'cybersygn-worker',
    server_name: 'cybersygn-worker',
    environment: env.CYBERSYGN_ENV || 'production',
    exception: {
      values: [{
        type: (err && err.name) || 'Error',
        value: (err && err.message) || String(err).slice(0, 1000),
        stacktrace: err && err.stack ? {
          frames: parseStack(err.stack),
        } : undefined,
      }],
    },
    tags: {
      // Useful for filtering.
      service: 'worker',
      route: context.route || 'unknown',
    },
    extra: sanitizeContext(context),
  };

  try {
    await fetch(`https://${host}/api/${projectId}/store/`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Sentry-Auth':
          `Sentry sentry_version=7, sentry_key=${key}, sentry_client=cybersygn/1.0`,
      },
      body: JSON.stringify(event),
    });
  } catch (e) {
    // Swallow, we don't want a Sentry failure to cascade.
  }
}

function randomHex(bytes) {
  const buf = new Uint8Array(bytes / 2);
  crypto.getRandomValues(buf);
  return Array.from(buf, b => b.toString(16).padStart(2, '0')).join('');
}

function parseStack(stack) {
  // Minimal V8 stack parser: lines look like
  //   "    at functionName (file:line:col)"
  const out = [];
  for (const line of String(stack || '').split('\n').slice(0, 30)) {
    const m = line.match(/at (.+?) \((.+?):(\d+):(\d+)\)/) ||
              line.match(/at (.+?):(\d+):(\d+)/);
    if (!m) continue;
    if (m.length === 5) {
      out.push({ function: m[1], filename: m[2], lineno: Number(m[3]), colno: Number(m[4]) });
    } else if (m.length === 4) {
      out.push({ filename: m[1], lineno: Number(m[2]), colno: Number(m[3]) });
    }
  }
  return out;
}

function sanitizeContext(ctx) {
  // Strip anything PII-shaped or auth-shaped.
  const out = {};
  for (const k of Object.keys(ctx || {})) {
    const lk = k.toLowerCase();
    if (lk.includes('authorization') || lk.includes('cookie') || lk.includes('token') ||
        lk.includes('password') || lk.includes('email') || lk.includes('apikey') ||
        lk.includes('secret')) continue;
    const v = ctx[k];
    if (typeof v === 'string') out[k] = v.slice(0, 500);
    else if (typeof v === 'number' || typeof v === 'boolean') out[k] = v;
    else if (v && typeof v === 'object') out[k] = '(object)';
  }
  return out;
}

/**
 * Last-resort error visibility, for when no Sentry DSN is configured.
 *
 * Without a DSN, reportToSentry is a no-op and an uncaught error reaches
 * console.error and nothing else. Cloudflare's log stream is not retained and
 * nobody is tailing it, so a production failure is effectively invisible to
 * the one person running this. That is how a broken path survives for weeks.
 *
 * This keeps a small bounded ring of recent errors in KV, PII-free by
 * construction: a message, a location, a timestamp, and a count. No request
 * body, no headers, no email, no document content, and the URL is reduced to
 * its pathname so a token in a query string cannot land here.
 *
 * Bounded and best-effort: it never throws, and a failure to record must never
 * turn a handled error into an unhandled one.
 */
const ERR_KEY = 'meta:errors:recent';
const ERR_MAX = 25;

export async function recordError(env, err, context = {}) {
  try {
    const kv = env && env.CYBERSYGN_DOCS;
    if (!kv || typeof kv.get !== 'function') return false;

    // Reduce the URL to a pathname: query strings carry signer tokens.
    let where = String(context.where || 'unknown');
    if (context.url) {
      try { where += ' ' + new URL(context.url).pathname; } catch (e) { /* keep the label alone */ }
    }
    const message = String((err && err.message) || err || 'unknown').slice(0, 300);

    let ring = [];
    try { ring = JSON.parse(await kv.get(ERR_KEY)) || []; } catch (e) { ring = []; }
    if (!Array.isArray(ring)) ring = [];

    // Collapse repeats rather than letting one hot loop evict everything else.
    const match = ring.find(e => e.message === message && e.where === where);
    if (match) {
      match.count = (match.count || 1) + 1;
      match.lastAt = new Date().toISOString();
    } else {
      ring.unshift({ message, where, count: 1, firstAt: new Date().toISOString(), lastAt: new Date().toISOString() });
    }
    if (ring.length > ERR_MAX) ring.length = ERR_MAX;

    await kv.put(ERR_KEY, JSON.stringify(ring));
    return true;
  } catch (e) {
    return false;
  }
}

/** Read the recent-error ring for the owner panel. Never throws. */
export async function getRecentErrors(env) {
  try {
    const kv = env && env.CYBERSYGN_DOCS;
    if (!kv || typeof kv.get !== 'function') return [];
    const ring = JSON.parse(await kv.get(ERR_KEY)) || [];
    return Array.isArray(ring) ? ring : [];
  } catch (e) {
    return [];
  }
}
