/**
 * Ambassador program: identity, product pass, learning progress, payouts.
 *
 * IDENTITY. An ambassador is resolved by senderId, via ambassadorBySender.
 *
 * This header used to claim identity was by emailHash "never by a device-local
 * senderId", describing an affiliate:email:<emailHash> index. That index was
 * never written by anything. Two functions existed to read and populate it and
 * neither had a caller, so the whole subsystem was documentation of a design
 * that was not built. They have been removed rather than left to look like
 * working code.
 *
 * A laptop-to-phone switch is still covered, by the product's ONE auth system
 * rather than an ambassador-specific one: the magic link in auth.js binds
 * emailHash to senderId and restores the senderId on a new device, after which
 * ambassadorBySender resolves normally. The dashboard's "Sign in" is that path.
 *
 * The ambassador record hangs off the affiliate code record that affiliate.js
 * already owns; this module adds the parts that make it a real program rather
 * than a counter.
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
 *
 * (There is no affiliate:email: index. erasure.js still probes for one when
 * deleting, which is harmless and costs one miss, so a legacy key from any
 * earlier deployment would still be cleaned up.)
 */

const KV = 'affiliate:';
const PASS_DAYS = 90;

/** Days -> ms. */
const DAY_MS = 24 * 60 * 60 * 1000;

// ---- Payout terms: ONE canonical constant ---------------------------------

/**
 * PAYOUT_TERMS is the single source of truth for every number in the payout
 * program. The public terms page, the ambassador dashboard, the owner roster
 * and the enforcement code in this file all read from here, so the terms we
 * publish and the terms we enforce can never drift apart. If a number is not
 * in this object it is not a term of the program.
 *
 * Nothing here is aspirational. Every value below is enforced server-side by
 * payoutState() and recordPayout() in this same file.
 */
export const HOLD_DAYS = 30;
export const PAYOUT_MINIMUM_USD = 25;
export const PAYOUT_RUN_DAY = 5;
export const COOKIE_WINDOW_DAYS = 60;
export const TERMS_VERSION = '2026-08-12';

/**
 * Form 1099-NEC reporting threshold, BY YEAR. Never a bare literal.
 * IRC 6041(a) was amended to $2,000 by Pub. L. 119-21 section 70433 for
 * payments made after December 31, 2025, and IRC 6041(h) re-indexes the
 * amount for inflation for years after 2026 (rounded to the nearest $100).
 * A hardcoded number is therefore wrong again on January 1, 2027, so each
 * year has to be seeded explicitly as the indexed figure is published.
 */
export const REPORTING_THRESHOLD_BY_YEAR = { 2026: 2000 };

/**
 * STATE filing thresholds, which did NOT all follow the federal increase.
 *
 * Colorado kept $600 (confirmed by the owner, 2026-08-12). CyberSygn operates
 * from Colorado, so the number that actually decides whether a return has to
 * be filed for a payee is $600, not the federal $2,000. Filing is triggered by
 * the LOWER of the two: clearing the state floor creates a real obligation
 * even though the federal one is untouched.
 *
 * PAYER_STATE is the state we file from. It is not the payee's state: the
 * obligation follows the payer here.
 */
export const PAYER_STATE = 'CO';
export const STATE_REPORTING_THRESHOLD = { CO: 600 };

/** Federal threshold for a calendar year, loudly on a miss. */
export function federalThresholdForYear(year) {
  const y = Number(year);
  if (Object.prototype.hasOwnProperty.call(REPORTING_THRESHOLD_BY_YEAR, y)) {
    return REPORTING_THRESHOLD_BY_YEAR[y];
  }
  // Unseeded year: fall back to the highest seeded year and SAY SO. Guessing
  // the indexed figure silently is how a wrong number ships for 12 months.
  const seeded = Object.keys(REPORTING_THRESHOLD_BY_YEAR).map(Number).sort((a, b) => a - b);
  const newest = seeded.length ? seeded[seeded.length - 1] : null;
  console.warn('[ambassador] no reporting threshold seeded for year', y, 'falling back to', newest);
  return newest === null ? 0 : REPORTING_THRESHOLD_BY_YEAR[newest];
}

/** The state floor we file against, or 0 when the payer state has none. */
export function stateThresholdForYear() {
  const v = STATE_REPORTING_THRESHOLD[PAYER_STATE];
  return Number.isFinite(v) ? v : 0;
}

/**
 * The threshold that actually decides filing: the lower of federal and state,
 * ignoring a zero (meaning "no state floor") so a state without one does not
 * collapse the federal number to nothing.
 */
