/**
 * Ambassador program: identity, product pass, learning progress, payouts.
 *
 * IDENTITY. An ambassador is identified by the emailHash the existing
 * magic-link auth already computes (auth.js), never by a device-local
 * senderId. That way a laptop-to-phone switch cannot orphan someone's
 * earnings, and there is exactly ONE auth system in the product: the
 * magic link. The ambassador record hangs off the affiliate code record
 * that affiliate.js already owns; this module adds the parts that make it
 * a real program rather than a counter.
 *
 * PRODUCT PASS. Ambassadors get the full product free while active. The
 * pass is a 90-day window that RENEWS on any real signal of life: opening
 * the dashboard, a click on their referral link, or a sale. So it cannot
 * lapse mid-program while someone is participating. It ends only after 90
 * days of total silence, or immediately on revoke. A lapsed ambassador
 * keeps their code, history, and earned commission; they just stop getting
 * the product for free.
 *
 * KV layout (CYBERSYGN_DOCS):
 *   affiliate:code:<code>        the ambassador record (affiliate.js owns writes)
 *   affiliate:sender:<senderId>  senderId -> code
 *   affiliate:email:<emailHash>  emailHash -> code   (identity that survives devices)
 */

const KV = 'affiliate:';
const PASS_DAYS = 90;

/** Days -> ms. */
const DAY_MS = 24 * 60 * 60 * 1000;

function codeKey(code) { return `${KV}code:${code}`; }

async function readCode(env, code) {
  if (!env || !env.CYBERSYGN_DOCS || !/^[a-z0-9]{4,16}$/.test(String(code || ''))) return null;
  try {
    const raw = await env.CYBERSYGN_DOCS.get(codeKey(code));
    return raw ? JSON.parse(raw) : null;
  } catch (e) { return null; }
}

async function writeCode(env, rec) {
  try { await env.CYBERSYGN_DOCS.put(codeKey(rec.code), JSON.stringify(rec)); return true; }
  catch (e) { return false; }
}

/** Resolve an ambassador record from an emailHash, else null. */
export async function ambassadorByEmailHash(env, emailHash) {
  if (!env || !env.CYBERSYGN_DOCS || !emailHash) return null;
  try {
    const code = await env.CYBERSYGN_DOCS.get(`${KV}email:${emailHash}`);
    return code ? await readCode(env, code.trim()) : null;
  } catch (e) { return null; }
}

/** Resolve from a senderId (the legacy path), else null. */
export async function ambassadorBySender(env, senderId) {
  if (!env || !env.CYBERSYGN_DOCS || !senderId) return null;
  try {
    const code = await env.CYBERSYGN_DOCS.get(`${KV}sender:${senderId}`);
    return code ? await readCode(env, code.trim()) : null;
  } catch (e) { return null; }
}

/**
 * Bind an emailHash to an existing ambassador code so identity survives a
 * device change. First-bind-wins, mirroring auth.js's own binding rule.
 */
export async function bindAmbassadorEmail(env, code, emailHash, email) {
  if (!env || !env.CYBERSYGN_DOCS || !emailHash) return { ok: false, error: 'missing_email' };
  const rec = await readCode(env, code);
  if (!rec) return { ok: false, error: 'unknown_code' };
  const key = `${KV}email:${emailHash}`;
  try {
    const existing = await env.CYBERSYGN_DOCS.get(key);
    if (existing && existing.trim() !== code) {
      return { ok: false, error: 'email_bound_elsewhere' };
    }
    await env.CYBERSYGN_DOCS.put(key, code);
  } catch (e) { return { ok: false, error: 'kv_write_failed' }; }
  rec.emailHash = emailHash;
  if (email && !rec.email) rec.email = String(email).trim().slice(0, 320);
  await writeCode(env, rec);
  return { ok: true, code };
}

// ---- Product pass ---------------------------------------------------------

/** Is the pass currently active? Revoked always wins. */
export function passActive(rec) {
  if (!rec || rec.status === 'revoked') return false;
  const until = rec.passUntil ? Date.parse(rec.passUntil) : 0;
  return Number.isFinite(until) && until > Date.now();
}

/**
 * Renew the pass to a fresh window. Called on any real signal of life so the
 * pass never lapses mid-program: dashboard open, referral click, or a sale.
 * Returns the record (mutated), caller persists.
 */
