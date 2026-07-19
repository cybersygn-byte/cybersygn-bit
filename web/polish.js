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
    '.scanshow',
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

  // Cursor-reactive card motion: a subtle tilt toward the pointer plus a
  // directional accent glow. Additive and inline-only: the transform and
  // box-shadow are set while the pointer is over the card and CLEARED on leave,
  // so the card always rests at its natural CSS state (never gates visibility).
  // Desktop fine-pointers only; unreachable under reduced motion because that
  // path already returned above.
  function wireCardMotion() {
    const fine = window.matchMedia && window.matchMedia('(pointer: fine)').matches;
    if (!fine) return;
    const SEL = [
      '.tier', '.alt-card', '.doc-card', '.origin-card',
      '.founder-card', '.founder-home__card', '.trust-tile',
      '.tmpl-card', '.blog-card',
    ].join(',');
    const MAX_TILT = 3.2;  // degrees, kept small so text stays crisp
    const LIFT = 6;        // px, matches the featured tier's resting lift

    document.querySelectorAll(SEL).forEach((card) => {
      let raf = 0;
      card.addEventListener('pointerenter', () => {
        card.style.transition = 'transform 120ms linear, box-shadow 200ms var(--ease, ease)';
      });
      card.addEventListener('pointermove', (e) => {
        const r = card.getBoundingClientRect();
        if (!r.width || !r.height) return;
        const px = (e.clientX - r.left) / r.width - 0.5;   // -0.5 .. 0.5
        const py = (e.clientY - r.top) / r.height - 0.5;
        cancelAnimationFrame(raf);
        raf = requestAnimationFrame(() => {
          const rotY = (px * 2 * MAX_TILT).toFixed(2);
          const rotX = (-py * 2 * MAX_TILT).toFixed(2);
          card.style.transform =
            `perspective(1000px) rotateX(${rotX}deg) rotateY(${rotY}deg) translateY(-${LIFT}px)`;
          const ox = Math.round(px * 24);
          const oy = Math.round(16 + py * 8);
          card.style.boxShadow =
            `${ox}px ${oy}px 48px -22px var(--accent-glow), 0 0 0 1px var(--accent-line)`;
        });
      });
      card.addEventListener('pointerleave', () => {
        cancelAnimationFrame(raf);
        card.style.transition = 'transform 340ms var(--ease, ease), box-shadow 340ms var(--ease, ease)';
        card.style.transform = '';
        card.style.boxShadow = '';
      });
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => { paintTargets(); wireCardMotion(); });
  } else {
    paintTargets();
    wireCardMotion();
  }
})();
