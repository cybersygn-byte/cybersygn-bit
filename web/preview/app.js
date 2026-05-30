/**
 * CyberSygn preview, prototype.
 *
 * Loads a PDF in the browser, runs the same detection module the Cloudflare
 * Worker uses, and draws bounding boxes on top of each rendered page.
 *
 * Detection lives in worker/src/detect.js. We import it without modification.
 * The pdfjs specifier inside that file is rewritten by the importmap in
 * index.html to point at the CDN, so node and browser resolve the same code.
 */

import { GlobalWorkerOptions } from 'pdfjs-dist/legacy/build/pdf.mjs';
import * as pdfjsLib from 'pdfjs-dist/legacy/build/pdf.mjs';
import { detectFields } from '../../worker/src/detect.js';
import {
  openCaptureModal,
  renderBoxForFill,
  flattenAndDownload,
  createFillStore,
} from './signing.js';
import {
  createSignersStore,
  createAssignmentStore,
  createSigningAsStore,
  progressBySigner,
  initialsFor,
} from './signers.js';
import {
  checkWorker,
  createDoc,
  hydrateSigner,
  submitFills,
  fetchSignerPdf,
  remindSigner,
  fetchProgress,
} from './api.js';
import { getSenderId, rememberDocToken, getActiveWorkspace } from './identity.js';
import * as ownerMod from './owner.js';
import * as cvDetect from './cv-detect.js';

// pdf.js needs a worker script. We point it at the self-hosted vendor
// copy so the browser parses PDFs off the main thread without making
// any third-party network calls.
GlobalWorkerOptions.workerSrc = '../vendor/pdf.worker.mjs';

const MAX_BYTES = 25 * 1024 * 1024; // matches Worker ceiling
// Pick a render scale that fills the available column width on wide
// screens. The result__pages column is everything left of the 380 px
// sidebar; on a 1440 px monitor that's ~1000 px after padding, which
// US-Letter at scale 1.0 (612 pt = 612 css px) does not fill, leaving
// a dark gap. We compute the scale so the rendered page targets ~960 px
// wide, capped to a sane range so a 32-inch monitor doesn't render a
// 4K canvas. On narrow viewports we drop to 1.2x for fast load.
function computeRenderScale() {
  const vw = (typeof window !== 'undefined' && window.innerWidth) || 1280;
  const sidebarWidth = vw > 980 ? 380 : 0;     // sidebar collapses on narrow
  const horizontalPadding = 64;                 // result__pages padding
  const target = Math.max(560, Math.min(1100, vw - sidebarWidth - horizontalPadding));
  const usLetterPt = 612;                       // standard PDF page width in points
  const scale = target / usLetterPt;
  return Math.max(1.0, Math.min(2.4, scale));
}
const RENDER_SCALE = computeRenderScale();

// Field types that trigger a capture flow when clicked. "checkbox"
// toggles inline without a modal; "text" gets a small text input modal.
const FILLABLE_TYPES = new Set(['signature', 'initial', 'date', 'checkbox', 'text']);

// ---- Analytics + error reporting hooks ------------------------------------
//
// These are no-ops by default. A production deployment can replace
// window.cybersygn.track / report with a real implementation (Plausible,
// PostHog, Sentry) by setting them before this module loads, or by
// editing the bodies below. The Worker also exposes a stub /api/event
// endpoint for self-hosted telemetry without any third-party service.

const cybersygn = (window.cybersygn = window.cybersygn || {});

const track = cybersygn.track || function track(event, props) {
  // Replace with a real analytics sink. Until then, log only when the
  // host explicitly opts in via window.__cybersygnDebug = true.
  if (window.__cybersygnDebug) console.info('[cybersygn:track]', event, props || {});
};

const report = cybersygn.report || function report(err, context) {
  // Replace with Sentry / Rollbar / etc. Always surfaces in the
  // browser console so prototype bugs are visible.
  console.error('[cybersygn:error]', context || '', err);
};

cybersygn.track = track;
cybersygn.report = report;

// ---- DOM refs --------------------------------------------------------------

const $ = id => document.getElementById(id);
const layout = $('app');
const dropzone = $('dropzone');
const result = $('result');
const fileInput = $('file-input');
const documentStrip = $('document-strip');
const filenameEl = $('result-filename');
const statPages = $('stat-pages');
const statFields = $('stat-fields');
const statConfidence = $('stat-confidence');
const fieldList = $('field-list');
const status = $('status-indicator');
const errorBanner = $('error-banner');
const resetButton = $('reset-button');
const signButton = $('sign-button');
const addFieldButtons = document.querySelectorAll('.add-field-btn');
const addFieldHint = $('add-field-hint');
const aiConsentCheckbox = $('ai-training-consent');
const saveTemplateButton = $('save-template-button');
const templateStateEl = $('template-state');

/**
 * Surface template state in the sidebar so the user knows whether
 * prior labeling loaded. States:
 *   applied-public  -> a public template auto-applied (anyone-shared)
 *   applied-private -> the user's own saved template auto-applied
 *   restored-edits  -> no template, but local senderEdits restored N adds
 *   none            -> heuristic-only result; no prior labels exist
 *   hidden          -> empty state (between documents)
 */
function setTemplateState(kind, detail) {
  if (!templateStateEl) return;
  if (!kind || kind === 'hidden') {
    templateStateEl.hidden = true;
    templateStateEl.removeAttribute('data-state');
    templateStateEl.textContent = '';
    return;
  }
  templateStateEl.hidden = false;
  templateStateEl.dataset.state = kind;
  const messages = {
    'applied-public':  `Template loaded (public, ${detail || 0} fields). Anyone uploading this PDF gets these labels.`,
    'applied-private': `Your saved template loaded (${detail || 0} fields).`,
    'restored-edits':  `Restored ${detail || 0} manual fields from your previous session on this PDF.`,
    'none':            `No saved template for this PDF. Detection is heuristic only. Add missing fields and click "Save as template" to lock them in.`,
  };
  templateStateEl.textContent = messages[kind] || '';
}
const toast = $('toast');

// Signers panel DOM
const signersList = $('signers-list');
const addSignerBtn = $('add-signer');
const signingAsSelect = $('signing-as');

// Currently rendered field elements, keyed by stable id, for sync with the sidebar.
const fieldElements = new Map();

// ---- Document state --------------------------------------------------------
//
// Holds everything needed to flatten and download the signed PDF once
// the user clicks "Download." Reset on a fresh upload.

const fillStore = createFillStore();
const signers = createSignersStore();
const assignments = createAssignmentStore();
const signingAs = createSigningAsStore();

const docState = {
  filename: null,
  originalBytes: null,        // Uint8Array, kept for pdf-lib flatten
  docId: null,                // SHA-256 hex of originalBytes, stable across reloads
  fields: [],                 // detection.fields, with id assigned
  mode: null,                 // null | 'in-person' | 'send', chosen after detection
};

/**
 * Per-field sender edits. Sender can change a field's type, promote /
 * demote it between primary and secondary, or delete it. Keyed by field
 * id (same id used by the rest of the app). Each value is a partial
 * overlay; applyEdits() merges base detection results with these
 * overlays to produce the live field list everywhere downstream.
 *
 * Persisted to localStorage per-document under
 * `cybersygn.edits.<docId>`. Document id is the SHA-256 of the original
 * PDF bytes, so re-uploading the same PDF restores the same edits.
 *
 * Each entry records BOTH the overlay (type/primary/deleted) AND a
 * timestamped reason so the Worker can replay the edits into the audit
 * certificate. The shape stored on each field id is:
 *   {
 *     type?:    string,
 *     primary?: boolean,
 *     deleted?: boolean,
 *     // History of changes for audit:
 *     history?: Array<{ at: string, change: object, prev: object }>,
 *   }
 */
const senderEdits = new Map();

const EDITS_KEY_PREFIX = 'cybersygn.edits.';
const EDITS_MAX_AGE_MS = 1000 * 60 * 60 * 24 * 30;  // 30 days

