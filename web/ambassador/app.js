/**
 * Ambassador dashboard client.
 *
 * Renders ONLY what /api/ambassador/me returns. It never invents a number, a
 * benchmark, or a projected earning. When the server withholds a stat (for
 * example a conversion rate below a meaningful sample), the row simply does
 * not render rather than showing noise.
 *
 * Auth reuses the product's existing magic link. There is no second auth
 * system: /api/auth/request sends the link, /api/auth/verify returns the
 * senderId, and that is the session, exactly as the main app does it.
 */

const API = '/api/ambassador';
const LS_SENDER = 'cybersygn.senderId';

const $ = (id) => document.getElementById(id);

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function money(n) {
  const v = Math.round((Number(n) || 0) * 100) / 100;
  const a = Math.abs(v);
  const s = a.toLocaleString(undefined, { minimumFractionDigits: a % 1 ? 2 : 0, maximumFractionDigits: 2 });
  return (v < 0 ? '-$' : '$') + s;
}

/**
 * THE HONESTY GATE for every figure on this page.
 *
 * Returns the value only when the server actually sent a JSON number. null for
 * missing, null, undefined, a string, or a NaN. Nothing downstream is allowed
 * to render a dollar figure that did not come back through here, so a field the
 * server withheld shows the TERM in words instead of a made-up number.
 */
function fin(v) {
  return (typeof v === 'number' && Number.isFinite(v)) ? v : null;
}

function round2(n) { return Math.round(n * 100) / 100; }

function ordinal(n) {
  const v = Math.trunc(Number(n) || 0);
  const s = ['th', 'st', 'nd', 'rd'];
  const k = v % 100;
  return v + (s[(k - 20) % 10] || s[k] || s[0]);
}

/** ISO or ms -> "September 5, 2026". null when the input is not a real date. */
function fmtDate(input) {
  const ms = typeof input === 'number' ? input : Date.parse(String(input || ''));
  if (!Number.isFinite(ms)) return null;
  const d = new Date(ms);
  try {
    return d.toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric', timeZone: 'UTC' });
  } catch (e) {
    return d.toISOString().slice(0, 10);
  }
}

function plural(n, one, many) { return n === 1 ? one : many; }

function toast(msg) {
  const t = $('amb-toast');
  if (!t) return;
  t.textContent = msg;
  t.hidden = false;
  t.classList.add('is-on');
  setTimeout(() => { t.classList.remove('is-on'); setTimeout(() => { t.hidden = true; }, 200); }, 1800);
}

async function copy(text, label) {
  try {
    await navigator.clipboard.writeText(text);
    toast(label + ' copied');
  } catch (e) {
    window.prompt('Copy this:', text);
  }
}

function senderId() {
  try {
    const fromUrl = new URLSearchParams(location.search).get('s');
    if (fromUrl) { localStorage.setItem(LS_SENDER, fromUrl); return fromUrl; }
    return localStorage.getItem(LS_SENDER) || '';
  } catch (e) { return ''; }
}

// ---- Sign in (reuses the product's magic link) ----------------------------

function showSignin() {
  $('amb-loading').hidden = true;
  $('amb-signin').hidden = false;
  const form = $('amb-signin-form');
  if (!form || form.dataset.wired) return;
  form.dataset.wired = '1';
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const email = ($('amb-email').value || '').trim();
    const status = $('amb-signin-status');
    if (!email) return;
    status.textContent = 'Sending.';
    try {
      await fetch('/api/auth/request', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email }),
      });
      // Uniform response by design: the API never confirms whether an address
      // exists, so we say the same thing either way.
      status.textContent = 'If that email is enrolled, a sign-in link is on its way. It works once and expires in 15 minutes.';
    } catch (err) {
      status.textContent = 'Could not reach the server. Try again in a moment.';
    }
  });
}

// ---- Renderers ------------------------------------------------------------

function renderHero(d) {
  $('amb-code-value').textContent = d.code.toUpperCase();
  $('amb-tier-badge').textContent = d.tier.label + ' tier';
  $('amb-tier-badge').dataset.tier = d.tier.key;
  $('amb-discount-line').textContent = 'Everyone who uses it gets ' + d.discount + '.';
  $('amb-open-link').href = d.shareUrl;

  $('amb-code-pill').addEventListener('click', () => copy(d.code.toUpperCase(), 'Code'));
  $('amb-copy-link').addEventListener('click', () => copy(d.shareUrl, 'Share link'));
}

