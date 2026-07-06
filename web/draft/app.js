/**
 * CyberSygn draft, the AI contract drafting wedge (/draft/).
 *
 * Flow:
 *   1. User picks a contract kind, describes the deal in plain English,
 *      optionally names both parties, and presses "Draft my contract".
 *   2. We POST that to /api/draft/generate and show a calm status.
 *   3. On { ok: true } we render draft.body in a readable preview with the
 *      "starting draft, not legal advice" disclaimer prominent, plus a
 *      "Copy text" action and an honest "Send it for signature" handoff to
 *      /preview/.
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
    renderNudge('Add a little more detail about the deal so the draft has something to work with. A sentence or two is plenty.');
    if (descEl) descEl.focus();
    return;
  }

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
    renderDraft(payload.draft, { kind, yourName, otherParty, description });
    return;
  }

  if (payload && payload.ok === false && payload.reason === 'unconfigured') {
    renderEarlyAccess();
    return;
  }

  // Any other shape (ok:false with another reason, or an unexpected body)
  // becomes a friendly retry rather than a raw error dump.
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

  // Send for signature. We stash the draft locally and open /preview/. This is
  // an honest handoff: /preview/ is where signing actually happens. We do not
  // claim the draft is auto-loaded unless it is; we hand off the text plus a
  // copy so the user is never stuck.
  const sendBtn = el('draft-send');
  if (sendBtn) {
    sendBtn.addEventListener('click', async () => {
      try {
        localStorage.setItem('cybersygn.draft.pending', JSON.stringify({
          kind: ctx.kind,
          title,
          body: draft.body,
          savedAt: Date.now(),
        }));
      } catch (e) {}
      // Copy the text too, so if the preview does not pre-fill, the user can
      // paste immediately. Then open the preview.
      await copyText(draft.body);
      window.location.href = '../preview/?from=draft';
    });
  }
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
          '<input id="draft-early-email" type="email" class="field__input" placeholder="you@email.com" autocomplete="email" required />' +
          '<button type="submit" class="btn btn--primary" id="draft-early-submit">Get early access</button>' +
        '</div>' +
        '<p class="draft-early__status caption" id="draft-early-status">Goes to CyberSygn, nowhere else.</p>' +
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
        if (emailInput) emailInput.focus();
        return;
      }
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
