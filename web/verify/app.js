/**
 * CyberSygn verify page (/verify/) client.
 *
 * A public "verify a signature" surface. It takes a 64-hex fingerprint,
 * either pasted into the field or passed as ?h=<hash> in the URL (the form
 * the verify link on an audit certificate uses), and calls the public
 * GET /api/verify/:hash endpoint.
 *
 * TWO FILES, TWO FINGERPRINTS. A completed multi-signer document can have a
 * fingerprint for the ORIGINAL that was put in front of the signers, and one
 * for the SIGNED PDF the Worker produced at completion. The endpoint may
 * report which of the two the queried hash is, and what the other one is:
 *   { found:true, fingerprint, signerCount, createdAt, completedAt, status,
 *     matched?: 'signed'|'original', signedSha256?: string|null,
 *     originalSha256?: string|null }
 * Those three fields are OPTIONAL. An older Worker returns only the first
 * six, in which case this client says a record matched and does NOT claim to
 * know which file it belongs to. It never guesses and never fabricates.
 *
 * Everything the endpoint returns is PII-FREE: no name, email, title, or
 * content, so this client has none to display.
 *
 * No imports: same-origin fetch, no build-time rewrites, degrades to a
 * calm error if the Worker is unreachable.
 */

const form = document.getElementById('verify-form');
const input = document.getElementById('verify-hash');
const submitBtn = document.getElementById('verify-submit');
const result = document.getElementById('verify-result');

// A fingerprint is exactly 64 lowercase hex characters (SHA-256 of a file).
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

/** A 64-hex string, lowercased, or '' when the value is not one. */
function asHash(v) {
  const s = String(v == null ? '' : v).trim().toLowerCase();
  return HASH_RE.test(s) ? s : '';
}

/** Normalise a pasted fingerprint. Accepts, in order of preference:
 *   - a full verify URL, pulling ?h= out of it so a pasted link just works
 *   - a line of tool output ("<hash>  file.pdf" from shasum, or the Hash
 *     column of Get-FileHash), by taking the standalone 64-hex token
 *   - the hash printed on the audit certificate in spaced groups across two
 *     rows, by stripping whitespace
 */
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
  // A 64-hex run bounded by whitespace or string edges is the hash itself,
  // even when a filename or a column header rode along with it.
  const token = v.match(/(^|\s)([0-9a-fA-F]{64})(\s|$)/);
  if (token) return token[2].toLowerCase();
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

