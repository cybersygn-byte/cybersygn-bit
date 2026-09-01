/**
 * Stripe webhook ordering + affiliate reversal regression tests.
 *
 * Every case here is a defect that shipped:
 *  - cancelling ONE of a customer's subscriptions wiped entitlement for the
 *    whole customer, and the upgrade path is what creates the second one
 *  - a stale customer.subscription.updated delivered after .deleted
 *    permanently resurrected paid access
 *  - events that failed to apply were marked processed, which suppressed the
 *    Stripe retry that was the only recovery path
 *  - any metadata.tier string was written into the subscription record and
 *    granted unlimited access under a plan name that bills nothing
 *  - a refund delivered before its conversion left an unearned bounty that
 *    nothing ever reversed
 *
 * No network. Stripe is a local fetch mock; KV is an in-memory map.
 */
import assert from 'node:assert/strict';
import * as stripe from '../worker/src/stripe.js';
import { registerAffiliate, recordConversion, reverseConversion, getCodeRecord } from '../worker/src/affiliate.js';

let pass = 0, fail = 0;
const results = [];
async function t(name, fn) {
  try { await fn(); pass++; results.push(`  OK   ${name}`); }
  catch (e) { fail++; results.push(`  FAIL ${name}\n         ${String(e && e.message).split('\n')[0]}`); }
}

// ---- harness ---------------------------------------------------------------

function makeKV() {
  const map = new Map();
  return {
    map,
    async get(key, type) {
      const v = map.get(key);
      if (v == null) return null;
      return type === 'json' ? JSON.parse(v) : v;
    },
    async put(key, value) { map.set(key, typeof value === 'string' ? value : JSON.stringify(value)); },
    async delete(key) { map.delete(key); },
    async list({ prefix = '', limit = 1000 } = {}) {
      return { keys: [...map.keys()].filter(k => k.startsWith(prefix)).slice(0, limit).map(name => ({ name })) };
    },
  };
}

function makeEnv(extra = {}) {
  return {
    CYBERSYGN_DOCS: makeKV(),
    CYBERSYGN_PDFS: makeKV(),
    STRIPE_SECRET_KEY: 'sk_test_fake',
    STRIPE_WEBHOOK_SECRET: 'whsec_test',
    STRIPE_PRICE_SOLO: 'price_solo',
    STRIPE_PRICE_PRO: 'price_pro',
    STRIPE_PRICE_FOUNDING: 'price_founding',
    ...extra,
  };
}

const REAL_FETCH = globalThis.fetch;
/** Route Stripe REST calls to a local table. Returns the recorded call log. */
function mockStripe(routes) {
  const calls = [];
  globalThis.fetch = async (url, init) => {
    const u = String(url);
    const method = (init && init.method) || 'GET';
    const body = init && init.body ? Object.fromEntries(new URLSearchParams(init.body)) : null;
    calls.push({ method, url: u, body });
    for (const r of routes) {
      if (r.method === method && u.includes(r.path)) {
        return new Response(JSON.stringify(typeof r.json === 'function' ? r.json(body) : r.json),
          { status: r.status || 200, headers: { 'content-type': 'application/json' } });
      }
    }
    return new Response(JSON.stringify({ error: { message: `unmocked ${method} ${u}` } }), { status: 404 });
  };
  return calls;
}
function restoreFetch() { globalThis.fetch = REAL_FETCH; }

let evtN = 0;
function evt(type, object, { id, created } = {}) {
  return { id: id || `evt_${++evtN}`, type, created, data: { object } };
}
function session(o = {}) {
  return {
    id: o.sid || 'cs_1',
    client_reference_id: 'senderId' in o ? o.senderId : 'snd_1',
    customer: 'customer' in o ? o.customer : 'cus_1',
    subscription: o.sub === undefined ? null : o.sub,
    metadata: { tier: o.tier === undefined ? 'solo' : o.tier, senderId: o.senderId || 'snd_1', ref: o.ref },
    customer_details: { email: o.email || 'buyer@example.com' },
  };
}
function subObj(o = {}) {
  return {
    id: o.id || 'sub_1',
    customer: o.customer || 'cus_1',
    status: o.status || 'active',
    metadata: { tier: o.tier || 'solo' },
    items: { data: [{ id: o.itemId || 'si_1', price: { id: o.priceId || 'price_solo' } }] },
    current_period_end: Math.floor(Date.now() / 1000) + 30 * 86400,
    cancel_at: o.cancel_at || null,
  };
}
const rec = async (env, senderId = 'snd_1') =>
  JSON.parse((await env.CYBERSYGN_DOCS.get(`sub:${senderId}`)) || 'null');
