/**
 * CyberSygn draft, the AI contract drafting wedge (/draft/).
 *
 * Flow:
 *   1. User picks a contract kind, describes the deal in plain English,
 *      optionally names both parties, and presses "Draft my contract".
 *   2. We POST that to /api/draft/generate and show a calm status.
 *   3. On { ok: true } we render draft.body in a readable preview with the
 *      "starting draft, not legal advice" disclaimer prominent, plus a
 *      "Copy text" action and a real "Send it for signature" handoff:
 *      the draft is rendered to a clean US Letter PDF entirely client-side
 *      (vendored pdf-lib, no network), downloaded, stashed in a
 *      sessionStorage bridge for the sender flow, and the user is guided
 *      into /preview/ where auto field detection takes over.
 *   4. On { ok: false, reason: "unconfigured" } we show a graceful early-
 *      access state: email capture (posts to /api/free/signup, mailto
 *      fallback) plus a strong secondary path to the 500+ template library.
 *   5. On any other failure we show a friendly retry, never a raw error.
 *
 * We reuse the site's senderId so a draft session and the preview app agree
 * on "which sender am I" without a real account system.
 */

import { getSenderId } from '../preview/identity.js';

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

/**
 * Escape text before it goes anywhere near innerHTML. The draft body, the
 * user's own inputs, and any server message are all untrusted from the DOM's
 * point of view, so everything that is inserted as markup passes through here.
 */
function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function el(id) { return document.getElementById(id); }

/**
 * Fire a first-party funnel event through the shared telemetry sink
 * (telemetry.js, loaded before this module). Never throws, never blocks the
 * user flow, and carries no extra PII: telemetry.js attaches only the
 * anonymous senderId, path, and tier. The draft description, party names, and
 * email are NEVER passed here.
 */
function track(event, props) {
  try {
    if (window.cybersygn && typeof window.cybersygn.track === 'function') {
      window.cybersygn.track(event, props || {});
    }
  } catch (e) {}
}

// Human labels for the kinds, used in the preview heading + the /preview/
// handoff title. Keep in sync with the <select> options in index.html.
const KIND_LABELS = {
  freelance: 'Freelance agreement',
  nda: 'NDA',
  consulting: 'Consulting agreement',
  sow: 'Statement of work',
  invoice: 'Invoice terms',
};

const DISCLAIMER = 'Starting draft, not legal advice. Review with a licensed attorney in your jurisdiction before signing.';

// The footer line baked into every page of the generated PDF itself.
const PDF_FOOTER = 'Starting draft generated with CyberSygn AI. Not legal advice. Review before signing.';

// sessionStorage bridge for the sender flow. /preview/ does not read this
// key today (its only programmatic loaders are the ?doc&t signer link and
// the ?pdf=<url> embed fetch, neither of which can carry a local file), so
// the working handoff is download + guidance. The bridge is written anyway,
// under a stable versioned key, so the preview app can pick it up the day
// it grows a loader, with zero changes needed here.
const PDF_BRIDGE_KEY = 'cybersygn.draft.pdf.v1';
// Stay far under the ~5MB sessionStorage quota. Generated drafts are tiny
// (tens of KB), this is just a guard against a pathological body.
const PDF_BRIDGE_MAX_B64 = 3.5 * 1024 * 1024;

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

const form = el('draft-form');
const output = el('draft-output');
const submitBtn = el('draft-submit');
const kindEl = el('draft-kind');
const descEl = el('draft-description');
const youEl = el('draft-you');
const otherEl = el('draft-other');

if (form && output) {
  form.addEventListener('submit', onSubmit);
}

