/**
 * AI contract-drafting wedge (Move 3).
 *
 * Turns a plain-English description into a clean, professional CONTRACT
 * DRAFT with clearly bracketed [PLACEHOLDERS] the user fills in. This is
 * the top-of-funnel: draft here, then sign with CyberSygn.
 *
 * INTEGRITY (this is a legal e-signature product):
 *   - Every draft is a NEUTRAL STARTING TEMPLATE, never legal advice.
 *     The model is instructed to produce a template only and to add no
 *     legal opinion. The caller attaches the human-readable disclaimer.
 *   - If ANTHROPIC_API_KEY is not configured, the caller returns a
 *     graceful "unconfigured" 200 (waitlist/fallback), never a 500.
 *   - Provider errors and the API key NEVER reach the client. All
 *     failures collapse into { ok:false, reason:'error', message }.
 *
 * Reuses the exact Anthropic request pattern from vision.js: same API
 * url, x-api-key header, anthropic-version, dated model snapshot, and a
 * per-call timeout so a slow provider cannot blow the CPU budget.
 */

const ANTHROPIC_MODEL = 'claude-sonnet-4-5-20250929';
const ANTHROPIC_API = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_VERSION = '2023-06-01';

const REQUEST_TIMEOUT_MS = 30_000;   // drafting is longer than field detection
// A starting contract draft is a page or two, not an exhaustive agreement.
// 1600 tokens is ample and keeps generation comfortably inside the timeout
// (3000 tokens routinely ran past 30s and failed every request).
const MAX_TOKENS = 1600;
const MAX_DESCRIPTION_CHARS = 1200;
const MAX_PARTY_CHARS = 120;
const MAX_RESPONSE_BYTES = 128 * 1024;

// Known contract kinds get a friendly title. Anything else is accepted
// but titled generically (the model still drafts to the described need).
const KIND_TITLES = {
  'freelance-agreement': 'Freelance Services Agreement',
  'nda': 'Non-Disclosure Agreement',
  'consulting': 'Consulting Agreement',
  'invoice-terms': 'Invoice and Payment Terms',
  'service-agreement': 'Service Agreement',
  'contractor': 'Independent Contractor Agreement',
  'statement-of-work': 'Statement of Work',
};

/**
 * Generate a starting contract draft.
 *
 * @param {object} env - Worker env; env.ANTHROPIC_API_KEY gates real calls.
 * @param {object} opts
 * @param {string} opts.kind        - e.g. "freelance-agreement", "nda".
 * @param {string} opts.description - plain-English description (<= ~1200 chars).
 * @param {object} [opts.parties]   - { you?, them? } optional party names.
 * @returns {Promise<object>} one of:
 *   { ok:true, kind, title, body }
 *   { ok:false, reason:'unconfigured', message }
 *   { ok:false, reason:'invalid', message }
 *   { ok:false, reason:'error', message }
 */
export async function generateDraft(env, opts) {
  // Graceful fallback: not enabled on this deployment. NOT an error.
  if (!env || !env.ANTHROPIC_API_KEY) {
    return {
      ok: false,
      reason: 'unconfigured',
      message: 'AI drafting is not enabled on this deployment yet.',
    };
  }

  const kind = normalizeKind(opts && opts.kind);
  const description = normalizeText(opts && opts.description, MAX_DESCRIPTION_CHARS);
  if (!description || description.length < 10) {
    return {
      ok: false,
      reason: 'invalid',
      message: 'Describe what the contract needs to cover (a sentence or two is enough).',
    };
  }

  const you = normalizeText(opts && opts.parties && opts.parties.you, MAX_PARTY_CHARS);
  const them = normalizeText(opts && opts.parties && opts.parties.them, MAX_PARTY_CHARS);
  const title = KIND_TITLES[kind] || 'Contract Draft';

  const body = {
    model: ANTHROPIC_MODEL,
    max_tokens: MAX_TOKENS,
    system: buildSystemPrompt(),
    messages: [
      { role: 'user', content: buildUserPrompt({ kind, title, description, you, them }) },
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
    console.warn('[ai-draft] fetch failed:', err && err.name);
    return { ok: false, reason: 'error', message: 'Drafting is temporarily unavailable. Please try again in a moment.' };
  }

  if (!res.ok) {
    // Log status for the owner via tail; do NOT surface provider detail.
    console.warn('[ai-draft] provider status', res.status);
    return { ok: false, reason: 'error', message: 'Drafting is temporarily unavailable. Please try again in a moment.' };
  }

  let raw;
  try {
    raw = await readJsonCapped(res, MAX_RESPONSE_BYTES);
  } catch (err) {
    console.warn('[ai-draft] parse failed:', err && err.name);
    return { ok: false, reason: 'error', message: 'Drafting is temporarily unavailable. Please try again in a moment.' };
  }

  const draft = extractAssistantText(raw).trim();
  if (!draft) {
    return { ok: false, reason: 'error', message: 'The draft came back empty. Please try again.' };
  }

  return { ok: true, kind, title, body: draft };
}

// ---------------------------------------------------------------------------
// Prompts. The model produces a NEUTRAL TEMPLATE ONLY, never legal advice.
// ---------------------------------------------------------------------------

function buildSystemPrompt() {
  return [
    'You are a contract-drafting assistant that produces clean, professional CONTRACT DRAFTS as neutral starting templates.',
    '',
    'Hard rules you must always follow:',
    '- Output ONLY the contract text. No preamble, no commentary, no markdown code fences.',
    '- Use clearly bracketed [PLACEHOLDERS] for every name, date, amount, term length, address, and other detail the user must fill in (for example [CLIENT NAME], [EFFECTIVE DATE], [FEE AMOUNT], [PAYMENT DUE DATE]).',
    '- Write plain, readable, professional contract language. Number the sections.',
    '- Produce a neutral, balanced template. Do NOT give legal advice, legal opinions, or recommendations.',
    '- Do NOT add any note claiming the document is legally binding, complete, or a substitute for a lawyer.',
    '- Do NOT invent facts the user did not provide; leave them as placeholders.',
    '- Keep it a starting template the user will review and adapt.',
    '- Keep it focused and concise: a typical draft is 6 to 12 numbered sections, one page or two. Do not pad with boilerplate the user did not ask for.',
  ].join('\n');
}

function buildUserPrompt({ kind, title, description, you, them }) {
  const lines = [
    `Draft a "${title}" (kind: ${kind}).`,
    '',
    'Base it on this plain-English description of the arrangement:',
    description,
  ];
  if (you || them) {
    lines.push('');
    lines.push('Known parties (use these names where they fit; leave any other details as placeholders):');
    if (you) lines.push(`- One party (the provider / disclosing side): ${you}`);
    if (them) lines.push(`- Other party (the client / receiving side): ${them}`);
  }
  lines.push('');
  lines.push('Return the full contract draft as plain text with numbered sections and bracketed [PLACEHOLDERS]. Output the contract text only.');
  return lines.join('\n');
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
// Input normalization
// ---------------------------------------------------------------------------

function normalizeKind(kind) {
  const k = String(kind || '').trim().toLowerCase().replace(/[^a-z0-9-]/g, '').slice(0, 48);
  return k || 'contract';
}

function normalizeText(value, maxChars) {
  if (typeof value !== 'string') return '';
  return value.trim().slice(0, maxChars);
}

// ---------------------------------------------------------------------------
// Helpers (mirrors vision.js so behavior is consistent across modules)
// ---------------------------------------------------------------------------

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
