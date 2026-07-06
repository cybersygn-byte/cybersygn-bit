/**
 * CyberSygn preview, prototype: multi-signer routing.
 *
 * Three stores collaborate to model a multi-party signing:
 *
 *   signers      | the named parties (you and everyone else who signs)
 *   assignments  | which signer owns which detected field
 *   signingAs    | whose perspective the current user is signing from
 *
 * In production these become server-side records keyed by document id;
 * here they live in memory and reset on every fresh upload. The
 * interface is identical to what the production version would expose,
 * so the UI layer does not need to change when persistence lands.
 */

// Distinct from the field-type palette so signer identity and field
// type stay separately readable. Order matches typical signing order:
// sender first, everyone else after.
// Up to twelve signers per document, matching the "up to 20" product promise
// far more closely than the old four-color prototype and clearing the
// ten-signer minimum. Each colour is visually distinct for at-a-glance field
// ownership. Default names are plain placeholders the sender overwrites.
export const SIGNER_PALETTE = [
  { id: 'p1',  hex: '#B83227', name: 'Sender'        },
  { id: 'p2',  hex: '#2F4D7A', name: 'Second signer' },
  { id: 'p3',  hex: '#B47A1F', name: 'Third signer'  },
  { id: 'p4',  hex: '#2F6D6A', name: 'Fourth signer' },
  { id: 'p5',  hex: '#7A2F6D', name: 'Signer 5'     },
  { id: 'p6',  hex: '#3B6A2F', name: 'Signer 6'     },
  { id: 'p7',  hex: '#A84A1F', name: 'Signer 7'     },
  { id: 'p8',  hex: '#2F6A8A', name: 'Signer 8'     },
  { id: 'p9',  hex: '#8A2F4A', name: 'Signer 9'     },
  { id: 'p10', hex: '#4A4A8A', name: 'Signer 10'    },
  { id: 'p11', hex: '#6A6A2F', name: 'Signer 11'    },
  { id: 'p12', hex: '#2F8A6A', name: 'Signer 12'    },
];

// A signing request to an invalid or duplicate email silently fails to reach
// the signer, which means the document can never complete. We validate format
// and flag duplicates so the send flow can warn before routing.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// ---------------------------------------------------------------------------
// Signers store
// ---------------------------------------------------------------------------

/**
 * Holds the list of signers for the current document.
 * Each signer: { id, name, email, color, initials }
 */
export function createSignersStore() {
  let signers = [];
  const listeners = new Set();

  function notify() { listeners.forEach(fn => fn(list())); }

  function list() { return signers.slice(); }

  function get(id) { return signers.find(s => s.id === id) || null; }

  function defaultName(index) {
    const slot = SIGNER_PALETTE[index];
    return slot ? slot.name : `Signer ${index + 1}`;
  }

  function paletteFor(index) {
    return SIGNER_PALETTE[index % SIGNER_PALETTE.length];
  }

  /**
   * Add a signer, returning the created record. If name is empty, a
   * plain default (Sender / Second signer / Third signer) is assigned.
   *
   * F5 habit layer: when the page URL carries a valid ?to=<email>
   * (and optional &name=), the FIRST recipient added without an
   * explicit name/email is prefilled from those params, once. The
   * sender (index 0) is never prefilled: ?to= names the counterparty.
   */
  function add({ name, email } = {}) {
    if (signers.length >= SIGNER_PALETTE.length) {
      throw new Error(`CyberSygn supports up to ${SIGNER_PALETTE.length} signers in this prototype.`);
    }
    const index = signers.length;
    const slot = paletteFor(index);
    let prefill = null;
    if (index >= 1 && pendingRecipientPrefill &&
        !(name && String(name).trim()) && !(email && String(email).trim())) {
      prefill = pendingRecipientPrefill;
      pendingRecipientPrefill = null; // consume exactly once
    }
    const cleanName = (prefill && prefill.name) || (name && name.trim()) || defaultName(index);
    const cleanEmail = (prefill ? prefill.email : (email || '')).trim();
    const signer = {
      id: slot.id,
      name: cleanName,
      email: cleanEmail,
      color: slot.hex,
      initials: initialsFor(cleanName),
      // Empty email is "not yet provided" (null), not invalid. A non-empty
      // email is validated against EMAIL_RE. duplicateEmail flags a collision
      // with an existing signer (case-insensitive). The send flow reads both.
      emailValid: cleanEmail === '' ? null : EMAIL_RE.test(cleanEmail),
      duplicateEmail: cleanEmail !== '' && signers.some(
        s => s.email && s.email.toLowerCase() === cleanEmail.toLowerCase()),
    };
    signers.push(signer);
    notify();
    // A pending ?to= recipient plus a freshly-seeded sender means the
    // user arrived via "Send another to <name>": add the recipient for
    // them right away (deferred a tick so the app finishes wiring the
    // sender first). Guarded so it never fires in signer/magic-link mode
    // (readRecipientPrefill returns null there) and never fires twice.
    if (index === 0 && pendingRecipientPrefill && HAS_DOM) {
      setTimeout(() => {
        try {
          if (pendingRecipientPrefill && signers.length === 1 &&
              signers[0] && signers[0].id === signer.id) {
            add({});
          }
        } catch (e) { /* graceful no-op */ }
      }, 0);
    }
    return signer;
  }

  /**
   * Replace a signer's name or email in place. Falls back to defaults
   * if name becomes empty. Recomputes email validity and duplicate flags.
   */
  function update(id, patch) {
    const i = signers.findIndex(s => s.id === id);
    if (i < 0) return null;
    const next = { ...signers[i], ...patch };
    if (!next.name || !next.name.trim()) next.name = defaultName(i);
    next.name = next.name.trim();
    next.email = (next.email || '').trim();
    next.initials = initialsFor(next.name);
    next.emailValid = next.email === '' ? null : EMAIL_RE.test(next.email);
    next.duplicateEmail = next.email !== '' && signers.some(
      (s, j) => j !== i && s.email && s.email.toLowerCase() === next.email.toLowerCase());
    signers[i] = next;
    notify();
    return next;
  }

  function remove(id) {
    if (signers.length <= 1) return false; // never remove the last signer
    signers = signers.filter(s => s.id !== id);
    notify();
    return true;
  }

  function reset() {
    signers = [];
    notify();
  }

  function onChange(fn) { listeners.add(fn); return () => listeners.delete(fn); }

  return { list, get, add, update, remove, reset, onChange };
}

