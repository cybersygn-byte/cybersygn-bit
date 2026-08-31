/**
 * FUZZER 6 — money paths. Local harness only. No network, no Stripe.
 *
 *   node scripts/fuzz-money.mjs
 *
 * Imports the real worker modules and drives them against an in-memory KV
 * mock that mirrors the Cloudflare KV surface (get/put/delete + list).
 */
import * as stripe from '../worker/src/stripe.js';
import * as free from '../worker/src/free-tier.js';
import * as aff from '../worker/src/affiliate.js';
import * as amb from '../worker/src/ambassador.js';

// ---- KV mock ---------------------------------------------------------------
function makeKV(opts = {}) {
  const map = new Map();
  const kv = {
    map,
    puts: 0,
    failPut: opts.failPut || (() => false),
    async get(key, type) {
      const v = map.get(key);
      if (v == null) return null;
      if (type === 'json') return JSON.parse(v);
      return v;
    },
    async put(key, value, o) {
      kv.puts++;
      if (kv.failPut(key, value)) throw new Error('kv put forced failure');
      map.set(key, typeof value === 'string' ? value : JSON.stringify(value));
    },
    async delete(key) { map.delete(key); },
    async list({ prefix = '', limit = 1000 } = {}) {
      return { keys: [...map.keys()].filter(k => k.startsWith(prefix)).slice(0, limit).map(name => ({ name })) };
    },
  };
  return kv;
}
function makeEnv(opts = {}) {
  return {
    CYBERSYGN_DOCS: makeKV(opts),
    CYBERSYGN_PDFS: makeKV(),
    STRIPE_SECRET_KEY: 'sk_test_fake',
    STRIPE_WEBHOOK_SECRET: 'whsec_test_secret',
    ...opts.env,
  };
}

let PASS = 0, FAIL = 0;
const failures = [];
function check(name, cond, detail) {
  if (cond) { PASS++; }
  else { FAIL++; failures.push({ name, detail }); console.log('  FAIL  ' + name + (detail ? '\n        ' + detail : '')); }
}
function section(t) { console.log('\n=== ' + t + ' ==='); }

// ---- signature helpers -----------------------------------------------------
async function hmacHex(secret, msg) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(msg));
  return Array.from(new Uint8Array(sig), b => b.toString(16).padStart(2, '0')).join('');
}
async function signHeader(secret, payload, ts = Math.floor(Date.now() / 1000)) {
  return `t=${ts},v1=${await hmacHex(secret, `${ts}.${payload}`)}`;
}

// ---------------------------------------------------------------------------
// 1. WEBHOOK SIGNATURE
// ---------------------------------------------------------------------------
async function testSignature() {
  section('1. Stripe webhook signature verification');
  const secret = 'whsec_test_secret';
  const payload = JSON.stringify({ id: 'evt_1', type: 'customer.subscription.deleted', data: { object: { customer: 'cus_1' } } });
  const good = await signHeader(secret, payload);
  const now = Math.floor(Date.now() / 1000);

  const cases = [
    ['valid signature accepts', good, secret, true],
    ['missing header rejected', null, secret, false],
    ['empty header rejected', '', secret, false],
    ['garbage header rejected', 'nonsense', secret, false],
    ['no v1 component rejected', `t=${now}`, secret, false],
    ['no timestamp rejected', `v1=${await hmacHex(secret, `${now}.${payload}`)}`, secret, false],
    ['wrong secret rejected', await signHeader('whsec_attacker', payload), secret, false],
    ['empty secret rejected', good, '', false],
    ['timestamp swapped (sig over different ts) rejected', `t=${now - 1},v1=${await hmacHex(secret, `${now}.${payload}`)}`, secret, false],
    ['stale timestamp (>5min) rejected', await signHeader(secret, payload, now - 400), secret, false],
    ['future timestamp (>5min) rejected', await signHeader(secret, payload, now + 400), secret, false],
    ['non-numeric timestamp rejected', `t=abc,v1=${await hmacHex(secret, `abc.${payload}`)}`, secret, false],
    ['truncated sig rejected', `t=${now},v1=${(await hmacHex(secret, `${now}.${payload}`)).slice(0, 32)}`, secret, false],
    ['uppercase-hex sig rejected (no case fold)', `t=${now},v1=${(await hmacHex(secret, `${now}.${payload}`)).toUpperCase()}`, secret, false],
    ['multi-v1 with one valid accepts (rotation)', `t=${now},v1=${'0'.repeat(64)},v1=${await hmacHex(secret, `${now}.${payload}`)}`, secret, true],
    ['v0 only rejected', `t=${now},v0=${await hmacHex(secret, `${now}.${payload}`)}`, secret, false],
  ];
  for (const [name, header, sec, want] of cases) {
    const got = await stripe.verifyStripeSignature({ payload, header, secret: sec });
    check(name, got === want, `expected ${want}, got ${got}`);
  }
  // Tampered body under a valid-shaped signature.
  const tampered = payload.replace('cus_1', 'cus_2');
  check('body tamper rejected', (await stripe.verifyStripeSignature({ payload: tampered, header: good, secret })) === false);
}

