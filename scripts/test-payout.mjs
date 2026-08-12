/**
 * Payout-terms enforcement tests.
 *
 * These cover the money paths, so they run in the deploy gate. Every case here
 * is a real failure that shipped or nearly shipped:
 *  - a clawback that made an overpayment invisible (owed clamped to zero)
 *  - a flat $20 reversal that was wrong in BOTH directions
 *  - a $600 tax threshold repealed for 2026 payments
 *  - a threshold measured on accrued earnings instead of cash paid
 *  - `earnedThisYear || earned` flagging dormant ambassadors via falsy fallback
 *  - a $25 minimum and a 30 day hold that nothing enforced
 */
import assert from 'node:assert/strict';
import {
  PAYOUT_TERMS, HOLD_DAYS, PAYOUT_MINIMUM_USD, TERMS_VERSION,
  REPORTING_THRESHOLD_BY_YEAR, reportingThresholdForYear,
  federalThresholdForYear, stateThresholdForYear,
  payoutState, recordPayout, nextPayoutDate, payoutRunDate,
  isUsFederalHoliday, railFor, acceptTerms,
} from '../worker/src/ambassador.js';
import { recordConversion, reverseConversion, payoutFor, tierFor } from '../worker/src/affiliate.js';

let pass = 0, fail = 0;
const results = [];
async function t(name, fn) {
  try { await fn(); pass++; results.push(`OK   ${name}`); }
  catch (e) { fail++; results.push(`FAIL ${name}\n       ${e.message.split('\n')[0]}`); }
}

const DAY = 24 * 60 * 60 * 1000;
const iso = (ms) => new Date(ms).toISOString();

/** In-memory KV good enough for these modules. */
function makeEnv(seed = {}) {
  const kv = new Map(Object.entries(seed));
  return {
    _kv: kv,
    CYBERSYGN_DOCS: {
      get: async (k) => (kv.has(k) ? kv.get(k) : null),
      put: async (k, v) => { kv.set(k, v); },
      delete: async (k) => { kv.delete(k); },
      list: async () => ({ keys: [...kv.keys()].map(name => ({ name })), list_complete: true }),
    },
  };
}

function entry(amountUsd, ageDays, extra = {}) {
  const at = Date.now() - ageDays * DAY;
  return {
    id: `led_${Math.random().toString(36).slice(2)}`,
    at: iso(at),
    clearsAt: iso(at + HOLD_DAYS * DAY),
    type: 'bounty', planId: 'pro', customerId: `cus_${ageDays}`,
    amount: amountUsd, what: 'pro sale', ...extra,
  };
}

/** A record that has accepted terms and has a tax doc, so gates are open. */
function baseRec(over = {}) {
  return {
    v: 1, code: 'testcode', senderId: 's1', email: 'a@x.com',
    createdAt: '2026-08-12T00:00:00.000Z',
    clicks: 100, conversions: 0, earnedUsd: 0, payouts: [], ledger: [],
    termsVersion: TERMS_VERSION, termsAcceptedAt: '2026-08-12T00:00:00.000Z',
    taxDocState: 'w9_on_file', taxDocType: 'w9',
    ...over,
  };
}

// ---------------------------------------------------------------- terms
await t('PAYOUT_TERMS is the single source of truth and is frozen', () => {
  assert.equal(PAYOUT_TERMS.minimumUsd, 25);
  assert.equal(PAYOUT_TERMS.holdDays, 30);
  assert.equal(PAYOUT_TERMS.scheduleDayOfMonth, 5);
  assert.equal(PAYOUT_TERMS.cookieWindowDays, 60);
  assert.ok(Object.isFrozen(PAYOUT_TERMS));
  assert.throws(() => { 'use strict'; PAYOUT_TERMS.minimumUsd = 1; });
});

await t('published terms text carries no em-dash', () => {
  for (const [k, v] of Object.entries(PAYOUT_TERMS)) {
    if (typeof v === 'string') assert.ok(!/[\u2012\u2013\u2014]/.test(v), `${k} has a dash glyph`);
  }
});