async function onSubmit(e) {
  e.preventDefault();

  const kind = (kindEl && kindEl.value) || 'freelance';
  const description = (descEl && descEl.value || '').trim();
  const yourName = (youEl && youEl.value || '').trim();
  const otherParty = (otherEl && otherEl.value || '').trim();

  if (description.length < 12) {
    track('draft_validation_nudge', { source: 'draft' });
    // WCAG 3.3.1: flag the field itself as invalid; the nudge text renders
    // into the aria-live output region so it is announced (4.1.3).
    if (descEl) descEl.setAttribute('aria-invalid', 'true');
    renderNudge('Add a little more detail about the deal so the draft has something to work with. A sentence or two is plenty.');
    if (descEl) descEl.focus();
    return;
  }
  if (descEl) descEl.removeAttribute('aria-invalid');

  // cta_click: the user asked for a draft. Carry the kind (not the content).
  track('draft_requested', { source: 'draft', kind });
  const startedAt = Date.now();

  setLoading(true);
  renderStatus('Drafting your contract. This takes a few seconds.');

  let payload;
  try {
    const res = await fetch('/api/draft/generate', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'accept': 'application/json' },
      body: JSON.stringify({
        kind,
        description,
        yourName,
        otherParty,
        senderId: safeSenderId(),
      }),
    });
    // A body is not guaranteed on every status; tolerate a non-JSON response.
    payload = await res.json().catch(() => null);

    // Treat an unconfigured backend as a first-class, graceful state whether
    // the Worker signals it in the body or via a 501/503 with no body.
    if (!payload && (res.status === 501 || res.status === 503)) {
      payload = { ok: false, reason: 'unconfigured' };
    }
  } catch (err) {
    setLoading(false);
    renderRetry();
    return;
  }

  setLoading(false);

  if (payload && payload.ok && payload.draft && typeof payload.draft.body === 'string') {
    // activation: a real draft came back. durationMs = time to first draft.
    track('draft_generated', { source: 'draft', durationMs: Date.now() - startedAt });
    renderDraft(payload.draft, { kind, yourName, otherParty, description });
    return;
  }

  if (payload && payload.ok === false && payload.reason === 'unconfigured') {
    track('draft_early_access_shown', { source: 'draft' });
    renderEarlyAccess();
    return;
  }

  // Any other shape (ok:false with another reason, or an unexpected body)
  // becomes a friendly retry rather than a raw error dump.
  track('draft_failed', { source: 'draft' });
  renderRetry();
}

function safeSenderId() {
  try { return getSenderId(); } catch { return ''; }
}

function setLoading(on) {
  if (!submitBtn) return;
  submitBtn.disabled = !!on;
  submitBtn.setAttribute('aria-busy', on ? 'true' : 'false');
  submitBtn.innerHTML = on
    ? 'Drafting<span class="draft-dots" aria-hidden="true"></span>'
    : 'Draft my contract <span class="btn-arrow" aria-hidden="true">&rarr;</span>';
}

// ---------------------------------------------------------------------------
// Render states. Each fully replaces the output panel's contents.
// ---------------------------------------------------------------------------

function renderStatus(message) {
  output.innerHTML =
    '<div class="draft-status" role="status">' +
      '<span class="draft-spinner" aria-hidden="true"></span>' +
      '<p class="draft-status__text">' + esc(message) + '</p>' +
    '</div>';
}

function renderNudge(message) {
  output.innerHTML =
    '<div class="draft-note">' +
      '<p class="draft-note__text">' + esc(message) + '</p>' +
    '</div>';
}

function renderRetry() {
  output.innerHTML =
    '<div class="draft-note draft-note--retry">' +
      '<p class="draft-note__text">Something went wrong on our side. Nothing you did. Give it another try in a moment.</p>' +
      '<button type="button" class="btn btn--ghost" id="draft-retry">Try again</button>' +
    '</div>';
  const retry = el('draft-retry');
  if (retry) retry.addEventListener('click', () => {
    if (form) form.requestSubmit ? form.requestSubmit() : form.dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }));
  });
}