// ---------------------------------------------------------------------------
// 2. UNVERIFIED EVENT MUST NEVER MUTATE + IDEMPOTENCY
// ---------------------------------------------------------------------------
const evtSeq = { n: 0 };
function evt(type, object, id) {
  return { id: id || `evt_${++evtSeq.n}`, type, data: { object } };
}
function checkoutSession(o = {}) {
  return {
    id: o.sid || 'cs_1',
    client_reference_id: o.senderId || 'snd_1',
    customer: o.customer || 'cus_1',
    subscription: o.sub === undefined ? 'sub_1' : o.sub,
    metadata: { tier: o.tier || 'solo', senderId: o.senderId || 'snd_1', ref: o.ref },
    customer_details: { email: o.email || 'buyer@example.com' },
  };
}
function subObj(o = {}) {
  return {
    id: o.id || 'sub_1',
    customer: o.customer || 'cus_1',
    status: o.status || 'active',
    metadata: { tier: o.tier || 'solo' },
    items: { data: [{ price: { id: 'price_solo' } }] },
    current_period_end: Math.floor(Date.now() / 1000) + 30 * 86400,
    cancel_at: o.cancel_at || null,
  };
}

async function testIdempotency() {
  section('2. applyStripeEvent idempotency / duplicate delivery');
  const env = makeEnv();
  // checkout.session.completed has no subId so no stripeFetch (network) fires.
  const e = evt('checkout.session.completed', checkoutSession({ sub: null }), 'evt_dup');
  const r1 = await stripe.applyStripeEvent(env, e);
  const r2 = await stripe.applyStripeEvent(env, e);
  const r3 = await stripe.applyStripeEvent(env, JSON.parse(JSON.stringify(e)));
  check('first delivery applies', r1.applied === true, JSON.stringify(r1));
  check('second delivery is a no-op (duplicate)', r2.applied === false && r2.reason === 'duplicate', JSON.stringify(r2));
  check('third delivery is a no-op (duplicate)', r3.applied === false && r3.reason === 'duplicate', JSON.stringify(r3));

  // Event with no id at all: Stripe always sends one, but check we do not crash
  // and note whether it can be replayed.
  const env2 = makeEnv();
  const noId = { type: 'checkout.session.completed', data: { object: checkoutSession({ sub: null }) } };
  const a = await stripe.applyStripeEvent(env2, noId);
  const b = await stripe.applyStripeEvent(env2, noId);
  check('id-less event is replayable (documented, low risk: signature still required)',
    a.applied === true && b.applied === true, `a=${JSON.stringify(a)} b=${JSON.stringify(b)}`);

  // Unknown customer.
  const env3 = makeEnv();
  const unknown = await stripe.applyStripeEvent(env3, evt('customer.subscription.updated', subObj({ customer: 'cus_nope' }), 'evt_unknown_cus'));
  check('unknown customer does not create a sub record',
    unknown.applied === false && (await env3.CYBERSYGN_DOCS.get('sub:snd_1')) === null, JSON.stringify(unknown));
  const seenMark = await env3.CYBERSYGN_DOCS.get('stripe:event:evt_unknown_cus');
  check('INVARIANT: an event that FAILED to apply is NOT marked seen (Stripe retry is the recovery path)',
    seenMark === null,
    `applyStripeEvent returned ${JSON.stringify(unknown)} yet wrote stripe:event:evt_unknown_cus = ${seenMark}, ` +
    `and handleStripeWebhook answers 200. index.js:1345 claims "marks the event seen only AFTER it fully applies" — it does not.`);

  // Plan id not in TIERS.
  const env4 = makeEnv();
  const bogus = await stripe.applyStripeEvent(env4, evt('checkout.session.completed', checkoutSession({ tier: 'unobtainium', sub: null })));
  const rec = JSON.parse((await env4.CYBERSYGN_DOCS.get('sub:snd_1')) || 'null');
  const gate = await stripe.checkFreeTierAllowance(env4, 'snd_1');
  check('tier not in TIERS is rejected rather than granted unlimited access',
    !(rec && rec.tier === 'unobtainium' && gate.remaining === Infinity),
    `record tier=${rec && rec.tier} status=${rec && rec.status} gate.remaining=${gate.remaining}`);

  // Unhandled event types.
  const env5 = makeEnv();
  const unh = await stripe.applyStripeEvent(env5, evt('invoice.payment_succeeded', { customer: 'cus_1' }));
  check('invoice.payment_succeeded is unhandled', unh.applied === false && String(unh.reason).startsWith('unhandled'), JSON.stringify(unh));
}

// ---------------------------------------------------------------------------
// 3. SUBSCRIPTION STATE MACHINE
// ---------------------------------------------------------------------------
async function seedPaidCustomer(env, { tier = 'solo', senderId = 'snd_1', customer = 'cus_1' } = {}) {
  await stripe.applyStripeEvent(env, evt('checkout.session.completed', checkoutSession({ tier, senderId, customer, sub: null })));
}
async function access(env, senderId = 'snd_1') {
  const g = await stripe.checkFreeTierAllowance(env, senderId);
  return { unlimited: g.remaining === Infinity, tier: g.tier, allowed: g.allowed };
}
async function subrec(env, senderId = 'snd_1') {
  return JSON.parse((await env.CYBERSYGN_DOCS.get(`sub:${senderId}`)) || 'null');
}