// ---------------------------------------------------------------------------
// Assignments store
// ---------------------------------------------------------------------------

/**
 * Map of fieldId -> signerId. Every field is assigned to exactly one
 * signer. New fields default to the first signer (the sender).
 */
export function createAssignmentStore(defaultSignerId, opts = {}) {
  let defaultId = defaultSignerId;
  // When wired to the signers store (production usage), `liveSigners` returns
  // the current live signer ids. With it, get() SELF-HEALS: a field assigned
  // to a signer who has since been removed resolves to the default (if live)
  // or the first live signer, so a field can never be silently orphaned to a
  // ghost. Without it, behavior matches the old store.
  const liveSigners = typeof opts.liveSigners === 'function' ? opts.liveSigners : null;
  const map = new Map();
  const listeners = new Set();

  function notify() { listeners.forEach(fn => fn()); }

  function setDefault(id) { defaultId = id; }

  function liveSet() { return liveSigners ? new Set(liveSigners()) : null; }

  // Resolve a raw owner to a guaranteed-live owner. Never returns undefined:
  // returns a live id when any signer exists, else null.
  function resolve(rawOwner) {
    const live = liveSet();
    if (!live) return rawOwner != null ? rawOwner : (defaultId != null ? defaultId : null);
    if (rawOwner != null && live.has(rawOwner)) return rawOwner;
    if (defaultId != null && live.has(defaultId)) return defaultId;
    const first = live.values().next().value;
    return first != null ? first : null;
  }

  function get(fieldId) { return resolve(map.get(fieldId)); }

  function set(fieldId, signerId) {
    map.set(fieldId, signerId);
    notify();
  }

  function bulkAssign(fieldIds, signerId) {
    for (const id of fieldIds) map.set(id, signerId);
    notify();
  }

  function countFor(signerId, allFields) {
    let n = 0;
    for (const f of allFields) {
      if (get(f.id) === signerId) n++;
    }
    return n;
  }

  /**
   * Used when a signer is removed: every field they owned reassigns
   * to the fallback (typically the first remaining signer).
   */
  function reassignFrom(oldSignerId, newSignerId) {
    for (const [fid, sid] of map.entries()) {
      if (sid === oldSignerId) map.set(fid, newSignerId);
    }
    notify();
  }

  /**
   * Rewrite every stored assignment that points to a non-live signer onto a
   * live fallback. Idempotent. Call after any signer removal to keep the map
   * physically clean (get() already heals reads, but reconcile fixes the
   * underlying store too).
   */
  function reconcile(fallbackId) {
    const live = liveSet();
    if (!live) return;
    const fb = (fallbackId != null && live.has(fallbackId))
      ? fallbackId
      : (live.values().next().value ?? null);
    if (fb == null) return;
    let changed = false;
    for (const [fid, sid] of map.entries()) {
      if (!live.has(sid)) { map.set(fid, fb); changed = true; }
    }
    if (changed) notify();
  }

  /**
   * Field ids whose RAW assignment points to a signer that is not live. The
   * send gate uses this to surface "these fields belong to a removed signer"
   * before routing, even though get() would heal them.
   */
  function orphanedFieldIds(allFields) {
    const live = liveSet();
    if (!live) return [];
    return allFields
      .map(f => f.id)
      .filter(id => { const raw = map.get(id); return raw != null && !live.has(raw); });
  }

  function reset() { map.clear(); notify(); }

  function onChange(fn) { listeners.add(fn); return () => listeners.delete(fn); }

  return { get, set, bulkAssign, countFor, reassignFrom, reconcile, orphanedFieldIds, reset, setDefault, onChange };
}

