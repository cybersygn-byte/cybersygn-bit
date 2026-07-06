/**
 * F3 AI plain-English summary of a COMPLETED document.
 *
 * Turns a completed document's title + filled field values into a short,
 * 2 to 4 sentence plain-English summary of what the signed document
 * commits the parties to. This is a reading aid, not legal advice.
 *
 * INTEGRITY (this is a legal e-signature product):
 *   - The model summarizes ONLY the provided title + filled field values.
 *     It is instructed to never invent facts, obligations, dates, or
 *     amounts that are not present in the fills.
 *   - If ANTHROPIC_API_KEY is not configured, this returns a graceful
 *     { ok:false, reason:'unconfigured' }, never a 500.
 *   - Provider errors and the API key NEVER reach the client. All
 *     failures collapse into { ok:false, reason:'error', message }.
 *
 * Reuses the exact Anthropic request pattern from ai-draft.js: same API
 * url, x-api-key header, anthropic-version, dated model snapshot, and a
 * per-call timeout so a slow provider cannot blow the CPU budget.
 */

const ANTHROPIC_MODEL = 'claude-sonnet-4-5-20250929';
const ANTHROPIC_API = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_VERSION = '2023-06-01';

const REQUEST_TIMEOUT_MS = 20_000;
const MAX_TOKENS = 600;
const MAX_TITLE_CHARS = 200;
const MAX_FIELDS = 60;          // cap how many fills we feed the model
const MAX_LABEL_CHARS = 80;
const MAX_VALUE_CHARS = 400;
const MAX_RESPONSE_BYTES = 64 * 1024;

/**
 * Generate a plain-English summary of a completed document.
 *
 * @param {object} env - Worker env; env.ANTHROPIC_API_KEY gates real calls.
 * @param {object} opts
 * @param {string} opts.title  - the document title.
 * @param {Array}  [opts.fields] - optional [{ id, label }] to name the fills.
 * @param {object} [opts.values] - map of { [fieldIdOrLabel]: value } filled in.
 * @returns {Promise<object>} one of:
 *   { ok:true, summary }
 *   { ok:false, reason:'unconfigured', message }
 *   { ok:false, reason:'invalid', message }
 *   { ok:false, reason:'error', message }
 */
export async function generateSummary(env, opts) {
  // Graceful fallback: not enabled on this deployment. NOT an error.
  if (!env || !env.ANTHROPIC_API_KEY) {
    return {
      ok: false,
      reason: 'unconfigured',
      message: 'AI summaries are not enabled on this deployment yet.',
    };
  }

  const title = normalizeText(opts && opts.title, MAX_TITLE_CHARS) || 'Document';
  const pairs = buildFilledPairs(opts && opts.fields, opts && opts.values);
  if (pairs.length === 0) {
    return {
      ok: false,
      reason: 'invalid',
      message: 'This document has no filled values to summarize yet.',
    };
  }

  const body = {
    model: ANTHROPIC_MODEL,
    max_tokens: MAX_TOKENS,
    system: buildSystemPrompt(),
    messages: [
      { role: 'user', content: buildUserPrompt({ title, pairs }) },
    ],
  };

  let res;
  try {
    res = await withTimeout(
      fetch(ANTHROPIC_API, {
        method: 'POST',
        headers: {
          'x-api-key': env.ANTHROPIC_API_KEY,
          'anthropic-version': ANTHROPIC_VERSION,
          'content-type': 'application/json',
        },
        body: JSON.stringify(body),
      }),
      REQUEST_TIMEOUT_MS,
    );
  } catch (err) {
    // Never leak the raw provider error or the key.
    console.warn('[ai-summary] fetch failed:', err && err.name);
    return { ok: false, reason: 'error', message: 'Summaries are temporarily unavailable. Please try again in a moment.' };
  }

  if (!res.ok) {
    console.warn('[ai-summary] provider status', res.status);
    return { ok: false, reason: 'error', message: 'Summaries are temporarily unavailable. Please try again in a moment.' };
  }

  let raw;
  try {
    raw = await readJsonCapped(res, MAX_RESPONSE_BYTES);
  } catch (err) {
    console.warn('[ai-summary] parse failed:', err && err.name);
    return { ok: false, reason: 'error', message: 'Summaries are temporarily unavailable. Please try again in a moment.' };
  }

  const summary = extractAssistantText(raw).trim();
  if (!summary) {
    return { ok: false, reason: 'error', message: 'The summary came back empty. Please try again.' };
  }

  return { ok: true, summary };
}

