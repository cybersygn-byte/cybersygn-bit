/**
 * /control/ controller. Two states:
 *
 *   1. No owner token in localStorage  -> show login form, hide panel.
 *   2. Owner token present + verifies  -> show panel, hide login.
 *
 * On successful login POST /api/owner/login, the response carries the
 * same token shape the URL-phrase activation issues. We persist it
 * under the existing localStorage key (cybersygn.owner.token) so every
 * other owner-gated page (/preview/, /dashboard/, /api/owner/*)
 * authenticates without any further setup.
 *
 * The analytics tile fetches /api/analytics/summary with the owner
 * header on a 7-day window by default. Window selector + Refresh
 * button drive ad-hoc queries.
 */

import * as ownerMod from '/preview/owner.js';

const OWNER_KEY = 'cybersygn.owner.token';
const $ = id => document.getElementById(id);

function readToken() {
  try { return localStorage.getItem(OWNER_KEY) || ''; } catch (e) { return ''; }
}
function writeToken(token) {
  try {
    if (token) localStorage.setItem(OWNER_KEY, token);
    else localStorage.removeItem(OWNER_KEY);
  } catch (e) {}
}

// ----- Login form -----------------------------------------------------------

const loginForm = $('control-login-form');
if (loginForm) {
  loginForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const errEl = $('control-login-error');
    if (errEl) { errEl.hidden = true; errEl.textContent = ''; }
    const username = $('control-user').value.trim();
    const password = $('control-pass').value;
    if (!username || !password) {
      showLoginError('Enter both username and password.');
      return;
    }
    const btn = loginForm.querySelector('button[type="submit"]');
    const originalLabel = btn.textContent;
    btn.disabled = true;
    btn.textContent = 'Signing in.';
    try {
      const res = await fetch('/api/owner/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ username, password }),
      });
      const data = await res.json().catch(() => ({}));
      if (res.status === 503) {
        showLoginError('Login is not configured on this Worker yet. Set OWNER_USERNAME, OWNER_PASSWORD_SALT, OWNER_PASSWORD_HASH via wrangler secret put, then redeploy.');
        return;
      }
      if (!res.ok || !data.ok || !data.token) {
        showLoginError(data.error === 'invalid_credentials' ? 'Username or password is wrong.' : ('Login failed: ' + (data.error || 'unknown')));
        return;
      }
      writeToken(data.token);
      paint();
    } catch (err) {
      showLoginError('Network error: ' + (err && err.message ? err.message : err));
    } finally {
      btn.disabled = false;
      btn.textContent = originalLabel;
    }
  });
}

function showLoginError(msg) {
  const el = $('control-login-error');
  if (!el) return;
  el.hidden = false;
  el.textContent = msg;
}

// ----- Sign out -------------------------------------------------------------

const signoutBtn = $('control-signout');
if (signoutBtn) {
  signoutBtn.addEventListener('click', () => {
    writeToken(null);
    paint();
  });
}

// ----- State paint ----------------------------------------------------------

async function paint() {
  const loginSection = $('control-login');
  const panelSection = $('control-panel');
  const signout = $('control-signout');
  const token = readToken();
  if (!token) {
    loginSection.hidden = false;
    panelSection.hidden = true;
    if (signout) signout.hidden = true;
    return;
  }

  // Verify the token still validates server-side before unlocking the panel.
  let valid = false;
  try {
    const r = await fetch('/api/owner/verify', { headers: { 'X-CyberSygn-Owner': token } });
    if (r.ok) {
      const d = await r.json();
      valid = !!(d && d.ok);
    }
  } catch (e) {}
  if (!valid) {
    writeToken(null);
    loginSection.hidden = false;
    panelSection.hidden = true;
    if (signout) signout.hidden = true;
    showLoginError('Saved token expired or was rejected. Sign in again.');
    return;
  }
  loginSection.hidden = true;
  panelSection.hidden = false;
  if (signout) signout.hidden = false;
  await loadKpis();
  await loadAnalytics();
}

// ----- Founder KPIs tile -----------------------------------------------------

