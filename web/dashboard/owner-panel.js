/**
 * Owner-only analytics panel on the dashboard.
 *
 * Activates when an owner token is present in localStorage. Fetches
 * /api/analytics/summary (server validates the token; on 401 we hide
 * the panel). Renders compact KPI cards with totals plus a few top-N
 * lists for paths, referrers, countries, and errors.
 *
 * Fails gracefully:
 *   - no owner token -> panel hidden entirely
 *   - 401 from server -> panel hidden entirely
 *   - 200 but AE not configured -> panel renders a "configure to
 *       see live data" notice instead of empty cards
 *   - 500 -> panel renders the error message
 */

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
      panel.hidden = true;
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
