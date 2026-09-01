/**
 * Self-serve erasure. GDPR Article 17, handled by the software, not by a human
 * reading hello@.
 *
 * WHY THIS IS EMAIL-CONFIRMED AND NOT senderId-AUTHENTICATED.
 * senderId lives in localStorage and is sent as a plain field on ordinary API
 * calls. It identifies, it does not authenticate. An endpoint that erased data
 * on a bare senderId would let anyone who ever saw one destroy that person's
 * documents. So erasure proves control of the mailbox instead: request a link,
 * click it, and only then does anything get deleted. That is also the standard
 * shape regulators expect, because it verifies the requester is the data
 * subject before acting on an irreversible request.
 *
 * WHAT SURVIVES, AND WHY IT IS NOT A GDPR PROBLEM.
 * `verify:<sha256>` records are PII-free by construction: a fingerprint of the
 * file, a signer count, and a timestamp. No name, no email, no content, and
 * nothing that can be reversed into any of those. They are kept because a
 * counterparty holding their own copy of a contract must still be able to
 * prove it is genuine, and one party must not be able to destroy the other
 * party's evidence. Erasing the data subject's personal data while keeping an
 * anonymous hash is the outcome Article 17 is designed to produce, not a
 * loophole around it.
 *
 * Billing records are also kept. Retention of invoices has an independent
 * lawful basis (a legal obligation to keep tax records), and Article 17(3)(b)
 * carves it out explicitly.
 */

import { sha256Hex } from './audit.js';

const TOKEN_KEY   = 'erase:token:';
const TOKEN_TTL   = 30 * 60;            // 30 minutes
const RECEIPT_KEY = 'erase:receipt:';
const RECEIPT_TTL = 60 * 60 * 24 * 365; // a year, so a receipt outlives a dispute

// Reads below use ns.get(key, 'json'), which is the actual Workers KV
// contract. They used to pass { json: true }, which KV does not recognise: an
// unknown options object falls back to type "text", so every read returned a
// STRING. `(await kv.get(...)) || { docs: [] }` then kept the string (truthy),
// idx.docs was undefined, and the document loop iterated nothing. Erasure
// removed the flat keys, reported success, and deleted ZERO documents, signed
// PDFs, audit certificates or signer fills.
function store(env) { return env.CYBERSYGN_DOCS; }

function randomToken() {
  const b = new Uint8Array(32);
  crypto.getRandomValues(b);
  return [...b].map(x => x.toString(16).padStart(2, '0')).join('');
}

/** Normalize an email the same way the rest of the product does. */
export function normalizeEmail(raw) {
  return String(raw || '').trim().toLowerCase();
}

/**
 * MUST match hashEmail() in auth.js and free-tier.js byte for byte, or an
 * erasure request silently resolves to a different identity and deletes
 * nothing while reporting success. Same normalization, same encoding.
 */
export async function emailHashOf(email) {
  return await sha256Hex(new TextEncoder().encode(normalizeEmail(email)));
}

/**
 * Mint a single-use erasure token for a verified mailbox.
 * Returns the token, or null when this email owns nothing (the caller must
 * still answer identically either way, so the endpoint cannot be used to test
 * whether an account exists).
 */
/**
 * Find EVERY senderId this email address owns.
 *
 * The first version read only the magic-link binding, which meant a free-tier
 * user (who has no binding until they use a login link) resolved to
 * senderId:null. Erasure then skipped every document and still answered
 * "Done. It is gone." Measured: 1 document in, 0 deleted, success reported.
 * A deletion feature that lies is worse than no deletion feature.
 *
 * Three independent sources, because the product binds identity three ways:
 *  - login:email:<hash>      the magic-link workspace binding
 *  - sender-email:<senderId> the reverse map written when a doc is created,
 *                            which is the ONLY link a free-tier sender has
 *  - sub:<senderId>.email    a paying customer who never used a login link
 *
 * Returns a de-duplicated array. One address really can own several senderIds
 * (a person who used two browsers before ever logging in), and erasing one of
 * them while reporting success would be the same lie in a smaller costume.
 */