async function sha256Hex(bytes) {
  // sha256Hex's caller passes its own bytes; crypto.subtle.digest accepts a
  // BufferSource. We pass bytes.slice() defensively so the digest call does
  // not see a detached buffer if upstream transferred one.
  const buf = await crypto.subtle.digest('SHA-256', bytes.slice());
  return Array.from(new Uint8Array(buf))
    .map(b => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Return a fresh, independent Uint8Array carrying the same bytes as `src`.
 * Allocates a new ArrayBuffer so consumers that transfer ownership
 * (pdf.js, pdf-lib) detach the new buffer instead of the caller's
 * canonical copy. Use this before every getDocument-style call.
 *
 * Throws if `src` is already detached (caller has a bug); the message
 * surfaces clearly to make the next debug step obvious.
 */
function freshCopy(src) {
  if (!(src instanceof Uint8Array)) {
    throw new TypeError('freshCopy: expected a Uint8Array');
  }
  // Reading .byteLength on a detached buffer is allowed and returns 0 in
  // some engines, but src.slice() throws a clear TypeError on a detached
  // buffer which is the diagnostic we want.
  return src.slice();
}

function loadEditsFromStorage(docId) {
  if (!docId) return;
  try {
    const raw = localStorage.getItem(EDITS_KEY_PREFIX + docId);
    if (!raw) return;
    const parsed = JSON.parse(raw);
    if (parsed && parsed.savedAt && Date.now() - parsed.savedAt > EDITS_MAX_AGE_MS) {
      localStorage.removeItem(EDITS_KEY_PREFIX + docId);
      return;
    }
    if (parsed && parsed.edits && typeof parsed.edits === 'object') {
      for (const [fieldId, overlay] of Object.entries(parsed.edits)) {
        senderEdits.set(fieldId, overlay);
      }
    }
  } catch (e) {
    console.warn('[cybersygn:edits] could not rehydrate', e);
  }
}

function saveEditsToStorage() {
  if (!docState.docId) return;
  try {
    const obj = {};
    for (const [k, v] of senderEdits.entries()) obj[k] = v;
    if (Object.keys(obj).length === 0) {
      localStorage.removeItem(EDITS_KEY_PREFIX + docState.docId);
      return;
    }
    localStorage.setItem(EDITS_KEY_PREFIX + docState.docId, JSON.stringify({
      savedAt: Date.now(),
      edits: obj,
    }));
  } catch (e) {
    console.warn('[cybersygn:edits] could not persist', e);
  }
}

/**
 * Apply saved edits to a freshly-detected fields array. Modifies fields
 * in place: changes type, sets primary, removes deleted ones. Called
 * right after detection completes and before the first render.
 */
function applyStoredEditsToFields(fields) {
  if (senderEdits.size === 0) return fields;
  const out = [];
  const seenIds = new Set();
  for (const f of fields) {
    const overlay = senderEdits.get(f.id);
    if (!overlay) { out.push(f); seenIds.add(f.id); continue; }
    if (overlay.deleted) continue;
    const next = { ...f };
    if (typeof overlay.type === 'string') next.type = overlay.type;
    if (typeof overlay.primary === 'boolean') next.primary = overlay.primary;
    // Geometry overrides from drag/resize. Applied after the base field
    // so the user's manual adjustments win over the detector's coords.
    if (Number.isFinite(overlay.x)) next.x = overlay.x;
    if (Number.isFinite(overlay.y)) next.y = overlay.y;
    if (Number.isFinite(overlay.width))  next.width  = overlay.width;
    if (Number.isFinite(overlay.height)) next.height = overlay.height;
    out.push(next);
    seenIds.add(f.id);
  }
  // Restore manually-added fields that the heuristic detector does NOT
  // find on its own. Without this, every reload of the same PDF loses
  // every field the user dropped manually. Match on overlay.added flag
  // set by the sticky add-field handler.
  for (const [fieldId, overlay] of senderEdits.entries()) {
    if (seenIds.has(fieldId)) continue;
    if (!overlay || !overlay.added) continue;
    if (overlay.deleted) continue;
    out.push({
      id: fieldId,
      type: overlay.type || 'text',
      page: Number(overlay.page) || 1,
      x: Number(overlay.x) || 0,
      y: Number(overlay.y) || 0,
      width:  Number(overlay.width)  || 180,
      height: Number(overlay.height) || 28,
      label: overlay.label || '',
      confidence: 1.0,
      source: overlay.source || 'user-added',
      primary: overlay.primary !== false,
    });
  }
  return out;
}

/**
 * Apply a sender edit to a field by id. Edits supported:
 *   { type: 'signature' | 'date' | 'initial' | 'text' | 'checkbox' }
 *   { primary: true | false }
 *   { deleted: true }
 *
 * Mutates docState.fields in place and triggers a re-render of the
 * affected box. For deletions, also removes the field from the
 * assignments map and the fill store so nothing references a ghost.
 */
function applyFieldEdit(fieldId, edit) {
  const field = docState.fields.find(f => f.id === fieldId);
  if (!field) return;

  // Capture the prior state for the audit history entry.
  const prev = {
    type: field.type,
    primary: field.primary === false ? false : true,
  };
  const historyEntry = {
    at: new Date().toISOString(),
    change: { ...edit },
    prev,
  };

  if (edit.deleted) {
    docState.fields = docState.fields.filter(f => f.id !== fieldId);
    const existing = senderEdits.get(fieldId) || {};
    senderEdits.set(fieldId, {
      ...existing,
      deleted: true,
      // We also record what the field looked like at deletion, so the
      // audit cert can name it ("Removed signature near 'TENANT'").
      lastSnapshot: {
        type: field.type,
        label: field.label,
        page: field.page,
      },
      history: [...(existing.history || []), historyEntry],
    });
    try { fillStore.clear(fieldId); } catch (e) {}
    try { assignments.unassign(fieldId); } catch (e) {}
    const box = fieldElements.get(fieldId);
    if (box && box.parentElement) box.parentElement.removeChild(box);
    fieldElements.delete(fieldId);
  } else {
    if (typeof edit.type === 'string') field.type = edit.type;
    if (typeof edit.primary === 'boolean') field.primary = edit.primary;
    // Geometry edits from drag/resize. Coordinates are stored in PDF
    // space; the box's CSS position is updated separately so the visible
    // result matches the new field bounds when flatten runs.
    if (Number.isFinite(edit.x)) field.x = edit.x;
    if (Number.isFinite(edit.y)) field.y = edit.y;
    if (Number.isFinite(edit.width))  field.width  = edit.width;
    if (Number.isFinite(edit.height)) field.height = edit.height;
    const existing = senderEdits.get(fieldId) || {};
    senderEdits.set(fieldId, {
      ...existing,
      ...edit,
      history: [...(existing.history || []), historyEntry],
    });
    const box = fieldElements.get(fieldId);
    if (box) {
      box.dataset.type = field.type;
      box.dataset.primary = field.primary === false ? 'false' : 'true';
      const tag = box.querySelector('.field-box__tag');
      if (tag) tag.textContent = field.type;
    }
  }

  saveEditsToStorage();
  refreshDetectionSummary();
  populateSidebar({ fields: docState.fields, pageCount: maxPage(docState.fields) }, docState.filename);
  track('preview_field_edited', { fieldId, edit: JSON.stringify(edit) });
}

function maxPage(fields) {
  return fields.reduce((m, f) => Math.max(m, f.page || 1), 1);
}

function refreshDetectionSummary() {
  const primary = docState.fields.filter(f => f.primary !== false);
  const secondary = docState.fields.length - primary.length;
  const fieldWord = primary.length === 1 ? 'field' : 'fields';
  // Pill text just confirms readiness; the sidebar carries the precise
  // counts. The previous "X fields, Y more in body." was noisy and
  // misleading when the heuristic + manual adds + template applied.
  setStatus('done', 'Ready to sign.');
  renderFieldToggle(secondary);
}

// ---- Sender context menu ----------------------------------------------------

const TYPES_AVAILABLE = ['signature', 'date', 'initial', 'text', 'checkbox'];

function openContextMenu(field, anchorEl) {
  closeContextMenu();
  const menu = document.createElement('div');
  menu.className = 'field-menu';
  menu.id = 'field-menu';
  menu.setAttribute('role', 'menu');

  const heading = document.createElement('div');
  heading.className = 'field-menu__heading';
  heading.textContent = field.label ? `“${field.label}”` : 'Unlabeled field';
  menu.appendChild(heading);

  const typeRow = document.createElement('div');
  typeRow.className = 'field-menu__type-row';
  const typeLabel = document.createElement('span');
  typeLabel.className = 'field-menu__type-label';
  typeLabel.textContent = 'Type';
  typeRow.appendChild(typeLabel);
  for (const t of TYPES_AVAILABLE) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'field-menu__type-btn';
    btn.dataset.active = field.type === t ? 'true' : 'false';
    btn.textContent = t;
    btn.addEventListener('click', () => {
      applyFieldEdit(field.id, { type: t });
      closeContextMenu();
    });
    typeRow.appendChild(btn);
  }
  menu.appendChild(typeRow);

  const sep = document.createElement('div');
  sep.className = 'field-menu__sep';
  menu.appendChild(sep);

  // Promote / demote.
  const promoteBtn = document.createElement('button');
  promoteBtn.type = 'button';
  promoteBtn.className = 'field-menu__action';
  if (field.primary === false) {
    promoteBtn.textContent = 'Promote to primary signature block';
    promoteBtn.addEventListener('click', () => {
      applyFieldEdit(field.id, { primary: true });
      closeContextMenu();
    });
  } else {
    promoteBtn.textContent = 'Demote to body field';
    promoteBtn.addEventListener('click', () => {
      applyFieldEdit(field.id, { primary: false });
      closeContextMenu();
    });
  }
  menu.appendChild(promoteBtn);

  // Delete.
  const delBtn = document.createElement('button');
  delBtn.type = 'button';
  delBtn.className = 'field-menu__action field-menu__action--danger';
  delBtn.textContent = 'Remove this field';
  delBtn.addEventListener('click', () => {
    applyFieldEdit(field.id, { deleted: true });
    closeContextMenu();
  });
  menu.appendChild(delBtn);

  // Position. Try to anchor to the field box; clamp inside viewport.
  document.body.appendChild(menu);
  const rect = anchorEl.getBoundingClientRect();
  const menuRect = menu.getBoundingClientRect();
  let top = rect.bottom + 4 + window.scrollY;
  let left = rect.left + window.scrollX;
  // Clamp right edge.
  if (left + menuRect.width > window.innerWidth - 16) {
    left = window.innerWidth - menuRect.width - 16;
  }
  // If below the page, flip above.
  if (rect.bottom + menuRect.height > window.innerHeight - 8) {
    top = rect.top - menuRect.height - 4 + window.scrollY;
  }
  menu.style.top = `${Math.max(8, top)}px`;
  menu.style.left = `${Math.max(8, left)}px`;

  setTimeout(() => {
    document.addEventListener('click', closeOnOutsideClick, true);
    document.addEventListener('keydown', closeOnEsc, true);
  }, 0);
}

function closeContextMenu() {
  const existing = document.getElementById('field-menu');
  if (existing && existing.parentElement) {
    existing.parentElement.removeChild(existing);
  }
  document.removeEventListener('click', closeOnOutsideClick, true);
  document.removeEventListener('keydown', closeOnEsc, true);
}

function closeOnOutsideClick(e) {
  const menu = document.getElementById('field-menu');
  if (!menu) return;
  if (menu.contains(e.target)) return;
  closeContextMenu();
}

function closeOnEsc(e) {
  if (e.key === 'Escape') closeContextMenu();
}

fillStore.onChange(updateFillUI);
signers.onChange(updateSignersUI);
assignments.onChange(updateAssignmentUI);
signingAs.onChange(updateSigningAsUI);

addSignerBtn.addEventListener('click', onAddSigner);
signingAsSelect.addEventListener('change', async () => {
  const newId = signingAsSelect.value;
  const oldId = signingAs.get();
  // In-person mode: when switching to a different signer, show the
  // pass-the-device handoff so the new person knows to pick up the iPad.
  if (docState.mode === 'in-person' && newId && newId !== oldId) {
    const newSigner = signers.get().find(s => s.id === newId);
    const list = signers.get();
    const remainingCount = list.filter(s => {
      const owned = list.indexOf(s) >= list.findIndex(x => x.id === newId);
      return owned;
    }).length;
    if (newSigner) {
      await showHandoff({ nextSignerName: newSigner.name || 'Next signer', remainingCount });
    }
  }
  signingAs.set(newId);
});

// ---- Wire UI ---------------------------------------------------------------

fileInput.addEventListener('change', e => {
  const files = Array.from(e.target.files || []);
  if (files.length) handleFiles(files);
});

const cameraInput = $('camera-input');
if (cameraInput) {
  cameraInput.addEventListener('change', e => {
    const files = Array.from(e.target.files || []);
    if (files.length) handleFiles(files);
  });
}

resetButton.addEventListener('click', resetApp);

signButton.addEventListener('click', onSignClick);

// Sticky add-field mode. Click one of the 5 type buttons to enter
// add-mode pinned to that type. While active, every click on a page
// drops a new field of that type and STAYS in add-mode for the next
// click — Photoshop brush behavior. Click the same type button again
// to exit, click a different type button to switch, or press Esc.
const AI_CONSENT_KEY = 'cybersygn.aiTrainingConsent';
let _addModeType = null;   // 'signature' | 'initial' | 'date' | 'checkbox' | 'text' | null

function setAddType(type) {
  _addModeType = type;
  document.body.dataset.addMode = type ? 'true' : 'false';
  document.body.dataset.addModeType = type || '';

  addFieldButtons.forEach(btn => {
    btn.dataset.active = btn.dataset.addType === type ? 'true' : 'false';
  });

  if (addFieldHint) {
    if (type) {
      const plural = type === 'checkbox' ? 'checkboxes' : `${type}s`;
      addFieldHint.textContent = `Adding ${plural}. Click anywhere on the page. Press Esc to stop.`;
    } else {
      addFieldHint.textContent = '';
    }
  }
}

addFieldButtons.forEach(btn => {
  btn.addEventListener('click', () => {
    const t = btn.dataset.addType;
    setAddType(_addModeType === t ? null : t);
  });
});

// Esc exits add-mode entirely.
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && _addModeType) setAddType(null);
});

// Page click handler: while in add-mode, drop a field of the pinned type
// and KEEP add-mode active for the next click. Delegated on documentStrip
// so it works for every rendered page.
documentStrip.addEventListener('click', (e) => {
  if (!_addModeType) return;
  const shell = e.target.closest('.page-shell');
  if (!shell) return;
  if (e.target.closest('.field-box')) return;  // click landed on an existing box
  const overlay = shell.querySelector('.overlay');
  if (!overlay) return;

  const rect = overlay.getBoundingClientRect();
  const cssX = e.clientX - rect.left;
  const cssY = e.clientY - rect.top;

  const pageNum = parseInt(shell.dataset.pageNum || '1', 10);
  const vpH = parseFloat(shell.dataset.viewportHeight);
  const scaleFactor = parseFloat(shell.dataset.scale) || RENDER_SCALE;
  if (!Number.isFinite(vpH)) return;

  // Default box size depends on type. Checkboxes are squares; everything
  // else is a wide rectangle sized to typical signature-line dimensions.
  const isCheckbox = _addModeType === 'checkbox';
  const W = isCheckbox ? 22 : 180;
  const H = isCheckbox ? 22 : 28;
  // Center the box on the click for checkboxes (small), left-anchor for
  // wider fields (so the start of the line tracks the click).
  const anchorX = isCheckbox ? cssX - W / 2 : cssX;
  const anchorY = isCheckbox ? cssY - H / 2 : cssY;

  const pdfX = anchorX / scaleFactor;
  const pdfY = (rect.height - anchorY - H) / scaleFactor;
  const pdfW = W / scaleFactor;
  const pdfH = H / scaleFactor;

  const newField = {
    type: _addModeType,
    label: '',
    page: pageNum,
    x: pdfX,
    y: pdfY,
    width: pdfW,
    height: pdfH,
    confidence: 1.0,
    source: 'user-added',
    primary: true,
  };
  newField.id = idFor(newField);
  docState.fields = [...docState.fields, newField];

  // CRITICAL: persist this manually-added field to senderEdits so the
  // next upload of the same PDF (same docId) restores it. Without this,
  // every reload starts from heuristic detection only and the user's
  // manual additions disappear. The 'added: true' flag distinguishes
  // a brand-new field from an overlay on an existing detected field.
  senderEdits.set(newField.id, {
    added: true,
    type: newField.type,
    page: newField.page,
    x: newField.x,
    y: newField.y,
    width: newField.width,
    height: newField.height,
    label: newField.label || '',
    primary: true,
    source: 'user-added',
    history: [{ at: new Date().toISOString(), change: { added: true } }],
  });
  saveEditsToStorage();

  const box = document.createElement('div');
  box.className = 'field-box';
  box.dataset.type = newField.type;
  box.dataset.fieldId = newField.id;
  box.dataset.primary = 'true';
  box.dataset.confidence = '100';
  box.style.left = `${anchorX}px`;
  box.style.top  = `${anchorY}px`;
  box.style.width  = `${W}px`;
  box.style.height = `${H}px`;
  const tag = document.createElement('span');
  tag.className = 'field-box__tag';
  tag.textContent = newField.type;
  box.appendChild(tag);
  overlay.appendChild(box);
  fieldElements.set(newField.id, box);
  attachDragResize(box, newField, shell);

  populateSidebar(
    { fields: docState.fields, pageCount: Math.max(...docState.fields.map(f => f.page)) },
    docState.filename || ''
  );
  track('preview_field_added_manually', { page: pageNum, type: newField.type });

  // Nudge toward saving a template once the user has invested real
  // labeling work (8+ manual adds in this session, only prompt once
  // per document load).
  _manualAddsThisSession = (_manualAddsThisSession || 0) + 1;
  if (_manualAddsThisSession === 8 && !_templateNudgeShown) {
    _templateNudgeShown = true;
    showToast(
      'You\'ve added 8 fields manually. Save as a template so the next ' +
      'upload of this exact PDF auto-loads them. Click "Save this ' +
      'document\'s fields as a template" in the sidebar.'
    );
  }
  // Stay in add-mode for the next click.
});

// Per-session counters for the auto-save-template nudge. Reset in
// resetApp so a fresh document gets a fresh count.
let _manualAddsThisSession = 0;
let _templateNudgeShown = false;

/**
 * Show a small popover chooser anchored near the click. Resolves with
 * the chosen field type ('signature' | 'initial' | 'date' | 'checkbox'
 * | 'text') or null if cancelled. Dismisses on outside-click or Esc.
 */
function promptAddFieldType(clientX, clientY) {
  return new Promise(resolve => {
    const TYPES = [
      { id: 'signature', label: 'Signature' },
      { id: 'initial',   label: 'Initial' },
      { id: 'date',      label: 'Date' },
      { id: 'checkbox',  label: 'Checkbox' },
      { id: 'text',      label: 'Text' },
    ];
    const wrap = document.createElement('div');
    wrap.className = 'add-type-chooser';
    const hint = document.createElement('p');
    hint.className = 'add-type-chooser__hint';
    hint.textContent = 'What kind of field?';
    wrap.appendChild(hint);
    TYPES.forEach(t => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'add-type-chooser__btn';
      btn.textContent = t.label;
      btn.addEventListener('click', () => { cleanup(); resolve(t.id); });
      wrap.appendChild(btn);
    });

    // Position near the click, clamped to viewport.
    document.body.appendChild(wrap);
    const r = wrap.getBoundingClientRect();
    const pad = 8;
    const maxLeft = window.innerWidth - r.width - pad;
    const maxTop  = window.innerHeight - r.height - pad;
    wrap.style.left = Math.min(maxLeft, Math.max(pad, clientX)) + 'px';
    wrap.style.top  = Math.min(maxTop,  Math.max(pad, clientY)) + 'px';

    function onOutside(e) { if (!wrap.contains(e.target)) { cleanup(); resolve(null); } }
    function onKey(e)     { if (e.key === 'Escape') { cleanup(); resolve(null); } }
    function cleanup() {
      document.removeEventListener('mousedown', onOutside, true);
      document.removeEventListener('keydown', onKey, true);
      wrap.remove();
    }
    setTimeout(() => {
      document.addEventListener('mousedown', onOutside, true);
      document.addEventListener('keydown', onKey, true);
    }, 0);
  });
}