async function loadKpis() {
  const body = $('ctrl-kpi-body');
  if (!body) return;
  body.innerHTML = '<p class="control-tile__empty">Loading metrics.</p>';
  try {
    const res = await fetch('/api/owner/metrics/dashboard', {
      headers: { 'X-CyberSygn-Owner': readToken() },
    });
    if (res.status === 401) {
      body.innerHTML = '<p class="control-tile__empty">Session expired.</p>';
      return;
    }
    if (!res.ok) {
      body.innerHTML = '<p class="control-tile__empty">Could not load: HTTP ' + res.status + '</p>';
      return;
    }
    const d = await res.json();
    const founding = d.founding || {};
    const free = d.free || {};
    const dataset = d.dataset || {};
    const integ = d.integrations || {};
    const revenue = d.revenue || {};
    const claimedPct = founding.cap > 0 ? Math.round((founding.claimed / founding.cap) * 100) : 0;
    const dsPct = Math.round((dataset.progress || 0) * 100);
    const money = (cents) => '$' + (Math.round((cents || 0)) / 100).toLocaleString(undefined, { maximumFractionDigits: 0 });
    const sources = Array.isArray(revenue.bySource) ? revenue.bySource : [];
    const sourceRows = sources.length
      ? sources.map((s) =>
          '<tr>' +
            '<td class="control-src__name">' + srcEsc(s.source) + '</td>' +
            '<td class="control-src__num">' + (Number(s.subs) || 0) + '</td>' +
            '<td class="control-src__num">' + money(s.mrrCents) + '</td>' +
          '</tr>').join('')
      : '<tr><td colspan="3" class="control-tile__empty">No paid subscriptions yet.</td></tr>';
    body.innerHTML =
      '<div class="control-stats">' +
        statBlock(founding.claimed, 'Origin claimed', founding.cap + ' cap · ' + claimedPct + '%') +
        statBlock(free.signups, 'Free signups', 'lifetime') +
        statBlock(dataset.total, 'Labeled corpus', dataset.threshold.toLocaleString() + ' target · ' + dsPct + '%') +
        statBlock(dataset.contributors, 'Contributors', 'unique emails') +
      '</div>' +
      '<div class="control-revenue">' +
        '<p class="kicker kicker--muted">Recurring revenue by source</p>' +
        '<div class="control-stats control-stats--rev">' +
          '<div class="control-stat"><span class="control-stat__num">' + money(revenue.mrrCents) + '</span><span class="control-stat__label">Active MRR</span><span class="control-stat__sub">' + (Number(revenue.activeSubs) || 0) + ' paid ' + ((Number(revenue.activeSubs) === 1) ? 'subscriber' : 'subscribers') + '</span></div>' +
        '</div>' +
        '<table class="control-src-table"><thead><tr><th>Source</th><th class="control-src__num">Subs</th><th class="control-src__num">MRR</th></tr></thead><tbody>' +
          sourceRows +
        '</tbody></table>' +
      '</div>' +
      revenueRiskBlock(d.risk || {}, d.affiliates || {}, money) +
      '<div class="control-integrations">' +
        '<p class="kicker kicker--muted">Integrations</p>' +
        '<ul>' +
          integBlock('GA4', integ.ga4) +
          integBlock('Search Console', integ.gsc) +
          integBlock('Resend', integ.resend) +
          integBlock('Stripe', integ.stripe) +
          integBlock('Anthropic', integ.anthropic) +
        '</ul>' +
      '</div>';
  } catch (err) {
    body.innerHTML = '<p class="control-tile__empty">Network error: ' + (err.message || err) + '</p>';
  }
}

function statBlock(num, label, sub) {
  const n = Number.isFinite(num) ? Number(num).toLocaleString() : '-';
  return '<div class="control-stat">' +
    '<span class="control-stat__num">' + n + '</span>' +
    '<span class="control-stat__label">' + label + '</span>' +
    (sub ? '<span class="control-stat__sub">' + sub + '</span>' : '') +
  '</div>';
}