export async function resolveSenderIds(env, emailHash) {
  const kv = store(env);
  const found = new Set();

  try {
    const bound = await kv.get(`login:email:${emailHash}`, 'json');
    if (bound && bound.senderId) found.add(String(bound.senderId));
  } catch (e) {}

  // Reverse index + billing records. Both need a scan, which is acceptable
  // here: erasure is rare, and correctness outranks a few extra reads.
  for (const [prefix, match] of [['sender-email:', 'reverse'], ['sub:', 'billing']]) {
    let cursor;
    let pages = 0;
    try {
      do {
        const page = await kv.list({ prefix, limit: 1000, cursor });
        for (const entry of (page.keys || [])) {
          const key = entry.name;
          if (!key.startsWith(prefix)) continue;
          const sid = key.slice(prefix.length);
          if (!/^[A-Za-z0-9_-]{1,128}$/.test(sid)) continue;
          if (match === 'reverse') {
            const v = await kv.get(key);
            if (typeof v === 'string' && v.trim().toLowerCase() === emailHash) found.add(sid);
          } else {
            const sub = await kv.get(key, 'json');
            if (sub && typeof sub.email === 'string' && sub.email) {
              const h = await emailHashOf(sub.email);
              if (h === emailHash) found.add(sid);
            }
          }
        }
        cursor = page.list_complete ? null : page.cursor;
        pages++;
      } while (cursor && pages < 20);
    } catch (e) { /* a failed source must not hide the ones that worked */ }
  }

  return [...found];
}

export async function mintErasureToken(env, email, scope) {
  const emailHash = await emailHashOf(email);
  const senderIds = await resolveSenderIds(env, emailHash);
  const freeRec = await store(env).get(`free:${emailHash}`);
  const dripRec = await store(env).get(`drip:${emailHash}`);
  if (!senderIds.length && !freeRec && !dripRec) return null;

  const token = randomToken();
  await store(env).put(TOKEN_KEY + token, JSON.stringify({
    v: 2,
    emailHash,
    senderIds,
    scope: scope === 'documents' ? 'documents' : 'account',
    createdAt: new Date().toISOString(),
  }), { expirationTtl: TOKEN_TTL });
  return token;
}

/** Consume a token. Single use: it is deleted before any erasure runs. */
export async function consumeErasureToken(env, token) {
  if (typeof token !== 'string' || !/^[a-f0-9]{64}$/.test(token)) return null;
  const key = TOKEN_KEY + token;
  const raw = await store(env).get(key);
  if (!raw) return null;
  // Delete FIRST. If erasure then fails halfway, the user re-requests rather
  // than a live token sitting around able to fire a second destructive run.
  await store(env).delete(key);
  try { return JSON.parse(raw); } catch (e) { return null; }
}

async function safeDelete(kv, key, tally) {
  try { await kv.delete(key); tally.deleted++; }
  catch (e) { tally.errors.push(key); }
}

/**
 * Erase everything personal tied to one identity.
 *
 * Deliberately conservative about what it touches: it walks the sender's own
 * document index rather than scanning by prefix, so a bug here can only ever
 * delete documents that index already claimed belonged to this person.
 */