// Save-template button: persists the current field set as a template
// indexed by the document's SHA-256 hash. Next upload of the exact same
// PDF (by anyone, if AI consent is on; otherwise by this sender) starts
// from these labels instead of re-running heuristic detection.
if (saveTemplateButton) {
  saveTemplateButton.addEventListener('click', async () => {
    if (!docState.docId) {
      showToast('Cannot save: no document loaded.');
      return;
    }
    if (!Array.isArray(docState.fields) || docState.fields.length === 0) {
      showToast('Cannot save: no fields detected or added.');
      return;
    }
    const consent = (() => {
      try { return localStorage.getItem(AI_CONSENT_KEY) === '1'; }
      catch (e) { return false; }
    })();
    const scope = consent ? 'public' : 'private';

    saveTemplateButton.disabled = true;
    const originalText = saveTemplateButton.textContent;
    saveTemplateButton.textContent = 'Saving template.';
    try {
      // Strip filled-in values; templates carry POSITIONS only.
      const fieldsToSave = docState.fields.map(f => ({
        type: f.type,
        page: f.page,
        x: f.x,
        y: f.y,
        width: f.width,
        height: f.height,
        label: f.label || '',
        primary: f.primary !== false,
        source: f.source || 'user-saved',
      }));
      const res = await fetch('/api/templates', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          docId: docState.docId,
          senderId: getSenderId(),
          fields: fieldsToSave,
          scope,
          consent,
        }),
      });
      const data = await res.json();
      if (!res.ok || !data.ok) {
        showToast(`Could not save template: ${data && data.error ? data.error : 'unknown error'}`);
        return;
      }
      const scopeLabel = data.scope === 'public'
        ? 'Saved publicly. Every future upload of this exact PDF (by you or anyone) auto-loads these labels.'
        : 'Saved privately. Your future uploads of this exact PDF auto-load these labels. Toggle AI training consent on the upload page to share publicly.';
      showToast(`Template saved (${data.fieldCount} fields). ${scopeLabel}`);
      track('template_saved', { scope: data.scope, fieldCount: data.fieldCount });
    } catch (err) {
      report(err, 'save_template');
      showToast(`Could not save template: ${err.message || err}`);
    } finally {
      saveTemplateButton.disabled = false;
      saveTemplateButton.textContent = originalText;
    }
  });
}

// AI training consent: persist the user's choice across sessions.
// Default is OFF (privacy by default). The current build does not
// actually send anything; the value is read by the create-doc payload
// path so the worker can record consent alongside the document.
if (aiConsentCheckbox) {
  try {
    const saved = localStorage.getItem(AI_CONSENT_KEY);
    aiConsentCheckbox.checked = saved === '1';
  } catch (e) {}
  aiConsentCheckbox.addEventListener('change', () => {
    try { localStorage.setItem(AI_CONSENT_KEY, aiConsentCheckbox.checked ? '1' : '0'); } catch (e) {}
    track('ai_training_consent_toggled', { value: aiConsentCheckbox.checked });
  });
}

// Drag-drop on the whole page so the user does not have to aim.
['dragenter', 'dragover'].forEach(name => {
  window.addEventListener(name, e => {
    e.preventDefault();
    dropzone.classList.add('is-dragging');
  });
});
['dragleave', 'drop'].forEach(name => {
  window.addEventListener(name, e => {
    e.preventDefault();
    if (name === 'dragleave' && e.target !== document.documentElement) return;
    dropzone.classList.remove('is-dragging');
  });
});
window.addEventListener('drop', e => {
  e.preventDefault();
  const files = Array.from(e.dataTransfer && e.dataTransfer.files || []);
  if (files.length) handleFiles(files);
});

// ---- Multi-source upload ---------------------------------------------------

/**
 * Accept any combination of PDFs and images. A single PDF flows straight
 * through. Multiple PDFs concatenate into one. One or more images get
 * composited into a synthetic PDF before detection. Mixed PDF+images is
 * treated as an error rather than guessed at.
 */
async function handleFiles(files) {
  hideError();

  const pdfs = files.filter(f => /\.pdf$/i.test(f.name) || f.type === 'application/pdf');
  const images = files.filter(f => f.type && f.type.startsWith('image/'));
  // .docx is recognized by extension or by the official OOXML wordprocessing
  // MIME type. We do not accept legacy .doc (Word 97 binary format) here:
  // mammoth cannot read it, and converting it would silently produce empty
  // PDFs rather than a useful error.
  const docxs = files.filter(f =>
    /\.docx$/i.test(f.name) ||
    f.type === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
  const unknown = files.filter(f =>
    !pdfs.includes(f) && !images.includes(f) && !docxs.includes(f));

  if (unknown.length > 0) {
    // Flag legacy .doc explicitly so the user knows why it was rejected.
    const hasLegacyDoc = unknown.some(f => /\.doc$/i.test(f.name));
    if (hasLegacyDoc) {
      showError('Word 97 ".doc" files are not supported. Save your document as .docx in Word, or print it to PDF first.');
    } else {
      showError('CyberSygn accepts PDFs, Word documents, and images. Try selecting just those.');
    }
    return;
  }
  // Mixed-type uploads are still rejected: we want one document per
  // session and the merge/convert paths can't sensibly compose across
  // formats.
  const buckets = [pdfs.length > 0, images.length > 0, docxs.length > 0].filter(Boolean).length;
  if (buckets > 1) {
    showError('Pick one type at a time: PDFs, a Word document, or images. Not a mix.');
    return;
  }
  if (pdfs.length === 0 && images.length === 0 && docxs.length === 0) {
    showError('No files to read.');
    return;
  }
  if (docxs.length > 1) {
    showError('Upload one Word document at a time.');
    return;
  }

  try {
    let file;
    if (pdfs.length === 1) {
      file = pdfs[0];
    } else if (pdfs.length > 1) {
      setStatus('busy', 'Merging PDFs.');
      file = await mergePdfsIntoFile(pdfs);
    } else if (docxs.length === 1) {
      setStatus('busy', 'Converting Word document.');
      file = await docxToPdf(docxs[0]);
    } else {
      // images.length >= 1
      setStatus('busy', images.length === 1 ? 'Converting image to PDF.' : `Composing ${images.length} pages.`);
      file = await imagesToPdfFile(images);
    }
    await handleFile(file);
  } catch (err) {
    report(err, 'multi-source-upload');
    showError('We could not assemble that into a PDF. Try again or pick a different file.');
    setStatus('error', 'Upload failed.');
  }
}

/**
 * Convert a .docx File into a PDF File via the docx-to-pdf module.
 * Lazy-loaded so users uploading PDFs (the majority path) pay zero
 * bytes for mammoth.
 */
async function docxToPdf(docxFile) {
  const mod = await import('./docx-to-pdf.js');
  return await mod.docxToPdfFile(docxFile);
}

async function imagesToPdfFile(imageFiles) {
  const { PDFDocument } = await import('../vendor/pdf-lib.mjs');
  const pdf = await PDFDocument.create();
  for (const f of imageFiles) {
    const bytes = new Uint8Array(await f.arrayBuffer());
    let img;
    if (/png$/i.test(f.type) || /\.png$/i.test(f.name)) {
      img = await pdf.embedPng(bytes);
    } else {
      // pdf-lib accepts PNG and JPG; coerce other types via canvas.
      if (/jpe?g$/i.test(f.type) || /\.jpe?g$/i.test(f.name)) {
        img = await pdf.embedJpg(bytes);
      } else {
        const coerced = await coerceImageToJpegBytes(f);
        img = await pdf.embedJpg(coerced);
      }
    }
    // Fit on a letter-size page with a small margin, preserving aspect ratio.
    const pageW = 612;  // 8.5 in * 72
    const pageH = 792;  // 11 in * 72
    const margin = 36;
    const maxW = pageW - margin * 2;
    const maxH = pageH - margin * 2;
    const ratio = Math.min(maxW / img.width, maxH / img.height);
    const w = img.width * ratio;
    const h = img.height * ratio;
    const x = (pageW - w) / 2;
    const y = (pageH - h) / 2;
    const page = pdf.addPage([pageW, pageH]);
    page.drawImage(img, { x, y, width: w, height: h });
  }
  const pdfBytes = await pdf.save();
  const filename = imageFiles.length === 1
    ? imageFiles[0].name.replace(/\.[^.]+$/, '') + '.pdf'
    : `scan-${new Date().toISOString().slice(0, 10)}.pdf`;
  return new File([pdfBytes], filename, { type: 'application/pdf' });
}

async function coerceImageToJpegBytes(file) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => {
      try {
        const canvas = document.createElement('canvas');
        canvas.width = img.naturalWidth;
        canvas.height = img.naturalHeight;
        const ctx = canvas.getContext('2d');
        ctx.fillStyle = '#fff';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.drawImage(img, 0, 0);
        canvas.toBlob(async (blob) => {
          if (!blob) { reject(new Error('canvas conversion failed')); return; }
          const buf = await blob.arrayBuffer();
          resolve(new Uint8Array(buf));
        }, 'image/jpeg', 0.92);
      } finally {
        URL.revokeObjectURL(url);
      }
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('image load failed')); };
    img.src = url;
  });
}

async function mergePdfsIntoFile(pdfFiles) {
  const { PDFDocument } = await import('../vendor/pdf-lib.mjs');
  const merged = await PDFDocument.create();
  for (const f of pdfFiles) {
    const bytes = new Uint8Array(await f.arrayBuffer());
    const src = await PDFDocument.load(bytes);
    const indices = src.getPageIndices();
    const pages = await merged.copyPages(src, indices);
    for (const p of pages) merged.addPage(p);
  }
  const out = await merged.save();
  return new File([out], `merged-${new Date().toISOString().slice(0, 10)}.pdf`, { type: 'application/pdf' });
}

// ---- Main flow -------------------------------------------------------------

async function handleFile(file) {
  hideError();

  if (!/\.pdf$/i.test(file.name) && file.type !== 'application/pdf') {
    showError('That file is not a PDF. CyberSygn only reads PDFs.');
    return;
  }
  if (file.size > MAX_BYTES) {
    showError(`That PDF is ${formatBytes(file.size)}. The 25 MB ceiling keeps preview fast.`);
    return;
  }

  setStatus('busy', 'Reading PDF.');
  filenameEl.textContent = file.name;

  // The pdf.js worker TRANSFERS (detaches) any ArrayBuffer it receives.
  // detectFields, renderDocument, and the signing flatten step all call
  // pdf.js or pdf-lib, each of which detaches its input. We therefore
  // hold a single canonical copy in docState.originalBytes and pass a
  // fresh per-call slice into every consumer. Without this, a TypeError
  // ("Cannot perform Construct on a detached or out-of-bounds
  // ArrayBuffer") fires the second time the same Uint8Array is read.
  let data;
  try {
    const buf = await file.arrayBuffer();
    data = new Uint8Array(buf);
  } catch (err) {
    showError('We could not read that file. Try selecting it again.');
    setStatus('error', 'Read failed.');
    return;
  }

  // Detection. Pass a fresh copy so the underlying buffer detachment by
  // pdf.js stays scoped to this call.
  setStatus('busy', 'Finding fields.');
  let detection;
  try {
    detection = await detectFields(freshCopy(data));
  } catch (err) {
    report(err, 'detection');
    showError('We could not parse that PDF. It may be encrypted or malformed.');
    setStatus('error', 'Parse failed.');
    return;
  }

  // Assign a stable id to each field so the fill store can address them.
  for (const f of detection.fields) f.id = idFor(f);

  // Stash for the signing flatten step.
  docState.filename = file.name;
  docState.originalBytes = data;
  docState.fields = detection.fields;
  fillStore.clear();

  // Compute a stable per-document id (SHA-256 of original bytes) and
  // rehydrate any previously-saved sender edits for this exact PDF.
  // Then re-apply them on top of the fresh detection result so the
  // user picks up where they left off.
  senderEdits.clear();
  try {
    docState.docId = await sha256Hex(data);
    loadEditsFromStorage(docState.docId);
    if (senderEdits.size > 0) {
      docState.fields = applyStoredEditsToFields(docState.fields);
      detection.fields = docState.fields;  // keep downstream paths consistent
    }
  } catch (e) {
    console.warn('[cybersygn:edits] could not compute docId', e);
    docState.docId = null;
  }

  // Document template lookup. If anyone previously saved labels for a
  // PDF with this exact SHA-256, those labels become the starting point
  // (replacing the heuristic detection) — the saved set is human-
  // verified and therefore strictly better. Heuristic fields the
  // template doesn't cover are kept; template fields the heuristic
  // missed are added.
  let templateHit = false;
  let restoredEditsCount = 0;
  if (docState.docId) {
    try {
      const senderId = getSenderId();
      const lookupRes = await fetch(`/api/templates?docId=${encodeURIComponent(docState.docId)}&senderId=${encodeURIComponent(senderId)}`);
      if (lookupRes.ok) {
        const lookup = await lookupRes.json();
        if (lookup.ok && lookup.template && Array.isArray(lookup.template.fields) && lookup.template.fields.length > 0) {
          const templateFields = lookup.template.fields.map(f => ({
            ...f,
            id: f.id || idFor(f),
          }));
          docState.fields = templateFields;
          detection.fields = docState.fields;
          if (senderEdits.size > 0) {
            docState.fields = applyStoredEditsToFields(docState.fields);
            detection.fields = docState.fields;
          }
          templateHit = true;
          setTemplateState(
            lookup.scope === 'public' ? 'applied-public' : 'applied-private',
            templateFields.length,
          );
          track('template_applied', {
            scope: lookup.scope,
            fieldCount: templateFields.length,
            savedCount: (lookup.template.stats && lookup.template.stats.savedCount) || 1,
          });
        }
      }
    } catch (e) {
      report(e, 'template_lookup');
    }
  }
  // If no template was found, count how many manual-add edits were
  // restored from senderEdits earlier in the upload flow so the
  // sidebar badge tells the truth instead of going silent.
  if (!templateHit) {
    if (senderEdits.size > 0) {
      for (const [, overlay] of senderEdits.entries()) {
        if (overlay && overlay.added && !overlay.deleted) restoredEditsCount++;
      }
    }
    if (restoredEditsCount > 0) {
      setTemplateState('restored-edits', restoredEditsCount);
    } else {
      setTemplateState('none');
    }
  }

  // Reset signer state and seed a single default signer (the sender).
  // Name is empty so the input ships with its "Your name" placeholder
  // and the avatar shows an em-dash instead of duplicating "You" + "YO".
  signers.reset();
  assignments.reset();
  const sender = signers.add({ name: '', email: '' });
  assignments.setDefault(sender.id);
  signingAs.set(sender.id);

  // Ask the sender how they want to use this document: sign together now
  // on this device (the iPad pass-around pattern), or send for signing.
  // Choice is recorded in docState.mode and used when the sender finally
  // submits to the Worker.
  if (!docState.mode) {
    docState.mode = await openModePicker({ fields: detection.fields.length, pages: detection.pageCount });
  }
  document.body.dataset.inPerson = docState.mode === 'in-person' ? 'true' : 'false';

  setStatus('busy', 'Rendering pages.');
  showResultLayout();
  let renderErr = null;
  try {
    // Fresh per-call copy: pdf.js's worker detaches the buffer, so re-using
    // `data` directly would TypeError on the second pass below.
    await renderDocument(freshCopy(data), detection);
  } catch (err) {
    renderErr = err;
    report(err, 'render:first-pass');
    // Second pass with conservative settings: drop @font-face, drop system
    // fonts. Handles PDFs whose embedded font subset has a malformed glyph
    // table. Needs another fresh copy because pass one detached its own.
    try {
      await renderDocument(freshCopy(data), detection, { conservative: true });
      renderErr = null; // recovered
    } catch (err2) {
      report(err2, 'render:second-pass');
      renderErr = err2;
    }
  }
  if (renderErr) {
    const cls = (renderErr && renderErr.constructor && renderErr.constructor.name) || 'Error';
    const msg = (renderErr && renderErr.message) ? String(renderErr.message).slice(0, 200) : String(renderErr);
    showError(`Render failed (${cls}). The detection results below are still accurate and signing still works. Cause: ${msg}`);
    populateSidebar(detection, file.name);
    setStatus('error', 'Render failed.');
    return;
  }

  populateSidebar(detection, file.name);
  updateFillUI(); // sync button text and any pre-existing fill state
  const primary = detection.fields.filter(f => f.primary !== false);
  const secondary = detection.fields.length - primary.length;
  const fieldWord = primary.length === 1 ? 'field' : 'fields';
  // Pill text just confirms readiness; the sidebar carries the precise
  // counts. The previous "X fields, Y more in body." was noisy and
  // misleading when the heuristic + manual adds + template applied.
  setStatus('done', 'Ready to sign.');
  renderFieldToggle(secondary);
  track('preview_detection_completed', {
    pages: detection.pageCount,
    fields: detection.fields.length,
    primary: primary.length,
    secondary,
    bytes: file.size,
  });
}

