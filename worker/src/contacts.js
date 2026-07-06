/**
 * F5 saved contacts (counterparties) per sender.
 *
 * A sender's frequent signers are saved so the next send is a one-tap
 * quick-pick instead of retyping a name and email. Auto-populated from
 * each doc's signers on create, and editable via the contacts endpoints.
 *
 * Storage: `contacts:<senderId>` in the docs namespace (CYBERSYGN_DOCS).
 * Shape: { contacts: [{ id, name, email, role, lastUsedAt, useCount }] }.
 * Ordering: newest-first (most recently used at the front). Cap 200.
 *
 * Auth posture matches /api/sender/:id/docs: the senderId is itself a
 * 256-bit capability held in the sender's localStorage and passed as a
 * path segment, so possession of the id is the authorization.
 */

import { getStorage } from './storage.js';

const CONTACTS_CAP = 200;
const MAX_NAME_CHARS = 120;
const MAX_EMAIL_CHARS = 200;
const MAX_ROLE_CHARS = 60;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Sanitize a senderId the same way the docs route does. */
export function sanitizeSenderId(senderId) {
  return String(senderId || '').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 64);
}

/** True when `email` looks like a valid address. */
export function isValidContactEmail(email) {
  return typeof email === 'string' && email.length <= MAX_EMAIL_CHARS && EMAIL_RE.test(email.trim());
}

function contactsKey(safeId) {
  return `contacts:${safeId}`;
}

async function readList(storage, safeId) {
  const rec = await storage.docs.get(contactsKey(safeId), { json: true });
  if (rec && Array.isArray(rec.contacts)) return rec.contacts;
  return [];
}

async function writeList(storage, safeId, contacts) {
  await storage.docs.put(contactsKey(safeId), { contacts });
}

function newId() {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
}

/**
 * List a sender's saved contacts, newest-first.
 * @returns {Promise<Array>} the contacts array (possibly empty).
 */
export async function listContacts(env, senderId) {
  const safeId = sanitizeSenderId(senderId);
  if (!safeId) return [];
  const storage = getStorage(env);
  return readList(storage, safeId);
}

/**
 * Upsert a contact by lowercased email. On a match, bumps useCount and
 * lastUsedAt and moves the contact to the front (newest-first). On a new
 * email, prepends it. Caps the list at 200 by dropping the oldest tail.
 *
 * @returns {Promise<{ ok:boolean, reason?:string, contacts?:Array }>}
 */
export async function upsertContact(env, senderId, { name, email, role } = {}) {
  const safeId = sanitizeSenderId(senderId);
  if (!safeId) return { ok: false, reason: 'invalid_sender' };

  const cleanEmail = String(email || '').trim().slice(0, MAX_EMAIL_CHARS);
  if (!isValidContactEmail(cleanEmail)) return { ok: false, reason: 'invalid_email' };
  const cleanName = String(name || '').trim().slice(0, MAX_NAME_CHARS);
  const cleanRole = String(role || '').trim().slice(0, MAX_ROLE_CHARS);
  const key = cleanEmail.toLowerCase();
  const now = new Date().toISOString();

  const storage = getStorage(env);
  const contacts = await readList(storage, safeId);

  const idx = contacts.findIndex(c => String(c.email || '').trim().toLowerCase() === key);
  let entry;
  if (idx >= 0) {
    const existing = contacts[idx];
    entry = {
      id: existing.id || newId(),
      // Keep the freshest non-empty name/role the sender has provided.
      name: cleanName || existing.name || '',
      email: existing.email || cleanEmail,
      role: cleanRole || existing.role || '',
      lastUsedAt: now,
      useCount: (Number.isFinite(existing.useCount) ? existing.useCount : 0) + 1,
    };
    contacts.splice(idx, 1);
  } else {
    entry = {
      id: newId(),
      name: cleanName,
      email: cleanEmail,
      role: cleanRole,
      lastUsedAt: now,
      useCount: 1,
    };
  }

  contacts.unshift(entry);
  const capped = contacts.slice(0, CONTACTS_CAP);
  await writeList(storage, safeId, capped);
  return { ok: true, contacts: capped };
}

/**
 * Batch upsert of many contacts in ONE read-modify-write. Used by the
 * doc-create auto-save so an N-signer document costs a single KV read + write
 * instead of 2N sequential ops (which would exhaust the Worker subrequest
 * budget on a large signer array). Dedupes by lowercased email, skips
 * invalid emails, and only takes the first `MAX_BATCH` unique addresses.
 * Best-effort: never throws to the caller.
 *
 * @param {Array<{name?,email?,role?}>} entries
 */
export async function upsertContacts(env, senderId, entries) {
  const safeId = sanitizeSenderId(senderId);
  if (!safeId || !Array.isArray(entries) || entries.length === 0) return { ok: false };

  const MAX_BATCH = 25; // one document rarely has more real counterparties
  const now = new Date().toISOString();

  // Dedupe + clean the incoming entries first (in memory, no KV).
  const incoming = new Map(); // key: lowercased email -> { name, email, role }
  for (const e of entries) {
    const cleanEmail = String((e && e.email) || '').trim().slice(0, MAX_EMAIL_CHARS);
    if (!isValidContactEmail(cleanEmail)) continue;
    const key = cleanEmail.toLowerCase();
    if (incoming.has(key)) continue;
    incoming.set(key, {
      name: String((e && e.name) || '').trim().slice(0, MAX_NAME_CHARS),
      email: cleanEmail,
      role: String((e && e.role) || '').trim().slice(0, MAX_ROLE_CHARS),
    });
    if (incoming.size >= MAX_BATCH) break;
  }
  if (incoming.size === 0) return { ok: false };

  try {
    const storage = getStorage(env);
    const contacts = await readList(storage, safeId);
    const byKey = new Map(contacts.map(c => [String(c.email || '').trim().toLowerCase(), c]));

    for (const [key, val] of incoming) {
      const existing = byKey.get(key);
      const entry = existing ? {
        id: existing.id || newId(),
        name: val.name || existing.name || '',
        email: existing.email || val.email,
        role: val.role || existing.role || '',
        lastUsedAt: now,
        useCount: (Number.isFinite(existing.useCount) ? existing.useCount : 0) + 1,
      } : {
        id: newId(), name: val.name, email: val.email, role: val.role, lastUsedAt: now, useCount: 1,
      };
      if (existing) {
        const i = contacts.indexOf(existing);
        if (i >= 0) contacts.splice(i, 1);
      }
      contacts.unshift(entry);
      byKey.set(key, entry);
    }
    await writeList(storage, safeId, contacts.slice(0, CONTACTS_CAP));
    return { ok: true };
  } catch (e) {
    return { ok: false };
  }
}

/**
 * Remove a contact by its id.
 * @returns {Promise<{ ok:boolean, reason?:string, contacts?:Array }>}
 */
export async function removeContact(env, senderId, contactId) {
  const safeId = sanitizeSenderId(senderId);
  if (!safeId) return { ok: false, reason: 'invalid_sender' };
  const id = String(contactId || '').trim();
  if (!id) return { ok: false, reason: 'invalid_contact' };

  const storage = getStorage(env);
  const contacts = await readList(storage, safeId);
  const next = contacts.filter(c => c.id !== id);
  await writeList(storage, safeId, next);
  return { ok: true, contacts: next };
}