export async function eraseIdentity(env, claim) {
  const kv = store(env);
  const emailHash = claim.emailHash;
  const scope = claim.scope;
  // v1 tokens carried a single senderId; v2 carries the full set.
  const senderIds = Array.isArray(claim.senderIds)
    ? claim.senderIds
    : (claim.senderId ? [claim.senderId] : []);

  const tally = {
    documents: 0, deleted: 0, keptVerifyRecords: 0,
    errors: [], scanComplete: true, senderIds: senderIds.length,
  };

  // A missing PDF namespace must NOT be silently skipped while still
  // reporting a clean erasure: the signed PDFs and audit certificates live
  // there, and "complete" would be a lie without them.
  if (!env.CYBERSYGN_PDFS) tally.errors.push('pdfs_binding_missing');

  for (const senderId of senderIds) {
    const idx = (await kv.get(`sender:${senderId}:docs`, 'json')) || { docs: [] };
    for (const docId of (idx.docs || [])) {
      if (!/^[A-Za-z0-9_-]{1,128}$/.test(String(docId || ''))) continue;
      let doc = null;
      try { doc = await kv.get(`doc:${docId}`, 'json'); } catch (e) {}
      // Fail CLOSED on ownership, matching the sweep. A record with no
      // senderId is not provably this person's, so it is left alone.
      if (!doc || doc.senderId !== senderId) continue;
      await eraseOneDoc(kv, env, docId, doc, tally);
    }
    await safeDelete(kv, `sender:${senderId}:docs`, tally);

    const scan = await sweepOrphanedDocs(kv, env, senderId, tally);
    if (!scan.complete) { tally.scanComplete = false; tally.errors.push('scan_incomplete'); }
  }

  if (scope === 'documents') return tally;

  // ---- Account scope: every namespace that holds personal data ------------
  for (const senderId of senderIds) {
    await safeDelete(kv, `brand:${senderId}`, tally);
    await safeDelete(kv, `webhook:${senderId}`, tally);
    // The saved address book: counterparty names and emails. This is other
    // people's personal data, and it was readable with only the senderId.
    await safeDelete(kv, `contacts:${senderId}`, tally);
    // The REVERSE email map. Deleting only login:email: left this behind with
    // a five year TTL, while the page claimed the link was destroyed.
    await safeDelete(kv, `sender-email:${senderId}`, tally);
    await revokeApiKeysFor(kv, senderId, tally);
    await scrubBillingRecord(kv, senderId, tally);
    await scrubAmbassadorRecord(kv, senderId, emailHash, tally);
  }

  await safeDelete(kv, `login:email:${emailHash}`, tally);
  // Records keyed by something other than senderId, which every pass above
  // missed: testimonials, founding-list signups and workspace membership all
  // hold a cleartext address, and the signup record holds an IP too.
  await erasePeripheralRecords(kv, env, emailHash, senderIds, tally);
  // The cleartext marketing record. Leaving it meant the drip cron kept
  // emailing someone who had just been told their data was deleted.
  await safeDelete(kv, `drip:${emailHash}`, tally);
  await safeDelete(kv, `drip-sent:${emailHash}`, tally);

  const freeRaw = await kv.get(`free:${emailHash}`);
  if (freeRaw) {
    let rec = null;
    try { rec = JSON.parse(freeRaw); } catch (e) {}
    for (const t of ((rec && rec.tokens) || [])) await safeDelete(kv, `free-tok:${t}`, tally);
    await safeDelete(kv, `free:${emailHash}`, tally);
  }

  return tally;
}

/** Delete one document and everything derived from it. */
/**
 * Delete this document's PERMANENT R2 artifact copies.
 *
 * The daily NDJSON snapshots age out on their own in 35 days, which is what
 * /privacy/ and /erase/ promise. The signed PDF and audit certificate are
 * different: they are copied to R2 once and kept indefinitely, precisely
 * because a completed document is not expired. That makes them the one place a
 * "delete everything" could leave the signature image and the full document
 * text sitting forever, so erasure has to reach into the bucket for them.
 *
 * Mirrors the key shape written by backupSignedArtifacts: artifacts/<kind>/<id>.
 */
async function eraseR2Artifacts(env, docId, tally) {
  const r2 = env && env.CYBERSYGN_BACKUPS;
  if (!r2 || typeof r2.delete !== 'function') return;
  for (const kind of ['signed', 'audit']) {
    try { await r2.delete(`artifacts/${kind}/${docId}`); }
    catch (e) { tally.errors.push(`r2:artifacts/${kind}/${docId}`); }
  }
}