const seen = async (env, id) => env.CYBERSYGN_DOCS.get(`stripe:event:${id}`);

/** Assert applyStripeEvent throws, and return the thrown error. */
async function throws(env, event) {
  try {
    const r = await stripe.applyStripeEvent(env, event);
    throw new Error(`expected a throw, got ${JSON.stringify(r)}`);
  } catch (e) {
    if (/^expected a throw/.test(e.message)) throw e;
    return e;
  }
}

// ---------------------------------------------------------------- siblings
await t('BLOCKER: cancelling the OLD subscription after an upgrade keeps access', async () => {
  const env = makeEnv();
  mockStripe([
    { method: 'GET', path: '/subscriptions/sub_old', json: subObj({ id: 'sub_old' }) },
    { method: 'GET', path: '/subscriptions/sub_new', json: subObj({ id: 'sub_new', priceId: 'price_pro' }) },
  ]);
  try {
    await stripe.applyStripeEvent(env, evt('checkout.session.completed', session({ tier: 'solo', sub: 'sub_old' })));
    // The upgrade path opens a SECOND Stripe subscription on the same customer.
    await stripe.applyStripeEvent(env, evt('checkout.session.completed', session({ sid: 'cs_2', tier: 'pro', sub: 'sub_new' })));
  } finally { restoreFetch(); }
  const before = await rec(env);
  assert.equal(before.tier, 'pro');
  assert.equal(before.stripeSubscriptionId, 'sub_new');

  // Stripe cancels the superseded subscription. It is not the live one.
  const r = await stripe.applyStripeEvent(env, evt('customer.subscription.deleted', subObj({ id: 'sub_old', tier: 'solo' })));
  assert.equal(r.noop, 'not_the_active_subscription');
  const after = await rec(env);
  assert.equal(after.tier, 'pro', 'tier survived the sibling cancellation');
  assert.equal(after.status, 'active');
  const gate = await stripe.checkFreeTierAllowance(env, 'snd_1');
  assert.equal(gate.remaining, Infinity, 'entitlement survived');
});

await t('cancelling the LIVE subscription still downgrades to free', async () => {
  const env = makeEnv();
  await stripe.applyStripeEvent(env, evt('checkout.session.completed', session({ tier: 'solo', sub: null })));
  // Bind the record to a concrete subscription id first.
  await stripe.applyStripeEvent(env, evt('customer.subscription.updated', subObj({ id: 'sub_live' }), { created: 100 }));
  const r = await stripe.applyStripeEvent(env, evt('customer.subscription.deleted', subObj({ id: 'sub_live' }), { created: 200 }));
  assert.equal(r.applied, true);
  assert.equal((await rec(env)).tier, 'free');
});

await t('a stale sibling UPDATE cannot overwrite the live subscription', async () => {
  const env = makeEnv();
  await stripe.applyStripeEvent(env, evt('checkout.session.completed', session({ tier: 'pro', sub: null })));
  await stripe.applyStripeEvent(env, evt('customer.subscription.updated', subObj({ id: 'sub_new', tier: 'pro' }), { created: 100 }));
  const r = await stripe.applyStripeEvent(env, evt('customer.subscription.updated',
    subObj({ id: 'sub_old', tier: 'solo', status: 'canceled' }), { created: 150 }));
  assert.equal(r.noop, 'not_the_active_subscription');
  const after = await rec(env);
  assert.equal(after.tier, 'pro');
  assert.equal(after.status, 'active');
});