/**
 * Add or remove the "Show all fields" toggle in the preview toolbar.
 * Pass 6 in detect.js classifies detected fields as primary (the
 * dedicated signature block at the end of the document) or secondary
 * (body inline fill-ins like __________ lines mid-paragraph). The user
 * sees primary fields by default. The toggle reveals the rest.
 */
// Default starting floor (percent). Most secondary body fields have
// confidence 0.45-0.55 and most primary signature-block fields have
// confidence >= 0.78, so 65 hides the body without touching the block.
// Show every detected field by default. The slider stays in place for
// users who want to hide low-confidence noise, but the default reveals
// all 71-ish fields a typical contract has rather than only the ~10
// primary signature-block fields. The user can double-click any box
// they don't want to remove it.
const DEFAULT_CONFIDENCE_FLOOR = 0;

function currentConfidenceFloor() {
  const raw = document.body.dataset.confidenceFloor;
  const n = parseInt(raw, 10);
  if (Number.isFinite(n) && n >= 0 && n <= 100) return n;
  return DEFAULT_CONFIDENCE_FLOOR;
}

function applyConfidenceFloorToBox(box, floor) {
  // Primary fields are exempt. The signature block stays visible
  // regardless of confidence so the sender never loses it.
  if (box.dataset.primary === 'true') {
    box.dataset.hidden = 'false';
    return;
  }
  const conf = parseInt(box.dataset.confidence || '0', 10);
  box.dataset.hidden = conf < floor ? 'true' : 'false';
}

function applyConfidenceFloorToAll(floor) {
  document.body.dataset.confidenceFloor = String(floor);
  for (const box of fieldElements.values()) {
    applyConfidenceFloorToBox(box, floor);
  }
}

/**
 * Render the confidence-threshold slider into the preview toolbar.
 * Replaces the prior binary primary/secondary toggle. The slider runs
 * from 40% to 95% in 5% increments. Lowering the floor reveals more
 * detected fields; raising it filters out low-confidence noise.
 *
 * Primary fields (the signature block from Pass 6) are exempt from the
 * filter and always visible, so the slider's effect is strictly on
 * body inline fill-ins and other low-confidence detections.
 *
 * Hidden when there are no secondary fields to hide.
 */
function renderFieldToggle(secondaryCount) {
  const host = document.querySelector('.preview-status') || document.querySelector('.preview-toolbar');
  if (!host) return;

  let widget = document.getElementById('field-slider');
  if (secondaryCount === 0) {
    if (widget) widget.remove();
    // No secondary fields means nothing to hide. Reset so any newly
    // detected secondary fields on a future doc start visible.
    document.body.dataset.confidenceFloor = String(DEFAULT_CONFIDENCE_FLOOR);
    return;
  }

  if (!widget) {
    widget = document.createElement('div');
    widget.id = 'field-slider';
    widget.className = 'field-slider';

    const label = document.createElement('label');
    label.className = 'field-slider__label';
    label.htmlFor = 'field-slider-input';
    label.textContent = 'Show fields above';

    const input = document.createElement('input');
    input.type = 'range';
    input.id = 'field-slider-input';
    input.className = 'field-slider__input';
    input.min = '40';
    input.max = '95';
    input.step = '5';
    input.value = String(currentConfidenceFloor());

    const readout = document.createElement('span');
    readout.className = 'field-slider__readout';
    readout.textContent = `${input.value}% confidence`;

    const count = document.createElement('span');
    count.className = 'field-slider__count';

    input.addEventListener('input', () => {
      const floor = parseInt(input.value, 10);
      readout.textContent = `${floor}% confidence`;
      applyConfidenceFloorToAll(floor);
      updateSliderCount(count);
      track('preview_confidence_floor', { floor });
    });

    widget.appendChild(label);
    widget.appendChild(input);
    widget.appendChild(readout);
    widget.appendChild(count);
    host.appendChild(widget);
  }

  // Apply the floor (default or whatever the slider last sat at) and
  // refresh the visible/hidden tally.
  applyConfidenceFloorToAll(currentConfidenceFloor());
  const count = widget.querySelector('.field-slider__count');
  if (count) updateSliderCount(count);
}

function updateSliderCount(countEl) {
  let visible = 0, hidden = 0;
  for (const box of fieldElements.values()) {
    if (box.dataset.hidden === 'true') hidden++;
    else visible++;
  }
  countEl.textContent = hidden > 0
    ? `${visible} shown, ${hidden} below cutoff`
    : `${visible} shown`;
}

// ---- Rendering -------------------------------------------------------------

async function renderDocument(data, detection, opts = {}) {
  documentStrip.innerHTML = '';
  fieldElements.clear();

  // pdfjs requires a fresh Uint8Array because detectFields consumes the buffer.
  const renderData = new Uint8Array(data);
  // Two render modes:
  //   default: allow @font-face + system fonts, cmaps active. Handles macOS
  //     PDFs with embedded Hiragino (common) by providing the CMap files
  //     pdf.js needs to translate CIDs to Unicode glyphs.
  //   conservative (opts.conservative): used as a second pass when the
  //     default fails. Drops @font-face entirely and uses a coarser DPI.
  //     Slower and less visually faithful but renders successfully on
  //     pathological PDFs where the embedded font subset has a malformed
  //     glyph table or where cmap fetch fails (offline / 503 / etc).
  const conservative = opts.conservative === true;
  const doc = await pdfjsLib.getDocument({
    data: renderData,
    isEvalSupported: false,
    useSystemFonts: !conservative,
    disableFontFace: conservative,
    disableAutoFetch: true,
    disableStream: true,
    cMapUrl: '/vendor/cmaps/',
    cMapPacked: true,
    standardFontDataUrl: '/vendor/standard_fonts/',
  }).promise;

  // Per-page staggered "detection reveal": each field box pops in
  // sequentially via CSS keyframe animation with an index-based delay.
  // The stagger restarts on each page so the visual rhythm follows the
  // page-by-page render (page lands, then its fields are "discovered"
  // one at a time). Reduced-motion users skip the animation entirely
  // (the rule below the keyframe handles that).
  const REVEAL_TOTAL_PER_PAGE_MS = 700;
  const PER_STEP_CAP_MS = 80;

  // Per-page resilience: if one page fails to render (font issue, image
  // decode failure, malformed content stream), surface a placeholder and
  // keep going so the user sees the rest of the document plus all detected
  // field boxes. The previous all-or-nothing behavior surfaced a generic
  // "failed to render" toast even when 99% of the document was fine.
  const pageErrors = [];
  for (let pageNum = 1; pageNum <= doc.numPages; pageNum++) {
    try {
      const page = await doc.getPage(pageNum);
      const viewport = page.getViewport({ scale: RENDER_SCALE });

      // Cap canvas to a sane device pixel ratio so very large pages do not
      // blow up memory on retina displays.
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const canvas = document.createElement('canvas');
      canvas.width = Math.round(viewport.width * dpr);
      canvas.height = Math.round(viewport.height * dpr);
      canvas.style.width = `${Math.round(viewport.width)}px`;
      canvas.style.height = `${Math.round(viewport.height)}px`;

      const ctx = canvas.getContext('2d');
      ctx.scale(dpr, dpr);

      const shell = document.createElement('div');
      shell.className = 'page-shell';
      shell.style.width = `${Math.round(viewport.width)}px`;

      const indexLabel = document.createElement('span');
      indexLabel.className = 'page-shell__index';
      indexLabel.textContent = `Page ${pageNum} of ${doc.numPages}.`;
      shell.appendChild(indexLabel);

      shell.appendChild(canvas);

      const overlay = document.createElement('div');
      overlay.className = 'overlay';
      shell.appendChild(overlay);

      // Stash viewport metadata on the shell DOM so the manual
      // "Add a field" path can convert click coordinates back to PDF
      // space without holding onto the pdfjs page object.
      shell.dataset.pageNum = String(pageNum);
      shell.dataset.viewportWidth = String(viewport.width);
      shell.dataset.viewportHeight = String(viewport.height);
      shell.dataset.scale = String(RENDER_SCALE);

      documentStrip.appendChild(shell);

      await page.render({ canvasContext: ctx, viewport }).promise;

      // Phase 2a pixel-based CV. DISABLED by default (overfires).
      // Owner can opt-in via localStorage.cybersygn.cvEnabled = '1'.
      try {
        const cvEnabled = (() => {
          try { return localStorage.getItem('cybersygn.cvEnabled') === '1'; }
          catch (e) { return false; }
        })();
        if (cvEnabled) {
          const cvFields = cvDetect.detectVisually(canvas, {
            width: viewport.width,
            height: viewport.height,
            scale: RENDER_SCALE,
          }, pageNum);
          if (cvFields.length > 0) {
            docState.fields = cvDetect.mergeWithHeuristic(docState.fields, cvFields);
            detection.fields = docState.fields;
          }
        }
      } catch (e) {
        report(e, `cv-detect:page-${pageNum}`);
      }

      // Phase 2b: LLM vision detection via /api/detect-vision (Claude).
      // Opt-in this slice via localStorage.cybersygn.visionEnabled = '1'.
      // Escalation logic (auto-trigger on low-detection pages) is slice 32.
      // Runs AFTER pixel-walk merge so any heuristic + cv-line fields are
      // already in docState.fields and the vision merge can de-duplicate.
      try {
        const visionEnabled = (() => {
          try { return localStorage.getItem('cybersygn.visionEnabled') === '1'; }
          catch (e) { return false; }
        })();
        if (visionEnabled) {
          const visionFields = await callVisionDetection(canvas, viewport, pageNum);
          if (Array.isArray(visionFields) && visionFields.length > 0) {
            // Convert vision pixel coords (top-left origin) to PDF coords
            // (bottom-left). Same math as field-box drag-resize commit.
            const scale = RENDER_SCALE;
            const dpr = Math.min(window.devicePixelRatio || 1, 2);
            const ks = scale * dpr;
            const pdfFields = visionFields.map(vf => {
              const id = `vision-${pageNum}-${Math.round(vf.x)}-${Math.round(vf.y)}-${vf.type}`;
              const cx = vf.x / ks;
              const cy = vf.y / ks;
              const cw = vf.width  / ks;
              const ch = vf.height / ks;
              return {
                id,
                type: vf.type,
                page: pageNum,
                x: cx,
                y: (viewport.height - cy - ch),
                width: cw,
                height: ch,
                confidence: vf.confidence,
                label: vf.label || '',
                source: 'vision',
                primary: vf.confidence >= 0.70,
              };
            });
            docState.fields = cvDetect.mergeWithHeuristic(docState.fields, pdfFields);
            detection.fields = docState.fields;
            track('vision_fields_added', { page: pageNum, added: pdfFields.length });
          }
        }
      } catch (e) {
        report(e, `vision-detect:page-${pageNum}`);
      }

      // Draw field boxes for this page, staggered so they "discover"
      // one at a time. Per-page step caps at 80ms and total stagger
      // for any single page caps at 700ms. After the CV merge above,
      // pageFields includes both heuristic and CV-detected entries.
      const pageFields = docState.fields.filter(f => f.page === pageNum);
      const pageStepMs = pageFields.length > 0
        ? Math.min(PER_STEP_CAP_MS, Math.floor(REVEAL_TOTAL_PER_PAGE_MS / Math.max(1, pageFields.length)))
        : 0;
      pageFields.forEach((field, i) => {
        drawFieldBox(overlay, field, viewport, pageNum, i, pageStepMs);
      });
    } catch (err) {
      // One page failed; record and continue. The user sees a placeholder
      // for this page with the detected fields list still accurate.
      pageErrors.push({ pageNum, message: err && err.message ? err.message : String(err) });
      report(err, `render:page-${pageNum}`);

      const placeholder = document.createElement('div');
      placeholder.className = 'page-shell page-shell--error';
      placeholder.innerHTML = `
        <span class="page-shell__index">Page ${pageNum} of ${doc.numPages}. Render failed.</span>
        <div class="page-shell__error-body">
          <p>This page would not render in your browser. Detection results for this page are still listed in the side panel and the page is still part of the signed PDF.</p>
          <p class="caption">Reason: ${(err && err.message ? err.message : 'unknown')}</p>
        </div>
      `;
      documentStrip.appendChild(placeholder);
    }
  }

  if (pageErrors.length === doc.numPages) {
    // Every page failed: throw so the outer handler shows a real error.
    throw new Error(`All ${doc.numPages} pages failed to render. Last error: ${pageErrors[pageErrors.length - 1].message}`);
  }
}