async function eraseOneDoc(kv, env, docId, doc, tally) {
  if (doc && doc.pdfSha256) tally.keptVerifyRecords++;
  await safeDelete(kv, `doc:${docId}`, tally);
  await safeDelete(kv, `meta:doc-complete-fired:${docId}`, tally);
  if (env.CYBERSYGN_PDFS) {
    try { await env.CYBERSYGN_PDFS.delete(`pdf:${docId}`); tally.deleted++; }
    catch (e) { tally.errors.push(`pdf:${docId}`); }
    try { await env.CYBERSYGN_PDFS.delete(`audit:${docId}`); tally.deleted++; }
    catch (e) { tally.errors.push(`audit:${docId}`); }
    // signed:<docId> too. This was missing, so the ONE artifact that actually
    // contains the person's signature image, their name, and the full document
    // text survived a confirmed "delete everything" erasure, and survived it
    // permanently: signed-pdf.js writes it with no expirationTtl, unlike
    // pdf:<docId> which at least ages out in 30 days. The erasure reported
    // complete while the most sensitive artifact stayed in storage.
    try { await env.CYBERSYGN_PDFS.delete(`signed:${docId}`); tally.deleted++; }
    catch (e) { tally.errors.push(`signed:${docId}`); }
  }
  // The kept R2 copies, which outlive the 35-day snapshot window by design.
  await eraseR2Artifacts(env, docId, tally);
  for (const sg of ((doc && doc.signers) || [])) {
    await safeDelete(kv, `signer-fills:${docId}:${sg.id}`, tally);
  }
  tally.documents++;
}

/**
 * Revoke every API key bound to this sender. An un-revoked key keeps
 * authenticating AS the deleted identity, so the subject deletes their account
 * while a credential that acts as them stays valid.
 */
/**
 * Namespaces holding cleartext personal data that erasure never reached.
 *
 * Each is keyed by something other than senderId, which is why the
 * senderId-driven passes above all missed them:
 *
 *   testimonial:<id>          email, name, role, location   (5 year TTL)
 *   signup:<receivedAt>-<em>  email, ip, userAgent          (NO TTL)
 *   workspace:<id>            members[].name, members[].email
 *
 * Matched on the hash of the address in the record, so the cleartext email
 * never has to be reconstructed to find them.
 */
async function erasePeripheralRecords(kv, env, emailHash, senderIds, tally) {
  const senderSet = new Set(senderIds || []);
  const matches = async (email) => {
    if (!email || typeof email !== 'string') return false;
    try { return (await emailHashOf(email)) === emailHash; } catch (e) { return false; }
  };

  // testimonial:<id>
  try {
    let cursor;
    do {
      const page = await kv.list({ prefix: 'testimonial:', limit: 1000, cursor });
      for (const entry of (page.keys || [])) {
        if (!entry.name.startsWith('testimonial:')) continue;
        let rec = null;
        try { rec = await kv.get(entry.name, 'json'); } catch (e) { continue; }
        if (!rec) continue;
        if (senderSet.has(rec.senderId) || await matches(rec.email)) {
          await safeDelete(kv, entry.name, tally);
        }
      }
      cursor = page.list_complete ? null : page.cursor;
    } while (cursor);
  } catch (e) { tally.errors.push('testimonials'); }

  // signup:<receivedAt>-<email>. The address is IN the key, so this also
  // removes the copy that a key listing alone would expose.
  try {
    let cursor;
    do {
      const page = await kv.list({ prefix: 'signup:', limit: 1000, cursor });
      for (const entry of (page.keys || [])) {
        if (!entry.name.startsWith('signup:')) continue;
        let rec = null;
        try { rec = await kv.get(entry.name, 'json'); } catch (e) { continue; }
        const email = rec && rec.email;
        if (await matches(email)) await safeDelete(kv, entry.name, tally);
      }
      cursor = page.list_complete ? null : page.cursor;
    } while (cursor);
  } catch (e) { tally.errors.push('signups'); }

  // workspace:<id> membership. The workspace belongs to other people too, so
  // the member entry is removed rather than the workspace deleted.
  try {
    let cursor;
    do {
      const page = await kv.list({ prefix: 'workspace:', limit: 1000, cursor });
      for (const entry of (page.keys || [])) {
        if (!entry.name.startsWith('workspace:')) continue;
        let ws = null;
        try { ws = await kv.get(entry.name, 'json'); } catch (e) { continue; }
        if (!ws || !Array.isArray(ws.members)) continue;
        const kept = [];
        let removed = false;
        for (const m of ws.members) {
          if (senderSet.has(m && m.senderId) || await matches(m && m.email)) { removed = true; continue; }
          kept.push(m);
        }
        if (removed) {
          ws.members = kept;
          try { await kv.put(entry.name, JSON.stringify(ws)); tally.deleted++; }
          catch (e) { tally.errors.push(entry.name); }
        }
      }
      cursor = page.list_complete ? null : page.cursor;
    } while (cursor);
  } catch (e) { tally.errors.push('workspaces'); }
}

