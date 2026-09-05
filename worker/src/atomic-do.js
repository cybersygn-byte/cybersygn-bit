/**
 * Atomic primitives, backed by a Durable Object.
 *
 * KV has no compare-and-set. Every "check then write" against it is a race:
 * two concurrent requests both read the old value, both decide they are within
 * the limit, and both write. The window is small, which is exactly why it
 * survives testing and shows up in production as an off-by-one nobody can
 * reproduce.
 *
 * Two paths in this product cannot tolerate that:
 *
 *  1. FREE-TIER CONSUME. The 3-document lifetime cap is the paywall. Two
 *     parallel sends could each read used=2, each decide they are allowed, and
 *     each write used=3, giving away a fourth document. Every extra document
 *     is real cost and a real hole in the only revenue gate the free tier has.
 *
 *  2. AT-MOST-ONCE EMAIL. The ambassador lifecycle emails claim a KV guard key
 *     before sending. A duplicate cron fire, which Cloudflare explicitly allows,
 *     could have both invocations read "not claimed" and both send. Sending an
 *     ambassador two identical payout emails is the kind of error that destroys
 *     trust in the numbers.
 *
 * A Durable Object fixes both properly: requests to one object id are handled
 * one at a time, and its storage is strongly consistent, so read-modify-write
 * is genuinely atomic. Each logical key maps to its own object, so there is no
 * shared bottleneck: contention only exists between operations that were
 * already contending for the same counter.
 *
 * SQLite-backed so it runs on every Workers plan.
 */

export class AtomicCounter {
  constructor(state) {
    this.state = state;
  }

  async fetch(request) {
    let body = {};
    try { body = await request.json(); } catch (e) { /* treated as empty below */ }
    const url = new URL(request.url);

    if (url.pathname === '/consume') return this.consume(body);
    if (url.pathname === '/rate') return this.rate(body);
    if (url.pathname === '/claim') return this.claim(body);
    if (url.pathname === '/peek') return this.peek();
    return json(400, { error: 'unknown_op' });
  }

  /**
   * Increment a counter, but only while it is strictly below `limit`.
   * Returns the value AFTER a successful increment, so the caller never has to
   * re-read (which would reintroduce the race it just paid to avoid).
   */
  async consume({ limit }) {
    const cap = Number(limit);
    if (!Number.isFinite(cap) || cap < 0) return json(400, { error: 'bad_limit' });
    const used = Number(await this.state.storage.get('used')) || 0;
    if (used >= cap) {
      return json(200, { ok: false, error: 'cap_reached', used, cap });
    }
    const next = used + 1;
    await this.state.storage.put('used', next);
    return json(200, { ok: true, used: next, cap });
  }

  /**
   * Claim a one-shot token. The FIRST caller gets claimed:true; everyone after
   * gets claimed:false, forever (or until the optional ttl passes). This is the
   * at-most-once primitive.
   */
  async claim({ ttlMs }) {
    const existing = await this.state.storage.get('claimedAt');
    const now = Date.now();
    if (existing) {
      const ttl = Number(ttlMs);
      const stillValid = !Number.isFinite(ttl) || ttl <= 0 || (now - Number(existing)) < ttl;
      if (stillValid) return json(200, { claimed: false, claimedAt: Number(existing) });
    }
    await this.state.storage.put('claimedAt', now);
    return json(200, { claimed: true, claimedAt: now });
  }

  /**
   * Fixed-window rate limiting, evaluated INSIDE the object so the whole
   * read-modify-write is serialized.
   *
   * The KV limiter this replaces did `get`, then `+1`, then `put` with no
   * compare-and-set, so N requests that arrived before any of them landed its
   * put all read the same value and all wrote the same value: the bucket
   * advanced by about one no matter how many were in flight. Measured against
   * production, 40 concurrent requests put 38 through a limit of 30.
   *
   * One object per SUBJECT, not per subject-and-window, so the number of
   * instances is bounded by the number of distinct callers rather than growing
   * with every minute that passes. Each policy keeps its own slot and rolls
   * itself over when the window id changes.
   *
   * Every policy is incremented even when another has already been exceeded,
   * matching the KV limiter's behaviour: the bucket should reflect the pressure
   * that actually arrived, not just the requests that were allowed.
   */
  async rate({ policies, nowMs }) {
    if (!Array.isArray(policies) || policies.length === 0) {
      return json(400, { error: 'bad_policies' });
    }
    const now = Number(nowMs) || Date.now();
    const nowSec = Math.floor(now / 1000);
    const hits = [];
    const exceeded = [];
    let longestSec = 0;

    for (const p of policies) {
      if (!p) continue;
      const windowSec = Math.max(1, Number(p.windowSec) | 0);
      const max = Math.max(1, Number(p.max) | 0);
      longestSec = Math.max(longestSec, windowSec);

      const slot = `w:${windowSec}`;
      const windowId = Math.floor(nowSec / windowSec);
      const rec = await this.state.storage.get(slot);
      const carried = (rec && Number(rec.windowId) === windowId) ? (Number(rec.count) || 0) : 0;
      const next = carried + 1;
      await this.state.storage.put(slot, { windowId, count: next });

      const resetSec = (windowId + 1) * windowSec - nowSec;
      hits.push({ windowSec, max, current: next, remaining: Math.max(0, max - next), resetSec });
      if (next > max) exceeded.push(resetSec);
    }

    // Drop the subject's counters once it has been quiet for two full windows,
    // so a churning population of callers (IP addresses, mostly) cannot leave
    // storage behind forever. lastSeen is what makes the alarm safe: if traffic
    // is still arriving when it fires, it reschedules instead of clearing a
    // live bucket, which would hand the caller a fresh allowance.
    await this.state.storage.put('lastSeen', now);
    try {
      await this.state.storage.setAlarm(now + longestSec * 2000 + 60000);
    } catch (e) { /* alarms are cleanup, never correctness */ }

    if (exceeded.length > 0) {
      return json(200, {
        ok: false,
        retryAfterSec: exceeded.reduce((m, v) => Math.max(m, v), 0),
        hits,
      });
    }
    return json(200, { ok: true, hits });
  }

  async alarm() {
    const lastSeen = Number(await this.state.storage.get('lastSeen')) || 0;
    const idleMs = Date.now() - lastSeen;
    // Only the rate slots, never `used` or `claimedAt`: those belong to the
    // consume/claim objects and have no expiry by design.
    const slots = await this.state.storage.list({ prefix: 'w:' });
    let longestSec = 0;
    for (const key of slots.keys()) {
      const sec = Number(String(key).slice(2)) || 0;
      longestSec = Math.max(longestSec, sec);
    }
    if (idleMs < longestSec * 2000) {
      try { await this.state.storage.setAlarm(lastSeen + longestSec * 2000 + 60000); } catch (e) {}
      return;
    }
    for (const key of slots.keys()) await this.state.storage.delete(key);
    await this.state.storage.delete('lastSeen');
  }

  async peek() {
    const used = Number(await this.state.storage.get('used')) || 0;
    const claimedAt = await this.state.storage.get('claimedAt');
    return json(200, { used, claimedAt: claimedAt ? Number(claimedAt) : null });
  }
}

function json(status, obj) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}