/**
 * Convert a detected field (PDF coords, origin bottom-left) into a box
 * positioned over the rendered canvas (CSS coords, origin top-left).
 *
 * Uses pdf.js's viewport.convertToViewportRectangle so we do not have to
 * track viewBox math ourselves.
 */
function drawFieldBox(overlay, field, viewport, pageNum, revealIndex = 0, stepMs = 0) {
  const x1 = field.x;
  const y1 = field.y;
  const x2 = field.x + field.width;
  const y2 = field.y + field.height;
  const rect = viewport.convertToViewportRectangle([x1, y1, x2, y2]);
  const left = Math.min(rect[0], rect[2]);
  const top = Math.min(rect[1], rect[3]);
  const width = Math.abs(rect[2] - rect[0]);
  const height = Math.abs(rect[3] - rect[1]);

  const box = document.createElement('div');
  box.className = 'field-box';
  box.dataset.type = field.type;
  box.dataset.fieldId = idFor(field);
  // CV-detected fields carry source 'cv-line' / 'cv-underscore' /
  // 'cv-checkbox'. We surface this on the box dataset so the CSS can
  // mark them with a small "AI" indicator and the user knows what came
  // from the visual pass.
  if (field.source && String(field.source).startsWith('cv-')) {
    box.dataset.source = 'cv';
  }
  // Staggered detection reveal: the CSS keyframe runs immediately, the
  // index-driven animation-delay creates the one-at-a-time effect.
  // stepMs=0 (e.g. single-field case) means render with no delay.
  if (stepMs > 0) {
    box.dataset.reveal = 'true';
    box.style.setProperty('--reveal-delay', `${revealIndex * stepMs}ms`);
  }
  // Pass 6 in detect.js marks the dedicated signature block as primary=true
  // and body inline fill-ins as primary=false. The confidence-floor slider
  // hides boxes whose confidence is below the floor; primary fields are
  // not auto-hidden regardless of confidence so the signature block is
  // always reachable.
  box.dataset.primary = field.primary === false ? 'false' : 'true';
  box.dataset.confidence = String(Math.round((field.confidence || 0) * 100));
  // Apply current floor immediately so first paint matches the slider.
  applyConfidenceFloorToBox(box, currentConfidenceFloor());
  box.style.left = `${left}px`;
  box.style.top = `${top}px`;
  box.style.width = `${width}px`;
  box.style.height = `${height}px`;

  const tag = document.createElement('span');
  tag.className = 'field-box__tag';
  tag.textContent = field.type;
  box.appendChild(tag);

  // Sender controls: a small edit button in the top-right of the box,
  // visible on hover. Right-click anywhere on the box opens the same
  // menu. Touch users get a long-press to surface the menu.
  const editBtn = document.createElement('button');
  editBtn.type = 'button';
  editBtn.className = 'field-box__edit';
  editBtn.setAttribute('aria-label', 'Edit this field');
  editBtn.title = 'Edit field (change type, demote, remove)';
  editBtn.textContent = '⋯';
  editBtn.addEventListener('click', e => {
    e.stopPropagation();
    openContextMenu(field, box);
  });
  box.appendChild(editBtn);

  box.addEventListener('contextmenu', e => {
    e.preventDefault();
    openContextMenu(field, box);
  });

  // Long-press for touch (~550ms).
  let longPressTimer = null;
  box.addEventListener('touchstart', () => {
    longPressTimer = setTimeout(() => openContextMenu(field, box), 550);
  }, { passive: true });
  box.addEventListener('touchend', () => {
    if (longPressTimer) { clearTimeout(longPressTimer); longPressTimer = null; }
  });
  box.addEventListener('touchmove', () => {
    if (longPressTimer) { clearTimeout(longPressTimer); longPressTimer = null; }
  });

  // Per-signer chip in the top-right corner shows ownership.
  // Click cycles to next signer; ALT+click opens an inline menu.
  const chip = document.createElement('button');
  chip.type = 'button';
  chip.className = 'field-box__chip';
  chip.dataset.fieldId = box.dataset.fieldId;
  chip.title = 'Click to reassign this field to another signer.';
  chip.addEventListener('click', e => {
    e.stopPropagation();
    onChipClick(field, chip);
  });
  box.appendChild(chip);

  box.title = `${field.type} on page ${pageNum}` +
    (field.label ? `: ${field.label}` : '') +
    ` (confidence ${Math.round(field.confidence * 100)}%). Drag to move, corners to resize, click to fill.`;

  // Click-to-fill is replaced by the drag-aware interaction helper, which
  // distinguishes click (movement under 3 px) from drag/resize. Click
  // dispatches the existing onFieldBoxClick; drag and resize commit new
  // PDF-space geometry to senderEdits.
  attachDragResize(box, field, overlay.parentElement);

  overlay.appendChild(box);
  fieldElements.set(box.dataset.fieldId, box);
}

/**
 * Phase 2b vision detection client. Converts a rendered page canvas
 * to a base64 PNG and POSTs to /api/detect-vision. Returns an array
 * of vision-detected field candidates in pixel coordinates (canvas
 * space), or [] on any failure. Caller is responsible for translating
 * pixel coords to PDF coords using the current viewport.
 *
 * Cost: each call hits Claude Sonnet 4.5 via the worker, ~$0.01 per
 * page. Worker enforces a per-sender monthly cap (default 1000 pages,
 * configurable via env.VISION_MONTHLY_CAP_PAGES).
 */
async function callVisionDetection(canvas, viewport, pageNum) {
  // Downsample the source canvas so the upload stays small. Claude
  // accepts up to 8000 px on the long edge, but the model uses
  // 1568x1568 internally; sending bigger images wastes bandwidth
  // and tokens without improving accuracy.
  const maxSide = 1568;
  const sourceW = canvas.width;
  const sourceH = canvas.height;
  let scale = 1;
  if (Math.max(sourceW, sourceH) > maxSide) {
    scale = maxSide / Math.max(sourceW, sourceH);
  }
  const targetW = Math.round(sourceW * scale);
  const targetH = Math.round(sourceH * scale);

  let pngBlob;
  if (scale === 1) {
    pngBlob = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
  } else {
    const off = document.createElement('canvas');
    off.width = targetW;
    off.height = targetH;
    const offCtx = off.getContext('2d');
    offCtx.drawImage(canvas, 0, 0, targetW, targetH);
    pngBlob = await new Promise(resolve => off.toBlob(resolve, 'image/png'));
  }
  if (!pngBlob) return [];

  const imageBase64 = await blobToBase64(pngBlob);

  const senderId = (typeof getSenderId === 'function') ? getSenderId() : '';
  const res = await fetch('/api/detect-vision', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      senderId,
      pageNum,
      imageBase64,
      imageWidth: targetW,
      imageHeight: targetH,
    }),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`vision endpoint ${res.status}: ${detail.slice(0, 200)}`);
  }
  const data = await res.json();
  if (!data || !Array.isArray(data.fields)) return [];

  // Adjust pixel coords back to the FULL canvas resolution because
  // the caller's downstream math assumes canvas-space coordinates.
  const inv = scale === 1 ? 1 : (1 / scale);
  return data.fields.map(f => ({
    ...f,
    x: f.x * inv,
    y: f.y * inv,
    width:  f.width  * inv,
    height: f.height * inv,
  }));
}

function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => {
      const s = String(r.result || '');
      const comma = s.indexOf(',');
      resolve(comma >= 0 ? s.slice(comma + 1) : s);
    };
    r.onerror = () => reject(r.error);
    r.readAsDataURL(blob);
  });
}

/**
 * Wire pointer interactions on a field-box so the user can:
 *   - click to fill (existing behavior)
 *   - drag to move the field anywhere on the page
 *   - resize via 4 corner handles
 *
 * Distinguishes click from drag using a 3-pixel movement threshold.
 * On commit (drag end / resize end), converts CSS pixels back to PDF
 * coordinates using the shell's stashed viewport dimensions, then
 * applyFieldEdit persists the new geometry to senderEdits.
 */
function attachDragResize(box, field, shell) {
  // Add 4 corner resize handles.
  for (const corner of ['nw','ne','sw','se']) {
    const h = document.createElement('div');
    h.className = `field-box__handle field-box__handle--${corner}`;
    h.dataset.handle = corner;
    box.appendChild(h);
  }

  // Double-click to delete. Fast gesture for cleaning up misfires.
  // Routes through applyFieldEdit so the deletion persists in
  // senderEdits (localStorage) the same way the right-click "Remove"
  // menu item does, and so the sidebar + fillStore + assignments
  // all stay consistent.
  box.addEventListener('dblclick', (e) => {
    e.preventDefault();
    e.stopPropagation();
    const fieldId = box.dataset.fieldId;
    if (!fieldId) return;
    applyFieldEdit(fieldId, { deleted: true });
    populateSidebar(
      { fields: docState.fields, pageCount: Math.max(1, ...docState.fields.map(f => f.page)) },
      docState.filename || ''
    );
    updateFillUI();
    track('preview_field_deleted_dblclick', { type: field.type, source: field.source || 'unknown' });
  });

  let drag = null;
  box.addEventListener('pointerdown', (e) => {
    // Skip if the press hit an interactive child (edit button, signer chip).
    if (e.target.closest('.field-box__edit, .field-box__chip')) return;
    e.stopPropagation();
    box.setPointerCapture(e.pointerId);
    const handle = e.target.dataset && e.target.dataset.handle ? e.target.dataset.handle : null;
    drag = {
      mode: handle ? 'resize' : 'move',
      handle,
      startX: e.clientX,
      startY: e.clientY,
      startLeft: parseFloat(box.style.left) || 0,
      startTop:  parseFloat(box.style.top)  || 0,
      startW:    parseFloat(box.style.width)  || box.offsetWidth,
      startH:    parseFloat(box.style.height) || box.offsetHeight,
      moved: false,
    };
  });

  box.addEventListener('pointermove', (e) => {
    if (!drag) return;
    const dx = e.clientX - drag.startX;
    const dy = e.clientY - drag.startY;
    if (Math.abs(dx) + Math.abs(dy) > 3) drag.moved = true;
    if (!drag.moved) return;
    if (drag.mode === 'move') {
      box.style.left = `${drag.startLeft + dx}px`;
      box.style.top  = `${drag.startTop  + dy}px`;
    } else {
      // Resize from one of the four corners.
      let L = drag.startLeft, T = drag.startTop;
      let W = drag.startW,    H = drag.startH;
      if (drag.handle.includes('e')) W = Math.max(20, drag.startW + dx);
      if (drag.handle.includes('s')) H = Math.max(12, drag.startH + dy);
      if (drag.handle.includes('w')) { L = drag.startLeft + dx; W = Math.max(20, drag.startW - dx); }
      if (drag.handle.includes('n')) { T = drag.startTop  + dy; H = Math.max(12, drag.startH - dy); }
      box.style.left = `${L}px`;
      box.style.top  = `${T}px`;
      box.style.width  = `${W}px`;
      box.style.height = `${H}px`;
    }
  });

  function endDrag(e) {
    if (!drag) return;
    const wasMoved = drag.moved;
    try { box.releasePointerCapture(e.pointerId); } catch (err) {}
    drag = null;
    if (!wasMoved) return;  // bubble to click handler
    // Stash a one-shot flag so the click event we know is coming gets
    // swallowed instead of triggering fill capture.
    box.dataset.justMoved = 'true';
    // Convert CSS px back to PDF coords using the shell's stashed viewport.
    if (!shell) return;
    const scale = parseFloat(shell.dataset.scale) || 1;
    const vpH   = parseFloat(shell.dataset.viewportHeight);
    const cssL = parseFloat(box.style.left);
    const cssT = parseFloat(box.style.top);
    const cssW = parseFloat(box.style.width);
    const cssH = parseFloat(box.style.height);
    if (![cssL, cssT, cssW, cssH, vpH, scale].every(Number.isFinite)) return;
    const pdfX = cssL / scale;
    const pdfY = (vpH - cssT - cssH) / scale;
    const pdfW = cssW / scale;
    const pdfH = cssH / scale;
    applyFieldEdit(field.id, { x: pdfX, y: pdfY, width: pdfW, height: pdfH });
    track('preview_field_geometry_changed', { mode: 'drag-or-resize', fieldId: field.id });
  }
  box.addEventListener('pointerup', endDrag);
  box.addEventListener('pointercancel', endDrag);

  box.addEventListener('click', () => {
    if (box.dataset.justMoved === 'true') {
      delete box.dataset.justMoved;
      return;
    }
    onFieldBoxClick(field);
  });
}

