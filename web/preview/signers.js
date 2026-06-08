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
      // Empty email is "not yet provided" (null), not invalid. A non-empty
      // email is validated against EMAIL_RE. duplicateEmail flags a collision
      // with an existing signer (case-insensitive). The send flow reads both.
      emailValid: cleanEmail === '' ? null : EMAIL_RE.test(cleanEmail),
      duplicateEmail: cleanEmail !== '' && signers.some(
        s => s.email && s.email.toLowerCase() === cleanEmail.toLowerCase()),
    };
    signers.push(signer);
    notify();
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