// ---------------------------------------------------------------- ordering
await t('MEDIUM: an update older than the delete cannot resurrect paid access', async () => {
  const env = makeEnv();
  await stripe.applyStripeEvent(env, evt('checkout.session.completed', session({ tier: 'solo', sub: null })));
  await stripe.applyStripeEvent(env, evt('customer.subscription.updated', subObj({ id: 'sub_1' }), { created: 1000 }));
  await stripe.applyStripeEvent(env, evt('customer.subscription.deleted', subObj({ id: 'sub_1' }), { created: 2000 }));
  assert.equal((await rec(env)).tier, 'free');

  const late = await stripe.applyStripeEvent(env, evt('customer.subscription.updated',
    subObj({ id: 'sub_1', status: 'active' }), { created: 1500 }));
  assert.equal(late.noop, 'older_than_last_applied_event');
  const after = await rec(env);
  assert.equal(after.tier, 'free', 'stale update did not resurrect the plan');
  const gate = await stripe.checkFreeTierAllowance(env, 'snd_1');
  assert.notEqual(gate.remaining, Infinity);
});

await t('a genuinely NEWER update after a delete still applies (reactivation)', async () => {
  const env = makeEnv();
  await stripe.applyStripeEvent(env, evt('checkout.session.completed', session({ tier: 'solo', sub: null })));
  await stripe.applyStripeEvent(env, evt('customer.subscription.deleted', subObj({ id: 'sub_1' }), { created: 2000 }));
  const r = await stripe.applyStripeEvent(env, evt('customer.subscription.updated',
    subObj({ id: 'sub_1', status: 'active' }), { created: 3000 }));
  assert.equal(r.applied, true);
  assert.equal((await rec(env)).tier, 'solo');
});

await t('events stamped in the same second are all applied (no strict-greater trap)', async () => {
  const env = makeEnv();
  await stripe.applyStripeEvent(env, evt('checkout.session.completed', session({ tier: 'solo', sub: null })));
  await stripe.applyStripeEvent(env, evt('customer.subscription.updated', subObj({ id: 'sub_1', status: 'trialing' }), { created: 500 }));
  const r = await stripe.applyStripeEvent(env, evt('customer.subscription.updated', subObj({ id: 'sub_1', status: 'active' }), { created: 500 }));
  assert.equal(r.applied, true);
  assert.equal((await rec(env)).status, 'active');
});

// ---------------------------------------------------------------- retries
await t('MEDIUM: an unappliable event is NOT marked seen and asks Stripe to retry', async () => {
  const env = makeEnv();
  const e = evt('customer.subscription.updated', subObj({ customer: 'cus_unknown' }), { id: 'evt_miss', created: 10 });
  const err = await throws(env, e);
  assert.equal(err.message, 'no_sender_for_customer');
  assert.equal(await seen(env, 'evt_miss'), null, 'no marker, so the redelivery can still land');
});

await t('a checkout session with no senderId is retried, not swallowed', async () => {
  const env = makeEnv();
  const e = evt('checkout.session.completed', session({ senderId: null }), { id: 'evt_nolink' });
  // client_reference_id AND metadata.senderId both absent.
  e.data.object.metadata.senderId = '';
  const err = await throws(env, e);
  assert.equal(err.message, 'missing_link_fields');
  assert.equal(await seen(env, 'evt_nolink'), null);
});

await t('a genuinely unhandled event type is accepted once and never marked', async () => {
  const env = makeEnv();
  const r = await stripe.applyStripeEvent(env, evt('invoice.payment_succeeded', { customer: 'cus_1' }, { id: 'evt_unh' }));
  assert.equal(r.applied, false);
  assert.match(String(r.reason), /^unhandled:/);
  assert.equal(await seen(env, 'evt_unh'), null);
});

await t('an applied event IS marked seen and its replay is a no-op', async () => {
  const env = makeEnv();
  const e = evt('checkout.session.completed', session({ sub: null }), { id: 'evt_dup' });
  assert.equal((await stripe.applyStripeEvent(env, e)).applied, true);
  assert.equal(await seen(env, 'evt_dup'), '1');
  const again = await stripe.applyStripeEvent(env, e);
  assert.equal(again.reason, 'duplicate');
});