// At-risk revenue (refunds, disputes, failed payments) + affiliate liability.
// Renders nothing alarming when all zero; the point is early visibility.
function revenueRiskBlock(risk, aff, money) {
  const refunds = Number(risk.refunds) || 0;
  const disputes = Number(risk.disputes) || 0;
  const failed = Number(risk.failedPayments) || 0;
  const affCount = Number(aff.count) || 0;
  const unpaid = money ? money(Math.round((Number(aff.unpaidUsd) || 0) * 100)) : ('$' + (Number(aff.unpaidUsd) || 0));
  return '<div class="control-revenue">' +
    '<p class="kicker kicker--muted">Risk and liabilities</p>' +
    '<div class="control-stats control-stats--rev">' +
      statBlock(failed, 'Failed payments', 'past-due renewals') +
      statBlock(refunds, 'Refunds', 'lifetime') +
      statBlock(disputes, 'Disputes', 'chargebacks') +
      '<div class="control-stat"><span class="control-stat__num">' + srcEsc(unpaid) + '</span>' +
        '<span class="control-stat__label">Affiliate owed</span>' +
        '<span class="control-stat__sub">' + affCount + ' ' + (affCount === 1 ? 'affiliate' : 'affiliates') + '</span></div>' +
    '</div>' +
  '</div>';
}

// Source values arrive already sanitized server-side to [a-z0-9_.-], but escape
// defensively before injecting as HTML.
function srcEsc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function integBlock(name, on) {
  return '<li class="control-integ ' + (on ? 'is-on' : 'is-off') + '">' +
    '<span class="control-integ__dot" aria-hidden="true"></span>' +
    '<span>' + name + '</span>' +
    '<span class="control-integ__state">' + (on ? 'configured' : 'not set') + '</span>' +
  '</li>';
}

// ----- Analytics tile -------------------------------------------------------

async function loadAnalytics() {
  const body = $('ctrl-analytics-body');
  if (!body) return;
  body.innerHTML = '<p class="control-tile__empty">Loading.</p>';
  const win = $('ctrl-window').value;
  try {
    const res = await fetch('/api/analytics/summary?window=' + encodeURIComponent(win), {
      headers: { 'X-CyberSygn-Owner': readToken() },
    });
    if (res.status === 401) {
      body.innerHTML = '<p class="control-tile__empty">Session expired. Sign out and back in.</p>';
      return;
    }
    if (!res.ok) {
      body.innerHTML = '<p class="control-tile__empty">Could not load: HTTP ' + res.status + '</p>';
      return;
    }
    const data = await res.json();
    const r = (data && data.results) || {};
    const sample = r.totals && r.totals.error;
    if (typeof sample === 'string' && /CF_ACCOUNT_ID|CF_ANALYTICS_TOKEN|enable Analytics Engine|not configured/i.test(sample)) {
      body.innerHTML = '<div class="control-tile__notice"><strong>Analytics SQL not configured yet.</strong> Set CF_ACCOUNT_ID and CF_ANALYTICS_TOKEN secrets so this tile can query the Analytics Engine.</div>';
      return;
    }
    renderAnalytics(body, r);
  } catch (err) {
    body.innerHTML = '<p class="control-tile__empty">Network error: ' + (err.message || err) + '</p>';
  }
}

function renderAnalytics(body, r) {
  function pickRows(key, blobCol, sumCol) {
    const v = r[key];
    if (!v || !Array.isArray(v.data) || v.data.length === 0) return [];
    return v.data.map(row => ({ label: row[blobCol] || '(none)', count: Number(row[sumCol]) || 0 }));
  }
  const totals = (r.totals && r.totals.data && r.totals.data[0]) || null;
  const totalEvents = totals && Number(totals.events) || 0;
  const totalSenders = totals && Number(totals.senders) || 0;
  const byEvent = pickRows('byEvent', 'event', 'n');
  const topPaths = pickRows('topPaths', 'path', 'n');
  const topRefs = pickRows('topReferrers', 'referrer', 'n');
  const byUaClass = pickRows('byUaClass', 'ua', 'n');
  const errors = (r.errors && r.errors.data) || [];

  body.innerHTML =
    '<div class="control-stats">' +
      '<div class="control-stat"><span class="control-stat__num">' + totalEvents.toLocaleString() + '</span><span class="control-stat__label">Events</span></div>' +
      '<div class="control-stat"><span class="control-stat__num">' + totalSenders.toLocaleString() + '</span><span class="control-stat__label">Distinct senders</span></div>' +
    '</div>' +
    '<div class="control-lists">' +
      listBlock('By event', byEvent) +
      listBlock('Top paths', topPaths) +
      listBlock('Top referrers', topRefs) +
      listBlock('By client', byUaClass) +
    '</div>' +
    (errors.length > 0 ? '<div class="control-errors"><p class="kicker kicker--muted">Errors (' + errors.length + ')</p><ul>' + errors.slice(0, 6).map(e => '<li><code>' + escapeHtml(e.event || '?') + '</code> ' + escapeHtml(e.error_class || '') + ' ' + escapeHtml(e.message || '') + '</li>').join('') + '</ul></div>' : '');
}