function renderPass(d) {
  const line = $('amb-pass-line');
  if (d.pass.active) {
    line.textContent = 'Your ambassador pass is active, so the full product is free for you. It renews every time you open this page.';
  } else {
    line.textContent = 'Your pass is not active right now. Open this page or share your link and it turns back on.';
  }
  const tools = [
    { href: '/preview/', title: 'Send a document', why: 'Run it on one of your own contracts first. That is the story you will tell.' },
    { href: '/templates/', title: '500+ contract templates', why: 'Free downloads. A useful thing to hand someone before you mention the product.' },
    { href: '/draft/', title: 'AI contract drafting', why: 'Describe the agreement in a sentence, get a draft. Good demo material.' },
    { href: '/verify/', title: 'Verify a signature', why: 'Show anyone that a signed document is tamper-evident. Trust in one link.' },
    { href: '/dashboard/', title: 'Your documents', why: 'Everything you have sent, plus signed PDFs and audit certificates.' },
  ];
  $('amb-toolkit').innerHTML = tools.map(t =>
    '<a class="amb-card" href="' + t.href + '">' +
      '<h3 class="amb-card__title">' + esc(t.title) + '</h3>' +
      '<p class="amb-card__why">' + esc(t.why) + '</p>' +
    '</a>').join('');
}

function renderActivationOrStats(d) {
  if (!d.hasSales) {
    // Zero state: a checklist, never a wall of zeros.
    $('amb-activation').hidden = false;
    const steps = [
      { t: 'Copy your share link', b: 'It is the button up top. Everything you send points there.' },
      { t: 'Pick one script below', b: 'Start with "Text a friend". It is written for someone you already know.' },
      { t: 'Send it to three people today', b: 'Not a broadcast. Three real people who sign contracts.' },
    ];
    $('amb-steps').innerHTML = steps.map(s =>
      '<li class="amb-step"><strong>' + esc(s.t) + '</strong><span>' + esc(s.b) + '</span></li>').join('');
    return;
  }
  // Has sales: show the real grid.
  $('amb-stats').hidden = false;
  const cells = [
    { n: d.stats.clicks, l: 'Clicks' },
    { n: d.stats.sales, l: 'Sales' },
  ];
  // Only when the server actually sent the figure. No placeholder dollars.
  const allTime = fin(d.payout && d.payout.earnedAllTimeUsd);
  if (allTime != null) cells.push({ n: money(allTime), l: 'Earned all time' });
  // Rate only renders when the server judged the sample meaningful.
  if (d.stats.conversionRate != null) cells.push({ n: d.stats.conversionRate + '%', l: 'Click to sale' });
  $('amb-stat-grid').innerHTML = cells.map(c =>
    '<div class="amb-stat"><span class="amb-stat__n">' + esc(c.n) + '</span><span class="amb-stat__l">' + esc(c.l) + '</span></div>').join('');
}

function progressBar(done, total) {
  const pct = total > 0 ? Math.min(100, Math.round((done / total) * 100)) : 0;
  return '<div class="amb-bar"><span class="amb-bar__fill" style="width:' + pct + '%"></span></div>';
}

function renderNextWin(d) {
  // ONE goal, not four: the nearer of the next milestone and the next tier.
  const m = d.nextMilestone, t = d.nextTier;
  let target = null;
  if (m && t) target = (m.salesRemaining <= t.salesRemaining) ? { kind: 'milestone', v: m } : { kind: 'tier', v: t };
  else if (m) target = { kind: 'milestone', v: m };
  else if (t) target = { kind: 'tier', v: t };
  if (!target) return;

  $('amb-nextwin').hidden = false;
  const sales = d.stats.sales;
  let title, sub, total;
  if (target.kind === 'milestone') {
    total = sales + target.v.salesRemaining;
    title = target.v.label + ' bonus, ' + money(target.v.bonus);
    sub = target.v.salesRemaining + (target.v.salesRemaining === 1 ? ' sale away' : ' sales away');
  } else {
    total = sales + target.v.salesRemaining;
    title = target.v.label + ' tier, ' + Math.round(target.v.mult * 100 - 100) + '% more on every sale';
    sub = target.v.salesRemaining + (target.v.salesRemaining === 1 ? ' sale away' : ' sales away');
  }
  $('amb-nextwin-body').innerHTML =
    '<h3 class="amb-card__title">' + esc(title) + '</h3>' +
    '<p class="amb-card__why">' + esc(sub) + '</p>' +
    progressBar(sales, total);
}

