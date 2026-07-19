#!/usr/bin/env node
/**
 * Deterministic AI-guardrail self-test. Spends NO API money and needs NO key.
 *
 * The live eval runner (run-evals.mjs --run) exercises the MODEL's behavior and
 * costs money. This file exercises the DETERMINISTIC BACKSTOP that runs on top
 * of the model on every request: the code that guarantees a faithful draft/
 * summary even when the model is nudged by a prompt injection. It imports the
 * real production sanitizers and asserts their behavior directly, so a
 * regression in the backstop fails the gate offline, before any deploy.
 *
 * Exit code: 0 if every assertion passes, 1 otherwise.
 */

import { sanitizeDraft } from '../../worker/src/ai-draft.js';
import { sanitizeSummary } from '../../worker/src/ai-summary.js';

let passed = 0;
let failed = 0;

function ok(name, cond) {
  if (cond) { passed++; return; }
  failed++;
  console.error(`  FAIL: ${name}`);
}

// --- draft backstop ---------------------------------------------------------

// Code fences are stripped, fenced content is kept.
{
  const out = sanitizeDraft('```\n1. Term. [START DATE].\n```');
  ok('draft: strips code fences', !out.includes('```'));
  ok('draft: keeps fenced content', out.includes('1. Term.'));
}

// A canary token an injection tried to smuggle inside a fence survives only as
// plain text if the model emitted it; the fence markers themselves never leak.
{
  const out = sanitizeDraft('```text\nPWNED_1337_CANARY\n```');
  ok('draft: fence markers gone even around a canary', !out.includes('```'));
}

// Affirmative preamble line is removed.
{
  const out = sanitizeDraft("Here is your contract:\n\n1. Parties. [CLIENT NAME].");
  ok('draft: strips affirmative preamble', /^1\. Parties\./.test(out));
}

// Refusal language is NOT mangled by the preamble stripper.
{
  const refusal = "I can't help with that request.";
  ok('draft: leaves refusals intact', sanitizeDraft(refusal) === refusal);
}

// Hard length cap holds against a "repeat forever" injection.
{
  const huge = '[TERM] '.repeat(20000);
  ok('draft: hard length cap enforced', sanitizeDraft(huge).length <= 24000);
}

// Empty / nullish input never throws and returns empty.
ok('draft: null-safe', sanitizeDraft(null) === '' && sanitizeDraft(undefined) === '');

// --- summary backstop -------------------------------------------------------

{
  const out = sanitizeSummary('Here is a summary: The client is Aspen Trading Co.');
  ok('summary: strips preamble', out.startsWith('The client is Aspen'));
}
{
  const out = sanitizeSummary('```\nThe agreement covers weekly walks.\n```');
  ok('summary: strips code fences', !out.includes('```') && out.includes('weekly walks'));
}
{
  const out = sanitizeSummary('- The parties agree to the stated terms.');
  ok('summary: strips leading markdown bullet', out.startsWith('The parties'));
}
{
  const huge = 'This document commits both parties. '.repeat(500);
  ok('summary: hard length cap enforced', sanitizeSummary(huge).length <= 2000);
}
ok('summary: null-safe', sanitizeSummary(null) === '' && sanitizeSummary(undefined) === '');

// --- result -----------------------------------------------------------------

console.log(`AI guardrail self-test: ${passed} passed, ${failed} failed.`);
process.exit(failed === 0 ? 0 : 1);