function listBlock(title, rows) {
  if (!rows.length) return '<div class="control-list"><p class="kicker kicker--muted">' + escapeHtml(title) + '</p><p class="control-list__empty">no data</p></div>';
  return '<div class="control-list"><p class="kicker kicker--muted">' + escapeHtml(title) + '</p><ul>' +
    rows.slice(0, 8).map(r => '<li><span>' + escapeHtml(String(r.label).slice(0, 48)) + '</span><span>' + r.count.toLocaleString() + '</span></li>').join('') +
    '</ul></div>';
}

function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// Refresh + window controls
const refreshBtn = $('ctrl-refresh');
if (refreshBtn) refreshBtn.addEventListener('click', loadAnalytics);
const windowSel = $('ctrl-window');
if (windowSel) windowSel.addEventListener('change', loadAnalytics);
const kpiRefreshBtn = $('ctrl-kpi-refresh');
if (kpiRefreshBtn) kpiRefreshBtn.addEventListener('click', loadKpis);

// ---- API keys (public API /api/v1) ---------------------------------------
const keyForm = $('apikey-form');
const keyListBtn = $('apikey-list-btn');
const keyFresh = $('apikey-fresh');
const keyList = $('apikey-list');

async function listApiKeys() {
  const sid = ($('apikey-sender').value || '').trim();
  if (!sid) { keyList.textContent = 'Enter a senderId to list its keys.'; return; }
  try {
    const res = await fetch('/api/owner/apikeys?senderId=' + encodeURIComponent(sid), { headers: { 'X-CyberSygn-Owner': readToken() } });
    const data = await res.json();
    const keys = (data && data.keys) || [];
    if (!keys.length) { keyList.textContent = 'No keys for ' + sid + '.'; return; }
    keyList.innerHTML = keys.map(k =>
      '<div style="display:flex;justify-content:space-between;gap:8px;align-items:center;padding:6px 0;border-bottom:1px solid var(--line);">' +
        '<span style="font-family:var(--mono);font-size:var(--t-xs);">' + k.id + ' · …' + (k.last4 || '') + ' · ' + (k.label || '') + (k.revoked ? ' · REVOKED' : '') + '</span>' +
        (k.revoked ? '' : '<button class="btn btn--ghost btn--sm" data-revoke="' + k.id + '" type="button">Revoke</button>') +
      '</div>').join('');
    keyList.querySelectorAll('[data-revoke]').forEach(b => b.addEventListener('click', () => revokeKey(sid, b.getAttribute('data-revoke'))));
  } catch (e) { keyList.textContent = 'Could not load keys.'; }
}

async function revokeKey(sid, keyId) {
  try {
    await fetch('/api/owner/apikeys', { method: 'DELETE', headers: { 'X-CyberSygn-Owner': readToken(), 'content-type': 'application/json' }, body: JSON.stringify({ senderId: sid, keyId }) });
    listApiKeys();
  } catch (e) { /* ignore */ }
}

if (keyForm) {
  keyForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const sid = ($('apikey-sender').value || '').trim();
    const label = ($('apikey-label').value || '').trim() || 'default';
    if (!sid) return;
    keyFresh.hidden = true;
    try {
      const body = {
        senderId: sid, label,
        partnerId: (($('apikey-partner') && $('apikey-partner').value) || '').trim() || null,
        unmetered: !!($('apikey-unmetered') && $('apikey-unmetered').checked),
        canProvision: !!($('apikey-provision') && $('apikey-provision').checked),
      };
      const res = await fetch('/api/owner/apikeys', { method: 'POST', headers: { 'X-CyberSygn-Owner': readToken(), 'content-type': 'application/json' }, body: JSON.stringify(body) });
      const data = await res.json();
      keyFresh.hidden = false;
      keyFresh.textContent = (res.ok && data.key) ? ('Copy now, shown once: ' + data.key) : ('Mint failed: ' + (data.message || res.status));
      if (res.ok && data.key) listApiKeys();
    } catch (e2) { keyFresh.hidden = false; keyFresh.textContent = 'Mint failed.'; }
  });
}
if (keyListBtn) keyListBtn.addEventListener('click', listApiKeys);

