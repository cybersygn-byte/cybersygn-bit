#!/usr/bin/env node
/**
 * Stripe module + free-tier gate end-to-end test.
 *
 * Verifies behaviour without contacting Stripe. The webhook handler is
 * exercised against a locally-HMAC-signed payload; the checkout-create
 * endpoint is gated by env so we assert it refuses cleanly when
 * STRIPE_SECRET_KEY is unset.
 *
 * Free-tier gate is exercised through the real /api/docs handler with
 * the in-memory storage backend, so the same code path that runs in
 * production runs here.
 */

import workerModule from '../worker/src/index.js';
import {
  verifyStripeSignature,
  applyStripeEvent,
  getSubscription,
  getUsageThisMonth,
  checkFreeTierAllowance,
  TIERS,
} from '../worker/src/stripe.js';
import { readFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');

let passed = 0;
let failed = 0;

function ok(condition, msg) {
  if (condition) { passed++; console.log(`  OK   ${msg}`); }
  else           { failed++; console.error(`  FAIL ${msg}`); }
}

async function sha256Hex(text) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
}

async function call(method, path, body, extraHeaders, env) {
  const headers = { 'accept': 'application/json', ...(extraHeaders || {}) };
  let init = { method, headers };
  if (body !== undefined) {
    init.body = typeof body === 'string' ? body : JSON.stringify(body);
    if (!headers['content-type']) headers['content-type'] = 'application/json';
    headers['content-length'] = String(init.body.length);
  }
  const req = new Request(`http://localhost${path}`, init);
  const res = await workerModule.fetch(req, env || {});
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch {}
  return { status: res.status, json, text };
}

// Sign a Stripe-style payload locally so we can assert verifier accepts it.
async function signPayload(payload, secret, timestamp) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    enc.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(`${timestamp}.${payload}`));
  const hex = Array.from(new Uint8Array(sig), b => b.toString(16).padStart(2, '0')).join('');
  return `t=${timestamp},v1=${hex}`;
}

