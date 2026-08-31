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