async function revokeApiKeysFor(kv, senderId, tally) {
  try {
    const idx = await kv.get(`apikeys:${senderId}`, 'json');
    // apikeys.js writes this index as a plain ARRAY of key records
    // (apikeys.js:96-98 does idx.push(pub), and listApiKeys asserts
    // Array.isArray). The old read was `idx.keys || idx.hashes`, and on an
    // array `idx.keys` resolves to Array.prototype.keys: a FUNCTION, which is
    // truthy, so it won that || and then `for (const h of ...)` threw on a
    // non-iterable. The catch below turned that into one tally.errors entry and
    // NOTHING was ever revoked. A deleted account kept a live cs_live_
    // credential that still authenticated as its senderId.
    const entries = Array.isArray(idx)
      ? idx
      : (idx && (Array.isArray(idx.hashes) ? idx.hashes : (Array.isArray(idx.keys) ? idx.keys : []))) || [];
    const partnerIds = new Set();
    for (const h of entries) {
      const hash = typeof h === 'string' ? h : (h && h.hash);
      if (h && h.partnerId) partnerIds.add(String(h.partnerId));
      if (!hash || !/^[a-f0-9]{64}$/.test(hash)) continue;
      await safeDelete(kv, `apikey:${hash}`, tally);
    }
    await safeDelete(kv, `apikeys:${senderId}`, tally);
    // A key also lives in its partner's index. Leaving it there would keep a
    // deleted person's credential listed under the partner that issued it.
    for (const pid of partnerIds) {
      const safePid = String(pid).replace(/[^A-Za-z0-9_-]/g, '').slice(0, 64);
      if (!safePid) continue;
      try {
        const pidx = await kv.get(`apikeys:partner:${safePid}`, 'json');
        if (!Array.isArray(pidx)) continue;
        const kept = pidx.filter(e => e && e.senderId !== senderId);
        if (kept.length !== pidx.length) {
          await kv.put(`apikeys:partner:${safePid}`, JSON.stringify(kept));
          tally.deleted++;
        }
      } catch (e) { tally.errors.push(`apikeys:partner:${safePid}`); }
    }
  } catch (e) { tally.errors.push(`apikeys:${senderId}`); }
}

/**
 * Billing records are retained under the Article 17(3)(b) legal-obligation
 * carve-out, but the plaintext email inside them is not required by tax law
 * and it also keeps the subject's name and city on the public Origin wall.
 * Strip the personal fields, keep the financial ones.
 */
