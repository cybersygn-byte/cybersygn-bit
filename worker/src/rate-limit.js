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
 * Failure mode: if KV is unreachable, we ALLOW the request. Better to
 * serve a real user than to fail-closed on infrastructure flakiness.
 * Logged so we can see it in tail.
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

/**
 * Compute the rate-limit verdict for a given subject key against one
 * or more time windows. Returns the verdict + headers to set on the
 * response.
 */
export async function checkRateLimit(env, key, policies) {
  if (!env || !env.CYBERSYGN_DOCS) {
    // No KV bound — fail-open. We log so the owner can spot it.
    console.warn('[rate-limit] KV unbound, allowing', key);
    return { ok: true, hits: [], headers: {} };
  }
  if (!Array.isArray(policies) || policies.length === 0) {
    return { ok: true, hits: [], headers: {} };
  }

  const now = Math.floor(Date.now() / 1000);
  const hits = [];
  const verdicts = [];

  for (const policy of policies) {
    const windowSec = Math.max(1, Number(policy.windowSec) | 0);
    const max = Math.max(1, Number(policy.max) | 0);
    const windowId = Math.floor(now / windowSec);
    const bucketKey = `${PREFIX}${key}:${windowSec}:${windowId}`;
    let raw = null;
    try {
      raw = await env.CYBERSYGN_DOCS.get(bucketKey);
    } catch (e) {
      // Fail-open on read errors.
      console.warn('[rate-limit] kv get failed', e && e.message);
      continue;
    }
    const current = (Number.isFinite(parseInt(raw, 10)) ? parseInt(raw, 10) : 0);
    const next = current + 1;

    // Always write back, even if the policy was exceeded, so the bucket
    // accurately reflects pressure for the next sibling check.
    try {
      // TTL ~2x window so a stale bucket can't accidentally allow a
      // burst into the next window.
      await env.CYBERSYGN_DOCS.put(bucketKey, String(next), { expirationTtl: windowSec * 2 + 5 });
    } catch (e) {
      console.warn('[rate-limit] kv put failed', e && e.message);
    }

    const remaining = Math.max(0, max - next);
    const resetSec = (windowId + 1) * windowSec - now;
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
