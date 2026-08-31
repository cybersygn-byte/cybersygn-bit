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
import { PAYOUT_TERMS } from './ambassador.js';

const KV_PREFIX = 'affiliate:';
const PAYOUT_USD = 20;   // legacy flat bounty; tiers below supersede it
// Attribution window. Read from the one canonical terms object so the number
// we publish and the cookie we actually set can never drift apart.
const COOKIE_DAYS = PAYOUT_TERMS.cookieWindowDays;
const HOLD_DAYS = PAYOUT_TERMS.holdDays;
const DAY_MS = 24 * 60 * 60 * 1000;
// Ledger cap. Entries beyond this are folded into a scalar rather than dropped,
// because every money figure is derived from this array and silently deleting
// the oldest 200th entry corrupts the total the moment the program works.
const LEDGER_MAX = 2000;

function ledgerId() {
  try {
    if (typeof crypto !== 'undefined' && crypto.randomUUID) return `led_${crypto.randomUUID()}`;
  } catch (e) {}
  return `led_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * Append ledger entries and keep the array bounded WITHOUT losing money.
 * Anything trimmed is added to rec.ledgerArchivedUsd, so a derived sum over
 * (ledger + archived) still equals rec.earnedUsd.
 */
function pushLedger(rec, entries) {
  rec.ledger = Array.isArray(rec.ledger) ? rec.ledger : [];
  for (const e of entries) rec.ledger.push(e);
  if (rec.ledger.length > LEDGER_MAX) {
    const drop = rec.ledger.splice(0, rec.ledger.length - LEDGER_MAX);
    const dropped = drop.reduce((s, e) => s + (Number(e.amount) || 0), 0);
    rec.ledgerArchivedUsd = Math.round(((Number(rec.ledgerArchivedUsd) || 0) + dropped) * 100) / 100;
  }
  return rec.ledger;
}
const CODE_LEN = 8;  // base36 chars; ~2.8 trillion address space

// ---- Commission ladder (docs/COMMISSION-MODEL.md is the plain-language copy)
// Bounty per qualifying sale, rising with LIFETIME sales. Milestones pay once.
// The monthly sprint repeats every calendar month.
// UNIT ECONOMICS. The bounty is scaled to the PLAN, not flat, because a flat
// bounty overpays cheap plans and underpays valuable ones. Each base bounty is
// about 35 to 40 percent of the net revenue from the customer's discounted
// first three months (sticker, minus the 20 percent ambassador discount, minus
// Stripe's 2.9 percent + 30 cents per charge), so EVERY sale is margin-positive
// on day one and Business/Studio sales are visibly worth chasing.
//
//   plan      net first 3 months   base bounty   margin
//   Origin    $20.07               $7            +$13.07
//   Solo      $27.07               $10           +$17.07
//   Pro       $43.38               $16           +$27.38
//   Studio    $66.68               $25           +$41.68
//   Business  $183.20              $70           +$113.20
//   Lifetime  $231.96              $85           +$146.96
//
// A flat $20 previously paid MORE than an Origin sale earned ($20.07 net) and
// a first Solo sale actually lost money once the first-sale bonus applied.
export const PLAN_BOUNTY = {
  founding: 7,  founding_annual: 7,
  solo: 10,     solo_annual: 10,
  pro: 16,      pro_annual: 16,
  team: 25,     team_annual: 25,
  business: 70, business_annual: 70,
  lifetime: 85,
  // Add-ons attach to an existing plan and do not pay a separate bounty.
  seat: 0, whitelabel: 0, free: 0,
};
export const DEFAULT_BOUNTY = 10;

// The ladder is now a MULTIPLIER on the plan bounty, so climbing pays more on
// every plan without ever inverting the plan-value relationship.
export const TIERS = [
  { key: 'bronze', label: 'Bronze', min: 0,  mult: 1.0 },
  { key: 'silver', label: 'Silver', min: 5,  mult: 1.15 },
  { key: 'gold',   label: 'Gold',   min: 15, mult: 1.3 },
];
// Bonuses are funded by ongoing subscription revenue, not the first 3 months.
// Sized so even the worst stack (Gold, five cheap sales, milestone + sprint in
// one month) is recovered by ongoing revenue inside a single month.
export const MILESTONES = [
  { at: 1,  bonus: 10, label: 'First sale' },
  { at: 10, bonus: 40, label: '10 sales' },
  { at: 25, bonus: 75, label: '25 sales' },
];
export const SPRINT = { salesNeeded: 5, bonus: 40, label: '5 sales in a calendar month' };

/** Base bounty for a Stripe tier id, before the ladder multiplier. */
export function bountyForPlan(planId) {
  const b = PLAN_BOUNTY[String(planId || '').toLowerCase()];
  return typeof b === 'number' ? b : DEFAULT_BOUNTY;
}

/** What a specific plan actually pays this ambassador at their current tier. */
export function payoutFor(planId, conversions) {
  const base = bountyForPlan(planId);
  if (base <= 0) return 0;
  return Math.round(base * tierFor(conversions).mult);
}
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
    if (seen) {
      // A tombstone means the refund for this sale was delivered BEFORE the
      // conversion it undoes. Crediting now would mint a bounty that nothing
      // will ever reverse, because the reversal has already been consumed.
      let prior = null;
      try { prior = JSON.parse(seen); } catch (e) {}
      if (prior && prior.reversedEarly) return { ok: false, error: 'reversed_before_credit' };
      return { ok: true, alreadyCounted: true };
    }
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
  // Plan-scaled: what this specific sale is worth, times the ladder multiplier.
  // Add-ons pay 0, so an add-on purchase never mints a bounty.
  let credit = payoutFor(tier, rec.conversions);
  if (credit <= 0) {
    // Not a bounty-bearing purchase (add-on, free). Count nothing, pay nothing.
    rec.conversions -= 1;
    return { ok: false, error: 'non_qualifying_plan' };
  }
  // ONE ENTRY PER COMPONENT. A refund has to reverse exactly the bounty plus
  // the bonuses THAT sale triggered and leave every other sale alone, which is
  // impossible once the components are folded into a single summed amount.
  // clearsAt is stamped HERE, at write time, not derived on read, so changing
  // the hold later can never retroactively move money already promised.
  const at = new Date().toISOString();
  const clearsAt = new Date(Date.now() + HOLD_DAYS * DAY_MS).toISOString();
  const planId = String(tier || '').toLowerCase() || null;
  // The bounty ALONE, captured before any bonus is folded into `credit`.
  const bountyOnly = credit;
  const entries = [{
    id: ledgerId(), at, clearsAt, type: 'bounty', planId, customerId,
    amount: credit, what: `${tier} sale`,
  }];
  const bonuses = [];
  // A milestone is awarded at most ONCE, ever, and that fact is PERSISTED.
  // It used to be inferred from `rec.conversions === m.at`, a live counter that
  // reverseConversion decrements. Reversing any sale other than the one that
  // triggered the milestone left the bonus credited AND re-armed the trigger,
  // so the next sale paid it again. A refund-and-replace cycle that always
  // netted 10 sales minted the $40 bonus six times: $420 earned against a true
  // book of $262.
  rec.milestonesPaid = (rec.milestonesPaid && typeof rec.milestonesPaid === 'object')
    ? rec.milestonesPaid : {};
  // BACKFILL for records written before milestonesPaid existed. Seed from the
  // ledger where we have evidence, then assume any milestone already at or
  // below the lifetime count was paid under the old rule. Assuming PAID is the
  // safe direction: the worst case is an ambassador misses a bonus we cannot
  // prove they are owed, which is visible and fixable by hand, versus silently
  // paying a 20-sale veteran their first-sale and 10-sale bonuses all over
  // again on their next sale. The ledger is capped and can be archived, so its
  // silence is not proof a milestone was never paid.
  if (!rec.milestonesPaidSeeded) {
    for (const e of (Array.isArray(rec.ledger) ? rec.ledger : [])) {
      if (e && e.type === 'milestone' && Number(e.amount) > 0) {
        const m = MILESTONES.find(x => x.bonus === Number(e.amount));
        if (m && !rec.milestonesPaid[m.at]) rec.milestonesPaid[m.at] = e.id || true;
      }
    }
    const priorConversions = Math.max(0, (rec.conversions || 0) - 1);
    for (const m of MILESTONES) {
      if (priorConversions >= m.at && !rec.milestonesPaid[m.at]) rec.milestonesPaid[m.at] = 'legacy';
    }
    rec.milestonesPaidSeeded = true;
  }
  for (const m of MILESTONES) {
    if (rec.conversions >= m.at && !rec.milestonesPaid[m.at]) {
      const mid = ledgerId();
      credit += m.bonus;
      bonuses.push(m.label);
      entries.push({
        id: mid, at, clearsAt, type: 'milestone', planId, customerId,
        amount: m.bonus, what: `${m.label} bonus`,
      });
      rec.milestonesPaid[m.at] = mid;
    }
  }
  // Monthly sprint: repeatable, tracked per calendar month.
  const monthKey = new Date().toISOString().slice(0, 7);
  rec.monthly = (rec.monthly && rec.monthly.month === monthKey)
    ? rec.monthly : { month: monthKey, sales: 0, sprintPaid: false };
  rec.monthly.sales += 1;
  if (!rec.monthly.sprintPaid && rec.monthly.sales >= SPRINT.salesNeeded) {
    const sid = ledgerId();
    credit += SPRINT.bonus;
    rec.monthly.sprintPaid = true;
    // Keep the entry id so a reversal can withdraw THIS bonus by id rather
    // than silently re-arming the threshold for the next sale to re-earn.
    rec.monthly.sprintEntryId = sid;
    bonuses.push(SPRINT.label);
    entries.push({
      id: sid, at, clearsAt, type: 'sprint', planId, customerId,
      amount: SPRINT.bonus, what: `${SPRINT.label} bonus`,
    });
  }
  rec.earnedUsd = Math.round(((rec.earnedUsd || 0) + credit) * 100) / 100;
  pushLedger(rec, entries);
  rec.tier = earnedTier.key;
  rec.lastConversionAt = at;

  // CLAIM BEFORE CREDIT. The dedupe key is written FIRST. If the second write
  // fails, the sale is claimed but uncredited: visible and recoverable. The old
  // order credited first, so a failed dedupe write left a credited sale with no
  // claim, and every webhook redelivery credited it again. A swallowed error
  // that still returned ok:true is how that stayed invisible.
  const dedupeValue = JSON.stringify({
    at, tier, planId,
    creditTotal: credit,
    // The bounty WITHOUT any milestone or sprint bonus this sale happened to
    // trigger. A reversal claws back only this, because bonuses are owned
    // entirely by the canonical reconcile in reverseConversion. Subtracting
    // the bundled creditTotal double-withdraws any bonus the reconcile has
    // already removed, which is how unwinding 5 sales left minus $40.
    bountyUsd: bountyOnly,
    entryIds: entries.map(e => e.id),
    month: monthKey,
  });
  try {
    await env.CYBERSYGN_DOCS.put(dedupeKey, dedupeValue, { expirationTtl: 60 * 60 * 24 * 365 * 5 });
  } catch (e) {
    return { ok: false, error: 'dedupe_claim_failed' };
  }
  try {
    await env.CYBERSYGN_DOCS.put(`${KV_PREFIX}code:${code}`, JSON.stringify(rec));
  } catch (e) {
    // Claimed but not credited. Say so instead of reporting a success, so the
    // webhook can be redelivered and the gap can be reconciled by hand.
    return { ok: false, error: 'credit_write_failed', claimed: true, payoutUsd: credit };
  }
  return { ok: true, alreadyCounted: false, payoutUsd: credit, tier: earnedTier.key, bonuses };
}

/**
 * Reverse a previously-credited conversion (refund, dispute, chargeback).
 *
 * Backs out this sale's BOUNTY, read from bountyUsd on the
 * per-customer dedupe record, including any milestone or sprint bonus the sale
 * triggered. It deliberately does not use a flat figure: a flat $20 was wrong
 * in both directions, leaving $71 of unearned commission on a clawed-back Gold
 * Business sale and, worse, taking $13 out of OTHER legitimately earned sales
 * when a $7 Origin sale reversed.
 *
 * Two more rules that keep the books honest:
 *  - A negative ledger entry is written per reversed component, so the ledger
 *    and earnedUsd still agree. Without it the monthly email keeps reporting
 *    the original figure forever.
 *  - earnedUsd is NOT clamped at zero. If a reversal lands after the money went
 *    out, the balance must go negative so payoutState can surface it as an
 *    overpayment. Clamping is exactly what made that loss invisible.
 *
 * Idempotent and best-effort.
 */
export async function reverseConversion(env, code, customerId, reason) {
  if (!isValidCode(code) || !customerId) return { ok: false, error: 'bad_args' };
  const dedupeKey = `${KV_PREFIX}conv:${code}:${customerId}`;
  try {
    const raw = await env.CYBERSYGN_DOCS.get(dedupeKey);
    if (!raw) {
      // Nothing to claw back YET. Stripe does not order its deliveries, so a
      // refund can land before the conversion it undoes, and simply returning
      // here left the later conversion free to credit a bounty that no second
      // refund would ever arrive to reverse. Leave a tombstone at the dedupe
      // key that recordConversion already reads first, so the credit never
      // happens rather than happening and standing forever.
      const at = new Date().toISOString();
      try {
        await env.CYBERSYGN_DOCS.put(dedupeKey, JSON.stringify({
          reversedEarly: true, at, reason: reason || 'reversed',
        }), { expirationTtl: 60 * 60 * 24 * 365 * 5 });
      } catch (e) {
        return { ok: false, error: 'tombstone_write_failed' };
      }
      return { ok: true, nothingToReverse: true, tombstoned: true };
    }
    let conv;
    try { conv = JSON.parse(raw); } catch (e) { conv = {}; }
    // reversedEarly is the tombstone written below when a refund beat its
    // conversion. It carries no amount, so a redelivered refund that fell
    // through here would claw back the legacy flat figure from an ambassador
    // who was never credited a cent.
    if (conv.reversed || conv.blocked || conv.reversedEarly) return { ok: true, alreadyHandled: true };

    // Claw back the BOUNTY ONLY. Bonuses (milestone, sprint) are owned end to
    // end by the canonical reconcile below, which recomputes entitlement from
    // the surviving counts. Subtracting the bundled creditTotal here made both
    // paths withdraw the same bonus: unwinding 5 solo sales peaked at $102 and
    // finished at MINUS $40, because the sprint was withdrawn once by the
    // reconcile (when sales fell under 5) and again by the clawback on the
    // sale that happened to carry it.
    //
    // Fallback order matters for records written before bountyUsd existed:
    // creditTotal is closer to correct than the legacy flat figure, and for
    // any sale that triggered no bonus the two are identical anyway.
    const bounty = Number(conv.bountyUsd);
    const credited = Number(conv.creditTotal);
    const clawback = Number.isFinite(bounty) ? bounty
                   : Number.isFinite(credited) ? credited
                   : PAYOUT_USD;
    const legacy = !Number.isFinite(bounty) && !Number.isFinite(credited);

    const rec = await loadCode(env, code);
    // No record means we cannot apply the debit. Marking the dedupe key
    // reversed anyway would poison it forever: the sale stays credited and no
    // retry can ever reverse it, because the marker says it is already handled.
    if (!rec) return { ok: false, error: 'record_unavailable' };

    const at = new Date().toISOString();
    const reversedIds = Array.isArray(conv.entryIds) ? conv.entryIds : [];
    rec.conversions = Math.max(0, (rec.conversions || 0) - 1);
    rec.earnedUsd = Math.round(((rec.earnedUsd || 0) - clawback) * 100) / 100;
    rec.reversals = (rec.reversals || 0) + 1;

    // Cleared immediately: a reversal must reduce the payable balance now, not
    // sit in the hold window where it could be paid around.
    const reversalEntries = [{
      id: ledgerId(),
      at,
      clearsAt: at,
      type: 'reversal',
      planId: conv.planId || null,
      customerId,
      amount: -clawback,
      what: `reversal (${reason || 'reversed'})`,
      reversesEntryIds: reversedIds,
      legacyFlatClawback: legacy || undefined,
    }];

    // Bonus flags are NOT cleared here any more. The clawback above no longer
    // removes bonus money, so a flag that still says "paid" is telling the
    // truth: that bonus is still on the books. The reconcile below is the one
    // authority that decides, from the surviving counts, whether it stays.
    // Clearing flags here as well is what let a bonus be withdrawn twice.
    rec.milestonesPaid = (rec.milestonesPaid && typeof rec.milestonesPaid === 'object')
      ? rec.milestonesPaid : {};
    if (rec.monthly && rec.monthly.month === conv.month) {
      rec.monthly.sales = Math.max(0, (rec.monthly.sales || 0) - 1);
    }

    // CANONICAL RECONCILE. Entitlement is recomputed from the surviving counts,
    // then the record is moved to match it. This is symmetric by construction:
    // entitled-but-unpaid credits, paid-but-not-entitled debits. Patching the
    // flags case by case is what produced both a $158 overpayment and, once
    // that was half-fixed, a $40 shortfall when a reversed sale happened to be
    // the one carrying the sprint bonus.
    for (const m of MILESTONES) {
      const entitled = rec.conversions >= m.at;
      const paid = !!rec.milestonesPaid[m.at];
      if (entitled && !paid) {
        const mid = ledgerId();
        rec.earnedUsd = Math.round((rec.earnedUsd + m.bonus) * 100) / 100;
        reversalEntries.push({
          id: mid, at, clearsAt: at, type: 'milestone',
          planId: conv.planId || null, customerId,
          amount: m.bonus, what: `${m.label} bonus`,
        });
        rec.milestonesPaid[m.at] = mid;
      } else if (!entitled && paid) {
        rec.earnedUsd = Math.round((rec.earnedUsd - m.bonus) * 100) / 100;
        reversalEntries.push({
          id: ledgerId(), at, clearsAt: at, type: 'reversal',
          planId: conv.planId || null, customerId,
          amount: -m.bonus, what: `${m.label} bonus withdrawn`,
        });
        delete rec.milestonesPaid[m.at];
      }
    }
    if (rec.monthly && rec.monthly.month === conv.month) {
      const entitled = (rec.monthly.sales || 0) >= SPRINT.salesNeeded;
      if (entitled && !rec.monthly.sprintPaid) {
        const sid = ledgerId();
        rec.earnedUsd = Math.round((rec.earnedUsd + SPRINT.bonus) * 100) / 100;
        reversalEntries.push({
          id: sid, at, clearsAt: at, type: 'sprint',
          planId: conv.planId || null, customerId,
          amount: SPRINT.bonus, what: `${SPRINT.label} bonus`,
        });
        rec.monthly.sprintPaid = true;
        rec.monthly.sprintEntryId = sid;
      } else if (!entitled && rec.monthly.sprintPaid) {
        rec.earnedUsd = Math.round((rec.earnedUsd - SPRINT.bonus) * 100) / 100;
        reversalEntries.push({
          id: ledgerId(), at, clearsAt: at, type: 'reversal',
          planId: conv.planId || null, customerId,
          amount: -SPRINT.bonus, what: `${SPRINT.label} bonus withdrawn`,
        });
        rec.monthly.sprintPaid = false;
        rec.monthly.sprintEntryId = null;
      }
    }

    pushLedger(rec, reversalEntries);
    rec.tier = tierFor(rec.conversions).key;

    // CLAIM BEFORE DEBIT, same reasoning as recordConversion. If the debit write
    // fails after the marker lands, the reversal is un-applied and visible, not
    // applied twice. The old order debited first, so a throw on the marker write
    // left the debit applied with nothing to stop a second attempt.
    conv.reversed = reason || 'reversed';
    conv.reversedAt = at;
    conv.clawedBackUsd = clawback;
    await env.CYBERSYGN_DOCS.put(dedupeKey, JSON.stringify(conv), { expirationTtl: 60 * 60 * 24 * 365 * 5 });
    await env.CYBERSYGN_DOCS.put(`${KV_PREFIX}code:${code}`, JSON.stringify(rec));
    return { ok: true, reversed: true, clawedBackUsd: clawback, legacyFlatClawback: legacy };
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

/** Full ambassador record by code (internal callers: email, owner tooling). */
export async function getCodeRecord(env, code) {
  return loadCode(env, code);
}