// ---------------------------------------------------------------- tax
await t('2026 FEDERAL threshold is $2,000, not the repealed $600', () => {
  assert.equal(federalThresholdForYear(2026), 2000);
  assert.equal(REPORTING_THRESHOLD_BY_YEAR[2026], 2000);
});

await t('Colorado kept $600, so the governing threshold is $600', () => {
  // Colorado did not conform to the federal increase (owner-confirmed).
  // Filing is triggered by the LOWER floor, so the state one governs.
  assert.equal(stateThresholdForYear(), 600);
  assert.equal(reportingThresholdForYear(2026), 600,
    'the lower of federal and state must govern, not the federal figure');
});

await t('unseeded year falls back to the newest seeded year, loudly', () => {
  const warn = console.warn; let warned = false;
  console.warn = () => { warned = true; };
  const v = federalThresholdForYear(2031);
  console.warn = warn;
  assert.equal(v, 2000);
  assert.ok(warned, 'must warn rather than silently guess an indexed figure');
});

await t('threshold measures CASH PAID in the year, not accrued earnings', () => {
  const now = Date.parse('2026-11-01T00:00:00Z');
  // Accrued $3,000 but only $400 actually paid in 2026, under both floors.
  const rec = baseRec({
    earnedUsd: 3000,
    ledger: [entry(3000, 200)],
    payouts: [{ amount: 400, paidAt: '2026-06-01T00:00:00.000Z', taxYear: 2026 }],
  });
  const st = payoutState(rec, now);
  assert.equal(st.paidThisYearUsd, 400);
  assert.equal(st.reportingLikely, false, '$400 cash is under both thresholds');
});

await t('$1,500 paid owes a COLORADO return but no federal one', () => {
  const now = Date.parse('2026-11-01T00:00:00Z');
  const rec = baseRec({
    earnedUsd: 3000,
    ledger: [entry(3000, 200)],
    payouts: [{ amount: 1500, paidAt: '2026-06-01T00:00:00.000Z', taxYear: 2026 }],
  });
  const st = payoutState(rec, now);
  assert.equal(st.reportingLikelyState, true, 'over the $600 Colorado floor');
  assert.equal(st.reportingLikelyFederal, false, 'under the $2,000 federal floor');
  assert.equal(st.reportingLikely, true, 'either one is a real filing obligation');
  assert.equal(st.federalThresholdUsd, 2000);
  assert.equal(st.stateThresholdUsd, 600);
  assert.equal(st.payerState, 'CO');
});

await t('$2,500 paid owes BOTH returns', () => {
  const now = Date.parse('2026-11-01T00:00:00Z');
  const rec = baseRec({
    earnedUsd: 2500, ledger: [entry(2500, 200)],
    payouts: [{ amount: 2500, paidAt: '2026-06-01T00:00:00.000Z', taxYear: 2026 }],
  });
  const st = payoutState(rec, now);
  assert.equal(st.reportingLikelyFederal, true);
  assert.equal(st.reportingLikelyState, true);
});

await t('the published tax text names both thresholds honestly', () => {
  const s = PAYOUT_TERMS.taxText;
  assert.match(s, /\$2,000/, 'must state the federal figure');
  assert.match(s, /\$600/, 'must state the Colorado figure');
  assert.match(s, /Colorado/, 'must say which state and why it differs');
});

await t('a dormant ambassador is not flagged by a falsy fallback', () => {
  const now = Date.parse('2026-06-01T00:00:00Z');
  // Earned $5,000 in 2025, nothing in 2026, fully paid out in 2025.
  const rec = baseRec({
    earnedUsd: 5000,
    ledger: [{ ...entry(5000, 400), at: '2025-03-01T00:00:00.000Z' }],
    payouts: [{ amount: 5000, paidAt: '2025-04-01T00:00:00.000Z', taxYear: 2025 }],
  });
  const st = payoutState(rec, now);
  assert.equal(st.earnedThisYearUsd, 0, 'zero is a real value, not a trigger for all-time');
  assert.equal(st.paidThisYearUsd, 0);
});