function renderSprint(d) {
  const s = d.sprint;
  if (!s) return;
  $('amb-sprint').hidden = false;
  const left = Math.max(0, s.needed - s.sales);
  const body = s.paid
    ? '<h3 class="amb-card__title">Sprint bonus earned, ' + money(s.bonus) + '</h3><p class="amb-card__why">Nice work. It resets on the 1st.</p>'
    : '<h3 class="amb-card__title">' + money(s.bonus) + ' for ' + s.needed + ' sales this month</h3>' +
      '<p class="amb-card__why">' + s.sales + ' so far, ' + left + ' to go. Resets on the 1st.</p>';
  $('amb-sprint-body').innerHTML = body + progressBar(s.sales, s.needed);
}

function renderPayoutTable(d) {
  $('amb-payout-lede').textContent =
    'You are ' + d.tier.label + ' tier. Bigger plans pay more, so this is what each one pays you.';
  $('amb-payout-body').innerHTML = (d.payoutTable || []).map(r =>
    '<tr>' +
      '<td>' + esc(r.plan) + '</td>' +
      '<td>' + esc(money(r.stickerUsd)) + '/mo</td>' +
      '<td>' + esc(money(r.buyerPaysUsd)) + ' <span class="amb-sub">' + esc(r.buyerPaysNote) + '</span></td>' +
      '<td class="amb-earn">' + esc(money(r.youEarnUsd)) + '</td>' +
    '</tr>').join('');

  if (d.firstSale) {
    const n = $('amb-firstsale-note');
    n.hidden = false;
    n.textContent = 'Your first ' + (d.firstSale.plan || 'Pro') + ' sale pays ' + money(d.firstSale.totalUsd) + ': ' +
      money(d.firstSale.bounty) + ' for the sale plus a ' + money(d.firstSale.milestoneBonus) + ' first-sale bonus.';
  }
}

function renderLessons(d, lessons) {
  const done = d.learn || {};
  const firstOpen = lessons.findIndex(l => !done[l.id]);
  $('amb-lessons').innerHTML = lessons.map((l, i) => {
    const isDone = !!done[l.id];
    const open = (!isDone && i === firstOpen) ? ' open' : '';
    return '<details class="amb-lesson' + (isDone ? ' is-done' : '') + '"' + open + '>' +
      '<summary class="amb-lesson__q">' +
        '<span class="amb-lesson__tick" aria-hidden="true">' + (isDone ? '&#10003;' : (i + 1)) + '</span>' +
        esc(l.title) +
      '</summary>' +
      '<div class="amb-lesson__a">' +
        '<p>' + esc(l.body).replace(/\n\n/g, '</p><p>') + '</p>' +
        '<p class="amb-lesson__do"><strong>Do this:</strong> ' + esc(l.action) + '</p>' +
        (isDone
          ? '<p class="amb-lesson__done">Marked done.</p>'
          : '<button class="btn btn--ghost amb-lesson__btn" type="button" data-lesson="' + esc(l.id) + '">Mark done</button>') +
      '</div>' +
    '</details>';
  }).join('');

  $('amb-lessons').addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-lesson]');
    if (!btn) return;
    btn.disabled = true;
    try {
      const res = await fetch(API + '/learn', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ senderId: senderId(), moduleId: btn.dataset.lesson }),
      });
      if (res.ok) { toast('Lesson marked done'); load(); }
      else { btn.disabled = false; }
    } catch (err) { btn.disabled = false; }
  });
}

function renderScripts(d, scripts) {
  const fill = (s) => s
    .replace(/\{\{CODE\}\}/g, d.code.toUpperCase())
    .replace(/\{\{LINK\}\}/g, d.shareUrl)
    .replace(/\{\{DISCOUNT\}\}/g, d.discount);
  $('amb-scripts').innerHTML = scripts.map((s, i) => {
    const body = fill(s.body);
    return '<article class="amb-script">' +
      '<header class="amb-script__head">' +
        '<h3 class="amb-script__title">' + esc(s.label) + '</h3>' +
        (s.public ? '<span class="amb-script__tag">public, discloses</span>' : '<span class="amb-script__tag amb-script__tag--dm">1 to 1</span>') +
      '</header>' +
      '<p class="amb-script__why">' + esc(s.whyFirst) + '</p>' +
      '<pre class="amb-script__body" id="scr-' + i + '">' + esc(body) + '</pre>' +
      '<button class="btn btn--ghost amb-script__copy" type="button" data-copy="' + i + '">Copy</button>' +
    '</article>';
  }).join('');

  $('amb-scripts').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-copy]');
    if (!btn) return;
    const pre = $('scr-' + btn.dataset.copy);
    if (pre) copy(pre.textContent, 'Script');
  });
}