// ---------------------------------------------------------------------------
// Prompts. The model summarizes ONLY the provided facts, never invents any.
// ---------------------------------------------------------------------------

function buildSystemPrompt() {
  return [
    'You summarize completed signed documents in plain English for the people who signed them.',
    '',
    'Hard rules you must always follow:',
    '- Write 2 to 4 short sentences. Plain, clear English a non-lawyer understands.',
    '- Summarize ONLY what the provided title and filled field values state. Do NOT invent parties, dates, amounts, obligations, or terms that are not present in the values.',
    '- Do NOT give legal advice, opinions, or recommendations. Do NOT claim the document is or is not legally binding.',
    '- If the values are sparse, keep the summary short rather than padding it with assumptions.',
    '- Output ONLY the summary text. No preamble, no bullet list, no markdown.',
  ].join('\n');
}

function buildUserPrompt({ title, pairs }) {
  const lines = [
    `Document title: ${title}`,
    '',
    'Filled values from the completed document:',
  ];
  for (const p of pairs) {
    lines.push(`- ${p.label}: ${p.value}`);
  }
  lines.push('');
  lines.push('Write a 2 to 4 sentence plain-English summary of what this completed document commits, using only the values above.');
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Build label/value pairs from doc fields + signer fills. Never invents.
// ---------------------------------------------------------------------------

/**
 * Flatten the doc's fields + a merged values map into a capped list of
 * { label, value } pairs, skipping empties. Labels come from the field
 * definitions when available, else the raw key.
 */
function buildFilledPairs(fields, values) {
  const labelById = new Map();
  if (Array.isArray(fields)) {
    for (const f of fields) {
      if (f && f.id != null) {
        const label = normalizeText(f.label, MAX_LABEL_CHARS);
        if (label) labelById.set(String(f.id), label);
      }
    }
  }
  const out = [];
  const src = values && typeof values === 'object' ? values : {};
  for (const [k, v] of Object.entries(src)) {
    if (out.length >= MAX_FIELDS) break;
    const value = normalizeText(v, MAX_VALUE_CHARS);
    if (!value) continue;
    const label = labelById.get(String(k)) || normalizeText(k, MAX_LABEL_CHARS) || 'Field';
    out.push({ label, value });
  }
  return out;
}

/**
 * Merge every signer's fills into a single { fieldId: value } map. Later
 * signers do not clobber earlier non-empty values for the same field.
 * Exported so the endpoint can build the values map from doc.signers.
 */
export function mergeSignerFills(signers) {
  const merged = {};
  if (!Array.isArray(signers)) return merged;
  for (const s of signers) {
    const fills = s && s.fills && typeof s.fills === 'object' ? s.fills : {};
    for (const [k, v] of Object.entries(fills)) {
      if (merged[k] == null || merged[k] === '') merged[k] = v;
    }
  }
  return merged;
}

// ---------------------------------------------------------------------------
// Response parsing
// ---------------------------------------------------------------------------

function extractAssistantText(rawResponse) {
  if (!rawResponse || !Array.isArray(rawResponse.content)) return '';
  const parts = [];
  for (const block of rawResponse.content) {
    if (block && block.type === 'text' && typeof block.text === 'string') {
      parts.push(block.text);
    }
  }
  return parts.join('\n').trim();
}

// ---------------------------------------------------------------------------
// Input normalization + helpers (mirror ai-draft.js)
// ---------------------------------------------------------------------------

function normalizeText(value, maxChars) {
  if (value == null) return '';
  const s = typeof value === 'string' ? value : String(value);
  return s.trim().slice(0, maxChars);
}

function withTimeout(p, ms) {
  return Promise.race([
    p,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`timeout after ${ms}ms`)), ms)),
  ]);
}

async function readJsonCapped(res, maxBytes) {
  const text = await res.text();
  if (text.length > maxBytes) {
    throw new Error(`response too large: ${text.length} bytes`);
  }
  return JSON.parse(text);
}