// ---- Field interaction (click to fill) -------------------------------------

async function onFieldBoxClick(field) {
  focusField(field.id);

  // Perspective check: if the current "signing as" signer doesn't own
  // this field, surface a polite toast instead of capturing.
  const ownerId = assignments.get(field.id);
  const currentSignerId = signingAs.get();
  if (ownerId !== currentSignerId) {
    const owner = signers.get(ownerId);
    showToast(
      `This field is assigned to ${owner ? owner.name : 'another signer'}. ` +
      `Switch perspective from "Signing as" below to sign on their behalf, ` +
      `or use the signer chip to reassign.`,
    );
    return;
  }

  // Checkbox toggles inline; no modal.
  if (field.type === 'checkbox') {
    const current = fillStore.get(field.id);
    fillStore.set(field.id, current && current.checked
      ? null
      : { kind: 'checkbox', checked: true });
    track('preview_field_filled', { type: 'checkbox' });
    return;
  }

  if (!FILLABLE_TYPES.has(field.type)) return;

  const current = fillStore.get(field.id);
  let value;
  try {
    value = await openCaptureModal(field, current);
  } catch (err) {
    report(err, 'capture_modal');
    return;
  }
  if (value == null) return; // cancelled
  fillStore.set(field.id, value);
  track('preview_field_filled', { type: field.type });
}

// ---- Sidebar ---------------------------------------------------------------

function populateSidebar(detection, filename) {
  filenameEl.textContent = filename;
  statPages.textContent = String(detection.pageCount);
  statFields.textContent = String(detection.fields.length);
  statConfidence.textContent = meanConfidencePct(detection.fields);

  fieldList.innerHTML = '';
  if (detection.fields.length === 0) {
    const empty = document.createElement('li');
    empty.className = 'field-list__empty';
    empty.textContent = 'No fields detected. This document may not need a signature, or its layout is outside Phase 1 coverage.';
    fieldList.appendChild(empty);
    return;
  }

  // Split into the dedicated signature block (primary) and body inline
  // fill-ins (secondary). Primary fields render expanded by page; secondary
  // fields collapse into a single click-to-expand group at the bottom with
  // duplicate labels merged. This keeps a 80-field contract from drowning
  // the sidebar while still preserving every detection result.
  const primary = detection.fields.filter(f => f.primary !== false);
  const secondary = detection.fields.filter(f => f.primary === false);

  // ---- Primary section (always expanded, grouped by page) ------------------
  const byPage = groupBy(primary, f => f.page);
  const sortedPages = [...byPage.keys()].sort((a, b) => a - b);

  if (primary.length > 0) {
    for (const page of sortedPages) {
      const fields = byPage.get(page).sort((a, b) => b.y - a.y);
      const header = document.createElement('li');
      header.className = 'field-list__group';
      const groupLabel = document.createElement('span');
      groupLabel.textContent = `Page ${page}`;
      const groupCount = document.createElement('span');
      groupCount.textContent = `${fields.length} ${fields.length === 1 ? 'field' : 'fields'}`;
      header.appendChild(groupLabel);
      header.appendChild(groupCount);
      fieldList.appendChild(header);
      for (const field of fields) fieldList.appendChild(buildFieldRow(field, 1));
    }
  } else {
    const note = document.createElement('li');
    note.className = 'field-list__empty';
    note.textContent = 'No signature block detected. Body fields are shown below.';
    fieldList.appendChild(note);
  }

  // ---- Secondary section (collapsed by default, duplicates merged) ---------
  if (secondary.length > 0) {
    // Group by normalized label so the user sees "Client Primary Phone × 4"
    // instead of four identical-looking rows. Empty labels stay separate
    // because they refer to different anchors.
    const groups = new Map();
    for (const f of secondary) {
      const key = (f.label || '').trim().toLowerCase().slice(0, 80) || `__noLabel_${idFor(f)}`;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(f);
    }

    const collapse = document.createElement('li');
    collapse.className = 'field-list__collapsible';
    const details = document.createElement('details');
    const summary = document.createElement('summary');
    summary.className = 'field-list__group field-list__group--toggle';
    const summaryLabel = document.createElement('span');
    summaryLabel.textContent = 'Body fields';
    const summaryCount = document.createElement('span');
    summaryCount.textContent = `${secondary.length} found, ${groups.size} unique`;
    summary.appendChild(summaryLabel);
    summary.appendChild(summaryCount);
    details.appendChild(summary);

    const inner = document.createElement('ul');
    inner.className = 'field-list__inner';
    // Stable order: by page then by first appearance y.
    const sortedGroups = [...groups.values()].sort((a, b) => {
      if (a[0].page !== b[0].page) return a[0].page - b[0].page;
      return b[0].y - a[0].y;
    });
    for (const group of sortedGroups) inner.appendChild(buildFieldRow(group[0], group.length));
    details.appendChild(inner);
    collapse.appendChild(details);
    fieldList.appendChild(collapse);
  }
}

/**
 * Build a single field-row <li>. count > 1 indicates a deduplicated body
 * group; we annotate the row with the count so the user can tell repeated
 * blanks at a glance (e.g. "Client Primary Phone × 4").
 */
function buildFieldRow(field, count) {
  const row = document.createElement('li');
  row.className = 'field-row';
  row.dataset.type = field.type;
  row.dataset.fieldId = idFor(field);
  if (count > 1) row.dataset.count = String(count);

  const dot = document.createElement('span');
  dot.className = 'field-row__dot';

  const body = document.createElement('div');
  body.className = 'field-row__body';

  const typeEl = document.createElement('span');
  typeEl.className = 'field-row__type';
  typeEl.textContent = field.type;

  const labelEl = document.createElement('span');
  labelEl.className = 'field-row__label';
  const labelText = field.label ? field.label : '(no label nearby)';
  labelEl.textContent = count > 1 ? `${labelText} × ${count}` : labelText;

  body.appendChild(typeEl);
  body.appendChild(labelEl);

  const conf = document.createElement('span');
  conf.className = 'field-row__conf';
  conf.textContent = `${Math.round(field.confidence * 100)}%`;

  row.appendChild(dot);
  row.appendChild(body);
  row.appendChild(conf);

  row.addEventListener('click', () => focusField(row.dataset.fieldId));
  return row;
}

// ---- Field focus -----------------------------------------------------------

function focusField(id) {
  // Clear prior focus.
  document.querySelectorAll('.field-box.is-focused, .field-row.is-focused')
    .forEach(el => el.classList.remove('is-focused'));

  const box = fieldElements.get(id);
  const row = fieldList.querySelector(`[data-field-id="${cssEscape(id)}"]`);
  if (box) {
    box.classList.add('is-focused');
    box.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }
  if (row) row.classList.add('is-focused');
}

