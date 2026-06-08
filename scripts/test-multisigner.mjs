#!/usr/bin/env node
/**
 * Adversarial test harness for multi-signer routing (web/preview/signers.js).
 *
 * Most users use multi-signer, so the failure that matters most is a SILENT
 * one: a field assigned to a signer who no longer exists (or an invalid email),
 * which means no one is ever asked to fill that field and the document can never
 * complete. This harness drives the stores through every edge case and reports
 * which ones break.
 *
 * Run: node scripts/test-multisigner.mjs
 */

import {
  createSignersStore, createAssignmentStore, progressBySigner, initialsFor, SIGNER_PALETTE,
} from '../web/preview/signers.js';

let breaks = 0, ok = 0;
function check(name, condition, detail = '') {
  if (condition) { ok++; console.log(`  ok    ${name}`); }
  else { breaks++; console.log(`  BREAK ${name}${detail ? '  -- ' + detail : ''}`); }
}
function safe(fn) { try { return { ok: true, val: fn() }; } catch (e) { return { ok: false, err: e }; } }

console.log('Multi-signer adversarial tests:\n');

// 1. Signer cap is enforced without an uncaught crash path.
{
  const s = createSignersStore();
  for (let i = 0; i < SIGNER_PALETTE.length; i++) s.add({ name: `P${i}` });
  const over = safe(() => s.add({ name: 'overflow' }));
  check('over-cap add throws a controlled Error (not silent corruption)',
    !over.ok && over.err instanceof Error, over.ok ? 'add succeeded past cap' : '');
  check('signer count stays at cap after over-cap attempt', s.list().length === SIGNER_PALETTE.length);
}

// 2. THE BIG ONE: removing a signer must not orphan their field assignments.
{
  const s = createSignersStore();
  const a = s.add({ name: 'Alice' });
  const b = s.add({ name: 'Bob' });
  const assign = createAssignmentStore(a.id, { liveSigners: () => s.list().map(x => x.id) });
  assign.set('field1', a.id);
  assign.set('field2', b.id);
  assign.set('field3', b.id);
  s.remove(b.id); // Bob removed
  const liveIds = new Set(s.list().map(x => x.id));
  const orphanFields = ['field1', 'field2', 'field3'].filter(fid => !liveIds.has(assign.get(fid)));
  check('removing a signer leaves NO orphaned field assignments',
    orphanFields.length === 0,
    orphanFields.length ? `${orphanFields.length} field(s) point to the removed signer -> never signed` : '');
}

// 3. progressBySigner must not silently lose orphaned fields.
{
  const s = createSignersStore();
  const a = s.add({ name: 'Alice' });
  const b = s.add({ name: 'Bob' });
  const assign = createAssignmentStore(a.id, { liveSigners: () => s.list().map(x => x.id) });
  const fields = [{ id: 'f1' }, { id: 'f2' }];
  assign.set('f1', a.id);
  assign.set('f2', b.id);
  s.remove(b.id);
  const fillStore = { get: () => false };
  const prog = progressBySigner({ signers: s.list(), fields, assignments: assign, fillStore });
  const accounted = prog.reduce((sum, p) => sum + p.owned, 0);
  check('every field is accounted to a live signer in progress',
    accounted === fields.length,
    accounted !== fields.length ? `${fields.length - accounted} field(s) belong to no live signer` : '');
}

// 4. Email validation: invalid emails should be flagged, not silently accepted.
{
  const s = createSignersStore();
  const r = s.add({ name: 'Bad', email: 'notanemail' });
  check('invalid email is rejected or flagged', r && r.emailValid === false,
    r && r.email === 'notanemail' && r.emailValid !== false ? 'invalid email accepted as valid' : '');
}

// 5. Duplicate emails should be detectable.
{
  const s = createSignersStore();
  s.add({ name: 'A', email: 'same@x.com' });
  const second = s.add({ name: 'B', email: 'same@x.com' });
  check('duplicate signer email is flagged', second && second.duplicateEmail === true,
    second && second.duplicateEmail !== true ? 'two signers share an email, no flag' : '');
}

// 6. Assignment store with no default must not yield an undefined owner.
{
  const assign = createAssignmentStore(undefined);
  const owner = assign.get('someField');
  check('assignment with no default does not return undefined owner', owner !== undefined,
    owner === undefined ? 'unassigned field has undefined owner -> orphan' : '');
}

// 7. initialsFor edge cases never throw.
{
  const cases = ['', '   ', 'Madonna', 'Jean-Luc Picard', '李 雷', null, undefined, '\t\n', 'A B C D E'];
  let threw = false;
  for (const c of cases) { const r = safe(() => initialsFor(c)); if (!r.ok) threw = true; }
  check('initialsFor never throws on edge inputs', !threw);
}

console.log(`\n${ok} ok, ${breaks} BREAK, of ${ok + breaks}.`);
console.log(breaks === 0 ? 'MULTI-SIGNER SURVIVED EVERY CASE.' : `MULTI-SIGNER BROKE on ${breaks} case(s) — diagnose and harden.`);
process.exit(breaks === 0 ? 0 : 1);
