/**
 * Simple KV-backed rate limiter.
 *
 * Approach: bucket-per-window. For a given (key, windowSeconds) we
 * increment a counter at `ratelimit:<key>:<window-id>` where window-id
 * is floor(now/window). The counter has a TTL slightly longer than
 * the window so it auto-clears.
 *
 * Two windows can be stacked (per-IP daily AND per-IP weekly) so a
 * burst-tolerant policy is expressible: "allow N per hour, M per day."
 *
 * Failure mode: FAIL CLOSED. This limiter guards owner login and
 * magic-link sends, so a counter it cannot read OR cannot write is
 * treated as "at the ceiling". The burst big enough to break KV is
 * exactly the burst that must not be waved through.
 *
 * Owner bypass: if the request carries a valid owner token, the
 * limiter short-circuits to { ok: true, owner: true }. Owner-bypass
 * happens at the caller; this module doesn't know about owners.
 *
 * Public API:
 *   await checkRateLimit(env, key, [{ windowSec, max }, ...])
 *     → { ok, retryAfterSec, hits, headers }
 *
 * Use the returned headers when building a 429 response so the client
 * sees `Retry-After` and `RateLimit-*` semantically.
 */

const PREFIX = 'ratelimit:';

/* Counter of last resort, used only when no KV namespace is bound.
   wrangler.jsonc declares CYBERSYGN_DOCS with a real namespace id, so the
   unbound case is local dev and the node harness, never production. Counting
   in-process is weaker than KV (it is per-isolate), but the choice there is
   between a limiter and no limiter at all: the old branch returned ok:true
   unconditionally, so anything running without a binding had no ceiling. A
   blanket 429 would instead brick every dev box and the test suite, which is
   an outage we would be inventing rather than preventing. */
const memoryBuckets = new Map();
const MEMORY_MAX_KEYS = 5000;
let warnedUnbound = false;

function pruneMemoryBuckets() {
  const now = Date.now();
  for (const [k, e] of memoryBuckets) {
    if (e.expiresAtMs <= now) memoryBuckets.delete(k);
  }
  // Map preserves insertion order, so dropping from the front evicts the
  // oldest buckets if pruning expired entries did not free enough room.
  while (memoryBuckets.size >= MEMORY_MAX_KEYS) {
    const oldest = memoryBuckets.keys().next();
    if (oldest.done) break;
    memoryBuckets.delete(oldest.value);
  }
}

const memoryStore = {
  async get(key) {
    const e = memoryBuckets.get(key);
    if (!e) return null;
    if (e.expiresAtMs <= Date.now()) { memoryBuckets.delete(key); return null; }
    return e.value;
  },
  async put(key, value, opts = {}) {
    if (memoryBuckets.size >= MEMORY_MAX_KEYS) pruneMemoryBuckets();
    const ttl = Number(opts.expirationTtl) || 60;
    memoryBuckets.set(key, { value, expiresAtMs: Date.now() + ttl * 1000 });
  },
};

/**
 * Compute the rate-limit verdict for a given subject key against one
 * or more time windows. Returns the verdict + headers to set on the
 * response.
 */
