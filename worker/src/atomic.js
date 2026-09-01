/**
 * Caller-facing helpers for the AtomicCounter Durable Object.
 *
 * Both helpers degrade deliberately, and they degrade in OPPOSITE directions,
 * because the two callers have opposite safe failure modes:
 *
 *  - atomicConsume returns null when the DO is unavailable, meaning "I could
 *    not answer". The caller falls back to the existing KV path, which may
 *    over-grant by one under a rare race. Granting one extra free document is
 *    a far better outcome than refusing a paying-adjacent user because a
 *    binding was missing.
 *
 *  - atomicClaim returns null the same way. Its only caller,
 *    claimSend in ambassador-email.js, does NOT block on that: it falls back to
 *    a narrowed KV claim, a read-then-write carrying a nonce, and re-reads to
 *    see whose nonce won. That is weaker than the DO and stronger than a bare
 *    get-then-put, and it is what the code actually does. This header used to
 *    say the caller "must treat null as DO NOT SEND", which described a
 *    contract nothing enforced: a reader trusting it would have believed a
 *    missing binding could not produce a duplicate email, when it can.
 *
 * Neither helper ever throws. Telemetry-grade reliability is not worth taking
 * the product down for.
 */

const OK = (env) => !!(env && env.ATOMIC && typeof env.ATOMIC.idFromName === 'function');

async function call(env, name, op, body) {
  if (!OK(env)) return null;
  try {
    const id = env.ATOMIC.idFromName(name);
    const stub = env.ATOMIC.get(id);
    const res = await stub.fetch(`https://atomic.internal${op}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body || {}),
    });
    if (!res || !res.ok) return null;
    return await res.json();
  } catch (e) {
    return null;
  }
}

/**
 * Atomically consume one unit against `limit`.
 * Returns { ok, used, cap } or null when the DO is unavailable.
 */
export async function atomicConsume(env, name, limit) {
  return await call(env, `consume:${name}`, '/consume', { limit });
}

/**
 * Atomically claim a one-shot token.
 * Returns { claimed: boolean } or null when the DO is unavailable.
 */
export async function atomicClaim(env, name, ttlMs) {
  return await call(env, `claim:${name}`, '/claim', { ttlMs });
}