// ---------------------------------------------------------------- tiers
await t('LOW: an undefined tier never reaches the subscription record', async () => {
  const env = makeEnv();
  const err = await throws(env, evt('checkout.session.completed', session({ tier: 'unobtainium' }), { id: 'evt_bogus' }));
  assert.equal(err.message, 'unknown_tier');
  assert.equal(await rec(env), null, 'no record written');
  assert.equal(await seen(env, 'evt_bogus'), null);
  const gate = await stripe.checkFreeTierAllowance(env, 'snd_1');
  assert.notEqual(gate.remaining, Infinity, 'no unlimited access granted');
});

await t('an undefined tier on a subscription event is refused too', async () => {
  const env = makeEnv();
  await stripe.applyStripeEvent(env, evt('checkout.session.completed', session({ tier: 'solo', sub: null })));
  const err = await throws(env, evt('customer.subscription.updated', subObj({ id: 'sub_1', tier: 'platinum' }), { created: 10 }));
  assert.equal(err.message, 'unknown_tier');
  assert.equal((await rec(env)).tier, 'solo');
});

// ---------------------------------------------------------------- upgrade
await t('a plan change goes through Checkout, it never silently charges the card', async () => {
  // This test previously asserted an IN-PLACE price swap on the existing
  // subscription. That implementation was deliberately reverted: it turned
  // POST /api/checkout/create-session from "mint a Checkout URL the customer
  // reviews" into an immediate, irreversible billing mutation with prorations
  // and no confirmation screen, so clicking Upgrade charged you before you saw
  // a price. maybeChangePlanInPlace still exists in worker/src/stripe.js,
  // unwired, with the reasoning written above it.
  //
  // The entitlement bug that motivated it is fixed properly by
  // staleSubscriptionEvent instead: cancelling a superseded subscription no
  // longer wipes access, and a dead sibling cannot downgrade a live plan.
  //
  // What this now asserts is the DECISION: an upgrade must reach a page where
  // the customer sees the price first.
  const env = makeEnv();
  await stripe.applyStripeEvent(env, evt('checkout.session.completed', session({ tier: 'solo', sub: null })));
  await stripe.applyStripeEvent(env, evt('customer.subscription.updated', subObj({ id: 'sub_1' }), { created: 10 }));

  const calls = mockStripe([
    { method: 'POST', path: '/checkout/sessions', json: { id: 'cs_1', url: 'https://checkout.stripe.com/c/pay/cs_1' } },
  ]);
  try {
    const out = await stripe.createCheckoutSession(env, {
      tier: 'pro', senderId: 'snd_1', origin: 'https://cybersygn.io',
    });
    assert.ok(out && out.url, 'a checkout URL is returned');
    assert.ok(!out.planChanged, 'no silent in-place plan change');
    assert.equal(
      calls.filter(c => c.method === 'POST' && /\/subscriptions\/sub_1$/.test(c.path || c.url || '')).length,
      0,
      'the existing subscription must NOT be mutated without a confirmation step',
    );
  } finally {
    restoreFetch();
  }
});

await t('a first-time buyer still goes through hosted Checkout', async () => {
  const env = makeEnv();
  const calls = mockStripe([
    { method: 'POST', path: '/checkout/sessions', json: { id: 'cs_new', url: 'https://checkout.stripe.com/x' } },
  ]);
  try {
    const out = await stripe.createCheckoutSession(env, { tier: 'pro', senderId: 'fresh', origin: 'https://cybersygn.io' });
    assert.equal(out.sessionId, 'cs_new');
    assert.equal(calls.length, 1);
  } finally { restoreFetch(); }
});

await t('Origin is never swapped in place, its numbered seat only issues at Checkout', async () => {
  const env = makeEnv();
  await stripe.applyStripeEvent(env, evt('checkout.session.completed', session({ tier: 'solo', sub: null })));
  await stripe.applyStripeEvent(env, evt('customer.subscription.updated', subObj({ id: 'sub_1' }), { created: 10 }));
  const calls = mockStripe([
    { method: 'POST', path: '/checkout/sessions', json: { id: 'cs_f', url: 'https://checkout.stripe.com/f' } },
  ]);
  try {
    const out = await stripe.createCheckoutSession(env, { tier: 'founding', senderId: 'snd_1', origin: 'https://cybersygn.io' });
    assert.equal(out.sessionId, 'cs_f');
    assert.equal(calls.filter(c => c.url.includes('/subscriptions/')).length, 0);
  } finally { restoreFetch(); }
});