async function testStateMachine() {
  section('3. Subscription state machine');

  // (a) canonical happy path
  {
    const env = makeEnv();
    await seedPaidCustomer(env);
    check('active checkout grants unlimited', (await access(env)).unlimited === true);
    await stripe.applyStripeEvent(env, evt('customer.subscription.deleted', subObj({})));
    check('cancel removes unlimited', (await access(env)).unlimited === false);
  }

  // (b) OUT OF ORDER: deleted then a stale updated(active)
  {
    const env = makeEnv();
    await seedPaidCustomer(env);
    await stripe.applyStripeEvent(env, evt('customer.subscription.deleted', subObj({})));
    const afterDelete = await access(env);
    await stripe.applyStripeEvent(env, evt('customer.subscription.updated', subObj({ status: 'active' })));
    const afterStale = await access(env);
    const r = await subrec(env);
    check('INVARIANT: a stale subscription.updated arriving after subscription.deleted must not resurrect paid access',
      afterStale.unlimited === false,
      `afterDelete.unlimited=${afterDelete.unlimited} afterStale.unlimited=${afterStale.unlimited} record=${JSON.stringify(r)}`);
  }

  // (c) every Stripe status, entitlement mapping
  {
    const statuses = ['active', 'trialing', 'past_due', 'unpaid', 'canceled', 'incomplete', 'incomplete_expired', 'paused'];
    const map = {};
    for (const s of statuses) {
      const env = makeEnv();
      await seedPaidCustomer(env);
      await stripe.applyStripeEvent(env, evt('customer.subscription.updated', subObj({ status: s })));
      map[s] = (await access(env)).unlimited;
    }
    console.log('  entitlement by status: ' + JSON.stringify(map));
    check('INVARIANT: a trialing customer keeps access', map.trialing === true, `trialing unlimited=${map.trialing}`);
    check('canceled has no access', map.canceled === false);
    check('incomplete_expired has no access', map.incomplete_expired === false);
  }

  // (d) invoice.payment_failed on a healthy paying customer
  {
    const env = makeEnv();
    await seedPaidCustomer(env);
    const before = await access(env);
    await stripe.applyStripeEvent(env, evt('invoice.payment_failed', { customer: 'cus_1', id: 'in_1' }));
    const after = await access(env);
    const r = await subrec(env);
    check('INVARIANT: one failed renewal must not strip entitlement mid-dunning',
      after.unlimited === true,
      `before=${before.unlimited} after=${after.unlimited} status=${r.status} tier=${r.tier}; ` +
      `stripe.js:800 comment claims "without changing entitlement prematurely"`);
    // Recovery: does anything restore them?
    await stripe.applyStripeEvent(env, evt('invoice.payment_succeeded', { customer: 'cus_1' }));
    check('invoice.payment_succeeded restores entitlement', (await access(env)).unlimited === true,
      `after payment_succeeded unlimited=${(await access(env)).unlimited} (event type is unhandled)`);
  }

  // (d2) the downstream consequence of past_due: the doc-creation gate
  {
    const env = makeEnv();
    await seedPaidCustomer(env);
    await stripe.applyStripeEvent(env, evt('invoice.payment_failed', { customer: 'cus_1', id: 'in_2' }));
    // three docs later (index.js:4329 meters past_due senders against the free counter)
    for (let i = 0; i < 3; i++) await stripe.incrementUsage(env, 'snd_1');
    const g = await stripe.checkFreeTierAllowance(env, 'snd_1');
    check('INVARIANT: a customer with a live (dunning) subscription is never refused a document',
      g.allowed === true,
      `after 1 failed invoice + 3 docs: allowed=${g.allowed} tier=${g.tier} used=${g.used} cap=${g.cap} ` +
      `-> index.js:4131 returns 402 free_tier_limit "You have used all 3 free documents this month."`);
  }

  // (e) refund does not strip entitlement
  {
    const env = makeEnv();
    await seedPaidCustomer(env);
    await stripe.applyStripeEvent(env, evt('charge.refunded', { customer: 'cus_1', id: 'ch_1' }));
    const a = await access(env);
    check('refund alone leaves entitlement (Stripe sends sub.deleted separately)', a.unlimited === true, JSON.stringify(a));
  }

  // (g) two live subscriptions on one customer (the upgrade path creates a
  // SECOND subscription; nothing cancels the first). Canceling the old one
  // must not strip a customer who is still paying on the new one.
  {
    const env = makeEnv();
    await seedPaidCustomer(env, { tier: 'solo' });
    // "upgrade": a second Checkout Session on the same customer, new sub id.
    await stripe.applyStripeEvent(env, evt('checkout.session.completed',
      { ...checkoutSession({ tier: 'business', sub: null }), id: 'cs_2' }));
    check('after the upgrade the record shows Business', (await subrec(env)).tier === 'business');
    // The customer now cancels the OLD solo subscription in the billing portal.
    await stripe.applyStripeEvent(env, evt('customer.subscription.deleted', subObj({ id: 'sub_1', tier: 'solo' })));
    const a = await access(env);
    const r = await subrec(env);
    check('INVARIANT: canceling an old subscription must not strip a customer still paying on another',
      a.unlimited === true,
      `after canceling sub_1 (solo) the Business customer has unlimited=${a.unlimited}, record tier=${r.tier} status=${r.status}. ` +
      `onSubscriptionDeleted never compares sub.id against the record's stripeSubscriptionId (stripe.js:759-786)`);
  }

  // (f) random sequence fuzz
  {
    const types = [
      ['customer.subscription.updated', () => subObj({ status: pick(['active', 'past_due', 'unpaid', 'canceled', 'trialing', 'incomplete']) })],
      ['customer.subscription.deleted', () => subObj({})],
      ['invoice.payment_failed', () => ({ customer: 'cus_1', id: 'in_x' })],
      ['charge.refunded', () => ({ customer: 'cus_1', id: 'ch_x' })],
      ['charge.dispute.created', () => ({ customer: 'cus_1', id: 'dp_x' })],
    ];
    let rng = 1234567;
    function rand() { rng = (rng * 1103515245 + 12345) & 0x7fffffff; return rng / 0x7fffffff; }
    function pick(a) { return a[Math.floor(rand() * a.length)]; }
    const bad = [];
    for (let trial = 0; trial < 400; trial++) {
      const env = makeEnv();
      await seedPaidCustomer(env);
      const seq = [];
      const n = 1 + Math.floor(rand() * 5);
      for (let i = 0; i < n; i++) {
        const [t, mk] = types[Math.floor(rand() * types.length)];
        const o = mk();
        seq.push(`${t}${o.status ? '(' + o.status + ')' : ''}`);
        await stripe.applyStripeEvent(env, evt(t, o));
      }
      const r = await subrec(env);
      const a = await access(env);
      // Violation A: unlimited access while the last known Stripe status is terminal.
      const terminal = ['canceled', 'unpaid', 'incomplete_expired'];
      if (a.unlimited && terminal.includes(r.status)) bad.push({ kind: 'access-without-sub', seq, status: r.status, tier: r.tier });
      // Violation B: no access while the last known Stripe status is a paying one.
      if (!a.unlimited && (r.status === 'active' || r.status === 'trialing') && r.tier !== 'free') {
        bad.push({ kind: 'paying-without-access', seq, status: r.status, tier: r.tier });
      }
    }
    const kinds = {};
    for (const b of bad) kinds[b.kind] = (kinds[b.kind] || 0) + 1;
    check('INVARIANT: no random sequence yields access-without-subscription or paying-without-access',
      bad.length === 0,
      `${bad.length}/400 sequences violated. kinds=${JSON.stringify(kinds)}\n        first: ${JSON.stringify(bad[0])}\n        example2: ${JSON.stringify(bad.find(b => b.kind !== (bad[0] || {}).kind))}`);
  }
}