export async function checkRateLimit(env, key, policies) {
  let store = env && env.CYBERSYGN_DOCS;
  if (!store) {
    // Once per isolate. The binding is either there or it is not, so one line
    // says everything and a per-request warning would bury the tail. Log only
    // the limiter family (the part before the subject), never the full key:
    // keys embed the client IP or an email hash, which must not land in logs.
    if (!warnedUnbound) {
      warnedUnbound = true;
      console.warn('[rate-limit] KV unbound, counting in-process', String(key || '').split(':')[0] || 'unknown');
    }
    store = memoryStore;
  }
  if (!Array.isArray(policies) || policies.length === 0) {
    return { ok: true, hits: [], headers: {} };
  }

  const now = Math.floor(Date.now() / 1000);
  const hits = [];
  const verdicts = [];

  for (const policy of policies) {
    // A null entry is a caller bug, not a policy. Reading .windowSec off it
    // threw straight out of the limiter, which the callers turn into a 500.
    if (!policy) continue;
    const windowSec = Math.max(1, Number(policy.windowSec) | 0);
    const max = Math.max(1, Number(policy.max) | 0);
    const windowId = Math.floor(now / windowSec);
    const resetSec = (windowId + 1) * windowSec - now;
    const bucketKey = `${PREFIX}${key}:${windowSec}:${windowId}`;
    let raw = null;
    try {
      raw = await store.get(bucketKey);
    } catch (e) {
      /* FAIL CLOSED. This limiter guards magic-link requests and owner login;
         a limiter that cannot read its own counter must not hand out unlimited
         attempts. The old `continue` skipped the policy, which allowed the
         request, so the abuse burst that broke KV was also the burst that
         defeated the limiter. Treat an unreadable counter as "at the ceiling". */
      console.warn('[rate-limit] kv get failed, failing closed', e && e.message);
      hits.push({ windowSec, max, current: max, remaining: 0, resetSec: windowSec });
      verdicts.push({ exceeded: true, retryAfterSec: windowSec });
      continue;
    }
    const current = (Number.isFinite(parseInt(raw, 10)) ? parseInt(raw, 10) : 0);
    const next = current + 1;

    // Always write back, even if the policy was exceeded, so the bucket
    // accurately reflects pressure for the next sibling check.
    try {
      // TTL ~2x window so a stale bucket can't accidentally allow a
      // burst into the next window.
      await store.put(bucketKey, String(next), { expirationTtl: windowSec * 2 + 5 });
    } catch (e) {
      /* Same fail-closed rule as the read above. A counter that cannot be
         incremented never advances, so every subsequent request re-reads the
         same value and the ceiling is never reached: reads succeeding while
         writes fail was the shape that still handed out unlimited attempts. */
      console.warn('[rate-limit] kv put failed, failing closed', e && e.message);
      hits.push({ windowSec, max, current: next, remaining: 0, resetSec });
      verdicts.push({ exceeded: true, retryAfterSec: resetSec });
      continue;
    }

    const remaining = Math.max(0, max - next);
    hits.push({ windowSec, max, current: next, remaining, resetSec });
    verdicts.push({ exceeded: next > max, retryAfterSec: resetSec });
  }

  // If any policy is exceeded, the verdict is reject. Take the LONGEST
  // retry-after (the most restrictive window) so we don't suggest an
  // immediate retry that will hit another locked window.
  const exceeded = verdicts.filter(v => v.exceeded);
  if (exceeded.length > 0) {
    const retryAfterSec = exceeded.reduce((m, v) => Math.max(m, v.retryAfterSec), 0);
    // Surface the tightest remaining across all hits, the standard
    // semantics for RateLimit-Remaining.
    const tightest = hits.reduce((m, h) => Math.min(m, h.remaining), Infinity);
    return {
      ok: false,
      retryAfterSec,
      hits,
      headers: {
        'Retry-After': String(retryAfterSec),
        'RateLimit-Limit': String(hits[0].max),
        'RateLimit-Remaining': String(Number.isFinite(tightest) ? tightest : 0),
        'RateLimit-Reset': String(retryAfterSec),
      },
    };
  }

  // Allowed. Set RateLimit-* headers for client visibility.
  const tightest = hits.reduce((acc, h) =>
    (h.remaining < acc.remaining ? h : acc), hits[0] || { remaining: Infinity, max: 0, resetSec: 0 });
  return {
    ok: true,
    hits,
    headers: hits.length > 0 ? {
      'RateLimit-Limit': String(tightest.max),
      'RateLimit-Remaining': String(tightest.remaining),
      'RateLimit-Reset': String(tightest.resetSec),
    } : {},
  };
}

/**
 * Build a stable per-IP key for rate limiting. Trims to 64 bytes and
 * sanitizes so it fits cleanly in a KV key. Use this for any IP-based
 * limiter so the key shape is consistent across endpoints.
 */
export function ipKey(request) {
  const ip = (request && request.headers && request.headers.get('cf-connecting-ip'))
          || (request && request.headers && request.headers.get('x-forwarded-for'))
          || 'unknown';
  // Strip non-printable + cap length.
  return String(ip).replace(/[^a-zA-Z0-9._:-]/g, '').slice(0, 64);
}

/**
 * Return a 429 Response with the headers from a rate-limit verdict.
 * Caller passes in the limiter result so the headers stay consistent.
 */
export function rateLimitedResponse(verdict, { endpoint }) {
  const body = {
    error: 'rate_limited',
    message: `Too many requests${endpoint ? ` to ${endpoint}` : ''}. Try again in ${verdict.retryAfterSec} seconds.`,
    retryAfterSec: verdict.retryAfterSec,
  };
  return new Response(JSON.stringify(body), {
    status: 429,
    headers: {
      'content-type': 'application/json',
      ...verdict.headers,
    },
  });
}