// ---- Password reset (email-gated) ----------------------------------------
const forgotLink = $('control-forgot');
const resetReqForm = $('control-reset-request');
const resetConfirmForm = $('control-reset-confirm');
const loginFormEl = $('control-login-form');

if (forgotLink && resetReqForm) {
  forgotLink.addEventListener('click', (e) => {
    e.preventDefault();
    resetReqForm.hidden = !resetReqForm.hidden;
  });
  resetReqForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const email = (($('control-reset-email') && $('control-reset-email').value) || '').trim();
    const status = $('control-reset-status');
    status.hidden = false; status.textContent = 'Sending…';
    try {
      const res = await fetch('/api/owner/reset/request', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email }) });
      const data = await res.json().catch(() => ({}));
      status.textContent = data.message || 'If that address is on file, a reset link is on its way.';
    } catch (err) { status.textContent = 'Could not send. Try again in a moment.'; }
  });
}

// Opened from the emailed reset link (?reset=token): show the set-new-password view.
(function initResetConfirm() {
  const token = new URLSearchParams(location.search).get('reset');
  if (!token || !resetConfirmForm) return;
  const loginSection = $('control-login');
  if (loginSection) loginSection.hidden = false;
  if (loginFormEl) loginFormEl.hidden = true;
  if (resetReqForm) resetReqForm.hidden = true;
  if (forgotLink && forgotLink.parentElement) forgotLink.parentElement.hidden = true;
  resetConfirmForm.hidden = false;
  resetConfirmForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const username = (($('control-reset-user') && $('control-reset-user').value) || '').trim();
    const password = ($('control-reset-pass') && $('control-reset-pass').value) || '';
    const status = $('control-reset-confirm-status');
    status.hidden = false; status.textContent = 'Saving…';
    try {
      const res = await fetch('/api/owner/reset/confirm', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token, username, password }) });
      const data = await res.json().catch(() => ({}));
      if (res.ok && data.ok) {
        status.textContent = 'Password updated. Loading sign-in…';
        setTimeout(() => { location.href = location.pathname; }, 1200);
      } else {
        status.textContent = data.message || 'Reset failed. Request a new link.';
      }
    } catch (err) { status.textContent = 'Reset failed. Try again.'; }
  });
})();

// ----- Ambassador program tile ----------------------------------------------

