/**
 * CyberSygn preview, prototype: multi-signer routing.
 *
 * Three stores collaborate to model a multi-party signing:
 *
 *   signers      | the named parties (you, the counterparty, witnesses)
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
// sender first, counterparty second, witnesses after.
export const SIGNER_PALETTE = [
  { id: 'p1', hex: '#B83227', name: 'Sender'      },
  { id: 'p2', hex: '#2F4D7A', name: 'Counterparty' },
  { id: 'p3', hex: '#B47A1F', name: 'Witness'     },
  { id: 'p4', hex: '#2F6D6A', name: 'Co-signer'   },
];

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
   * sensible default (Sender / Counterparty / Witness) is assigned.
   */
  function add({ name, email } = {}) {
    if (signers.length >= SIGNER_PALETTE.length) {
      throw new Error(`CyberSygn supports up to ${SIGNER_PALETTE.length} signers in this prototype.`);
    }
    const index = signers.length;
    const slot = paletteFor(index);
    const cleanName = (name && name.trim()) || defaultName(index);
    const cleanEmail = (email || '').trim();
    const signer = {
      id: slot.id,
      name: cleanName,
      email: cleanEmail,
      color: slot.hex,
      initials: initialsFor(cleanName),
    };
    signers.push(signer);
    notify();
    return signer;
  }

  /**
   * Replace a signer's name or email in place. Falls back to defaults
   * if name becomes empty.
   */
  function update(id, patch) {
    const i = signers.findIndex(s => s.id === id);
    if (i < 0) return null;
    const next = { ...signers[i], ...patch };
    if (!next.name || !next.name.trim()) next.name = defaultName(i);
    next.name = next.name.trim();
    next.email = (next.email || '').trim();
    next.initials = initialsFor(next.name);
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
export function createAssignmentStore(defaultSignerId) {
  let defaultId = defaultSignerId;
  const map = new Map();
  const listeners = new Set();

  function notify() { listeners.forEach(fn => fn()); }

  function setDefault(id) { defaultId = id; }

  function get(fieldId) { return map.get(fieldId) || defaultId; }

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

  function reset() { map.clear(); notify(); }

  function onChange(fn) { listeners.add(fn); return () => listeners.delete(fn); }

  return { get, set, bulkAssign, countFor, reassignFrom, reset, setDefault, onChange };
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
  if (!name) return '?';
  const parts = String(name).trim().split(/\s+/);
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
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