// ---------------------------------------------------------------------------
// Signing-as (perspective) store
// ---------------------------------------------------------------------------

/**
 * Tracks whose perspective the current browser is signing from. The
 * preview app uses this to dim fields not owned by the current signer.
 * In production this is set from the magic-link token; here it is set
 * from a UI dropdown.
 */
export function createSigningAsStore(initial) {
  let current = initial;
  const listeners = new Set();

  function set(signerId) {
    if (signerId === current) return;
    current = signerId;
    listeners.forEach(fn => fn(current));
  }
  function get() { return current; }
  function onChange(fn) { listeners.add(fn); return () => listeners.delete(fn); }

  return { get, set, onChange };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export function initialsFor(name) {
  // Single-word names get one initial, not two. Returning two letters
  // ("YO" from "You", "AL" from "Alex") read like duplicates next to
  // the name field on the signer card. Two-word names get the
  // conventional first-last initials.
  if (!name) return '—';
  const parts = String(name).trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '—';
  if (parts.length === 1) return parts[0][0].toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

// ---------------------------------------------------------------------------
// F5 habit layer: recipient prefill (?to=&name=) + saved-contact quick-pick
// ---------------------------------------------------------------------------
//
// Both features live here because this module owns signer state and is the
// one place every signer row's inputs flow through. Everything below is
// browser-only and fails soft: no DOM, no senderId, no worker, empty
// contacts, or a fetch error all degrade to the exact behavior the add-
// signer flow had before.

const HAS_DOM = typeof document !== 'undefined' && typeof window !== 'undefined';

/**
 * Parse a one-shot recipient prefill from the page URL. Only honored when
 * ?to= is a valid email; &name= is optional and sanitized (control chars
 * stripped, length capped). Never active on signer magic links (?doc=&t=),
 * where the signer list is hydrated from the server, not the sender.
 */
function readRecipientPrefill() {
  if (!HAS_DOM) return null;
  try {
    const p = new URLSearchParams(window.location.search);
    if (p.get('doc') && p.get('t')) return null;
    const to = (p.get('to') || '').trim();
    if (!to || to.length > 254 || !EMAIL_RE.test(to)) return null;
    const name = (p.get('name') || '')
      .replace(/[\u0000-\u001F\u007F]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 80);
    return { email: to, name };
  } catch (e) {
    return null;
  }
}

let pendingRecipientPrefill = readRecipientPrefill();

/**
 * Saved-contact quick-pick. Wires a native <datalist> onto every signer
 * email input (.signer-row__email) via delegated listeners, so it works
 * for rows built now or later without touching the row-building code.
 * Contacts come from GET /api/sender/:id/contacts (Wave 1), fetched once
 * per page, only after the user first focuses a signer email input.
 * Picking a suggestion fills the email natively; a matching contact name
 * is then written into the sibling name input (only when that input still
 * holds an empty or default placeholder name) and an 'input' event is
 * dispatched so the store update path runs exactly as if the user typed.
 */
const CONTACTS_DATALIST_ID = 'cybersygn-contacts-datalist';
let contactsPromise = null;

function fetchSavedContacts() {
  if (contactsPromise) return contactsPromise;
  contactsPromise = (async () => {
    try {
      // Read the sender identity without minting one: suggestions are a
      // convenience and must never create an identity as a side effect.
      let senderId = '';
      try { senderId = localStorage.getItem('cybersygn.senderId') || ''; } catch (e) {}
      senderId = senderId.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 64);
      if (!senderId) return [];
      const base = (window.CYBERSYGN_API_BASE)
        ? String(window.CYBERSYGN_API_BASE).replace(/\/$/, '')
        : '';
      const opts = { headers: { accept: 'application/json' } };
      try { if (AbortSignal && AbortSignal.timeout) opts.signal = AbortSignal.timeout(4000); } catch (e) {}
      const res = await fetch(base + '/api/sender/' + encodeURIComponent(senderId) + '/contacts', opts);
      if (!res.ok) return [];
      const data = await res.json();
      const raw = (data && Array.isArray(data.contacts)) ? data.contacts : [];
      return raw
        .filter(c => c && typeof c.email === 'string' && EMAIL_RE.test(c.email.trim()))
        .map(c => ({
          name: String(c.name || '').trim().slice(0, 80),
          email: c.email.trim(),
        }))
        .slice(0, 200);
    } catch (e) {
      return []; // offline / worker missing / bad JSON: graceful no-op
    }
  })();
  return contactsPromise;
}

function ensureContactsDatalist(contacts) {
  let dl = document.getElementById(CONTACTS_DATALIST_ID);
  if (!dl) {
    dl = document.createElement('datalist');
    dl.id = CONTACTS_DATALIST_ID;
    document.body.appendChild(dl);
  }
  if (dl.childElementCount === 0 && contacts.length > 0) {
    for (const c of contacts) {
      // Property assignment only: user text never passes through HTML.
      const opt = document.createElement('option');
      opt.value = c.email;
      if (c.name) opt.label = c.name;
      dl.appendChild(opt);
    }
  }
  return dl;
}

function wireContactQuickPick() {
  let contacts = null; // null until first load resolves

  const DEFAULT_NAMES = new Set(SIGNER_PALETTE.map(s => s.name.toLowerCase()));
  function isDefaultName(v) {
    const t = String(v || '').trim().toLowerCase();
    return t === '' || DEFAULT_NAMES.has(t) || /^signer \d+$/.test(t);
  }

  function isSignerEmailInput(el) {
    return !!(el && el.classList && el.classList.contains('signer-row__email'));
  }

  // Lazy-load on first focus of any signer email input, then attach the
  // datalist to whichever input the user is in.
  document.addEventListener('focusin', async (e) => {
    const input = e.target;
    if (!isSignerEmailInput(input)) return;
    try {
      if (contacts === null) contacts = await fetchSavedContacts();
      if (!contacts || contacts.length === 0) return; // empty: change nothing
      ensureContactsDatalist(contacts);
      if (!input.getAttribute('list')) input.setAttribute('list', CONTACTS_DATALIST_ID);
    } catch (err) { /* graceful no-op */ }
  });

  // When the email exactly matches a saved contact (a datalist pick or a
  // full retype), carry the contact's name into the row's name input if
  // that input still shows a default. Dispatching 'input' runs the same
  // store-update listener a keystroke would.
  function maybeFillName(input) {
    if (!contacts || contacts.length === 0) return;
    const v = String(input.value || '').trim().toLowerCase();
    if (!v) return;
    const match = contacts.find(c => c.email.toLowerCase() === v);
    if (!match || !match.name) return;
    const body = input.closest('.signer-row__body');
    const nameInput = body && body.querySelector('.signer-row__name');
    if (!nameInput || !isDefaultName(nameInput.value)) return;
    if (nameInput.value === match.name) return;
    nameInput.value = match.name;
    nameInput.dispatchEvent(new Event('input', { bubbles: true }));
  }

  const onEmailEdit = (e) => {
    if (!isSignerEmailInput(e.target)) return;
    try { maybeFillName(e.target); } catch (err) { /* graceful no-op */ }
  };
  document.addEventListener('input', onEmailEdit);
  document.addEventListener('change', onEmailEdit);
}

if (HAS_DOM) {
  try { wireContactQuickPick(); } catch (e) { /* never break the send flow */ }
}

/**
 * Convenience: return a synthesis of completion progress for the
 * "Send" modal. Per signer: how many fields they own, how many are
 * filled, and whether they are complete.
 */
export function progressBySigner({ signers, fields, assignments, fillStore }) {
  return signers.map(signer => {
    let owned = 0;
    let filled = 0;
    for (const f of fields) {
      if (assignments.get(f.id) !== signer.id) continue;
      owned++;
      if (fillStore.get(f.id)) filled++;
    }
    return {
      signer,
      owned,
      filled,
      complete: owned > 0 && filled === owned,
      noFields: owned === 0,
    };
  });
}