// ---------------------------------------------------------------------------
// 4. FREE TIER ACCOUNTING
// ---------------------------------------------------------------------------
async function signup(env, email = 'free@example.com') {
  const r = await free.freeSignup(env, { firstName: 'Ada', lastName: 'Lovelace', email });
  if (!r.ok) throw new Error('signup failed: ' + r.error);
  return r.freeToken;
}
async function usedOf(env, token) {
  const p = await free.freePeek(env, token);
  return p.ok ? p.used : `ERR:${p.error}`;
}

async function testFreeTier() {
  section('4. Free-tier accounting (3 lifetime)');
  // sequential cap
  {
    const env = makeEnv();
    const t = await signup(env);
    const results = [];
    for (let i = 0; i < 6; i++) results.push((await free.freeConsume(env, t)).ok);
    check('sequential consume caps at 3', JSON.stringify(results) === JSON.stringify([true, true, true, false, false, false]), JSON.stringify(results));
    check('used never exceeds 3 sequentially', (await usedOf(env, t)) === 3, String(await usedOf(env, t)));
  }
  // concurrent consume
  {
    const env = makeEnv();
    const t = await signup(env);
    const rs = await Promise.all(Array.from({ length: 12 }, () => free.freeConsume(env, t)));
    const okCount = rs.filter(r => r.ok).length;
    const finalUsed = await usedOf(env, t);
    check('INVARIANT: concurrent consume never grants more than 3',
      okCount <= 3, `${okCount} of 12 concurrent consumes succeeded; stored used=${finalUsed}`);
  }
  // refund on failed store
  {
    const env = makeEnv();
    const t = await signup(env);
    await free.freeConsume(env, t);
    check('used=1 after one consume', (await usedOf(env, t)) === 1);
    await free.freeRefund(env, t);
    check('refund returns the credit', (await usedOf(env, t)) === 0, String(await usedOf(env, t)));
    // refund below zero
    await free.freeRefund(env, t);
    check('refund never goes negative', (await usedOf(env, t)) === 0, String(await usedOf(env, t)));
    // unlimited refunds after consumes
    await free.freeConsume(env, t); await free.freeConsume(env, t); await free.freeConsume(env, t);
    for (let i = 0; i < 5; i++) await free.freeRefund(env, t);
    check('refund floor holds under spam', (await usedOf(env, t)) === 0, String(await usedOf(env, t)));
  }
  // failed KV write during consume
  {
    const env = makeEnv({ failPut: (k) => k.startsWith('free:') });
    // signup writes free: too, so build the record with a working store first
    const clean = makeEnv();
    const t = await signup(clean);
    for (const [k, v] of clean.CYBERSYGN_DOCS.map) env.CYBERSYGN_DOCS.map.set(k, v);
    const r = await free.freeConsume(env, t);
    check('a failed counter write refuses the consume rather than passing', r.ok === false && r.error === 'kv_put_failed', JSON.stringify(r));
    // and the refund path on a store that then works
    env.CYBERSYGN_DOCS.failPut = () => false;
    check('no credit was burned by the failed write', (await usedOf(env, t)) === 0, String(await usedOf(env, t)));
  }
  // freeRefund when the put fails: silent
  {
    const env = makeEnv();
    const t = await signup(env);
    await free.freeConsume(env, t);
    env.CYBERSYGN_DOCS.failPut = (k) => k.startsWith('free:');
    await free.freeRefund(env, t);   // swallows
    env.CYBERSYGN_DOCS.failPut = () => false;
    check('freeRefund swallows a failed write, credit stays burned (documented best-effort)',
      (await usedOf(env, t)) === 1, `used=${await usedOf(env, t)} — refund silently lost`);
  }
  // download-then-send double bill (models the two code paths)
  {
    const env = makeEnv();
    const t = await signup(env);
    // path 1: browser download -> POST /api/free/consume  (handleFreeConsume, index.js:2503)
    await free.freeConsume(env, t);
    // path 2: same document sent -> POST /api/docs -> freeConsume (index.js:4290)
    await free.freeConsume(env, t);
    const used = await usedOf(env, t);
    check('KNOWN: download-then-send bills the SAME document twice',
      used === 2, `used=${used} after one document (download + send)`);
    // how far do 3 credits go under that pattern?
    let docs = 0, blocked = null;
    const env2 = makeEnv();
    const t2 = await signup(env2, 'b@example.com');
    for (let i = 0; i < 5; i++) {
      const d = await free.freeConsume(env2, t2);   // download
      const s = await free.freeConsume(env2, t2);   // send
      if (d.ok && s.ok) docs++; else { blocked = { i, d: d.error, s: s.error }; break; }
    }
    check('QUANTIFIED: 3 advertised free documents deliver only 1 complete download+send',
      docs === 1, `complete documents=${docs}, blocked at ${JSON.stringify(blocked)}`);
  }
  // dataset counter inflation from the double bill
  {
    const env = makeEnv();
    const t = await signup(env);
    await free.freeConsume(env, t);
    await free.freeConsume(env, t);
    const c = await free.getDatasetCount(env);
    check('public dataset total counts the double-billed doc twice', c.total === 2, JSON.stringify(c));
  }
  // token fuzz
  {
    const env = makeEnv();
    const junk = ['', null, undefined, 'a', 'g'.repeat(48), 'A'.repeat(48), '0'.repeat(47), '0'.repeat(49), '../../etc', '0'.repeat(48), 1234, {}, []];
    let allRejected = true, detail = '';
    for (const j of junk) {
      const r = await free.freeConsume(env, j);
      if (r.ok) { allRejected = false; detail = `accepted ${JSON.stringify(j)}`; }
    }
    check('malformed free tokens all rejected', allRejected, detail);
  }
  // token pointer poisoning: pointer to a missing record
  {
    const env = makeEnv();
    const t = await signup(env);
    env.CYBERSYGN_DOCS.map.delete('free:' + (await free.freePeek(env, t)).emailHash);
    const r = await free.freeConsume(env, t);
    check('orphaned pointer yields record_missing, not a free pass', r.ok === false && r.error === 'record_missing', JSON.stringify(r));
  }
  // signup idempotency does not reset the counter
  {
    const env = makeEnv();
    const t = await signup(env);
    await free.freeConsume(env, t); await free.freeConsume(env, t); await free.freeConsume(env, t);
    const again = await free.freeSignup(env, { firstName: 'Ada', lastName: 'Lovelace', email: 'FREE@EXAMPLE.COM' });
    check('re-signup (case-varied email) does not mint new credits', again.freeToken === t && again.used === 3, JSON.stringify(again));
    const spaced = await free.freeSignup(env, { firstName: 'Ada', lastName: 'Lovelace', email: '  free@example.com  ' });
    check('whitespace-padded email hits the same record', spaced.freeToken === t, JSON.stringify(spaced));
  }
  // email variations that mint fresh credits
  {
    const env = makeEnv();
    const a = await free.freeSignup(env, { firstName: 'A', lastName: 'B', email: 'user+1@gmail.com' });
    const b = await free.freeSignup(env, { firstName: 'A', lastName: 'B', email: 'user+2@gmail.com' });
    const c = await free.freeSignup(env, { firstName: 'A', lastName: 'B', email: 'u.s.e.r@gmail.com' });
    check('plus/dot gmail aliases each mint a fresh 3-doc allowance (unbounded free tier)',
      a.freeToken !== b.freeToken && b.freeToken !== c.freeToken,
      `tokens distinct: ${a.freeToken !== b.freeToken}; each starts at remaining=${a.remaining}`);
  }
}

