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
  console.log('\n5. Owner mode skips Stripe');
  const ownerClaim = await call('POST', '/api/owner/claim', { phrase: 'cybersygn-dev-owner' });
  ok(ownerClaim.status === 200, 'owner claim succeeded');
  const ownerToken = ownerClaim.json && ownerClaim.json.token;
  ok(typeof ownerToken === 'string' && ownerToken.length === 64, 'owner token returned');

  const ownerCheckout = await call(
    'POST',
    '/api/checkout/create-session',
    { tier: 'solo', senderId: 'sender-owner' },
    { 'x-cybersygn-owner': ownerToken },
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
  const d1 = await call('POST', '/api/docs', newDocBody(senderId));
  ok(d1.status === 201, 'doc 1 of 3 accepted');
  const d2 = await call('POST', '/api/docs', newDocBody(senderId));
  ok(d2.status === 201, 'doc 2 of 3 accepted');
  const d3 = await call('POST', '/api/docs', newDocBody(senderId));
  ok(d3.status === 201, 'doc 3 of 3 accepted');
  const d4 = await call('POST', '/api/docs', newDocBody(senderId));
  ok(d4.status === 402, 'doc 4 hit free-tier limit (402)');
  ok(d4.json && d4.json.error === 'free_tier_limit', 'error code is free_tier_limit');

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

  console.log('\n=======================================');
  console.log(`  ${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch(err => {
  console.error('test runner crashed:', err);
  process.exit(2);
});