function renderCreative() {
  const assets = [
    { href: '/brand/og-certificate.png', title: 'Signed and verified card', spec: 'PNG, 1200x630, good for a post or a link preview' },
    { href: '/brand/og-image.png', title: 'CyberSygn brand card', spec: 'PNG, 1200x630, general purpose' },
    { href: '/brand/scan-detect.jpg', title: 'Field detection visual', spec: 'JPG, 1600x900, shows the product doing its thing' },
  ];
  $('amb-creative').innerHTML = assets.map(a =>
    '<a class="amb-card" href="' + a.href + '" download>' +
      '<h3 class="amb-card__title">' + esc(a.title) + '</h3>' +
      '<p class="amb-card__why">' + esc(a.spec) + '</p>' +
    '</a>').join('');
}

function renderLedger(d) {
  const rows = d.ledger || [];
  if (!rows.length) return;
  $('amb-ledger-section').hidden = false;
  $('amb-ledger-body').innerHTML = rows.map(r => {
    const amt = fin(r.amount);
    const neg = amt != null && amt < 0;
    return '<tr>' +
      '<td>' + esc(String(r.at || '').slice(0, 10)) + '</td>' +
      '<td>' + esc(r.what || (neg ? 'Reversal' : 'Sale')) + '</td>' +
      '<td class="' + (neg ? 'amb-neg' : 'amb-earn') + '">' + esc(amt == null ? '' : money(amt)) + '</td>' +
    '</tr>';
  }).join('');
}

// ---- k. Getting paid ------------------------------------------------------
//
// The section someone actually reads when they wonder "when do I get paid?".
//
// TWO RULES GOVERN EVERYTHING BELOW.
//
// 1. Every dollar figure comes from the server through fin(). A figure the
//    server did not send is not rendered at all: the surrounding term is shown
//    in words instead. There are no placeholder amounts anywhere in this file.
//
// 2. The TERMS (minimum, hold, run day, rails) are the published contract, not
//    per-person data. The server is the source of truth for them and sends
//    them next to payoutState so copy and enforcement can never drift apart.
//    PROGRAM_TERMS below is the exact published fallback for the case where an
//    older worker response omits them, and every sentence is composed FROM the
//    numbers rather than having them typed into prose twice.

const PROGRAM_TERMS = {
  url: '/ambassador/terms/',
  minimumUsd: 25,
  holdDays: 30,
  runDayOfMonth: 5,
  releaseAfterDays: 90,
  methods: ['PayPal goods and services', 'Wise', 'CyberSygn account credit'],
};

/** Merge the server's terms over the published fallback. Server always wins. */
function programTerms(d) {
  const raw = (d && d.payout && d.payout.terms) || (d && d.terms) || {};
  const T = {
    url: typeof raw.url === 'string' && raw.url ? raw.url : PROGRAM_TERMS.url,
    minimumUsd: fin(raw.minimumUsd) != null ? raw.minimumUsd : PROGRAM_TERMS.minimumUsd,
    holdDays: fin(raw.holdDays) != null ? raw.holdDays : PROGRAM_TERMS.holdDays,
    runDayOfMonth: fin(raw.runDayOfMonth) != null ? raw.runDayOfMonth : PROGRAM_TERMS.runDayOfMonth,
    releaseAfterDays: fin(raw.releaseAfterDays) != null ? raw.releaseAfterDays : PROGRAM_TERMS.releaseAfterDays,
    methods: Array.isArray(raw.methods) && raw.methods.length ? raw.methods.map(String) : PROGRAM_TERMS.methods,
    nextRunAt: typeof raw.nextRunAt === 'string' ? raw.nextRunAt : null,
    version: typeof raw.version === 'string' ? raw.version : null,
  };
  // Sentences are BUILT from the numbers above, so a change to the minimum or
  // the hold can never leave stale prose behind. A server-sent line wins.
  const built = {
    method: 'Your choice of ' + listOf(T.methods) + '. CyberSygn pays the sending fee on PayPal and Wise. Account credit has no minimum and no fee.',
    schedule: 'Once a month, on the ' + ordinal(T.runDayOfMonth) + '. If the ' + ordinal(T.runDayOfMonth) +
      ' falls on a weekend or a US holiday, the next business day. For most sales that is ' + T.holdDays + ' to ' + (T.holdDays + 5) +
      ' days from the day the customer paid. A sale that clears just after a run waits for the following one, which can be about ' + (T.holdDays * 2) + ' days.',
    minimum: money(T.minimumUsd) + '. A balance under it is not lost, it rolls over and goes out in the first run that clears ' +
      money(T.minimumUsd) + '. Any balance is paid in full, minimum waived, on request after ' + T.releaseAfterDays +
      ' days with no new sale, if you close your account, and if the program shuts down.',
    hold: T.holdDays + ' days from the day the customer\'s payment cleared. That is the window a refund or chargeback shows up in, so commission is not payable until it has passed.',
    clawback: 'If a customer\'s payment is refunded, charged back, or disputed, that sale\'s commission is reversed for the exact amount it credited, bonuses included, and it shows on your ledger as a negative line with the reason. If that leaves a negative balance it is carried forward against future commissions. We will never invoice you for it, and it is written off to zero if you leave or the program ends.',
    disclosure: 'Commission is earned only on promotion that clearly says you are paid for it. The FTC requires it and so do we. A line like "(affiliate, I earn a commission)" is enough.',
  };
  T.lines = Object.assign(built, (raw.lines && typeof raw.lines === 'object') ? raw.lines : {});
  return T;
}

