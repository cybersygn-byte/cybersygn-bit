/**
 * Affiliate program.
 *
 * Solo SaaS rocket fuel. Existing customers get a unique referral URL
 * like `https://cybersygn.io/?ref=abc123` (where `abc123` is their
 * affiliateCode). The visitor's browser stores ?ref in a cookie + the
 * client passes it as Stripe checkout metadata. When the resulting
 * subscription is created, the webhook attributes the conversion.
 *
 * Payout: $20 per converted (first-paid-month) subscription. Tracked
 * in KV under affiliate:<code>:<docId> records so we never double-pay.
 *
 * Surface:
 *   POST /api/affiliate/register  → mint code for a sender (idempotent)
 *   GET  /api/affiliate/:code     → public stats (clicks, conversions)
 *   GET  /api/affiliate/me        → my dashboard (owner of the code)
 *
 * Cookie:
 *   `cybersygn_ref=<code>` for 60 days. Set by client-side script
 *   when the visitor lands on cybersygn.io/?ref=...
 *
 * Stripe attribution:
 *   The /api/checkout/create-session handler includes
 *   `metadata: {ref: <code>}` so the resulting subscription carries
 *   the referrer through every webhook payload.
 */

import { sha256Hex } from './audit.js';

const KV_PREFIX = 'affiliate:';
const PAYOUT_USD = 20;   // legacy flat bounty; tiers below supersede it
const COOKIE_DAYS = 60;
const CODE_LEN = 8;  // base36 chars; ~2.8 trillion address space

// ---- Commission ladder (docs/COMMISSION-MODEL.md is the plain-language copy)
// Bounty per qualifying sale, rising with LIFETIME sales. Milestones pay once.
// The monthly sprint repeats every calendar month.
export const TIERS = [
  { key: 'bronze', label: 'Bronze', min: 0,  bounty: 20 },
  { key: 'silver', label: 'Silver', min: 5,  bounty: 25 },
  { key: 'gold',   label: 'Gold',   min: 15, bounty: 30 },
];
export const MILESTONES = [
  { at: 1,  bonus: 10,  label: 'First sale' },
  { at: 10, bonus: 50,  label: '10 sales' },
  { at: 25, bonus: 100, label: '25 sales' },
];
export const SPRINT = { salesNeeded: 5, bonus: 50, label: '5 sales in a calendar month' };
// What the buyer gets for using an ambassador code.
export const DISCOUNT = { percentOff: 20, months: 3, label: '20% off their first 3 months' };

/** Tier for a given lifetime sales count. */
export function tierFor(conversions) {
  const n = Number(conversions) || 0;
  let t = TIERS[0];
  for (const tier of TIERS) if (n >= tier.min) t = tier;
  return t;
}

/** Resolve an ambassador code to its Stripe promotion_code id, or null. */
export async function promoIdForCode(env, code) {
  if (!isValidCode(code)) return null;
  const rec = await loadCode(env, code);
  return (rec && rec.status !== 'revoked' && rec.stripePromoId) ? rec.stripePromoId : null;
}

/**
 * Create the Stripe coupon + promotion code for an ambassador, atomically from
 * the caller's perspective: if the promotion-code call fails after the coupon
 * was created, the orphan coupon is deleted so a retry starts clean.
 */
export async function ensureStripeDiscount(env, code, knownRecord) {
  if (!isValidCode(code)) return { ok: false, error: 'invalid_code' };
  // Accept the caller's freshly-written record: KV is eventually consistent, so
  // a read immediately after registerAffiliate can miss it and would otherwise
  // fail as unknown_code, leaving the ambassador with no working discount.
  const rec = knownRecord || await loadCode(env, code);
  if (!rec) return { ok: false, error: 'unknown_code' };
  if (rec.stripePromoId) return { ok: true, promoId: rec.stripePromoId, existing: true };
  if (!env || !env.STRIPE_SECRET_KEY) return { ok: false, error: 'stripe_not_configured' };

  const { stripeFetch } = await import('./stripe.js');
  let couponId = null;
  try {
    const cBody = new URLSearchParams();
    cBody.set('percent_off', String(DISCOUNT.percentOff));
    cBody.set('duration', 'repeating');
    cBody.set('duration_in_months', String(DISCOUNT.months));
    cBody.set('name', `Ambassador ${code}`);
    cBody.set('metadata[ambassadorCode]', code);
    const coupon = await stripeFetch(env, 'POST', '/coupons', cBody);
    couponId = coupon && coupon.id;
    if (!couponId) throw new Error('no coupon id');

    const pBody = new URLSearchParams();
    pBody.set('coupon', couponId);
    pBody.set('code', code.toUpperCase());
    pBody.set('metadata[ambassadorCode]', code);
    const promo = await stripeFetch(env, 'POST', '/promotion_codes', pBody);
    if (!promo || !promo.id) throw new Error('no promo id');

    rec.stripeCouponId = couponId;
    rec.stripePromoId = promo.id;
    rec.discount = DISCOUNT.label;
    await env.CYBERSYGN_DOCS.put(`${KV_PREFIX}code:${code}`, JSON.stringify(rec));
    return { ok: true, promoId: promo.id, couponId };
  } catch (e) {
    // Orphan cleanup: a coupon with no promotion code is dead weight and would
    // block a clean retry, so delete it before surfacing the failure.
    if (couponId) {
      try { await stripeFetch(env, 'DELETE', `/coupons/${couponId}`, null); } catch (e2) {}
    }
    return { ok: false, error: 'stripe_discount_failed', detail: e && e.message };
  }
}

