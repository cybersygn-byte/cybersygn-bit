/**
 * Cinematic hero — autoplay loop with bookend logo fade.
 *
 * Behavior:
 *   1. If web/brand/hero.mp4 loads successfully, the <video> autoplays
 *      muted and loops continuously. The CSS/SVG placeholder fades out.
 *   2. If the MP4 is missing or fails, the placeholder runs forever.
 *   3. The CyberSygn logo overlay sits on top of the video, opacity
 *      driven from video.currentTime each frame:
 *        - first FADE_DURATION seconds of every loop: fade out 1 -> 0
 *        - middle of the loop: opacity 0 (let the cinematic breathe)
 *        - last FADE_DURATION seconds: fade in 0 -> 1
 *      So every iteration starts and ends with the logo visible, which
 *      reads as "CyberSygn presents... [cinematic] ... CyberSygn." It
 *      gives the loop a brand bookend without requiring the video itself
 *      to include the logo (so the cinematic stays portable and easy
 *      to re-render in Higgsfield).
 *   4. Respects prefers-reduced-motion: video paused on first frame,
 *      logo held at full opacity.
 *
 * Length-agnostic: works at any video duration. The fade timings are
 * calculated from video.duration once metadata loads, so swapping in
 * a 10-second or 30-second cinematic just works.
 */
(function () {
  if (typeof window === 'undefined') return;
  const hero = document.getElementById('cinematic-hero');
  const video = document.getElementById('cinematic-hero-video');
  const logo = document.getElementById('cinematic-hero-logo');
  if (!hero || !video) return;

  const reduced = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  // Length of each bookend fade. 1.6s gives the brand a confident, paced
  // breathing room without burning too much of the loop. Adjusted to a
  // proportion of the video if the video is short.
  function fadeDurationFor(totalSec) {
    if (!isFinite(totalSec) || totalSec <= 0) return 1.6;
    // For short videos, cap the bookends at ~15% of total.
    return Math.min(1.6, totalSec * 0.15);
  }

  let videoReady = false;
  let fadeDuration = 1.6;

  function markReady() {
    if (videoReady) return;
    videoReady = true;
    hero.dataset.videoReady = 'true';
    if (isFinite(video.duration) && video.duration > 0) {
      fadeDuration = fadeDurationFor(video.duration);
    }
    if (reduced) {
      try { video.pause(); video.currentTime = 0; } catch (e) {}
      if (logo) logo.style.opacity = '1';
      return;
    }
    // Kick autoplay — most browsers permit muted autoplay without
    // user gesture. play() returns a promise; rejection is fine,
    // the user can still see the first frame as poster.
    try { video.play().catch(() => {}); } catch (e) {}
    startLogoSync();
  }

  function markFailed() {
    try { video.remove(); } catch (e) {}
    if (logo) {
      // No video means no bookends — just keep the logo solid over
      // the placeholder so the brand reads regardless.
      logo.style.opacity = '1';
    }
  }

  video.addEventListener('loadedmetadata', markReady, { once: true });
  video.addEventListener('canplay', markReady, { once: true });
  video.addEventListener('error', markFailed, { once: true });
  setTimeout(() => { if (!videoReady) markFailed(); }, 4000);

  // Per-frame logo opacity driven by video.currentTime.
  // Curve:
  //   0           - 0.2s          : opacity 1 (hold visible at start)
  //   0.2         - fadeDuration  : opacity 1 -> 0
  //   fadeDuration - (dur - fadeDuration): opacity 0
  //   (dur - fadeDuration) - (dur - 0.2) : opacity 0 -> 1
  //   (dur - 0.2) - dur           : opacity 1 (hold visible at end)
  let rafId = 0;
  function tickLogo() {
    if (!videoReady || !logo) {
      rafId = requestAnimationFrame(tickLogo);
      return;
    }
    const dur = isFinite(video.duration) && video.duration > 0 ? video.duration : 15;
    const t = isFinite(video.currentTime) ? video.currentTime : 0;
    const holdEdge = 0.2;
    const fade = fadeDuration;
    let opacity;
    if (t < holdEdge) {
      opacity = 1;
    } else if (t < fade) {
      // Linear fade out from 1 to 0 across (holdEdge -> fade).
      const p = (t - holdEdge) / Math.max(0.001, fade - holdEdge);
      opacity = 1 - p;
    } else if (t < dur - fade) {
      opacity = 0;
    } else if (t < dur - holdEdge) {
      // Linear fade in from 0 to 1 across ((dur-fade) -> (dur-holdEdge)).
      const p = (t - (dur - fade)) / Math.max(0.001, fade - holdEdge);
      opacity = Math.min(1, Math.max(0, p));
    } else {
      opacity = 1;
    }
    logo.style.opacity = String(Math.max(0, Math.min(1, opacity)));
    rafId = requestAnimationFrame(tickLogo);
  }
  function startLogoSync() {
    if (rafId) cancelAnimationFrame(rafId);
    rafId = requestAnimationFrame(tickLogo);
  }
  // Pause RAF when the tab is hidden — save battery, don't tick uselessly.
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      if (rafId) cancelAnimationFrame(rafId);
      rafId = 0;
    } else if (videoReady && !reduced) {
      startLogoSync();
      // Resume playback if autoplay paused during background.
      try { video.play().catch(() => {}); } catch (e) {}
    }
  });
})();
