#!/usr/bin/env node
/**
 * Direct test of the multi-signer Worker endpoints.
 *
 * Instead of running wrangler dev (which is slow and flaky in
 * resource-constrained sandboxes), we import the Worker module
 * directly and invoke its fetch() function with constructed Request
 * objects. The storage layer falls back to its in-memory mode when
 * no KV bindings are present, so we test against the same code path
 * production runs with bindings, minus the bindings themselves.
 *
 * Asserts that:
 *   1. /api/status reports memory storage + console email
 *   2. POST /api/docs accepts a doc, returns docId + 2 magic links
 *   3. GET /api/docs/:id/signer/:token returns only that signer's fields
 *   4. POST .../fills accepts the signer's fills
 *   5. Sender progress shows partial completion
 *   6. Second signer's fills trigger doc completion
 *   7. Invalid token is rejected
 *   8. Cross-signer fills are silently filtered (do not leak into other fields)
 *   9. PDF fetch works with valid token, fails with bad token
 */

import workerModule from '../worker/src/index.js';
import { createApiKey, revokeApiKey } from '../worker/src/apikeys.js';
import { readFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');

// Test env: storage falls back to memory, email falls back to console. The
// owner hash is set EXPLICITLY to the SHA-256 of "cybersygn-dev-owner" so the
// owner-claim test exercises the real path; production has no such fallback
// (owner.js fails closed when this secret is absent or malformed).
const env = {
  CYBERSYGN_OWNER_HASH: 'db4620902e87f722ffe92d06b1d013e58a09aacceae9fce7899456da072698b5',
};

let passed = 0;
let failed = 0;

function ok(condition, msg) {
  if (condition) { passed++; console.log(`  OK   ${msg}`); }
  else           { failed++; console.error(`  FAIL ${msg}`); }
}

async function call(method, path, body, extraHeaders) {
  const headers = { 'accept': 'application/json' };
  if (extraHeaders) {
    for (const k of Object.keys(extraHeaders)) headers[k] = extraHeaders[k];
  }
  // Browser-path doc creation requires a signup-issued free token (the
  // three-doc lifetime cap binds to the signed-up email). Auto-attach a
  // dispenser token so the whole suite exercises the real gate. Callers
  // testing the gate itself pass their own header; '' suppresses it.
  if (method === 'POST' && path === '/api/docs') {
    const explicit = Object.keys(headers).find(k => k.toLowerCase() === 'x-cybersygn-free');
    if (explicit === undefined) headers['x-cybersygn-free'] = await takeFreeUse();
    else if (headers[explicit] === '') delete headers[explicit];
  }
  let init = { method, headers };
  if (body !== undefined) {
    init.body = typeof body === 'string' ? body : JSON.stringify(body);
    headers['content-type'] = 'application/json';
    headers['content-length'] = String(init.body.length);
  }
  const req = new Request(`http://localhost${path}`, init);
  const res = await workerModule.fetch(req, env);
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch {}
  return { status: res.status, json, text, contentType: res.headers.get('content-type') };
}

// ---- Free-token dispenser ---------------------------------------------------
// Signs up throwaway harness emails as needed and hands out tokens with
// lifetime allowance remaining. Conservative accounting: a token is
// decremented per attach, while the Worker only consumes on successful
// creation, so the dispenser can never hand out an exhausted token. (The
// per-signup IP is varied to mirror the real client shape, but note the
// limiter is a no-op in this harness: checkRateLimit fails open without a
// CYBERSYGN_DOCS binding, and env is {}, so no 429 path is exercised here.)
const _freeDispenser = { token: null, left: 0, n: 0 };
async function takeFreeUse() {
  if (_freeDispenser.left <= 0) {
    _freeDispenser.n += 1;
    const n = _freeDispenser.n;
    const res = await call('POST', '/api/free/signup', {
      firstName: 'Test', lastName: 'Harness', email: `harness${n}@test.cybersygn.io`,
    }, { 'cf-connecting-ip': `10.9.${Math.floor(n / 200)}.${n % 200}` });
    if (!res.json || !res.json.freeToken) {
      throw new Error('free-token dispenser: signup failed: ' + res.text);
    }
    _freeDispenser.token = res.json.freeToken;
    _freeDispenser.left = 3;
  }
  _freeDispenser.left -= 1;
  return _freeDispenser.token;
}

// Multi-signer routing is a PAID feature. The free tier is sold as "single
// signer per document" and Solo is sold on multi-signer routing, and the Worker
// enforces that now, so every multi-signer create below runs as a subscriber,
// which is what a real one would be.
const PAID_SENDER = 'paid_multisigner_sender';
async function seedPaidSender() {
  const storageModule = await import('../worker/src/storage.js');
  const storage = storageModule.getStorage({});
  // A STRING, the way real KV holds it: getSubscription reads without the json
  // flag and JSON.parse()s the result, so seeding an object makes the parse
  // throw and the sender silently reads back as free.
  await storage.docs.put(`sub:${PAID_SENDER}`, JSON.stringify({ tier: 'pro', status: 'active' }));
}

async function main() {
  console.log('CyberSygn multi-signer end-to-end test');
  console.log('======================================\n');
  await seedPaidSender();

  // 1. Status
  console.log('1. /api/status');
  const status = await call('GET', '/api/status');
  ok(status.status === 200, 'returns 200');
  ok(status.json && status.json.storage === 'memory', 'reports memory storage');
  ok(status.json && status.json.email === 'console', 'reports console email');

  // 2. Create a document with two signers.
  console.log('\n2. POST /api/docs');
  const pdfBytes = await readFile(resolve(ROOT, 'test-pdfs', '01-simple-signature.pdf'));
  const pdfBase64 = pdfBytes.toString('base64');

  const create = await call('POST', '/api/docs', {
    title: 'Painting Contract',
    senderName: 'Nathan',
    pdfBase64,
    fields: [
      { id: 'f1', page: 1, x: 100, y: 100, width: 200, height: 20, type: 'signature', label: 'Artist sig', confidence: 0.9 },
      { id: 'f2', page: 1, x: 100, y: 80,  width: 200, height: 20, type: 'signature', label: 'Client sig', confidence: 0.9 },
      { id: 'f3', page: 1, x: 100, y: 60,  width: 200, height: 20, type: 'date',      label: 'Date',       confidence: 0.9 },
    ],
    senderId: PAID_SENDER,
    signers: [
      { id: 'p1', name: 'Artist Alice', email: 'alice@example.com' },
      { id: 'p2', name: 'Client Bob',   email: 'bob@example.com' },
    ],
    assignments: { f1: 'p1', f2: 'p2', f3: 'p2' },
  });
  ok(create.status === 201, `returns 201 (got ${create.status}: ${create.text.slice(0, 200)})`);
  ok(create.json && typeof create.json.docId === 'string', 'returns a docId');
  ok(create.json && create.json.docId.length === 32, 'docId is a 32-char hex string');
  ok(create.json && Array.isArray(create.json.signerLinks) && create.json.signerLinks.length === 2, 'returns 2 signer links');

  const docId = create.json.docId;
  const senderTok = create.json.senderToken;
  const link1 = create.json.signerLinks.find(l => l.signerId === 'p1');
  const link2 = create.json.signerLinks.find(l => l.signerId === 'p2');
  ok(link1 && link1.token.length === 64, 'signer 1 token is 64-char hex');
  ok(link2 && link2.token.length === 64, 'signer 2 token is 64-char hex');
  ok(link1.magicLink.includes(docId) && link1.magicLink.includes(link1.token), 'signer 1 link contains docId + token');
  ok(link1.sent === true, 'signer 1 invite reports sent (console mode)');

  // 3. Hydrate signer 1. Should see only their 1 field.
  console.log('\n3. GET /api/docs/:id/signer/:token (signer 1)');
  const hyd1 = await call('GET', `/api/docs/${docId}/signer/${link1.token}`);
  ok(hyd1.status === 200, `returns 200 (got ${hyd1.status}: ${hyd1.text.slice(0, 200)})`);
  ok(hyd1.json && hyd1.json.signer.name === 'Artist Alice', 'returns signer name');
  ok(hyd1.json && hyd1.json.fields.length === 1, `returns 1 owned field (got ${hyd1.json && hyd1.json.fields.length})`);
  ok(hyd1.json && hyd1.json.fields[0].id === 'f1', 'returns f1 only');

  // 4. Hydrate signer 2. Should see 2 fields.
  console.log('\n4. GET /api/docs/:id/signer/:token (signer 2)');
  const hyd2 = await call('GET', `/api/docs/${docId}/signer/${link2.token}`);
  ok(hyd2.status === 200, 'returns 200');
  ok(hyd2.json && hyd2.json.fields.length === 2, `returns 2 owned fields (got ${hyd2.json && hyd2.json.fields.length})`);
  ok(hyd2.json && hyd2.json.fields.map(f => f.id).sort().join(',') === 'f2,f3', 'returns f2 and f3');

  // 5. Signer 1 submits their field.
  console.log('\n5. POST .../fills (signer 1)');
  const sub1 = await call('POST', `/api/docs/${docId}/signer/${link1.token}/fills`, {
    fills: { f1: { kind: 'signature', dataUrl: 'data:image/png;base64,iVBORw0KGgo=' } },
  });
  ok(sub1.status === 200, `returns 200 (got ${sub1.status}: ${sub1.text.slice(0, 200)})`);
  ok(sub1.json && sub1.json.accepted === 1, 'accepts 1 fill');
  ok(sub1.json && sub1.json.signerComplete === true, 'marks signer complete');
  ok(sub1.json && sub1.json.docComplete === false, 'document not yet complete');

  // 6. Sender progress check.
  console.log('\n6. GET /api/docs/:id (sender progress)');
  const prog1 = await call('GET', `/api/docs/${docId}`);
  ok(prog1.status === 200, 'returns 200');
  ok(prog1.json && prog1.json.completedAt === null, 'doc not yet complete');
  const p1 = prog1.json.progress.find(p => p.signerId === 'p1');
  const p2 = prog1.json.progress.find(p => p.signerId === 'p2');
  ok(p1 && p1.complete === true && p1.filled === 1, 'signer 1 marked complete with 1 fill');
  ok(p2 && p2.complete === false && p2.filled === 0, 'signer 2 not yet started');

  // 7. Cross-signer protection: signer 1 tries to fill f2 (belongs to signer 2).
  console.log('\n7. Cross-signer protection');
  const bad = await call('POST', `/api/docs/${docId}/signer/${link1.token}/fills`, {
    fills: { f2: { kind: 'signature', dataUrl: 'data:image/png;base64,evil' } },
  });
  ok(bad.json && bad.json.accepted === 0, 'silently rejects fill for unowned field');
  // Confirm f2 still empty by checking signer 2's hydrate.
  const hyd2again = await call('GET', `/api/docs/${docId}/signer/${link2.token}`);
  ok(hyd2again.json && Object.keys(hyd2again.json.fills).length === 0, 'signer 2 has no fills yet');

  // 8. Signer 2 submits both fields.
  console.log('\n8. POST .../fills (signer 2, both fields, triggers completion)');
  const sub2 = await call('POST', `/api/docs/${docId}/signer/${link2.token}/fills`, {
    fills: {
      f2: { kind: 'signature', dataUrl: 'data:image/png;base64,iVBORw0KGgo=' },
      f3: { kind: 'date', text: 'May 24, 2026' },
    },
  });
  ok(sub2.json && sub2.json.accepted === 2, `accepts 2 fills (got ${sub2.json && sub2.json.accepted})`);
  ok(sub2.json && sub2.json.signerComplete === true, 'marks signer 2 complete');
  ok(sub2.json && sub2.json.docComplete === true, 'marks document complete');
  ok(sub2.json && Array.isArray(sub2.json.completionEmails) && sub2.json.completionEmails.length === 2,
     `sends 2 completion emails (got ${sub2.json && sub2.json.completionEmails && sub2.json.completionEmails.length})`);

  // 9. Final progress.
  console.log('\n9. Final progress');
  const prog2 = await call('GET', `/api/docs/${docId}`);
  ok(prog2.json && prog2.json.completedAt !== null, 'doc has completedAt');

  // 10. Invalid token rejected.
  console.log('\n10. Invalid token');
  const badHydrate = await call('GET', `/api/docs/${docId}/signer/notarealtoken`);
  ok(badHydrate.status === 403, `returns 403 (got ${badHydrate.status})`);
  const badSubmit = await call('POST', `/api/docs/${docId}/signer/notarealtoken/fills`, { fills: {} });
  ok(badSubmit.status === 403, `submit returns 403 (got ${badSubmit.status})`);
  const noDoc = await call('GET', `/api/docs/notarealdoc`);
  ok(noDoc.status === 404, `unknown doc returns 404 (got ${noDoc.status})`);

  // 11. PDF fetch with valid token.
  console.log('\n11. PDF fetch (binary path)');
  const pdfReq = new Request(`http://localhost/api/docs/${docId}/pdf?t=${link1.token}`, { method: 'GET' });
  const pdfRes = await workerModule.fetch(pdfReq, env);
  const pdfBody = await pdfRes.arrayBuffer();
  ok(pdfRes.status === 200, `returns 200 (got ${pdfRes.status})`);
  ok(pdfRes.headers.get('content-type') === 'application/pdf', 'content-type is application/pdf');
  ok(pdfBody.byteLength === pdfBytes.byteLength, `PDF round-trips intact (${pdfBody.byteLength} bytes)`);

  // 12. PDF fetch with bad token rejected.
  const badPdf = await workerModule.fetch(
    new Request(`http://localhost/api/docs/${docId}/pdf?t=bad`, { method: 'GET' }),
    env,
  );
  ok(badPdf.status === 403, `bad token returns 403 (got ${badPdf.status})`);

  // 13. Audit certificate generated on completion.
  console.log('\n13. Audit certificate');
  ok(sub2.json && typeof sub2.json.auditUrl === 'string', 'completion response includes auditUrl');
  ok(sub2.json && sub2.json.auditUrl.includes(docId), 'auditUrl contains docId');

  const auditReq = new Request(`http://localhost/api/docs/${docId}/audit?t=${link1.token}`, { method: 'GET' });
  const auditRes = await workerModule.fetch(auditReq, env);
  const auditBytes = await auditRes.arrayBuffer();
  ok(auditRes.status === 200, `audit returns 200 (got ${auditRes.status})`);
  ok(auditRes.headers.get('content-type') === 'application/pdf', 'audit content-type is application/pdf');
  ok(auditBytes.byteLength > 1000, `audit PDF is non-trivial (${auditBytes.byteLength} bytes)`);
  // Quick PDF magic-bytes check.
  const head = new Uint8Array(auditBytes).slice(0, 4);
  const headStr = String.fromCharCode(...head);
  ok(headStr === '%PDF', `audit bytes start with %PDF (got "${headStr}")`);

  // 14. Audit fetch protected by token.
  const badAudit = await workerModule.fetch(
    new Request(`http://localhost/api/docs/${docId}/audit?t=bad`, { method: 'GET' }),
    env,
  );
  ok(badAudit.status === 403, `audit with bad token returns 403 (got ${badAudit.status})`);

  // 15. Audit completion email mentions the certificate URL.
  const lastCompletionEmail = sub2.json && sub2.json.completionEmails && sub2.json.completionEmails[0];
  // The completion email object only carries delivery metadata, not the
  // body. We confirm the auditUrl flag exists; the body content is
  // verified by reading the email.js source.
  ok(lastCompletionEmail && lastCompletionEmail.delivered === true, 'completion email delivered');

  // 16. Audit certificate contents (parse with pdf-lib for evidence the
  //     critical text strings actually landed in the PDF).
  console.log('\n16. Audit certificate contents');
  const { PDFDocument } = await import('pdf-lib');
  const certDoc = await PDFDocument.load(auditBytes);
  ok(certDoc.getPageCount() >= 1, `audit cert has at least one page (${certDoc.getPageCount()})`);
  const certTitle = certDoc.getTitle();
  ok(certTitle && certTitle.includes('Audit certificate'), `cert title is correct (got "${certTitle}")`);
  ok(certDoc.getCreator() === 'CyberSygn', 'cert creator is CyberSygn');

  // 17. Event log captured every meaningful action.
  console.log('\n17. Event log');
  const progAfterAudit = await call('GET', `/api/docs/${docId}`);
  ok(progAfterAudit.json && progAfterAudit.json.completedAt, 'doc is complete');
  // Reach into doc.events via a re-hydrate trick: we don't expose
  // events on the public progress endpoint, but the audit cert itself
  // is the proof. We can also check our test received completion=true
  // earlier as the proxy for 'completed' event recorded.
  ok(sub2.json && sub2.json.docComplete === true, 'completion event implicitly recorded');

  // 18. Reminders: separate flow on a fresh, incomplete doc.
  console.log('\n18. Reminders');
  const { runReminderSweep } = await import('../worker/src/index.js');
  // Create a second doc that nobody signs yet.
  const create2 = await call('POST', '/api/docs', {
    title: 'Reminder Test',
    senderName: 'Nathan',
    pdfBase64,
    fields: [
      { id: 'g1', page: 1, x: 50, y: 50, width: 200, height: 20, type: 'signature', label: 'Sig', confidence: 0.9 },
    ],
    signers: [
      { id: 'p1', name: 'Pending Pat', email: 'pat@example.com' },
    ],
    assignments: { g1: 'p1' },
  });
  ok(create2.status === 201, `second doc created (got ${create2.status})`);
  const docId2 = create2.json.docId;
  const sTok2 = create2.json.senderToken;
  const link2_p1 = create2.json.signerLinks[0];

  // A reminder is an email we send to a third party in the sender's name, so
  // it must not be triggerable by anyone who merely learned the docId.
  const remindNoTok = await call('POST', `/api/docs/${docId2}/remind/p1`);
  ok(remindNoTok.status === 403, `reminder without a sender token is refused (got ${remindNoTok.status})`);

  // Manual reminder.
  const remind = await call('POST', `/api/docs/${docId2}/remind/p1?s=${sTok2}`);
  ok(remind.status === 200, `manual reminder returns 200 (got ${remind.status})`);
  ok(remind.json && remind.json.delivered === true, 'reminder reports delivered');
  ok(remind.json && remind.json.tone === 'first', `first reminder tone is "first" (got "${remind.json && remind.json.tone}")`);
  ok(remind.json && remind.json.reminderCount === 1, `count is 1 (got ${remind.json && remind.json.reminderCount})`);

  // Rate limit: second immediate call rejected.
  const remindAgain = await call('POST', `/api/docs/${docId2}/remind/p1?s=${sTok2}`);
  ok(remindAgain.status === 429, `rate-limited 1-minute wall returns 429 (got ${remindAgain.status})`);

  // Reminder for non-existent signer.
  const noSigner = await call('POST', `/api/docs/${docId2}/remind/nope?s=${sTok2}`);
  ok(noSigner.status === 404, `unknown signer returns 404 (got ${noSigner.status})`);

  // Reminder for the already-completed Alice (from doc 1) should be 409.
  const completedRemind = await call('POST', `/api/docs/${docId}/remind/p1?s=${senderTok}`);
  ok(completedRemind.status === 409, `reminder for completed signer returns 409 (got ${completedRemind.status})`);

  // Cron sweep: should skip docs whose schedule has not elapsed yet (just sent one minute ago).
  const sweep = await runReminderSweep({});
  ok(sweep && typeof sweep.docsScanned === 'number', 'sweep returns docsScanned');
  ok(sweep.remindersSent === 0, `nothing to send right now (got ${sweep.remindersSent})`);

  // Cron sweep: force the schedule to fire by rewinding the signer's
  // lastReminderAt 25 hours in the past.
  const docRecord = await call('GET', `/api/docs/${docId2}`);
  ok(docRecord.json.progress[0].reminderCount === 1, 'progress endpoint exposes reminderCount');
  ok(docRecord.json.progress[0].lastReminderAt, 'progress endpoint exposes lastReminderAt');

  // Cron sweep: force the schedule to fire by rewinding the signer's
  // lastReminderAt 73 hours in the past. After 1 manual reminder, the
  // next step is "second" at 72 hours, so 73 hours of rewind triggers it.
  const storageModule = await import('../worker/src/storage.js');
  const storage = storageModule.getStorage({});
  const stored = await storage.docs.get(`doc:${docId2}`, { json: true });
  stored.signers[0].lastReminderAt = new Date(Date.now() - 73 * 3600 * 1000).toISOString();
  await storage.docs.put(`doc:${docId2}`, stored);

  const sweep2 = await runReminderSweep({});
  ok(sweep2.remindersSent === 1, `cron sends second reminder (got ${sweep2.remindersSent})`);

  const after = await call('GET', `/api/docs/${docId2}`);
  ok(after.json.progress[0].reminderCount === 2, `signer now at count 2 (got ${after.json.progress[0].reminderCount})`);
  // Validate the tone bumped correctly. We can't directly check the
  // sent email body from the test, but we can verify the next sweep
  // would now use "final". Rewind another 7 days and re-sweep.
  const stored2 = await storage.docs.get(`doc:${docId2}`, { json: true });
  stored2.signers[0].lastReminderAt = new Date(Date.now() - 8 * 24 * 3600 * 1000).toISOString();
  await storage.docs.put(`doc:${docId2}`, stored2);
  const sweep3 = await runReminderSweep({});
  ok(sweep3.remindersSent === 1, `cron sends final reminder (got ${sweep3.remindersSent})`);

  const after2 = await call('GET', `/api/docs/${docId2}`);
  ok(after2.json.progress[0].reminderCount === 3, `signer now at count 3, hard cap (got ${after2.json.progress[0].reminderCount})`);

  // Fourth sweep: hard-cap holds, nothing sent.
  const stored3 = await storage.docs.get(`doc:${docId2}`, { json: true });
  stored3.signers[0].lastReminderAt = new Date(Date.now() - 30 * 24 * 3600 * 1000).toISOString();
  await storage.docs.put(`doc:${docId2}`, stored3);
  const sweep4 = await runReminderSweep({});
  ok(sweep4.remindersSent === 0, `hard cap of 3 reminders enforced (got ${sweep4.remindersSent})`);

  // 19. Dashboard: sender list endpoint.
  console.log('\n19. Dashboard sender list');
  // Create two more docs from the same sender so the list has scale.
  const senderId = 'sender_' + Math.random().toString(36).slice(2, 12);
  for (let i = 0; i < 2; i++) {
    await call('POST', '/api/docs', {
      title: `Doc ${i + 1}`,
      senderName: 'Nathan',
      senderId,
      pdfBase64,
      fields: [
        { id: 'sig', page: 1, x: 50, y: 50, width: 200, height: 20, type: 'signature', label: 'Sig', confidence: 0.9 },
      ],
      signers: [{ id: 'p1', name: 'Recipient', email: `r${i}@example.com` }],
      assignments: { sig: 'p1' },
    });
  }
  const list = await call('GET', `/api/sender/${senderId}/docs`);
  ok(list.status === 200, `list returns 200 (got ${list.status})`);
  ok(list.json && list.json.docs.length === 2, `list shows both docs (got ${list.json && list.json.docs.length})`);
  // Newest-first ordering.
  ok(list.json.docs[0].title === 'Doc 2', `newest first (got "${list.json.docs[0].title}")`);
  ok(typeof list.json.docs[0].senderToken === 'string' && list.json.docs[0].senderToken.length === 64,
     'list row exposes senderToken to the sender');
  ok(list.json.docs[0].signers === 1 && list.json.docs[0].totalOwned === 1,
     'list row exposes signer + field counts');

  // 20. Empty sender list does not 404.
  console.log('\n20. Empty sender list');
  const emptyList = await call('GET', `/api/sender/no_such_sender/docs`);
  ok(emptyList.status === 200, 'unknown sender returns 200 (privacy)');
  ok(emptyList.json && emptyList.json.docs.length === 0, 'unknown sender returns empty list');

  // 21. Progress endpoint with senderToken reveals magic links.
  console.log('\n21. Sender-authenticated progress');
  const doc1Id = list.json.docs[1].docId;
  const doc1Token = list.json.docs[1].senderToken;
  const senderProg = await call('GET', `/api/docs/${doc1Id}?s=${doc1Token}`);
  ok(senderProg.status === 200, 'returns 200');
  ok(senderProg.json && senderProg.json.progress[0].magicLink,
     'sender-authenticated progress includes magicLink');
  ok(senderProg.json.progress[0].magicLink.includes(doc1Id),
     'magicLink contains docId');

  // 22. Progress endpoint without senderToken hides magic links.
  console.log('\n22. Public progress hides magic links');
  const publicProg = await call('GET', `/api/docs/${doc1Id}`);
  ok(publicProg.status === 200, 'returns 200');
  ok(!publicProg.json.progress[0].magicLink, 'no magicLink without senderToken');
  ok(!publicProg.json.auditUrl, 'no auditUrl without senderToken');
  // Every signer's name and email used to come back here with no token at all.
  // The docId travels in every signing URL, so one counterparty could harvest
  // the addresses of all the others, as could anyone who saw a forwarded link.
  ok(publicProg.json.progress[0].name === undefined,
     'no signer name without a token');
  ok(publicProg.json.progress[0].email === undefined,
     'no signer email without a token');
  ok(typeof publicProg.json.progress[0].filled === 'number',
     'non-identifying progress stays public, the signing UI needs it');
  ok(senderProg.json.progress[0].email,
     'the sender still sees signer identities');

  // 23. Bad senderToken silently degrades to public view (no 403, so
  //     a leaked docId never reveals whether a token exists).
  console.log('\n23. Bad senderToken degrades to public');
  const wrongTokenProg = await call('GET', `/api/docs/${doc1Id}?s=wrong_token`);
  ok(wrongTokenProg.status === 200, 'returns 200');
  ok(!wrongTokenProg.json.progress[0].magicLink, 'no magicLink with bad senderToken');

  // 24. Workspaces.
  console.log('\n24. Workspaces');
  const wsCreate = await call('POST', '/api/workspaces', {
    name: 'Patterson Studio',
    adminSenderId: 'alice_sender_id',
    adminName: 'Alice Patterson',
    adminEmail: 'alice@example.com',
  });
  ok(wsCreate.status === 201, `create returns 201 (got ${wsCreate.status})`);
  ok(wsCreate.json && wsCreate.json.workspaceId.length === 32, 'workspaceId is 32 hex chars');
  ok(wsCreate.json && wsCreate.json.workspaceToken.length === 64, 'workspaceToken is 64 hex chars');
  ok(wsCreate.json && wsCreate.json.adminMemberId.length === 24, 'adminMemberId is 24 hex chars');
  const wsId = wsCreate.json.workspaceId;
  const wsToken = wsCreate.json.workspaceToken;

  // 25. Workspace docs (initially empty)
  const wsDocs0 = await call('GET', `/api/workspaces/${wsId}/docs?w=${wsToken}`);
  ok(wsDocs0.status === 200, 'docs list returns 200');
  ok(wsDocs0.json && wsDocs0.json.docs.length === 0, 'no docs yet');
  ok(wsDocs0.json && wsDocs0.json.members.length === 1, 'admin is the only member');

  // 26. Workspace token required
  const wsDocsBad = await call('GET', `/api/workspaces/${wsId}/docs?w=wrong`);
  ok(wsDocsBad.status === 403, `wrong token returns 403 (got ${wsDocsBad.status})`);

  // 27. Create a doc that targets the workspace
  const wsDocCreate = await call('POST', '/api/docs', {
    title: 'Workspace Test Doc',
    senderName: 'Alice',
    senderId: 'alice_sender_id',
    workspaceId: wsId,
    pdfBase64,
    fields: [
      { id: 'sig', page: 1, x: 50, y: 50, width: 200, height: 20, type: 'signature', label: 'Sig', confidence: 0.9 },
    ],
    signers: [{ id: 'p1', name: 'Recipient', email: 'r@example.com' }],
    assignments: { sig: 'p1' },
  });
  ok(wsDocCreate.status === 201, `workspace doc created (got ${wsDocCreate.status})`);

  const wsDocs1 = await call('GET', `/api/workspaces/${wsId}/docs?w=${wsToken}`);
  ok(wsDocs1.json && wsDocs1.json.docs.length === 1, `workspace shows 1 doc (got ${wsDocs1.json && wsDocs1.json.docs.length})`);
  ok(wsDocs1.json.docs[0].createdBy && wsDocs1.json.docs[0].createdBy.name === 'Alice Patterson',
     `createdBy resolves to member name (got "${wsDocs1.json.docs[0].createdBy && wsDocs1.json.docs[0].createdBy.name}")`);

  // 28. Create an invite
  const invite = await call('POST', `/api/workspaces/${wsId}/invites?w=${wsToken}`, {
    name: 'Bob Patterson',
    email: 'bob@example.com',
  });
  ok(invite.status === 201, `invite created (got ${invite.status})`);
  ok(invite.json && invite.json.inviteId.length === 40, 'inviteId is 40 hex chars');
  ok(invite.json && invite.json.inviteUrl.includes(invite.json.inviteId), 'inviteUrl contains inviteId');

  // 29. Read invite (the join page does this on load)
  const inviteRead = await call('GET', `/api/invites/${invite.json.inviteId}`);
  ok(inviteRead.status === 200, 'invite readable');
  ok(inviteRead.json && inviteRead.json.workspaceName === 'Patterson Studio', 'invite carries workspace name');

  // 30. Accept invite as a new sender
  const accept = await call('POST', `/api/invites/${invite.json.inviteId}`, {
    senderId: 'bob_sender_id',
    name: 'Bob Patterson',
    email: 'bob@example.com',
  });
  ok(accept.status === 200, `invite accepted (got ${accept.status})`);
  ok(accept.json && accept.json.workspaceToken === wsToken, 'accept returns the same workspaceToken');
  ok(accept.json && accept.json.memberId !== wsCreate.json.adminMemberId, 'new memberId minted');

  // 31. Workspace now has two members
  const wsDocs2 = await call('GET', `/api/workspaces/${wsId}/docs?w=${wsToken}`);
  ok(wsDocs2.json && wsDocs2.json.members.length === 2, `workspace has 2 members (got ${wsDocs2.json && wsDocs2.json.members.length})`);

  // 32. Invite is consumed; second accept attempt is rejected
  const acceptAgain = await call('POST', `/api/invites/${invite.json.inviteId}`, {
    senderId: 'charlie_sender_id',
    name: 'Charlie',
    email: 'c@example.com',
  });
  ok(acceptAgain.status === 410, `consumed invite returns 410 (got ${acceptAgain.status})`);

  // 33. Bob can now send a workspace doc and Alice sees it too
  const bobDoc = await call('POST', '/api/docs', {
    title: 'Bob\'s contract',
    senderName: 'Bob',
    senderId: 'bob_sender_id',
    workspaceId: wsId,
    pdfBase64,
    fields: [{ id: 'sig', page: 1, x: 50, y: 50, width: 200, height: 20, type: 'signature', label: 'Sig', confidence: 0.9 }],
    signers: [{ id: 'p1', name: 'Counterparty', email: 'cp@example.com' }],
    assignments: { sig: 'p1' },
  });
  ok(bobDoc.status === 201, 'Bob can send to the workspace');

  const wsDocs3 = await call('GET', `/api/workspaces/${wsId}/docs?w=${wsToken}`);
  ok(wsDocs3.json && wsDocs3.json.docs.length === 2, `workspace now shows 2 docs (got ${wsDocs3.json && wsDocs3.json.docs.length})`);
  // Newest first: Bob's doc, then Alice's.
  ok(wsDocs3.json.docs[0].title === "Bob's contract", `newest first (got "${wsDocs3.json.docs[0].title}")`);
  // Resolves createdBy by senderId
  ok(wsDocs3.json.docs[0].createdBy.name === 'Bob Patterson', `Bob's doc createdBy is Bob (got "${wsDocs3.json.docs[0].createdBy.name}")`);

  // 34. Unknown workspace returns empty (not 404, privacy preserving)
  const unknownWs = await call('GET', `/api/workspaces/unknown/docs?w=anything`);
  ok(unknownWs.status === 200, `unknown workspace returns 200 (got ${unknownWs.status})`);
  ok(unknownWs.json && unknownWs.json.docs.length === 0, 'unknown workspace returns empty list');

  // ========================================================================
  // Owner backdoor
  // ========================================================================

  // 35. Wrong phrase fails with 401
  const wrongClaim = await call('POST', '/api/owner/claim', { phrase: 'definitely-not-the-phrase' });
  ok(wrongClaim.status === 401, `wrong phrase returns 401 (got ${wrongClaim.status})`);
  ok(wrongClaim.json && wrongClaim.json.error === 'invalid_phrase', 'wrong phrase returns invalid_phrase');

  // 36. Empty phrase fails
  const emptyClaim = await call('POST', '/api/owner/claim', { phrase: '' });
  ok(emptyClaim.status === 400, `empty phrase returns 400 (got ${emptyClaim.status})`);

  // 37. Correct phrase mints a token. The dev phrase is documented as
  // "cybersygn-dev-owner" and matches the DEV_OWNER_HASH baked into owner.js.
  const goodClaim = await call('POST', '/api/owner/claim', { phrase: 'cybersygn-dev-owner' });
  ok(goodClaim.status === 200, `correct phrase returns 200 (got ${goodClaim.status})`);
  ok(goodClaim.json && goodClaim.json.ok === true, 'correct phrase returns ok:true');
  ok(goodClaim.json && typeof goodClaim.json.token === 'string' && goodClaim.json.token.length === 64,
     `correct phrase returns a 64-char token (got ${goodClaim.json && goodClaim.json.token && goodClaim.json.token.length})`);
  ok(goodClaim.json && goodClaim.json.role === 'owner', 'token records role:owner');
  ok(goodClaim.json && goodClaim.json.unmetered === true, 'token records unmetered:true');

  const ownerToken = goodClaim.json.token;

  // 38. Verify endpoint accepts the token via header
  const verifyHdr = await call('GET', '/api/owner/verify', undefined, { 'X-CyberSygn-Owner': ownerToken });
  ok(verifyHdr.status === 200, `verify via header returns 200 (got ${verifyHdr.status})`);
  ok(verifyHdr.json && verifyHdr.json.ok === true, 'verify returns ok:true');
  ok(verifyHdr.json && verifyHdr.json.owner && verifyHdr.json.owner.unmetered === true, 'verify returns unmetered owner');

  // 39. Query-param tokens are REJECTED by design: tokens in URLs leak via
  // logs, history, and Referer. Header is the only accepted transport.
  const verifyQp = await call('GET', `/api/owner/verify?owner=${ownerToken}`);
  ok(verifyQp.status === 401, `verify via query param is rejected with 401 (got ${verifyQp.status})`);

  // 40. No token returns 401 ok:false
  const verifyEmpty = await call('GET', '/api/owner/verify');
  ok(verifyEmpty.status === 401, `verify without token returns 401 (got ${verifyEmpty.status})`);
  ok(verifyEmpty.json && verifyEmpty.json.ok === false, 'verify without token returns ok:false');

  // 41. A bogus token (wrong length) returns 401
  const verifyBogus = await call('GET', '/api/owner/verify', undefined, { 'X-CyberSygn-Owner': 'shorttoken' });
  ok(verifyBogus.status === 401, `bogus short token returns 401 (got ${verifyBogus.status})`);

  // 42. A bogus token (right length, wrong value) returns 401
  const fakeToken = 'a'.repeat(64);
  const verifyFake = await call('GET', '/api/owner/verify', undefined, { 'X-CyberSygn-Owner': fakeToken });
  ok(verifyFake.status === 401, `fake-but-well-formed token returns 401 (got ${verifyFake.status})`);

  // 43. Doc created with owner token gets ownerCreated:true stamped on it
  const ownerSenderId = 'owner_sender_' + Math.random().toString(16).slice(2, 10);
  const ownerDoc = await call('POST', '/api/docs', {
    title: 'Owner-mode doc',
    senderName: 'Owner',
    senderId: ownerSenderId,
    pdfBase64,
    fields: [{ id: 'f1', type: 'signature', page: 1, x: 100, y: 100, width: 200, height: 30, confidence: 0.9, label: 'Sig' }],
    signers: [{ id: 'p1', name: 'Self', email: 'self@example.com' }],
    assignments: { f1: 'p1' },
  }, { 'X-CyberSygn-Owner': ownerToken });
  ok(ownerDoc.status === 201, `owner-created doc returns 201 (got ${ownerDoc.status}: ${ownerDoc.text.slice(0, 200)})`);
  ok(ownerDoc.json && ownerDoc.json.docId, 'owner-created doc returns a docId');

  const ownerDocProgress = await call('GET', `/api/docs/${ownerDoc.json.docId}?s=${ownerSenderId}`);
  ok(ownerDocProgress.status === 200, `owner doc progress returns 200 (got ${ownerDocProgress.status})`);
  ok(ownerDocProgress.json && ownerDocProgress.json.doc && ownerDocProgress.json.doc.ownerCreated === true,
     'owner-created doc has ownerCreated:true');

  // 44. Doc created without owner token does NOT get the flag
  const normalSenderId = 'normal_sender_' + Math.random().toString(16).slice(2, 10);
  const normalDoc = await call('POST', '/api/docs', {
    title: 'Normal doc',
    senderName: 'Normal sender',
    senderId: normalSenderId,
    pdfBase64,
    fields: [{ id: 'f1', type: 'signature', page: 1, x: 100, y: 100, width: 200, height: 30, confidence: 0.9, label: 'Sig' }],
    signers: [{ id: 'p1', name: 'Self', email: 'self@example.com' }],
    assignments: { f1: 'p1' },
  });
  ok(normalDoc.status === 201, `normal doc returns 201 (got ${normalDoc.status})`);
  const normalDocProgress = await call('GET', `/api/docs/${normalDoc.json.docId}?s=${normalSenderId}`);
  ok(normalDocProgress.json && normalDocProgress.json.doc && normalDocProgress.json.doc.ownerCreated === false,
     'normal doc has ownerCreated:false');

  // 45. mode field is recorded: send (default) and in-person
  ok(normalDocProgress.json.doc.mode === 'send', `default mode is "send" (got "${normalDocProgress.json.doc.mode}")`);

  const inPersonSenderId = 'inperson_sender_' + Math.random().toString(16).slice(2, 10);
  const inPersonDoc = await call('POST', '/api/docs', {
    title: 'In-person doc',
    senderName: 'In-person',
    senderId: inPersonSenderId,
    mode: 'in-person',
    pdfBase64,
    fields: [{ id: 'f1', type: 'signature', page: 1, x: 100, y: 100, width: 200, height: 30, confidence: 0.9, label: 'Sig' }],
    signers: [{ id: 'p1', name: 'Self', email: 'self@example.com' }],
    assignments: { f1: 'p1' },
  });
  ok(inPersonDoc.status === 201, `in-person doc returns 201 (got ${inPersonDoc.status})`);
  const inPersonProgress = await call('GET', `/api/docs/${inPersonDoc.json.docId}?s=${inPersonSenderId}`);
  ok(inPersonProgress.json.doc.mode === 'in-person', `in-person mode preserved (got "${inPersonProgress.json.doc.mode}")`);

  // 38. Sender field edits: round-trip through API + audit.
  console.log('\n38. Sender field edits');
  const editsDoc = await call('POST', '/api/docs', {
    title: 'Edits Demo',
    senderName: 'Nathan',
    pdfBase64,
    fields: [
      { id: 'fA', page: 1, x: 100, y: 100, width: 200, height: 20, type: 'signature', label: 'A', confidence: 0.9 },
      { id: 'fB', page: 1, x: 100, y: 80,  width: 200, height: 20, type: 'signature', label: 'B', confidence: 0.9 },
    ],
    fieldEdits: {
      fA: {
        type: 'date',
        history: [
          { at: '2026-05-25T22:00:00.000Z',
            change: { type: 'date' },
            prev: { type: 'signature', primary: true } },
        ],
      },
      fB: {
        deleted: true,
        lastSnapshot: { type: 'signature', label: 'B', page: 1 },
        history: [
          { at: '2026-05-25T22:01:00.000Z',
            change: { deleted: true },
            prev: { type: 'signature', primary: true } },
        ],
      },
    },
    signers: [{ id: 'p1', name: 'Self', email: 'self@example.com' }],
    assignments: { fA: 'p1', fB: 'p1' },
  });
  ok(editsDoc.status === 201, `edits doc creates ok (got ${editsDoc.status})`);
  const editsDocId = editsDoc.json.docId;
  const editsToken = editsDoc.json.signerLinks[0].token;

  // The audit cert should render even with edits in the doc; we cannot
  // easily peek inside PDF text from here, but byte-size growth from
  // the additional section is a reasonable signal, and pdf-lib parse
  // confirms the document remains valid.
  const editsAuditReq = new Request(
    `http://localhost/api/docs/${editsDocId}/audit?t=${editsToken}`,
    { method: 'GET' },
  );
  const editsAuditRes = await workerModule.fetch(editsAuditReq, env);
  ok(editsAuditRes.status === 200, `edits audit returns 200 (got ${editsAuditRes.status})`);
  const editsAuditBytes = await editsAuditRes.arrayBuffer();
  ok(editsAuditBytes.byteLength > 1000, `edits audit pdf is non-trivial (${editsAuditBytes.byteLength} bytes)`);
  const editsCert = await PDFDocument.load(editsAuditBytes);
  ok(editsCert.getPageCount() >= 1, `edits audit cert has at least one page (${editsCert.getPageCount()})`);

  // 30. Sequential signing-order routing (server-side).
  console.log('\n30. Sequential signing-order routing');
  const seqPdf = (await readFile(resolve(ROOT, 'test-pdfs', '01-simple-signature.pdf'))).toString('base64');
  const seqCreate = await call('POST', '/api/docs', {
    title: 'Sequential Routing Test',
    senderName: 'Nathan',
    pdfBase64: seqPdf,
    signingOrder: 'sequential',
    fields: [
      { id: 'f1', page: 1, x: 100, y: 100, width: 200, height: 20, type: 'signature', label: 'S1', confidence: 0.9 },
      { id: 'f2', page: 1, x: 100, y: 80,  width: 200, height: 20, type: 'signature', label: 'S2', confidence: 0.9 },
      { id: 'f3', page: 1, x: 100, y: 60,  width: 200, height: 20, type: 'signature', label: 'S3', confidence: 0.9 },
    ],
    senderId: PAID_SENDER,
    signers: [
      { id: 'p1', name: 'First Signer',  email: 'first@example.com'  },
      { id: 'p2', name: 'Second Signer', email: 'second@example.com' },
      { id: 'p3', name: 'Third Signer',  email: 'third@example.com'  },
    ],
    assignments: { f1: 'p1', f2: 'p2', f3: 'p3' },
  });
  ok(seqCreate.status === 201, `sequential doc created (got ${seqCreate.status})`);
  const seqLinks = seqCreate.json.signerLinks;
  const sl1 = seqLinks.find(l => l.signerId === 'p1');
  const sl2 = seqLinks.find(l => l.signerId === 'p2');
  const sl3 = seqLinks.find(l => l.signerId === 'p3');
  ok(sl1.sent === true && !sl1.queued, 'signer 1 invited up front');
  ok(sl2.queued === true && sl2.sent === false, 'signer 2 queued, not yet invited');
  ok(sl3.queued === true && sl3.sent === false, 'signer 3 queued, not yet invited');

  const seqStorage = (await import('../worker/src/storage.js')).getStorage({});
  let seqDoc = await seqStorage.docs.get(`doc:${seqCreate.json.docId}`, { json: true });
  ok(seqDoc.signingOrder === 'sequential', 'doc records sequential order');
  ok(!!seqDoc.signers.find(s => s.id === 'p1').notifiedAt, 'signer 1 has notifiedAt stamp');
  ok(!seqDoc.signers.find(s => s.id === 'p2').notifiedAt, 'signer 2 not yet notified');

  // Signer 1 completes -> signer 2 should be invited next.
  await call('POST', `/api/docs/${seqCreate.json.docId}/signer/${sl1.token}/fills`, {
    fills: { f1: { kind: 'signature', dataUrl: 'data:image/png;base64,iVBORw0KGgo=' } },
  });
  seqDoc = await seqStorage.docs.get(`doc:${seqCreate.json.docId}`, { json: true });
  ok(!!seqDoc.signers.find(s => s.id === 'p2').notifiedAt, 'signer 2 invited after signer 1 completes');
  ok(!seqDoc.signers.find(s => s.id === 'p3').notifiedAt, 'signer 3 still queued (one at a time)');

  // Signer 2 completes -> signer 3 invited.
  await call('POST', `/api/docs/${seqCreate.json.docId}/signer/${sl2.token}/fills`, {
    fills: { f2: { kind: 'signature', dataUrl: 'data:image/png;base64,iVBORw0KGgo=' } },
  });
  seqDoc = await seqStorage.docs.get(`doc:${seqCreate.json.docId}`, { json: true });
  ok(!!seqDoc.signers.find(s => s.id === 'p3').notifiedAt, 'signer 3 invited after signer 2 completes');

  // 31. Parallel default still invites everyone at once.
  console.log('\n31. Parallel default routing');
  const parCreate = await call('POST', '/api/docs', {
    title: 'Parallel Routing Test', senderName: 'Nathan', pdfBase64: seqPdf,
    fields: [
      { id: 'f1', page: 1, x: 100, y: 100, width: 200, height: 20, type: 'signature', confidence: 0.9 },
      { id: 'f2', page: 1, x: 100, y: 80,  width: 200, height: 20, type: 'signature', confidence: 0.9 },
    ],
    senderId: PAID_SENDER,
    signers: [
      { id: 'p1', name: 'A', email: 'a@example.com' },
      { id: 'p2', name: 'B', email: 'b@example.com' },
    ],
    assignments: { f1: 'p1', f2: 'p2' },
  });
  ok(parCreate.json.signerLinks.every(l => l.sent === true && !l.queued), 'parallel: all signers invited up front');

  // 32. Template library: download serves the real pre-rendered static PDF.
  //
  // The download handler resolves the slug to the static asset
  // /templates-pdf/<slug>.pdf via env.ASSETS and streams those bytes. We
  // mock env.ASSETS.fetch here so we don't need a built dist/: a known
  // rendered slug returns 200 with real PDF bytes, anything else 404s.
  console.log('\n32. Template download (static rendered PDF)');
  const RENDERED_SLUG = 'master-services-agreement';
  const renderedPdf = await readFile(
    resolve(ROOT, 'web', 'templates-pdf', `${RENDERED_SLUG}.pdf`),
  );
  const savedAssets = env.ASSETS;
  let lastAssetPath = null;
  env.ASSETS = {
    fetch: async (req) => {
      const u = new URL(req.url);
      lastAssetPath = u.pathname;
      if (u.pathname === `/templates-pdf/${RENDERED_SLUG}.pdf`) {
        return new Response(renderedPdf, {
          status: 200,
          headers: { 'content-type': 'application/pdf' },
        });
      }
      return new Response('not found', { status: 404 });
    },
  };
  try {
    // Known rendered slug -> 200 application/pdf, real bytes, no wireframe.
    // Use the binary path (arrayBuffer) so byte counts are exact.
    const dlReq = new Request(
      `http://localhost/api/templates/download/${RENDERED_SLUG}?email=lead%40example.com&firstName=Lead`,
      { method: 'GET' },
    );
    const dlRes = await workerModule.fetch(dlReq, env);
    const dlBody = new Uint8Array(await dlRes.arrayBuffer());
    ok(dlRes.status === 200, 'rendered slug downloads 200');
    ok(dlRes.headers.get('content-type') === 'application/pdf', 'rendered slug is application/pdf');
    ok(
      dlRes.headers.get('content-disposition') === `attachment; filename="${RENDERED_SLUG}.pdf"`,
      'download has attachment content-disposition with slug filename',
    );
    ok(
      lastAssetPath === `/templates-pdf/${RENDERED_SLUG}.pdf`,
      'download resolved the static asset path',
    );
    ok(
      dlBody.byteLength === renderedPdf.length,
      `served bytes match the on-disk rendered PDF length (${dlBody.byteLength})`,
    );
    ok(
      dlBody[0] === 0x25 && dlBody[1] === 0x50 && dlBody[2] === 0x44 && dlBody[3] === 0x46,
      'served bytes are a real PDF (start %PDF)',
    );

    // Garbage / non-rendered slug with no legacy registry entry -> 404.
    const bad = await call(
      'GET',
      '/api/templates/download/totally-made-up-not-a-template?email=lead%40example.com',
    );
    ok(bad.status === 404, 'garbage slug returns 404');
    ok(bad.json && bad.json.error === 'unknown_template', 'garbage slug error=unknown_template');

    // Path-traversal attempt is sanitized away and 404s (never reaches a file).
    const traversal = await call(
      'GET',
      '/api/templates/download/master-services-agreement?email=bad',
    );
    ok(traversal.status === 400, 'missing/invalid email is rejected (400)');

    // Legacy 16 still work via wireframe fallback when no static asset exists.
    // 'non-disclosure-agreement' is in findTemplate but our mock returns 404
    // for its asset, so the handler must fall back to generateTemplatePdf.
    const legacy = await call(
      'GET',
      '/api/templates/download/non-disclosure-agreement?email=lead%40example.com',
    );
    ok(legacy.status === 200, 'legacy slug (no static asset) falls back to 200');
    ok(legacy.contentType === 'application/pdf', 'legacy fallback is application/pdf');
  } finally {
    if (savedAssets === undefined) delete env.ASSETS;
    else env.ASSETS = savedAssets;
  }

  // ---- Public API v1 (API-key authed), full lifecycle -----------------
  console.log('\n33. /api/v1 public API + API keys');
  {
    const apiPdf = (await readFile(resolve(ROOT, 'test-pdfs', '01-simple-signature.pdf'))).toString('base64');
    const A = 'Bearer ';

    const minted = await createApiKey(env, 'vyan-acct', { label: 'vyan' });
    ok(minted && /^cs_live_[A-Za-z0-9_-]{20,}$/.test(minted.key), 'mints a cs_live_ key');
    ok(minted && minted.key.length > 40, 'key is long/random');
    const key = minted.key;

    const noAuth = await call('POST', '/api/v1/documents', { pdf_base64: apiPdf, signers: [{ name: 'A', email: 'a@x.com' }] });
    ok(noAuth.status === 401, 'create without a key -> 401');
    const badAuth = await call('POST', '/api/v1/documents', { pdf_base64: apiPdf, signers: [{ name: 'A', email: 'a@x.com' }] }, { authorization: A + 'cs_live_bogusbogusbogusbogusbogus00' });
    ok(badAuth.status === 401, 'create with an unknown key -> 401');

    const me = await call('GET', '/api/v1/me', undefined, { authorization: A + key });
    ok(me.status === 200 && me.json && me.json.account === 'vyan-acct', '/me returns the bound account');

    const vCreate = await call('POST', '/api/v1/documents', {
      title: 'Vyan deal',
      pdf_base64: apiPdf,
      fields: [{ id: 'sig', type: 'signature', page: 1, x: 80, y: 80, width: 200, height: 24, confidence: 0.95, label: 'Sign' }],
      signers: [{ name: 'Dana Deal', email: 'dana@buyer.com' }],
    }, { authorization: A + key });
    ok(vCreate.status === 201, `v1 create -> 201 (got ${vCreate.status}: ${vCreate.text.slice(0, 160)})`);
    ok(vCreate.json && typeof vCreate.json.id === 'string', 'v1 create returns an id');
    ok(vCreate.json && Array.isArray(vCreate.json.signers) && vCreate.json.signers[0] &&
       typeof vCreate.json.signers[0].signing_url === 'string' &&
       vCreate.json.signers[0].signing_url.includes(vCreate.json.id),
       'v1 create returns a signing_url containing the doc id');
    const vDocId = vCreate.json.id;

    const vStatus = await call('GET', '/api/v1/documents/' + vDocId, undefined, { authorization: A + key });
    ok(vStatus.status === 200 && vStatus.json.status === 'sent', 'v1 status -> sent');
    ok(vStatus.json.signers && vStatus.json.signers[0].status === 'pending', 'v1 signer starts pending');

    // Tenant isolation: a different account's key cannot read this doc.
    const other = await createApiKey(env, 'other-acct', { label: 'other' });
    const cross = await call('GET', '/api/v1/documents/' + vDocId, undefined, { authorization: A + other.key });
    ok(cross.status === 403, 'cross-account document access -> 403');

    const det = await call('POST', '/api/v1/detect', { pdf_base64: apiPdf }, { authorization: A + key });
    ok(det.status === 200 && Array.isArray(det.json.fields), 'v1 detect returns a fields array');

    const tmpl = await call('GET', '/api/v1/templates', undefined, { authorization: A + key });
    ok(tmpl.status === 200 && Array.isArray(tmpl.json.templates), 'v1 templates returns a list');

    const voided = await call('POST', '/api/v1/documents/' + vDocId + '/void', {}, { authorization: A + key });
    ok(voided.status === 200 && voided.json.status === 'voided', 'v1 void -> voided');

    // Voiding is effective: the signer can no longer submit fills.
    const tok = new URL(vCreate.json.signers[0].signing_url).searchParams.get('t');
    const signVoided = await call('POST', `/api/docs/${vDocId}/signer/${tok}/fills`, { fills: { sig: { type: 'signature', value: 'x' } } });
    ok(signVoided.status === 410, 'signing a voided document -> 410');

    // Revoke kills the key.
    const rev = await revokeApiKey(env, 'vyan-acct', minted.id);
    ok(rev === true, 'revoke returns true');
    const afterRevoke = await call('GET', '/api/v1/me', undefined, { authorization: A + key });
    ok(afterRevoke.status === 401, 'a revoked key -> 401');
  }

  // ---- Partner provisioning + unmetered keys ---------------------------
  console.log('\n34. /api/v1 partner provisioning + unmetered keys');
  {
    const apiPdf = (await readFile(resolve(ROOT, 'test-pdfs', '01-simple-signature.pdf'))).toString('base64');
    const A = 'Bearer ';
    const mkBody = {
      pdf_base64: apiPdf,
      fields: [{ id: 'sig', type: 'signature', page: 1, x: 80, y: 80, width: 200, height: 24, confidence: 0.95, label: 'Sign' }],
      signers: [{ name: 'T', email: 't@x.com' }],
    };

    // Unmetered key never hits the free-tier cap (5 creates all succeed).
    const unmeteredKey = (await createApiKey(env, 'unmetered-acct', { label: 'u', unmetered: true })).key;
    const statuses = [];
    for (let i = 0; i < 5; i++) {
      const r = await call('POST', '/api/v1/documents', mkBody, { authorization: A + unmeteredKey });
      statuses.push(r.status);
    }
    ok(statuses.every(s => s === 201), 'unmetered key creates past the free cap (5/5 -> 201)');

    // Partner master mints individualized, unmetered tenant keys.
    const master = await createApiKey(env, 'vyan-master', { label: 'partner', unmetered: true, canProvision: true, partnerId: 'vyan' });
    const prov = await call('POST', '/api/v1/keys', { tenant_id: 'cust-1', label: 'cust1' }, { authorization: A + master.key });
    ok(prov.status === 201 && /^cs_live_/.test(prov.json.key || ''), 'partner master provisions a tenant key');
    ok(prov.json && prov.json.unmetered === true, 'provisioned tenant key is unmetered');
    ok(prov.json && prov.json.account === 'p-vyan-cust-1', 'tenant key gets its own isolated account namespace');
    const tenantKey = prov.json.key;

    // Tenant key works, is unmetered, and CANNOT mint further keys.
    const tcreate = await call('POST', '/api/v1/documents', mkBody, { authorization: A + tenantKey });
    ok(tcreate.status === 201, 'tenant key can create documents');
    const tprov = await call('POST', '/api/v1/keys', { tenant_id: 'x' }, { authorization: A + tenantKey });
    ok(tprov.status === 403, 'tenant key cannot provision further keys');

    // A plain (non-partner) key cannot provision at all.
    const noProv = await call('POST', '/api/v1/keys', { tenant_id: 'x' }, { authorization: A + unmeteredKey });
    ok(noProv.status === 403, 'a non-partner key cannot provision');

    // Master lists + revokes its tenant keys.
    const listed = await call('GET', '/api/v1/keys', undefined, { authorization: A + master.key });
    ok(listed.status === 200 && Array.isArray(listed.json.keys) && listed.json.keys.some(k => k.tenantId === 'cust-1'), 'master lists its tenant keys');
    const rev = await call('DELETE', '/api/v1/keys', { key_id: prov.json.key_id }, { authorization: A + master.key });
    ok(rev.status === 200 && rev.json.revoked === true, 'master revokes a tenant key');
    const afterRev = await call('GET', '/api/v1/me', undefined, { authorization: A + tenantKey });
    ok(afterRev.status === 401, 'revoked tenant key -> 401');
  }

  // ---- Free-tier lifetime cap binds to the email, not the senderId --------
  console.log('\n35. Free-tier lifetime cap (emailHash, senderId rotation useless)');
  {
    const mini = {
      title: 'Cap test',
      senderName: 'Capper',
      pdfBase64,
      fields: [{ id: 'sig', page: 1, x: 50, y: 50, width: 200, height: 20, type: 'signature', label: 'Sig', confidence: 0.9 }],
      signers: [{ id: 'p1', name: 'R', email: 'r@example.com' }],
      assignments: { sig: 'p1' },
    };

    // No token at all -> the create is refused up front.
    const noTok = await call('POST', '/api/docs', { ...mini, senderId: 'rotate-0' }, { 'x-cybersygn-free': '' });
    ok(noTok.status === 402 && noTok.json && noTok.json.error === 'free_signup_required',
      `tokenless create refused with free_signup_required (got ${noTok.status} ${noTok.json && noTok.json.error})`);

    // A garbage token is refused the same way.
    const badTok = await call('POST', '/api/docs', { ...mini, senderId: 'rotate-0' }, { 'x-cybersygn-free': 'f'.repeat(48) });
    ok(badTok.status === 402 && badTok.json && badTok.json.error === 'free_signup_required',
      'unknown token refused with free_signup_required');

    // Sign up one email, then burn its three lifetime docs across THREE
    // different senderIds. Rotating the senderId must not reset anything.
    const su = await call('POST', '/api/free/signup', {
      firstName: 'Cap', lastName: 'Tester', email: 'cap-tester@test.cybersygn.io',
    }, { 'cf-connecting-ip': '10.8.0.1' });
    ok(su.json && su.json.ok && su.json.freeToken && su.json.remaining === 3, 'signup issues a token with 3 remaining');
    const capTok = su.json.freeToken;

    let creates = [];
    for (let i = 1; i <= 3; i++) {
      const r = await call('POST', '/api/docs', { ...mini, senderId: `rotate-${i}` }, { 'x-cybersygn-free': capTok });
      creates.push(r.status);
    }
    ok(creates.every(s => s === 201), `three creates across three senderIds all succeed (got ${creates.join(',')})`);

    const fourth = await call('POST', '/api/docs', { ...mini, senderId: 'rotate-4-fresh' }, { 'x-cybersygn-free': capTok });
    ok(fourth.status === 402 && fourth.json && fourth.json.error === 'free_cap_reached',
      `fourth create on a FRESH senderId still refused (got ${fourth.status} ${fourth.json && fourth.json.error})`);

    // Re-signup with the same email returns the same exhausted token.
    const again = await call('POST', '/api/free/signup', {
      firstName: 'Cap', lastName: 'Tester', email: 'cap-tester@test.cybersygn.io',
    }, { 'cf-connecting-ip': '10.8.0.2' });
    ok(again.json && again.json.isReturning === true && again.json.remaining === 0,
      `re-signup returns the same account with 0 remaining (got remaining=${again.json && again.json.remaining})`);

    // The senderId -> emailHash binding was written for the GDPR path.
    const bindRaw = await storage.docs.get('sender-email:rotate-1');
    ok(typeof bindRaw === 'string' && /^[a-f0-9]{64}$/.test(bindRaw), 'sender-email binding written on free create');

    // Paid senders need no token: seed an active sub and create bare.
    await storage.docs.put('sub:paid-cap-tester', JSON.stringify({ tier: 'solo', status: 'active' }));
    const paid = await call('POST', '/api/docs', { ...mini, senderId: 'paid-cap-tester' }, { 'x-cybersygn-free': '' });
    ok(paid.status === 201, `paid sender creates with no token (got ${paid.status})`);
 
    // A LAPSED subscription must not keep the paid product.
    //
    // The gate used to read `neverPaid`, which stays false for past_due and
    // unpaid because those keep their tier, so the entire cap was skipped the
    // moment a card declined. Under Stripe's default dunning that is about
    // three weeks of unlimited product at zero revenue, every billing cycle.
    await storage.docs.put('sub:lapsed-tester', JSON.stringify({ tier: 'solo', status: 'past_due' }));
    let lapsedStatuses = [];
    for (let i = 0; i < 5; i++) {
      const r = await call('POST', '/api/docs', { ...mini, senderId: 'lapsed-tester' }, { 'x-cybersygn-free': '' });
      lapsedStatuses.push(r.status);
      if (r.status === 402) {
        ok(r.json && r.json.error === 'subscription_inactive',
          `a lapsed payer is told their subscription is inactive, not to sign up (got ${r.json && r.json.error})`);
        break;
      }
    }
    ok(lapsedStatuses.includes(402),
      `a past_due subscriber hits the free cap instead of unlimited sending (got ${lapsedStatuses.join(',')})`);

    // And the other direction: an ACTIVE subscriber must stay uncapped.
    await storage.docs.put('sub:active-tester', JSON.stringify({ tier: 'solo', status: 'active' }));
    let activeAll201 = true;
    for (let i = 0; i < 5; i++) {
      const r = await call('POST', '/api/docs', { ...mini, senderId: 'active-tester' }, { 'x-cybersygn-free': '' });
      if (r.status !== 201) { activeAll201 = false; break; }
    }
    ok(activeAll201, 'an active subscriber is never capped');
  }

  // ---- GDPR export: email-confirmed, index-backed ---------------------------
  console.log('\n36. GDPR export requires email confirmation');
  {
    const { createGdprConfirm } = await import('../worker/src/index.js');
    const { sha256Hex } = await import('../worker/src/audit.js');
    const capEmail = 'cap-tester@test.cybersygn.io'; // bound to rotate-1 in section 35
    const capHash = await sha256Hex(new TextEncoder().encode(capEmail));

    // The old capability-only GET is gone.
    const oldGet = await call('GET', '/api/sender/rotate-1/gdpr-export');
    ok(oldGet.status === 410, `legacy GET export returns 410 (got ${oldGet.status})`);

    // Unbound email: uniform 200 (no oracle) AND no pending record minted.
    const wrongMail = await call('POST', '/api/sender/rotate-1/gdpr-export/request',
      { email: 'stranger@example.com' }, { 'cf-connecting-ip': '10.7.0.1' });
    ok(wrongMail.status === 200 && wrongMail.json && wrongMail.json.ok === true,
      `unbound email gets the same 200 as a match, no oracle (got ${wrongMail.status})`);
    const noPending = await storage.docs.get('gdpr-confirm:rotate-1', { json: true });
    ok(!noPending, 'a mismatched email mints NO confirmation code');

    // Bound email -> uniform 200, and the REQUEST path itself writes a
    // valid pending record (mint + store are exercised here, not just the
    // harness-minted code used below to obtain cleartext).
    const goodReq = await call('POST', '/api/sender/rotate-1/gdpr-export/request',
      { email: capEmail }, { 'cf-connecting-ip': '10.7.0.2' });
    ok(goodReq.status === 200 && goodReq.json && goodReq.json.ok === true,
      `bound email accepted (got ${goodReq.status})`);
    const pending = await storage.docs.get('gdpr-confirm:rotate-1', { json: true });
    ok(pending && /^[a-f0-9]{64}$/.test(pending.codeHash || '') && pending.emailHash === capHash,
      'the request endpoint stored a pending record bound to the verified email');

    // Wrong code -> 403 and attempts counted; right code -> full export.
    // (Mint directly to hold the cleartext, which a SHA-256 record hides;
    // the request path's own mint/store was just asserted above.)
    const code = await createGdprConfirm({}, 'rotate-1', capHash);
    const bad = await call('POST', '/api/sender/rotate-1/gdpr-export/confirm',
      { code: 'f'.repeat(32) }, { 'cf-connecting-ip': '10.7.0.3' });
    ok(bad.status === 403 && bad.json && bad.json.error === 'wrong_code', `wrong code refused (got ${bad.status})`);

    const good = await call('POST', '/api/sender/rotate-1/gdpr-export/confirm',
      { code }, { 'cf-connecting-ip': '10.7.0.4' });
    ok(good.status === 200 && good.json && good.json.ok === true, `right code returns the export (got ${good.status})`);
    const docRecords = (good.json && good.json.records || []).filter(r => r.label === 'doc');
    ok(docRecords.length === 1, `export lists exactly the sender's 1 indexed doc (got ${docRecords.length})`);
    ok((good.json.records || []).some(r => r.label === 'free_contact'), 'export includes the verified email contact record');

    // Single use: the same code again -> 410.
    const replay = await call('POST', '/api/sender/rotate-1/gdpr-export/confirm',
      { code }, { 'cf-connecting-ip': '10.7.0.5' });
    ok(replay.status === 410, `code is single-use (got ${replay.status})`);

    // Paid binding path: sub record email verifies too.
    await storage.docs.put('sub:gdpr-paid', JSON.stringify({ tier: 'solo', status: 'active', email: 'buyer@example.com' }));
    const paidReq = await call('POST', '/api/sender/gdpr-paid/gdpr-export/request',
      { email: 'buyer@example.com' }, { 'cf-connecting-ip': '10.7.0.6' });
    ok(paidReq.status === 200 && paidReq.json && paidReq.json.ok === true,
      `subscription email verifies a paid sender (got ${paidReq.status})`);
  }

  // ---- Lost-signature race: presence off the doc record, ink survives ------
  console.log('\n37. Co-signing race safety');
  {
    const race = await call('POST', '/api/docs', {
      title: 'Race doc',
      senderName: 'Racer',
      pdfBase64,
      fields: [
        { id: 'ra', page: 1, x: 50, y: 90, width: 200, height: 20, type: 'signature', label: 'A', confidence: 0.9 },
        { id: 'rb', page: 1, x: 50, y: 60, width: 200, height: 20, type: 'signature', label: 'B', confidence: 0.9 },
      ],
      senderId: PAID_SENDER,
      signers: [
        { id: 'p1', name: 'Racer A', email: 'ra@example.com' },
        { id: 'p2', name: 'Racer B', email: 'rb@example.com' },
      ],
      assignments: { ra: 'p1', rb: 'p2' },
    });
    ok(race.status === 201, `race doc created (got ${race.status})`);
    const rDocId = race.json.docId;
    const rA = race.json.signerLinks.find(l => l.signerId === 'p1');
    const rB = race.json.signerLinks.find(l => l.signerId === 'p2');

    // Presence heartbeat must not rewrite the doc record at all.
    // (Memory mode hands out live references, so compare deep snapshots.)
    const docBefore = JSON.stringify(await storage.docs.get(`doc:${rDocId}`, { json: true }));
    const hb = await call('POST', `/api/docs/${rDocId}/live?t=${rA.token}`, { currentPage: 2 });
    ok(hb.status === 200, `heartbeat accepted (got ${hb.status})`);
    const docAfter = JSON.stringify(await storage.docs.get(`doc:${rDocId}`, { json: true }));
    ok(docBefore === docAfter, 'heartbeat leaves doc:<id> byte-identical (no more read-modify-write)');
    const presKey = await storage.docs.get(`presence:${rDocId}:p1`, { json: true });
    ok(presKey && presKey.currentPage === 2, 'presence lives in its own per-signer key');
    const live = await call('GET', `/api/docs/${rDocId}/live?t=${rB.token}`);
    ok(live.status === 200 && live.json.signers.find(s => s.id === 'p1').currentPage === 2,
      'live poll reads presence from the subkey');

    // THE RACE: a stale writer overwrites the doc record right after
    // signer A submits (this is what the old presence heartbeat did).
    // Deep-copy: memory mode returns live references, and a reference
    // would silently pick up A's mutations and defeat the simulation.
    const staleCopy = JSON.parse(JSON.stringify(await storage.docs.get(`doc:${rDocId}`, { json: true })));
    const subA = await call('POST', `/api/docs/${rDocId}/signer/${rA.token}/fills`, {
      fills: { ra: { kind: 'signature', dataUrl: 'data:image/png;base64,iVBORw0KGgo=' } },
    });
    ok(subA.status === 200 && subA.json.signerComplete === true, `signer A submits and completes (got ${subA.status})`);
    await storage.docs.put(`doc:${rDocId}`, staleCopy); // lost-update simulation: A's doc write clobbered

    // A's ink must still be there for every reader.
    const hydA = await call('GET', `/api/docs/${rDocId}/signer/${rA.token}`);
    ok(hydA.status === 200 && hydA.json.fills && hydA.json.fills.ra,
      'signer A ink survives a clobbered doc write (healed from the subkey)');
    const prog = await call('GET', `/api/docs/${rDocId}`);
    const pA = prog.json.progress.find(p => p.signerId === 'p1');
    ok(pA && pA.complete === true && pA.filled === 1, 'sender progress shows A complete despite the clobber');

    // B finishes; completion is decided on the merged state, so the doc
    // completes even though A's own doc write was thrown away.
    const subB = await call('POST', `/api/docs/${rDocId}/signer/${rB.token}/fills`, {
      fills: { rb: { kind: 'signature', dataUrl: 'data:image/png;base64,iVBORw0KGgo=' } },
    });
    ok(subB.status === 200 && subB.json.docComplete === true,
      `doc completes on B's submit from merged state (got docComplete=${subB.json && subB.json.docComplete})`);
    const progDone = await call('GET', `/api/docs/${rDocId}`);
    ok(progDone.json && progDone.json.completedAt, 'persisted doc record carries completedAt');

    // NOTE: this section proves fills + per-signer completion survive a lost
    // doc write (they heal from the signer-fills subkey). doc.events live only
    // in doc:<id> and are NOT healed by the overlay, so a raw clobber still
    // drops the clobbered writer's appended events; the write-freshen re-read
    // narrows that window in production but does not fully close it.

    // Void integrity: a voided document must reject new signatures and must
    // never be silently un-voided by a subsequent submit.
    const vdoc = await call('POST', '/api/docs', {
      title: 'Void test', senderName: 'V', pdfBase64,
      fields: [{ id: 'vs', page: 1, x: 50, y: 50, width: 200, height: 20, type: 'signature', label: 'S', confidence: 0.9 }],
      senderId: PAID_SENDER,
      signers: [{ id: 'p1', name: 'V One', email: 'v1@example.com' }, { id: 'p2', name: 'V Two', email: 'v2@example.com' }],
      assignments: { vs: 'p1' },
    });
    const vId = vdoc.json.docId;
    const vTok = vdoc.json.signerLinks.find(l => l.signerId === 'p1').token;
    const rec = await storage.docs.get(`doc:${vId}`, { json: true });
    rec.voidedAt = new Date().toISOString();
    await storage.docs.put(`doc:${vId}`, rec);
    const voidSubmit = await call('POST', `/api/docs/${vId}/signer/${vTok}/fills`, {
      fills: { vs: { kind: 'signature', dataUrl: 'data:image/png;base64,iVBORw0KGgo=' } },
    });
    ok(voidSubmit.status === 410, `submit to a voided doc is refused (got ${voidSubmit.status})`);
    const afterVoid = await storage.docs.get(`doc:${vId}`, { json: true });
    ok(afterVoid.voidedAt && !afterVoid.completedAt,
      'voided doc stays voided and uncompleted after a rejected submit (no resurrection)');
  }

  // ---- /api/metrics rides rolling counters, not key scans ------------------
  console.log('\n38. Metrics rolling counters');
  {
    const { recordSubForMetrics } = await import('../worker/src/metrics-counters.js');
    env.VYAN_METRICS_KEY = 'metrics-test-key';
    try {
      const noAuth = await call('GET', '/api/metrics');
      ok(noAuth.status === 401, `metrics without key -> 401 (got ${noAuth.status})`);

      // Registry mirrors subscription writes: one active, one canceled.
      await recordSubForMetrics(env, 'op-active', { tier: 'solo', status: 'active' });
      await recordSubForMetrics(env, 'op-gone', { tier: 'solo', status: 'canceled' });

      const m = await call('GET', '/api/metrics', undefined, { authorization: 'Bearer metrics-test-key' });
      ok(m.status === 200, `metrics with key -> 200 (got ${m.status})`);
      // Registry-derived: paid-cap-tester (active solo, seeded in section 35
      // via direct KV write) is NOT in the registry, which is exactly the
      // point: only real subscription writes register. op-active is the one.
      ok(m.json && m.json.activeOperators === 1, `activeOperators from registry (got ${m.json && m.json.activeOperators})`);
      ok(m.json && m.json.revenueCents === 1200, `MRR sums registry tiers (got ${m.json && m.json.revenueCents})`);

      // Day buckets counted every create/complete this suite performed.
      ok(m.json && m.json.usage && m.json.usage.docsSent >= 5,
        `docsSent from day buckets (got ${m.json && m.json.usage && m.json.usage.docsSent})`);
      ok(m.json && m.json.usage && m.json.usage.docsCompleted >= 1,
        `docsCompleted from day buckets (got ${m.json && m.json.usage && m.json.usage.docsCompleted})`);

      // The bucket itself exists and matches what the endpoint reported.
      const today = new Date().toISOString().slice(0, 10);
      const bucket = await storage.docs.get(`metrics:day:${today}`, { json: true });
      ok(bucket && bucket.sent === m.json.usage.docsSent && bucket.completed === m.json.usage.docsCompleted,
        `today's bucket backs the endpoint (sent=${bucket && bucket.sent}, completed=${bucket && bucket.completed})`);
    } finally {
      delete env.VYAN_METRICS_KEY;
    }
  }

  // ---- Security self-check dispatches in-process (no self-fetch 522) --------
  console.log('\n39. Security self-check in-process dispatch');
  {
    const { runSecurityCheck } = await import('../worker/src/security-check.js');
    // The incident: every live probe returned HTTP 522 because the Worker
    // fetched its own hostname from cron and the self-subrequest timed out.
    // The fix dispatches probes straight to worker.fetch. Stub the two
    // bindings the health + header probes touch (KV binding so health is
    // 200; ASSETS so "/" is a real hardened HTML response) WITHOUT setting
    // Stripe/Resend keys, so no external API calls fire during the test.
    const kvMap = new Map();
    const kvStub = {
      async get(k) { return kvMap.has(k) ? kvMap.get(k) : null; },
      async put(k, v) { kvMap.set(k, v); },
      async delete(k) { kvMap.delete(k); },
    };
    const probeEnv = {
      ...env,
      CYBERSYGN_DOCS: kvStub, // makes handleHealth's KV probe pass -> HTTP 200
      ASSETS: { fetch: async () => new Response('<!doctype html><title>home</title>', { headers: { 'content-type': 'text/html; charset=utf-8' } }) },
    };
    const dispatch = (req) => workerModule.fetch(req, probeEnv, { waitUntil() {}, passThroughOnException() {} });
    const result = await runSecurityCheck(probeEnv, { trigger: 'test', dispatch, origin: 'http://localhost' });
    const by = Object.fromEntries(result.checks.map(c => [c.name, c]));

    // The exact six checks that came back HTTP 522 in the incident must now
    // reach the handler in-process and pass.
    ok(by.v1_requires_key && by.v1_requires_key.pass, `v1_requires_key passes in-process (${by.v1_requires_key && by.v1_requires_key.detail})`);
    ok(by.v1_create_requires_key && by.v1_create_requires_key.pass, 'v1_create_requires_key passes in-process');
    ok(by.owner_apikeys_requires_auth && by.owner_apikeys_requires_auth.pass, 'owner_apikeys_requires_auth passes in-process');
    ok(by.owner_metrics_requires_auth && by.owner_metrics_requires_auth.pass, `owner_metrics_requires_auth passes in-process (${by.owner_metrics_requires_auth && by.owner_metrics_requires_auth.detail})`);
    ok(by.health_responds && by.health_responds.pass, `health_responds passes in-process (${by.health_responds && by.health_responds.detail})`);
    ok(by.header_nosniff && by.header_nosniff.pass, 'header_nosniff passes in-process (hardened ASSETS response)');
    // No probe reports a network-level failure (the 522 signature was a
    // "probe failed"/5xx on every one).
    const liveNames = ['v1_requires_key','v1_create_requires_key','owner_apikeys_requires_auth','owner_metrics_requires_auth','health_responds','header_nosniff'];
    ok(liveNames.every(n => by[n] && by[n].pass), 'all six previously-522 live probes pass in-process');
  }

  // ---- F4 public verify record (PII-free) -----------------------------------
  console.log('\n40. F4 GET /api/verify/:hash (PII-free proof of a completed doc)');
  {
    // The two-signer painting contract (docId) completed back in section 6.
    // Its completion should have written a verify:<pdfSha256> record.
    const completedDoc = await storage.docs.get(`doc:${docId}`, { json: true });
    ok(completedDoc && completedDoc.completedAt, 'painting-contract doc is completed');
    const fp = completedDoc && completedDoc.pdfSha256;
    ok(typeof fp === 'string' && /^[0-9a-f]{64}$/.test(fp), `doc carries a 64-hex pdfSha256 (got ${fp && fp.slice(0, 12)}...)`);

    const found = await call('GET', `/api/verify/${fp}`);
    ok(found.status === 200, `verify returns 200 (got ${found.status})`);
    ok(found.json && found.json.found === true, 'verify reports found:true for the completed fingerprint');
    ok(found.json && found.json.fingerprint === fp, 'verify echoes the fingerprint');
    ok(found.json && found.json.signerCount === 2, `verify reports signerCount 2 (got ${found.json && found.json.signerCount})`);
    ok(found.json && typeof found.json.completedAt === 'string', 'verify exposes completedAt');
    ok(found.json && found.json.status === 'completed', 'verify status is completed');

    // ZERO PII: no name, email, title, or content ever leaves this endpoint.
    const leaked = ['name', 'email', 'title', 'senderName', 'signers', 'fields', 'content', 'senderToken']
      .filter(k => Object.prototype.hasOwnProperty.call(found.json || {}, k));
    ok(leaked.length === 0, `verify record carries no PII (leaked keys: ${leaked.join(',') || 'none'})`);
    const blob = JSON.stringify(found.json || {}).toLowerCase();
    ok(!blob.includes('alice') && !blob.includes('bob') && !blob.includes('example.com') && !blob.includes('painting'),
      'verify body contains no signer names, emails, or the doc title');

    // Cacheable for 300s (immutable record).
    // A random (well-formed but unknown) hash returns found:false.
    const randomHash = 'f'.repeat(64);
    const miss = await call('GET', `/api/verify/${randomHash}`);
    ok(miss.status === 200 && miss.json && miss.json.found === false, 'unknown fingerprint returns found:false');

    // A malformed hash is rejected without touching storage.
    const bad = await call('GET', '/api/verify/not-a-real-hash');
    ok(bad.status === 400, `malformed hash returns 400 (got ${bad.status})`);
  }

  // ---- F5 saved contacts (auto-save + upsert + remove) ----------------------
  console.log('\n41. F5 /api/sender/:id/contacts (auto-save, add, remove)');
  {
    // Create a fresh doc; its signer should be auto-saved as a contact.
    const cPdf = (await readFile(resolve(ROOT, 'test-pdfs', '01-simple-signature.pdf'))).toString('base64');
    const senderId = 'contactsender' + Math.random().toString(16).slice(2, 10);
    const create = await call('POST', '/api/docs', {
      title: 'Contacts Test Doc',
      senderName: 'Nathan',
      senderId,
      pdfBase64: cPdf,
      fields: [{ id: 'c1', page: 1, x: 100, y: 100, width: 200, height: 20, type: 'signature', label: 'Sig', confidence: 0.9 }],
      signers: [{ id: 's1', name: 'Carol Contact', email: 'carol@example.com' }],
      assignments: { c1: 's1' },
    });
    ok(create.status === 201, `create returns 201 (got ${create.status}: ${create.text.slice(0, 160)})`);

    const list1 = await call('GET', `/api/sender/${senderId}/contacts`);
    ok(list1.status === 200, `list returns 200 (got ${list1.status})`);
    const saved = (list1.json && list1.json.contacts || []).find(c => c.email === 'carol@example.com');
    ok(!!saved, 'the doc signer was auto-saved as a contact');
    ok(saved && saved.name === 'Carol Contact', 'auto-saved contact carries the signer name');
    ok(saved && saved.useCount >= 1 && saved.id && saved.lastUsedAt, 'auto-saved contact has id, useCount, lastUsedAt');

    // POST adds a new contact.
    const add = await call('POST', `/api/sender/${senderId}/contacts`, { name: 'Dave New', email: 'dave@example.com', role: 'Client' });
    ok(add.status === 200, `add returns 200 (got ${add.status})`);
    const daveInAdd = (add.json && add.json.contacts || []).find(c => c.email === 'dave@example.com');
    ok(!!daveInAdd, 'POST adds the new contact and returns the list');
    ok(daveInAdd && daveInAdd.role === 'Client', 'new contact keeps its role');
    // Newest-first: the just-added contact is at the front.
    ok(add.json.contacts[0].email === 'dave@example.com', 'newest contact is at the front');

    // POST with a bad email is rejected.
    const badAdd = await call('POST', `/api/sender/${senderId}/contacts`, { name: 'X', email: 'not-an-email' });
    ok(badAdd.status === 400, `POST with invalid email returns 400 (got ${badAdd.status})`);

    // DELETE removes by contactId.
    const del = await call('DELETE', `/api/sender/${senderId}/contacts`, { contactId: daveInAdd.id });
    ok(del.status === 200, `delete returns 200 (got ${del.status})`);
    const daveGone = !(del.json && del.json.contacts || []).some(c => c.id === daveInAdd.id);
    ok(daveGone, 'DELETE removes the contact by id');
    // Carol survives the delete.
    ok((del.json.contacts || []).some(c => c.email === 'carol@example.com'), 'other contacts survive the delete');
  }

  // 55. Cross-device sign-in (enroll-then-recover; bind only at verified confirm).
  console.log('\n55. Cross-device sign-in (auth)');
  {
    const email = 'signin-user@test.cybersygn.io';
    const sender = 'a1b2c3d4e5f6a7b8c9d0e1f2';      // this device's own senderId
    const attacker = 'ffffffffffffffffffffffff';     // a foreign senderId

    const store = (await import('../worker/src/storage.js')).getStorage(env).docs;
    const { sha256Hex } = await import('../worker/src/audit.js');
    const emailHash = await sha256Hex(new TextEncoder().encode(email));

    // Signup with a senderId must NOT create a login binding (unverified email).
    const sup = await call('POST', '/api/free/signup', {
      firstName: 'Sign', lastName: 'In', email, senderId: sender,
    }, { 'cf-connecting-ip': '10.55.0.1' });
    ok(sup.status === 200 && sup.json && sup.json.ok, `auth signup ok (got ${sup.status})`);
    ok(!('boundSenderId' in (sup.json || {})), 'signup no longer returns boundSenderId');
    const afterSignup = await store.get('login:email:' + emailHash, { json: true });
    ok(!afterSignup, 'unverified signup does NOT bind email -> senderId (pre-hijack fix)');

    // request-link is enumeration-safe: same ok:true whether or not bound.
    const r1 = await call('POST', '/api/auth/request-link', { email }, { 'cf-connecting-ip': '10.55.0.2' });
    ok(r1.status === 200 && r1.json && r1.json.ok === true, 'request-link returns ok for an unbound email');
    const r2 = await call('POST', '/api/auth/request-link', { email: 'nobody-here@test.cybersygn.io' }, { 'cf-connecting-ip': '10.55.0.3' });
    ok(r2.status === 200 && r2.json && r2.json.ok === true, 'request-link returns the same ok for another email (no enumeration)');
    ok(!('senderId' in (r1.json || {})), 'request-link never leaks a senderId in its response');

    // ENROLL: verifying an enroll token binds THIS device's senderId (from the
    // request body), not any caller-chosen id. An enroll token carries no senderId.
    const enrollTok = 'a'.repeat(48);
    await store.put('login:token:' + enrollTok, { v: 1, mode: 'enroll', emailHash, exp: Date.now() + 60000 });
    const noSender = await call('POST', '/api/auth/verify', { token: enrollTok }, { 'cf-connecting-ip': '10.55.0.4' });
    ok(noSender.status === 400, 'enroll verify without a senderId is rejected (need_sender)');
    // token was consumed by the attempt above; mint a fresh one.
    const enrollTok2 = 'b'.repeat(48);
    await store.put('login:token:' + enrollTok2, { v: 1, mode: 'enroll', emailHash, exp: Date.now() + 60000 });
    const enroll = await call('POST', '/api/auth/verify', { token: enrollTok2, senderId: sender }, { 'cf-connecting-ip': '10.55.0.5' });
    ok(enroll.status === 200 && enroll.json && enroll.json.senderId === sender, 'enroll verify binds and returns THIS device senderId');
    const bound = await store.get('login:email:' + emailHash, { json: true });
    ok(bound && bound.senderId === sender, 'binding now exists, pointing at this device senderId');

    // Single use: the same enroll token cannot be replayed.
    const replay = await call('POST', '/api/auth/verify', { token: enrollTok2, senderId: sender }, { 'cf-connecting-ip': '10.55.0.6' });
    ok(replay.status === 400, 'verify rejects a reused token (single-use)');

    // First-bind-wins: a second enroll (foreign senderId) cannot steal the email.
    const enrollTok3 = 'c'.repeat(48);
    await store.put('login:token:' + enrollTok3, { v: 1, mode: 'enroll', emailHash, exp: Date.now() + 60000 });
    const steal = await call('POST', '/api/auth/verify', { token: enrollTok3, senderId: attacker }, { 'cf-connecting-ip': '10.55.0.7' });
    ok(steal.status === 200 && steal.json && steal.json.senderId === sender, 'first-bind-wins: foreign senderId cannot rebind a live account');

    // RECOVER: a recover token returns the bound senderId, ignoring any body senderId.
    const recTok = 'd'.repeat(48);
    await store.put('login:token:' + recTok, { v: 1, mode: 'recover', senderId: sender, emailHash, exp: Date.now() + 60000 });
    const rec = await call('POST', '/api/auth/verify', { token: recTok, senderId: attacker }, { 'cf-connecting-ip': '10.55.0.8' });
    ok(rec.status === 200 && rec.json && rec.json.senderId === sender, 'recover verify returns the bound senderId (not a body-supplied one)');

    // Malformed + expired tokens are rejected.
    const bad = await call('POST', '/api/auth/verify', { token: 'nothex!!', senderId: sender }, { 'cf-connecting-ip': '10.55.0.9' });
    ok(bad.status === 400, 'verify rejects a malformed token');
    const expTok = 'e'.repeat(48);
    await store.put('login:token:' + expTok, { v: 1, mode: 'recover', senderId: sender, emailHash, exp: Date.now() - 1000 });
    const expRes = await call('POST', '/api/auth/verify', { token: expTok, senderId: sender }, { 'cf-connecting-ip': '10.55.0.10' });
    ok(expRes.status === 400, 'verify rejects an expired token');
  }

  // 56. Pricing add-ons: purchasability + no entitlement clobber.
  console.log('\n56. Pricing add-ons (purchasability + entitlement safety)');
  {
    const stripe = await import('../worker/src/stripe.js');
    const store = (await import('../worker/src/storage.js')).getStorage(env).docs;

    // purchasableTiers requires BOTH monthly and annual for a subscription tier
    // (annual is the default cycle, so a missing *_annual would dead-end).
    const pMonthlyOnly = stripe.purchasableTiers({ STRIPE_PRICE_PRO: 'price_x' });
    ok(pMonthlyOnly.pro === false, 'pro not purchasable when only the monthly price exists');
    const pBoth = stripe.purchasableTiers({ STRIPE_PRICE_PRO: 'price_x', STRIPE_PRICE_PRO_ANNUAL: 'price_y' });
    ok(pBoth.pro === true, 'pro purchasable when both monthly and annual prices exist');
    // RETIRED SKUs are never purchasable, even with a live Stripe price.
    // Seats and white-label were withdrawn 2026-08-12: the whitelabel
    // entitlement was written and read by nothing, and one flat member cap
    // applied to every plan, so both took money and delivered no change.
    const pSeat = stripe.purchasableTiers({ STRIPE_PRICE_SEAT: 'price_s' });
    ok(pSeat.seat === false, 'retired seat add-on is NOT purchasable even though its price exists');
    const pWl = stripe.purchasableTiers({ STRIPE_PRICE_WHITELABEL: 'price_w' });
    ok(pWl.whitelabel === false, 'retired white-label add-on is NOT purchasable even though its price exists');
    ok(stripe.purchasableTiers({}).solo === false, 'unpriced tier is not purchasable');

    // And the server refuses at checkout, not just in the UI, so a stale page
    // or a hand-crafted request cannot buy a withdrawn SKU.
    let retiredErr = null;
    try {
      await stripe.createCheckoutSession(
        { STRIPE_SECRET_KEY: 'sk_test_x', STRIPE_PRICE_SEAT: 'price_s', CYBERSYGN_APP_URL: 'https://x.test' },
        { tier: 'seat', senderId: 'someone' },
      );
    } catch (e) { retiredErr = e; }
    ok(retiredErr && /retired/i.test(String(retiredErr.code || retiredErr.message || '')),
      'checkout refuses a retired SKU server-side');

    // An add-on purchase must NOT overwrite the base plan in sub:<senderId>.
    await store.put('sub:addon-tester', JSON.stringify({ tier: 'pro', status: 'active', stripeSubscriptionId: 'sub_base' }));
    const applied = await stripe.applyStripeEvent(env, {
      type: 'checkout.session.completed',
      data: { object: { client_reference_id: 'addon-tester', customer: 'cus_a',
        metadata: { tier: 'seat', senderId: 'addon-tester', quantity: '3' } } },
    });
    ok(applied && applied.addon === 'seat', 'add-on checkout routes to the add-on handler');
    const baseAfter = JSON.parse(await store.get('sub:addon-tester'));
    ok(baseAfter.tier === 'pro' && baseAfter.stripeSubscriptionId === 'sub_base', 'base plan is untouched by an add-on purchase (no entitlement clobber)');
    const addonsAfter = JSON.parse((await store.get('addons:addon-tester')) || '{}');
    ok(addonsAfter.seat && addonsAfter.seat.qty === 3 && !addonsAfter.seat.orphan, 'seat add-on recorded separately with its quantity');

    // A planless account buying an add-on is flagged orphan, never granted a plan.
    const orphanApplied = await stripe.applyStripeEvent(env, {
      type: 'checkout.session.completed',
      data: { object: { client_reference_id: 'addon-orphan', customer: 'cus_o',
        metadata: { tier: 'whitelabel', senderId: 'addon-orphan' } } },
    });
    ok(orphanApplied && orphanApplied.orphan === true, 'add-on bought with no base plan is flagged orphan');
    ok(!(await store.get('sub:addon-orphan')), 'a planless add-on buyer is NOT granted a base subscription');
  }

  console.log('\n======================================');
  console.log(`${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main().catch(err => {
  console.error('test crashed:', err);
  process.exit(2);
});