// ---------------------------------------------------------- affiliate money
async function newCode(env) {
  const r = await registerAffiliate(env, { senderId: 'amb-1', email: 'amb@example.com' });
  return r.code;
}

await t('LOW: a refund delivered BEFORE its conversion blocks the credit', async () => {
  const env = makeEnv();
  const code = await newCode(env);
  const early = await reverseConversion(env, code, 'cus_early', 'refund');
  assert.equal(early.tombstoned, true);

  const conv = await recordConversion(env, code, 'cus_early', 'solo', 'buyer-1', 'buyer@example.com');
  assert.equal(conv.ok, false);
  assert.equal(conv.error, 'reversed_before_credit');
  const r = await getCodeRecord(env, code);
  assert.equal(r.earnedUsd, 0, 'no unearned bounty');
  assert.equal(r.conversions, 0);
});

await t('a redelivered early refund does not debit an uncredited ambassador', async () => {
  const env = makeEnv();
  const code = await newCode(env);
  await reverseConversion(env, code, 'cus_early', 'refund');
  const again = await reverseConversion(env, code, 'cus_early', 'refund');
  assert.equal(again.alreadyHandled, true);
  assert.equal((await getCodeRecord(env, code)).earnedUsd, 0, 'no phantom clawback');
  assert.equal((await getCodeRecord(env, code)).reversals || 0, 0);
});

await t('a normal refund after the sale still reverses exactly once', async () => {
  const env = makeEnv();
  const code = await newCode(env);
  await recordConversion(env, code, 'cus_1', 'solo', 'buyer-1', 'buyer@example.com');
  assert.equal((await getCodeRecord(env, code)).earnedUsd, 20); // $10 bounty + $10 first-sale
  await reverseConversion(env, code, 'cus_1', 'refund');
  assert.equal((await getCodeRecord(env, code)).earnedUsd, 0);
  // A redelivered refund must not double-debit.
  await reverseConversion(env, code, 'cus_1', 'refund');
  assert.equal((await getCodeRecord(env, code)).earnedUsd, 0);
});

// Deterministic shuffle so a failure is reproducible.
function shuffled(arr, seed) {
  const a = arr.slice();
  let s = seed;
  const rnd = () => { s = (s * 1103515245 + 12345) & 0x7fffffff; return s / 0x7fffffff; };
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

for (const n of [1, 5, 10, 25]) {
  for (const order of ['forward', 'reverse', 'random']) {
    await t(`INVARIANT: reversing all ${n} sales in ${order} order returns earnedUsd to $0`, async () => {
      const env = makeEnv();
      const code = await newCode(env);
      const customers = Array.from({ length: n }, (_, i) => `cus_${i}`);
      for (const c of customers) {
        const r = await recordConversion(env, code, c, 'solo', `buyer-${c}`, `${c}@example.com`);
        assert.equal(r.ok, true, `sale ${c} credited`);
      }
      const toReverse = order === 'forward' ? customers
                      : order === 'reverse' ? customers.slice().reverse()
                      : shuffled(customers, n * 7919 + 13);
      for (const c of toReverse) {
        const r = await reverseConversion(env, code, c, 'refund');
        assert.equal(r.ok, true, `reversal ${c} applied`);
      }
      const r = await getCodeRecord(env, code);
      assert.equal(r.earnedUsd, 0, `earnedUsd was ${r.earnedUsd}`);
      assert.equal(r.conversions, 0);
      const ledgerSum = Math.round(((r.ledgerArchivedUsd || 0)
        + (r.ledger || []).reduce((s, e) => s + (Number(e.amount) || 0), 0)) * 100) / 100;
      assert.equal(ledgerSum, 0, `ledger sums to ${ledgerSum}, not earnedUsd`);
    });
  }
}

// ---------------------------------------------------------------- report
console.log('CyberSygn Stripe event-ordering + affiliate reversal tests');
console.log('=========================================================');
for (const line of results) console.log(line);
console.log('---------------------------------------------------------');
console.log(`  ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