// ---- Code minting ---------------------------------------------------------

function randomCode() {
  // base36 8 chars from a random Uint8Array. Strong enough for non-
  // sensitive identifiers; collisions are vanishingly rare.
  const buf = new Uint8Array(8);
  crypto.getRandomValues(buf);
  let out = '';
  for (let i = 0; i < CODE_LEN; i++) {
    out += (buf[i] % 36).toString(36);
  }
  return out;
}

function isValidCode(s) {
  return typeof s === 'string' && /^[a-z0-9]{4,16}$/.test(s);
}

// ---- Registration ---------------------------------------------------------

/**
 * Register (or look up) an affiliate code for a senderId. Idempotent:
 * the same senderId always returns the same code.
 */
export async function registerAffiliate(env, { senderId, email }) {
  if (!env || !env.CYBERSYGN_DOCS) return { ok: false, error: 'kv_unavailable' };
  if (!senderId) return { ok: false, error: 'missing_sender' };

  // Map sender -> code (so a known sender returns their existing code).
  const senderKey = `${KV_PREFIX}sender:${senderId}`;
  try {
    const existing = await env.CYBERSYGN_DOCS.get(senderKey);
    if (existing) {
      const code = existing.trim();
      const rec = await loadCode(env, code);
      if (rec) return { ok: true, code, record: rec, isNew: false };
    }
  } catch (e) {}

  // Mint a fresh code with a small collision check.
  let code = randomCode();
  for (let attempt = 0; attempt < 5; attempt++) {
    const claim = await env.CYBERSYGN_DOCS.get(`${KV_PREFIX}code:${code}`);
    if (!claim) break;
    code = randomCode();
  }
  const now = new Date().toISOString();
  const record = {
    v: 1,
    code,
    senderId,
    email: typeof email === 'string' ? email.trim().slice(0, 320) : '',
    createdAt: now,
    clicks: 0,
    signups: 0,
    conversions: 0,
    earnedUsd: 0,
    payouts: [],  // [{ amount, paidAt, method }]
  };
  await env.CYBERSYGN_DOCS.put(`${KV_PREFIX}code:${code}`, JSON.stringify(record));
  await env.CYBERSYGN_DOCS.put(senderKey, code);
  return { ok: true, code, record, isNew: true };
}

async function loadCode(env, code) {
  if (!env || !env.CYBERSYGN_DOCS || !isValidCode(code)) return null;
  try {
    const raw = await env.CYBERSYGN_DOCS.get(`${KV_PREFIX}code:${code}`);
    if (!raw) return null;
    return JSON.parse(raw);
  } catch (e) { return null; }
}

// ---- Counters -------------------------------------------------------------

/**
 * Increment the click counter for an affiliate code. Public, fired
 * when a visitor lands with ?ref=<code>. Cheap KV read + write.
 */
export async function bumpClick(env, code) {
  if (!isValidCode(code)) return;
  const rec = await loadCode(env, code);
  if (!rec) return;
  rec.clicks = (rec.clicks || 0) + 1;
  rec.lastClickAt = new Date().toISOString();
  try { await env.CYBERSYGN_DOCS.put(`${KV_PREFIX}code:${code}`, JSON.stringify(rec)); } catch (e) {}
}

/**
 * Mark a signup attributed to this affiliate. Called by /api/free/signup
 * when the request carries a ref code.
 */
export async function bumpSignup(env, code) {
  if (!isValidCode(code)) return;
  const rec = await loadCode(env, code);
  if (!rec) return;
  rec.signups = (rec.signups || 0) + 1;
  rec.lastSignupAt = new Date().toISOString();
  try { await env.CYBERSYGN_DOCS.put(`${KV_PREFIX}code:${code}`, JSON.stringify(rec)); } catch (e) {}
}

/**
 * Mark a paid conversion. Called by the Stripe webhook when a subscription
 * is created with metadata.ref set. Idempotent on (code, customerId) so
 * a customer's renewals don't double-credit.
 */
