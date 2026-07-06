/**
 * CyberSygn verify page (/verify/) client.
 *
 * A public "verify a signature" surface. It takes a 64-hex document
 * fingerprint, either pasted into the field or passed as ?h=<hash> in the
 * URL (the form the verify link / QR on a signed PDF uses), and calls the
 * public GET /api/verify/:hash endpoint.
 *
 * The endpoint returns PII-FREE facts only:
 *   { found:true, fingerprint, signerCount, completedAt, status } | { found:false }
 * so this client never has a name, email, title, or content to display, and
 * never fabricates any. It renders one of three honest states: verified,
 * no-record, or a friendly retry on a transport error.
 *
 * No imports: same-origin fetch, no build-time rewrites, degrades to a
 * calm error if the Worker is unreachable.
 */

const form = document.getElementById('verify-form');
const input = document.getElementById('verify-hash');
const submitBtn = document.getElementById('verify-submit');
const result = document.getElementById('verify-result');

// A fingerprint is exactly 64 lowercase hex characters (SHA-256 of the PDF).
const HASH_RE = /^[a-f0-9]{64}$/;

/** Escape user-influenced text before HTML insertion. */
function esc(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Normalise a pasted fingerprint: strip whitespace, lowercase. Accepts a
 *  full verify URL too, pulling ?h= out of it so a pasted link just works. */
function normalizeHash(raw) {
  let v = String(raw || '').trim();
  if (!v) return '';
  // If someone pasted a whole verify URL, extract the h param.
  if (/[?&]h=/.test(v)) {
    try {
      const u = new URL(v, location.href);
      v = u.searchParams.get('h') || v;
    } catch (e) {
      const m = v.match(/[?&]h=([^&\s]+)/);
      if (m) v = decodeURIComponent(m[1]);
    }
  }
  return v.replace(/\s+/g, '').toLowerCase();
}

/** Format an ISO timestamp for humans. Falls back to the raw string if it
 *  is not parseable, and never throws. */
function formatDate(iso) {
  if (!iso) return null;
  const d = new Date(iso);
  if (isNaN(d.getTime())) return null;
  try {
    return d.toLocaleString(undefined, {
      year: 'numeric', month: 'long', day: 'numeric',
      hour: 'numeric', minute: '2-digit',
    });
  } catch (e) {
    return d.toISOString();
  }
}

function show(html) {
  result.innerHTML = html;
  result.hidden = false;
}

function setBusy(busy) {
  submitBtn.disabled = busy;
  submitBtn.textContent = busy ? 'Verifying...' : 'Verify signature';
}

/** Loading state while the request is in flight. */
function renderLoading(hash) {
  show(
    '<div class="verify-card verify-card--none">' +
      '<div class="verify-card__head">' +
        '<span class="verify-card__badge" aria-hidden="true">&#8230;</span>' +
        '<h2 class="verify-card__title">Checking the record</h2>' +
      '</div>' +
      '<p class="verify-card__body"><span class="verify-fact__value--hash">' + esc(hash) + '</span></p>' +
    '</div>'
  );
}

/** Verified: a confident, honest found state. All fields are PII-free. */
function renderFound(data) {
  const signers = Number(data.signerCount);
  const signerText = Number.isFinite(signers) && signers > 0
    ? (signers === 1 ? '1 signer' : signers + ' signers')
    : 'Not reported';
  const when = formatDate(data.completedAt);
  const fingerprint = typeof data.fingerprint === 'string' ? data.fingerprint : '';

  show(
    '<div class="verify-card verify-card--found">' +
      '<div class="verify-card__head">' +
        '<span class="verify-card__badge" aria-hidden="true">&#10003;</span>' +
        '<h2 class="verify-card__title">Signed on CyberSygn</h2>' +
      '</div>' +
      '<p class="verify-card__body">This fingerprint matches a document that was completed on CyberSygn. The signed file has not changed since.</p>' +
      '<ul class="verify-facts">' +
        '<li class="verify-fact">' +
          '<span class="verify-fact__label">Fingerprint</span>' +
          '<span class="verify-fact__value--hash">' + esc(fingerprint) + '</span>' +
        '</li>' +
        '<li class="verify-fact">' +
          '<span class="verify-fact__label">Signers</span>' +
          '<span class="verify-fact__value">' + esc(signerText) + '</span>' +
        '</li>' +
        '<li class="verify-fact">' +
          '<span class="verify-fact__label">Completed</span>' +
          '<span class="verify-fact__value">' + esc(when || 'Not reported') + '</span>' +
        '</li>' +
      '</ul>' +
      '<p class="verify-scope">This confirms integrity: the document reached completion on CyberSygn and its fingerprint still matches. It is not a legal opinion on the agreement.</p>' +
    '</div>'
  );
}

/** No record: a calm, non-alarming state with practical guidance. */
function renderNotFound(hash) {
  show(
    '<div class="verify-card verify-card--none">' +
      '<div class="verify-card__head">' +
        '<span class="verify-card__badge" aria-hidden="true">?</span>' +
        '<h2 class="verify-card__title">No record found</h2>' +
      '</div>' +
      '<p class="verify-card__body">We have no completed signing on file for that fingerprint.</p>' +
      (hash ? '<p class="verify-scope"><span class="verify-fact__value--hash">' + esc(hash) + '</span></p>' : '') +
      '<ul class="verify-guidance">' +
        '<li>Check that you copied the full 64-character fingerprint, with nothing missing or added.</li>' +
        '<li>The fingerprint comes from a completed document. A document still awaiting signatures will not have one yet.</li>' +
        '<li>If you opened this from a signed PDF, use the exact verify link or QR code printed on it.</li>' +
      '</ul>' +
    '</div>'
  );
}

/** Bad input: the field does not hold a valid fingerprint. */
function renderInvalid() {
  show(
    '<div class="verify-card verify-card--none">' +
      '<div class="verify-card__head">' +
        '<span class="verify-card__badge" aria-hidden="true">?</span>' +
        '<h2 class="verify-card__title">That is not a fingerprint</h2>' +
      '</div>' +
      '<p class="verify-card__body">A CyberSygn fingerprint is exactly 64 characters, each one 0 to 9 or a to f. Paste the whole code, or open the verify link from a signed document.</p>' +
    '</div>'
  );
}

/** Transport error: friendly, retryable, never blames the visitor. */
function renderError() {
  show(
    '<div class="verify-card verify-card--error">' +
      '<div class="verify-card__head">' +
        '<span class="verify-card__badge" aria-hidden="true">&#33;</span>' +
        '<h2 class="verify-card__title">Could not reach the check</h2>' +
      '</div>' +
      '<p class="verify-card__body">Something got in the way of confirming this fingerprint. It is not a problem with your document. Give it a moment and try again.</p>' +
      '<div class="verify-card__actions">' +
        '<button type="button" class="btn btn--ghost" id="verify-retry">Try again</button>' +
      '</div>' +
    '</div>'
  );
  const retry = document.getElementById('verify-retry');
  if (retry) retry.addEventListener('click', () => run(input.value));
}

/** Run one verification for whatever is currently in `raw`. */
async function run(raw) {
  const hash = normalizeHash(raw);
  if (!HASH_RE.test(hash)) {
    renderInvalid();
    return;
  }
  setBusy(true);
  renderLoading(hash);
  try {
    const res = await fetch('/api/verify/' + encodeURIComponent(hash), {
      method: 'GET',
      headers: { 'accept': 'application/json' },
    });
    let data = null;
    try { data = await res.json(); } catch (e) {}
    if (!res.ok || !data) {
      renderError();
      return;
    }
    if (data.found) {
      renderFound(data);
    } else {
      renderNotFound(hash);
    }
  } catch (err) {
    renderError();
  } finally {
    setBusy(false);
  }
}

// Submit handler.
if (form) {
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    run(input.value);
  });
}

// Cmd/Ctrl+Enter or Enter (via enterkeyhint "go") submits from the textarea.
if (input) {
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      run(input.value);
    }
  });
}

// Auto-run when the URL carries ?h=<hash> (the signed-PDF verify link / QR).
(function bootFromURL() {
  const wanted = new URLSearchParams(location.search).get('h');
  if (!wanted) return;
  const hash = normalizeHash(wanted);
  if (input) input.value = hash;
  run(hash);
})();