// ---------------------------------------------------------------------------
// 5. AFFILIATE / AMBASSADOR MONEY
// ---------------------------------------------------------------------------
function ledgerSum(rec) {
  const l = Array.isArray(rec.ledger) ? rec.ledger : [];
  return Math.round((l.reduce((s, e) => s + (Number(e.amount) || 0), 0) + (Number(rec.ledgerArchivedUsd) || 0)) * 100) / 100;
}
async function mkCode(env, senderId = 'amb_1') {
  const r = await aff.registerAffiliate(env, { senderId, email: `${senderId}@example.com` });
  return r.code;
}
async function loadRec(env, code) {
  return JSON.parse(await env.CYBERSYGN_DOCS.get(`affiliate:code:${code}`));
}
function expectedEarned(sales) {
  // Independent re-implementation of the published model, used as an oracle.
  let conv = 0, total = 0;
  const milestonesPaid = {};
  const monthly = {};
  for (const s of sales) {
    conv++;
    const base = aff.PLAN_BOUNTY[s.plan];
    const mult = aff.tierFor(conv).mult;
    total += Math.round(base * mult);
    for (const m of aff.MILESTONES) if (conv >= m.at && !milestonesPaid[m.at]) { total += m.bonus; milestonesPaid[m.at] = true; }
    monthly[s.month] = (monthly[s.month] || 0) + 1;
    if (monthly[s.month] === aff.SPRINT.salesNeeded) total += aff.SPRINT.bonus;
  }
  return Math.round(total * 100) / 100;
}

