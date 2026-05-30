/**
 * Customer-facing visual polish driver. Two responsibilities:
 *
 *   1. Scroll-driven entrance animations. Watches a curated list of
 *      sections, cards, and headings. When each enters the viewport,
 *      attaches data-reveal="visible" so the CSS keyframe runs once.
 *      Single IntersectionObserver shared across all targets to keep
 *      memory low and the main thread idle.
 *
 *   2. Section gradient activation. The hero, section--alt, and
 *      .dropzone-wrap each receive a subtle navy/cyan/paper gradient
 *      via CSS; this script's only job there is to mark .body[data-polish="on"]
 *      once we've decided the user wants animation. With reduced-motion
 *      preferred, polish degrades to static (gradients still apply,
 *      but no scroll reveals; everything is visible immediately).
 *
 * No layout changes. No logic changes. Polish only.
 */

(function polishDriver() {
  if (typeof window === 'undefined') return;
  if (typeof document === 'undefined') return;

  const reduced = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  // Mark the body so the CSS layer below the keyframes activates.
  document.documentElement.dataset.polish = 'on';
  if (reduced) {
    // Make every target visible at once; skip the observer entirely.
    document.querySelectorAll('[data-reveal]').forEach(el => {
      el.setAttribute('data-reveal', 'visible');
    });
    return;
  }

  // Targets: most sections, cards, headings, pricing tiles, FAQ items,
  // and similar containers. The data-reveal attribute is added below
  // when the DOM is ready, so we don't have to touch every HTML file
  // to mark elements individually.
  const SELECTOR = [
    '.hero__title',
    '.hero__lede',
    '.hero__actions',
    '.hero__note',
    '.demo-doc',
    '.section__head',
    '.section__lede',
    '.steps .step',
    '.tier',
    '.compare-table-wrap',
    '.faq__item',
    '.founding',
    '.colophon',
    '.dash-stats__card',
    '.dash-welcome',
    '.dash-util__item',
    '.dash-step',
    '.alt-card',
    '.doc-card',
    '.dropzone-card',
    '.sidebar__head',
    '.field-list__group',
    '.field-list__collapsible',
  ].join(',');

  function paintTargets() {
    const all = document.querySelectorAll(SELECTOR);
    all.forEach((el, i) => {
      // Stagger via index: every 4th element shares a delay step so
      // a long list (FAQ items, comparison rows) doesn't cascade for
      // 5 seconds. Each step is 60ms.
      el.setAttribute('data-reveal', 'hidden');
      el.style.setProperty('--polish-delay', `${(i % 4) * 60}ms`);
    });

    const io = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            entry.target.setAttribute('data-reveal', 'visible');
            io.unobserve(entry.target);
          }
        }
      },
      {
        rootMargin: '0px 0px -8% 0px',  // start 8% before exiting the viewport
        threshold: 0.08,                  // 8% of element visible
      },
    );

    all.forEach(el => io.observe(el));
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', paintTargets);
  } else {
    paintTargets();
  }
})();