await t('IRC 3406(b)(6): prior-year reporting drops the threshold to zero', () => {
  const now = Date.parse('2027-02-01T00:00:00Z');
  const rec = baseRec({ reportedYears: [2026], earnedUsd: 10, ledger: [entry(10, 90)] });
  const st = payoutState(rec, now);
  assert.equal(st.priorYearReported, true);
  assert.equal(st.reportingThresholdUsd, 0);
});

// ---------------------------------------------------------------- hold
await t('a fresh commission is pending, not payable', () => {
  const rec = baseRec({ earnedUsd: 100, ledger: [entry(100, 1)] });
  const st = payoutState(rec);
  assert.equal(st.pendingUsd, 100);
  assert.equal(st.payableUsd, 0);
  assert.ok(st.blockReasons.includes('nothing_cleared'));
});

await t('hold boundary: day 29 pending, day 31 cleared', () => {
  const a = payoutState(baseRec({ earnedUsd: 100, ledger: [entry(100, 29)] }));
  assert.equal(a.pendingUsd, 100, 'day 29 must still be held');
  const b = payoutState(baseRec({ earnedUsd: 100, ledger: [entry(100, 31)] }));
  assert.equal(b.pendingUsd, 0, 'day 31 must have cleared');
  assert.equal(b.payableUsd, 100);
});

await t('legacy entries with no timestamp clear rather than hang forever', () => {
  const rec = baseRec({ earnedUsd: 80, ledger: [{ amount: 80, what: 'pro sale' }] });
  const st = payoutState(rec);
  assert.equal(st.pendingUsd, 0, 'an undateable old balance must not be trapped');
  assert.equal(st.payableUsd, 80);
});

await t('pending can never exceed earned', () => {
  const rec = baseRec({ earnedUsd: 50, ledger: [entry(50, 1), entry(50, 1)] });
  const st = payoutState(rec);
  assert.ok(st.pendingUsd <= st.earnedAllTimeUsd);
  assert.ok(st.payableUsd >= 0);
});

// ---------------------------------------------------------------- overpayment
await t('THE BUG: clawback below paid surfaces as overpaid, not $0 owed', () => {
  const rec = baseRec({
    earnedUsd: 92, ledger: [entry(92, 60)],
    payouts: [{ amount: 132, paidAt: iso(Date.now() - 40 * DAY), taxYear: 2026 }],
  });
  const st = payoutState(rec);
  assert.equal(st.balanceUsd, -40, 'balance must be allowed to go negative');
  assert.equal(st.overpaidUsd, 40, 'the loss must be visible');
  assert.equal(st.owedUsd, 0);
  assert.ok(st.blockReasons.includes('overpaid_balance'), 'and it must block further payouts');
  assert.equal(st.payable, false);
});

await t('a settled account is NOT pixel-identical to an overpaid one', () => {
  const settled = payoutState(baseRec({
    earnedUsd: 132, ledger: [entry(132, 60)],
    payouts: [{ amount: 132, paidAt: iso(Date.now() - 40 * DAY) }],
  }));
  const over = payoutState(baseRec({
    earnedUsd: 92, ledger: [entry(92, 60)],
    payouts: [{ amount: 132, paidAt: iso(Date.now() - 40 * DAY) }],
  }));
  assert.equal(settled.owedUsd, over.owedUsd, 'both show $0 owed, which is why owed alone lied');
  assert.notEqual(settled.overpaidUsd, over.overpaidUsd, 'overpaidUsd is what tells them apart');
  assert.equal(settled.overpaidUsd, 0);
  assert.equal(over.overpaidUsd, 40);
});