async function testAffiliate() {
  section('5. Affiliate / ambassador money');

  // ledger <-> earnedUsd agreement over a clean run
  {
    const env = makeEnv();
    const code = await mkCode(env);
    const plans = ['solo', 'pro', 'founding', 'team', 'business', 'lifetime', 'solo', 'pro', 'solo', 'team', 'solo', 'business'];
    for (let i = 0; i < plans.length; i++) {
      await aff.recordConversion(env, code, `cus_${i}`, plans[i], `buyer_${i}`, `buyer${i}@x.com`);
    }
    const rec = await loadRec(env, code);
    check('earnedUsd equals the ledger sum after 12 sales', rec.earnedUsd === ledgerSum(rec), `earned=${rec.earnedUsd} ledger=${ledgerSum(rec)}`);
    const oracle = expectedEarned(plans.map(p => ({ plan: p, month: new Date().toISOString().slice(0, 7) })));
    check('earnedUsd matches an independent model of the published ladder', rec.earnedUsd === oracle, `earned=${rec.earnedUsd} oracle=${oracle}`);
  }

  // add-on / free plan pays nothing and does not count
  {
    const env = makeEnv();
    const code = await mkCode(env);
    for (const p of ['seat', 'whitelabel', 'free']) {
      const r = await aff.recordConversion(env, code, `cus_${p}`, p, 'buyer', 'b@x.com');
      check(`${p} purchase pays no bounty`, r.ok === false && r.error === 'non_qualifying_plan', JSON.stringify(r));
    }
    const rec = await loadRec(env, code);
    check('non-qualifying purchases leave conversions at 0', (rec.conversions || 0) === 0, String(rec.conversions));
  }

  // unknown plan id
  {
    const env = makeEnv();
    const code = await mkCode(env);
    const r = await aff.recordConversion(env, code, 'cus_x', 'unobtainium', 'buyer', 'b@x.com');
    const rec = await loadRec(env, code);
    check('unknown plan id falls back to DEFAULT_BOUNTY rather than throwing',
      r.ok === true && rec.earnedUsd === aff.DEFAULT_BOUNTY + 10, `payout=${r.payoutUsd} earned=${rec.earnedUsd}`);
  }

  // self-referral
  {
    const env = makeEnv();
    const code = await mkCode(env, 'amb_self');
    const bySender = await aff.recordConversion(env, code, 'cus_s1', 'solo', 'amb_self', 'other@x.com');
    const byEmail = await aff.recordConversion(env, code, 'cus_s2', 'solo', 'someone', 'AMB_SELF@example.com');
    check('self-referral blocked by senderId', bySender.ok === false && bySender.error === 'self_referral_blocked', JSON.stringify(bySender));
    check('self-referral blocked by email (case-insensitive)', byEmail.ok === false && byEmail.error === 'self_referral_blocked', JSON.stringify(byEmail));
  }

  // duplicate webhook delivery of the same conversion
  {
    const env = makeEnv();
    const code = await mkCode(env);
    const a = await aff.recordConversion(env, code, 'cus_dup', 'business', 'b1', 'b1@x.com');
    const b = await aff.recordConversion(env, code, 'cus_dup', 'business', 'b1', 'b1@x.com');
    const rec = await loadRec(env, code);
    check('duplicate conversion for the same customer credits once',
      a.ok && b.alreadyCounted === true && rec.conversions === 1, `earned=${rec.earnedUsd} conv=${rec.conversions}`);
  }

  // BONUS DOUBLE-CLAWBACK: sprint. The bonus rides in the carrier sale's frozen
  // creditTotal AND in the reconcile pass, so it can be removed twice.
  {
    const env = makeEnv();
    const code = await mkCode(env);
    for (let i = 0; i < 5; i++) await aff.recordConversion(env, code, `c${i}`, 'solo', `b${i}`, `b${i}@x.com`);
    let rec = await loadRec(env, code);
    check('5 solo sales earn 4x$10 + 1x$12 + $10 first-sale + $40 sprint = $102', rec.earnedUsd === 102, `earned=${rec.earnedUsd}`);
    await aff.reverseConversion(env, code, 'c0', 'refund');          // NOT the sprint carrier
    const mid = (await loadRec(env, code)).earnedUsd;
    await aff.reverseConversion(env, code, 'c4', 'refund');          // the sprint carrier
    rec = await loadRec(env, code);
    // Survivors: c1,c2,c3 = 3 x $10 bounty, plus the $10 first-sale milestone.
    check('INVARIANT: the sprint bonus is withdrawn at most once',
      rec.earnedUsd === 40,
      `after reversing c0 then c4: earned=$${rec.earnedUsd}, true book for 3 surviving $10 solo sales + $10 first-sale = $40. ` +
      `Delta $${rec.earnedUsd - 40} = the $${aff.SPRINT.bonus} sprint bonus removed TWICE (mid=$${mid})`);
  }
  // BONUS DOUBLE-CLAWBACK: milestone, same shape.
  {
    const env = makeEnv();
    const code = await mkCode(env);
    for (let i = 0; i < 10; i++) await aff.recordConversion(env, code, `c${i}`, 'solo', `b${i}`, `b${i}@x.com`);
    check('10 solo sales earn $202', (await loadRec(env, code)).earnedUsd === 202);
    await aff.reverseConversion(env, code, 'c0', 'refund');   // drops to 9, reconcile withdraws the $40 10-sale bonus
    await aff.reverseConversion(env, code, 'c9', 'refund');   // c9 CARRIED that $40 inside its creditTotal
    const rec = await loadRec(env, code);
    // Survivors c1..c8: 3 x $10 + 5 x $12 = $90, + $10 first-sale, + $40 sprint (8 >= 5) = $140.
    check('INVARIANT: the 10-sale milestone bonus is withdrawn at most once',
      rec.earnedUsd === 140,
      `earned=$${rec.earnedUsd}, true book = $140. Delta $${rec.earnedUsd - 140} = the $40 milestone removed TWICE`);
  }
  // Full unwind: reversing every sale must return the book to exactly $0.
  {
    const scenarios = [
      ['5 solo, reverse oldest-first', Array(5).fill('solo'), [0, 1, 2, 3, 4]],
      ['5 solo, reverse newest-first', Array(5).fill('solo'), [4, 3, 2, 1, 0]],
      ['5 mixed plans, interleaved', ['business', 'solo', 'pro', 'founding', 'team'], [0, 2, 4, 1, 3]],
      ['10 solo, reverse oldest-first', Array(10).fill('solo'), [...Array(10).keys()]],
      ['10 solo, reverse newest-first', Array(10).fill('solo'), [...Array(10).keys()].reverse()],
      ['25 solo, reverse oldest-first', Array(25).fill('solo'), [...Array(25).keys()]],
    ];
    const bad = [];
    for (const [name, plans, order] of scenarios) {
      const env = makeEnv();
      const code = await mkCode(env, 'amb_' + name.replace(/\W/g, ''));
      for (let i = 0; i < plans.length; i++) await aff.recordConversion(env, code, `c${i}`, plans[i], `b${i}`, `b${i}@x.com`);
      const peak = (await loadRec(env, code)).earnedUsd;
      for (const i of order) await aff.reverseConversion(env, code, `c${i}`, 'refund');
      const rec = await loadRec(env, code);
      if (rec.earnedUsd !== 0) bad.push(`${name}: peak $${peak} -> after full unwind $${rec.earnedUsd}`);
    }
    check('INVARIANT: reversing every sale returns earnedUsd to exactly $0 (no residue in either direction)',
      bad.length === 0, bad.join('\n        '));
  }
  // reversal of a never-recorded / legacy customer
  {
    const env = makeEnv();
    const code = await mkCode(env);
    const r = await aff.reverseConversion(env, code, 'cus_never', 'refund');
    check('reversing an unknown customer is a no-op', r.ok === true && r.nothingToReverse === true, JSON.stringify(r));
    await aff.recordConversion(env, code, 'cus_r', 'solo', 'b', 'b@x.com');
    const r1 = await aff.reverseConversion(env, code, 'cus_r', 'refund');
    const r2 = await aff.reverseConversion(env, code, 'cus_r', 'dispute');
    check('double reversal only claws back once', r1.reversed === true && r2.alreadyHandled === true, JSON.stringify(r2));
    const rec = await loadRec(env, code);
    check('a fully reversed single sale returns the book to zero', rec.earnedUsd === 0, `earned=${rec.earnedUsd} ledger=${ledgerSum(rec)}`);
  }

  // legacy record with no creditTotal
  {
    const env = makeEnv();
    const code = await mkCode(env);
    await aff.recordConversion(env, code, 'cus_leg', 'founding', 'b', 'b@x.com');
    // simulate an old dedupe record without creditTotal
    await env.CYBERSYGN_DOCS.put(`affiliate:conv:${code}:cus_leg`, JSON.stringify({ at: new Date().toISOString(), tier: 'founding' }));
    await aff.reverseConversion(env, code, 'cus_leg', 'refund');
    const rec = await loadRec(env, code);
    check('legacy reversal uses the flat $20 and can overshoot a $7 sale, going negative (visible)',
      rec.earnedUsd < 0, `earned=${rec.earnedUsd} (founding sale credited $7 + $10 first-sale bonus, flat clawback $20)`);
    const st = amb.payoutState(rec);
    check('overshoot is surfaced, not swallowed', st.overpaidUsd >= 0 && st.blockReasons.length > 0, JSON.stringify({ overpaid: st.overpaidUsd, block: st.blockReasons }));
  }

  // refund AFTER payout must be a visible overpayment
  {
    const env = makeEnv();
    const code = await mkCode(env);
    for (let i = 0; i < 6; i++) await aff.recordConversion(env, code, `p${i}`, 'business', `pb${i}`, `pb${i}@x.com`);
    let rec = await loadRec(env, code);
    const earned = rec.earnedUsd;
    // simulate the owner having paid the whole balance out
    rec.payouts = [{ amount: earned, paidAt: new Date().toISOString(), method: 'paypal' }];
    await env.CYBERSYGN_DOCS.put(`affiliate:code:${code}`, JSON.stringify(rec));
    await aff.reverseConversion(env, code, 'p0', 'refund');
    rec = await loadRec(env, code);
    const st = amb.payoutState(rec);
    check('INVARIANT: a refund after payout shows a VISIBLE overpayment, not a silent zero',
      st.overpaidUsd > 0 && st.blockReasons.includes('overpaid_balance'),
      `balance=${st.balanceUsd} overpaid=${st.overpaidUsd} owed=${st.owedUsd} block=${JSON.stringify(st.blockReasons)}`);
    check('overpaid ambassador is not payable', st.payable === false);
  }

  // random sequence fuzz: earnedUsd must always equal the ledger
  {
    let rng = 987654321;
    const rand = () => { rng = (rng * 1103515245 + 12345) & 0x7fffffff; return rng / 0x7fffffff; };
    const plans = ['solo', 'pro', 'founding', 'team', 'business', 'lifetime', 'solo_annual', 'pro_annual'];
    const bad = [];
    for (let trial = 0; trial < 120; trial++) {
      const env = makeEnv();
      const code = await mkCode(env, `amb_f${trial}`);
      const live = [];
      let n = 0;
      const ops = [];
      for (let i = 0; i < 24; i++) {
        if (rand() < 0.62 || live.length === 0) {
          const cus = `c${n++}`;
          const plan = plans[Math.floor(rand() * plans.length)];
          const r = await aff.recordConversion(env, code, cus, plan, `b${cus}`, `b${cus}@x.com`);
          ops.push(`+${plan}`);
          if (r.ok) live.push(cus);
        } else {
          const idx = Math.floor(rand() * live.length);
          const cus = live.splice(idx, 1)[0];
          await aff.reverseConversion(env, code, cus, 'refund');
          ops.push(`-${cus}`);
        }
      }
      const rec = await loadRec(env, code);
      if (rec.earnedUsd !== ledgerSum(rec)) bad.push({ trial, kind: 'ledger-drift', earned: rec.earnedUsd, ledger: ledgerSum(rec), ops });
      // milestone flags must never claim more than the surviving conversions justify
      for (const m of aff.MILESTONES) {
        if (rec.milestonesPaid && rec.milestonesPaid[m.at] && rec.conversions < m.at) {
          bad.push({ trial, kind: 'milestone-flag-unearned', at: m.at, conv: rec.conversions, ops });
        }
      }
      if (rec.earnedUsd < 0 && live.length > 0) bad.push({ trial, kind: 'negative-with-live-sales', earned: rec.earnedUsd, live: live.length, ops });
    }
    const kinds = {};
    for (const b of bad) kinds[b.kind] = (kinds[b.kind] || 0) + 1;
    check('INVARIANT: 120 random conversion/reversal sequences keep earnedUsd == ledger and no unearned milestone flags',
      bad.length === 0, `${bad.length} violations. kinds=${JSON.stringify(kinds)}\n        first: ${JSON.stringify(bad[0]).slice(0, 600)}`);
  }

  // ordering: reversal arriving BEFORE the conversion (Stripe does not order events)
  {
    const env = makeEnv();
    const code = await mkCode(env);
    await aff.reverseConversion(env, code, 'cus_ooo', 'refund');   // arrives first
    const r = await aff.recordConversion(env, code, 'cus_ooo', 'business', 'b', 'b@x.com');
    const rec = await loadRec(env, code);
    check('INVARIANT: a refund delivered before its conversion still leaves no unearned credit',
      rec.earnedUsd === 0,
      `earned=$${rec.earnedUsd} — the reversal was a no-op (nothing to reverse) and the later conversion credited in full`);
  }
}

