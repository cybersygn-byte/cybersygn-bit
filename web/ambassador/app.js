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
  const v = Number(n) || 0;
  return '$' + (Math.round(v * 100) / 100).toLocaleString(undefined, { minimumFractionDigits: v % 1 ? 2 : 0, maximumFractionDigits: 2 });
}

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
    { n: money(d.payout.earnedAllTimeUsd), l: 'Earned all time' },
  ];
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
  $('amb-ledger-body').innerHTML = rows.map(r =>
    '<tr><td>' + esc(String(r.at || '').slice(0, 10)) + '</td><td>' + esc(r.what || 'Sale') + '</td><td class="amb-earn">' + esc(money(r.amount)) + '</td></tr>').join('');
}

function renderPaid(d) {
  const p = d.payout;
  $('amb-paid-grid').innerHTML = [
    { n: money(p.earnedThisYearUsd), l: 'Earned this year' },
    { n: money(p.earnedAllTimeUsd), l: 'Earned all time' },
    { n: money(p.owedUsd), l: 'Owed to you' },
  ].map(c => '<div class="amb-stat"><span class="amb-stat__n">' + esc(c.n) + '</span><span class="amb-stat__l">' + esc(c.l) + '</span></div>').join('');

  const steps = [
    { t: 'Earn', b: 'Every qualifying sale adds to your balance automatically.', on: p.earnedAllTimeUsd > 0 },
    { t: 'Tax info', b: p.w9Required ? 'You have passed $600 this year, so a W-9 is needed before the next payout.' : 'Not needed yet. We only ask for a W-9 once you pass $600 in a year.', on: p.w9Required },
    { t: 'Paid', b: 'Payouts go out monthly on the 1st, $50 minimum, by PayPal or Wise.', on: p.paidUsd > 0 },
  ];
  $('amb-payflow').innerHTML = steps.map(s =>
    '<li class="amb-payflow__step' + (s.on ? ' is-on' : '') + '"><strong>' + esc(s.t) + '</strong><span>' + esc(s.b) + '</span></li>').join('');

  $('amb-paid-note').textContent =
    'Payouts are recorded by hand today, not automatically. If a balance looks wrong, email me and I will sort it out.';
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
    renderPaid(d);
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