function renderDraft(draft, ctx) {
  const heading = KIND_LABELS[ctx.kind] || 'Your contract';
  const title = draft.title && String(draft.title).trim() ? String(draft.title).trim() : heading;

  output.innerHTML =
    '<div class="draft-result">' +
      '<div class="draft-result__head">' +
        '<p class="kicker kicker--muted">Your draft</p>' +
        '<h2 class="draft-result__title">' + esc(title) + '</h2>' +
      '</div>' +
      '<p class="draft-result__disclaimer" role="note">' + esc(DISCLAIMER) + '</p>' +
      '<pre class="draft-result__body" id="draft-result-body">' + esc(draft.body) + '</pre>' +
      '<div class="draft-result__actions">' +
        '<button type="button" class="btn btn--ghost" id="draft-copy">Copy text</button>' +
        '<button type="button" class="btn btn--primary" id="draft-send">Send it for signature <span class="btn-arrow" aria-hidden="true">&rarr;</span></button>' +
      '</div>' +
      '<p class="draft-result__handoff caption" id="draft-handoff">Signing opens the preview, where you drop this draft in, review it, and route it to signers. Every signed PDF carries a tamper-evident audit trail.</p>' +
    '</div>';

  // Copy: use the clipboard API where present, fall back to a select-all hint.
  const copyBtn = el('draft-copy');
  if (copyBtn) {
    copyBtn.addEventListener('click', async () => {
      const ok = await copyText(draft.body);
      copyBtn.textContent = ok ? 'Copied' : 'Press Cmd or Ctrl + C';
      setTimeout(() => { copyBtn.textContent = 'Copy text'; }, 2200);
      if (!ok) selectBody();
    });
  }

  // Send for signature: a real handoff. Render the draft to a clean PDF
  // client-side (vendored pdf-lib, zero network), download it, stash the
  // sessionStorage bridge, and guide the user into /preview/ where auto
  // field detection takes over. Honest at every step: we never claim the
  // preview pre-loads the file, because today it does not.
  const sendBtn = el('draft-send');
  if (sendBtn) {
    sendBtn.addEventListener('click', () => startSendHandoff(sendBtn, draft, ctx, title));
  }
}

// ---------------------------------------------------------------------------
// Send-for-signature handoff: client-side PDF + download + guided /preview/.
// ---------------------------------------------------------------------------

async function startSendHandoff(sendBtn, draft, ctx, title) {
  // checkout_started proxy: the user chose to route this draft into signing.
  track('draft_send_started', { source: 'draft', kind: ctx && ctx.kind });
  const priorHtml = sendBtn.innerHTML;
  sendBtn.disabled = true;
  sendBtn.setAttribute('aria-busy', 'true');
  sendBtn.innerHTML = 'Preparing your PDF<span class="draft-dots" aria-hidden="true"></span>';

  // Stash the plain-text draft locally either way, so nothing is ever lost.
  try {
    localStorage.setItem('cybersygn.draft.pending', JSON.stringify({
      kind: ctx.kind,
      title,
      body: draft.body,
      savedAt: Date.now(),
    }));
  } catch (e) {}

  let pdfBytes;
  try {
    pdfBytes = await generateDraftPdf(title, draft.body);
  } catch (err) {
    // PDF generation failed (old browser, blocked module, corrupt vendor
    // file). Fall back to the previous honest handoff: copy the text and
    // open the preview, where the user can paste or upload their own file.
    sendBtn.disabled = false;
    sendBtn.removeAttribute('aria-busy');
    sendBtn.innerHTML = priorHtml;
    await copyText(draft.body);
    window.location.href = '../preview/?from=draft';
    return;
  }

  const filename = pdfFilename(title);

  // sessionStorage bridge for a future preview-side loader. Best-effort.
  try {
    const b64 = bytesToBase64(pdfBytes);
    if (b64.length <= PDF_BRIDGE_MAX_B64) {
      sessionStorage.setItem(PDF_BRIDGE_KEY, JSON.stringify({
        v: 1,
        kind: ctx.kind,
        title,
        filename,
        savedAt: Date.now(),
        pdfBase64: b64,
      }));
    }
  } catch (e) {}

  // Trigger the download, then show the guided handoff card.
  const blob = new Blob([pdfBytes], { type: 'application/pdf' });
  const url = URL.createObjectURL(blob);
  triggerDownload(url, filename);

  sendBtn.disabled = false;
  sendBtn.removeAttribute('aria-busy');
  sendBtn.innerHTML = priorHtml;

  // The PDF is built and downloaded: the handoff into the signer flow is live.
  track('draft_send_ready', { source: 'draft' });
  renderSendoff({ url, filename, sizeKb: Math.max(1, Math.round(pdfBytes.length / 1024)), draft, ctx, title });
}

