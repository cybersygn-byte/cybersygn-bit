/**
 * Owner-only analytics panel on the dashboard.
 *
 * Activates when an owner token is present in localStorage. Fetches
 * /api/analytics/summary (server validates the token). Renders compact
 * KPI cards with totals plus a few top-N lists for paths, referrers,
 * countries, and errors.
 *
 * Also hydrates the masthead's owner-pill on this page by booting the
 * shared owner module (which the marketing page already does). Without
 * this hydration the pill would never appear on /dashboard/ even when
 * the token is present, which is exactly the issue users hit before.
 *
 * Fails gracefully:
 *   - no owner token -> panel hidden entirely (and pill hidden)
 *   - 401 from server -> render a "re-activate" prompt with a button
 *   - 200 but AE not configured -> "configure to enable" notice
 *   - 500 -> error message inline
 */

import * as ownerMod from '../preview/owner.js';

const PANEL_ID = 'owner-panel';
const BODY_ID  = 'owner-panel-body';
const WINDOW_ID = 'owner-panel-window';
const REFRESH_ID = 'owner-panel-refresh';
const OWNER_HEADER = 'X-CyberSygn-Owner';
const OWNER_KEY = 'cybersygn.owner.token';

function getOwnerToken() {
  try { return localStorage.getItem(OWNER_KEY); } catch (e) { return null; }
}

function $(id) { return document.getElementById(id); }

function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function rowsFromData(d) {
  // Cloudflare AE SQL API returns { meta: [...], data: [{...}, ...] }.
  if (!d || !d.data || !Array.isArray(d.data)) return [];
  return d.data;
}

function tableRows(rows, primaryKey, valueKey, emptyLabel) {
  if (!rows.length) return `<p class="owner-panel__empty">${escapeHtml(emptyLabel || 'No data yet.')}</p>`;
  return `<ul class="owner-panel__list">${rows.map(r => `
    <li class="owner-panel__list-row">
      <span class="owner-panel__list-key">${escapeHtml(r[primaryKey] || '—')}</span>
      <span class="owner-panel__list-val">${escapeHtml(r[valueKey] != null ? r[valueKey] : '—')}</span>
    </li>`).join('')}</ul>`;
}

function render(state) {
  const body = $(BODY_ID);
  if (!body) return;

  if (state.kind === 'unconfigured') {
    body.innerHTML = `
      <div class="owner-panel__notice">
        <p><strong>Analytics storage not enabled yet.</strong></p>
        <p>Events are being accepted at /api/event and /api/error but Cloudflare Analytics Engine has not been turned on for this account. Enable at <a href="https://dash.cloudflare.com/workers/analytics-engine" target="_blank" rel="noopener">dash.cloudflare.com/workers/analytics-engine</a>, then uncomment the analytics_engine_datasets block in wrangler.jsonc and redeploy. Live data will start flowing within minutes of the next event.</p>
      </div>`;
    return;
  }

  if (state.kind === 'reauth') {
    body.innerHTML = `
      <div class="owner-panel__notice">
        <p><strong>Owner token no longer valid.</strong></p>
        <p>Your browser has an owner token but the server rejected it (HTTP 401). This usually means the owner phrase changed, the token record expired, or the worker was redeployed in a way that lost the token. Re-activate to fix:</p>
        <p style="margin-top:12px;"><button type="button" id="owner-panel-reauth" class="btn btn--primary">Re-activate owner mode</button></p>
      </div>`;
    const btn = document.getElementById('owner-panel-reauth');
    if (btn) btn.addEventListener('click', reauthPrompt);
    return;
  }

  if (state.kind === 'error') {
    body.innerHTML = `<p class="owner-panel__empty">Could not load: ${escapeHtml(state.message || 'unknown error')}</p>`;
    return;
  }

  // state.kind === 'ok'
  const r = state.results || {};
  const totalsRows = rowsFromData(r.totals);
  const totals = totalsRows[0] || {};
  const events  = totals.events != null  ? totals.events  : 0;
  const senders = totals.senders != null ? totals.senders : 0;

  body.innerHTML = `
    <div class="owner-panel__kpis">
      <div class="owner-panel__kpi">
        <span class="owner-panel__kpi-num">${escapeHtml(events)}</span>
        <span class="owner-panel__kpi-label">events</span>
      </div>
      <div class="owner-panel__kpi">
        <span class="owner-panel__kpi-num">${escapeHtml(senders)}</span>
        <span class="owner-panel__kpi-label">unique senders</span>
      </div>
    </div>
    <div class="owner-panel__grid">
      <div class="owner-panel__col">
        <h3 class="owner-panel__h">Top paths</h3>
        ${tableRows(rowsFromData(r.topPaths), 'path', 'n', 'No pageviews yet.')}
      </div>
      <div class="owner-panel__col">
        <h3 class="owner-panel__h">Top referrers</h3>
        ${tableRows(rowsFromData(r.topReferrers), 'referrer', 'n', 'No referrers yet.')}
      </div>
      <div class="owner-panel__col">
        <h3 class="owner-panel__h">By country</h3>
        ${tableRows(rowsFromData(r.byCountry), 'country', 'n', 'No country data yet.')}
      </div>
      <div class="owner-panel__col">
        <h3 class="owner-panel__h">By client</h3>
        ${tableRows(rowsFromData(r.byUaClass), 'ua', 'n', 'No client data yet.')}
      </div>
      <div class="owner-panel__col owner-panel__col--wide">
        <h3 class="owner-panel__h">Top events</h3>
        ${tableRows(rowsFromData(r.byEvent), 'event', 'n', 'No events yet.')}
      </div>
      <div class="owner-panel__col owner-panel__col--wide">
        <h3 class="owner-panel__h">Recent errors</h3>
        ${tableRows(rowsFromData(r.errors).map(e => ({ key: `${e.event || ''} ${e.error_class || ''}: ${e.message || ''}`.slice(0, 120), n: e.n })), 'key', 'n', 'No errors yet.')}
      </div>
    </div>`;
}

