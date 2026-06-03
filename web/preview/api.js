/**
 * CyberSygn preview, prototype: client-side API layer.
 *
 * Thin wrapper over the Worker endpoints. Every call is wrapped so the
 * caller gets {ok, data} or {ok: false, error} and can decide whether
 * to fall back to the local-only flow.
 *
 * The Worker is optional. When it is not reachable (CORS error, 404 on
 * /api/status, or any network failure), every method here resolves with
 * { ok: false, ... } and the rest of the app stays usable in the
 * in-browser-only mode it always had.
 */

// The Worker base URL. Same-origin in production (Cloudflare Pages with
// a Worker route on /api/*), localhost in dev (wrangler dev runs on
// 8787 by default). Override via window.CYBERSYGN_API_BASE if needed.
function apiBase() {
  if (typeof window !== 'undefined' && window.CYBERSYGN_API_BASE) {
    return String(window.CYBERSYGN_API_BASE).replace(/\/$/, '');
  }
  // Try same-origin first.
  return '';
}

/**
 * Probe /api/status. Caches the result for the rest of the page life.
 * The probe is intentionally fast (HEAD-equivalent GET, small response)
 * so the UI can adapt before the user clicks anything.
 */
let _statusPromise = null;
export function checkWorker() {
  if (_statusPromise) return _statusPromise;
  _statusPromise = (async () => {
    try {
      const res = await fetch(apiBase() + '/api/status', {
        method: 'GET',
        headers: { 'accept': 'application/json' },
        // Short timeout so a missing Worker does not delay the UI.
        signal: AbortSignal.timeout(2500),
      });
      if (!res.ok) return { ok: false, reason: `status:${res.status}` };
      const data = await res.json();
      return { ok: true, ...data };
    } catch (err) {
      return { ok: false, reason: String(err && err.message || err) };
    }
  })();
  return _statusPromise;
}

/**
 * Create a document for multi-signer routing. Returns the docId and
 * the magic links the Worker minted (and tried to email).
 */
export async function createDoc({ title, pdfBytes, fields, fieldEdits, signers, assignments, cc, senderName, senderId, workspaceId, mode }) {
  const pdfBase64 = bytesToBase64(pdfBytes);
  return jsonCall('/api/docs', {
    method: 'POST',
    body: JSON.stringify({
      title,
      pdfBase64,
      fields,
      fieldEdits: fieldEdits || {},
      signers,
      assignments,
      cc: Array.isArray(cc) ? cc : [],
      senderName,
      senderId,
      workspaceId,
      mode,
    }),
  });
}

/**
 * Hydrate a signer's perspective from a magic link.
 */
export async function hydrateSigner(docId, token) {
  return jsonCall(`/api/docs/${docId}/signer/${token}`, { method: 'GET' });
}

/**
 * Submit one signer's fills.
 */
export async function submitFills(docId, token, fills) {
  return jsonCall(`/api/docs/${docId}/signer/${token}/fills`, {
    method: 'POST',
    body: JSON.stringify({ fills }),
  });
}

/**
 * Fetch the original PDF for an authenticated signer.
 */
export async function fetchSignerPdf(docId, token) {
  try {
    const res = await fetch(apiBase() + `/api/docs/${docId}/pdf?t=${encodeURIComponent(token)}`, {
      method: 'GET',
    });
    if (!res.ok) return { ok: false, error: `status:${res.status}` };
    const buf = await res.arrayBuffer();
    return { ok: true, bytes: new Uint8Array(buf) };
  } catch (err) {
    return { ok: false, error: String(err && err.message || err) };
  }
}

/**
 * Sender-triggered reminder for a single pending signer.
 */
export async function remindSigner(docId, signerId) {
  return jsonCall(`/api/docs/${docId}/remind/${signerId}`, { method: 'POST' });
}

/**
 * Sender's view of progress.
 */
export async function fetchProgress(docId, senderToken) {
  const q = senderToken ? `?s=${encodeURIComponent(senderToken)}` : '';
  return jsonCall(`/api/docs/${docId}${q}`, { method: 'GET' });
}

/**
 * Dashboard: every doc this sender has created.
 */
export async function fetchSenderDocs(senderId) {
  return jsonCall(`/api/sender/${encodeURIComponent(senderId)}/docs`, { method: 'GET' });
}

// ---- Workspaces -----------------------------------------------------------

export async function createWorkspace({ name, adminSenderId, adminName, adminEmail }) {
  return jsonCall('/api/workspaces', {
    method: 'POST',
    body: JSON.stringify({ name, adminSenderId, adminName, adminEmail }),
  });
}

export async function fetchWorkspaceDocs(workspaceId, workspaceToken) {
  return jsonCall(`/api/workspaces/${encodeURIComponent(workspaceId)}/docs?w=${encodeURIComponent(workspaceToken)}`, { method: 'GET' });
}

export async function fetchWorkspaceMembers(workspaceId, workspaceToken) {
  return jsonCall(`/api/workspaces/${encodeURIComponent(workspaceId)}/members?w=${encodeURIComponent(workspaceToken)}`, { method: 'GET' });
}

export async function createInvite(workspaceId, workspaceToken, { name, email } = {}) {
  return jsonCall(`/api/workspaces/${encodeURIComponent(workspaceId)}/invites?w=${encodeURIComponent(workspaceToken)}`, {
    method: 'POST',
    body: JSON.stringify({ name, email }),
  });
}

export async function readInvite(inviteId) {
  return jsonCall(`/api/invites/${encodeURIComponent(inviteId)}`, { method: 'GET' });
}

export async function acceptInvite(inviteId, { senderId, name, email } = {}) {
  return jsonCall(`/api/invites/${encodeURIComponent(inviteId)}`, {
    method: 'POST',
    body: JSON.stringify({ senderId, name, email }),
  });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function jsonCall(path, init = {}) {
  try {
    const headers = {
      'content-type': 'application/json',
      'accept': 'application/json',
      ...(init.headers || {}),
    };
    // Auto-attach owner token when present. We read directly from
    // localStorage rather than import owner.js to avoid a circular
    // dependency between api.js and owner.js (owner.js wants to call
    // /api/owner/claim through this client).
    try {
      const t = localStorage.getItem('cybersygn.owner.token');
      if (t && t.length === 64 && /^[a-f0-9]+$/.test(t)) {
        headers['X-CyberSygn-Owner'] = t;
      }
    } catch (e) {}
    const res = await fetch(apiBase() + path, {
      ...init,
      headers,
    });
    let data = null;
    try { data = await res.json(); } catch {}
    if (!res.ok) {
      return { ok: false, status: res.status, error: (data && data.message) || `HTTP ${res.status}` };
    }
    return { ok: true, status: res.status, data };
  } catch (err) {
    return { ok: false, error: String(err && err.message || err) };
  }
}

/**
 * Base64 encode a large Uint8Array without blowing the JS stack.
 * The naive String.fromCharCode(...arr) approach throws RangeError for
 * arrays bigger than ~64 KB on most engines, so we chunk.
 */
export function bytesToBase64(bytes) {
  const CHUNK = 0x8000; // 32 KB
  let binary = '';
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

/**
 * Decode a base64 string into a Uint8Array. Counterpart of bytesToBase64.
 * Used by the draft-restore path to rehydrate a saved PDF.
 */
export function base64ToBytes(b64) {
  const binary = atob(b64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}