function triggerDownload(url, filename) {
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  a.remove();
}

function pdfFilename(title) {
  const slug = String(title || 'contract-draft')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60) || 'contract-draft';
  return slug + '-draft.pdf';
}

function bytesToBase64(bytes) {
  let binary = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

/**
 * The post-generation handoff screen. Mobile-first: every action is a
 * full-width comfortable tap target, guidance is plain English, and the
 * user can always get back to the draft text.
 */
function renderSendoff(state) {
  output.innerHTML =
    '<div class="draft-sendoff">' +
      '<p class="kicker kicker--muted">Ready to send</p>' +
      '<h2 class="draft-sendoff__title">Your draft PDF downloaded.</h2>' +
      '<div class="draft-sendoff__card">' +
        '<div class="draft-sendoff__file">' +
          '<span class="draft-sendoff__file-name" id="draft-pdf-name">' + esc(state.filename) + '</span>' +
          '<span class="draft-sendoff__file-meta">PDF, ' + esc(String(state.sizeKb)) + ' KB, US Letter</span>' +
        '</div>' +
        '<button type="button" class="btn btn--ghost draft-sendoff__again" id="draft-download-again">Download again</button>' +
      '</div>' +
      '<a class="btn btn--primary btn--lg btn--block" id="draft-open-sender" href="../preview/?from=draft">Open the sender <span class="btn-arrow" aria-hidden="true">&rarr;</span></a>' +
      '<p class="draft-sendoff__guide">Drop the downloaded PDF into the sender. It auto-detects signature fields, then you add signers and send.</p>' +
      '<p class="draft-result__disclaimer" role="note">' + esc(DISCLAIMER) + '</p>' +
      '<button type="button" class="btn btn--ghost btn--block" id="draft-back">Back to the draft text</button>' +
    '</div>';

  const again = el('draft-download-again');
  if (again) {
    again.addEventListener('click', () => {
      triggerDownload(state.url, state.filename);
      again.textContent = 'Downloaded';
      setTimeout(() => { again.textContent = 'Download again'; }, 2200);
    });
  }

  const back = el('draft-back');
  if (back) {
    back.addEventListener('click', () => {
      try { URL.revokeObjectURL(state.url); } catch (e) {}
      renderDraft(state.draft, state.ctx);
    });
  }
}

// ---------------------------------------------------------------------------
// Client-side PDF rendering (vendored pdf-lib, imported on demand).
// ---------------------------------------------------------------------------

/**
 * Render the draft text into a simple professional US Letter PDF:
 * a title, a thin rule, wrapped body text with page breaks, and the
 * AI-draft disclaimer footer on every page. Standard fonts only, so
 * nothing is fetched over the network.
 */
async function generateDraftPdf(title, body) {
  // ../vendor/pdf-lib.mjs resolves in both layouts: web/draft/ next to
  // web/vendor/ in dev, dist/draft/ next to dist/vendor/ after build.
  const { PDFDocument, StandardFonts, rgb } = await import('../vendor/pdf-lib.mjs');

  const doc = await PDFDocument.create();
  doc.setTitle(winAnsiSafe(title));
  doc.setCreator('CyberSygn AI draft');
  doc.setProducer('CyberSygn');

  const bodyFont = await doc.embedFont(StandardFonts.Helvetica);
  const boldFont = await doc.embedFont(StandardFonts.HelveticaBold);

  const PAGE_W = 612;               // US Letter, points
  const PAGE_H = 792;
  const MARGIN = 72;                // 1 inch
  const FOOTER_ZONE = 44;           // reserved for the disclaimer footer
  const CONTENT_W = PAGE_W - MARGIN * 2;
  const BODY_SIZE = 10.5;
  const BODY_LEAD = 15.5;
  const TITLE_SIZE = 16;
  const TITLE_LEAD = 21;

  const ink = rgb(0.08, 0.12, 0.2);
  const faint = rgb(0.45, 0.49, 0.56);

  let page = doc.addPage([PAGE_W, PAGE_H]);
  let y = PAGE_H - MARGIN;

  function ensureRoom(lead) {
    if (y - lead < MARGIN + FOOTER_ZONE) {
      page = doc.addPage([PAGE_W, PAGE_H]);
      y = PAGE_H - MARGIN;
    }
  }

  // Title, wrapped, then a thin rule under it.
  const titleLines = wrapText(winAnsiSafe(title), boldFont, TITLE_SIZE, CONTENT_W);
  for (const line of titleLines) {
    ensureRoom(TITLE_LEAD);
    y -= TITLE_LEAD;
    page.drawText(line, { x: MARGIN, y, size: TITLE_SIZE, font: boldFont, color: ink });
  }
  y -= 10;
  ensureRoom(2);
  page.drawLine({
    start: { x: MARGIN, y },
    end: { x: PAGE_W - MARGIN, y },
    thickness: 0.75,
    color: faint,
  });
  y -= 14;

  // Body: paragraph by paragraph, wrapped, blank lines preserved.
  const paragraphs = winAnsiSafe(body).split('\n');
  for (const para of paragraphs) {
    if (para.trim() === '') { y -= BODY_LEAD * 0.6; continue; }
    const lines = wrapText(para, bodyFont, BODY_SIZE, CONTENT_W);
    for (const line of lines) {
      ensureRoom(BODY_LEAD);
      y -= BODY_LEAD;
      page.drawText(line, { x: MARGIN, y, size: BODY_SIZE, font: bodyFont, color: ink });
    }
  }

  // Footer on every page: the AI-draft disclaimer plus a page number.
  const pages = doc.getPages();
  const FOOT_SIZE = 7.5;
  for (let i = 0; i < pages.length; i++) {
    const p = pages[i];
    const footW = bodyFont.widthOfTextAtSize(PDF_FOOTER, FOOT_SIZE);
    p.drawText(PDF_FOOTER, {
      x: Math.max(MARGIN, (PAGE_W - footW) / 2),
      y: 34,
      size: FOOT_SIZE,
      font: bodyFont,
      color: faint,
    });
    const pageLabel = 'Page ' + (i + 1) + ' of ' + pages.length;
    const plW = bodyFont.widthOfTextAtSize(pageLabel, FOOT_SIZE);
    p.drawText(pageLabel, {
      x: (PAGE_W - plW) / 2,
      y: 22,
      size: FOOT_SIZE,
      font: bodyFont,
      color: faint,
    });
  }

  return doc.save();
}

/**
 * pdf-lib's standard fonts encode WinAnsi only; anything outside throws.
 * Map the common typographic characters to safe equivalents and strip the
 * rest, so a stray glyph never kills the whole handoff.
 */
function winAnsiSafe(s) {
  return String(s == null ? '' : s)
    .replace(/[\u2018\u2019\u201A\u2032]/g, "'")
    .replace(/[\u201C\u201D\u201E\u2033]/g, '"')
    .replace(/[\u2010-\u2015\u2212]/g, '-')
    .replace(/\u2026/g, '...')
    .replace(/[\u2022\u25CF\u25AA\u25E6]/g, '-')
    .replace(/[\u00A0\u2000-\u200B\u202F\u3000]/g, ' ')
    .replace(/\t/g, '    ')
    .replace(/\r\n?/g, '\n')
    .replace(/[^\n\x20-\x7E\xA1-\xFF]/g, '');
}

/**
 * Greedy word wrap using real font metrics. Words wider than the column
 * are hard-broken by characters so nothing can overflow the margin.
 */
function wrapText(text, font, size, maxWidth) {
  const words = String(text).split(' ');
  const lines = [];
  let cur = '';

  const width = (t) => font.widthOfTextAtSize(t, size);

  const pushWord = (word) => {
    if (width(word) <= maxWidth) {
      const test = cur ? cur + ' ' + word : word;
      if (width(test) <= maxWidth) { cur = test; return; }
      if (cur) lines.push(cur);
      cur = word;
      return;
    }
    // A single over-wide token (a long URL, say): break it by characters.
    if (cur) { lines.push(cur); cur = ''; }
    let piece = '';
    for (const ch of word) {
      if (width(piece + ch) > maxWidth && piece) {
        lines.push(piece);
        piece = ch;
      } else {
        piece += ch;
      }
    }
    cur = piece;
  };

  for (const w of words) {
    if (w === '') continue;
    pushWord(w);
  }
  if (cur) lines.push(cur);
  return lines.length ? lines : [''];
}

function selectBody() {
  const pre = el('draft-result-body');
  if (!pre) return;
  try {
    const range = document.createRange();
    range.selectNodeContents(pre);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
  } catch (e) {}
}

async function copyText(text) {
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch (e) {}
  return false;
}

// Graceful "AI drafting is rolling out" state. Real email capture (posts to
// the existing /api/free/signup, mailto fallback) plus a strong secondary
// path to the proven template library. No fabricated urgency or counts.
function renderEarlyAccess() {
  output.innerHTML =
    '<div class="draft-early">' +
      '<p class="kicker kicker--muted">Rolling out</p>' +
      '<h2 class="draft-early__title">AI drafting is rolling out.</h2>' +
      '<p class="draft-early__body">It is not switched on for every account yet. Leave your email and we will let you know the moment it reaches you.</p>' +
      '<form id="draft-early-form" class="draft-early__form" autocomplete="on">' +
        '<label class="draft-field-label" for="draft-early-email">Email</label>' +
        '<div class="draft-early__row">' +
          '<input id="draft-early-email" type="email" class="field__input" placeholder="you@email.com" autocomplete="email" aria-describedby="draft-early-status" required />' +
          '<button type="submit" class="btn btn--primary" id="draft-early-submit">Get early access</button>' +
        '</div>' +
        '<p class="draft-early__status caption" id="draft-early-status" role="status" aria-live="polite">Goes to CyberSygn, nowhere else.</p>' +
      '</form>' +
      '<div class="draft-early__alt">' +
        '<p class="draft-early__alt-lead">Prefer to start from a proven template?</p>' +
        '<a class="btn btn--ghost" href="../templates/">Browse 500+ templates</a>' +
      '</div>' +
    '</div>';

  const earlyForm = el('draft-early-form');
  const emailInput = el('draft-early-email');
  const statusEl = el('draft-early-status');
  const earlyBtn = el('draft-early-submit');

  if (earlyForm) {
    earlyForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      const email = (emailInput && emailInput.value || '').trim();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        if (statusEl) statusEl.textContent = 'Enter a valid email so we can reach you.';
        if (emailInput) { emailInput.setAttribute('aria-invalid', 'true'); emailInput.focus(); }
        return;
      }
      if (emailInput) emailInput.removeAttribute('aria-invalid');
      if (earlyBtn) earlyBtn.disabled = true;
      if (statusEl) statusEl.textContent = 'Adding you to the list.';
      try {
        const res = await fetch('/api/free/signup', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ firstName: 'Friend', lastName: 'CyberSygn', email }),
        });
        const data = await res.json().catch(() => ({}));
        if (data && data.ok) {
          // lead_capture: an early-access email was accepted. The email itself
          // is never sent to telemetry, only that a lead was captured.
          track('draft_lead_captured', { source: 'draft' });
          if (statusEl) statusEl.textContent = 'You are on the list. We will be in touch.';
          return;
        }
        // Backend not reachable or declined: fall back to a plain mailto so
        // the intent is never lost.
        mailtoFallback(email, statusEl);
      } catch (err) {
        mailtoFallback(email, statusEl);
      } finally {
        if (earlyBtn) earlyBtn.disabled = false;
      }
    });
  }
}

function mailtoFallback(email, statusEl) {
  const subject = encodeURIComponent('Early access to AI contract drafting');
  const body = encodeURIComponent('Please add ' + email + ' to the AI drafting early-access list.');
  window.location.href = 'mailto:hello@cybersygn.io?subject=' + subject + '&body=' + body;
  if (statusEl) statusEl.textContent = 'Opening your email app so you can send the request.';
}
