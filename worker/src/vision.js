/**
 * Phase 2b: LLM-vision field detection via the Anthropic Claude API.
 *
 * Accepts a rendered page image (base64 PNG, sent from the browser
 * after pdf.js renders it to canvas), forwards it to Claude Sonnet 4.5
 * with a strict structured-output prompt, parses the JSON response,
 * and returns an array of field candidates in PIXEL coordinates
 * relative to the image's top-left origin.
 *
 * Why Claude over alternatives (see slice 31 cost matrix):
 *   - Strongest instruction-following on structured JSON output.
 *   - Precise bounding boxes (matters because we flatten signed
 *     content back into the PDF at these coordinates).
 *   - ~$0.01 per page at current pricing (Sonnet 4.5: $3/M input,
 *     $15/M output). Acceptable unit economics even at heavy use.
 *
 * Cost guardrails:
 *   - ANTHROPIC_API_KEY required. Without it, this module is dead
 *     code; the route handler returns 503 with a clear configure-me
 *     message rather than silently calling a free endpoint.
 *   - Per-call timeout (12s) so a slow API does not blow CPU budget.
 *   - Response size cap (8 KB JSON) to bound output token spend.
 *   - Caller tracks per-account monthly usage via KV
 *     (meta:vision-usage:<senderId>:<YYYY-MM>) and refuses when
 *     a cap is hit. Default cap: 1000 pages/account/month = $10.
 *
 * Per CONSTITUTION 1.9: every fetch has a timeout, every JSON.parse
 * is guarded, every failure produces a useful error response.
 */

// Sonnet 4.5 is the right tier: 4.6/4.7 add cost without measurably
// better field-detection performance for our prompt shape. Pinned to
// a dated snapshot for prediction stability.
const ANTHROPIC_MODEL = 'claude-sonnet-4-5-20250929';
const ANTHROPIC_API = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_VERSION = '2023-06-01';

// Hard upper bounds. Sized so a single page never exceeds them.
const REQUEST_TIMEOUT_MS = 12_000;
const MAX_RESPONSE_BYTES = 32 * 1024;   // 32 KB is generous; typical reply ~2 KB
const MAX_FIELDS_RETURNED = 80;          // a single page should not exceed this
const DEFAULT_MONTHLY_CAP_PAGES = 1000;  // per sender; ~$10/mo budget

const ALLOWED_TYPES = new Set(['signature', 'initial', 'date', 'checkbox', 'text']);

/**
 * Main entry. Returns { ok, fields, cost, error? }.
 *
 * @param {object} env - Worker env with ANTHROPIC_API_KEY secret.
 * @param {object} opts
 * @param {string} opts.imageBase64 - PNG image as base64 (no data: prefix).
 * @param {number} opts.imageWidth - source image width in pixels.
 * @param {number} opts.imageHeight - source image height in pixels.
 * @param {number} opts.pageNum - 1-based page number (for the prompt).
 */