export function reportingThresholdForYear(year) {
  const fed = federalThresholdForYear(year);
  const st = stateThresholdForYear();
  if (st > 0 && st < fed) return st;
  return fed;
}

export const PAYOUT_TERMS = Object.freeze({
  version: TERMS_VERSION,
  termsVersion: TERMS_VERSION,
  minimumUsd: PAYOUT_MINIMUM_USD,
  holdDays: HOLD_DAYS,
  scheduleDayOfMonth: PAYOUT_RUN_DAY,
  cookieWindowDays: COOKIE_WINDOW_DAYS,
  // The governing figure: the lower of federal and state. Colorado kept $600.
  taxThresholdUsd: reportingThresholdForYear(new Date().getUTCFullYear()),
  taxThresholdFederalUsd: federalThresholdForYear(new Date().getUTCFullYear()),
  taxThresholdStateUsd: stateThresholdForYear(),
  payerState: PAYER_STATE,
  taxThresholdByYear: Object.freeze({ ...REPORTING_THRESHOLD_BY_YEAR }),
  methods: Object.freeze([
    'PayPal goods and services',
    'Wise',
    'CyberSygn account credit',
  ]),
  rails: Object.freeze(['paypal_gs', 'wise', 'account_credit']),
  scheduleText: "Payouts run once a month, on the 5th (next business day if the 5th falls on a weekend or a US holiday). A commission joins a run once its 30 day hold has finished on or before the 5th. For most sales that is 30 to 35 days from the day the customer's payment cleared. A sale that clears just after a monthly cutoff waits for the following run, which is up to about 60 days. Balances under the $25 minimum roll over and are paid in the first run that clears the minimum. Any balance is paid in full, minimum waived, on request after 90 days with no new qualifying sale, on account closure, and if the program shuts down. Account credit against a CyberSygn subscription has no minimum and no transfer fee. CyberSygn pays the sending fee on PayPal and Wise; any receiving or currency conversion fee charged by the ambassador's own bank or PayPal account is theirs. One person, the founder, runs every payout by hand. There is no automation and no cron job behind this schedule, and zero ambassadors have been paid to date.",
  clawbackText: "If a referred customer's payment is refunded, charged back, disputed, or otherwise reversed, the commission for that sale is reversed. The reversal backs out the exact amount that sale credited, including any milestone bonus or monthly sprint bonus that the sale triggered, not a flat figure, and it is written to the ambassador's ledger as a visible negative entry with the reason and the date. The sale also stops counting toward lifetime sales and tier. If the unpaid balance covers the reversal, it comes out of the balance. If the reversal is larger than the unpaid balance, the shortfall becomes a negative balance carried forward and offset against future commissions. CyberSygn will not invoice an ambassador for a reversal and will not ask for money back. If an ambassador leaves the program, or the program ends, while carrying a negative balance, the balance is written off to zero. The single exception is fraud or self-dealing, where we reserve the right to recover. Card networks generally allow a customer to dispute a charge for up to 120 days after payment, and some payment methods allow up to 180 days, so a reversal can arrive well after a commission has already been paid. The 30 day hold covers the common case and the carry-forward rule covers the long tail. Separately, and as a condition of eligibility: commission is earned only on promotion that clearly and conspicuously discloses the paid relationship, as the FTC Endorsement Guides require of the advertiser at 16 CFR 255.1(d). CyberSygn may withhold or reverse commission on any sale generated by an undisclosed placement, and may end the arrangement for repeated non-disclosure. Both the pending balance and any negative balance are shown to the ambassador and to the owner, never hidden or clamped to zero.",
  taxText: 'A completed W-9 (US) or W-8BEN (non-US) must be on file before the first dollar moves, at any amount. A missing, refused, or expired tax document blocks the payout. CyberSygn does not store a TIN, an SSN, or a raw tax form: collection is routed to a third-party collector and only a status flag plus an opaque vendor payee id is kept. Two thresholds apply and the lower one governs. Federal: for payments made in calendar year 2026 the Form 1099-NEC threshold is $2,000, raised from $600 by IRC 6041(a) as amended by Pub. L. 119-21 section 70433. State: CyberSygn files from Colorado, which kept the $600 threshold and did not follow the federal increase, so a return is filed once $600 is paid in a year even though no federal return is due until $2,000. Both are measured against cash actually paid in the calendar year, not commission accrued.',
  releaseValveText: 'Any balance is paid in full, minimum waived, on request after 90 days with no new qualifying sale, on account closure, and if the program shuts down.',
  honestyNote: 'Payouts are recorded by hand today, not automatically. One founder runs every run. Zero ambassadors have been paid to date.',
});