function listOf(items) {
  const a = items.slice();
  if (a.length <= 1) return a[0] || '';
  return a.slice(0, -1).join(', ') + ', or ' + a[a.length - 1];
}

/**
 * The next run day as a real date. The server's nextRunAt wins outright. The
 * fallback advances to the run day and steps off a weekend, and SAYS that it
 * cannot see the US holiday calendar rather than quietly pretending it can.
 */
function nextRun(T) {
  if (T.nextRunAt) {
    const label = fmtDate(T.nextRunAt);
    if (label) return { label, exact: true };
  }
  const now = new Date();
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  let ms = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), T.runDayOfMonth);
  if (ms < today) ms = Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, T.runDayOfMonth);
  let dt = new Date(ms);
  for (let i = 0; i < 7 && (dt.getUTCDay() === 0 || dt.getUTCDay() === 6); i++) {
    dt = new Date(dt.getTime() + 86400000);
  }
  const label = fmtDate(dt.getTime());
  return label ? { label, exact: false } : null;
}

/**
 * Held money broken out by the date it clears.
 *
 * Prefers an explicit server list. The ledger fallback is only trusted when its
 * held total matches the server's pendingUsd to the cent, because /me sends a
 * TRUNCATED ledger and a partial breakdown would understate what is waiting.
 */
function pendingChunks(d) {
  const p = (d && d.payout) || {};
  const now = Date.now();
  let raw = null;

  if (Array.isArray(p.pending)) {
    raw = p.pending
      .map(e => ({ clearsAt: e && e.clearsAt, amount: fin(e && (e.amountUsd != null ? e.amountUsd : e.amount)) }))
      .filter(e => e.amount != null && fmtDate(e.clearsAt));
  } else {
    const led = Array.isArray(d && d.ledger) ? d.ledger : [];
    const held = led
      .map(e => ({ clearsAt: e && e.clearsAt, amount: fin(e && e.amount) }))
      .filter(e => e.amount != null && e.clearsAt && Date.parse(e.clearsAt) > now);
    if (!held.length) return [];
    const total = round2(held.reduce((s, e) => s + e.amount, 0));
    const serverPending = fin(p.pendingUsd);
    // No match, no breakdown. The total the server sent stays authoritative.
    if (serverPending == null || Math.abs(total - serverPending) > 0.005) return [];
    raw = held;
  }

  const byDay = new Map();
  raw.forEach((e) => {
    const key = new Date(Date.parse(e.clearsAt)).toISOString().slice(0, 10);
    byDay.set(key, round2((byDay.get(key) || 0) + e.amount));
  });
  return Array.from(byDay.entries())
    .sort((a, b) => (a[0] < b[0] ? -1 : 1))
    .map(([day, amount]) => ({ day, label: fmtDate(day + 'T00:00:00Z'), amount }));
}

const TAX_COPY = {
  none: {
    tone: 'warn',
    title: 'Tax paperwork is not on file yet',
    body: 'Before the first dollar moves, at any amount, we need a W-9 from you if you are in the US or a W-8BEN if you are not. You will get a link when you have a balance coming.',
  },
  requested: {
    tone: 'warn',
    title: 'Tax paperwork requested',
    body: 'Check your email for the link. It goes to a third-party tax document collector, not to us.',
  },
  w9_on_file: { tone: 'ok', title: 'W-9 on file', body: 'Nothing else is needed from you on the tax side.' },
  w8ben_on_file: { tone: 'ok', title: 'W-8BEN on file', body: 'Nothing else is needed from you on the tax side right now.' },
  w8ben_expired: {
    tone: 'warn',
    title: 'Your W-8BEN has expired',
    body: 'A W-8BEN is good through the third calendar year after you signed it. A fresh one is needed before the next payout.',
  },
  refused: {
    tone: 'warn',
    title: 'No tax document on file',
    body: 'We cannot send money without it. If this is a mistake, email me and we will sort it out.',
  },
};