async function scrubBillingRecord(kv, senderId, tally) {
  try {
    const sub = await kv.get(`sub:${senderId}`, 'json');
    if (!sub) return;
    if (typeof sub !== 'object') { tally.errors.push(`sub:${senderId}:unparsed`); return; }
    let touched = false;
    // originDisplayName, NOT originName. The published field is written by
    // stripe.js:200 as originDisplayName and read by the public wall at
    // index.js:2145; 'originName' matched nothing, so an erased person's
    // chosen display name stayed listed on cybersygn.io/origin/ and in the
    // homepage proof strip, on a CORS-open, edge-cached endpoint.
    for (const f of ['email', 'name', 'displayName', 'city', 'originName', 'originDisplayName', 'originCity', 'handle']) {
      if (sub[f] !== undefined) { delete sub[f]; touched = true; }
    }
    sub.erasedAt = new Date().toISOString();
    // Always persist: erasedAt is what the Origin wall now filters on, so the
    // write has to happen even when there was nothing left to strip. The old
    // `touched || !sub.erasedAt` could never fire its second arm, because
    // erasedAt was assigned on the line above it.
    await kv.put(`sub:${senderId}`, JSON.stringify(sub));
    if (touched) tally.deleted++;
  } catch (e) { tally.errors.push(`sub:${senderId}`); }
}

/**
 * Ambassador records keep payout and tax history, which has its own lawful
 * basis, but must not keep the person's address or remain resolvable from
 * either identity index.
 */
async function scrubAmbassadorRecord(kv, senderId, emailHash, tally) {
  try {
    let code = await kv.get(`affiliate:sender:${senderId}`);
    if (!code) code = await kv.get(`affiliate:email:${emailHash}`);
    if (code && typeof code === 'string') {
      const safe = code.trim();
      if (/^[a-z0-9]{1,32}$/i.test(safe)) {
        const rec = await kv.get(`affiliate:code:${safe}`, 'json');
        if (rec) {
          delete rec.email;
          delete rec.emailHash;
          rec.erasedAt = new Date().toISOString();
          await kv.put(`affiliate:code:${safe}`, JSON.stringify(rec));
          tally.deleted++;
        }
      }
    }
    await safeDelete(kv, `affiliate:sender:${senderId}`, tally);
    await safeDelete(kv, `affiliate:email:${emailHash}`, tally);
  } catch (e) { tally.errors.push(`affiliate:${senderId}`); }
}

/**
 * Delete any remaining documents owned by `senderId` that the capped index did
 * not list. Paginated, and bounded so a pathological account cannot run the
 * request out of KV operations. Returns complete:false if the cap is hit, so
 * the caller can report an incomplete erasure instead of a false success.
 */
const SCAN_PAGE = 1000;
const SCAN_MAX_PAGES = 20;
// Workers allow ~1000 subrequests per request and KV reads count. The legacy
// scan is one read per document PRODUCT-WIDE, so it has to stop well short of
// that and say it stopped, rather than take the whole erasure down with it.
const SCAN_READ_BUDGET = 400;

const BACKFILL_STATE_KEY = 'meta:doc-of-backfill';
const BACKFILL_BATCH = 200;

/**
 * Backfill doc-of:<senderId>:<docId> for documents created before that key
 * existed, so the erasure sweep can stop scanning the whole namespace.
 *
 * Resumable: stores its cursor and picks up where it left off, a bounded batch
 * per cron tick, so it never competes with a user request for subrequests.
 * When it finishes it sets done:true, and sweepOrphanedDocs then skips the
 * legacy scan entirely and an erasure costs reads proportional to the user's
 * own documents rather than to the whole product.
 */
