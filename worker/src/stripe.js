/**
 * Stripe integration for CyberSygn.
 *
 * One file, no SDK. Direct fetch calls to Stripe's REST API so we keep
 * the Worker small and the dependency graph empty. Hosted Checkout only,
 * which means no card data ever touches our Worker.
 *
 * Configuration (all set via `wrangler secret put` in production):
 *   STRIPE_SECRET_KEY        sk_live_... or sk_test_...
 *   STRIPE_WEBHOOK_SECRET    whsec_...
 *   STRIPE_PRICE_SOLO        price_... for $12 / mo
 *   STRIPE_PRICE_FOUNDING    price_... for $9 / mo, founding 100
 *   STRIPE_PRICE_TEAM        price_... for $29 / mo, 3 seats
 *
 * Sub state, KV layout (CYBERSYGN_DOCS namespace):
 *   sub:<senderId>                 sender's subscription record
 *   stripe:customer:<customerId>   reverse lookup for webhooks
 *   usage:<senderId>:<YYYY-MM>     free-tier doc counter (UTC month)
 *   meta:founding-count            integer, founding seats taken so far
 */

import { getStorage } from './storage.js';
import { recordSubForMetrics } from './metrics-counters.js';

const STRIPE_API = 'https://api.stripe.com/v1';
const FOUNDING_CAP = 100;

export const TIERS = {
  free:            { id: 'free',            docs: 3,        priceEnv: null,                            label: 'Demo' },
  solo:            { id: 'solo',            docs: Infinity, priceEnv: 'STRIPE_PRICE_SOLO',             label: 'Solo' },
  solo_annual:     { id: 'solo_annual',     docs: Infinity, priceEnv: 'STRIPE_PRICE_SOLO_ANNUAL',      label: 'Solo (annual)' },
  // Pro (hero): Solo + AI co-pilot + priority. $19 / $180yr. New envs.
  pro:             { id: 'pro',             docs: Infinity, priceEnv: 'STRIPE_PRICE_PRO',              label: 'Pro' },
  pro_annual:      { id: 'pro_annual',      docs: Infinity, priceEnv: 'STRIPE_PRICE_PRO_ANNUAL',       label: 'Pro (annual)' },
  founding:        { id: 'founding',        docs: Infinity, priceEnv: 'STRIPE_PRICE_FOUNDING',         label: 'Origin' },
  founding_annual: { id: 'founding_annual', docs: Infinity, priceEnv: 'STRIPE_PRICE_FOUNDING_ANNUAL',  label: 'Origin (annual)' },
  team:            { id: 'team',            docs: Infinity, priceEnv: 'STRIPE_PRICE_TEAM',             label: 'Studio' },
  team_annual:     { id: 'team_annual',     docs: Infinity, priceEnv: 'STRIPE_PRICE_TEAM_ANNUAL',      label: 'Studio (annual)' },
  // Business (anchor): 10 seats + white-label + SSO + API. $79 / $780yr.
  business:        { id: 'business',        docs: Infinity, priceEnv: 'STRIPE_PRICE_BUSINESS',         label: 'Business' },
  business_annual: { id: 'business_annual', docs: Infinity, priceEnv: 'STRIPE_PRICE_BUSINESS_ANNUAL',  label: 'Business (annual)' },
  // Lifetime tier (slice 98): one-time $299, capped at first 50 customers.
  // No recurring billing. Same feature set as Solo. Tracked separately
  // so the tier label and Stripe checkout-mode differ from subscriptions.
  lifetime:        { id: 'lifetime',        docs: Infinity, priceEnv: 'STRIPE_PRICE_LIFETIME',         label: 'Lifetime', oneTime: true },
  // A la carte add-ons, WITHDRAWN FROM SALE 2026-08-12.
  //
  // Both were purchasable and neither did anything. The whitelabel
  // entitlement is written to `addons:<senderId>` by the webhook and read by
  // NOTHING: a customer could pay $19/month and receive no change, while a
  // free user removes the same footer from devtools in five seconds. Seats
  // were worse: there is a single flat MEMBER_HARD_CAP of 25 applied to every
  // workspace regardless of plan, and no code path reads a purchased
  // quantity, so "extra seat" bought nothing at all.
  //
  // `retired: true` keeps the definitions so existing Stripe objects and any
  // historical subscription still resolve, while removing them from the
  // purchasable set below. Delete the flag to put them back on sale, and only
  // do that on the day the entitlement is actually enforced.
  seat:            { id: 'seat',            docs: 0,        priceEnv: 'STRIPE_PRICE_SEAT',             label: 'Extra seat', addon: true, quantifiable: true, retired: true },
  whitelabel:      { id: 'whitelabel',      docs: 0,        priceEnv: 'STRIPE_PRICE_WHITELABEL',       label: 'White-label', addon: true, retired: true },
};

/**
 * Which purchasable things actually have a Stripe price configured. The
 * pricing UI reads this so a not-yet-priced tier (e.g. Pro/Business before the
 * owner creates its Stripe price) shows for the anchor effect but its CTA
 * degrades to "notify me" instead of dead-ending on a checkout error.
 * Annual variants fold into their base id.
 */
/**
 * Tiers that include the AI co-pilot.
 *
 * Pro's pricing copy is "Everything in Solo, plus the AI co-pilot that drafts
 * and reads your contracts for you", so Solo is deliberately NOT in this set.
 * Anything at or above Pro is, including the annual variants and the
 * grandfathered lifetime/founding tiers.
 */
const AI_TIER_BASES = new Set(['pro', 'team', 'business', 'founding', 'lifetime', 'whitelabel']);

export function tierIncludesAi(tier) {
  if (!tier) return false;
  return AI_TIER_BASES.has(String(tier).replace(/_annual$/, ''));
}

export function purchasableTiers(env) {
  const priced = (id) => {
    const conf = TIERS[id];
    return !!(conf && conf.priceEnv && typeof env[conf.priceEnv] === 'string' && env[conf.priceEnv].startsWith('price_'));
  };
  const out = {};
  const bases = ['solo', 'pro', 'team', 'business', 'founding', 'lifetime', 'seat', 'whitelabel'];
  for (const id of bases) {
    // A subscription tier is only "purchasable" for the funnel if BOTH its
    // monthly and annual prices exist, because annual is the default cycle and
    // an annual click with no *_annual price would dead-end. Tiers without an
    // annual variant (lifetime, seat, whitelabel) just need their one price.
    const annualId = `${id}_annual`;
    const needsAnnual = !!TIERS[annualId];
    // A retired SKU is never purchasable, whatever Stripe still has priced.
    // We do not take money for something the code does not deliver.
    const retired = !!(TIERS[id] && TIERS[id].retired);
    out[id] = !retired && priced(id) && (!needsAnnual || priced(annualId));
  }
  return out;
}

