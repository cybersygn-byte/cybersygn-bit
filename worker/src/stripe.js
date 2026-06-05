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

const STRIPE_API = 'https://api.stripe.com/v1';
const FOUNDING_CAP = 100;

export const TIERS = {
  free:     { id: 'free',     docs: 3,        priceEnv: null,                    label: 'Free' },
  solo:     { id: 'solo',     docs: Infinity, priceEnv: 'STRIPE_PRICE_SOLO',     label: 'Solo' },
  founding: { id: 'founding', docs: Infinity, priceEnv: 'STRIPE_PRICE_FOUNDING', label: 'Founding' },
  team:     { id: 'team',     docs: Infinity, priceEnv: 'STRIPE_PRICE_TEAM',     label: 'Team' },
};

// ---- Public API surface called from index.js ------------------------------

/**
 * Read the current subscription record for a senderId. Returns a normalized
 * record: { tier, status, stripeCustomerId?, stripeSubscriptionId?, ... }.
 * Free-tier is the implicit default.
 */
export async function getSubscription(env, senderId) {
  if (!senderId) return defaultFree();
  const storage = pickStorage(env);
  const raw = await storage.get(`sub:${senderId}`);
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
 * exist or isn't a Origin member.
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
export async function createCheckoutSession(env, { tier, senderId, email, successUrl, cancelUrl, origin }) {
  if (!env || typeof env.STRIPE_SECRET_KEY !== 'string' || !env.STRIPE_SECRET_KEY.startsWith('sk_')) {
    throw stripeError('not_configured', 'Stripe is not configured on this deployment.');
  }
  const tierConf = TIERS[tier];
  if (!tierConf || !tierConf.priceEnv) {
    throw stripeError('invalid_tier', 'That tier is not purchasable.');
  }
  const priceId = env[tierConf.priceEnv];
  if (typeof priceId !== 'string' || !priceId.startsWith('price_')) {
    throw stripeError('missing_price', `Price for "${tier}" is not configured.`);
  }
  if (tier === 'founding') {
    const taken = await getFoundingCount(env);
    if (taken >= FOUNDING_CAP) {
      throw stripeError('founding_full', 'All 100 founding spots are taken. Pick Solo or Team.');
    }
  }

  const reUseCustomer = await maybeExistingCustomer(env, senderId);

  const body = new URLSearchParams();
  body.set('mode', 'subscription');
  body.set('line_items[0][price]', priceId);
  body.set('line_items[0][quantity]', '1');
  body.set('success_url', successUrl || `${origin}/dashboard/?checkout=success&session_id={CHECKOUT_SESSION_ID}`);
  body.set('cancel_url', cancelUrl || `${origin}/?checkout=canceled`);
  body.set('client_reference_id', senderId || '');
  body.set('allow_promotion_codes', 'true');
  body.set('billing_address_collection', 'auto');
  body.set('metadata[tier]', tier);
  body.set('metadata[senderId]', senderId || '');
  body.set('subscription_data[metadata][tier]', tier);
  body.set('subscription_data[metadata][senderId]', senderId || '');
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
 * Apply a verified webhook event to KV. Idempotent: replaying the same
 * event id is a no-op (we record processed event ids with a short TTL).
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
      result = await onSubscriptionUpserted(env, obj);
      break;
    case 'customer.subscription.deleted':
      result = await onSubscriptionDeleted(env, obj);
      break;
    default:
      return { applied: false, reason: `unhandled:${type}` };
  }

  if (eventId) {
    // TTL outlasts Stripe's 3-day retry window with safety margin.
    try {
      await storage.put(`stripe:event:${eventId}`, '1', { expirationTtl: 14 * 24 * 3600 });
    } catch (err) {
      console.error('[stripe] event-seen mark failed:', err && err.message);
    }
  }

  return result;
}

// ---- Event handlers --------------------------------------------------------

async function onCheckoutCompleted(env, session) {
  const senderId = session.client_reference_id || (session.metadata && session.metadata.senderId);
  const tier = session.metadata && session.metadata.tier;
  const customerId = session.customer;
  const subId = session.subscription;
  if (!senderId || !tier || !customerId) {
    return { applied: false, reason: 'missing_link_fields' };
  }
  const storage = pickStorage(env);

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
    priceId: subDetails?.items?.data?.[0]?.price?.id || null,
    currentPeriodEnd: subDetails?.current_period_end
      ? new Date(subDetails.current_period_end * 1000).toISOString()
      : null,
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

  await storage.put(`sub:${senderId}`, JSON.stringify(record));
  await storage.put(`stripe:customer:${customerId}`, senderId);

  // Origin welcome email. Fires exactly once per founding number
  // assignment, gated by a KV marker so webhook retries don't dupe.
  // Failure of the email send doesn't block the rest of the checkout
  // pipeline — webhook returns 200 either way.
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
 * so webhook retries — or multiple checkout-completed events — never
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

  // Mark as sent regardless of Resend success — a retry on a real send
  // failure could spam, and the dashboard surfaces the Origin card
  // already so the member can still find their wall edit.
  await storage.put(markerKey, new Date().toISOString(), {
    expirationTtl: 60 * 60 * 24 * 365 * 5,
  });
  return { sent: true, deliveryResult: result };
}

async function onSubscriptionUpserted(env, sub) {
  const storage = pickStorage(env);
  const customerId = sub.customer;
  const senderId = await senderIdForCustomer(env, customerId);
  if (!senderId) return { applied: false, reason: 'no_sender_for_customer' };

  const existing = await getSubscription(env, senderId);
  const tier = (sub.metadata && sub.metadata.tier) || existing.tier || 'free';
  const next = {
    ...existing,
    senderId,
    tier,
    status: sub.status,
    stripeCustomerId: customerId,
    stripeSubscriptionId: sub.id,
    priceId: sub.items?.data?.[0]?.price?.id || existing.priceId || null,
    currentPeriodEnd: sub.current_period_end
      ? new Date(sub.current_period_end * 1000).toISOString()
      : existing.currentPeriodEnd,
    cancelAt: sub.cancel_at
      ? new Date(sub.cancel_at * 1000).toISOString()
      : null,
    updatedAt: new Date().toISOString(),
  };
  await storage.put(`sub:${senderId}`, JSON.stringify(next));
  return { applied: true, senderId, tier, status: sub.status };
}

async function onSubscriptionDeleted(env, sub) {
  const storage = pickStorage(env);
  const customerId = sub.customer;
  const senderId = await senderIdForCustomer(env, customerId);
  if (!senderId) return { applied: false, reason: 'no_sender_for_customer' };
  const existing = await getSubscription(env, senderId);
  const next = {
    ...existing,
    tier: 'free',
    status: 'canceled',
    canceledAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  await storage.put(`sub:${senderId}`, JSON.stringify(next));
  return { applied: true, senderId, tier: 'free', status: 'canceled' };
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
 * Storage shim. We use raw KV calls here (not the typed storage.js
 * wrapper) because every value we read or write is already a string or
 * a serialized JSON blob. Falls back to an in-memory Map when KV is
 * unbound so local dev and tests run without configuration.
 */
const memoryStripe = new Map();

function pickStorage(env) {
  const ns = env && env.CYBERSYGN_DOCS;
  if (ns && typeof ns.get === 'function') {
    return {
      async get(key) { return ns.get(key); },
      async put(key, value, opts) { return ns.put(key, value, opts || {}); },
    };
  }
  return {
    async get(key) { return memoryStripe.get(key) || null; },
    async put(key, value) { memoryStripe.set(key, value); },
  };
}