export async function backfillOwnershipIndex(env) {
  const kv = env && env.CYBERSYGN_DOCS;
  if (!kv || typeof kv.list !== 'function') return { ok: false, reason: 'kv_unavailable' };
  let state = {};
  try { state = JSON.parse(await kv.get(BACKFILL_STATE_KEY) || '{}') || {}; } catch (e) { state = {}; }
  if (state.done) return { ok: true, done: true, indexed: state.indexed || 0 };

  let indexed = state.indexed || 0;
  let scanned = 0;
  let cursor = state.cursor || undefined;
  try {
    const page = await kv.list({ prefix: 'doc:', limit: BACKFILL_BATCH, cursor });
    for (const entry of (page.keys || [])) {
      scanned += 1;
      const docId = entry.name.slice('doc:'.length);
      if (!docId || !/^[A-Za-z0-9_-]{1,128}$/.test(docId)) continue;
      let doc = null;
      try { doc = await kv.get(entry.name, 'json'); } catch (e) { continue; }
      const senderId = doc && typeof doc.senderId === 'string' ? doc.senderId.replace(/[^A-Za-z0-9_-]/g, '') : '';
      if (!senderId) continue;
      try { await kv.put(`doc-of:${senderId}:${docId}`, '1'); indexed += 1; } catch (e) { /* retried next tick */ }
    }
    cursor = page.list_complete ? null : page.cursor;
    const next = cursor ? { cursor, indexed } : { done: true, indexed };
    await kv.put(BACKFILL_STATE_KEY, JSON.stringify(next));
    return { ok: true, done: !cursor, indexed, scanned };
  } catch (e) {
    return { ok: false, reason: 'scan_failed', error: (e && e.message) || 'unknown', indexed };
  }
}