/** One label/value row in the facts list. */
function fact(label, value, hash) {
  return '<li class="verify-fact">' +
    '<span class="verify-fact__label">' + esc(label) + '</span>' +
    '<span class="' + (hash ? 'verify-fact__value--hash' : 'verify-fact__value') + '">' + esc(value) + '</span>' +
  '</li>';
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

/**
 * Which file the queried hash identifies: 'signed', 'original', or '' when
 * the record does not say. Trusts an explicit label from the endpoint first,
 * then falls back to comparing the queried hash against the two hashes the
 * record carries. Never guesses beyond that.
 */
function whichFile(data, queried) {
  const label = String(data.matched || data.kind || '');
  if (label === 'signed' || label === 'original') return label;
  if (asHash(data.signedSha256) && asHash(data.signedSha256) === queried) return 'signed';
  if (asHash(data.originalSha256) && asHash(data.originalSha256) === queried) return 'original';
  return '';
}

/** Verified: a confident, honest found state. All fields are PII-free. */
function renderFound(data, queried) {
  // Funnel instrument: a certificate successfully rendered. The transport
  // (telemetry.js) is loaded on this page; guard anyway and never throw.
  try {
    if (window.cybersygn && typeof window.cybersygn.track === 'function') {
      window.cybersygn.track('cert_verified');
    }
  } catch (e) {}
  const signers = Number(data.signerCount);
  const signerText = Number.isFinite(signers) && signers > 0
    ? (signers === 1 ? '1 signer' : signers + ' signers')
    : 'Not reported';
  const when = formatDate(data.completedAt);
  // Echo back what the visitor actually checked. The record's own
  // `fingerprint` is the same value on every current Worker, but the queried
  // hash is the one the visitor can compare against their file.
  const fingerprint = queried || asHash(data.fingerprint);

  const signedHash = asHash(data.signedSha256);
  const originalHash = asHash(data.originalSha256);
  const matched = whichFile(data, fingerprint);

  // The body sentence has to be true in all three cases, including the case
  // where an older Worker tells us only that a record exists.
  let body;
  if (matched === 'signed') {
    body = 'You checked the signed PDF that CyberSygn issued for this document, the copy with every ' +
      'signature drawn into it. It matches the record byte for byte, so the file has not changed since ' +
      'signing completed.';
  } else if (matched === 'original') {
    body = 'You checked the original document, the file as it was uploaded before anyone signed it. ' +
      'A document with this fingerprint was completed on CyberSygn, and the original has not changed ' +
      'by a byte since.';
    body += signedHash
      ? ' CyberSygn also issued a signed PDF for it, with a different fingerprint, shown below. If you ' +
        'are holding a signed copy, check that fingerprint instead.'
      : ' CyberSygn did not produce a signed file of its own for this document, so this original ' +
        'fingerprint is the only one on record. A signed copy of it will not match anything here.';
  } else {
    body = 'This fingerprint matches a document that was completed on CyberSygn, and the file carrying ' +
      'it has not changed by a byte since. The record does not say which of the two files it is, the ' +
      'original or the signed copy.';
  }

  const identifies = matched === 'signed'
    ? 'The signed PDF CyberSygn issued'
    : (matched === 'original' ? 'The original document, before signatures' : '');

  let facts = fact('Fingerprint you checked', fingerprint, true);
  if (identifies) facts += fact('Identifies', identifies, false);
  if (matched === 'original' && signedHash) facts += fact('Signed PDF fingerprint', signedHash, true);
  if (matched === 'signed' && originalHash && originalHash !== fingerprint) {
    facts += fact('Original PDF fingerprint', originalHash, true);
  }
  facts += fact('Signers', signerText, false);
  facts += fact('Completed', when || 'Not reported', false);

  show(
    '<div class="verify-card verify-card--found">' +
      '<div class="verify-card__head">' +
        '<span class="verify-card__badge" aria-hidden="true">&#10003;</span>' +
        '<h2 class="verify-card__title">Signed on CyberSygn</h2>' +
      '</div>' +
      '<p class="verify-card__body">' + esc(body) + '</p>' +
      '<ul class="verify-facts">' + facts + '</ul>' +
      '<p class="verify-scope">This confirms integrity: a document reached completion on CyberSygn and the file with this fingerprint still matches the record. It is not a legal opinion on the agreement, and the record carries no names, addresses, or content.</p>' +
      '<div class="verify-card__actions">' +
        '<button type="button" class="btn btn--primary" id="verify-share">Share this certificate</button>' +
        '<a class="btn btn--ghost" href="/preview/?src=verify-share" rel="noopener">Sign your own document</a>' +
      '</div>' +
    '</div>'
  );

  // Make the verified record a shareable certificate: native share sheet where
  // available, clipboard copy everywhere else. The shared link is the canonical
  // public verify URL for this fingerprint, which carries no PII.
  const shareBtn = document.getElementById('verify-share');
  if (shareBtn && fingerprint) {
    const shareUrl = location.origin + '/verify/?h=' + encodeURIComponent(fingerprint);
    const shareData = {
      title: 'Signed and verified on CyberSygn',
      text: 'This document was signed and verified on CyberSygn. Confirm its integrity here.',
      url: shareUrl,
    };
    shareBtn.addEventListener('click', async () => {
      try {
        if (navigator.share) { await navigator.share(shareData); return; }
      } catch (e) { if (e && e.name === 'AbortError') return; }
      try {
        await navigator.clipboard.writeText(shareUrl);
        const original = shareBtn.textContent;
        shareBtn.textContent = 'Link copied';
        shareBtn.disabled = true;
        setTimeout(() => { shareBtn.textContent = original; shareBtn.disabled = false; }, 1800);
      } catch (e) {
        window.prompt('Copy this certificate link:', shareUrl);
      }
    });
  }
}

/**
 * No record. The endpoint cannot tell "wrong file" from "not ours", so this
 * splits the guidance into those two situations and lets the visitor place
 * themselves. The wrong-file case comes first because it is the likelier one
 * for anyone who hashed a PDF: any tool that re-saves the file changes its
 * bytes, and older documents are on record under the original only.
 */
function renderNotFound(hash) {
  show(
    '<div class="verify-card verify-card--none">' +
      '<div class="verify-card__head">' +
        '<span class="verify-card__badge" aria-hidden="true">?</span>' +
        '<h2 class="verify-card__title">No record found</h2>' +
      '</div>' +
      '<p class="verify-card__body">No completed CyberSygn signing is on record under that fingerprint. That means one of two things, and they are worth telling apart.</p>' +
      (hash ? '<p class="verify-scope"><span class="verify-fact__value--hash">' + esc(hash) + '</span></p>' : '') +
      '<p class="verify-card__body"><strong>You may have hashed a different file than the one on record.</strong></p>' +
      '<ul class="verify-guidance">' +
        '<li>Hash the copy exactly as you downloaded it from CyberSygn. Re-saving, re-exporting, printing to PDF, or flattening the document again in another tool rewrites the bytes and changes the fingerprint.</li>' +
        '<li>Older documents, and documents where CyberSygn produced no signed file of its own, are on record under the fingerprint of the ORIGINAL upload only. For those, a signed copy will never match. Check the original file instead.</li>' +
        '<li>The audit certificate prints every fingerprint on record for its document, each labelled with the file it belongs to. Those are the values that will match.</li>' +
        '<li>Check you copied all 64 characters, with nothing missing or added. <a href="#how-to-hash">How to fingerprint a file.</a></li>' +
      '</ul>' +
      '<p class="verify-card__body"><strong>Or the document was never completed on CyberSygn.</strong></p>' +
      '<ul class="verify-guidance">' +
        '<li>The record is written the moment the last signer finishes. A document still waiting on a signature does not have one yet.</li>' +
        '<li>A document signed by one person alone in the browser is flattened on that device and never reaches our servers, so it has no public record.</li>' +
        '<li>If none of these fit, then no document with that fingerprint was completed on CyberSygn.</li>' +
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
      '<p class="verify-card__body">A fingerprint is exactly 64 characters, each one 0 to 9 or a to f. Paste the whole code, the verify link from an audit certificate, or a line of <code>shasum -a 256</code> output. <a href="#how-to-hash">How to fingerprint a file.</a></p>' +
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
      renderFound(data, hash);
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

// Auto-run when the URL carries ?h=<hash> (the verify link on a certificate).
(function bootFromURL() {
  const wanted = new URLSearchParams(location.search).get('h');
  if (!wanted) return;
  const hash = normalizeHash(wanted);
  if (input) input.value = hash;
  run(hash);
})();
