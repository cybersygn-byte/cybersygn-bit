/**
 * Client-side owner mode.
 *
 * On page load, checks localStorage for a saved owner token and validates
 * it against the Worker. If valid, sets a global flag and shows the
 * owner pill in the masthead.
 *
 * Activation is silent: if the user types a special phrase into any
 * email input on the page (including the marketing founding-member form),
 * we POST it to /api/owner/claim and stash the returned token. Same
 * applies to a ?owner=<phrase> URL parameter on any page.
 *
 * The client stores the token in localStorage under `cybersygn.owner.token`
 * and includes it in `X-CyberSygn-Owner` headers on every authenticated
 * request.
 */

const STORAGE_KEY = 'cybersygn.owner.token';
const HEADER_NAME = 'X-CyberSygn-Owner';

let _ownerToken = null;
let _ownerRecord = null;

function readToken() {
  try {
    return localStorage.getItem(STORAGE_KEY) || null;
  } catch (e) {
    return null;
  }
}

function writeToken(token) {
  try {
    if (token) {
      localStorage.setItem(STORAGE_KEY, token);
    } else {
      localStorage.removeItem(STORAGE_KEY);
    }
  } catch (e) {}
}

export function ownerToken() {
  return _ownerToken;
}

export function isOwner() {
  return !!_ownerToken;
}

/**
 * Augment a fetch headers object with the owner token if one is active.
 * Use this in every API call where ownership should be honored.
 */
export function withOwnerHeader(headers = {}) {
  const out = { ...headers };
  if (_ownerToken) out[HEADER_NAME] = _ownerToken;
  return out;
}

/**
 * Attempt to claim owner status with a candidate phrase. Returns true on
 * success, false otherwise. On success, the token is persisted and the
 * owner pill becomes visible.
 */
export async function claimOwner(phrase, apiBase = '') {
  if (typeof phrase !== 'string' || phrase.length === 0) return false;
  try {
    const res = await fetch(`${apiBase}/api/owner/claim`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ phrase }),
    });
    if (!res.ok) return false;
    const data = await res.json();
    if (data && data.ok && data.token) {
      _ownerToken = data.token;
      _ownerRecord = data;
      writeToken(data.token);
      renderPill();
      return true;
    }
  } catch (err) {
    // network failure or worker missing in offline preview: silently fail
  }
  return false;
}

/**
 * Drop owner status locally. The token remains valid in the Worker's KV
 * for 365 days; this only removes it from this browser.
 */
export function clearOwner() {
  _ownerToken = null;
  _ownerRecord = null;
  writeToken(null);
  renderPill();
}

/**
 * On boot: read any persisted token and verify it against the Worker.
 * If valid, set state and show the pill. If invalid (server says no),
 * clear the local token. If the Worker is unreachable (no API host in
 * static-only mode), keep the token locally so the owner can use the
 * UI without server validation.
 */
export async function bootOwner(apiBase = '') {
  const saved = readToken();
  if (!saved) return false;
  _ownerToken = saved;  // optimistic
  renderPill();
  try {
    const res = await fetch(`${apiBase}/api/owner/verify`, {
      headers: { [HEADER_NAME]: saved },
    });
    if (res.ok) {
      const data = await res.json();
      if (data && data.ok && data.owner) {
        _ownerRecord = data.owner;
        renderPill();
        return true;
      } else {
        clearOwner();
        return false;
      }
    } else if (res.status === 401) {
      // Token rejected by server: clear it.
      clearOwner();
      return false;
    }
    // Other statuses: leave optimistic state in place.
    return true;
  } catch (err) {
    // Worker unreachable (likely static-only deployment). Keep the local
    // token; it will start working once the Worker is up.
    return true;
  }
}

/**
 * Watch URL params and any email input on the page for the activation
 * phrase. If found, claim owner status.
 */
export async function watchActivation(apiBase = '') {
  // URL param
  try {
    const params = new URLSearchParams(window.location.search);
    const fromUrl = params.get('owner');
    if (fromUrl) {
      // Strip from URL bar so it isn't accidentally bookmarked.
      params.delete('owner');
      const cleanUrl = window.location.pathname + (params.toString() ? `?${params}` : '') + window.location.hash;
      history.replaceState(null, '', cleanUrl);
      // 64-char hex looks like a token; everything else is treated as a phrase.
      if (/^[a-f0-9]{64}$/.test(fromUrl)) {
        // Token activation: just store it and verify.
        _ownerToken = fromUrl;
        writeToken(fromUrl);
        await bootOwner(apiBase);
      } else {
        await claimOwner(fromUrl, apiBase);
      }
    }
  } catch (e) {}

  // Email input gesture: if any email input contains a string starting
  // with "owner:" followed by the phrase, intercept the form submit and
  // claim instead of submitting.
  document.querySelectorAll('input[type="email"]').forEach(input => {
    input.addEventListener('blur', async () => {
      const val = (input.value || '').trim();
      if (val.startsWith('owner:') && val.length > 6) {
        const phrase = val.slice(6);
        const ok = await claimOwner(phrase, apiBase);
        if (ok) {
          input.value = '';
          input.blur();
          // Quiet UI signal: pulse the input border. The pill in the
          // masthead is the durable indicator.
          input.style.transition = 'box-shadow 220ms ease';
          input.style.boxShadow = '0 0 0 3px var(--accent-soft)';
          setTimeout(() => { input.style.boxShadow = ''; }, 600);
        }
      }
    });
  });
}

/**
 * Find the owner-pill element in the page and reflect current state.
 * Pages that don't have the pill just no-op.
 */
function renderPill() {
  const pill = document.getElementById('owner-pill');
  if (!pill) return;
  pill.dataset.active = _ownerToken ? 'true' : 'false';
}

/**
 * Wire the pill's close button (if present) to drop owner mode.
 * Call this once at boot time.
 */
export function wirePillControls() {
  const close = document.querySelector('#owner-pill .owner-pill__close');
  if (close) {
    close.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      clearOwner();
    });
  }
}