async function sweepOrphanedDocs(kv, env, senderId, tally) {
  // FAST PATH: ownership is in the key name.
  //
  // doc-of:<senderId>:<docId> is written at creation, so this lists a
  // sender-scoped prefix and establishes ownership without reading anything.
  // Cost is proportional to THIS user's documents. The legacy scan below is
  // one read per document in the entire product, which past roughly a thousand
  // documents exhausted the request's subrequest budget mid-sweep, so an
  // erasure would stop partway while still printing "Done. It is gone."
  let ownedCursor;
  try {
    do {
      const ownPrefix = `doc-of:${senderId}:`;
      const page = await kv.list({ prefix: ownPrefix, limit: SCAN_PAGE, cursor: ownedCursor });
      for (const entry of (page.keys || [])) {
        // NEVER TRUST THE LISTING, same rule as the legacy scan below. A list()
        // that ignores its prefix would otherwise hand us an auth binding or a
        // brand record, and the delete at the end of this loop would destroy
        // it. Re-assert the namespace on the key we were actually given.
        if (typeof entry.name !== 'string' || !entry.name.startsWith(ownPrefix)) continue;
        const docId = entry.name.slice(ownPrefix.length);
        if (!docId || !/^[A-Za-z0-9_-]{1,128}$/.test(docId)) continue;
        let doc = null;
        try { doc = await kv.get(`doc:${docId}`, 'json'); } catch (e) { /* delete the derived keys anyway */ }
        // The ownership key is this sender's by construction, so a missing or
        // unreadable doc record must not stop the artifacts being removed.
        if (doc && doc.pdfSha256) tally.keptVerifyRecords++;
        await eraseOneDoc(kv, env, docId, doc, tally);
        await safeDelete(kv, entry.name, tally);
      }
      ownedCursor = page.list_complete ? null : page.cursor;
    } while (ownedCursor);
  } catch (e) {
    return { complete: false };
  }

  // LEGACY PATH, for documents created before the ownership key existed.
  //
  // Skipped entirely once backfillOwnershipIndex has finished, because at that
  // point every document has an ownership key and the pass above is complete by
  // construction. Until then it is bounded by a real read budget: an honest
  // incomplete answer beats blowing the subrequest limit and failing the whole
  // request halfway through while the page says "Done. It is gone."
  try {
    const st = JSON.parse((await kv.get(BACKFILL_STATE_KEY)) || '{}');
    if (st && st.done) return { complete: true };
  } catch (e) { /* fall through to the scan */ }

  let reads = 0;
  let cursor;
  let pages = 0;
  try {
    do {
      const page = await kv.list({ prefix: 'doc:', limit: SCAN_PAGE, cursor });
      for (const entry of (page.keys || [])) {
        const key = entry.name;
        // Never trust the listing to have filtered for us. A list that ignores
        // or mishandles the prefix would otherwise hand us keys from other
        // namespaces, and any record that merely HAS a matching senderId field
        // (an auth binding, a brand record) would be destroyed as if it were a
        // document. Re-assert the namespace here.
        if (!key.startsWith('doc:')) continue;
        const docId = key.slice('doc:'.length);
        // A doc id is opaque but must not contain separators that could let a
        // crafted id address a different namespace in the derived keys below.
        if (!docId || !/^[A-Za-z0-9_-]{1,128}$/.test(docId)) continue;
        // Stop before the request runs out of subrequests. Reporting an
        // incomplete scan lets the caller say so; running out mid-sweep would
        // fail the request while the page claims the erasure finished.
        if (reads >= SCAN_READ_BUDGET) return { complete: false, budgetExhausted: true };
        let doc = null;
        reads += 1;
        try { doc = await kv.get(key, 'json'); } catch (e) { continue; }
        // Only this sender's documents. Anything else is untouched.
        if (!doc || doc.senderId !== senderId) continue;
        // Anything the ownership pass already erased reads back as null above
        // and is skipped by the guard, so no extra check is needed here.

        if (doc.pdfSha256) tally.keptVerifyRecords++;
        await safeDelete(kv, key, tally);
        await safeDelete(kv, `meta:doc-complete-fired:${docId}`, tally);
        if (env.CYBERSYGN_PDFS) {
          try { await env.CYBERSYGN_PDFS.delete(`pdf:${docId}`); tally.deleted++; } catch (e) { tally.errors.push(`pdf:${docId}`); }
          try { await env.CYBERSYGN_PDFS.delete(`audit:${docId}`); tally.deleted++; } catch (e) { tally.errors.push(`audit:${docId}`); }
          // signed: here too, for the same reason as eraseOneDoc: the sweep is
          // the path that catches documents missing from the 200-entry index,
          // so leaving it out would keep the signature image for exactly the
          // heaviest users the sweep exists to serve.
          try { await env.CYBERSYGN_PDFS.delete(`signed:${docId}`); tally.deleted++; } catch (e) { tally.errors.push(`signed:${docId}`); }
          await eraseR2Artifacts(env, docId, tally);
        }
        for (const sg of (doc.signers || [])) {
          await safeDelete(kv, `signer-fills:${docId}:${sg.id}`, tally);
        }
        tally.documents++;
      }
      cursor = page.list_complete ? null : page.cursor;
      pages++;
    } while (cursor && pages < SCAN_MAX_PAGES);
  } catch (e) {
    return { complete: false };
  }
  return { complete: !cursor };
}

/**
 * Write a PII-FREE receipt. It records that an erasure happened and what it
 * touched, which is what demonstrates compliance, without re-storing the very
 * identifiers the request existed to remove. The emailHash is a one-way digest
 * and is the only linkage kept.
 */
export async function writeErasureReceipt(env, { emailHash, scope, tally }) {
  const id = randomToken().slice(0, 32);
  const receipt = {
    v: 1,
    id,
    emailHash,
    scope,
    documents: tally.documents,
    keysDeleted: tally.deleted,
    verifyRecordsKept: tally.keptVerifyRecords,
    errors: tally.errors.length,
    completedAt: new Date().toISOString(),
  };
  try {
    await store(env).put(RECEIPT_KEY + id, JSON.stringify(receipt), { expirationTtl: RECEIPT_TTL });
  } catch (e) { /* the response still carries the receipt */ }
  return receipt;
}