export async function recordConversion(env, code, customerId, tier, buyerSenderId, buyerEmail) {
  if (!isValidCode(code)) return { ok: false, error: 'invalid_code' };
  if (!customerId) return { ok: false, error: 'missing_customer' };
  const dedupeKey = `${KV_PREFIX}conv:${code}:${customerId}`;
  try {
    const seen = await env.CYBERSYGN_DOCS.get(dedupeKey);
    if (seen) return { ok: true, alreadyCounted: true };
  } catch (e) {}
  const rec = await loadCode(env, code);
  if (!rec) return { ok: false, error: 'unknown_code' };
  // Self-referral guard: an affiliate must not earn a bounty on their own
  // purchase. $20 on a $9-$19 monthly plan is negative-margin, so a buyer
  // riding their own ?ref link is pure arbitrage. Block by matching the
  // buyer's senderId against the code owner's, and remember the block so a
  // webhook retry does not re-attempt it.
  const sameEmail = buyerEmail && rec.email &&
    String(buyerEmail).trim().toLowerCase() === String(rec.email).trim().toLowerCase();
  if (sameEmail || (buyerSenderId && rec.senderId && buyerSenderId === rec.senderId)) {
    try {
      await env.CYBERSYGN_DOCS.put(dedupeKey, JSON.stringify({ at: new Date().toISOString(), tier, blocked: 'self_referral' }), {
        expirationTtl: 60 * 60 * 24 * 365 * 5,
      });
    } catch (e) {}
    return { ok: false, error: 'self_referral_blocked' };
  }
  // Ladder: the bounty is set by the tier the ambassador is in AS OF this sale.
  rec.conversions = (rec.conversions || 0) + 1;
  const earnedTier = tierFor(rec.conversions);
  let credit = earnedTier.bounty;
  const bonuses = [];
  for (const m of MILESTONES) {
    if (rec.conversions === m.at) { credit += m.bonus; bonuses.push(m.label); }
  }
  // Monthly sprint: repeatable, tracked per calendar month.
  const monthKey = new Date().toISOString().slice(0, 7);
  rec.monthly = (rec.monthly && rec.monthly.month === monthKey)
    ? rec.monthly : { month: monthKey, sales: 0, sprintPaid: false };
  rec.monthly.sales += 1;
  if (!rec.monthly.sprintPaid && rec.monthly.sales >= SPRINT.salesNeeded) {
    credit += SPRINT.bonus;
    rec.monthly.sprintPaid = true;
    bonuses.push(SPRINT.label);
  }
  rec.earnedUsd = (rec.earnedUsd || 0) + credit;
  rec.tier = earnedTier.key;
  rec.lastConversionAt = new Date().toISOString();
  try {
    await env.CYBERSYGN_DOCS.put(`${KV_PREFIX}code:${code}`, JSON.stringify(rec));
    await env.CYBERSYGN_DOCS.put(dedupeKey, JSON.stringify({ at: new Date().toISOString(), tier }), {
      expirationTtl: 60 * 60 * 24 * 365 * 5,
    });
  } catch (e) {}
  return { ok: true, alreadyCounted: false, payoutUsd: credit, tier: earnedTier.key, bonuses };
}

/**
 * Reverse a previously-credited conversion (refund, dispute, chargeback). Backs
 * out the $20 and the conversion count from the affiliate's code record and
 * marks the per-customer conversion record so it is never re-credited or
 * double-reversed. Idempotent and best-effort.
 */
export async function reverseConversion(env, code, customerId, reason) {
  if (!isValidCode(code) || !customerId) return { ok: false, error: 'bad_args' };
  const dedupeKey = `${KV_PREFIX}conv:${code}:${customerId}`;
  try {
    const raw = await env.CYBERSYGN_DOCS.get(dedupeKey);
    if (!raw) return { ok: true, nothingToReverse: true };
    let conv;
    try { conv = JSON.parse(raw); } catch (e) { conv = {}; }
    if (conv.reversed || conv.blocked) return { ok: true, alreadyHandled: true };
    const rec = await loadCode(env, code);
    if (rec) {
      rec.conversions = Math.max(0, (rec.conversions || 0) - 1);
      rec.earnedUsd = Math.max(0, (rec.earnedUsd || 0) - PAYOUT_USD);
      rec.reversals = (rec.reversals || 0) + 1;
      await env.CYBERSYGN_DOCS.put(`${KV_PREFIX}code:${code}`, JSON.stringify(rec));
    }
    conv.reversed = reason || 'reversed';
    conv.reversedAt = new Date().toISOString();
    await env.CYBERSYGN_DOCS.put(dedupeKey, JSON.stringify(conv), { expirationTtl: 60 * 60 * 24 * 365 * 5 });
    return { ok: true, reversed: true, clawedBackUsd: PAYOUT_USD };
  } catch (e) {
    return { ok: false, error: 'reverse_failed' };
  }
}

// ---- Public read endpoints ------------------------------------------------

export async function getCodeStats(env, code) {
  const rec = await loadCode(env, code);
  if (!rec) return { ok: false, error: 'not_found' };
  return {
    ok: true,
    code: rec.code,
    clicks: rec.clicks || 0,
    signups: rec.signups || 0,
    conversions: rec.conversions || 0,
    earnedUsd: rec.earnedUsd || 0,
    createdAt: rec.createdAt,
  };
}

export const __forTests = {
  randomCode,
  isValidCode,
  PAYOUT_USD,
  COOKIE_DAYS,
  KV_PREFIX,
};
