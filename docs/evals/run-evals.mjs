#!/usr/bin/env node
/**
 * CyberSygn AI co-pilot eval runner (drafting + summaries).
 *
 * THIS SCRIPT SPENDS REAL ANTHROPIC API MONEY WHEN RUN WITH --run.
 * It is intentionally NOT wired into any build, lint, test, or deploy path
 * (see package.json: no script references it). It never runs automatically.
 *
 * It exercises the ACTUAL production code paths by importing generateDraft and
 * generateSummary from worker/src, so the real system prompts, model string,
 * token bounds, and output parsing are what get tested. Scoring is cheap and
 * deterministic (schema, required/forbidden substrings and regex, length
 * bounds, refusal-when-required). No LLM judge is used by default.
 *
 * Modes:
 *   node docs/evals/run-evals.mjs            Dry run. Validates every case file
 *                                            parses, prints the estimated cost,
 *                                            and exits. Makes NO API calls and
 *                                            needs NO API key. Use this to check
 *                                            the set without spending anything.
 *   node docs/evals/run-evals.mjs --run      Executes the cases against the live
 *                                            Anthropic API. Requires the env var
 *                                            ANTHROPIC_API_KEY. Prints the cost
 *                                            estimate first, then scores.
 *
 * Exit code: 0 if all executed cases pass (or on a clean dry run), 1 otherwise.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { generateDraft } from '../../worker/src/ai-draft.js';
import { generateSummary } from '../../worker/src/ai-summary.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const CASE_DIR = join(HERE, 'cases');
const CASE_FILES = ['golden.jsonl', 'adversarial.jsonl', 'regression.jsonl'];

// Pricing for the pinned model claude-sonnet-4-5-20250929, USD per 1M tokens.
// Estimate only, used for the up-front cost warning. Verify against current
// Anthropic pricing before trusting the absolute number.
const INPUT_USD_PER_M = 3;
const OUTPUT_USD_PER_M = 15;

// Production bounds mirrored from worker/src for the estimate (see PROMPTS.md).
const DRAFT_MAX_TOKENS = 1600;
const DRAFT_DESC_CAP = 1200;
const DRAFT_SYS_CHARS = 1200; // approx size of the drafting system prompt
const SUMMARY_MAX_TOKENS = 600;
const SUMMARY_TITLE_CAP = 200;
const SUMMARY_VALUE_CAP = 400;
const SUMMARY_LABEL_CAP = 80;
const SUMMARY_MAX_FIELDS = 60;
const SUMMARY_SYS_CHARS = 900; // approx size of the summary system prompt

// A generated draft or summary is refused when the model declines. Detect that
// so refusal-when-required cases can be scored without an LLM judge.
const REFUSAL_RE =
  /(i can('|no)?t\b|i cannot\b|i can not\b|i'?m unable\b|i am unable\b|unable to (help|assist|create|draft|provide)|i won'?t\b|i will not\b|i must decline|i (do|am) not (help|assist|feel comfortable)|not able to (help|assist|create|draft)|can'?t help with|cannot help with|won'?t be able to|i'?m not able|i am not able|i'?m not going to)/i;

function ciIncludes(haystack, needle) {
  return haystack.toLowerCase().includes(String(needle).toLowerCase());
}

function rx(pattern) {
  // Case-insensitive, not multiline. Patterns that need line anchoring use an
  // explicit (^|\n) so they work without the m flag.
  return new RegExp(pattern, 'i');
}

// ---------------------------------------------------------------------------
// Case loading + validation
// ---------------------------------------------------------------------------

function loadCases() {
  const all = [];
  const errors = [];
  for (const file of CASE_FILES) {
    const set = file.replace(/\.jsonl$/, '');
    let raw;
    try {
      raw = readFileSync(join(CASE_DIR, file), 'utf8');
    } catch (e) {
      errors.push(`${file}: cannot read (${e && e.message})`);
      continue;
    }
    const lines = raw.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (line.trim() === '') continue;
      let obj;
      try {
        obj = JSON.parse(line);
      } catch (e) {
        errors.push(`${file}:${i + 1}: invalid JSON (${e && e.message})`);
        continue;
      }
      if (!obj.id) errors.push(`${file}:${i + 1}: missing id`);
      if (obj.type !== 'draft' && obj.type !== 'summary') {
        errors.push(`${file}:${i + 1} (${obj.id}): type must be "draft" or "summary"`);
      }
      obj.__set = set;
      obj.__loc = `${file}:${i + 1}`;
      all.push(obj);
    }
  }
  return { all, errors };
}

// ---------------------------------------------------------------------------
// Cost estimate
// ---------------------------------------------------------------------------

function isGuardOnly(c) {
  if (c.type === 'draft') {
    const d = (c.input && typeof c.input.description === 'string' ? c.input.description : '').trim();
    return d.length < 10; // returns reason:invalid before any API call
  }
  // summary: no non-empty value means reason:invalid before any API call
  const values = (c.input && c.input.values) || {};
  return !Object.values(values).some((v) => String(v == null ? '' : v).trim() !== '');
}

function estimateTokens(c) {
  if (isGuardOnly(c)) return { input: 0, output: 0 };
  if (c.type === 'draft') {
    const desc = String((c.input && c.input.description) || '').slice(0, DRAFT_DESC_CAP);
    const parties = (c.input && c.input.parties) || {};
    const userChars = desc.length + String(parties.you || '').length + String(parties.them || '').length + 260;
    return { input: Math.ceil((DRAFT_SYS_CHARS + userChars) / 4), output: DRAFT_MAX_TOKENS };
  }
  const title = String((c.input && c.input.title) || '').slice(0, SUMMARY_TITLE_CAP);
  const fields = (c.input && c.input.fields) || [];
  const labelById = new Map(fields.filter((f) => f && f.id != null).map((f) => [String(f.id), String(f.label || '').slice(0, SUMMARY_LABEL_CAP)]));
  const values = (c.input && c.input.values) || {};
  let userChars = title.length + 160;
  let n = 0;
  for (const [k, v] of Object.entries(values)) {
    if (n >= SUMMARY_MAX_FIELDS) break;
    const value = String(v == null ? '' : v).trim().slice(0, SUMMARY_VALUE_CAP);
    if (!value) continue;
    const label = labelById.get(String(k)) || String(k).slice(0, SUMMARY_LABEL_CAP);
    userChars += label.length + value.length + 4;
    n++;
  }
  return { input: Math.ceil((SUMMARY_SYS_CHARS + userChars) / 4), output: SUMMARY_MAX_TOKENS };
}

function estimateCostUSD(cases) {
  let input = 0;
  let output = 0;
  let apiCalls = 0;
  for (const c of cases) {
    const t = estimateTokens(c);
    input += t.input;
    output += t.output;
    if (t.input > 0 || t.output > 0) apiCalls++;
  }
  const usd = (input / 1e6) * INPUT_USD_PER_M + (output / 1e6) * OUTPUT_USD_PER_M;
  return { usd, input, output, apiCalls };
}

// ---------------------------------------------------------------------------
// Scoring (deterministic, no LLM judge)
// ---------------------------------------------------------------------------

function scoreCase(c, result) {
  const checks = c.checks || {};
  const ok = !!(result && result.ok);
  const text = ok ? String((c.type === 'draft' ? result.body : result.summary) || '') : '';
  const failures = [];

  if (checks.expect_refusal) {
    const refused = !ok || REFUSAL_RE.test(text);
    if (!refused) failures.push('expected a refusal, but a draft/summary was produced');
  } else {
    if (typeof checks.expect_ok === 'boolean' && ok !== checks.expect_ok) {
      failures.push(`expect_ok=${checks.expect_ok} but got ok=${ok} (reason=${result && result.reason})`);
    }
    if (checks.expect_reason && (!result || result.reason !== checks.expect_reason)) {
      failures.push(`expect_reason=${checks.expect_reason} but got ${result && result.reason}`);
    }
    if (checks.expect_title !== undefined && (!result || result.title !== checks.expect_title)) {
      failures.push(`expect_title=${JSON.stringify(checks.expect_title)} but got ${JSON.stringify(result && result.title)}`);
    }
  }

  // Text-content checks only apply when there is model text to inspect.
  if (ok && text) {
    if (typeof checks.min_length === 'number' && text.length < checks.min_length) {
      failures.push(`length ${text.length} < min_length ${checks.min_length}`);
    }
    if (typeof checks.max_length === 'number' && text.length > checks.max_length) {
      failures.push(`length ${text.length} > max_length ${checks.max_length}`);
    }
    for (const p of checks.required_regex || []) {
      if (!rx(p).test(text)) failures.push(`missing required_regex /${p}/`);
    }
    for (const s of checks.required_substrings_all || []) {
      if (!ciIncludes(text, s)) failures.push(`missing required substring "${s}"`);
    }
    if ((checks.required_substrings_any || []).length && !checks.required_substrings_any.some((s) => ciIncludes(text, s))) {
      failures.push(`none of required_substrings_any present: ${JSON.stringify(checks.required_substrings_any)}`);
    }
    for (const s of checks.forbidden_substrings || []) {
      if (ciIncludes(text, s)) failures.push(`forbidden substring present "${s}"`);
    }
    for (const p of checks.forbidden_regex || []) {
      if (rx(p).test(text)) failures.push(`forbidden_regex matched /${p}/`);
    }
  }

  return failures;
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

async function runCase(env, c) {
  if (c.type === 'draft') {
    const input = c.input || {};
    return generateDraft(env, { kind: input.kind, description: input.description, parties: input.parties || {} });
  }
  const input = c.input || {};
  return generateSummary(env, { title: input.title, fields: input.fields || [], values: input.values || {} });
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function main() {
  const args = process.argv.slice(2);
  const doRun = args.includes('--run');

  const { all, errors } = loadCases();
  if (errors.length) {
    console.error('Case file validation errors:');
    for (const e of errors) console.error('  ' + e);
    process.exit(1);
  }

  const counts = { golden: 0, adversarial: 0, regression: 0 };
  for (const c of all) counts[c.__set] = (counts[c.__set] || 0) + 1;

  console.log('CyberSygn AI co-pilot eval set');
  console.log(`  golden:      ${counts.golden}`);
  console.log(`  adversarial: ${counts.adversarial}`);
  console.log(`  regression:  ${counts.regression}`);
  console.log(`  total cases: ${all.length}`);

  const est = estimateCostUSD(all);
  console.log('');
  console.log('Estimated cost per full run (worst case, output billed at max_tokens):');
  console.log(`  API calls:      ${est.apiCalls} (${all.length - est.apiCalls} pre-API guard cases cost nothing)`);
  console.log(`  input tokens:   ~${est.input.toLocaleString()}`);
  console.log(`  output tokens:  ~${est.output.toLocaleString()} (upper bound)`);
  console.log(`  estimated cost: ~$${est.usd.toFixed(4)} at $${INPUT_USD_PER_M}/$${OUTPUT_USD_PER_M} per 1M tokens (sonnet-4-5)`);
  console.log('');

  if (!doRun) {
    console.log('Dry run only: no API calls were made and no money was spent.');
    console.log('Case files parsed and validated successfully.');
    console.log('To execute against the live API: ANTHROPIC_API_KEY=... node docs/evals/run-evals.mjs --run');
    process.exit(0);
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    console.error('Refusing to run: ANTHROPIC_API_KEY is not set.');
    console.error('This runner spends real API money and will not run without an explicit key.');
    process.exit(1);
  }

  console.log('Running against the live Anthropic API. This spends real money.');
  console.log('');

  const env = { ANTHROPIC_API_KEY: apiKey };
  const results = [];
  let passed = 0;
  let failed = 0;

  for (const c of all) {
    let result;
    try {
      result = await runCase(env, c);
    } catch (e) {
      result = { ok: false, reason: 'error', message: `runner threw: ${e && e.message}` };
    }
    const failures = scoreCase(c, result);
    const pass = failures.length === 0;
    if (pass) passed++;
    else failed++;
    results.push({ c, failures });
    const tag = pass ? 'PASS' : 'FAIL';
    console.log(`[${tag}] ${c.__set.padEnd(11)} ${c.id}`);
    if (!pass) {
      for (const f of failures) console.log(`         - ${f}`);
    }
    await sleep(200); // be gentle on rate limits
  }

  console.log('');
  console.log(`Results: ${passed} passed, ${failed} failed, ${all.length} total.`);

  // Per-set breakdown.
  const bySet = {};
  for (const { c, failures } of results) {
    bySet[c.__set] = bySet[c.__set] || { pass: 0, fail: 0 };
    if (failures.length === 0) bySet[c.__set].pass++;
    else bySet[c.__set].fail++;
  }
  for (const set of Object.keys(bySet)) {
    console.log(`  ${set.padEnd(11)} ${bySet[set].pass} passed, ${bySet[set].fail} failed`);
  }

  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error('Fatal:', e && e.stack ? e.stack : e);
  process.exit(1);
});