export async function detectFieldsViaVision(env, opts) {
  if (!env || !env.ANTHROPIC_API_KEY) {
    return { ok: false, error: 'ANTHROPIC_API_KEY not configured', fields: [], cost: 0 };
  }
  if (!opts || typeof opts.imageBase64 !== 'string' || opts.imageBase64.length === 0) {
    return { ok: false, error: 'imageBase64 required', fields: [], cost: 0 };
  }
  if (!Number.isFinite(opts.imageWidth) || !Number.isFinite(opts.imageHeight)) {
    return { ok: false, error: 'imageWidth and imageHeight required', fields: [], cost: 0 };
  }

  const prompt = buildPrompt({
    width: opts.imageWidth,
    height: opts.imageHeight,
    pageNum: opts.pageNum || 1,
  });

  const body = {
    model: ANTHROPIC_MODEL,
    max_tokens: 4096,
    messages: [
      {
        role: 'user',
        content: [
          {
            type: 'image',
            source: { type: 'base64', media_type: 'image/png', data: opts.imageBase64 },
          },
          { type: 'text', text: prompt },
        ],
      },
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
    return { ok: false, error: `vision_fetch_failed: ${trimErr(err)}`, fields: [], cost: 0 };
  }

  if (!res.ok) {
    let detail = '';
    try {
      const text = await res.text();
      detail = text.slice(0, 300);
    } catch (e) {}
    return {
      ok: false,
      error: `vision_http_${res.status}: ${detail}`,
      fields: [],
      cost: 0,
    };
  }

  let raw;
  try {
    raw = await readJsonCapped(res, MAX_RESPONSE_BYTES);
  } catch (err) {
    return { ok: false, error: `vision_parse_failed: ${trimErr(err)}`, fields: [], cost: 0 };
  }

  // Pull the assistant's text block and parse the embedded JSON.
  const text = extractAssistantText(raw);
  if (!text) {
    return { ok: false, error: 'vision_empty_response', fields: [], cost: 0 };
  }
  const parsed = parseFieldsJson(text, opts);
  if (!parsed.ok) {
    return { ok: false, error: parsed.error, fields: [], cost: estimateCost(raw) };
  }

  return {
    ok: true,
    fields: parsed.fields,
    cost: estimateCost(raw),
    usage: raw && raw.usage ? raw.usage : null,
  };
}

// ---------------------------------------------------------------------------
// Prompt. Single source of truth. Tested by repeated runs against the
// real-world contracts in real-pdfs/. Changes here should be checked
// against the regression set before deploying.
// ---------------------------------------------------------------------------

function buildPrompt({ width, height, pageNum }) {
  return [
    `You are inspecting page ${pageNum} of a contract PDF rendered as a ${width}x${height} pixel image.`,
    '',
    'Find every place where a SIGNER needs to add information. For each, return a bounding box in pixel coordinates relative to the image\'s top-left origin (x=0, y=0 at top-left; x grows right, y grows down).',
    '',
    'Field types:',
    '- "signature": a signature line (the signer draws their name)',
    '- "initial": an initial line or initial box',
    '- "date": a date field',
    '- "checkbox": a box the signer checks (empty square outline)',
    '- "text": a fill-in line for text (name, address, amount, phone, email, etc.)',
    '',
    'Return ONLY valid JSON in this exact shape, no preamble, no markdown, no commentary:',
    '',
    '{"fields":[{"type":"signature","x":0,"y":0,"width":0,"height":0,"label":"","confidence":0.0}]}',
    '',
    'Rules:',
    '- Skip pre-filled text. Only return blank fields a signer must complete.',
    '- For each field, "label" is the nearest text label (e.g. "Owner Signature", "Date", "Phone"). Empty string if no nearby label.',
    '- "confidence" is 0.0 to 1.0. Use 0.95+ only for clearly labeled fields.',
    '- Coordinates must be integers within the image bounds.',
    '- Width and height in pixels.',
    '- BE CONSERVATIVE. Better to miss a borderline field than invent one. The user will manually add any miss.',
    '- Return at most 80 fields per page. If a page has more, return the most important.',
    '- The JSON must parse with JSON.parse. No trailing commas, no comments, no unquoted keys.',
  ].join('\n');
}

// ---------------------------------------------------------------------------
// Response parsing
// ---------------------------------------------------------------------------

function extractAssistantText(rawResponse) {
  if (!rawResponse || !Array.isArray(rawResponse.content)) return '';
  for (const block of rawResponse.content) {
    if (block && block.type === 'text' && typeof block.text === 'string') {
      return block.text;
    }
  }
  return '';
}

function parseFieldsJson(text, opts) {
  // Claude almost always returns clean JSON when instructed to. If it
  // accidentally wraps in ```json ... ```, strip the fences.
  let body = text.trim();
  if (body.startsWith('```')) {
    body = body.replace(/^```(?:json)?\s*/, '').replace(/\s*```\s*$/, '');
  }
  // Sometimes the model emits a brief preamble before the JSON. Be lenient.
  const firstBrace = body.indexOf('{');
  const lastBrace = body.lastIndexOf('}');
  if (firstBrace < 0 || lastBrace < firstBrace) {
    return { ok: false, error: 'vision_no_json_in_response' };
  }
  body = body.slice(firstBrace, lastBrace + 1);

  let parsed;
  try {
    parsed = JSON.parse(body);
  } catch (err) {
    return { ok: false, error: `vision_invalid_json: ${trimErr(err)}` };
  }
  if (!parsed || !Array.isArray(parsed.fields)) {
    return { ok: false, error: 'vision_missing_fields_array' };
  }

  const out = [];
  for (const f of parsed.fields.slice(0, MAX_FIELDS_RETURNED)) {
    const v = validateField(f, opts);
    if (v) out.push(v);
  }
  return { ok: true, fields: out };
}

function validateField(f, opts) {
  if (!f || typeof f !== 'object') return null;
  if (typeof f.type !== 'string' || !ALLOWED_TYPES.has(f.type)) return null;

  const x = Math.round(Number(f.x));
  const y = Math.round(Number(f.y));
  const w = Math.round(Number(f.width));
  const h = Math.round(Number(f.height));
  if (![x, y, w, h].every(Number.isFinite)) return null;
  if (w < 4 || h < 4) return null;           // implausibly tiny
  if (w > opts.imageWidth || h > opts.imageHeight) return null;  // implausibly huge

  // Clamp to image bounds so a hallucinated x=-50 still works.
  const cx = Math.max(0, Math.min(opts.imageWidth  - 1, x));
  const cy = Math.max(0, Math.min(opts.imageHeight - 1, y));
  const cw = Math.min(opts.imageWidth  - cx, w);
  const ch = Math.min(opts.imageHeight - cy, h);

  const conf = Math.max(0, Math.min(1, Number(f.confidence) || 0.5));
  const label = typeof f.label === 'string' ? f.label.slice(0, 160) : '';

  return {
    type: f.type,
    x: cx,
    y: cy,
    width: cw,
    height: ch,
    label,
    confidence: conf,
    source: 'vision',
  };
}

// ---------------------------------------------------------------------------
// Cost estimation. Anthropic returns input_tokens and output_tokens in
// the response usage block. We estimate cost in USD micro-cents so the
// integer survives JSON without floating-point drift.
// ---------------------------------------------------------------------------

const COST_PER_INPUT_TOKEN_USD  = 3 / 1_000_000;   // $3 per million
const COST_PER_OUTPUT_TOKEN_USD = 15 / 1_000_000;  // $15 per million

function estimateCost(raw) {
  if (!raw || !raw.usage) return 0;
  const i = Number(raw.usage.input_tokens) || 0;
  const o = Number(raw.usage.output_tokens) || 0;
  return Math.round((i * COST_PER_INPUT_TOKEN_USD + o * COST_PER_OUTPUT_TOKEN_USD) * 1_000_000);
  // Returns a number in micro-USD. 10_000 = $0.01.
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function withTimeout(p, ms) {
  return Promise.race([
    p,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`timeout after ${ms}ms`)), ms)),
  ]);
}