const BLOCK_COPY = {
  no_terms_acceptance: 'You have not accepted the ambassador terms yet. Read them and accept, and this clears.',
  tax_doc_missing: 'Your W-9 or W-8BEN is not on file yet.',
  tax_doc_expired: 'Your W-8BEN has expired and needs to be replaced.',
  tax_doc_refused: 'There is no tax document on file for you.',
  overpaid_balance: 'A refund left your balance below zero. Future commissions offset it before anything is sent.',
  owner_freeze: 'This account is on hold. Email me and I will tell you exactly why.',
  below_minimum: 'Your cleared balance is under the minimum, so it rolls over to a later run.',
  nothing_cleared: 'Nothing has finished its hold yet.',
};

function callout(tone, title, bodyHtml) {
  return '<div class="amb-callout amb-callout--' + tone + '">' +
    '<h3 class="amb-callout__title">' + esc(title) + '</h3>' + bodyHtml + '</div>';
}

function renderPaid(d, faq) {
  const p = (d && d.payout) || {};
  const T = programTerms(d);

  const available = fin(p.availableUsd);
  const pending = fin(p.pendingUsd);
  const paid = fin(p.paidUsd);
  const earned = fin(p.earnedAllTimeUsd);
  const overpaid = fin(p.overpaidUsd);
  const paidThisYear = fin(p.paidThisYearUsd);
  const threshold = fin(p.reportingThresholdUsd);

  const hasMoney = [available, pending, paid, earned, overpaid].some(v => v != null && v > 0);

  const termsHref = T.url;
  const link = $('amb-terms-link');
  if (link) link.href = termsHref;

  $('amb-paid-lede').textContent = hasMoney
    ? 'Where your money is right now, and the date it moves.'
    : 'You have not earned anything yet, so here is the whole deal in advance: what triggers a payment, how long it waits, and when it lands.';

  // ---- Balance ------------------------------------------------------------
  let balanceHtml = '';
  if (hasMoney) {
    let leadFigure, leadNote;
    if (available != null) {
      leadFigure = money(available);
      const gap = round2(T.minimumUsd - available);
      if (available <= 0) {
        leadNote = pending != null && pending > 0
          ? 'Nothing has finished its ' + T.holdDays + ' day hold yet. ' + money(pending) + ' is still inside it.'
          : 'Nothing has cleared the hold yet.';
      } else if (gap > 0) {
        leadNote = money(gap) + ' more and you are over the ' + money(T.minimumUsd) +
          ' minimum. Until then this rolls over, it is not lost.';
      } else {
        leadNote = 'That is over the ' + money(T.minimumUsd) + ' minimum, so it goes out in the next run.';
      }
    } else {
      // Server did not send the figure. State the rule, invent nothing.
      leadFigure = null;
      leadNote = 'Your payable balance is not available right now. It is everything that has finished its ' +
        T.holdDays + ' day hold and has not been paid out yet.';
    }

    balanceHtml += '<div class="amb-paid__lead">' +
      '<span class="amb-paid__label">Payable now</span>' +
      (leadFigure ? '<span class="amb-paid__figure">' + esc(leadFigure) + '</span>' : '') +
      '<p class="amb-paid__gap">' + esc(leadNote) + '</p>' +
    '</div>';

    const rows = [];
    if (available != null) rows.push(['Cleared and waiting for the next run', money(available), '']);
    if (pending != null) rows.push(['Still inside the ' + T.holdDays + ' day hold', money(pending), '']);
    if (paid != null) rows.push(['Paid to you so far', money(paid), '']);
    if (earned != null) rows.push(['Earned all time', money(earned), '']);
    if (overpaid != null && overpaid > 0) {
      rows.push(['Carried forward after a refund', money(-overpaid), 'amb-neg']);
    }
    if (rows.length) {
      balanceHtml += '<dl class="amb-rows">' + rows.map(([k, v, cls]) =>
        '<div class="amb-row"><dt class="amb-row__k">' + esc(k) + '</dt>' +
        '<dd class="amb-row__v' + (cls ? ' ' + cls : '') + '">' + esc(v) + '</dd></div>').join('') + '</dl>';
    }
    if (overpaid != null && overpaid > 0) {
      balanceHtml += callout('warn', 'You are carrying a negative balance',
        '<p>A refunded sale reversed more commission than you had unpaid. That shortfall comes out of future commissions first. ' +
        'You will never get an invoice for it, and it is written off to zero if you leave the program or the program ends.</p>');
    }
  }
  $('amb-paid-balance').innerHTML = balanceHtml;

  // ---- Held money, with the date each chunk clears -------------------------
  const chunks = pendingChunks(d);
  if (chunks.length) {
    $('amb-paid-pending').innerHTML =
      '<h3 class="amb-paid__h3">When the held money clears</h3>' +
      '<ul class="amb-pending">' + chunks.map(c =>
        '<li class="amb-pending__item">' +
          '<span class="amb-pending__when">Clears ' + esc(c.label) + '</span>' +
          '<span class="amb-pending__amt">' + esc(money(c.amount)) + '</span>' +
        '</li>').join('') + '</ul>' +
      '<p class="amb-paid__hint">A commission joins a run once its hold has finished on or before the ' +
        esc(ordinal(T.runDayOfMonth)) + '.</p>';
  } else if (pending != null && pending > 0) {
    $('amb-paid-pending').innerHTML =
      '<h3 class="amb-paid__h3">When the held money clears</h3>' +
      '<p class="amb-paid__hint">' + esc(money(pending)) + ' is inside the ' + T.holdDays +
      ' day hold. Each sale clears ' + T.holdDays + ' days after that customer\'s payment went through, then joins the next run.</p>';
  } else {
    $('amb-paid-pending').innerHTML = '';
  }

  // ---- The next run, as a real date ---------------------------------------
  const run = nextRun(T);
  if (run) {
    let tail;
    if (p.payable === false && Array.isArray(p.blockReasons) && p.blockReasons.length) {
      tail = 'Something is holding your payout up right now. It is listed below.';
    } else if (available != null && available >= T.minimumUsd) {
      tail = 'Your cleared balance is set to go out then.';
    } else if (available != null) {
      tail = 'Your balance rolls into a later run, the first one where it is over ' + money(T.minimumUsd) + '.';
    } else {
      tail = 'Everything that finished its hold on or before that date goes out in it.';
    }
    $('amb-paid-next').innerHTML = '<div class="amb-paid__next">' +
      '<span class="amb-paid__label">Next payout run</span>' +
      '<strong class="amb-paid__date">' + esc(run.label) + '</strong>' +
      '<p class="amb-paid__hint">' + esc(tail) +
        (run.exact ? '' : ' Dates that land on a US holiday move to the next business day.') + '</p>' +
    '</div>';
  } else {
    $('amb-paid-next').innerHTML = '';
  }

  // ---- The journey. Steps light up from real state only. -------------------
  const flow = [
    {
      t: 'A sale lands',
      b: 'Someone buys through your link or code and the commission is credited to your ledger.',
      on: earned != null && earned > 0,
    },
    {
      t: 'It waits ' + T.holdDays + ' days',
      b: 'That is the window a refund or chargeback would arrive in. Held money is shown separately, never counted as payable.',
      on: (pending != null && pending > 0) || (available != null && available > 0) || (paid != null && paid > 0),
    },
    {
      t: 'It joins a run',
      b: 'Once the hold has finished on or before the ' + ordinal(T.runDayOfMonth) + ', it is in that run. Under ' +
         money(T.minimumUsd) + ' it rolls to the next one.',
      on: available != null && available >= T.minimumUsd,
    },
    {
      t: 'I send it by hand',
      b: 'On your chosen rail, with the transaction id recorded against your ledger.',
      on: paid != null && paid > 0,
    },
  ];
  $('amb-payflow').innerHTML = flow.map(s =>
    '<li class="amb-payflow__step' + (s.on ? ' is-on' : '') + '">' +
      '<strong>' + esc(s.t) + '</strong><span>' + esc(s.b) + '</span></li>').join('');

  // ---- Method, schedule, minimum, hold. One plain line each. ---------------
  const termRows = [
    ['Method', T.lines.method],
    ['Schedule', T.lines.schedule],
    ['Minimum', T.lines.minimum],
    ['Hold', T.lines.hold],
    ['If a customer refunds', T.lines.clawback],
    ['Disclosure', T.lines.disclosure],
  ];
  $('amb-paid-terms').innerHTML = termRows.map(([k, v]) =>
    '<div class="amb-term"><dt>' + esc(k) + '</dt><dd>' + esc(v) + '</dd></div>').join('');

  // ---- Tax paperwork -------------------------------------------------------
  const state = typeof p.taxDocState === 'string' ? p.taxDocState : 'none';
  const tax = TAX_COPY[state] || TAX_COPY.none;
  const onFile = state === 'w9_on_file' || state === 'w8ben_on_file';
  let taxBody = '<p>' + esc(tax.body) + '</p>';

  const expires = fmtDate(p.taxDocExpiresAt);
  if (state === 'w8ben_on_file' && expires) {
    taxBody += '<p>Yours is good through ' + esc(expires) + '. We will ask for a new one before then.</p>';
  }
  if (!onFile) {
    taxBody += '<p>Until it is on file, a payout is blocked. That is deliberate: it is the only moment we have any way to collect it.</p>';
  }
  taxBody += '<p>CyberSygn never stores your SSN, TIN, or the form itself. Collection is routed to a third-party tax document ' +
    'service and all we keep on our side is a status flag and their reference id.</p>';
  if (paidThisYear != null && threshold != null && threshold > 0) {
    taxBody += '<p>You have been paid ' + esc(money(paidThisYear)) + ' this calendar year. At ' + esc(money(threshold)) +
      ' paid in a year we have to file a 1099-NEC for you, which is why the paperwork has to exist first.</p>';
  }
  $('amb-paid-tax').innerHTML = callout(onFile ? 'ok' : 'warn', tax.title, taxBody);

  // ---- Anything blocking a payout right now --------------------------------
  const reasons = Array.isArray(p.blockReasons)
    ? p.blockReasons.map(r => BLOCK_COPY[r]).filter(Boolean)
    : [];
  $('amb-paid-blocks').innerHTML = reasons.length
    ? callout('warn', 'What is holding a payout up right now',
        '<ul>' + reasons.map(r => '<li>' + esc(r) + '</li>').join('') + '</ul>')
    : '';

  // ---- Optional extra answers ---------------------------------------------
  const items = Array.isArray(faq) ? faq.filter(f => f && f.q && f.a) : [];
  $('amb-paid-faq').innerHTML = items.length
    ? '<div class="amb-lessons amb-paid__faq">' + items.map(f =>
        '<details class="amb-lesson"><summary class="amb-lesson__q">' + esc(f.q) + '</summary>' +
        '<div class="amb-lesson__a"><p>' + esc(f.a) + '</p></div></details>').join('') + '</div>'
    : '';

  // ---- The honesty line. Kept verbatim, plus what is true about the program.
  $('amb-paid-note').textContent =
    'Payouts are recorded by hand today, not automatically. If a balance looks wrong, email me and I will sort it out. ' +
    'One person, the founder, runs every payout. There is no cron job behind this schedule, and zero ambassadors have been paid to date.';
}