async function loadAmbassadors() {
  const body = $('ctrl-amb-body');
  if (!body) return;
  body.innerHTML = '<p class="control-tile__empty">Loading ambassadors.</p>';
  try {
    const res = await fetch('/api/owner/ambassadors', {
      headers: { 'X-CyberSygn-Owner': readToken() },
    });
    if (res.status === 401) { body.innerHTML = '<p class="control-tile__empty">Session expired.</p>'; return; }
    if (!res.ok) { body.innerHTML = '<p class="control-tile__empty">Could not load: HTTP ' + res.status + '</p>'; return; }
    const d = await res.json();
    const t = d.totals || {};
    const money = (n) => '$' + (Math.round((Number(n) || 0) * 100) / 100).toLocaleString();

    if (!d.rows || !d.rows.length) {
      body.innerHTML = '<p class="control-tile__empty">No ambassadors enrolled yet.</p>';
      return;
    }

    const rows = d.rows.map((r) => (
      '<tr>' +
        '<td class="control-src__name">' + srcEsc(r.code.toUpperCase()) + '</td>' +
        '<td>' + srcEsc(r.status) + '</td>' +
        '<td>' + srcEsc(r.tier) + '</td>' +
        '<td class="control-src__num">' + r.sales + '</td>' +
        '<td class="control-src__num">' + money(r.earnedUsd) + '</td>' +
        '<td class="control-src__num"><strong>' + money(r.owedUsd) + '</strong></td>' +
        '<td>' + (r.w9Required ? srcEsc(r.w9State || 'needed') : 'n/a') + '</td>' +
        '<td class="control-amb__act">' +
          (r.owedUsd > 0 ? '<button class="btn btn--ghost btn--sm" data-payout="' + srcEsc(r.code) + '" data-owed="' + r.owedUsd + '">Pay</button> ' : '') +
          (r.status !== 'revoked' ? '<button class="btn btn--ghost btn--sm" data-revoke="' + srcEsc(r.code) + '">Revoke</button>' : '') +
        '</td>' +
      '</tr>'
    )).join('');

    body.innerHTML =
      '<div class="control-stats">' +
        statBlock(t.active, 'Active', t.ambassadors + ' enrolled') +
        statBlock(t.sales, 'Attributed sales', 'all time') +
        '<div class="control-stat"><span class="control-stat__num">' + money(t.owedUsd) + '</span>' +
          '<span class="control-stat__label">Unpaid liability</span>' +
          '<span class="control-stat__sub">' + money(t.earnedUsd) + ' earned, ' + money(t.paidUsd) + ' paid</span></div>' +
        statBlock(t.w9Needed, 'W-9 needed', 'past $600 this year') +
      '</div>' +
      '<table class="control-src-table"><thead><tr>' +
        '<th>Code</th><th>Status</th><th>Tier</th>' +
        '<th class="control-src__num">Sales</th>' +
        '<th class="control-src__num">Earned</th>' +
        '<th class="control-src__num">Owed</th>' +
        '<th>W-9</th><th>Actions</th>' +
      '</tr></thead><tbody>' + rows + '</tbody></table>';
  } catch (err) {
    body.innerHTML = '<p class="control-tile__empty">Network error: ' + (err.message || err) + '</p>';
  }
}

// Payout and revoke, both confirmed before they fire. Revoke is destructive
// (it kills the Stripe promo and the product pass) so it asks twice.
document.addEventListener('click', async (e) => {
  const payBtn = e.target.closest('[data-payout]');
  if (payBtn) {
    const code = payBtn.dataset.payout;
    const owed = payBtn.dataset.owed;
    const amount = window.prompt('Record a payout for ' + code.toUpperCase() + '. Amount owed is $' + owed + '. Enter the amount you actually sent:', owed);
    if (amount === null) return;
    const method = window.prompt('Method (paypal, wise, other):', 'paypal');
    if (method === null) return;
    payBtn.disabled = true;
    const res = await fetch('/api/owner/ambassadors/payout', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'X-CyberSygn-Owner': readToken() },
      body: JSON.stringify({ code, amount: Number(amount), method }),
    });
    if (res.ok) loadAmbassadors(); else payBtn.disabled = false;
    return;
  }
  const revBtn = e.target.closest('[data-revoke]');
  if (revBtn) {
    const code = revBtn.dataset.revoke;
    if (!window.confirm('Revoke ' + code.toUpperCase() + '? This deactivates their discount code and ends their product pass. Earned commission is kept.')) return;
    const reason = window.prompt('Reason (kept on the record):', '');
    if (reason === null) return;
    revBtn.disabled = true;
    const res = await fetch('/api/owner/ambassadors/revoke', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'X-CyberSygn-Owner': readToken() },
      body: JSON.stringify({ code, reason }),
    });
    if (res.ok) loadAmbassadors(); else revBtn.disabled = false;
  }
});

const ambRefresh = $('ctrl-amb-refresh');
if (ambRefresh) ambRefresh.addEventListener('click', loadAmbassadors);
const ambTest = $('ctrl-amb-test');
if (ambTest) ambTest.addEventListener('click', async () => {
  ambTest.disabled = true;
  const prior = ambTest.textContent;
  ambTest.textContent = 'Sending.';
  try {
    const res = await fetch('/api/owner/ambassadors/test-email', {
      method: 'POST',
      headers: { 'X-CyberSygn-Owner': readToken() },
    });
    const d = await res.json().catch(() => ({}));
    ambTest.textContent = res.ok ? ('Sent to ' + (d.redirectedTo || 'you')) : 'Failed';
  } catch (e) { ambTest.textContent = 'Failed'; }
  setTimeout(() => { ambTest.textContent = prior; ambTest.disabled = false; }, 2600);
});


// Initial paint
paint();
loadAmbassadors();

