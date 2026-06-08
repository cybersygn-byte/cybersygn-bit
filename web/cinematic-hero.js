/**
 * Cinematic hero — one-shot autoplay with logo-overlay outro.
 *
 * Behavior:
 *   1. If web/brand/hero.mp4 loads successfully, the <video> autoplays
 *      ONCE muted. No loop. The CSS/SVG placeholder fades out.
 *   2. The CyberSygn logo overlay opacity is driven from
 *      video.currentTime each frame:
 *        - first FADE_DURATION seconds: hold visible 0-0.2s, fade out 0.2-FADE
 *        - middle of the play: opacity 0 (let the cinematic breathe)
 *        - last FADE_DURATION seconds: fade in 0 -> 1
 *      So the video opens and closes with the logo as a brand bookend.
 *   3. On 'ended': the video element fades out (CSS transition on
 *      .cinematic-hero[data-video-ended="true"] .cinematic-hero__video).
 *      The logo overlay is pinned at opacity 1. RAF tick stops so the
 *      logo never bounces back down. State holds until page reload.
 *   4. If MP4 is missing or fails, the SVG placeholder runs forever
 *      with logo held at full opacity.
 *   5. Respects prefers-reduced-motion: video paused on first frame,
 *      logo held at full opacity, no fades.
 *
 * Length-agnostic: works at any duration. Fade timings scale to a
 * proportion of total run-time.
 */
(function () {
  if (typeof window === 'undefined') return;
  const hero = document.getElementById('cinematic-hero');
  const video = document.getElementById('cinematic-hero-video');
  const logo = document.getElementById('cinematic-hero-logo');
  if (!hero || !video) return;

  const reduced = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  // Glassy opening haze: a frosted sheen behind the logo / in front of the
  // video. CSS runs the fade; here we just retire the element once it has
  // faded so it never lingers as a backdrop-filter layer (keeps scroll and
  // compositing cheap, especially on Android). Reduced-motion: drop it outright.
  const haze = document.querySelector('.cinematic-hero__haze');
  if (haze) {
    if (reduced) { haze.style.display = 'none'; }
    else { haze.addEventListener('animationend', () => { haze.remove(); }, { once: true }); }
  }

  function fadeDurationFor(totalSec) {
    if (!isFinite(totalSec) || totalSec <= 0) return 1.6;
    return Math.min(1.6, totalSec * 0.15);
  }

  let videoReady = false;
  let videoEnded = false;
  let fadeDuration = 1.6;
  let rafId = 0;

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
    try { video.play().catch(() => {}); } catch (e) {}
    startLogoSync();
  }

  function markFailed() {
    try { video.remove(); } catch (e) {}
    if (logo) logo.style.opacity = '1';
  }

  function handleEnded() {
    videoEnded = true;
    hero.dataset.videoEnded = 'true';
    // Pin the logo at full opacity; stop RAF so we never tick it back down.
    if (logo) logo.style.opacity = '1';
    if (rafId) cancelAnimationFrame(rafId);
    rafId = 0;
  }

  video.addEventListener('loadedmetadata', markReady, { once: true });
  video.addEventListener('canplay', markReady, { once: true });
  video.addEventListener('error', markFailed, { once: true });
  video.addEventListener('ended', handleEnded, { once: true });
  setTimeout(() => { if (!videoReady) markFailed(); }, 4000);

  function tickLogo() {
    if (videoEnded || !videoReady || !logo) {
      // If the video ended, lock to 1 and stop. Otherwise wait for ready.
      if (videoEnded && logo) logo.style.opacity = '1';
      if (!videoEnded) rafId = requestAnimationFrame(tickLogo);
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
      const p = (t - holdEdge) / Math.max(0.001, fade - holdEdge);
      opacity = 1 - p;
    } else if (t < dur - fade) {
      opacity = 0;
    } else if (t < dur - holdEdge) {
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
  // When the tab becomes hidden during playback, the browser may pause
  // the video. We do NOT auto-resume on visibilitychange — the spec is
  // "play once, hold." If the user returns to a paused mid-play state,
  // they'll see the frame the browser parked on plus the logo state
  // we last drove, which is honest and reflects the one-shot rule.
  document.addEventListener('visibilitychange', () => {
    if (document.hidden && rafId) {
      cancelAnimationFrame(rafId);
      rafId = 0;
    } else if (!document.hidden && !videoEnded && videoReady && !reduced) {
      startLogoSync();
    }
  });
})();