// Cap for Lifetime tier, only the first N customers can claim it.
export const LIFETIME_CAP = 50;

// ---- Public API surface called from index.js ------------------------------

/**
 * Read the current subscription record for a senderId. Returns a normalized
 * record: { tier, status, stripeCustomerId?, stripeSubscriptionId?, ... }.
 * Free-tier is the implicit default.
 */
export async function getSubscription(env, senderId) {
  if (!senderId) return defaultFree();
  // Sanitize HERE, not only in the callers. This builds a KV key from a value
  // that arrives straight out of a URL path segment on several routes, and
  // Cloudflare KV throws on a key over 512 bytes, so an unauthenticated GET
  // with a long segment took the worker to a 500. Every id sanitizer in the
  // codebase uses this same shape.
  const safe = String(senderId).replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 64);
  if (!safe) return defaultFree();
  const storage = pickStorage(env);
  const raw = await storage.get(`sub:${safe}`);
  if (!raw) return defaultFree();
  try {
    const parsed = JSON.parse(raw);
    return { ...defaultFree(), ...parsed };
  } catch {
    return defaultFree();
  }
}

/**
 * Read this calendar month's doc usage for a senderId. UTC month.
 */
export async function getUsageThisMonth(env, senderId) {
  if (!senderId) return 0;
  const storage = pickStorage(env);
  const key = `usage:${senderId}:${currentMonthKey()}`;
  const raw = await storage.get(key);
  if (!raw) return 0;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

/**
 * Increment this month's doc counter. Best-effort: failure to write is
 * logged but does not block the doc creation that triggered it.
 */
export async function incrementUsage(env, senderId) {
  if (!senderId) return;
  const storage = pickStorage(env);
  const key = `usage:${senderId}:${currentMonthKey()}`;
  try {
    const raw = await storage.get(key);
    const n = parseInt(raw || '0', 10);
    const next = (Number.isFinite(n) && n >= 0 ? n : 0) + 1;
    // 40-day TTL is plenty for a calendar-month counter.
    await storage.put(key, String(next), { expirationTtl: 40 * 24 * 3600 });
  } catch (err) {
    console.error('[stripe] usage increment failed:', err && err.message);
  }
}

/**
 * Free-tier gate. Returns { allowed: bool, remaining, tier, used }.
 * Owner check is the caller's responsibility (owner short-circuits to
 * allowed: true before this is called).
 */
export async function checkFreeTierAllowance(env, senderId) {
  const sub = await getSubscription(env, senderId);
  if (sub.status === 'active' && sub.tier !== 'free') {
    return { allowed: true, remaining: Infinity, tier: sub.tier, used: 0, sub };
  }
  // Ambassador product pass: active ambassadors get the full product free.
  // Checked after a real paid plan (a paying ambassador keeps their own tier)
  // and before the free-tier counter, so the pass genuinely unlocks sending.
  try {
    const { ambassadorBySender, passActive } = await import('./ambassador.js');
    const amb = await ambassadorBySender(env, senderId);
    if (passActive(amb)) {
      return { allowed: true, remaining: Infinity, tier: 'ambassador', used: 0, sub, ambassadorPass: true };
    }
  } catch (e) { /* pass check must never block a send */ }
  const used = await getUsageThisMonth(env, senderId);
  const cap = TIERS.free.docs;
  return {
    allowed: used < cap,
    remaining: Math.max(0, cap - used),
    tier: 'free',
    used,
    cap,
    sub,
  };
}

/**
 * Set the Origin wall display fields on a sub record. Used by the
 * Origin onboarding form so a member can fill in their display name
 * and city for the public wall. Owner-by-senderId auth check is the
 * caller's responsibility.
 *
 * Returns the updated record on success, null if the record doesn't
 * exist or isn't an Origin member.
 */
export async function setOriginProfile(env, senderId, { displayName, city }) {
  if (!senderId) return null;
  const storage = pickStorage(env);
  const raw = await storage.get(`sub:${senderId}`);
  if (!raw) return null;
  let rec;
  try { rec = JSON.parse(raw); } catch (e) { return null; }
  if (!rec || rec.tier !== 'founding' || typeof rec.foundingNumber !== 'number') {
    return null;
  }
  if (typeof displayName === 'string') {
    rec.originDisplayName = displayName.trim().slice(0, 40);
  }
  if (typeof city === 'string') {
    rec.originCity = city.trim().slice(0, 60);
  }
  rec.updatedAt = new Date().toISOString();
  await storage.put(`sub:${senderId}`, JSON.stringify(rec));
  return rec;
}

/**
 * Read the live founding-member count. Used by the marketing page to
 * render "X of 100 founding spots remaining" honestly.
 */
export async function getFoundingCount(env) {
  const storage = pickStorage(env);
  const raw = await storage.get('meta:founding-count');
  const n = parseInt(raw || '0', 10);
  return Number.isFinite(n) && n >= 0 ? Math.min(n, FOUNDING_CAP) : 0;
}

/**
 * Read the live Lifetime count (slice 98). Capped at LIFETIME_CAP.
 */
export async function getLifetimeCount(env) {
  const storage = pickStorage(env);
  const raw = await storage.get('meta:lifetime-count');
  const n = parseInt(raw || '0', 10);
  return Number.isFinite(n) && n >= 0 ? Math.min(n, LIFETIME_CAP) : 0;
}

export function foundingCap() {
  return FOUNDING_CAP;
}

/**
 * Create a Stripe Checkout session for a chosen tier. Returns the
 * hosted checkout URL the browser should redirect to.
 *
 * Founding 100 is gated server-side: if the count is already at the cap,
 * we refuse and ask the caller to fall back to Solo.
 */
export async function createCheckoutSession(env, { tier, senderId, email, successUrl, cancelUrl, origin, ref, quantity, source }) {
  if (!env || typeof env.STRIPE_SECRET_KEY !== 'string' || !env.STRIPE_SECRET_KEY.startsWith('sk_')) {
    throw stripeError('not_configured', 'Stripe is not configured on this deployment.');
  }
  const tierConf = TIERS[tier];
  if (!tierConf || !tierConf.priceEnv) {
    throw stripeError('invalid_tier', 'That tier is not purchasable.');
  }
  // Server-side guard, not just a hidden button. A retired SKU still has a
  // live Stripe price, so a stale page or a hand-crafted request could still
  // reach checkout and take money for functionality that does not exist.
  if (tierConf.retired) {
    throw stripeError('tier_retired', 'That add-on is no longer sold.');
  }
  const priceId = env[tierConf.priceEnv];
  if (typeof priceId !== 'string' || !priceId.startsWith('price_')) {
    throw stripeError('missing_price', `Price for "${tier}" is not configured.`);
  }
  // Add-ons attach to a paid plan. Refuse to sell one to a free/planless
  // account, or it would be a cheaper path to an unlimited entitlement.
  if (tierConf.addon) {
    const base = await getSubscription(env, senderId);
    const hasPlan = !!(base && base.status === 'active' && base.tier !== 'free'
      && !(TIERS[base.tier] && TIERS[base.tier].addon));
    if (!hasPlan) {
      throw stripeError('addon_needs_plan', 'Add-ons attach to a paid plan. Choose a plan first, then add this.');
    }
  }
  if (tier === 'founding') {
    const taken = await getFoundingCount(env);
    if (taken >= FOUNDING_CAP) {
      throw stripeError('founding_full', 'All 100 founding spots are taken. Pick Solo or Team.');
    }
  }
  if (tier === 'lifetime') {
    const taken = await getLifetimeCount(env);
    if (taken >= LIFETIME_CAP) {
      throw stripeError('lifetime_full', `All ${LIFETIME_CAP} Lifetime spots are taken. Pick Solo, Origin, or Studio.`);
    }
  }

  // A PLAN CHANGE IS AN UPGRADE, NOT A SECOND SUBSCRIPTION.
  //
  // Sending an existing subscriber back through hosted Checkout opens a second
  // Stripe subscription alongside the one they already hold: they are billed
  // for both, and when the old one is finally cancelled its deleted event is
  // what used to strip the account back to free. Swap the price on the live
  // subscription instead, so a customer only ever has one, and Stripe prorates
  // the difference. Anything unclean falls through to Checkout below, because a
  // failed upgrade must never block a sale.
  const reUseCustomer = await maybeExistingCustomer(env, senderId);

  const body = new URLSearchParams();
  // Lifetime is a one-time payment ('payment' mode in Stripe Checkout);
  // every other tier is recurring ('subscription' mode). subscription_data
  // metadata only applies to subscription mode.
  const isOneTime = tier === 'lifetime' || tierConf.oneTime;
  body.set('mode', isOneTime ? 'payment' : 'subscription');
  body.set('line_items[0][price]', priceId);
  // Quantifiable add-ons (seats) accept a quantity; everything else is 1.
  let qty = 1;
  if (tierConf.quantifiable) {
    const n = parseInt(quantity, 10);
    qty = Number.isFinite(n) ? Math.min(50, Math.max(1, n)) : 1;
    body.set('line_items[0][adjustable_quantity][enabled]', 'true');
    body.set('line_items[0][adjustable_quantity][minimum]', '1');
    body.set('line_items[0][adjustable_quantity][maximum]', '50');
  }
  body.set('line_items[0][quantity]', String(qty));
  body.set('success_url', successUrl || `${origin}/dashboard/?checkout=success&session_id={CHECKOUT_SESSION_ID}`);
  body.set('cancel_url', cancelUrl || `${origin}/?checkout=canceled`);
  body.set('client_reference_id', senderId || '');
  // No OPEN promo-code field (an empty coupon box at the pay button invites
  // discount-hunting and erodes the price anchor). Ambassador discounts are
  // applied server-side below, from the referring code, so the buyer never has
  // to type anything and the promised discount cannot silently fail.
  body.set('billing_address_collection', 'auto');
  body.set('metadata[tier]', tier);
  body.set('metadata[senderId]', senderId || '');
  if (tierConf.quantifiable) body.set('metadata[quantity]', String(qty));
  if (!isOneTime) {
    body.set('subscription_data[metadata][tier]', tier);
    body.set('subscription_data[metadata][senderId]', senderId || '');
  } else {
    // One-time payments have no subscription label, so name the charge on the
    // PaymentIntent so the Stripe receipt and dashboard show the plan.
    body.set('payment_intent_data[description]', `CyberSygn ${tierConf.label || tier}`);
  }
  // Affiliate ref: only set if the client supplied a real code shape.
  // The webhook reads subscription.metadata.ref to credit the affiliate.
  if (typeof ref === 'string' && /^[a-z0-9]{4,16}$/.test(ref)) {
    body.set('metadata[ref]', ref);
    if (!isOneTime) body.set('subscription_data[metadata][ref]', ref);
    // THE DISCOUNT MUST ACTUALLY APPLY. Resolve the ambassador code to its
    // Stripe promotion code and attach it to the session server-side, so the
    // buyer sees the promised discount without typing anything. If the code has
    // no promo (legacy code, or Stripe call failed at setup), we simply do not
    // discount: attribution still works and checkout still succeeds.
    // NOT on one-time purchases. The ambassador coupon is duration=repeating
    // over 3 months, which Stripe rejects on a 'payment' mode session, so
    // attaching it to Lifetime failed the whole checkout rather than merely
    // skipping the discount. "20% off the first 3 months" has no meaning on a
    // one-time purchase anyway. Attribution and the bounty are unaffected:
    // both ride on metadata, not on the discount.
    if (!isOneTime) {
      try {
        const { promoIdForCode } = await import('./affiliate.js');
        const promoId = await promoIdForCode(env, ref);
        if (promoId) body.set('discounts[0][promotion_code]', promoId);
      } catch (e) {
        console.error('[stripe] promo lookup failed:', e && e.message);
      }
    }
  }

  // First-touch marketing source (utm_source or referrer host, sanitized
  // client-side). Stored on the subscription metadata so it survives every
  // later subscription.* webhook and can be aggregated into MRR-by-source.
  if (typeof source === 'string' && source) {
    const s = source.slice(0, 40);
    body.set('metadata[source]', s);
    if (!isOneTime) body.set('subscription_data[metadata][source]', s);
  }
  if (reUseCustomer) {
    body.set('customer', reUseCustomer);
  } else if (email && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    body.set('customer_email', email);
  }

  const res = await stripeFetch(env, 'POST', '/checkout/sessions', body);
  if (!res.id || !res.url) {
    throw stripeError('checkout_create_failed', res.error?.message || 'Stripe rejected the checkout request.');
  }
  return { sessionId: res.id, url: res.url };
}

/**
 * Move an existing subscriber to a different recurring plan by swapping the
 * price on their live Stripe subscription. Returns a value shaped like a
 * checkout session (the caller only reads `url`), or null to fall through to
 * hosted Checkout.
 *
 * Deliberately NOT used for Origin or Lifetime in either direction: both hand
 * out a numbered seat that is only ever issued in the checkout.session.completed
 * handler, so buying one has to go through Checkout, and swapping away from one
 * would silently retire a number we promised was theirs for life.
 */
// DELIBERATELY NOT WIRED UP. An in-place plan swap was written here to stop a
// second subscription being created on upgrade, but it turned
// POST /api/checkout/create-session from "mint a Checkout URL the customer
// reviews" into an immediate, irreversible billing mutation with prorations
// and no confirmation screen. Clicking Upgrade would charge you before you saw
// a price. The entitlement bug it was meant to help with is fully fixed by the
// staleSubscriptionEvent guard below, which is the actual defect: cancelling a
// superseded subscription no longer wipes access.
//
// If single-subscription upgrades are wanted, they need a confirmation step
// (a Stripe Billing Portal flow, or a preview-then-confirm endpoint), which is
// a product decision, not a bug fix. See HANDOFF.md.
async function maybeChangePlanInPlace(env, { tier, tierConf, priceId, senderId, origin, source }) {
  if (!senderId || !origin) return null;
  if (tierConf.addon || tierConf.oneTime) return null;
  const NUMBERED = ['founding', 'founding_annual', 'lifetime'];
  if (NUMBERED.includes(tier)) return null;

  const existing = await getSubscription(env, senderId);
  if (!existing.stripeSubscriptionId || !existing.stripeCustomerId) return null;
  if (NUMBERED.includes(existing.tier)) return null;
  // Only a running subscription can be swapped. A cancelled or unpaid one has
  // no live item to prorate against, so that buyer starts a fresh one.
  if (existing.status !== 'active' && existing.status !== 'trialing') return null;
  if (existing.tier === tier) return null;

  try {
    const live = await stripeFetch(env, 'GET', `/subscriptions/${existing.stripeSubscriptionId}`, null);
    if (!live || (live.status !== 'active' && live.status !== 'trialing')) return null;
    const items = (live.items && live.items.data) || [];
    // More than one line means an add-on rides this same subscription and we
    // cannot tell which line is the plan. Let Checkout handle that account.
    if (items.length !== 1 || !items[0].id) return null;

    const body = new URLSearchParams();
    body.set('items[0][id]', items[0].id);
    body.set('items[0][price]', priceId);
    body.set('proration_behavior', 'create_prorations');
    // The subscription.updated this triggers reads metadata.tier, so it has to
    // name the NEW plan or the webhook writes the old tier straight back.
    body.set('metadata[tier]', tier);
    body.set('metadata[senderId]', senderId);
    if (existing.ref) body.set('metadata[ref]', existing.ref);
    const keepSource = source || existing.source;
    if (keepSource) body.set('metadata[source]', String(keepSource).slice(0, 40));
    const updated = await stripeFetch(env, 'POST', `/subscriptions/${existing.stripeSubscriptionId}`, body);
    if (!updated || !updated.id) return null;

    // Write entitlement now instead of waiting on the webhook: the browser is
    // being redirected to the dashboard in the next few hundred milliseconds
    // and the plan they just paid for has to be live when they land.
    const storage = pickStorage(env);
    const record = {
      ...existing,
      tier,
      status: updated.status || existing.status,
      stripeSubscriptionId: updated.id,
      priceId: updated.items?.data?.[0]?.price?.id || priceId,
      currentPeriodEnd: updated.current_period_end
        ? new Date(updated.current_period_end * 1000).toISOString()
        : existing.currentPeriodEnd,
      cancelAt: updated.cancel_at
        ? new Date(updated.cancel_at * 1000).toISOString()
        : null,
      planChangedFrom: existing.tier,
      planChangedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    await storage.put(`sub:${senderId}`, JSON.stringify(record));
    await recordSubForMetrics(env, senderId, record).catch(() => {});
    return {
      planChanged: true,
      from: existing.tier,
      tier,
      url: `${origin}/dashboard/?checkout=success&tier=${encodeURIComponent(tier)}`,
    };
  } catch (err) {
    console.error('[stripe] in-place plan change failed:', err && err.message);
    return null;
  }
}

/**
 * Create a Customer Portal session so the user can manage billing.
 * Returns the portal URL. Caller validates the senderId out of band.
 */
export async function createBillingPortalSession(env, { senderId, returnUrl }) {
  if (!env || typeof env.STRIPE_SECRET_KEY !== 'string') {
    throw stripeError('not_configured', 'Stripe is not configured on this deployment.');
  }
  const sub = await getSubscription(env, senderId);
  if (!sub.stripeCustomerId) {
    throw stripeError('no_customer', 'No Stripe customer is associated with this account.');
  }
  const body = new URLSearchParams();
  body.set('customer', sub.stripeCustomerId);
  body.set('return_url', returnUrl);
  const res = await stripeFetch(env, 'POST', '/billing_portal/sessions', body);
  if (!res.url) throw stripeError('portal_create_failed', res.error?.message || 'Portal session failed.');
  return { url: res.url };
}

// ---- Webhook ---------------------------------------------------------------

/**
 * Verify Stripe-Signature header against the raw request body. Stripe's
 * scheme: header is `t=<unix>,v1=<hex>,...`. We HMAC-SHA256 of
 * "<unix>.<body>" with the webhook secret and constant-time compare.
 *
 * Returns true if any v1 signature matches; false otherwise. Replay
 * window: 5 minutes by default.
 */
export async function verifyStripeSignature({ payload, header, secret, toleranceSeconds = 300 }) {
  if (!header || !secret) return false;
  const parts = String(header).split(',').map(p => p.trim());
  let timestamp = null;
  const sigs = [];
  for (const p of parts) {
    const [k, v] = p.split('=');
    if (k === 't') timestamp = v;
    else if (k === 'v1') sigs.push(v);
  }
  if (!timestamp || sigs.length === 0) return false;
  const tsNum = parseInt(timestamp, 10);
  if (!Number.isFinite(tsNum)) return false;
  const drift = Math.abs(Math.floor(Date.now() / 1000) - tsNum);
  if (drift > toleranceSeconds) return false;

  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    enc.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sigBytes = await crypto.subtle.sign('HMAC', key, enc.encode(`${timestamp}.${payload}`));
  const expected = Array.from(new Uint8Array(sigBytes), b => b.toString(16).padStart(2, '0')).join('');
  for (const candidate of sigs) {
    if (constantTimeEquals(expected, candidate)) return true;
  }
  return false;
}

/**
 * Reasons a miss is RECOVERABLE, meaning the event was well formed and we
 * simply did not hold the state to apply it yet. The commonest is the race
 * between checkout.session.completed (which writes stripe:customer:<id>) and
 * the subscription event that needs that mapping to resolve a sender.
 *
 * Stripe's retry ladder is the only recovery path here, and it runs on a 5xx
 * and nothing else, so applyStripeEvent throws for these instead of returning
 * a tidy result the caller answers 200 to. A 200 spends the retry budget on
 * nothing and the customer stays unentitled forever.
 */
const RETRYABLE_MISSES = new Set([
  'no_sender_for_customer',
  'missing_link_fields',
  'unknown_tier',
]);

/**
 * Apply a verified webhook event to KV. Idempotent: replaying the same
 * event id is a no-op (we record processed event ids with a short TTL).
 *
 * Throws on a recoverable miss (see RETRYABLE_MISSES). The webhook route turns
 * a throw into a 500, which is what asks Stripe to redeliver.
 */
export async function applyStripeEvent(env, event) {
  if (!event || typeof event !== 'object') return { applied: false, reason: 'invalid_event' };
  const storage = pickStorage(env);
  const eventId = event.id;
  if (eventId) {
    const seen = await storage.get(`stripe:event:${eventId}`);
    if (seen) return { applied: false, reason: 'duplicate' };
  }

  const type = event.type;
  const obj = event.data && event.data.object;
  if (!obj) return { applied: false, reason: 'no_object' };
  // Stripe's own emission time. Neither webhook delivery nor KV gives us any
  // ordering guarantee, so this is the only way to tell a fresh subscription
  // event from a redelivery of an older one.
  const eventCreated = Number.isFinite(event.created) ? event.created : null;

  // Apply BEFORE marking seen. All our handlers are idempotent
  // (sub:<senderId> is an upsert; the founding-number assignment is gated
  // on hasFoundingNumber). If apply succeeds but the mark-seen write
  // fails, Stripe will retry and we will re-apply safely. If we marked
  // seen first and apply failed, we would silently drop the event.
  let result;
  switch (type) {
    case 'checkout.session.completed':
      result = await onCheckoutCompleted(env, obj);
      break;
    case 'customer.subscription.created':
    case 'customer.subscription.updated':
      result = await onSubscriptionUpserted(env, obj, eventCreated);
      break;
    case 'customer.subscription.deleted':
      result = await onSubscriptionDeleted(env, obj, eventCreated);
      break;
    case 'invoice.payment_failed':
      result = await onPaymentFailed(env, obj);
      break;
    case 'charge.refunded':
      result = await onChargeReversed(env, obj, 'refund');
      break;
    case 'charge.dispute.created':
      result = await onChargeReversed(env, obj, 'dispute');
      break;
    default:
      return { applied: false, reason: `unhandled:${type}` };
  }

  // ONLY a real apply earns the marker. Marking a failed event processed makes
  // the failure permanent: the marker suppresses the redelivery that would have
  // fixed it, so the customer who paid never gets their tier.
  if (eventId && result && result.applied === true) {
    // TTL outlasts Stripe's 3-day retry window with safety margin.
    try {
      await storage.put(`stripe:event:${eventId}`, '1', { expirationTtl: 14 * 24 * 3600 });
    } catch (err) {
      console.error('[stripe] event-seen mark failed:', err && err.message);
    }
  }

  if (result && result.applied !== true && RETRYABLE_MISSES.has(result.reason)) {
    throw stripeError('event_retryable', result.reason);
  }

  return result;
}

// ---- Event handlers --------------------------------------------------------

async function onCheckoutCompleted(env, session) {
  const senderId = session.client_reference_id || (session.metadata && session.metadata.senderId);
  const tier = session.metadata && session.metadata.tier;
  const customerId = session.customer;
  const subId = session.subscription;
  const ref = session.metadata && session.metadata.ref;
  if (!senderId || !tier || !customerId) {
    return { applied: false, reason: 'missing_link_fields' };
  }
  // A tier we do not define is not a tier. metadata[tier] is set at checkout
  // and echoed back here, and every entitlement check asks only "is it not
  // free", so writing an arbitrary string granted unlimited docs under a plan
  // name that exists nowhere in the code and bills nothing.
  if (!TIERS[tier]) {
    return { applied: false, reason: 'unknown_tier' };
  }

  // Affiliate attribution. Credit the conversion exactly once per
  // (code, customer) pair. Done lazily, if the import fails for any
  // reason (cycle, missing module in test env), we don't block the
  // main subscription record write.
  if (ref) {
    try {
      const { recordConversion } = await import('./affiliate.js');
      // Pass the buyer's senderId so the affiliate module can block a
      // self-referral (buying through your own code).
      const conv = await recordConversion(env, ref.toLowerCase(), customerId, tier, senderId,
        session.customer_details?.email || session.customer_email || null);
      // Sale alert. Guarded per conversion (code + stripe customer) so a
      // webhook redelivery cannot double-send. Never blocks the webhook.
      if (conv && conv.ok && !conv.alreadyCounted) {
        try {
          const [{ sendSaleAlert }, aff] = await Promise.all([
            import('./ambassador-email.js'),
            import('./affiliate.js'),
          ]);
          const rec = await aff.getCodeRecord(env, ref.toLowerCase());
          if (rec && rec.email) {
            const base = (env && env.CYBERSYGN_APP_URL) || 'https://cybersygn.io';
            await sendSaleAlert(env, {
              to: rec.email,
              code: rec.code,
              guardKey: `${rec.code}:${customerId}`,
              amount: conv.payoutUsd,
              bonuses: conv.bonuses || [],
              tierLabel: aff.tierFor(rec.conversions || 0).label,
              totalSales: rec.conversions || 0,
              dashUrl: `${base}/ambassador/`,
            });
          }
        } catch (e) { console.error('[ambassador] sale alert failed:', e && e.message); }
      }
    } catch (e) {
      console.error('[stripe] affiliate credit failed:', e && e.message);
    }
  }
  const storage = pickStorage(env);

  // Add-ons (extra seats, white-label) ATTACH to an existing plan. They must
  // never be written into sub:<senderId>, or they would replace the buyer's
  // real plan with the add-on (and hand a planless buyer an unlimited
  // entitlement for the price of an add-on). Record them under their own key.
  if (TIERS[tier] && TIERS[tier].addon) {
    const base = await getSubscription(env, senderId);
    const hasPlan = !!(base && base.status === 'active' && base.tier !== 'free'
      && !(TIERS[base.tier] && TIERS[base.tier].addon));
    let addons = {};
    try { addons = JSON.parse((await storage.get(`addons:${senderId}`)) || '{}') || {}; } catch (e) {}
    addons[tier] = {
      stripeSubscriptionId: subId || null,
      qty: (session.metadata && parseInt(session.metadata.quantity, 10)) || 1,
      activatedAt: new Date().toISOString(),
      orphan: hasPlan ? undefined : true,
    };
    await storage.put(`addons:${senderId}`, JSON.stringify(addons));
    return { applied: true, addon: tier, orphan: !hasPlan };
  }

  // Pull the subscription so we have the canonical status and renewal date.
  let subDetails = null;
  if (subId) {
    try {
      subDetails = await stripeFetch(env, 'GET', `/subscriptions/${subId}`, null);
    } catch (err) {
      console.error('[stripe] sub fetch failed in webhook:', err && err.message);
    }
  }

  const record = {
    senderId,
    tier,
    status: subDetails?.status || 'active',
    stripeCustomerId: customerId,
    stripeSubscriptionId: subId || null,
    // Checkout email, kept for owner support and GDPR-export verification
    // (the export flow compares a SHA-256 of it, never the cleartext).
    email: session.customer_details?.email || session.customer_email || null,
    priceId: subDetails?.items?.data?.[0]?.price?.id || null,
    currentPeriodEnd: subDetails?.current_period_end
      ? new Date(subDetails.current_period_end * 1000).toISOString()
      : null,
    // First-touch marketing source, set at checkout for MRR attribution.
    source: (session.metadata && session.metadata.source) || null,
    // Affiliate code that earned this customer, kept so a later refund/dispute
    // can reverse the commission (clawback) without scanning.
    ref: (ref && typeof ref === 'string') ? ref.toLowerCase() : null,
    activatedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  if (tier === 'founding' && !await hasFoundingNumber(env, senderId)) {
    const taken = await getFoundingCount(env);
    if (taken < FOUNDING_CAP) {
      record.foundingNumber = taken + 1;
      await storage.put('meta:founding-count', String(taken + 1));
    } else {
      // Race: someone bought the last spot while this one was processing.
      // We keep the subscription active (Stripe charged them) but flag
      // for manual review.
      record.foundingNumber = null;
      record.foundingOverflow = true;
    }
  }

  // Lifetime ($299 one-time, capped at LIFETIME_CAP). One-time payment has no
  // subscription to gate on, so idempotency rides a per-sender KV marker, webhook
  // retries / duplicate checkout.session.completed events must never double-count.
  // Without this the public "50 of 50 spots left" counter stays frozen at 0 and
  // the cap is unenforced (the counter + cap gate READ meta:lifetime-count, which
  // nothing was writing). Same KV non-atomicity tradeoff as the founding branch.
  if (tier === 'lifetime') {
    const claimedMarker = `meta:lifetime-claimed:${senderId}`;
    const already = await storage.get(claimedMarker);
    if (!already) {
      const taken = await getLifetimeCount(env);
      if (taken < LIFETIME_CAP) {
        record.lifetimeNumber = taken + 1;
        await storage.put('meta:lifetime-count', String(taken + 1));
      } else {
        record.lifetimeNumber = null;
        record.lifetimeOverflow = true;
      }
      await storage.put(claimedMarker, '1');
    }
  }

  await storage.put(`sub:${senderId}`, JSON.stringify(record));
  await recordSubForMetrics(env, senderId, record).catch(() => {});
  await storage.put(`stripe:customer:${customerId}`, senderId);

  // Origin welcome email. Fires exactly once per founding number
  // assignment, gated by a KV marker so webhook retries don't dupe.
  // Failure of the email send doesn't block the rest of the checkout
  // pipeline, webhook returns 200 either way.
  if (tier === 'founding' && typeof record.foundingNumber === 'number' && record.foundingNumber > 0) {
    try {
      await maybeSendOriginWelcome(env, {
        senderId,
        customerId,
        foundingNumber: record.foundingNumber,
        sessionEmail: session.customer_details?.email || session.customer_email || null,
        sessionName: session.customer_details?.name || null,
      });
    } catch (err) {
      console.error('[stripe] origin welcome failed:', err && err.message);
    }
  }

  return { applied: true, senderId, tier, status: record.status };
}

/**
 * Send the welcome-to-Origin email exactly once per founding number.
 * Idempotency lives in a KV marker at meta:origin-welcomed:<senderId>
 * so webhook retries, or multiple checkout-completed events, never
 * dupe-send.
 *
 * Email destination resolution priority:
 *   1. session.customer_details.email (the Stripe Checkout email)
 *   2. fetched Stripe customer.email
 *   3. silently skip
 *
 * The body addresses the customer by name when available.
 */
async function maybeSendOriginWelcome(env, { senderId, customerId, foundingNumber, sessionEmail, sessionName }) {
  const storage = pickStorage(env);
  const markerKey = `meta:origin-welcomed:${senderId}`;
  const existing = await storage.get(markerKey).catch(() => null);
  if (existing) return { skipped: 'already_welcomed' };

  let email = sessionEmail || null;
  let name = sessionName || null;
  if (!email && customerId) {
    try {
      const cust = await stripeFetch(env, 'GET', `/customers/${customerId}`, null);
      email = cust?.email || null;
      name = name || cust?.name || null;
    } catch (e) {}
  }
  if (!email) {
    return { skipped: 'no_email' };
  }
  const firstName = (name || '').split(/\s+/)[0] || '';
  const appUrl = (env && env.CYBERSYGN_APP_URL) || 'https://cybersygn.io';

  // Lazy import to avoid the email-html module loading for non-email paths.
  const { sendOriginWelcome } = await import('./email.js');
  const result = await sendOriginWelcome(env, {
    to: email,
    name: firstName,
    foundingNumber,
    appUrl,
  });

  // Mark as sent regardless of Resend success, a retry on a real send
  // failure could spam, and the dashboard surfaces the Origin card
  // already so the member can still find their wall edit.
  await storage.put(markerKey, new Date().toISOString(), {
    expirationTtl: 60 * 60 * 24 * 365 * 5,
  });
  return { sent: true, deliveryResult: result };
}

/**
 * Should this subscription.* event be ignored for the BASE plan record?
 *
 * Two independent ways an event can be about something other than the plan
 * that currently owns this account's entitlement, both of which used to
 * overwrite it:
 *
 *  - a SIBLING subscription. One Stripe customer can hold several at once, and
 *    a plan change bought through Checkout is exactly how the second one
 *    appears. Acting on the old one's cancellation dropped an account that had
 *    just upgraded straight back to free.
 *  - a STALE redelivery. Stripe retries out of order, so an `updated` emitted
 *    BEFORE a `deleted` can arrive after it. Applying it resurrected paid
 *    access permanently, because nothing downstream ever revisits the record.
 *
 * Returns the reason to skip, or null to apply.
 */
function staleSubscriptionEvent(existing, sub, eventCreated, opts = {}) {
  // The sibling guard applies to DELETES ONLY.
  //
  // On a delete it is essential: cancelling a superseded subscription must not
  // wipe entitlement for a customer who is still paying on the live one.
  //
  // On an upsert it is actively harmful. A brand new subscription always has an
  // id that differs from the bound one, so applying the guard there rejects the
  // customer's CURRENT plan as "not the active subscription": an upgrade would
  // be ignored, the record would keep the old tier, and cancelling the old
  // subscription would then drop them to free. The newest active subscription
  // is by definition the live one, so an upsert rebinds. Ordering is still
  // protected by the timestamp check below.
  // A sibling is any subscription other than the one currently bound.
  const isSibling = !!(existing.stripeSubscriptionId && sub.id && sub.id !== existing.stripeSubscriptionId);
  if (isSibling) {
    // DELETE from a sibling: always ignore. Cancelling a superseded
    // subscription must not wipe entitlement for a customer still paying on
    // the live one.
    if (opts.isDelete) return 'not_the_active_subscription';
    // UPSERT from a sibling: rebind ONLY if the incoming subscription is
    // actually running. The newest RUNNING subscription is by definition the
    // customer's current plan, which is what makes an upgrade record
    // correctly. But a sibling in any other state (canceled, incomplete,
    // unpaid) is not a plan, and letting one through would let a dead
    // subscription's trailing event downgrade a live paying customer.
    // Scoping this guard to deletes alone was exactly that bug.
    const live = sub.status === 'active' || sub.status === 'trialing';
    if (!live) return 'not_the_active_subscription';
  }
  const seen = Number(existing.lastSubEventAt);
  // Strictly older only: Stripe stamps several events in the same second and
  // those are legitimate, in-order deliveries.
  if (Number.isFinite(seen) && Number.isFinite(eventCreated) && eventCreated < seen) {
    return 'older_than_last_applied_event';
  }
  return null;
}

async function onSubscriptionUpserted(env, sub, eventCreated) {
  const storage = pickStorage(env);
  const customerId = sub.customer;
  const senderId = await senderIdForCustomer(env, customerId);
  if (!senderId) return { applied: false, reason: 'no_sender_for_customer' };

  const existing = await getSubscription(env, senderId);
  const tier = (sub.metadata && sub.metadata.tier) || existing.tier || 'free';
  // Same reasoning as onCheckoutCompleted: an undefined tier is not a plan and
  // must never be written into a record that grants unlimited access.
  if (!TIERS[tier]) return { applied: false, reason: 'unknown_tier' };

  // Add-on subscriptions (seat, white-label) live under one Stripe customer
  // alongside the base plan. Their lifecycle events must NEVER touch
  // sub:<senderId>, or the add-on's event overwrites the buyer's real plan
  // (same guard onCheckoutCompleted applies at purchase time). Update the
  // add-on's own record and stop.
  if (TIERS[tier] && TIERS[tier].addon) {
    let addons = {};
    try { addons = JSON.parse((await storage.get(`addons:${senderId}`)) || '{}') || {}; } catch (e) {}
    addons[tier] = {
      ...(addons[tier] || {}),
      stripeSubscriptionId: sub.id,
      status: sub.status,
      qty: sub.items?.data?.[0]?.quantity || (addons[tier] && addons[tier].qty) || 1,
      updatedAt: new Date().toISOString(),
    };
    await storage.put(`addons:${senderId}`, JSON.stringify(addons));
    return { applied: true, addon: tier, status: sub.status };
  }

  // Guard the base plan only. Add-ons keep their own record and their own
  // lifecycle, so folding their event times into the base plan's high-water
  // mark would let an add-on event silence a real plan event.
  const skip = staleSubscriptionEvent(existing, sub, eventCreated);
  if (skip) return { applied: true, senderId, noop: skip };

  const next = {
    ...existing,
    senderId,
    tier,
    status: sub.status,
    stripeCustomerId: customerId,
    stripeSubscriptionId: sub.id,
    // Preserve first-touch source: prefer the value on the subscription
    // metadata, else keep whatever the original checkout recorded.
    source: (sub.metadata && sub.metadata.source) || existing.source || null,
    ref: (sub.metadata && sub.metadata.ref) || existing.ref || null,
    priceId: sub.items?.data?.[0]?.price?.id || existing.priceId || null,
    currentPeriodEnd: sub.current_period_end
      ? new Date(sub.current_period_end * 1000).toISOString()
      : existing.currentPeriodEnd,
    cancelAt: sub.cancel_at
      ? new Date(sub.cancel_at * 1000).toISOString()
      : null,
    // High-water mark for the ordering guard above.
    lastSubEventAt: Number.isFinite(eventCreated) ? eventCreated : existing.lastSubEventAt || null,
    updatedAt: new Date().toISOString(),
  };
  await storage.put(`sub:${senderId}`, JSON.stringify(next));
  await recordSubForMetrics(env, senderId, next).catch(() => {});
  return { applied: true, senderId, tier, status: sub.status };
}

async function onSubscriptionDeleted(env, sub, eventCreated) {
  const storage = pickStorage(env);
  const customerId = sub.customer;
  const senderId = await senderIdForCustomer(env, customerId);
  if (!senderId) return { applied: false, reason: 'no_sender_for_customer' };

  // Canceling ONLY an add-on must not downgrade the base plan to free.
  // Remove the add-on's own record and leave sub:<senderId> untouched.
  const deletedTier = sub.metadata && sub.metadata.tier;
  if (deletedTier && TIERS[deletedTier] && TIERS[deletedTier].addon) {
    let addons = {};
    try { addons = JSON.parse((await storage.get(`addons:${senderId}`)) || '{}') || {}; } catch (e) {}
    delete addons[deletedTier];
    await storage.put(`addons:${senderId}`, JSON.stringify(addons));
    return { applied: true, addon: deletedTier, removed: true };
  }

  const existing = await getSubscription(env, senderId);
  // The one that matters. Cancelling ANY of a customer's subscriptions used to
  // wipe entitlement for the whole customer, and the upgrade path is what
  // creates the second subscription, so upgrading and then losing the old plan
  // downgraded a paying customer to free.
  const skip = staleSubscriptionEvent(existing, sub, eventCreated, { isDelete: true });
  if (skip) return { applied: true, senderId, noop: skip };

  const next = {
    ...existing,
    tier: 'free',
    status: 'canceled',
    // UNBIND the dead subscription. The record spread above carries
    // stripeSubscriptionId forward, and staleSubscriptionEvent refuses any
    // event whose sub.id differs from it. Leaving a cancelled record pointing
    // at the cancelled subscription therefore means the customer's NEXT
    // subscription is rejected as "not_the_active_subscription" forever: they
    // pay and never regain access. A cancelled record owns no live
    // subscription, so it must claim none.
    stripeSubscriptionId: null,
    canceledSubscriptionId: existing.stripeSubscriptionId || null,
    canceledAt: new Date().toISOString(),
    lastSubEventAt: Number.isFinite(eventCreated) ? eventCreated : existing.lastSubEventAt || null,
    updatedAt: new Date().toISOString(),
  };
  await storage.put(`sub:${senderId}`, JSON.stringify(next));
  await recordSubForMetrics(env, senderId, next).catch(() => {});
  return { applied: true, senderId, tier: 'free', status: 'canceled' };
}

// Best-effort risk counters so the owner panel can surface at-risk revenue
// without scanning. Non-atomic (same KV tradeoff as every other counter here).
async function bumpRisk(env, field, senderId) {
  try {
    const storage = pickStorage(env);
    let risk = {};
    try { risk = JSON.parse((await storage.get('metrics:risk')) || '{}') || {}; } catch (e) {}
    risk[field] = (risk[field] || 0) + 1;
    risk.updatedAt = new Date().toISOString();
    if (senderId) {
      risk.recent = Array.isArray(risk.recent) ? risk.recent : [];
      risk.recent.unshift({ field, senderId, at: risk.updatedAt });
      risk.recent = risk.recent.slice(0, 20);
    }
    await storage.put('metrics:risk', JSON.stringify(risk));
  } catch (e) { /* best-effort */ }
}

// invoice.payment_failed: a renewal charge failed. Mark the subscription
// past_due (Stripe will retry per its dunning settings and eventually cancel).
// Surfaces dunning risk without changing entitlement prematurely.
async function onPaymentFailed(env, invoice) {
  const storage = pickStorage(env);
  const customerId = invoice.customer;
  const senderId = await senderIdForCustomer(env, customerId);
  if (!senderId) return { applied: false, reason: 'no_sender_for_customer' };
  const existing = await getSubscription(env, senderId);
  const next = { ...existing, status: 'past_due', pastDueAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
  await storage.put(`sub:${senderId}`, JSON.stringify(next));
  await recordSubForMetrics(env, senderId, next).catch(() => {});
  await bumpRisk(env, 'failedPayments', senderId);
  return { applied: true, senderId, status: 'past_due' };
}

// charge.refunded / charge.dispute.created: money went back. Flag the record
// and claw back any affiliate commission earned on this customer.
async function onChargeReversed(env, charge, kind) {
  const storage = pickStorage(env);
  const customerId = charge.customer;
  if (!customerId) return { applied: false, reason: 'no_customer' };
  const senderId = await senderIdForCustomer(env, customerId);
  await bumpRisk(env, kind === 'dispute' ? 'disputes' : 'refunds', senderId || null);
  // RETRY, do not silently succeed. Every sibling handler returns this miss
  // (onPaymentFailed and the two subscription handlers all do), and
  // 'no_sender_for_customer' is in RETRYABLE_MISSES so applyStripeEvent throws
  // and the webhook is redelivered once the customer mapping exists.
  //
  // Wrapping the whole body in `if (senderId)` instead meant a refund that
  // arrived BEFORE its conversion was credited returned applied:true, was
  // marked processed, and never came back. The clawback below then never ran,
  // leaving an affiliate bounty paid on money that had been given back.
  if (!senderId) return { applied: false, reason: 'no_sender_for_customer' };
  {
    const existing = await getSubscription(env, senderId);
    const next = { ...existing, [kind === 'dispute' ? 'disputedAt' : 'refundedAt']: new Date().toISOString(), updatedAt: new Date().toISOString() };
    await storage.put(`sub:${senderId}`, JSON.stringify(next));
    // Affiliate clawback: reverse the bounty if this customer came via a code.
    if (existing.ref) {
      try {
        const { reverseConversion } = await import('./affiliate.js');
        await reverseConversion(env, String(existing.ref).toLowerCase(), customerId, kind);
      } catch (e) { console.error('[stripe] affiliate clawback failed:', e && e.message); }
    }
  }
  return { applied: true, kind, senderId: senderId || null };
}

// ---- Helpers ---------------------------------------------------------------

function defaultFree() {
  return { tier: 'free', status: 'inactive', stripeCustomerId: null, stripeSubscriptionId: null };
}

function currentMonthKey() {
  const d = new Date();
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  return `${yyyy}-${mm}`;
}

async function hasFoundingNumber(env, senderId) {
  const sub = await getSubscription(env, senderId);
  return typeof sub.foundingNumber === 'number' && sub.foundingNumber > 0;
}

async function maybeExistingCustomer(env, senderId) {
  if (!senderId) return null;
  const sub = await getSubscription(env, senderId);
  return sub.stripeCustomerId || null;
}

async function senderIdForCustomer(env, customerId) {
  if (!customerId) return null;
  const storage = pickStorage(env);
  return await storage.get(`stripe:customer:${customerId}`);
}

export { stripeFetch };

async function stripeFetch(env, method, path, body) {
  const url = `${STRIPE_API}${path}`;
  const init = {
    method,
    headers: {
      authorization: `Bearer ${env.STRIPE_SECRET_KEY}`,
      'stripe-version': '2024-12-18.acacia',
    },
  };
  if (body) {
    init.headers['content-type'] = 'application/x-www-form-urlencoded';
    init.body = body.toString();
  }
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), 10_000);
  let res;
  try {
    res = await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(id);
  }
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw stripeError('stripe_api_error', json.error?.message || `Stripe ${res.status}`);
  }
  return json;
}

function stripeError(code, message) {
  const e = new Error(message);
  e.code = code;
  return e;
}

function constantTimeEquals(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/**
 * Storage shim over the shared storage abstraction. Everything read or
 * written here is already a string or serialized JSON blob. Routing
 * through getStorage keeps memory-mode (local dev, tests) on the SAME
 * store as the rest of the Worker; a sub record seeded anywhere is
 * visible everywhere, exactly as it is in production KV.
 */
function pickStorage(env) {
  const docs = getStorage(env).docs;
  return {
    async get(key) { return docs.get(key); },
    async put(key, value, opts) { return docs.put(key, value, opts || {}); },
  };
}