async function refresh() {
  const token = getOwnerToken();
  if (!token) return;
  const panel = $(PANEL_ID);
  if (!panel) return;
  const body = $(BODY_ID);
  if (body) body.innerHTML = '<p class="owner-panel__empty">Loading.</p>';

  const win = ($(WINDOW_ID) && $(WINDOW_ID).value) || "INTERVAL '7' DAY";
  try {
    const res = await fetch(`/api/analytics/summary?window=${encodeURIComponent(win)}`, {
      headers: { [OWNER_HEADER]: token },
    });
    if (res.status === 401) {
      // Token in localStorage no longer validates against the worker. Don't
      // silently hide the panel; render a re-activation prompt so the owner
      // knows what to do. Common causes: owner hash was rotated, KV record
      // expired, or the token was minted against an older deploy.
      render({ kind: 'reauth' });
      return;
    }
    if (!res.ok) {
      render({ kind: 'error', message: `HTTP ${res.status}` });
      return;
    }
    const data = await res.json();
    // Detect "AE not configured" by checking each result for the configure-error message.
    const r = data.results || {};
    const sample = r.totals && r.totals.error;
    if (typeof sample === 'string' && /CF_ACCOUNT_ID|CF_ANALYTICS_TOKEN|enable Analytics Engine|not configured/i.test(sample)) {
      render({ kind: 'unconfigured' });
      return;
    }
    render({ kind: 'ok', results: r });
  } catch (err) {
    render({ kind: 'error', message: err && err.message ? err.message : String(err) });
  }
}

async function sendTestEmail(to) {
  const token = getOwnerToken();
  if (!token) throw new Error('not owner');
  const res = await fetch('/api/owner/test-email', {
    method: 'POST',
    headers: { 'content-type': 'application/json', [OWNER_HEADER]: token },
    body: JSON.stringify({ to }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.message || `HTTP ${res.status}`);
  return data;
}

// Re-activation flow. Prompts for the owner phrase, POSTs to /api/owner/claim,
// saves the new token, then refreshes. Lets the owner fix a stale token
// without leaving the dashboard.
async function reauthPrompt() {
  const phrase = window.prompt('Paste your owner phrase to re-activate:');
  if (!phrase || phrase.trim().length === 0) return;
  try {
    const res = await fetch('/api/owner/claim', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ phrase: phrase.trim() }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.token) {
      alert('Activation failed. Check the phrase and try again.');
      return;
    }
    try { localStorage.setItem(OWNER_KEY, data.token); } catch (e) {}
    refresh();
  } catch (err) {
    alert('Activation failed: ' + (err && err.message ? err.message : err));
  }
}

async function runHealth() {
  const out = $('owner-health-output');
  if (out) out.textContent = 'Running.';
  try {
    const res = await fetch('/api/health');
    const data = await res.json();
    if (out) out.textContent = JSON.stringify(data, null, 2);
  } catch (err) {
    if (out) out.textContent = 'Health check failed: ' + (err && err.message ? err.message : err);
  }
}

function wireTools() {
  const form = $('owner-test-email');
  const status = $('owner-test-email-status');
  if (form) {
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const input = $('owner-test-email-to');
      const to = input && input.value && input.value.trim();
      if (!to) return;
      if (status) status.textContent = 'Sending.';
      try {
        const data = await sendTestEmail(to);
        if (status) {
          status.textContent = data.mode === 'resend'
            ? `Delivered via Resend. Provider id: ${data.providerId || 'unknown'}.`
            : `Sent in ${data.mode || 'fallback'} mode (check Worker logs).`;
        }
      } catch (err) {
        if (status) status.textContent = 'Failed: ' + (err && err.message ? err.message : err);
      }
    });
  }
  const healthBtn = $('owner-health-run');
  if (healthBtn) healthBtn.addEventListener('click', runHealth);
}

function mount() {
  // Hydrate the masthead owner-pill from localStorage. Without this, the
  // pill stays data-active="false" on the dashboard even when the user is
  // signed in as owner. Side effects: also re-verifies the token against
  // the server and wires the pill's close button.
  ownerMod.bootOwner('').then(() => ownerMod.wirePillControls());
  ownerMod.watchActivation('');

  const panel = $(PANEL_ID);
  if (!panel) return;
  if (!getOwnerToken()) {
    panel.hidden = true;
    return;
  }
  panel.hidden = false;

  // Wire controls.
  const refreshBtn = $(REFRESH_ID);
  if (refreshBtn) refreshBtn.addEventListener('click', refresh);
  const winSel = $(WINDOW_ID);
  if (winSel) winSel.addEventListener('change', refresh);
  wireTools();

  refresh();
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', mount);
} else {
  mount();
}
