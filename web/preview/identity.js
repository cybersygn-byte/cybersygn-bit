/**
 * Sender identity, browser-side.
 *
 * The prototype stores a stable senderId in localStorage so the
 * dashboard knows "which sender am I" without a real account system.
 * The id is a 32-character random token, generated once per browser
 * profile, and submitted with every createDoc call. The Worker uses
 * it to build a per-sender index of docs.
 *
 * Per-doc senderTokens (a separate, doc-specific secret returned by
 * createDoc) are also cached, keyed by docId. This lets the dashboard
 * fetch privileged details (magic links, audit URL) without making
 * the user log in. When localStorage gets cleared, the sender just
 * has to copy their senderId back in from the dashboard's "Backup"
 * panel, like a recovery code.
 */

const SENDER_ID_KEY = 'cybersygn.senderId';
const DOC_TOKENS_KEY = 'cybersygn.docTokens';
const WORKSPACES_KEY = 'cybersygn.workspaces';
const ACTIVE_WORKSPACE_KEY = 'cybersygn.activeWorkspaceId';

export function getSenderId() {
  let id = '';
  try { id = localStorage.getItem(SENDER_ID_KEY) || ''; } catch {}
  if (!id) {
    id = generate();
    try { localStorage.setItem(SENDER_ID_KEY, id); } catch {}
  }
  return id;
}

export function setSenderId(id) {
  const clean = String(id || '').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 64);
  if (!clean) return null;
  try { localStorage.setItem(SENDER_ID_KEY, clean); } catch {}
  return clean;
}

/**
 * After a doc is created, stash the per-doc senderToken so the
 * dashboard can fetch privileged details later without re-creating
 * the doc.
 */
export function rememberDocToken(docId, senderToken) {
  try {
    const map = JSON.parse(localStorage.getItem(DOC_TOKENS_KEY) || '{}');
    map[docId] = senderToken;
    localStorage.setItem(DOC_TOKENS_KEY, JSON.stringify(map));
  } catch {}
}

export function getDocToken(docId) {
  try {
    const map = JSON.parse(localStorage.getItem(DOC_TOKENS_KEY) || '{}');
    return map[docId] || null;
  } catch {
    return null;
  }
}

function generate() {
  const bytes = new Uint8Array(16);
  (crypto || window.crypto).getRandomValues(bytes);
  return Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
}

// ---- Workspaces ------------------------------------------------------------

/**
 * Workspace identity: a list of workspaces the user has joined and a
 * pointer to which one is "active." Each entry is a small record
 * { id, token, name, memberId, joinedAt }.
 *
 * The active workspace governs which doc index the dashboard reads
 * from. "None" is a valid state; the dashboard falls back to the
 * per-sender list (the existing Solo behaviour).
 */
export function listWorkspaces() {
  try {
    const raw = localStorage.getItem(WORKSPACES_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

export function saveWorkspace({ id, token, name, memberId }) {
  if (!id || !token) return null;
  const list = listWorkspaces();
  const i = list.findIndex(w => w.id === id);
  const entry = { id, token, name: name || 'Workspace', memberId: memberId || null, joinedAt: new Date().toISOString() };
  if (i >= 0) list[i] = { ...list[i], ...entry, joinedAt: list[i].joinedAt };
  else list.unshift(entry);
  try { localStorage.setItem(WORKSPACES_KEY, JSON.stringify(list)); } catch {}
  return entry;
}

export function removeWorkspace(id) {
  const list = listWorkspaces().filter(w => w.id !== id);
  try {
    localStorage.setItem(WORKSPACES_KEY, JSON.stringify(list));
    if (getActiveWorkspaceId() === id) localStorage.removeItem(ACTIVE_WORKSPACE_KEY);
  } catch {}
}

export function getActiveWorkspaceId() {
  try { return localStorage.getItem(ACTIVE_WORKSPACE_KEY) || null; } catch { return null; }
}

export function setActiveWorkspaceId(id) {
  try {
    if (id) localStorage.setItem(ACTIVE_WORKSPACE_KEY, id);
    else localStorage.removeItem(ACTIVE_WORKSPACE_KEY);
  } catch {}
}

export function getActiveWorkspace() {
  const id = getActiveWorkspaceId();
  if (!id) return null;
  return listWorkspaces().find(w => w.id === id) || null;
}