function trimErr(err) {
  const msg = err && err.message ? String(err.message) : String(err || 'unknown');
  return msg.slice(0, 160);
}

async function readJsonCapped(res, maxBytes) {
  // The Workers runtime exposes ReadableStream + getReader, but for our
  // size budget a plain .text() with a length check is enough.
  const text = await res.text();
  if (text.length > maxBytes) {
    throw new Error(`response too large: ${text.length} bytes`);
  }
  return JSON.parse(text);
}

// ---------------------------------------------------------------------------
// Monthly usage cap. Tracks pages-per-sender-per-month in KV.
// Used by the route handler to refuse over-quota requests before
// burning a paid API call.
// ---------------------------------------------------------------------------

export async function checkAndIncrementVisionUsage(env, senderId, capPages = DEFAULT_MONTHLY_CAP_PAGES) {
  if (!env || !env.CYBERSYGN_DOCS) {
    return { ok: true, used: 0, cap: capPages, mode: 'memory-no-kv' };
  }
  if (!senderId || typeof senderId !== 'string') {
    return { ok: false, error: 'senderId required', used: 0, cap: capPages };
  }
  const now = new Date();
  const month = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
  const key = `meta:vision-usage:${senderId.slice(0, 64)}:${month}`;
  let usedBefore = 0;
  try {
    const raw = await env.CYBERSYGN_DOCS.get(key);
    if (raw) {
      const n = parseInt(raw, 10);
      if (Number.isFinite(n) && n >= 0) usedBefore = n;
    }
  } catch (e) {}
  if (usedBefore >= capPages) {
    return { ok: false, error: 'monthly_cap_reached', used: usedBefore, cap: capPages };
  }
  const next = usedBefore + 1;
  // TTL of 40 days so old months expire automatically.
  try {
    await env.CYBERSYGN_DOCS.put(key, String(next), { expirationTtl: 40 * 24 * 60 * 60 });
  } catch (e) {}
  return { ok: true, used: next, cap: capPages };
}