function cssEscape(s) {
  // Minimal CSS escaping for attribute selectors. Avoids depending on
  // CSS.escape, which is not in every old browser.
  return String(s).replace(/(["\\])/g, '\\$1');
}

// ---- Helpers ---------------------------------------------------------------

function idFor(f) {
  return `${f.page}-${Math.round(f.x)}-${Math.round(f.y)}-${f.type}`;
}

function groupBy(arr, keyFn) {
  const out = new Map();
  for (const item of arr) {
    const k = keyFn(item);
    if (!out.has(k)) out.set(k, []);
    out.get(k).push(item);
  }
  return out;
}

function meanConfidencePct(fields) {
  // Confidence-of-record is the average confidence of PRIMARY fields only:
  // the dedicated signature block (signature, initial, date in the
  // signer area). These are what matter for whether the document can be
  // signed; body inline fill-in blanks are advisory.
  //
  // Earlier this function averaged ALL detected fields, which is honest
  // but misleading: a contract whose signature block scores 90% but
  // whose body has 60 inline blanks at 50% would show "55%" overall.
  // The signer reading "55% confidence" reasonably assumes detection
  // is unreliable, when in fact the only fields they need to sign are
  // at 90%. We now report the number that actually matters.
  if (!Array.isArray(fields) || fields.length === 0) return '0%';
  const primary = fields.filter(f => f.primary !== false);
  const pool = primary.length > 0 ? primary : fields;
  const sum = pool.reduce((s, f) => s + (f.confidence || 0), 0);
  return `${Math.round((sum / pool.length) * 100)}%`;
}

function formatBytes(bytes) {
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${bytes} B`;
}

function showResultLayout() {
  layout.classList.remove('layout--empty');
  layout.classList.add('layout--loaded');
  result.hidden = false;
}

function resetApp() {
  layout.classList.remove('layout--loaded');
  layout.classList.add('layout--empty');
  result.hidden = true;
  documentStrip.innerHTML = '';
  fieldList.innerHTML = '';
  fieldElements.clear();
  _manualAddsThisSession = 0;
  _templateNudgeShown = false;
  setTemplateState('hidden');
  fileInput.value = '';
  signButton.disabled = true;
  signButton.textContent = 'Send for signature';
  signButton.classList.remove('btn--ready');
  fillStore.clear();
  signers.reset();
  assignments.reset();
  docState.filename = null;
  docState.originalBytes = null;
  docState.docId = null;
  docState.fields = [];
  senderEdits.clear();
  signButton.removeAttribute('data-signer-mode');
  hideToast();
  setStatus('idle', 'Ready.');
  hideError();
}

// ---- Sign button + fill state UI ------------------------------------------

/**
 * Called whenever fillStore changes. Updates each field-box on the page,
 * each sidebar row, and the sign button's label/state.
 */
function updateFillUI() {
  // Per-box visual: show signature bitmap, date text, etc.
  for (const field of docState.fields) {
    const box = fieldElements.get(field.id);
    if (!box) continue;
    const value = fillStore.get(field.id);
    renderBoxForFill(box, field, value);
  }

  // Sidebar rows reflect filled state.
  const rows = fieldList.querySelectorAll('.field-row');
  rows.forEach(row => {
    const id = row.dataset.fieldId;
    row.classList.toggle('field-row--filled', Boolean(fillStore.get(id)));
  });

  // Sign button: always enabled once any field exists, always downloads
  // what's filled. Label is a fixed "Download PDF" with a dynamic
  // "(X of N fields)" subline rendered inside the button so the user
  // sees progress without the button locking them out.
  const filledCount = fillStore.size();
  const totalCount = docState.fields.length;
  if (totalCount === 0) {
    signButton.disabled = true;
    signButton.innerHTML = '<span class="sign-btn__label">Download PDF</span>';
    return;
  }
  signButton.disabled = false;
  signButton.classList.add('btn--ready');
  signButton.innerHTML =
    `<span class="sign-btn__label">Download PDF</span>` +
    `<span class="sign-btn__sub">(${filledCount} of ${totalCount} fields filled)</span>`;
}

async function onSignClick() {
  track('preview_send_clicked');

  // Signer mode (magic-link): submit fills back to the Worker.
  if (signButton.dataset.signerMode === 'true') {
    return submitSignerFills();
  }

  if (!docState.originalBytes || docState.fields.length === 0) {
    showToast('No document loaded.');
    return;
  }

  // Multi-signer mode: still goes through the send-by-email modal so
  // each signer gets their own magic link. Single-signer (just "You"):
  // the click directly downloads the flattened PDF with whatever is
  // filled. No more "X fields left" gate; the user controls when
  // they're done.
  const isMultiSigner = signers.list().length > 1;
  if (isMultiSigner) {
    openSendModal();
    return;
  }

  try {
    signButton.disabled = true;
    const originalHtml = signButton.innerHTML;
    signButton.innerHTML = '<span class="sign-btn__label">Preparing PDF...</span>';
    await flattenAndDownload({
      originalBytes: freshCopy(docState.originalBytes),
      fields: docState.fields,
      fillStore,
      filename: docState.filename || 'signed.pdf',
    });
    track('preview_downloaded_direct', {
      fieldsTotal: docState.fields.length,
      fieldsFilled: fillStore.size(),
    });
    signButton.innerHTML = originalHtml;
  } catch (err) {
    report(err, 'direct_download');
    showToast(`Could not generate PDF: ${err.message || err}`);
  } finally {
    signButton.disabled = false;
    updateFillUI();  // restore the button state to "X of N filled"
  }
}

/**
 * In signer mode (?doc=&t=), the sign button persists the signer's
 * fills and shows them how complete they are. The fillStore.onChange
 * listener added by enterSignerMode also persists on every change,
 * so this is effectively a "confirm" affordance.
 */
async function submitSignerFills() {
  const { docId, token } = currentSignerSession();
  if (!docId || !token) {
    showToast('Signing session is missing. Reopen your magic link.');
    return;
  }
  const prior = signButton.textContent;
  signButton.disabled = true;
  signButton.textContent = 'Submitting.';
  try {
    const fillsObject = Object.fromEntries(fillStore.entries());
    const res = await submitFills(docId, token, fillsObject);
    if (!res.ok) throw new Error(res.error || 'submit failed');
    track('preview_signer_submitted', {
      complete: !!(res.data && res.data.signerComplete),
      docComplete: !!(res.data && res.data.docComplete),
    });
    if (res.data && res.data.signerComplete) {
      signButton.textContent = res.data.docComplete
        ? 'All signed.'
        : 'Your part is done.';
      if (res.data.docComplete) {
        showToast(
          'Every signer is finished. The sender has been emailed the signed document and the audit certificate.',
          res.data.auditUrl
            ? { action: { href: res.data.auditUrl, label: 'Download audit certificate' } }
            : undefined,
        );
      } else {
        showToast('Your part is submitted. We email you when the other signers complete.');
      }
    } else {
      signButton.textContent = prior;
      signButton.disabled = false;
      showToast('Fields saved. Add the remaining fields, then submit again.');
    }
  } catch (err) {
    report(err, 'submitSignerFills');
    signButton.textContent = prior;
    signButton.disabled = false;
    showToast(`Could not submit: ${err.message}`);
  }
}

function currentSignerSession() {
  const params = new URLSearchParams(window.location.search);
  return { docId: params.get('doc'), token: params.get('t') };
}

function showToast(message, opts = {}) {
  toast.innerHTML = '';
  const p = document.createElement('p');
  p.className = 'toast__message';
  p.textContent = message;
  toast.appendChild(p);
  if (opts.action) {
    const a = document.createElement('a');
    a.className = 'toast__action';
    a.href = opts.action.href;
    a.textContent = opts.action.label;
    toast.appendChild(a);
  }
  const close = document.createElement('button');
  close.className = 'toast__close';
  close.type = 'button';
  close.setAttribute('aria-label', 'Dismiss');
  close.textContent = 'Dismiss.';
  close.addEventListener('click', hideToast);
  toast.appendChild(close);
  toast.hidden = false;
}

function hideToast() {
  toast.hidden = true;
  toast.innerHTML = '';
}

function setStatus(state, text) {
  status.dataset.state = state;
  status.textContent = text;
}

function showError(msg) {
  errorBanner.textContent = msg;
  errorBanner.hidden = false;
}

function hideError() {
  errorBanner.textContent = '';
  errorBanner.hidden = true;
}

// ---- Multi-signer UI -------------------------------------------------------

/**
 * Cycle this field to the next signer in the list. Skips opening the
 * capture modal because it's a reassignment, not a fill.
 */
function onChipClick(field, chipEl) {
  const list = signers.list();
  if (list.length < 2) {
    showToast(
      'Add a second signer first. Click "+ Add" in the Signers panel.',
    );
    return;
  }
  const currentOwnerId = assignments.get(field.id);
  const idx = list.findIndex(s => s.id === currentOwnerId);
  const next = list[(idx + 1) % list.length];
  assignments.set(field.id, next.id);
  track('preview_field_reassigned', { type: field.type });
}

function onAddSigner() {
  const list = signers.list();
  if (list.length >= 4) {
    showToast('Up to four signers in this prototype.');
    return;
  }
  let signer;
  try {
    signer = signers.add({});
  } catch (e) {
    showToast(e.message);
    return;
  }
  // Focus the new signer's name field for inline editing.
  setTimeout(() => {
    const row = signersList.querySelector(`[data-signer-id="${cssEscape(signer.id)}"]`);
    const nameInput = row && row.querySelector('.signer-row__name');
    if (nameInput) { nameInput.focus(); nameInput.select(); }
  }, 30);
  track('preview_signer_added');
}

function updateSignersUI(list) {
  // 1. Rebuild the signers list.
  signersList.innerHTML = '';
  for (const signer of list) {
    const li = document.createElement('li');
    li.className = 'signer-row';
    li.dataset.signerId = signer.id;
    li.style.setProperty('--signer-color', signer.color);

    const swatch = document.createElement('span');
    swatch.className = 'signer-row__swatch';
    swatch.setAttribute('aria-hidden', 'true');
    swatch.textContent = signer.initials;

    const body = document.createElement('div');
    body.className = 'signer-row__body';

    const nameInput = document.createElement('input');
    nameInput.className = 'signer-row__name';
    nameInput.value = signer.name;
    nameInput.placeholder = 'Your name';
    nameInput.addEventListener('input', e => signers.update(signer.id, { name: e.target.value }));

    const emailInput = document.createElement('input');
    emailInput.className = 'signer-row__email';
    emailInput.type = 'email';
    emailInput.value = signer.email;
    emailInput.placeholder = 'email@address';
    emailInput.addEventListener('input', e => signers.update(signer.id, { email: e.target.value }));

    body.appendChild(nameInput);
    body.appendChild(emailInput);

    const count = document.createElement('span');
    count.className = 'signer-row__count';
    const owned = assignments.countFor(signer.id, docState.fields);
    count.textContent = `${owned}`;
    count.title = `${owned} fields assigned to ${signer.name}.`;

    li.appendChild(swatch);
    li.appendChild(body);
    li.appendChild(count);

    // Remove button (hidden for the only remaining signer; we always
    // need at least one).
    if (list.length > 1) {
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'signer-row__remove';
      remove.setAttribute('aria-label', `Remove ${signer.name}`);
      remove.textContent = '×';
      remove.addEventListener('click', () => removeSigner(signer.id));
      li.appendChild(remove);
    }

    signersList.appendChild(li);
  }

  // 2. Rebuild the "Signing as" dropdown to match. Empty-name signers
  // get an ordinal fallback ("Signer 1") so the dropdown never reads
  // as a blank option until the user types a name.
  const currentAs = signingAs.get();
  signingAsSelect.innerHTML = '';
  list.forEach((signer, idx) => {
    const opt = document.createElement('option');
    opt.value = signer.id;
    opt.textContent = signer.name.trim() || `Signer ${idx + 1}`;
    signingAsSelect.appendChild(opt);
  });
  signingAsSelect.value = currentAs && list.some(s => s.id === currentAs)
    ? currentAs : (list[0] && list[0].id);

  // 3. Refresh per-box chips so colours follow the (possibly renamed) signer.
  updateAssignmentUI();
}

function removeSigner(id) {
  const list = signers.list();
  if (list.length <= 1) return;
  // Reassign their fields to the first remaining signer.
  const remaining = list.find(s => s.id !== id);
  if (remaining) assignments.reassignFrom(id, remaining.id);
  if (signingAs.get() === id && remaining) signingAs.set(remaining.id);
  signers.remove(id);
  track('preview_signer_removed');
}

function updateAssignmentUI() {
  // Update each field-box chip colour + initials and the dimmed state.
  const currentAs = signingAs.get();
  for (const field of docState.fields) {
    const box = fieldElements.get(field.id);
    if (!box) continue;
    const ownerId = assignments.get(field.id);
    const owner = signers.get(ownerId);
    const chip = box.querySelector('.field-box__chip');
    if (chip && owner) {
      chip.style.background = owner.color;
      chip.style.borderColor = owner.color;
      chip.textContent = owner.initials;
      chip.title = `Assigned to ${owner.name}. Click to cycle to next signer.`;
    }
    const isCurrent = ownerId === currentAs;
    box.classList.toggle('field-box--other-signer', !isCurrent);
  }
  // Refresh signer counts in the panel without re-rendering the inputs.
  const counts = signersList.querySelectorAll('.signer-row__count');
  counts.forEach(el => {
    const row = el.closest('.signer-row');
    if (!row) return;
    const id = row.dataset.signerId;
    const n = assignments.countFor(id, docState.fields);
    el.textContent = `${n}`;
  });
}

function updateSigningAsUI() {
  signingAsSelect.value = signingAs.get();
  updateAssignmentUI();
}

// ---- Mode picker ----------------------------------------------------------

/**
 * After detection, ask: sign together on this device now, or send to
 * signers by email? Returns 'in-person' or 'send'. Defaults to 'send'
 * on Escape or backdrop click; Enter chooses the focused option.
 */
function openModePicker({ fields, pages }) {
  return new Promise(resolve => {
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-modal', 'true');
    overlay.setAttribute('aria-labelledby', 'mode-picker-title');

    const card = document.createElement('div');
    card.className = 'modal-card modal-card--wide';
    overlay.appendChild(card);

    const fieldNoun = `${fields} field${fields === 1 ? '' : 's'}`;
    const pageNoun = `${pages} page${pages === 1 ? '' : 's'}`;

    card.innerHTML = `
      <div class="modal-card__head">
        <div>
          <span class="modal-card__kicker">Ready to sign.</span>
          <h2 class="modal-card__title" id="mode-picker-title">How do you want to sign this?</h2>
        </div>
      </div>
      <div class="modal-card__body">
        <p class="modal-card__lede">
          ${fieldNoun} across ${pageNoun}. Pick how the signing happens.
        </p>
        <div class="mode-picker">
          <button class="mode-choice" type="button" data-mode="in-person" autofocus>
            <svg class="mode-choice__icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <rect x="4" y="2" width="16" height="20" rx="2"/>
              <path d="M10 18h4"/>
            </svg>
            <h3 class="mode-choice__title">Sign together now.</h3>
            <p class="mode-choice__body">
              Everyone signs on this device. Hand the iPad or laptop around between signers. The signed PDF and audit certificate download here when you finish.
            </p>
          </button>
          <button class="mode-choice" type="button" data-mode="send">
            <svg class="mode-choice__icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z"/>
              <polyline points="22,6 12,13 2,6"/>
            </svg>
            <h3 class="mode-choice__title">Send for signing.</h3>
            <p class="mode-choice__body">
              Email each signer a private link. They sign on their own device. We send the signed PDF and audit certificate to everyone when the last one completes.
            </p>
          </button>
        </div>
      </div>
    `;

    document.body.appendChild(overlay);
    document.body.style.overflow = 'hidden';

    function pick(mode) {
      document.body.style.overflow = '';
      overlay.remove();
      window.removeEventListener('keydown', onKey);
      resolve(mode);
    }
    function onKey(e) {
      if (e.key === 'Escape') pick('send');
    }
    window.addEventListener('keydown', onKey);
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) pick('send');
    });
    card.querySelectorAll('.mode-choice').forEach(btn => {
      btn.addEventListener('click', () => pick(btn.dataset.mode));
    });
  });
}

// ---- In-person handoff ----------------------------------------------------

/**
 * Full-screen pass-the-iPad screen shown between signers when in-person
 * mode is active. Resolves when the next signer taps the CTA.
 */
function showHandoff({ nextSignerName, remainingCount }) {
  return new Promise(resolve => {
    const div = document.createElement('div');
    div.className = 'handoff';
    div.setAttribute('role', 'dialog');
    div.setAttribute('aria-modal', 'true');
    const remaining = remainingCount > 1
      ? `${remainingCount - 1} signer${remainingCount - 1 === 1 ? '' : 's'} after this one.`
      : 'Last signer.';
    div.innerHTML = `
      <p class="handoff__kicker">Pass the device</p>
      <h1 class="handoff__name">${escapeHtml(nextSignerName)}<span class="dot">.</span></h1>
      <p class="handoff__body">${remaining} Hand this over and tap when ready.</p>
      <button class="btn btn--primary handoff__cta" type="button">I'm ${escapeHtml(nextSignerName)}. Let's sign.</button>
      <button class="handoff__skip" type="button">Skip this prompt</button>
    `;
    document.body.appendChild(div);
    document.body.style.overflow = 'hidden';

    function dismiss() {
      document.body.style.overflow = '';
      div.remove();
      resolve();
    }
    div.querySelector('.handoff__cta').addEventListener('click', dismiss);
    div.querySelector('.handoff__skip').addEventListener('click', dismiss);
  });
}

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[c]);
}

// ---- Send-flow modal -------------------------------------------------------

function openSendModal() {
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  const card = document.createElement('div');
  card.className = 'modal-card modal-card--wide';
  overlay.appendChild(card);
  document.body.appendChild(overlay);
  document.body.style.overflow = 'hidden';

  function close() {
    document.body.style.overflow = '';
    overlay.remove();
    window.removeEventListener('keydown', onKey);
  }
  function onKey(e) { if (e.key === 'Escape') close(); }
  overlay.addEventListener('click', e => { if (e.target === overlay) close(); });
  window.addEventListener('keydown', onKey);

  // Header
  const head = document.createElement('header');
  head.className = 'modal-card__head';
  head.innerHTML =
    '<span class="modal-card__kicker">Send for signature.</span>' +
    '<h2 class="modal-card__title">Route this document to every signer.</h2>';
  const closeBtn = document.createElement('button');
  closeBtn.type = 'button';
  closeBtn.className = 'modal-card__close';
  closeBtn.setAttribute('aria-label', 'Close');
  closeBtn.textContent = '×';
  closeBtn.addEventListener('click', close);
  head.appendChild(closeBtn);
  card.appendChild(head);

  // Body
  const body = document.createElement('div');
  body.className = 'modal-card__body';

  const lede = document.createElement('p');
  lede.className = 'modal-card__lede';
  const list = signers.list();
  if (list.length === 1) {
    lede.textContent =
      'This document has one signer (you). Click Download below to flatten ' +
      'every filled field into the original PDF.';
  } else {
    lede.innerHTML =
      'In production, CyberSygn emails each signer a magic link that lets them ' +
      'sign only their assigned fields. The prototype simulates this by letting ' +
      'you switch perspectives in the sidebar. Each signer below shows their ' +
      'completion status.';
  }
  body.appendChild(lede);

  // Per-signer progress list.
  const progress = progressBySigner({
    signers: list,
    fields: docState.fields,
    assignments,
    fillStore,
  });

  const ol = document.createElement('ol');
  ol.className = 'send-list';
  for (const p of progress) {
    const li = document.createElement('li');
    li.className = 'send-list__row';
    li.style.setProperty('--signer-color', p.signer.color);
    li.classList.toggle('send-list__row--complete', p.complete);
    li.classList.toggle('send-list__row--idle', p.noFields);

    const swatch = document.createElement('span');
    swatch.className = 'send-list__swatch';
    swatch.textContent = p.signer.initials;

    const meta = document.createElement('div');
    meta.className = 'send-list__meta';
    const name = document.createElement('p');
    name.className = 'send-list__name';
    name.textContent = p.signer.name;
    const email = document.createElement('p');
    email.className = 'send-list__email';
    email.textContent = p.signer.email || 'No email on file.';
    meta.appendChild(name);
    meta.appendChild(email);

    const status = document.createElement('span');
    status.className = 'send-list__status';
    if (p.noFields) status.textContent = 'No fields assigned';
    else if (p.complete) status.textContent = `All ${p.owned} signed`;
    else status.textContent = `${p.filled} of ${p.owned}`;

    li.appendChild(swatch);
    li.appendChild(meta);
    li.appendChild(status);
    ol.appendChild(li);
  }
  body.appendChild(ol);

  // Production-flow preview (the magic-link copy).
  if (list.length > 1) {
    const note = document.createElement('div');
    note.className = 'send-note';
    note.innerHTML =
      '<p class="send-note__kicker">What ships in production.</p>' +
      '<p class="send-note__body">' +
      'CyberSygn sends each signer a unique link by email. They open it on any device, ' +
      'see only their assigned fields, sign, and submit. The moment the last signer ' +
      'completes, every party receives the signed PDF and an audit certificate that ' +
      'lists every event, every IP address, and the SHA-256 of the original document. ' +
      'Keep it with the signed PDF as evidence of who signed what and when.' +
      '</p>';
    body.appendChild(note);
  }

  card.appendChild(body);

  // Footer
  const footer = document.createElement('footer');
  footer.className = 'modal-card__footer';

  const left = document.createElement('div');
  left.className = 'modal-card__footer-left';
  const cancelBtn = document.createElement('button');
  cancelBtn.type = 'button';
  cancelBtn.className = 'btn btn--ghost';
  cancelBtn.textContent = 'Keep editing';
  cancelBtn.addEventListener('click', close);
  left.appendChild(cancelBtn);

  const right = document.createElement('div');
  right.className = 'modal-card__footer-right';

  // Send via Worker: appears when the Worker is reachable AND there is
  // more than one signer (single-signer documents flatten and download
  // immediately; routing them by email would add no value).
  if (workerStatus.ok && list.length > 1) {
    const sendBtn = document.createElement('button');
    sendBtn.type = 'button';
    sendBtn.className = 'btn btn--ink';
    sendBtn.textContent = 'Send by email';
    sendBtn.addEventListener('click', async () => {
      sendBtn.disabled = true;
      sendBtn.textContent = 'Sending.';
      try {
        const activeWs = getActiveWorkspace();
        // Sender edits captured in the preview UI are forwarded to the
        // Worker so they can be replayed into the audit certificate.
        // We send the full history (timestamps + before/after) so the
        // cert shows what the sender changed and when.
        const fieldEditsPayload = {};
        for (const [fieldId, overlay] of senderEdits.entries()) {
          fieldEditsPayload[fieldId] = overlay;
        }
        const sendResult = await createDoc({
          title: docState.filename || 'CyberSygn document',
          pdfBytes: docState.originalBytes,
          fields: docState.fields,
          fieldEdits: fieldEditsPayload,
          signers: list.map(s => ({ id: s.id, name: s.name, email: s.email })),
          assignments: Object.fromEntries(
            docState.fields.map(f => [f.id, assignments.get(f.id)]),
          ),
          senderName: list[0] && list[0].name,
          senderId: getSenderId(),
          workspaceId: activeWs ? activeWs.id : null,
          mode: docState.mode || 'send',
        });
        if (!sendResult.ok) {
          throw new Error(sendResult.error || 'send failed');
        }
        // Persist the per-doc senderToken so the dashboard can fetch
        // privileged details later (magic links, audit URL).
        if (sendResult.data.senderToken) {
          rememberDocToken(sendResult.data.docId, sendResult.data.senderToken);
        }
        close();
        openLinksModal(sendResult.data);
        track('preview_doc_created', {
          signers: list.length,
          email_mode: sendResult.data.email,
        });
      } catch (err) {
        report(err, 'createDoc');
        sendBtn.disabled = false;
        sendBtn.textContent = 'Try sending again';
        showToast(`Could not route the document: ${err.message}`);
      }
    });
    right.appendChild(sendBtn);
  }

  const downloadBtn = document.createElement('button');
  downloadBtn.type = 'button';
  downloadBtn.className = 'btn btn--primary';
  const totalFilled = fillStore.size();
  const allComplete = progress.every(p => p.noFields || p.complete);
  downloadBtn.textContent = allComplete
    ? `Download signed PDF`
    : `Download what is signed so far (${totalFilled})`;
  if (!allComplete) downloadBtn.classList.add('btn--warn');
  downloadBtn.addEventListener('click', async () => {
    downloadBtn.disabled = true;
    downloadBtn.textContent = 'Flattening PDF.';
    try {
      await flattenAndDownload({
        originalBytes: docState.originalBytes,
        fields: docState.fields,
        fillStore,
        filename: docState.filename,
      });
      track('preview_download_succeeded', { filled: fillStore.size(), signers: list.length });
      close();
      showToast(
        allComplete
          ? `Downloaded. Every signer has signed their fields.`
          : `Downloaded a partial. ${fillStore.size()} of ${docState.fields.length} fields filled.`,
        { action: { href: '../#founding', label: 'Join founding members' } },
      );
    } catch (err) {
      report(err, 'flatten');
      downloadBtn.disabled = false;
      downloadBtn.textContent = 'Try again';
      showToast('We could not flatten the PDF.');
    }
  });
  right.appendChild(downloadBtn);

  footer.appendChild(left);
  footer.appendChild(right);
  card.appendChild(footer);
}

// ---- Magic-link modal (shown after a successful createDoc) ----------------

function openLinksModal(payload) {
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  const card = document.createElement('div');
  card.className = 'modal-card modal-card--wide';
  overlay.appendChild(card);
  document.body.appendChild(overlay);
  document.body.style.overflow = 'hidden';

  function close() {
    document.body.style.overflow = '';
    overlay.remove();
    window.removeEventListener('keydown', onKey);
  }
  function onKey(e) { if (e.key === 'Escape') close(); }
  overlay.addEventListener('click', e => { if (e.target === overlay) close(); });
  window.addEventListener('keydown', onKey);

  const head = document.createElement('header');
  head.className = 'modal-card__head';
  head.innerHTML =
    '<span class="modal-card__kicker">Routed.</span>' +
    '<h2 class="modal-card__title">Document sent to ' + payload.signerLinks.length + ' signer' +
      (payload.signerLinks.length === 1 ? '' : 's') + '.</h2>';
  const closeBtn = document.createElement('button');
  closeBtn.type = 'button';
  closeBtn.className = 'modal-card__close';
  closeBtn.setAttribute('aria-label', 'Close');
  closeBtn.textContent = '×';
  closeBtn.addEventListener('click', close);
  head.appendChild(closeBtn);
  card.appendChild(head);

  const body = document.createElement('div');
  body.className = 'modal-card__body';

  const note = document.createElement('p');
  note.className = 'modal-card__lede';
  if (payload.email === 'resend') {
    note.textContent = 'Each signer has been emailed their signing link. The links below are a copy in case you need to resend manually.';
  } else {
    note.innerHTML = 'Email is in <strong>dev mode</strong>. The Worker logged each message to its console; copy the links below to send them manually, or set <code>RESEND_API_KEY</code> in your Worker to deliver them automatically.';
  }
  body.appendChild(note);

  const ol = document.createElement('ol');
  ol.className = 'send-list';
  for (const link of payload.signerLinks) {
    const li = document.createElement('li');
    li.className = 'send-list__row link-row';

    const meta = document.createElement('div');
    meta.className = 'send-list__meta';
    const name = document.createElement('p');
    name.className = 'send-list__name';
    name.textContent = link.name;
    const email = document.createElement('p');
    email.className = 'send-list__email';
    email.textContent = link.email || 'No email; copy link manually.';
    meta.appendChild(name);
    meta.appendChild(email);

    const linkInput = document.createElement('input');
    linkInput.className = 'link-row__url';
    linkInput.readOnly = true;
    linkInput.value = link.magicLink;
    linkInput.addEventListener('focus', () => linkInput.select());

    const copyBtn = document.createElement('button');
    copyBtn.type = 'button';
    copyBtn.className = 'btn btn--ghost btn--sm';
    copyBtn.textContent = 'Copy';
    copyBtn.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(link.magicLink);
        copyBtn.textContent = 'Copied';
        setTimeout(() => { copyBtn.textContent = 'Copy'; }, 1400);
      } catch {
        linkInput.select();
        document.execCommand && document.execCommand('copy');
      }
    });

    // Remind: re-sends the magic-link email to this signer. Only useful
    // when the Worker is running in resend mode; in console mode it
    // still works but the developer reads the new message from the log.
    const remindBtn = document.createElement('button');
    remindBtn.type = 'button';
    remindBtn.className = 'btn btn--ghost btn--sm';
    remindBtn.textContent = 'Remind';
    remindBtn.title = link.email
      ? `Send a reminder email to ${link.email}.`
      : 'No email on file. Add one before reminding.';
    if (!link.email) remindBtn.disabled = true;
    remindBtn.addEventListener('click', async () => {
      remindBtn.disabled = true;
      remindBtn.textContent = 'Sending.';
      try {
        const res = await remindSigner(payload.docId, link.signerId);
        if (!res.ok) throw new Error(res.error || 'remind failed');
        const tone = res.data && res.data.tone;
        const count = res.data && res.data.reminderCount;
        remindBtn.textContent = tone === 'final' ? 'Final sent'
                              : tone === 'second' ? 'Second sent'
                              : 'Sent';
        remindBtn.title = `Reminder ${count} of 3 sent. Wait a minute before another.`;
        track('preview_reminder_sent', { tone });
        setTimeout(() => {
          remindBtn.textContent = 'Remind again';
          remindBtn.disabled = false;
        }, 4000);
      } catch (err) {
        report(err, 'remindSigner');
        remindBtn.textContent = 'Try again';
        remindBtn.disabled = false;
        showToast(`Could not send reminder: ${err.message}`);
      }
    });

    li.appendChild(meta);
    li.appendChild(linkInput);
    li.appendChild(copyBtn);
    li.appendChild(remindBtn);
    ol.appendChild(li);
  }
  body.appendChild(ol);
  card.appendChild(body);

  const footer = document.createElement('footer');
  footer.className = 'modal-card__footer';
  const left = document.createElement('div');
  left.className = 'modal-card__footer-left';
  const right = document.createElement('div');
  right.className = 'modal-card__footer-right';
  const dashboardLink = document.createElement('a');
  dashboardLink.className = 'btn btn--ghost';
  dashboardLink.href = '../dashboard/';
  dashboardLink.textContent = 'Open dashboard';
  left.appendChild(dashboardLink);

  const doneBtn = document.createElement('button');
  doneBtn.type = 'button';
  doneBtn.className = 'btn btn--primary';
  doneBtn.textContent = 'Done';
  doneBtn.addEventListener('click', close);
  right.appendChild(doneBtn);
  footer.appendChild(left);
  footer.appendChild(right);
  card.appendChild(footer);
}

// ---- Boot ------------------------------------------------------------------

const workerStatus = { ok: false, mode: 'memory', email: 'console' };

async function boot() {
  // Probe the Worker once on load so the UI can adapt.
  const status = await checkWorker();
  Object.assign(workerStatus, status);
  if (status.ok && window.__cybersygnDebug) {
    console.info('[cybersygn:worker]', status);
  }

  // Magic-link handling: if the URL contains ?doc=&t=, hydrate the signer
  // perspective from the Worker.
  const params = new URLSearchParams(window.location.search);
  const docId = params.get('doc');
  const token = params.get('t');
  if (docId && token && status.ok) {
    await enterSignerMode(docId, token);
  } else {
    resetApp();
  }
}

async function enterSignerMode(docId, token) {
  setStatus('busy', 'Loading your document.');

  const hydrateResult = await hydrateSigner(docId, token);
  if (!hydrateResult.ok) {
    setStatus('error', 'Invalid link.');
    showError(
      'This signing link is no longer valid. Ask the sender to issue a new one. ' +
      `Detail: ${hydrateResult.error || 'unknown'}`,
    );
    return;
  }
  const session = hydrateResult.data;

  const pdfResult = await fetchSignerPdf(docId, token);
  if (!pdfResult.ok) {
    setStatus('error', 'Could not load the document.');
    showError(`We could not fetch the original PDF: ${pdfResult.error || 'unknown'}.`);
    return;
  }

  // Configure the app exactly as if the user had uploaded the file and we
  // were just rendering the fields they own.
  docState.filename = session.title;
  docState.originalBytes = pdfResult.bytes;
  docState.fields = session.fields;
  for (const f of docState.fields) f.id = idFor(f);
  fillStore.clear();

  // Restore any fills the signer had already saved.
  for (const [fid, value] of Object.entries(session.fills || {})) {
    fillStore.set(fid, value);
  }

  // Signer roster shows only this signer, framed as the active perspective.
  signers.reset();
  assignments.reset();
  const me = signers.add({ name: session.signer.name, email: session.signer.email });
  for (const f of docState.fields) assignments.set(f.id, me.id);
  assignments.setDefault(me.id);
  signingAs.set(me.id);

  setStatus('busy', 'Rendering pages.');
  showResultLayout();
  try {
    await renderDocument(pdfResult.bytes, { fields: docState.fields, pageCount: 0 });
  } catch (err) {
    report(err, 'render');
    showError('The PDF parsed but failed to render.');
    setStatus('error', 'Render failed.');
    return;
  }

  populateSidebar({ pageCount: '-', fields: docState.fields }, session.title);
  updateFillUI();

  // Replace the send button label so the signer knows what it does.
  signButton.textContent = 'Submit your fields';
  signButton.dataset.signerMode = 'true';

  // Persist fills to the Worker on every change.
  fillStore.onChange(async () => {
    if (!signButton.dataset.signerMode) return;
    const fillsObject = Object.fromEntries(fillStore.entries());
    await submitFills(docId, token, fillsObject);
  });

  setStatus('done', `Signing as ${session.signer.name}.`);
  showToast(
    `You are signing as ${session.signer.name}. Fill the highlighted fields, then click Submit.`,
  );
}

// Start.
boot();

// Boot owner mode: validate any saved token, surface the pill, listen
// for the activation gesture on email inputs or URL params.
ownerMod.bootOwner('').then(() => ownerMod.wirePillControls());
ownerMod.watchActivation('');