/** Tax document states. 'received' is the legacy spelling of w9_on_file. */
export const TAX_DOC_STATES = Object.freeze([
  'none', 'requested', 'received', 'w9_on_file', 'w8ben_on_file', 'w8ben_expired', 'refused',
]);
const TAX_DOC_ON_FILE = Object.freeze(['received', 'w9_on_file', 'w8ben_on_file']);

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


/** Resolve from a senderId (the legacy path), else null. */
export async function ambassadorBySender(env, senderId) {
  if (!env || !env.CYBERSYGN_DOCS || !senderId) return null;
  try {
    const code = await env.CYBERSYGN_DOCS.get(`${KV}sender:${senderId}`);
    return code ? await readCode(env, code.trim()) : null;
  } catch (e) { return null; }
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

// ---- Terms acceptance -----------------------------------------------------

/**
 * Record that this ambassador accepted the published payout terms. Stores the
 * version they agreed to plus the moment, so a clawback or a revoke rests on a
 * document the person actually saw. Mutates and returns the record; the caller
 * persists (acceptTermsForCode below does both).
 */
export function acceptTerms(rec, version, ipHash) {
  if (!rec) return rec;
  rec.termsVersion = String(version || TERMS_VERSION).slice(0, 40);
  rec.termsAcceptedAt = new Date().toISOString();
  if (ipHash) rec.termsAcceptedIpHash = String(ipHash).slice(0, 128);
  // The FTC disclosure condition lives in the same document, so accepting the
  // terms is the attestation. 16 CFR 255.1(d) expects the advertiser to hold
  // exactly this lever.
  rec.disclosureAttestedAt = rec.termsAcceptedAt;
  return rec;
}

/** Accept terms for a code and persist. Returns the fresh payout state. */
export async function acceptTermsForCode(env, code, version, ipHash) {
  const rec = await readCode(env, code);
  if (!rec) return { ok: false, error: 'unknown_code' };
  acceptTerms(rec, version, ipHash);
  const wrote = await writeCode(env, rec);
  if (!wrote) return { ok: false, error: 'kv_write_failed' };
  return {
    ok: true,
    termsVersion: rec.termsVersion,
    termsAcceptedAt: rec.termsAcceptedAt,
    state: payoutState(rec),
  };
}

/** Has this record accepted the CURRENT published terms version? */
export function termsAccepted(rec) {
  return !!(rec && rec.termsAcceptedAt && rec.termsVersion === TERMS_VERSION);
}

// ---- Tax document state ---------------------------------------------------

/**
 * Mark an ambassador's tax document state (owner action, after the third-party
 * collector reports back).
 *
 * WE NEVER STORE A TIN, AN SSN, AN EIN, OR AN IMAGE OF A W-9 OR W-8BEN.
 * Only a state enum, a timestamp, the document type, the collector's name and
 * an opaque vendor payee id ever touch KV. The reason is concrete, not
 * theoretical: Cloudflare KV has no field-level encryption and no access audit
 * trail, and our own backup tooling copies every value it can read. A TIN in
 * KV would be silently duplicated into backups with nothing recording who read
 * it. Collection is routed to a vendor that stores the number, does IRS TIN
 * matching, and files; we keep the flag. Any field that looks like a tax
 * identifier is dropped on the floor below rather than persisted.
 */
export async function setW9State(env, code, state, opts = {}) {
  const rec = await readCode(env, code);
  if (!rec) return { ok: false, error: 'unknown_code' };
  const next = String(state || '').trim().toLowerCase();
  if (!TAX_DOC_STATES.includes(next)) {
    return { ok: false, error: 'invalid_state', allowed: TAX_DOC_STATES.slice() };
  }
  rec.w9State = next;
  rec.taxDocState = next;
  rec.w9StateAt = new Date().toISOString();
  rec.taxDocStateAt = rec.w9StateAt;
  if (TAX_DOC_ON_FILE.includes(next)) {
    rec.taxDocCollectedAt = validIso(opts.collectedAt) || rec.w9StateAt;
  }
  const type = String(opts.docType || (next === 'w8ben_on_file' ? 'w8ben' : next === 'w9_on_file' || next === 'received' ? 'w9' : '') || '').toLowerCase();
  if (type === 'w9' || type === 'w8ben') rec.taxDocType = type;
  if (opts.vendor) rec.taxDocVendor = String(opts.vendor).slice(0, 60);
  if (opts.vendorPayeeId) rec.taxDocVendorPayeeId = String(opts.vendorPayeeId).slice(0, 120);
  // W-8BEN is valid through the last day of the third succeeding calendar year
  // from signature, so an expiry is a real date we have to model, not a
  // formality. A W-9 does not expire.
  if (rec.taxDocType === 'w8ben') {
    rec.taxDocExpiresAt = validIso(opts.expiresAt) || w8benExpiry(rec.taxDocCollectedAt || rec.w9StateAt);
  }
  if (opts.country) rec.taxCountry = String(opts.country).trim().toUpperCase().slice(0, 2);
  // Belt and braces: strip anything a caller may have smuggled onto the record
  // that resembles a tax identifier. See the block comment above.
  for (const banned of ['tin', 'ssn', 'ein', 'taxId', 'taxIdLast4', 'w9Image', 'w9Pdf']) {
    if (banned in rec) delete rec[banned];
  }
  const wrote = await writeCode(env, rec);
  if (!wrote) return { ok: false, error: 'kv_write_failed' };
  return { ok: true, code: rec.code, w9State: rec.w9State, state: payoutState(rec) };
}

/** Owner freeze / unfreeze, independent of the automatic blocks. */
export async function setPayoutBlock(env, code, blocked, reason) {
  const rec = await readCode(env, code);
  if (!rec) return { ok: false, error: 'unknown_code' };
  rec.payoutBlock = blocked
    ? { blocked: true, reason: String(reason || 'owner freeze').slice(0, 200), at: new Date().toISOString() }
    : { blocked: false, reason: '', at: new Date().toISOString() };
  const wrote = await writeCode(env, rec);
  if (!wrote) return { ok: false, error: 'kv_write_failed' };
  return { ok: true, payoutBlock: rec.payoutBlock, state: payoutState(rec) };
}

// ---- Payout state ---------------------------------------------------------

function num(v) { const n = Number(v); return Number.isFinite(n) ? n : 0; }
function round2(n) { return Math.round((Number(n) || 0) * 100) / 100; }
function validIso(v) {
  const t = Date.parse(v);
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
}

/** Last day of the third succeeding calendar year from signature (W-8BEN). */
export function w8benExpiry(signedAt) {
  const t = Date.parse(signedAt);
  const base = Number.isFinite(t) ? new Date(t) : new Date();
  return new Date(Date.UTC(base.getUTCFullYear() + 3, 11, 31, 23, 59, 59)).toISOString();
}

/**
 * Has this ledger entry finished its hold?
 *
 * DEGRADE SAFELY. A pre-hold record has entries with no clearsAt, and some very
 * old entries may have no parseable `at` either. An entry we cannot age is
 * treated as CLEARED, never as pending. Trapping an old honest balance in a
 * hold window that nothing can ever end would be a worse failure than paying
 * out money that is already 30 days stale: that balance was accrued under the
 * no-hold terms these people were actually shown, so holding it now would be a
 * retroactive takeaway. Reversals (negative amounts) always bite immediately;
 * a clawback that waited 30 days to reduce a balance would let already-refunded
 * money be paid out in the meantime.
 */
function entryCleared(entry, nowMs) {
  const amt = num(entry && entry.amount);
  if (amt < 0) return true;
  const clears = Date.parse(entry && entry.clearsAt);
  if (Number.isFinite(clears)) return clears <= nowMs;
  const at = Date.parse(entry && entry.at);
  if (Number.isFinite(at)) return at + HOLD_DAYS * DAY_MS <= nowMs;
  return true;
}

/** True on the weekend or a US federal holiday (dates are UTC). */
export function isBusinessDay(d) {
  const dow = d.getUTCDay();
  if (dow === 0 || dow === 6) return false;
  return !isUsFederalHoliday(d);
}

function nthWeekdayOfMonth(year, month, weekday, n) {
  const first = new Date(Date.UTC(year, month, 1));
  const shift = (weekday - first.getUTCDay() + 7) % 7;
  return 1 + shift + (n - 1) * 7;
}
function lastWeekdayOfMonth(year, month, weekday) {
  const last = new Date(Date.UTC(year, month + 1, 0));
  const back = (last.getUTCDay() - weekday + 7) % 7;
  return last.getUTCDate() - back;
}

/**
 * US federal holidays, including the Saturday-to-Friday and Sunday-to-Monday
 * observance shifts. The only fixed holiday that can ever land on the 5th is
 * July 4 observed on Monday July 5, and the only floating one is Labor Day,
 * which falls on September 5 whenever that is the first Monday. Both are real
 * and both would otherwise print a payout date the bank does not honor.
 */
export function isUsFederalHoliday(d) {
  const y = d.getUTCFullYear();
  const m = d.getUTCMonth();
  const day = d.getUTCDate();
  const dow = d.getUTCDay();
  const fixed = [[0, 1], [5, 19], [6, 4], [10, 11], [11, 25]];
  for (const [fm, fd] of fixed) {
    if (m === fm && day === fd && dow !== 0 && dow !== 6) return true;
    // Observed shifts: Saturday holiday -> observed Friday before,
    // Sunday holiday -> observed Monday after.
    const actual = new Date(Date.UTC(y, fm, fd));
    if (actual.getUTCDay() === 6) {
      const obs = new Date(actual.getTime() - DAY_MS);
      if (obs.getUTCFullYear() === y && obs.getUTCMonth() === m && obs.getUTCDate() === day) return true;
    }
    if (actual.getUTCDay() === 0) {
      const obs = new Date(actual.getTime() + DAY_MS);
      if (obs.getUTCFullYear() === y && obs.getUTCMonth() === m && obs.getUTCDate() === day) return true;
    }
  }
  // New Year's Day falling on a Saturday is observed on December 31 prior year.
  const nextNy = new Date(Date.UTC(y + 1, 0, 1));
  if (nextNy.getUTCDay() === 6 && m === 11 && day === 31) return true;
  if (m === 0 && day === nthWeekdayOfMonth(y, 0, 1, 3)) return true;   // MLK Day
  if (m === 1 && day === nthWeekdayOfMonth(y, 1, 1, 3)) return true;   // Presidents Day
  if (m === 4 && day === lastWeekdayOfMonth(y, 4, 1)) return true;     // Memorial Day
  if (m === 8 && day === nthWeekdayOfMonth(y, 8, 1, 1)) return true;   // Labor Day
  if (m === 9 && day === nthWeekdayOfMonth(y, 9, 1, 2)) return true;   // Columbus Day
  if (m === 10 && day === nthWeekdayOfMonth(y, 10, 4, 4)) return true; // Thanksgiving
  return false;
}

/** The run date for a given month: the 5th, rolled forward to a business day. */
export function payoutRunDate(year, month) {
  const d = new Date(Date.UTC(year, month, PAYOUT_RUN_DAY));
  let guard = 0;
  while (!isBusinessDay(d) && guard < 10) { d.setUTCDate(d.getUTCDate() + 1); guard += 1; }
  return d;
}

/** ISO date (YYYY-MM-DD) of the next scheduled payout run, from `from`. */
export function nextPayoutDate(from = new Date()) {
  const now = from instanceof Date ? from : new Date(from);
  const todayMs = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  let run = payoutRunDate(now.getUTCFullYear(), now.getUTCMonth());
  if (run.getTime() < todayMs) run = payoutRunDate(now.getUTCFullYear(), now.getUTCMonth() + 1);
  return run.toISOString().slice(0, 10);
}

/**
 * The full money picture for one ambassador.
 *
 * Everything downstream (owner roster, owner report, ambassador dashboard,
 * lifecycle emails) reads these fields, so the field names that already
 * existed are kept exactly: earnedAllTimeUsd, paidUsd, owedUsd,
 * earnedThisYearUsd, w9Required, w9State. owedUsd stays what it always was,
 * total unpaid liability, because the owner report prints it as liability.
 * payableUsd is the NEW number a payout may actually draw against: cleared
 * money only, floored at zero.
 *
 * The hold split works off the ledger but the total comes from rec.earnedUsd,
 * which recordConversion and reverseConversion keep in lockstep with the
 * ledger. Any earnings not represented by a ledger entry (an old truncated
 * ledger) therefore land in CLEARED, which is the safe direction.
 */
export function payoutState(rec, now = Date.now()) {
  const nowMs = now instanceof Date ? now.getTime() : Number(now) || Date.now();
  const ledger = Array.isArray(rec && rec.ledger) ? rec.ledger : [];
  const payouts = Array.isArray(rec && rec.payouts) ? rec.payouts : [];

  const ledgerSum = round2(ledger.reduce((s, e) => s + num(e.amount), 0));
  const scalar = Number(rec && rec.earnedUsd);
  const earned = Number.isFinite(scalar)
    ? round2(scalar)
    : round2(ledgerSum + num(rec && rec.ledgerArchivedUsd));
  const paid = round2(payouts.reduce((s, p) => s + num(p.amount), 0));

  // UNCLAMPED. This is the number the Math.max used to swallow.
  const balance = round2(earned - paid);
  const owed = Math.max(0, balance);
  const overpaid = Math.max(0, round2(-balance));

  let pendingRaw = 0;
  for (const e of ledger) {
    const amt = num(e.amount);
    if (amt <= 0) continue;
    if (!entryCleared(e, nowMs)) pendingRaw += amt;
  }
  const pending = Math.min(round2(pendingRaw), Math.max(0, earned));
  const cleared = Math.max(0, round2(earned - pending));
  const payable = Math.max(0, round2(cleared - paid));

  const year = new Date(nowMs).getUTCFullYear();
  const earnedThisYear = round2(ledger
    .filter(e => String(e.at || '').slice(0, 4) === String(year))
    .reduce((s, e) => s + num(e.amount), 0));
  // CASH BASIS. Information reporting counts money actually paid in the
  // calendar year, not commission accrued, and zero is a real value here: no
  // falsy fallback to an all-time figure, which used to flag dormant
  // ambassadors and show them a year-to-date number they never earned.
  const paidThisYear = round2(payouts
    .filter(p => payoutTaxYear(p) === year)
    .reduce((s, p) => s + num(p.amount), 0));

  const reportedYears = Array.isArray(rec && rec.reportedYears) ? rec.reportedYears.map(Number) : [];
  // IRC 3406(b)(6): if we filed an information return for this payee last year,
  // there is no dollar floor this year. Reportable from the first dollar.
  const priorYearReported = reportedYears.includes(year - 1);
  // Federal and state are separate filings with different floors. Colorado kept
  // $600 while federal moved to $2,000, so a payee can owe a STATE return and
  // no federal one. Report both rather than one blended number, because at
  // year end they are two different stacks of paperwork.
  const federalThreshold = priorYearReported ? 0 : federalThresholdForYear(year);
  const stateThreshold = priorYearReported ? 0 : stateThresholdForYear();
  const threshold = priorYearReported ? 0 : reportingThresholdForYear(year);
  const reportingLikelyFederal = paidThisYear >= federalThreshold;
  const reportingLikelyState = stateThreshold > 0 && paidThisYear >= stateThreshold;
  const reportingLikely = reportingLikelyFederal || reportingLikelyState;

  const w9State = normalizeTaxDocState(rec);
  const expiresAt = (rec && rec.taxDocExpiresAt) || null;
  const expired = w9State === 'w8ben_expired' ||
    (!!expiresAt && Date.parse(expiresAt) < nowMs && rec.taxDocType === 'w8ben');
  const onFile = TAX_DOC_ON_FILE.includes(w9State) && !expired;
  // Program policy is stricter than the statute on purpose: documentation
  // before the first dollar, at any amount. All leverage disappears the moment
  // money moves, and an undocumented payee we later owe backup withholding on
  // costs us 24 percent out of pocket with no realistic recovery.
  const w9Required = earned > 0 || paid > 0 || reportingLikely;
  const w9Blocking = w9Required && !onFile;

  const frozen = !!(rec && rec.payoutBlock && rec.payoutBlock.blocked);
  const acceptedTerms = !!(rec && rec.termsAcceptedAt);
  // Records minted before the terms page existed cannot have accepted terms
  // that were not published yet, so for them it is a warning the owner chases,
  // not a wall around money they honestly earned. Anything registered on or
  // after the terms version must have accepted.
  const predatesTerms = !acceptedTerms && String((rec && rec.createdAt) || '').slice(0, 10) < TERMS_VERSION;
  const belowMinimum = payable < PAYOUT_MINIMUM_USD;

  const blockReasons = [];
  const warnings = [];
  if (w9Blocking) blockReasons.push(expired ? 'tax_doc_expired' : (w9State === 'refused' ? 'tax_doc_refused' : 'tax_doc_missing'));
  if (overpaid > 0) blockReasons.push('overpaid_balance');
  if (frozen) blockReasons.push('owner_freeze');
  if (!acceptedTerms) (predatesTerms ? warnings : blockReasons).push('no_terms_acceptance');
  if (payable <= 0) blockReasons.push('nothing_cleared');
  else if (belowMinimum) blockReasons.push('below_minimum');
  if (pending > 0) warnings.push('hold_pending');

  return {
    // Existing field names, unchanged in meaning.
    earnedAllTimeUsd: earned,
    paidUsd: paid,
    owedUsd: owed,
    earnedThisYearUsd: earnedThisYear,
    w9Required,
    w9State,
    // Hold split.
    clearedUsd: cleared,
    pendingUsd: pending,
    payableUsd: payable,
    // The clawback case, visible instead of swallowed.
    balanceUsd: balance,
    overpaidUsd: overpaid,
    // Terms, enforced.
    belowMinimum,
    minimumUsd: PAYOUT_MINIMUM_USD,
    holdDays: HOLD_DAYS,
    nextPayoutDate: nextPayoutDate(new Date(nowMs)),
    // Tax.
    paidThisYearUsd: paidThisYear,
    reportingThresholdUsd: threshold,
    reportingLikely,
    // Split out: at year end these are two separate filings.
    federalThresholdUsd: federalThreshold,
    stateThresholdUsd: stateThreshold,
    payerState: PAYER_STATE,
    reportingLikelyFederal,
    reportingLikelyState,
    priorYearReported,
    w9Blocking,
    taxDocType: (rec && rec.taxDocType) || null,
    taxDocExpiresAt: expiresAt,
    // Terms acceptance.
    termsVersion: (rec && rec.termsVersion) || null,
    termsAcceptedAt: (rec && rec.termsAcceptedAt) || null,
    termsCurrent: termsAccepted(rec),
    // Gate.
    payable: blockReasons.length === 0,
    blockReasons,
    warnings,
  };
}

/** UTC tax year of a payout entry, stamped at write time when available. */
function payoutTaxYear(p) {
  const stamped = Number(p && p.taxYear);
  if (Number.isFinite(stamped) && stamped > 1999) return stamped;
  const t = Date.parse(p && p.paidAt);
  return Number.isFinite(t) ? new Date(t).getUTCFullYear() : 0;
}

/** Map legacy and current tax-doc spellings onto the enum. */
function normalizeTaxDocState(rec) {
  const raw = String((rec && (rec.taxDocState || rec.w9State)) || '').trim().toLowerCase();
  if (!raw || raw === 'not_required') return 'none';
  return TAX_DOC_STATES.includes(raw) ? raw : 'none';
}

const RAIL_ALIASES = {
  paypal: 'paypal_gs', paypal_gs: 'paypal_gs', 'paypal goods and services': 'paypal_gs',
  wise: 'wise',
  credit: 'account_credit', account_credit: 'account_credit', 'cybersygn account credit': 'account_credit',
};

/** Normalize a rail or a legacy free-text method onto the rail enum. */
export function railFor(rail, method) {
  const direct = String(rail || '').trim().toLowerCase();
  if (RAIL_ALIASES[direct]) return RAIL_ALIASES[direct];
  const m = String(method || '').trim().toLowerCase();
  if (RAIL_ALIASES[m]) return RAIL_ALIASES[m];
  if (m.includes('paypal')) return 'paypal_gs';
  if (m.includes('wise')) return 'wise';
  if (m.includes('credit')) return 'account_credit';
  return 'other';
}

/**
 * Record a manual payout (owner action), with every published term enforced
 * server-side. Returns a structured error rather than throwing, because the
 * owner needs to see WHY a payout was refused, not a 500.
 *
 * Overrides exist for the cases the terms actually name:
 *   belowMinimum   the 90-day release valve, account closure, program shutdown
 *   allowOverpay   a deliberate settlement above cleared balance
 * Both are recorded on the payout entry so the exception is auditable rather
 * than silent.
 */
export async function recordPayout(env, code, opts = {}) {
  const { amount, method, note, rail, railRef, idempotencyKey } = opts;
  const rec = await readCode(env, code);
  if (!rec) return { ok: false, error: 'unknown_code' };

  rec.payouts = Array.isArray(rec.payouts) ? rec.payouts : [];

  // Idempotency first: a double click must not double paidUsd.
  const key = String(idempotencyKey || '').slice(0, 120);
  if (key) {
    const dupe = rec.payouts.find(p => p && p.idempotencyKey === key);
    if (dupe) {
      return { ok: true, duplicate: true, payout: dupe, state: payoutState(rec) };
    }
  }

  const amt = round2(amount);
  if (!Number.isFinite(Number(amount)) || amt <= 0) {
    return { ok: false, error: 'invalid_amount', message: 'Amount must be a positive number.' };
  }

  const state = payoutState(rec);
  const allowBelowMinimum = opts.belowMinimum === true;
  const allowOverpay = opts.allowOverpay === true;

  const blocks = state.blockReasons.filter((r) => {
    if (r === 'below_minimum' || r === 'nothing_cleared') return !allowBelowMinimum && !allowOverpay;
    return true;
  });
  if (blocks.includes('tax_doc_missing') || blocks.includes('tax_doc_expired') || blocks.includes('tax_doc_refused')) {
    return {
      ok: false,
      error: 'tax_doc_required',
      blockReasons: blocks,
      message: 'A W-9 or W-8BEN must be on file before any money moves. Mark it received in Control once the collector reports back.',
      state,
    };
  }
  if (blocks.includes('no_terms_acceptance')) {
    return { ok: false, error: 'terms_not_accepted', blockReasons: blocks, message: `This ambassador has not accepted the ${TERMS_VERSION} payout terms.`, state };
  }
  if (blocks.includes('owner_freeze')) {
    return { ok: false, error: 'payout_frozen', blockReasons: blocks, message: (rec.payoutBlock && rec.payoutBlock.reason) || 'Payouts frozen by the owner.', state };
  }
  if (blocks.includes('overpaid_balance') && !allowOverpay) {
    return {
      ok: false,
      error: 'overpaid_balance',
      blockReasons: blocks,
      overpaidUsd: state.overpaidUsd,
      message: `This account has been overpaid by $${state.overpaidUsd.toFixed(2)} after a clawback. Recover that before paying again.`,
      state,
    };
  }
  if (blocks.includes('nothing_cleared')) {
    return { ok: false, error: 'nothing_cleared', blockReasons: blocks, pendingUsd: state.pendingUsd, message: `Nothing has cleared the ${HOLD_DAYS} day hold yet. $${state.pendingUsd.toFixed(2)} is still pending.`, state };
  }
  if (blocks.includes('below_minimum')) {
    return {
      ok: false,
      error: 'below_minimum',
      blockReasons: blocks,
      payableUsd: state.payableUsd,
      minimumUsd: PAYOUT_MINIMUM_USD,
      message: `$${state.payableUsd.toFixed(2)} is under the $${PAYOUT_MINIMUM_USD} minimum. It rolls over, or pass belowMinimum to use the release valve.`,
      state,
    };
  }
  if (!allowOverpay && amt > state.payableUsd) {
    return {
      ok: false,
      error: 'exceeds_payable',
      payableUsd: state.payableUsd,
      pendingUsd: state.pendingUsd,
      message: `$${amt.toFixed(2)} is more than the $${state.payableUsd.toFixed(2)} cleared and payable.`,
      state,
    };
  }

  const paidAt = new Date();
  // Settle the oldest cleared, unsettled entries first so a payout can be read
  // back line by line.
  const entryIds = [];
  let remaining = amt;
  const nowMs = paidAt.getTime();
  for (const e of (Array.isArray(rec.ledger) ? rec.ledger : [])) {
    if (remaining <= 0) break;
    if (!e || e.payoutId || num(e.amount) <= 0) continue;
    if (!entryCleared(e, nowMs)) continue;
    entryIds.push(e.id || null);
    remaining = round2(remaining - num(e.amount));
  }

  const payout = {
    id: `pay_${cryptoId()}`,
    amount: amt,
    paidAt: paidAt.toISOString(),
    taxYear: paidAt.getUTCFullYear(),
    rail: railFor(rail, method),
    railRef: String(railRef || '').slice(0, 120),
    method: String(method || 'manual').slice(0, 40),
    idempotencyKey: key || null,
    entryIds: entryIds.filter(Boolean),
    belowMinimum: allowBelowMinimum && amt < PAYOUT_MINIMUM_USD,
    overpayApproved: allowOverpay && amt > state.payableUsd,
    note: String(note || '').slice(0, 200),
  };
  rec.payouts.push(payout);
  for (const e of (Array.isArray(rec.ledger) ? rec.ledger : [])) {
    if (e && e.id && payout.entryIds.includes(e.id)) e.payoutId = payout.id;
  }
  const wrote = await writeCode(env, rec);
  if (!wrote) return { ok: false, error: 'kv_write_failed', state };
  return { ok: true, payout, state: payoutState(rec) };
}

function cryptoId() {
  try {
    if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
  } catch (e) {}
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
}

export const __payoutInternals = { entryCleared, normalizeTaxDocState, payoutTaxYear };