// ---------------------------------------------------------------- minimum + gates
await t('below the $25 minimum blocks, at the minimum passes', () => {
  const under = payoutState(baseRec({ earnedUsd: 24, ledger: [entry(24, 60)] }));
  assert.equal(under.belowMinimum, true);
  assert.ok(under.blockReasons.includes('below_minimum'));
  assert.equal(under.payable, false);

  const at = payoutState(baseRec({ earnedUsd: PAYOUT_MINIMUM_USD, ledger: [entry(PAYOUT_MINIMUM_USD, 60)] }));
  assert.equal(at.belowMinimum, false);
  assert.equal(at.payable, true, `blocked by: ${at.blockReasons.join(',')}`);
});

await t('a missing tax document blocks the payout', () => {
  const rec = baseRec({ earnedUsd: 100, ledger: [entry(100, 60)], taxDocState: 'none', taxDocType: null });
  const st = payoutState(rec);
  assert.equal(st.w9Blocking, true);
  assert.ok(st.blockReasons.includes('tax_doc_missing'));
  assert.equal(st.payable, false);
});

await t('an expired W-8BEN blocks the payout', () => {
  const rec = baseRec({
    earnedUsd: 100, ledger: [entry(100, 60)],
    taxDocState: 'w8ben_on_file', taxDocType: 'w8ben',
    taxDocExpiresAt: iso(Date.now() - 5 * DAY),
  });
  const st = payoutState(rec);
  assert.ok(st.blockReasons.includes('tax_doc_expired'));
});

await t('no terms acceptance blocks a record minted after the terms shipped', () => {
  const rec = baseRec({ earnedUsd: 100, ledger: [entry(100, 60)] });
  delete rec.termsAcceptedAt; delete rec.termsVersion;
  rec.createdAt = '2026-09-01T00:00:00.000Z';
  const st = payoutState(rec);
  assert.ok(st.blockReasons.includes('no_terms_acceptance'));
});

await t('a pre-terms record warns instead of trapping honest money', () => {
  const rec = baseRec({ earnedUsd: 100, ledger: [entry(100, 60)], createdAt: '2026-06-01T00:00:00.000Z' });
  delete rec.termsAcceptedAt; delete rec.termsVersion;
  const st = payoutState(rec);
  assert.ok(st.warnings.includes('no_terms_acceptance'));
  assert.ok(!st.blockReasons.includes('no_terms_acceptance'));
  assert.equal(st.payable, true, `blocked by: ${st.blockReasons.join(',')}`);
});

await t('acceptTerms stamps version and time', () => {
  const rec = baseRec(); delete rec.termsAcceptedAt;
  acceptTerms(rec, TERMS_VERSION, 'iphash');
  assert.equal(rec.termsVersion, TERMS_VERSION);
  assert.ok(rec.termsAcceptedAt);
});

// ---------------------------------------------------------------- recordPayout
await t('recordPayout refuses an amount above payable', async () => {
  const rec = baseRec({ code: 'abc123', earnedUsd: 30, ledger: [entry(30, 60)] });
  const env = makeEnv({ 'affiliate:code:abc123': JSON.stringify(rec) });
  const r = await recordPayout(env, 'abc123', { amount: 500, rail: 'paypal_gs' });
  assert.equal(r.ok, false, 'a $500 payout against a $30 balance must be refused');
  assert.ok(String(r.error).length > 0);
});

await t('recordPayout refuses below the minimum without an override', async () => {
  const rec = baseRec({ code: 'abc124', earnedUsd: 10, ledger: [entry(10, 60)] });
  const env = makeEnv({ 'affiliate:code:abc124': JSON.stringify(rec) });
  const r = await recordPayout(env, 'abc124', { amount: 10, rail: 'paypal_gs' });
  assert.equal(r.ok, false);
});

await t('recordPayout allows a below-minimum final settlement with the override', async () => {
  const rec = baseRec({ code: 'abc125', earnedUsd: 10, ledger: [entry(10, 60)] });
  const env = makeEnv({ 'affiliate:code:abc125': JSON.stringify(rec) });
  const r = await recordPayout(env, 'abc125', { amount: 10, rail: 'paypal_gs', belowMinimum: true });
  assert.equal(r.ok, true, `override must work for closures: ${r.error || ''}`);
});