async function main() {
  console.log('CyberSygn Stripe + free-tier gate tests');
  console.log('=======================================\n');

  // 1. Free-tier allowance state machine (unit-level)
  console.log('1. Free-tier gate, unit-level');
  const env = {};
  let gate = await checkFreeTierAllowance(env, 'sender-A');
  ok(gate.allowed === true, 'fresh sender is allowed');
  ok(gate.cap === 3, 'cap is 3');
  ok(gate.remaining === 3, 'remaining is 3');

  // 2. Signature verifier accepts a locally-signed payload
  console.log('\n2. Webhook signature verification');
  const secret = 'whsec_test_local_secret';
  const payload = JSON.stringify({ id: 'evt_test_1', type: 'noop' });
  const ts = Math.floor(Date.now() / 1000);
  const header = await signPayload(payload, secret, ts);
  const goodSig = await verifyStripeSignature({ payload, header, secret });
  ok(goodSig === true, 'verifier accepts a correctly-signed payload');

  const tampered = payload + 'x';
  const badSig = await verifyStripeSignature({ payload: tampered, header, secret });
  ok(badSig === false, 'verifier rejects a tampered payload');

  const oldTs = ts - 3600;
  const oldHeader = await signPayload(payload, secret, oldTs);
  const replay = await verifyStripeSignature({ payload, header: oldHeader, secret });
  ok(replay === false, 'verifier rejects a stale timestamp outside tolerance');

  // 3. /api/checkout/create-session refuses cleanly without configuration
  console.log('\n3. Checkout endpoint without Stripe config');
  const noConfig = await call('POST', '/api/checkout/create-session',
    { tier: 'solo', senderId: 'sender-A' });
  ok(noConfig.status === 503, 'returns 503 when STRIPE_SECRET_KEY missing');
  ok(noConfig.json && noConfig.json.error === 'not_configured', 'reports not_configured');

  // 4. /api/checkout/create-session validates input
  console.log('\n4. Checkout input validation');
  const badTier = await call('POST', '/api/checkout/create-session', { tier: 'platinum', senderId: 'x' });
  ok(badTier.status === 400, 'unknown tier rejected with 400');
  const noSender = await call('POST', '/api/checkout/create-session', { tier: 'solo' });
  ok(noSender.status === 400, 'missing senderId rejected with 400');
  const freeTier = await call('POST', '/api/checkout/create-session', { tier: 'free', senderId: 'x' });
  ok(freeTier.status === 400, 'free tier rejected (not purchasable)');

  // 5. Owner short-circuit on checkout
  //
  // This block used to claim owner with the literal phrase 'cybersygn-dev-owner'.
  // That phrase was a hardcoded fallback in owner.js, in a PUBLIC repo, which
  // any reader could use to become owner on any deployment whose secret was
  // unset or malformed. It was removed, owner.js now fails closed, and these
  // tests correctly started failing because they were asserting the backdoor
  // still worked. The fix is to configure a real owner hash for the test env,
  // exactly as production does, and to pin the removal so it cannot come back.
  console.log('\n5. Owner mode skips Stripe');
  const OWNER_PHRASE = 'test-only-owner-phrase-not-a-real-secret';
  const ownerEnv = { CYBERSYGN_OWNER_HASH: await sha256Hex(OWNER_PHRASE) };

  // REGRESSION GUARD: the retired dev phrase must never claim owner again.
  const devPhrase = await call('POST', '/api/owner/claim', { phrase: 'cybersygn-dev-owner' }, null, ownerEnv);
  ok(devPhrase.status !== 200, 'the retired dev phrase cannot claim owner');
  // And with no hash configured at all, nothing can claim owner.
  const noHash = await call('POST', '/api/owner/claim', { phrase: OWNER_PHRASE }, null, {});
  ok(noHash.status !== 200, 'no configured hash means no owner claim (fails closed)');

  const ownerClaim = await call('POST', '/api/owner/claim', { phrase: OWNER_PHRASE }, null, ownerEnv);
  ok(ownerClaim.status === 200, 'owner claim succeeded');
  const ownerToken = ownerClaim.json && ownerClaim.json.token;
  ok(typeof ownerToken === 'string' && ownerToken.length === 64, 'owner token returned');

  const ownerCheckout = await call(
    'POST',
    '/api/checkout/create-session',
    { tier: 'solo', senderId: 'sender-owner' },
    { 'x-cybersygn-owner': ownerToken },
    ownerEnv,
  );
  ok(ownerCheckout.status === 200, 'owner checkout 200');
  ok(ownerCheckout.json && ownerCheckout.json.owner === true, 'response flags owner=true');
  ok(ownerCheckout.json && /checkout=owner/.test(ownerCheckout.json.url), 'redirect carries checkout=owner');

  // 6. Founding count endpoint
  console.log('\n6. Founding-count endpoint');
  const fc = await call('GET', '/api/billing/founding-count');
  ok(fc.status === 200, '200');
  ok(fc.json && fc.json.cap === 100, 'cap=100');
  ok(fc.json && fc.json.taken === 0, 'taken=0');
  ok(fc.json && fc.json.remaining === 100, 'remaining=100');

  // 7. Free-tier gate enforcement on /api/docs
  console.log('\n7. Free-tier gate on doc creation');
  const pdfBytes = await readFile(resolve(ROOT, 'test-pdfs', '01-simple-signature.pdf'));
  const pdfBase64 = pdfBytes.toString('base64');

  function newDocBody(senderId) {
    return {
      title: 'Gate test',
      senderName: 'Tester',
      senderId,
      pdfBase64,
      fields: [{ id: 'f1', page: 1, x: 100, y: 100, width: 200, height: 30, type: 'signature', label: 'Sig', confidence: 1 }],
      signers: [{ id: 's1', name: 'Me', email: 'me@example.com' }],
      assignments: { f1: 's1' },
    };
  }

  const senderId = 'sender-gate-test';

  // A free sender must present the signup-issued token: the three-doc
  // lifetime cap now binds to the signed-up email, not the rotatable
  // senderId. Without a token the create is refused up front.
  const noTok = await call('POST', '/api/docs', newDocBody(senderId));
  ok(noTok.status === 402 && noTok.json && noTok.json.error === 'free_signup_required',
     'tokenless free create is refused with free_signup_required');

  // Sign up once, then the SAME token caps at three creates regardless of
  // the senderId it is used with (the email is the durable identity).
  const su = await call('POST', '/api/free/signup', {
    firstName: 'Gate', lastName: 'Test', email: 'gate-test@example.com',
  });
  const freeTok = su.json && su.json.freeToken;
  ok(!!freeTok, 'free signup issued a token');
  const withTok = { 'x-cybersygn-free': freeTok };

  const d1 = await call('POST', '/api/docs', newDocBody(senderId), withTok);
  ok(d1.status === 201, 'doc 1 of 3 accepted');
  const d2 = await call('POST', '/api/docs', newDocBody(senderId + '-rotated'), withTok);
  ok(d2.status === 201, 'doc 2 of 3 accepted (senderId rotation does not reset the cap)');
  const d3 = await call('POST', '/api/docs', newDocBody(senderId + '-rotated-again'), withTok);
  ok(d3.status === 201, 'doc 3 of 3 accepted');
  const d4 = await call('POST', '/api/docs', newDocBody(senderId + '-fresh'), withTok);
  ok(d4.status === 402, 'doc 4 hit the lifetime cap (402)');
  ok(d4.json && d4.json.error === 'free_cap_reached', 'error code is free_cap_reached');

  // Owner bypasses the gate.
  const d5 = await call(
    'POST',
    '/api/docs',
    newDocBody(senderId),
    { 'x-cybersygn-owner': ownerToken },
  );
  ok(d5.status === 201, 'owner override bypasses the gate');

  // 8. Webhook end-to-end: simulate checkout.session.completed, then verify gate
  console.log('\n8. Webhook event upserts subscription');
  process.env.STRIPE_WEBHOOK_SECRET = 'whsec_test_local_secret';
  const envWithSecret = { STRIPE_WEBHOOK_SECRET: 'whsec_test_local_secret' };
  const fakeEvent = {
    id: 'evt_test_checkout_1',
    type: 'checkout.session.completed',
    data: {
      object: {
        id: 'cs_test_xxx',
        client_reference_id: senderId,
        customer: 'cus_test_xxx',
        subscription: null,
        metadata: { tier: 'solo', senderId },
      },
    },
  };
  const fakePayload = JSON.stringify(fakeEvent);
  const wsTs = Math.floor(Date.now() / 1000);
  const wsHeader = await signPayload(fakePayload, 'whsec_test_local_secret', wsTs);
  const wh = await call(
    'POST',
    '/api/stripe/webhook',
    fakePayload,
    { 'stripe-signature': wsHeader, 'content-type': 'application/json' },
    envWithSecret,
  );
  ok(wh.status === 200, 'webhook accepted');
  ok(wh.json && wh.json.applied === true, 'event applied');

  const sub = await getSubscription(envWithSecret, senderId);
  ok(sub.tier === 'solo', 'subscription tier is solo after webhook');
  ok(sub.status === 'active', 'subscription status is active');
  ok(sub.stripeCustomerId === 'cus_test_xxx', 'customer id stored');

  // Replay the same event: should be a no-op
  const wh2 = await call(
    'POST',
    '/api/stripe/webhook',
    fakePayload,
    { 'stripe-signature': wsHeader, 'content-type': 'application/json' },
    envWithSecret,
  );
  ok(wh2.status === 200, 'replay accepted');
  ok(wh2.json && (wh2.json.applied === false || wh2.json.reason === 'duplicate'),
     'replay is idempotent (no double-apply)');

  // Gate now passes because the sender is on solo.
  const d6 = await call('POST', '/api/docs', newDocBody(senderId), {}, envWithSecret);
  ok(d6.status === 201, 'solo subscriber bypasses free-tier gate');

  // Sign and POST an event through the real webhook route.
  async function webhook(event) {
    const body = JSON.stringify(event);
    const ts = Math.floor(Date.now() / 1000);
    const sig = await signPayload(body, 'whsec_test_local_secret', ts);
    return call('POST', '/api/stripe/webhook', body,
      { 'stripe-signature': sig, 'content-type': 'application/json' }, envWithSecret);
  }
  function subEvent(type, { id, subId, customer, tier, created, status }) {
    return {
      id, type, created,
      data: { object: {
        id: subId, customer, status: status || 'active',
        metadata: { tier },
        items: { data: [{ id: 'si_1', price: { id: 'price_x' } }] },
        current_period_end: Math.floor(Date.now() / 1000) + 30 * 86400,
      } },
    };
  }

  // 9. A recoverable miss must answer 5xx, because Stripe's retry is the only
  // recovery path and a 200 spends it on nothing.
  console.log('\n9. Unappliable events ask Stripe to retry');
  const retryEvt = subEvent('customer.subscription.updated', {
    id: 'evt_retry_1', subId: 'sub_retry', customer: 'cus_retry', tier: 'solo', created: 1000,
  });
  const miss = await webhook(retryEvt);
  ok(miss.status === 500, 'unknown customer answers 500 so Stripe redelivers');
  ok(miss.json && miss.json.error === 'no_sender_for_customer', 'reports the reason');

  // The customer mapping arrives (checkout landed second), then the SAME event
  // id is redelivered. It must apply, which it cannot do if the failed first
  // delivery marked the id processed.
  const linkEvt = {
    id: 'evt_retry_link', type: 'checkout.session.completed',
    data: { object: {
      id: 'cs_retry', client_reference_id: 'sender-retry', customer: 'cus_retry',
      subscription: null, metadata: { tier: 'solo', senderId: 'sender-retry' },
    } },
  };
  const linked = await webhook(linkEvt);
  ok(linked.status === 200 && linked.json.applied === true, 'the linking checkout event applies');
  const redeliver = await webhook(retryEvt);
  ok(redeliver.status === 200 && redeliver.json.applied === true,
     'the redelivered event applies (the failed delivery was never marked seen)');

  // 10. Cancelling a sibling subscription must not strip the live plan.
  console.log('\n10. Sibling subscription cancellation');
  const upSender = 'sender-upgrade';
  await webhook({
    id: 'evt_up_checkout', type: 'checkout.session.completed',
    data: { object: {
      id: 'cs_up', client_reference_id: upSender, customer: 'cus_up',
      subscription: null, metadata: { tier: 'solo', senderId: upSender },
    } },
  });
  await webhook(subEvent('customer.subscription.updated', {
    id: 'evt_up_a', subId: 'sub_A', customer: 'cus_up', tier: 'pro', created: 2000,
  }));
  const liveSub = await getSubscription(envWithSecret, upSender);
  ok(liveSub.tier === 'pro' && liveSub.stripeSubscriptionId === 'sub_A', 'live plan is pro on sub_A');

  const sibling = await webhook(subEvent('customer.subscription.deleted', {
    id: 'evt_up_b_del', subId: 'sub_B', customer: 'cus_up', tier: 'solo', created: 2100,
  }));
  ok(sibling.status === 200 && sibling.json.noop === 'not_the_active_subscription',
     'a sibling cancellation is a no-op');
  const stillPaid = await getSubscription(envWithSecret, upSender);
  ok(stillPaid.tier === 'pro' && stillPaid.status === 'active', 'the upgraded plan survived');
  const upGate = await checkFreeTierAllowance(envWithSecret, upSender);
  ok(upGate.remaining === Infinity, 'entitlement survived the sibling cancellation');

  const real = await webhook(subEvent('customer.subscription.deleted', {
    id: 'evt_up_a_del', subId: 'sub_A', customer: 'cus_up', tier: 'pro', created: 2200,
  }));
  ok(real.status === 200 && real.json.applied === true, 'cancelling the LIVE subscription applies');
  ok((await getSubscription(envWithSecret, upSender)).tier === 'free', 'and downgrades to free');

  // A stale update emitted before that delete must not resurrect the plan.
  const stale = await webhook(subEvent('customer.subscription.updated', {
    id: 'evt_up_a_stale', subId: 'sub_A', customer: 'cus_up', tier: 'pro', created: 2150,
  }));
  ok(stale.status === 200 && stale.json.noop === 'older_than_last_applied_event',
     'a stale update after the delete is dropped');
  ok((await getSubscription(envWithSecret, upSender)).tier === 'free', 'access stayed cancelled');

  console.log('\n=======================================');
  console.log(`  ${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch(err => {
  console.error('test runner crashed:', err);
  process.exit(2);
});
