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
    const claimedPct = founding.cap > 0 ? Math.round((founding.claimed / founding.cap) * 100) : 0;
    const dsPct = Math.round((dataset.progress || 0) * 100);
    body.innerHTML =
      '<div class="control-stats">' +
        statBlock(founding.claimed, 'Origin claimed', founding.cap + ' cap · ' + claimedPct + '%') +
        statBlock(free.signups, 'Free signups', 'lifetime') +
        statBlock(dataset.total, 'Labeled corpus', dataset.threshold.toLocaleString() + ' target · ' + dsPct + '%') +
        statBlock(dataset.contributors, 'Contributors', 'unique emails') +
      '</div>' +
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
  const n = Number.isFinite(num) ? Number(num).toLocaleString() : '—';
  return '<div class="control-stat">' +
    '<span class="control-stat__num">' + n + '</span>' +
    '<span class="control-stat__label">' + label + '</span>' +
    (sub ? '<span class="control-stat__sub">' + sub + '</span>' : '') +
  '</div>';
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

// Initial paint
paint();