await t('recordPayout refuses when the tax doc is missing', async () => {
  const rec = baseRec({ code: 'abc126', earnedUsd: 100, ledger: [entry(100, 60)], taxDocState: 'none' });
  const env = makeEnv({ 'affiliate:code:abc126': JSON.stringify(rec) });
  const r = await recordPayout(env, 'abc126', { amount: 100, rail: 'wise' });
  assert.equal(r.ok, false, 'paying an undocumented payee risks 24% backup withholding on us');
});

await t('a recorded payout reduces payable and stamps the tax year', async () => {
  const rec = baseRec({ code: 'abc127', earnedUsd: 100, ledger: [entry(100, 60)] });
  const env = makeEnv({ 'affiliate:code:abc127': JSON.stringify(rec) });
  const r = await recordPayout(env, 'abc127', { amount: 100, rail: 'paypal_gs' });
  assert.equal(r.ok, true, r.error || '');
  const after = JSON.parse(env._kv.get('affiliate:code:abc127'));
  const st = payoutState(after);
  assert.equal(st.paidUsd, 100);
  assert.equal(st.payableUsd, 0);
  assert.ok(after.payouts[0].taxYear, 'taxYear must be stamped at write time');
});

// ---------------------------------------------------------------- clawback
await t('reversal backs out the EXACT credit, not a flat $20', async () => {
  const env = makeEnv();
  const code = 'gold01';
  const rec = baseRec({ code, conversions: 20, earnedUsd: 0 });
  await env.CYBERSYGN_DOCS.put(`affiliate:code:${code}`, JSON.stringify(rec));

  const conv = await recordConversion(env, code, 'cus_biz', 'business', 'sub_1');
  const loaded = JSON.parse(env._kv.get(`affiliate:code:${code}`));
  const credited = loaded.earnedUsd;
  assert.ok(credited > 20, `a Gold Business sale credits ${credited}, well above the flat $20`);

  const rev = await reverseConversion(env, code, 'cus_biz', 'chargeback');
  assert.equal(rev.ok, true);
  assert.equal(rev.clawedBackUsd, credited, 'must claw back exactly what it credited');
  const after = JSON.parse(env._kv.get(`affiliate:code:${code}`));
  assert.equal(after.earnedUsd, 0, 'back to square, no residue in either direction');
  void conv;
});

await t('a small sale reversal does not steal from other sales', async () => {
  const env = makeEnv();
  const code = 'orig01';
  await env.CYBERSYGN_DOCS.put(`affiliate:code:${code}`, JSON.stringify(baseRec({ code, conversions: 0, earnedUsd: 0 })));
  await recordConversion(env, code, 'cus_a', 'founding', 'sub_a');
  await recordConversion(env, code, 'cus_b', 'pro', 'sub_b');
  const both = JSON.parse(env._kv.get(`affiliate:code:${code}`));
  const proBounty = both.ledger.find(e => e.type === 'bounty' && e.customerId === 'cus_b').amount;

  await reverseConversion(env, code, 'cus_a', 'refund');
  const after = JSON.parse(env._kv.get(`affiliate:code:${code}`));

  // The surviving sale keeps every cent of its own bounty.
  assert.ok(after.earnedUsd >= proBounty, 'the surviving sale keeps its bounty');
  // And the ledger still reconciles to the scalar.
  assert.equal(Math.round(after.ledger.reduce((s, e) => s + e.amount, 0) * 100) / 100, after.earnedUsd,
    'ledger and earnedUsd stay in lockstep through a reversal');
});

