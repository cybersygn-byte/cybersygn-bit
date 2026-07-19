/**
 * Tactile interaction layer. Additive feel only, no layout or logic changes.
 *
 * Magnetic primary CTAs: while the cursor is over a primary/large button it
 * leans subtly toward the pointer and springs back on leave, so the most
 * important actions feel physical and alive.
 *
 * Guardrails: desktop pointers only (pointer: fine), fully disabled under
 * prefers-reduced-motion, and the button always rests at its natural position
 * (transform is cleared on leave), so visibility never depends on this script.
 */
(function motionLayer() {
  if (typeof window === 'undefined' || typeof document === 'undefined') return;
  const fine = window.matchMedia && window.matchMedia('(pointer: fine)').matches;
  const reduced = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (!fine || reduced) return;

  const STRENGTH = 0.26;   // fraction of the cursor offset the button follows
  const MAX = 7;           // px cap so the button never drifts off its label

  function magnetize(btn) {
    let raf = 0;
    function onMove(e) {
      const r = btn.getBoundingClientRect();
      const dx = e.clientX - (r.left + r.width / 2);
      const dy = e.clientY - (r.top + r.height / 2);
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        const tx = Math.max(-MAX, Math.min(MAX, dx * STRENGTH));
        const ty = Math.max(-MAX, Math.min(MAX, dy * STRENGTH));
        btn.style.transform = `translate(${tx}px, ${ty}px)`;
      });
    }
    function reset() { cancelAnimationFrame(raf); btn.style.transform = ''; }
    btn.addEventListener('pointermove', onMove);
    btn.addEventListener('pointerleave', reset);
    btn.addEventListener('blur', reset);
  }

  function init() {
    document.querySelectorAll('.btn--primary, .btn--lg').forEach(b => {
      b.classList.add('is-magnetic');
      magnetize(b);
    });
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init, { once: true });
  } else { init(); }
})();
