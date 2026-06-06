/**
 * CyberSygn marketing page.
 *
 * Handles the founding-members signup form. POSTs to /api/signup if a
 * Worker is reachable; if not (static-only hosting, dev without the
 * Worker bound, network failure), the form degrades gracefully to a
 * mailto link so a serious prospect can still reach us.
 *
 * Analytics and error reporting hook through `window.cybersygn`.
 * No third-party calls.
 */

const cybersygn = (window.cybersygn = window.cybersygn || {});
cybersygn.track = cybersygn.track || function track(event, props) {
  if (window.__cybersygnDebug) console.info('[cybersygn:track]', event, props || {});
};
cybersygn.report = cybersygn.report || function report(err, context) {
  console.error('[cybersygn:error]', context || '', err);
};

// ---- Founding-members form -------------------------------------------------

const form = document.getElementById('founding-form');
// The status paragraph below the form button. Holds the default
// "Your email goes to the founder" caption until a submit replaces it.
// Pre-existing bug: this element used to be looked up as 'founding-result'
// but the HTML id is 'founding-status'. The mismatch silently broke
// every founding-form submission with TypeError on null.innerHTML.
const result = document.getElementById('founding-status');
const SIGNUP_ENDPOINT = '/api/signup';
const FALLBACK_EMAIL = 'hello@cybersygn.io';

if (form) {
  form.addEventListener('submit', async event => {
    event.preventDefault();
    const data = new FormData(form);
    const email = String(data.get('email') || '').trim();
    const context = String(data.get('context') || '').trim();

    if (!isValidEmail(email)) {
      showResult('That does not look like an email address. Try again?', 'error');
      return;
    }

    setSubmitting(true);
    cybersygn.track('founding_form_submitted', { hasContext: Boolean(context) });

    try {
      const res = await fetch(SIGNUP_ENDPOINT, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          email,
          context: context || null,
          source: 'marketing/founding',
        }),
      });
      if (!res.ok) throw new Error(`signup endpoint returned ${res.status}`);
      const payload = await res.json().catch(() => ({}));
      showResult(
        payload.message ||
          'You are on the list. We will email you when there is something worth saying.',
        'success',
      );
      form.reset();
      cybersygn.track('founding_form_succeeded');
    } catch (err) {
      cybersygn.report(err, 'founding_form');
      // Fallback: open a mailto link so we never silently lose the lead.
      const subject = encodeURIComponent('Origin member, CyberSygn');
      const body = encodeURIComponent(
        `Email: ${email}\n` +
        (context ? `Contracts: ${context}\n` : '') +
        '\nSent from the CyberSygn Origin-members form.',
      );
      showResult(
        'Our signup endpoint is not responding right now. Click the link below ' +
          'to send the same details by email instead.',
        'error',
        { href: `mailto:${FALLBACK_EMAIL}?subject=${subject}&body=${body}`, label: 'Email us directly.' },
      );
    } finally {
      setSubmitting(false);
    }
  });
}

function setSubmitting(isSubmitting) {
  const button = form.querySelector('button[type="submit"]');
  if (!button) return;
  button.disabled = isSubmitting;
  button.textContent = isSubmitting ? 'Reserving your spot.' : 'Reserve a founding spot.';
}

function showResult(message, kind, action) {
  if (!result) return; // defensive: never crash on a missing status element
  result.hidden = false;
  result.dataset.kind = kind;
  result.textContent = message;
  if (action) {
    const a = document.createElement('a');
    a.href = action.href;
    a.textContent = action.label;
    a.className = 'form__result-action';
    a.style.marginLeft = '8px';
    result.appendChild(a);
  }
}

function isValidEmail(s) {
  // Pragmatic: one @, at least one dot in the domain, no whitespace.
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s);
}

// ---- Pageview --------------------------------------------------------------

cybersygn.track('marketing_pageview', {
  path: location.pathname,
  referrer: document.referrer || null,
});

// Owner-mode bootstrap: validates any saved token and listens for the
// activation gesture. Runs after pageview tracking.
import('./preview/owner.js').then(mod => {
  mod.bootOwner('').then(() => mod.wirePillControls());
  mod.watchActivation('');
}).catch(err => cybersygn.report(err, 'owner-module-load'));