// ---------------------------------------------------------------------------
// 6. PRICE INTEGRITY
// ---------------------------------------------------------------------------
async function testPriceIntegrity() {
  section('6. Price integrity');
  const T = stripe.TIERS;
  const envAll = {};
  for (const id of Object.keys(T)) if (T[id].priceEnv) envAll[T[id].priceEnv] = 'price_fake';
  const p = stripe.purchasableTiers(envAll);
  check('retired add-ons are NOT purchasable even with a live Stripe price',
    p.seat === false && p.whitelabel === false, JSON.stringify(p));

  const envWithKey = { ...envAll, STRIPE_SECRET_KEY: 'sk_test_x', CYBERSYGN_DOCS: makeKV() };
  for (const id of ['seat', 'whitelabel']) {
    let err = null;
    try { await stripe.createCheckoutSession(envWithKey, { tier: id, senderId: 'x', origin: 'https://cybersygn.io' }); }
    catch (e) { err = e; }
    check(`createCheckoutSession refuses retired tier "${id}" server-side`,
      err && err.code === 'tier_retired', err ? `${err.code}: ${err.message}` : 'NO ERROR THROWN — checkout proceeded');
  }
  // every non-free tier maps to a distinct env var
  const envNames = Object.values(T).filter(t => t.priceEnv).map(t => t.priceEnv);
  check('every priceEnv is unique', new Set(envNames).size === envNames.length, envNames.join(','));
  check('free tier has no priceEnv', T.free.priceEnv === null);
  // tiers whose bounty is undefined in PLAN_BOUNTY get DEFAULT_BOUNTY silently
  const missingBounty = Object.keys(T).filter(id => aff.PLAN_BOUNTY[id] === undefined);
  check('every TIERS id has an explicit affiliate bounty (no silent DEFAULT_BOUNTY)',
    missingBounty.length === 0, `missing from PLAN_BOUNTY: ${missingBounty.join(', ')} -> would silently pay $${aff.DEFAULT_BOUNTY}`);
}

// ---------------------------------------------------------------------------
(async function main() {
  await testSignature();
  await testIdempotency();
  await testStateMachine();
  await testFreeTier();
  await testAffiliate();
  await testPriceIntegrity();
  console.log(`\n---- ${PASS} passed, ${FAIL} failed ----`);
  if (FAIL) { console.log('\nFAILED INVARIANTS:'); for (const f of failures) console.log(' * ' + f.name + '\n   ' + (f.detail || '')); }
})();