export function renewPass(rec, reason) {
  if (!rec || rec.status === 'revoked') return rec;
  rec.passUntil = new Date(Date.now() + PASS_DAYS * DAY_MS).toISOString();
  rec.passRenewedAt = new Date().toISOString();
  rec.passReason = reason || 'activity';
  return rec;
}

/** Renew + persist in one call. Best-effort, never throws into a request. */
export async function touchPass(env, rec, reason) {
  try {
    if (!rec || rec.status === 'revoked') return rec;
    renewPass(rec, reason);
    await writeCode(env, rec);
  } catch (e) { /* pass renewal is never load-bearing */ }
  return rec;
}

// ---- Learning progress ----------------------------------------------------

/** Mark a learning module complete on the ambassador record (cross-device). */
export async function markLearnDone(env, rec, moduleId) {
  if (!rec) return { ok: false, error: 'unknown_ambassador' };
  const id = String(moduleId || '').replace(/[^a-z0-9_-]/g, '').slice(0, 40);
  if (!id) return { ok: false, error: 'invalid_module' };
  rec.learn = rec.learn && typeof rec.learn === 'object' ? rec.learn : {};
  rec.learn[id] = new Date().toISOString();
  await writeCode(env, rec);
  return { ok: true, learn: rec.learn };
}

// ---- Revoke ---------------------------------------------------------------

/**
 * Revoke an ambassador: kill the Stripe promotion code so the discount stops
 * working, end the product pass, and mark the record. History and earned
 * commission are KEPT (they may still be owed money).
 */
export async function revokeAmbassador(env, code, reason) {
  const rec = await readCode(env, code);
  if (!rec) return { ok: false, error: 'unknown_code' };
  // Deactivate the Stripe promotion code (Stripe has no delete for promos).
  if (rec.stripePromoId && env && env.STRIPE_SECRET_KEY) {
    try {
      const { stripeFetch } = await import('./stripe.js');
      const body = new URLSearchParams();
      body.set('active', 'false');
      await stripeFetch(env, 'POST', `/promotion_codes/${rec.stripePromoId}`, body);
    } catch (e) {
      console.error('[ambassador] promo deactivate failed:', e && e.message);
    }
  }
  rec.status = 'revoked';
  rec.revokedAt = new Date().toISOString();
  rec.revokeReason = String(reason || '').slice(0, 200);
  rec.passUntil = null;
  await writeCode(env, rec);
  return { ok: true, code, revokedAt: rec.revokedAt };
}

// ---- Payout state ---------------------------------------------------------

/**
 * Owed = earned minus everything already recorded as paid. Payouts are manual
 * today (owner records them), so this is the single source of truth for
 * liability and for what an ambassador is told they are owed.
 */
export function payoutState(rec) {
  const earned = Number(rec && rec.earnedUsd) || 0;
  const paid = ((rec && rec.payouts) || []).reduce((s, p) => s + (Number(p.amount) || 0), 0);
  const owed = Math.max(0, earned - paid);
  const year = new Date().getUTCFullYear();
  const earnedThisYear = ((rec && rec.ledger) || [])
    .filter(e => String(e.at || '').startsWith(String(year)))
    .reduce((s, e) => s + (Number(e.amount) || 0), 0);
  return {
    earnedAllTimeUsd: earned,
    paidUsd: paid,
    owedUsd: owed,
    earnedThisYearUsd: earnedThisYear || (paid === 0 ? earned : 0),
    // W-9 is only collected past the IRS reporting threshold for the year.
    w9Required: (earnedThisYear || earned) >= 600,
    w9State: (rec && rec.w9State) || 'not_required',
  };
}

/** Record a manual payout (owner action). */
export async function recordPayout(env, code, { amount, method, note }) {
  const rec = await readCode(env, code);
  if (!rec) return { ok: false, error: 'unknown_code' };
  const amt = Number(amount);
  if (!Number.isFinite(amt) || amt <= 0) return { ok: false, error: 'invalid_amount' };
  rec.payouts = Array.isArray(rec.payouts) ? rec.payouts : [];
  rec.payouts.push({
    amount: Math.round(amt * 100) / 100,
    paidAt: new Date().toISOString(),
    method: String(method || 'manual').slice(0, 40),
    note: String(note || '').slice(0, 200),
  });
  await writeCode(env, rec);
  return { ok: true, state: payoutState(rec) };
}