// THE INVARIANT the whole reconcile exists to protect. Earnings must be a pure
// function of the sales that are still standing. If a refunded-then-replaced
// book paid differently from a clean book of the same shape, the ledger drifts
// and neither the ambassador nor the owner can ever reconcile it.
await t('identical standing books pay identically, refunds and all', async () => {
  async function bookValue(code, steps) {
    const env = makeEnv();
    await env.CYBERSYGN_DOCS.put(`affiliate:code:${code}`, JSON.stringify(baseRec({ code, conversions: 0, earnedUsd: 0 })));
    for (const s of steps) {
      if (s[0] === 'sale') await recordConversion(env, code, s[1], s[2], `sub_${s[1]}`);
      else await reverseConversion(env, code, s[1], 'refund');
    }
    return JSON.parse(env._kv.get(`affiliate:code:${code}`)).earnedUsd;
  }
  // Sold two, refunded one. Standing book: a single pro sale.
  const messy = await bookValue('mess01', [
    ['sale', 'cus_a', 'founding'], ['sale', 'cus_b', 'pro'], ['rev', 'cus_a'],
  ]);
  // Sold one, never refunded. Standing book: a single pro sale. Same shape.
  const clean = await bookValue('cln001', [['sale', 'cus_b', 'pro']]);
  assert.equal(messy, clean,
    `a refunded-and-replaced book must pay the same as a clean one (${messy} vs ${clean})`);
});

await t('reversal writes a negative ledger entry so ledger and earned agree', async () => {
  const env = makeEnv();
  const code = 'ledg01';
  await env.CYBERSYGN_DOCS.put(`affiliate:code:${code}`, JSON.stringify(baseRec({ code })));
  await recordConversion(env, code, 'cus_x', 'pro', 'sub_x');
  await reverseConversion(env, code, 'cus_x', 'refund');
  const after = JSON.parse(env._kv.get(`affiliate:code:${code}`));
  const sum = after.ledger.reduce((s, e) => s + Number(e.amount || 0), 0);
  assert.equal(Math.round(sum * 100) / 100, after.earnedUsd, 'ledger sum must equal earnedUsd');
  assert.ok(after.ledger.some(e => e.type === 'reversal' && e.amount < 0));
});

await t('reversal is idempotent', async () => {
  const env = makeEnv();
  const code = 'idem01';
  await env.CYBERSYGN_DOCS.put(`affiliate:code:${code}`, JSON.stringify(baseRec({ code })));
  await recordConversion(env, code, 'cus_y', 'pro', 'sub_y');
  await reverseConversion(env, code, 'cus_y', 'refund');
  const once = JSON.parse(env._kv.get(`affiliate:code:${code}`)).earnedUsd;
  const again = await reverseConversion(env, code, 'cus_y', 'refund');
  assert.equal(again.alreadyHandled, true);
  assert.equal(JSON.parse(env._kv.get(`affiliate:code:${code}`)).earnedUsd, once);
});

await t('a legacy dedupe record still reverses using the flat fallback', async () => {
  const env = makeEnv();
  const code = 'lgcy01';
  await env.CYBERSYGN_DOCS.put(`affiliate:code:${code}`, JSON.stringify(baseRec({ code, conversions: 1, earnedUsd: 20 })));
  await env.CYBERSYGN_DOCS.put(`affiliate:conv:${code}:cus_old`, JSON.stringify({ at: '2026-01-01T00:00:00.000Z', tier: 'pro' }));
  const r = await reverseConversion(env, code, 'cus_old', 'refund');
  assert.equal(r.ok, true);
  assert.equal(r.legacyFlatClawback, true, 'and it must say it used the fallback');
});

await t('reversal frees the sprint bonus to be re-earned honestly', async () => {
  const env = makeEnv();
  const code = 'sprnt1';
  await env.CYBERSYGN_DOCS.put(`affiliate:code:${code}`, JSON.stringify(baseRec({ code })));
  for (let i = 0; i < 5; i++) await recordConversion(env, code, `cus_s${i}`, 'pro', `sub_s${i}`);
  const peak = JSON.parse(env._kv.get(`affiliate:code:${code}`));
  assert.equal(peak.monthly.sprintPaid, true, '5 sales in a month earns the sprint');
  await reverseConversion(env, code, 'cus_s4', 'refund');
  const after = JSON.parse(env._kv.get(`affiliate:code:${code}`));
  assert.equal(after.monthly.sales, 4);
  assert.equal(after.monthly.sprintPaid, false, 'the sprint must be re-earnable, not burned');
});

