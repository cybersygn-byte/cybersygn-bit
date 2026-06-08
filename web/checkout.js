/**
 * Checkout button handler.
 *
 * Wires every `[data-checkout-tier]` element on the page to POST to
 * /api/checkout/create-session and redirect to Stripe's hosted checkout.
 *
 * Owner-mode requests skip Stripe entirely and land on the dashboard
 * with a synthetic `?checkout=owner` so demos look like a paid account
 * without burning real card data.
 *
 * The sender's localStorage id is included so the eventual webhook can
 * match the subscription to the right dashboard view.
 */

import { getSenderId } from './preview/identity.js';

const ENDPOINT = '/api/checkout/create-session';
const OWNER_HEADER = 'X-CyberSygn-Owner';
const OWNER_STORAGE_KEY = 'cybersygn.owner.token';

function readOwnerToken() {
  try { return localStorage.getItem(OWNER_STORAGE_KEY) || null; } catch { return null; }
}

async function startCheckout(button) {
  const baseTier = button.dataset.checkoutTier;
  if (!baseTier) return;
  // Honor the monthly/annual billing toggle. conversion.js sets
  // data-checkout-cycle="annual" on the tier buttons when Annual is active; map
  // to the tier's annual price id so the buyer is charged the ADVERTISED annual
  // rate. The *_annual tiers resolve to STRIPE_PRICE_*_ANNUAL server-side and are
  // accepted by TIERS in the worker. Lifetime/free have no annual variant.
  const ANNUAL = { solo: 'solo_annual', founding: 'founding_annual', team: 'team_annual' };
  const tier = (button.dataset.checkoutCycle === 'annual' && ANNUAL[baseTier]) ? ANNUAL[baseTier] : baseTier;
  const originalLabel = button.textContent;
  const senderId = getSenderId();
  const ownerToken = readOwnerToken();

  button.disabled = true;
  button.dataset.busy = 'true';
  button.textContent = 'Opening checkout.';

  const headers = { 'content-type': 'application/json' };
  if (ownerToken) headers[OWNER_HEADER] = ownerToken;

  // Affiliate attribution: capture ref from URL or cookie, forward to
  // /api/checkout/create-session so the subscription metadata carries it.
  let ref = null;
  try {
    const urlRef = new URLSearchParams(window.location.search).get('ref');
    if (urlRef && /^[a-z0-9]{4,16}$/.test(urlRef.toLowerCase())) ref = urlRef.toLowerCase();
    if (!ref) {
      const m = document.cookie.match(/(?:^|;\s*)cybersygn_ref=([a-z0-9]{4,16})/);
      if (m) ref = m[1].toLowerCase();
    }
  } catch (e) {}

  try {
    const res = await fetch(ENDPOINT, {
      method: 'POST',
      headers,
      body: JSON.stringify({ tier, senderId, ref }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.url) {
      const message = data && data.message
        ? data.message
        : 'Checkout is not available right now. Please try again.';
      announce(button, message, 'error');
      button.disabled = false;
      delete button.dataset.busy;
      button.textContent = originalLabel;
      return;
    }
    if (data.owner) {
      announce(button, 'Owner mode. Redirecting.', 'success');
    }
    window.location.assign(data.url);
  } catch (err) {
    announce(button, 'Network failure. Try again.', 'error');
    button.disabled = false;
    delete button.dataset.busy;
    button.textContent = originalLabel;
  }
}

function announce(button, message, kind) {
  let region = button.parentElement && button.parentElement.querySelector('.checkout-status');
  if (!region) {
    region = document.createElement('p');
    region.className = 'checkout-status caption';
    region.style.marginTop = '0.5rem';
    region.style.textAlign = 'center';
    region.setAttribute('role', 'status');
    if (button.parentElement) button.parentElement.appendChild(region);
  }
  region.dataset.kind = kind;
  region.textContent = message;
  region.style.color = kind === 'error' ? 'var(--err, #c0322f)' : 'var(--muted, inherit)';
}

export function initCheckoutButtons(scope = document) {
  scope.querySelectorAll('[data-checkout-tier]').forEach(el => {
    if (el.dataset.checkoutBound === '1') return;
    el.dataset.checkoutBound = '1';
    el.addEventListener('click', e => {
      e.preventDefault();
      startCheckout(el);
    });
  });
}

// Auto-init on import.
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => initCheckoutButtons());
} else {
  initCheckoutButtons();
}
