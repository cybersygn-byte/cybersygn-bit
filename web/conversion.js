/**
 * Conversion-side enhancements that ride on top of the static homepage.
 *
 *   1. Billing-cycle toggle (Monthly / Annual).
 *      Updates each .tier's visible price number and unit, plus a small
 *      "$X annually" footnote. Drives a `?cycle=annual` query param
 *      onto the checkout buttons so the Worker maps to STRIPE_PRICE_*_ANNUAL.
 *
 *   2. Exit-intent modal.
 *      Detects when the user's mouse leaves the top of the viewport
 *      (a strong signal they're switching tab/closing). Fires once per
 *      session. Captures email straight into the existing /api/free/signup
 *      flow with a "Send me three free signs" CTA. localStorage flag
 *      suppresses re-fire across reloads.
 *
 * Both opt out of `prefers-reduced-motion` gracefully — the toggle
 * works without animation; exit-intent skips its slide-in.
 */
(function () {
  if (typeof window === 'undefined') return;

  // ─────────────────────────────────────────────────────────
  // Billing-cycle toggle
  // ─────────────────────────────────────────────────────────
  const toggle = document.querySelector('.billing-toggle');
  if (toggle) {
    const opts = toggle.querySelectorAll('.billing-toggle__opt');
    function applyCycle(cycle) {
      toggle.dataset.cycle = cycle;
      opts.forEach(o => {
        const on = o.dataset.cycle === cycle;
        o.classList.toggle('is-active', on);
        o.setAttribute('aria-checked', on ? 'true' : 'false');
      });
      // Update each tier card.
      document.querySelectorAll('.tier[data-monthly]').forEach(tier => {
        const monthly = tier.dataset.monthly;
        const annual = tier.dataset.annual;
        const annualTotal = tier.dataset.annualTotal;
        const num = tier.querySelector('.tier__price-num');
        const unit = tier.querySelector('.tier__price-unit');
        let foot = tier.querySelector('.tier__price-foot');
        if (!num || !unit) return;
        if (cycle === 'annual') {
          num.textContent = '$' + annual;
          unit.textContent = '/mo billed yearly';
          if (!foot) {
            foot = document.createElement('span');
            foot.className = 'tier__price-foot';
            unit.parentElement.appendChild(foot);
          }
          foot.textContent = '$' + annualTotal + ' / year · save 20%';
        } else {
          num.textContent = '$' + monthly;
          unit.textContent = (tier.dataset.tier === 'origin') ? '/mo forever' : '/mo';
          if (foot) foot.remove();
        }
      });
      // Drive checkout buttons.
      document.querySelectorAll('[data-checkout-tier]').forEach(btn => {
        btn.dataset.checkoutCycle = cycle;
      });
      try { sessionStorage.setItem('cybersygn.billingCycle', cycle); } catch (e) {}
    }
    opts.forEach(o => o.addEventListener('click', () => applyCycle(o.dataset.cycle)));
    // Restore prior choice within the session.
    let prior = 'monthly';
    try { prior = sessionStorage.getItem('cybersygn.billingCycle') || 'monthly'; } catch (e) {}
    if (prior === 'annual') applyCycle('annual');
  }

  // ─────────────────────────────────────────────────────────
  // Exit-intent modal
  // ─────────────────────────────────────────────────────────
  const EI_SEEN_KEY = 'cybersygn.exitIntentSeen.v1';
  let seenRecently = false;
  try { seenRecently = !!localStorage.getItem(EI_SEEN_KEY); } catch (e) {}

  // Skip exit-intent on touch devices (no mouseleave at top), on /preview/
  // (already engaged), and on pages that don't include a CTA worth showing.
  const isTouch = ('ontouchstart' in window) || (navigator.maxTouchPoints > 0);
  const path = (location.pathname || '/').toLowerCase();
  const skipPaths = ['/preview/', '/control/', '/dashboard/', '/origin/', '/charter/'];
  const blocked = skipPaths.some(p => path.startsWith(p));
  if (seenRecently || isTouch || blocked) return;

  // Modal element. Built lazily on first trigger.
  let modal = null;
  function buildModal() {
    modal = document.createElement('div');
    modal.className = 'exit-intent';
    modal.setAttribute('role', 'dialog');
    modal.setAttribute('aria-modal', 'true');
    modal.setAttribute('aria-labelledby', 'exit-intent-title');
    modal.innerHTML = (
      '<div class="exit-intent__backdrop" data-close></div>' +
      '<div class="exit-intent__card">' +
        '<button type="button" class="exit-intent__close" aria-label="Close" data-close>×</button>' +
        '<p class="kicker">Before you go.</p>' +
        '<h2 id="exit-intent-title" class="h-card exit-intent__title">Three signed documents. On the house.</h2>' +
        '<p class="exit-intent__lede">No credit card. No app to install. See the field-detection in 30 seconds. ' +
        'Your three free signs never expire.</p>' +
        '<form class="exit-intent__form" autocomplete="on">' +
          '<div class="exit-intent__row">' +
            '<input class="exit-intent__input" type="email" name="email" placeholder="your@email.com" autocomplete="email" required />' +
            '<button class="btn btn--primary" type="submit">' +
              'Send me three free signs' +
              '<span class="btn-arrow" aria-hidden="true">→</span>' +
            '</button>' +
          '</div>' +
          '<p class="exit-intent__small">Goes to the founder, nowhere else. Replies within a day.</p>' +
        '</form>' +
      '</div>'
    );
    document.body.appendChild(modal);

    // Close handlers.
    modal.addEventListener('click', e => {
      if (e.target && e.target.dataset && 'close' in e.target.dataset) closeModal();
    });
    document.addEventListener('keydown', escClose);

    // Submit handler — splits the email into first/last placeholder and
    // calls /api/free/signup. On success, redirect to /preview/.
    const form = modal.querySelector('form');
    form.addEventListener('submit', async e => {
      e.preventDefault();
      const input = form.querySelector('input[type=email]');
      const email = input.value.trim();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        input.focus();
        return;
      }
      const btn = form.querySelector('button[type=submit]');
      const orig = btn.innerHTML;
      btn.disabled = true;
      btn.innerHTML = 'Sending.';
      try {
        const res = await fetch('/api/free/signup', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            firstName: 'Friend',
            lastName: 'CyberSygn',
            email,
          }),
        });
        const data = await res.json().catch(() => ({}));
        if (data && data.ok && data.freeToken) {
          try { localStorage.setItem('cybersygn.freeToken', data.freeToken); } catch (e) {}
          location.href = '/preview/?welcome=1';
          return;
        }
        btn.disabled = false;
        btn.innerHTML = 'Try again';
      } catch (err) {
        btn.disabled = false;
        btn.innerHTML = orig;
      }
    });
  }
  function escClose(e) { if (e.key === 'Escape') closeModal(); }
  function closeModal() {
    if (!modal) return;
    try { localStorage.setItem(EI_SEEN_KEY, String(Date.now())); } catch (e) {}
    document.removeEventListener('keydown', escClose);
    modal.classList.add('is-closing');
    setTimeout(() => { if (modal && modal.parentNode) modal.parentNode.removeChild(modal); modal = null; }, 280);
  }

  function trigger() {
    if (modal) return;
    if (seenRecently) return;
    seenRecently = true;
    buildModal();
    requestAnimationFrame(() => modal && modal.classList.add('is-open'));
    if (typeof window.cybersygn !== 'undefined' && window.cybersygn.track) {
      try { window.cybersygn.track('exit_intent_shown'); } catch (e) {}
    }
  }

  // Fire when cursor leaves the top edge of the viewport AND the user
  // has been on the page > 3 seconds (so it's not pre-pageload jitter).
  const landedAt = Date.now();
  document.addEventListener('mouseout', e => {
    if (!e.relatedTarget && (e.clientY || 0) <= 5 && (Date.now() - landedAt) > 3000) {
      trigger();
    }
  });
})();
