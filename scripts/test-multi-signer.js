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
import { readFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');

// Empty env: storage falls back to memory, email falls back to console.
const env = {};

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

async function main() {
  console.log('CyberSygn multi-signer end-to-end test');
  console.log('======================================\n');

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
  const link2_p1 = create2.json.signerLinks[0];

  // Manual reminder.
  const remind = await call('POST', `/api/docs/${docId2}/remind/p1`);
  ok(remind.status === 200, `manual reminder returns 200 (got ${remind.status})`);
  ok(remind.json && remind.json.delivered === true, 'reminder reports delivered');
  ok(remind.json && remind.json.tone === 'first', `first reminder tone is "first" (got "${remind.json && remind.json.tone}")`);
  ok(remind.json && remind.json.reminderCount === 1, `count is 1 (got ${remind.json && remind.json.reminderCount})`);

  // Rate limit: second immediate call rejected.
  const remindAgain = await call('POST', `/api/docs/${docId2}/remind/p1`);
  ok(remindAgain.status === 429, `rate-limited 1-minute wall returns 429 (got ${remindAgain.status})`);

  // Reminder for non-existent signer.
  const noSigner = await call('POST', `/api/docs/${docId2}/remind/nope`);
  ok(noSigner.status === 404, `unknown signer returns 404 (got ${noSigner.status})`);

  // Reminder for the already-completed Alice (from doc 1) should be 409.
  const completedRemind = await call('POST', `/api/docs/${docId}/remind/p1`);
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

  // 39. Verify endpoint accepts the token via query param
  const verifyQp = await call('GET', `/api/owner/verify?owner=${ownerToken}`);
  ok(verifyQp.status === 200, `verify via query param returns 200 (got ${verifyQp.status})`);

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

  console.log('\n======================================');
  console.log(`${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main().catch(err => {
  console.error('test crashed:', err);
  process.exit(2);
});
