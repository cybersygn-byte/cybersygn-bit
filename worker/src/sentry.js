/**
 * Sentry hook (slice 100).
 *
 * Optional. If env.SENTRY_DSN is set, report() forwards uncaught
 * exceptions to Sentry's HTTP API (no SDK — single fetch). If not
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
    // Swallow — we don't want a Sentry failure to cascade.
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