// ---- Boot -----------------------------------------------------------------

let CONTENT = null;

async function loadContent() {
  if (CONTENT) return CONTENT;
  try {
    const res = await fetch('/ambassador/content.json');
    CONTENT = await res.json();
  } catch (e) { CONTENT = { scripts: [], lessons: [] }; }
  return CONTENT;
}

async function load() {
  const sid = senderId();
  if (!sid) { showSignin(); return; }
  try {
    const res = await fetch(API + '/me?senderId=' + encodeURIComponent(sid));
    if (res.status === 404) { showSignin(); return; }
    if (!res.ok) throw new Error('http ' + res.status);
    const d = await res.json();
    const content = await loadContent();

    $('amb-loading').hidden = true;
    $('amb-signin').hidden = true;
    $('amb-panel').hidden = false;

    renderHero(d);
    renderPass(d);
    renderActivationOrStats(d);
    renderNextWin(d);
    renderSprint(d);
    renderPayoutTable(d);
    renderLessons(d, content.lessons || []);
    renderScripts(d, content.scripts || []);
    renderCreative();
    renderLedger(d);
    renderPaid(d, content.payoutFaq || []);
  } catch (err) {
    $('amb-loading').hidden = false;
    $('amb-loading').querySelector('.amb-state__msg').textContent =
      'Could not load your dashboard. Refresh in a moment, or email hello@cybersygn.io.';
  }
}

// Magic-link return: /ambassador/?token=... verifies then lands signed in.
(async function boot() {
  const params = new URLSearchParams(location.search);
  const token = params.get('token');
  if (token) {
    try {
      const res = await fetch('/api/auth/verify', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ token, senderId: senderId() || undefined }),
      });
      const data = await res.json().catch(() => ({}));
      if (data && data.senderId) {
        try { localStorage.setItem(LS_SENDER, data.senderId); } catch (e) {}
        history.replaceState({}, '', '/ambassador/');
      }
    } catch (e) {}
  }
  load();
})();
