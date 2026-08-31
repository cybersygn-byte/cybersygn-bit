/**
 * /erase/ controller. Two states, driven by the URL:
 *
 *   no ?token   -> the request form. Asks for an email, sends a link.
 *   ?token=...  -> the confirm screen. Requires ONE more deliberate click
 *                  before anything is destroyed.
 *
 * The second click is not ceremony. Mail clients, security scanners, and link
 * previewers fetch URLs in emails automatically, and several issue GETs and a
 * few issue POSTs. If landing on this page erased an account, a corporate mail
 * scanner could wipe someone's contracts before they ever read the email. The
 * destructive call is therefore a POST that only a human click can trigger.
 */

const $ = (id) => document.getElementById(id);
const form = $('erase-form');
const status = $('erase-status');
const wrap = $('erase-form-wrap');

function setStatus(msg, kind) {
  if (!status) return;
  status.textContent = msg;
  status.dataset.kind = kind || '';
}

// ---- Step 1: request a link -------------------------------------------------

if (form) {
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const email = ($('erase-email').value || '').trim();
    const scope = (form.querySelector('input[name="scope"]:checked') || {}).value || 'account';
    if (!email) { setStatus('Enter the email address on your account.', 'warn'); return; }

    const btn = form.querySelector('button[type="submit"]');
    const label = btn.textContent;
    btn.disabled = true;
    btn.textContent = 'Sending.';
    try {
      const res = await fetch('/api/erase/request', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email, scope }),
      });
      const data = await res.json().catch(() => ({}));
      if (res.status === 429) {
        setStatus('Too many requests. Wait a few minutes and try again.', 'warn');
        return;
      }
      // The server answers identically whether or not the address has data,
      // so this page must not imply an account was found. Saying "if that
      // address has data with us" is the honest phrasing and it is also what
      // stops the form being used to test whether someone has an account.
      setStatus(data.message || 'If that address has data with us, a confirmation link is on its way.', 'ok');
      form.reset();
    } catch (err) {
      setStatus('Network error. Try again in a moment.', 'warn');
    } finally {
      btn.disabled = false;
      btn.textContent = label;
    }
  });
}

// ---- Step 2: confirm --------------------------------------------------------

const token = new URLSearchParams(location.search).get('token');
if (token && wrap) {
  wrap.innerHTML =
    '<div class="free-gate">' +
      '<h2 class="free-gate__title">Last chance to change your mind.</h2>' +
      '<p class="free-gate__lede">Clicking below permanently deletes your data. It cannot be undone, ' +
      'and we cannot recover it for you afterwards.</p>' +
      '<button class="btn btn--primary btn--block btn--lg" id="erase-confirm" type="button">Delete my data permanently</button>' +
      '<p class="free-gate__small" id="erase-confirm-status">Nothing has been deleted yet.</p>' +
    '</div>';

  const cbtn = $('erase-confirm');
  const cstatus = $('erase-confirm-status');
  cbtn.addEventListener('click', async () => {
    cbtn.disabled = true;
    cbtn.textContent = 'Deleting.';
    try {
      const res = await fetch('/api/erase/confirm', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ token }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.ok) {
        cstatus.textContent = data.error === 'invalid_or_expired'
          ? 'That link has expired or was already used. Request a new one below.'
          : 'Something went wrong. Nothing was deleted. Try requesting a new link.';
        cbtn.disabled = false;
        cbtn.textContent = 'Delete my data permanently';
        return;
      }
      // Report REAL numbers returned by the server, never a generic success.
      const docs = Number(data.documentsDeleted) || 0;
      const kept = Number(data.verifyRecordsKept) || 0;
      wrap.innerHTML =
        '<div class="free-gate">' +
          '<h2 class="free-gate__title">Done. It is gone.</h2>' +
          '<p class="free-gate__lede">' +
            'Deleted ' + docs + ' document' + (docs === 1 ? '' : 's') +
            (data.scope === 'account' ? ', along with your account data and settings.' : '.') +
          '</p>' +
          (kept > 0
            ? '<p class="free-gate__small">' + kept + ' anonymous completion fingerprint' +
              (kept === 1 ? '' : 's') + ' kept, so anyone holding a signed copy can still verify it. ' +
              'No name, email, or document text is in them.</p>'
            : '') +
          (data.complete === false
            ? '<p class="free-gate__small" data-kind="warn">' +
              String(data.incompleteReason || 'Some records could not be removed.') + '</p>'
            : '') +
          '<p class="free-gate__small">Receipt: <code>' + String(data.receiptId || '').replace(/[^a-f0-9]/g, '') + '</code>. ' +
          'Keep it if you ever need to show the request was honored.</p>' +
        '</div>';
    } catch (err) {
      cstatus.textContent = 'Network error. Nothing was deleted. Try again.';
      cbtn.disabled = false;
      cbtn.textContent = 'Delete my data permanently';
    }
  });
}
