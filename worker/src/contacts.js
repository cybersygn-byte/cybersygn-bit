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
