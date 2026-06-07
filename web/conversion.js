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
          const monthlyTotal = Number(monthly) * 12;
          const savedDollars = monthlyTotal - Number(annualTotal);
          foot.textContent = '$' + annualTotal + ' / year · save $' + savedDollars;
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
  // "Your DocuSign tax" calculator
  // ─────────────────────────────────────────────────────────
  const calcDocs = document.getElementById('calc-docs');
  const calcRate = document.getElementById('calc-rate');
  const calcMin = document.getElementById('calc-min');
  const calcHours = document.getElementById('calc-hours');
  const calcDollars = document.getElementById('calc-dollars');
  const calcPayback = document.getElementById('calc-payback');
  if (calcDocs && calcRate && calcMin) {
    function runCalc() {
      const docs = Math.max(0, Number(calcDocs.value) || 0);
      const rate = Math.max(0, Number(calcRate.value) || 0);
      const min = Math.max(1, Number(calcMin.value) || 1);
      const hours = (docs * min) / 60;
      const dollars = hours * rate;
      const originCost = 9;
      // How many DAYS until the $9 Origin subscription pays for itself
      // at the user's hourly time savings? dollars/month → dollars/day → days till $9.
      const dailyTimeSaved = dollars / 30;
      const paybackDays = dailyTimeSaved > 0 ? Math.max(0.1, originCost / dailyTimeSaved) : Infinity;
      if (calcHours) calcHours.textContent = hours.toFixed(1) + ' h';
      if (calcDollars) calcDollars.textContent = '$' + Math.round(dollars).toLocaleString();
      if (calcPayback) {
        if (!isFinite(paybackDays)) {
          calcPayback.textContent = '—';
        } else if (paybackDays < 1) {
          const hoursPay = Math.max(0.1, paybackDays * 24);
          calcPayback.textContent = hoursPay.toFixed(1) + ' hours';
        } else if (paybackDays < 30) {
          calcPayback.textContent = paybackDays.toFixed(1) + ' days';
        } else {
          calcPayback.textContent = (paybackDays / 30).toFixed(1) + ' months';
        }
      }
    }
    [calcDocs, calcRate, calcMin].forEach(el => el.addEventListener('input', runCalc));
    runCalc();
  }

  // ─────────────────────────────────────────────────────────
  // "Ask the founder" floating widget
  // ─────────────────────────────────────────────────────────
  function buildFounderWidget() {
    if (document.getElementById('cs-founder-widget')) return;
    const root = document.createElement('div');
    root.id = 'cs-founder-widget';
    root.className = 'founder-widget';
    root.innerHTML = (
      '<button class="founder-widget__btn" type="button" aria-expanded="false" aria-label="Ask Nathan a question">' +
        '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
          '<path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"/>' +
        '</svg>' +
      '</button>' +
      '<div class="founder-widget__panel" role="dialog" aria-label="Ask Nathan" hidden>' +
        '<button class="founder-widget__close" type="button" aria-label="Close">×</button>' +
        '<p class="kicker">Ask the founder.</p>' +
        '<p class="founder-widget__lede">Replies within a day, usually within hours. No bots, no queue — it lands in my inbox.</p>' +
        '<form class="founder-widget__form" autocomplete="on">' +
          '<input class="founder-widget__email" name="email" type="email" placeholder="your@email.com" autocomplete="email" required />' +
          '<textarea class="founder-widget__msg" name="message" placeholder="What\'s on your mind?" rows="3" required></textarea>' +
          '<button class="btn btn--primary btn--block" type="submit">Send to Nathan</button>' +
          '<p class="founder-widget__small">Goes straight to nathan@cybersygn.io. No CRM, no autoresponder.</p>' +
        '</form>' +
        '<p class="founder-widget__done" hidden>Sent. I\'ll reply within a day.</p>' +
      '</div>'
    );
    document.body.appendChild(root);

    const btn = root.querySelector('.founder-widget__btn');
    const panel = root.querySelector('.founder-widget__panel');
    const close = root.querySelector('.founder-widget__close');
    const form = root.querySelector('.founder-widget__form');
    const done = root.querySelector('.founder-widget__done');
    btn.addEventListener('click', () => {
      const isOpen = !panel.hidden;
      panel.hidden = isOpen;
      btn.setAttribute('aria-expanded', isOpen ? 'false' : 'true');
      if (!isOpen) {
        const em = panel.querySelector('input[name=email]');
        if (em) setTimeout(() => em.focus(), 30);
      }
    });
    close.addEventListener('click', () => {
      panel.hidden = true;
      btn.setAttribute('aria-expanded', 'false');
    });
    form.addEventListener('submit', async e => {
      e.preventDefault();
      const data = new FormData(form);
      const email = String(data.get('email') || '').trim();
      const message = String(data.get('message') || '').trim();
      if (!email || !message) return;
      const submitBtn = form.querySelector('button[type=submit]');
      submitBtn.disabled = true;
      submitBtn.textContent = 'Sending…';
      try {
        const res = await fetch('/api/contact', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email, message, source: 'founder-widget', path: location.pathname }),
        });
        if (res.ok) {
          form.hidden = true;
          done.hidden = false;
        } else {
          submitBtn.disabled = false;
          submitBtn.textContent = 'Try again';
        }
      } catch (err) {
        submitBtn.disabled = false;
        submitBtn.textContent = 'Try again';
      }
    });
  }
  // Don't show the widget on /preview/ (already engaged), /control/, /dashboard/.
  const widgetSkip = ['/preview/', '/control/', '/dashboard/'];
  if (!widgetSkip.some(p => (location.pathname || '/').startsWith(p))) {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', buildFounderWidget);
    } else {
      buildFounderWidget();
    }
  }

  // ─────────────────────────────────────────────────────────
  // Origin proof — latest founders on homepage
  // ─────────────────────────────────────────────────────────
  const proofList = document.getElementById('origin-proof-list');
  const proofClaimed = document.getElementById('origin-proof-claimed');
  const proofCap = document.getElementById('origin-proof-cap');
  if (proofList) {
    fetch('/api/origin/wall?limit=6').then(r => r.ok ? r.json() : null).then(d => {
      if (!d) return;
      if (proofCap && d.cap) proofCap.textContent = String(d.cap);
      if (proofClaimed && typeof d.claimed === 'number') proofClaimed.textContent = String(d.claimed);
      if (Array.isArray(d.members) && d.members.length > 0) {
        proofList.innerHTML = d.members.map((m, i) => (
          '<li class="origin-proof__item">' +
            '<span class="origin-proof__num">#' + (m.number || (i + 1)) + '</span>' +
            '<p class="origin-proof__name">' + escapeHtml(m.displayName || 'A founder') + '</p>' +
            '<p class="origin-proof__city">' + escapeHtml(m.city || 'Somewhere on Earth') + '</p>' +
          '</li>'
        )).join('');
      }
    }).catch(() => {});
  }
  function escapeHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
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
              'Send Me the Freebies' +
              '<span class="btn-arrow" aria-hidden="true">→</span>' +
            '</button>' +
          '</div>' +
          '<p class="exit-intent__small">Goes to CyberSygn, nowhere else.</p>' +
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

  // ─────────────────────────────────────────────────────────────
  // 3. Free-template tile randomizer.
  //    Renders 8 randomly-selected tiles per page load into the
  //    #template-tile-grid container on the homepage. The pool
  //    is hand-curated so every shuffle surfaces a coherent mix.
  //    Each tile links to /templates/?cat=<slug> so the library
  //    can filter to the category the user clicked.
  // ─────────────────────────────────────────────────────────────
  const TEMPLATE_TILES = [
    { type: 'msa',          name: 'Master Services Agreement',  sub: 'Vendor contracts, retainer agreements, consulting MSAs.', layout: 'sig' },
    { type: 'nda',          name: 'Non-Disclosure Agreement',   sub: 'Mutual NDAs, one-way confidentiality, due-diligence wrappers.', layout: 'sig-init' },
    { type: 'employment',   name: 'Employment Agreement',       sub: 'W-2 offer letters, 1099 contractor agreements, advisor terms.', layout: 'sig-date' },
    { type: 'lease',        name: 'Rental Lease',               sub: 'Residential leases, commercial subleases, room rentals.', layout: 'sig-init' },
    { type: 'photography',  name: 'Photography Contract',       sub: 'Shoot agreements, model releases, image licensing.', layout: 'sig-date' },
    { type: 'coaching',     name: 'Coaching Agreement',         sub: 'Engagement terms, intake forms, cancellation policies.', layout: 'sig' },
    { type: 'freelance',    name: 'Freelance Contract',         sub: 'Project SOWs, milestone payments, IP transfer clauses.', layout: 'sig-date' },
    { type: 'safe',         name: 'SAFE / Investor Agreement',  sub: 'YC SAFE templates, convertible notes, advisor agreements.', layout: 'sig' },
    { type: 'consulting',   name: 'Consulting Agreement',       sub: 'Independent consultant engagements, scope, IP, term.', layout: 'sig-date' },
    { type: 'contractor',   name: 'Independent Contractor',     sub: '1099 contractor work-for-hire, IP assignment, fee schedule.', layout: 'sig-date' },
    { type: 'advisor',      name: 'Advisor Agreement',          sub: 'FAST-style agreement, equity grant, vesting, IP.', layout: 'sig' },
    { type: 'vendor',       name: 'Vendor Agreement',           sub: 'Standard vendor terms, payment, performance, exit.', layout: 'sig-init' },
    { type: 'speaker',      name: 'Speaker Agreement',          sub: 'Event speaker terms, fee, recording rights, cancellation.', layout: 'sig-date' },
    { type: 'sponsorship',  name: 'Sponsorship Agreement',      sub: 'Brand partnership tiers, deliverables, exclusivity.', layout: 'sig' },
    { type: 'safe-note',    name: 'Convertible Note',           sub: 'Promissory note that converts at next priced round.', layout: 'sig' },
    { type: 'promissory',   name: 'Promissory Note',            sub: 'Borrower, lender, principal, interest, repayment terms.', layout: 'sig-date' },
    { type: 'bill-of-sale', name: 'Bill of Sale',               sub: 'Asset transfer, vehicle title, equipment sale.', layout: 'sig-date' },
    { type: 'poa',          name: 'Power of Attorney',          sub: 'General, durable, healthcare, financial POA forms.', layout: 'sig-init' },
    { type: 'will',         name: 'Last Will and Testament',    sub: 'State-specific will templates and witness blocks.', layout: 'sig' },
    { type: 'advance-dir',  name: 'Advance Healthcare Directive',sub: 'Living will, healthcare proxy, end-of-life wishes.', layout: 'sig' },
    { type: 'llc',          name: 'LLC Operating Agreement',    sub: 'Multi-member or single-member LLC operating terms.', layout: 'sig-init' },
    { type: 'partnership',  name: 'Partnership Agreement',      sub: 'Partners, contributions, profit split, dissolution.', layout: 'sig-init' },
    { type: 'licensing',    name: 'Licensing Agreement',        sub: 'IP license, scope, royalties, quality control, term.', layout: 'sig' },
    { type: 'model-release',name: 'Model Release',              sub: 'Image-rights grant for commercial and editorial use.', layout: 'sig-date' },
    { type: 'mutual-nda',   name: 'Mutual NDA',                 sub: 'Bilateral confidentiality between two business parties.', layout: 'sig' },
    { type: 'sow',          name: 'Statement of Work',          sub: 'Scoped project under an MSA — deliverables, dates, fee.', layout: 'sig-date' },
    { type: 'mou',          name: 'Memorandum of Understanding',sub: 'Non-binding pre-contract alignment between parties.', layout: 'sig' },
    { type: 'subscription', name: 'Subscription Agreement',     sub: 'SaaS subscription terms, billing, data, termination.', layout: 'sig' },
  ];

  function shuffle(arr) {
    const a = arr.slice();
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  }

  function lineHTML() {
    const widths = ['80', '60', '90', '70'];
    return widths.map(w => '<span class="pdf-tile__line pdf-tile__line--' + w + '"></span>').join('');
  }

  function tileHTML(t) {
    const accents =
      t.layout === 'sig-init'  ? '<span class="pdf-tile__sig"></span><span class="pdf-tile__init"></span>' :
      t.layout === 'sig-date'  ? '<span class="pdf-tile__sig"></span><span class="pdf-tile__date"></span>' :
      /* sig */                  '<span class="pdf-tile__sig"></span>';
    return (
      '<a class="pdf-tile" href="./templates/?cat=' + t.type + '" data-type="' + t.type + '">' +
        '<div class="pdf-tile__paper" aria-hidden="true">' +
          lineHTML() + accents +
        '</div>' +
        '<p class="pdf-tile__name">' + t.name + '</p>' +
        '<p class="pdf-tile__sub">' + t.sub + '</p>' +
      '</a>'
    );
  }

  function renderTiles() {
    const grid = document.getElementById('template-tile-grid');
    if (!grid) return;
    const picks = shuffle(TEMPLATE_TILES).slice(0, 8);
    grid.innerHTML = picks.map(tileHTML).join('');
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', renderTiles, { once: true });
  } else {
    renderTiles();
  }
})();
