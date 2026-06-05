/**
 * First-time onboarding: coachmarks + milestone toasts.
 *
 * The product's wow moment is automatic field detection. New users
 * need a small, deliberate guide that surfaces that moment, then
 * celebrates their first three milestones:
 *
 *   1. First detection (when fields first appear on a fresh upload)
 *   2. First field filled (when fillStore goes from 0 → 1)
 *   3. First send / download (when the user produces a signed PDF)
 *
 * Each fires exactly once per browser (localStorage flags). The
 * coachmark for #1 hands a soft pointer to the field-type legend
 * so the user understands what they're looking at.
 *
 * Designed to be aware of all the existing in-app machinery: it
 * subscribes to track() events emitted by app.js and shows lightweight
 * UI from there. No deep coupling.
 */
(function () {
  if (typeof window === 'undefined') return;

  const FLAGS_KEY = 'cybersygn.onboarding.flags';
  function readFlags() {
    try { return JSON.parse(localStorage.getItem(FLAGS_KEY) || '{}'); } catch (e) { return {}; }
  }
  function writeFlags(f) {
    try { localStorage.setItem(FLAGS_KEY, JSON.stringify(f)); } catch (e) {}
  }
  function setFlag(name) {
    const f = readFlags();
    if (f[name]) return false;
    f[name] = new Date().toISOString();
    writeFlags(f);
    return true;
  }
  function hasFlag(name) {
    return Boolean(readFlags()[name]);
  }

  // ---- Coachmark for first detection ------------------------------------
  function showFirstDetectionCoachmark() {
    if (!setFlag('first_detection')) return;
    // Anchor: the field-type legend in the sidebar.
    const anchor = document.querySelector('.sidebar__legend');
    if (!anchor) return;
    const rect = anchor.getBoundingClientRect();

    const mark = document.createElement('div');
    mark.className = 'coachmark';
    mark.style.cssText =
      'position:fixed;z-index:80;max-width:300px;padding:14px 16px;' +
      'background:#011434;color:#F7F8FB;border:1px solid #00CBF6;' +
      'border-radius:10px;box-shadow:0 18px 40px rgba(1,20,52,0.32);' +
      'font-family:Inter,system-ui,sans-serif;font-size:13px;line-height:1.5;' +
      'top:' + Math.round(rect.top + window.scrollY + rect.height + 12) + 'px;' +
      'left:' + Math.max(12, Math.round(rect.left - 12)) + 'px;';
    mark.innerHTML =
      '<p style="margin:0 0 8px;font-family:JetBrains Mono,monospace;font-size:10px;text-transform:uppercase;letter-spacing:0.1em;color:#6EDEFA">First time here?</p>' +
      '<p style="margin:0 0 10px"><strong>That just happened in 3 seconds.</strong> Every signature line, date, initial, and checkbox in your PDF — automatically placed. Color codes show what kind of field each one is.</p>' +
      '<button type="button" style="appearance:none;border:0;background:#00CBF6;color:#011434;padding:6px 12px;border-radius:6px;font-weight:600;cursor:pointer;font-size:12px;">Got it</button>';
    document.body.appendChild(mark);
    const dismiss = () => { try { mark.remove(); } catch (e) {} };
    mark.querySelector('button').addEventListener('click', dismiss);
    setTimeout(dismiss, 12000);
  }

  // ---- Milestone toasts ------------------------------------------------
  function showMilestone(title, sub) {
    const t = document.createElement('div');
    t.className = 'milestone-toast';
    t.style.cssText =
      'position:fixed;bottom:24px;left:50%;transform:translate(-50%, 80px);' +
      'z-index:90;max-width:380px;padding:14px 20px;background:#011434;' +
      'color:#F7F8FB;border-radius:14px;box-shadow:0 18px 40px rgba(1,20,52,0.36);' +
      'border:1px solid #00CBF6;font-family:Inter,system-ui,sans-serif;' +
      'font-size:14px;line-height:1.45;display:flex;gap:12px;align-items:center;' +
      'transition:transform 320ms cubic-bezier(.22,1,.36,1);';
    t.innerHTML =
      '<div style="font-size:22px">🎉</div>' +
      '<div>' +
        '<p style="margin:0;font-weight:600">' + title + '</p>' +
        (sub ? '<p style="margin:2px 0 0;font-size:12px;opacity:0.85">' + sub + '</p>' : '') +
      '</div>';
    document.body.appendChild(t);
    requestAnimationFrame(() => { t.style.transform = 'translate(-50%, 0)'; });
    setTimeout(() => {
      t.style.transform = 'translate(-50%, 80px)';
      setTimeout(() => { try { t.remove(); } catch (e) {} }, 320);
    }, 4200);
  }

  // ---- Hook into app.js's track() pipeline ------------------------------
  // We wrap window.cybersygn.track so every existing event analytics
  // call also gets a chance to trigger onboarding UI. Lightweight,
  // no API surface change.
  function installTrackHook() {
    const cs = window.cybersygn = window.cybersygn || {};
    const originalTrack = cs.track || function () {};
    cs.track = function (event, props) {
      try { originalTrack(event, props); } catch (e) {}
      try {
        if (event === 'preview_detection_completed' && (props?.fieldCount || 0) > 0) {
          // Wait a beat so the sidebar paints before we anchor to it.
          setTimeout(showFirstDetectionCoachmark, 700);
        }
        if (event === 'preview_field_filled' && setFlag('first_fill')) {
          showMilestone('First field filled.', 'You\'re doing it. Keep going.');
        }
        if ((event === 'preview_downloaded_direct' || event === 'preview_send_clicked') && setFlag('first_send')) {
          showMilestone('First signed document!', 'Saved hours of DocuSign drudgery. Send another?');
        }
      } catch (err) {}
    };
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', installTrackHook);
  } else {
    installTrackHook();
  }

  // Public reset for development.
  (window.cybersygn = window.cybersygn || {}).resetOnboarding = function () {
    try { localStorage.removeItem(FLAGS_KEY); } catch (e) {}
    console.info('[cybersygn] onboarding flags cleared');
  };
})();
