/**
 * Apple-style scroll-driven video hero.
 *
 * Behavior:
 *   1. If web/brand/hero.mp4 loads successfully, the <video> takes over
 *      and the CSS/SVG placeholder fades out. Video is scrubbed by
 *      scroll position — video.currentTime = (scrollY / heroHeight) * duration.
 *   2. If the MP4 is missing or fails to load, the placeholder animation
 *      keeps running and the experience never breaks.
 *   3. Respects prefers-reduced-motion: no scrub, video paused on first frame.
 *
 * Drop-in workflow: generate a 10–20s vertical-friendly product reveal in
 * Higgsfield (see docs/HIGGSFIELD-VIDEO-PROMPTS.md), export as h.264 MP4
 * with frequent keyframes (every 6–10 frames so scrubbing is smooth),
 * save to web/brand/hero.mp4, and the page picks it up on next load.
 */
(function () {
  if (typeof window === 'undefined') return;
  const hero = document.getElementById('cinematic-hero');
  const video = document.getElementById('cinematic-hero-video');
  if (!hero || !video) return;

  const reduced = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  // Step 1: detect whether the video file actually exists and is playable.
  // loadedmetadata fires the moment dimensions + duration are known.
  // error fires if the source is 404 or can't be decoded.
  let videoReady = false;
  function markReady() {
    if (videoReady) return;
    videoReady = true;
    hero.dataset.videoReady = 'true';
    // First frame visible immediately. Scroll handler takes over from here.
    if (reduced) {
      video.pause();
      try { video.currentTime = 0; } catch (e) {}
    }
  }
  function markFailed() {
    // Placeholder stays; explicitly drop the video element to free decoder.
    try { video.remove(); } catch (e) {}
  }
  video.addEventListener('loadedmetadata', markReady, { once: true });
  video.addEventListener('canplay', markReady, { once: true });
  video.addEventListener('error', markFailed, { once: true });
  // Safety net: if 4 seconds pass with no metadata, assume the file's
  // not there. Browsers can sometimes swallow the error event.
  setTimeout(() => { if (!videoReady) markFailed(); }, 4000);

  // Step 2: scroll-driven scrub. Maps the user's scroll position
  // through the hero's vertical span to the video's currentTime.
  // Uses requestAnimationFrame coalescing so we don't redundantly
  // seek on every scroll tick.
  let scrolling = false;
  function onScroll() {
    if (!videoReady || reduced) return;
    if (scrolling) return;
    scrolling = true;
    requestAnimationFrame(() => {
      scrolling = false;
      const rect = hero.getBoundingClientRect();
      const heroTop = rect.top + window.scrollY;
      const heroHeight = rect.height;
      const scrubStart = heroTop;
      const scrubEnd = heroTop + heroHeight;
      const y = window.scrollY + window.innerHeight * 0.5;
      // Progress: 0 at top of viewport entering hero, 1 at bottom leaving it.
      let p = (y - scrubStart) / Math.max(1, scrubEnd - scrubStart);
      p = Math.max(0, Math.min(1, p));
      const dur = isFinite(video.duration) ? video.duration : 0;
      if (dur > 0) {
        try { video.currentTime = p * dur; } catch (e) {}
      }
    });
  }
  window.addEventListener('scroll', onScroll, { passive: true });
  window.addEventListener('resize', onScroll, { passive: true });
  // Initial sync.
  setTimeout(onScroll, 100);
})();