// ---------------------------------------------------------------- schedule
await t('payout run date is the 5th, pushed off weekends and holidays', () => {
  const d = payoutRunDate(2026, 0); // January 2026
  assert.equal(d.getUTCDate() >= 5, true);
  // July 4 2026 falls on a Saturday, so the observed federal holiday is Friday
  // the 3rd. The run must dodge the OBSERVED day, which is when banks are shut.
  assert.equal(isUsFederalHoliday(new Date(Date.UTC(2026, 6, 3))), true, 'observed July 4 is Fri Jul 3');
  assert.equal(isUsFederalHoliday(new Date(Date.UTC(2026, 6, 4))), false, 'the Saturday itself is not the observed day');
  assert.equal(isUsFederalHoliday(new Date(Date.UTC(2026, 0, 1))), true, 'New Year 2026 is a Thursday');
  // The run day itself must never land on a weekend or an observed holiday.
  for (let m = 0; m < 12; m++) {
    const run = payoutRunDate(2026, m);
    assert.ok(run.getUTCDay() !== 0 && run.getUTCDay() !== 6, `run ${run.toISOString()} lands on a weekend`);
    assert.equal(isUsFederalHoliday(run), false, `run ${run.toISOString()} lands on a holiday`);
  }
});

await t('nextPayoutDate returns a real future ISO date', () => {
  const n = nextPayoutDate(new Date('2026-08-12T00:00:00Z'));
  assert.match(String(n), /^\d{4}-\d{2}-\d{2}/);
  assert.ok(Date.parse(n) > Date.parse('2026-08-12T00:00:00Z'));
});

// ---------------------------------------------------------------- rails
await t('rail normalization maps legacy free-text methods', () => {
  assert.equal(railFor('paypal_gs'), 'paypal_gs');
  assert.equal(railFor('', 'PayPal'), 'paypal_gs');
  assert.equal(railFor('wise'), 'wise');
  assert.equal(railFor('credit'), 'account_credit');
});

await t('every published method maps to a real rail', () => {
  for (const m of PAYOUT_TERMS.methods) {
    assert.ok(PAYOUT_TERMS.rails.includes(railFor('', m)), `${m} has no rail`);
  }
});

// ---------------------------------------------------------------- economics
await t('bounties still scale by plan and tier', () => {
  assert.ok(payoutFor('business', 0) > payoutFor('solo', 0));
  assert.equal(tierFor(0).key, 'bronze');
  assert.equal(tierFor(5).key, 'silver');
  assert.equal(tierFor(15).key, 'gold');
  assert.ok(payoutFor('pro', 15) > payoutFor('pro', 0), 'gold pays more than bronze');
});

await t('rounding stays clean across many tiered sales', async () => {
  const env = makeEnv();
  const code = 'round1';
  await env.CYBERSYGN_DOCS.put(`affiliate:code:${code}`, JSON.stringify(baseRec({ code })));
  for (let i = 0; i < 25; i++) await recordConversion(env, code, `cus_r${i}`, 'pro', `sub_r${i}`);
  const rec = JSON.parse(env._kv.get(`affiliate:code:${code}`));
  assert.equal(rec.earnedUsd, Math.round(rec.earnedUsd * 100) / 100, 'no sub-cent drift');
  const sum = rec.ledger.reduce((s, e) => s + Number(e.amount || 0), 0);
  assert.equal(Math.round(sum * 100) / 100, rec.earnedUsd);
});

console.log(results.join('\n'));
console.log(`\npayout enforcement: ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
