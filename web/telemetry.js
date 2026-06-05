/**
 * First-party telemetry.
 *
 * Replaces the no-op cybersygn.track / cybersygn.report stubs that ship in
 * marketing.js and preview/app.js with real POSTs to the Worker. The Worker
 * writes to Cloudflare Analytics Engine (free tier, no cookies, no third
 * party). Every page loads this BEFORE its page-specific scripts; pages
 * that set their own track/report on `window.cybersygn` win because we
 * install ourselves first.
 *
 * Buffering: each call enqueues; the queue flushes via sendBeacon on next
 * tick. sendBeacon survives page unload, so the last click before
 * navigation is captured. POST falls through to fetch with keepalive if
 * sendBeacon is unavailable (very old browsers, certain webviews).
 *
 * Owner-mode is signaled by reading the persisted owner token and adding
 * a tier=owner field. Owner traffic is still tracked so the dashboard's
 * own usage is visible.
 */

(function () {
  if (typeof window === 'undefined') return;
  var w = window;
  var cybersygn = (w.cybersygn = w.cybersygn || {});

  var EVENT_URL = '/api/event';
  var ERROR_URL = '/api/error';
  var SENDER_KEY = 'cybersygn.senderId';
  var OWNER_KEY  = 'cybersygn.owner.token';
  var FLUSH_DEBOUNCE_MS = 200;
  var MAX_QUEUE = 50;

  // ---- sender id (already provisioned by web/preview/identity.js when present)
  function senderId() {
    try {
      var v = localStorage.getItem(SENDER_KEY);
      if (v) return v;
      // mint a fresh one if absent (so pageviews on the marketing page count too)
      var fresh = (crypto && crypto.randomUUID) ? crypto.randomUUID() : String(Date.now()) + '-' + Math.random().toString(36).slice(2);
      localStorage.setItem(SENDER_KEY, fresh);
      return fresh;
    } catch (e) { return ''; }
  }

  function tier() {
    try { return localStorage.getItem(OWNER_KEY) ? 'owner' : 'free'; } catch (e) { return 'free'; }
  }

  // ---- queue + flush
  var eventQueue = [];
  var errorQueue = [];
  var flushTimer = null;

  function send(url, payload) {
    try {
      var body = JSON.stringify(payload);
      // Try sendBeacon first (survives page unload).
      if (navigator && typeof navigator.sendBeacon === 'function') {
        var blob = new Blob([body], { type: 'application/json' });
        if (navigator.sendBeacon(url, blob)) return;
      }
      // Fallback: keepalive fetch.
      fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: body,
        keepalive: true,
      }).catch(function () {});
    } catch (e) {
      // never break user flows from telemetry
    }
  }

  function flush() {
    flushTimer = null;
    while (eventQueue.length) send(EVENT_URL, eventQueue.shift());
    while (errorQueue.length) send(ERROR_URL, errorQueue.shift());
  }

  function scheduleFlush() {
    if (flushTimer != null) return;
    flushTimer = setTimeout(flush, FLUSH_DEBOUNCE_MS);
  }

  // ---- public track
  cybersygn.track = function track(event, props) {
    if (!event || typeof event !== 'string') return;
    if (eventQueue.length >= MAX_QUEUE) return;
    var safeProps = (props && typeof props === 'object') ? props : {};
    eventQueue.push({
      event: event,
      props: {
        senderId: senderId(),
        path: w.location.pathname || '/',
        tier: tier(),
        source: safeProps.source || inferSource(),
        value: typeof safeProps.value === 'number' ? safeProps.value : undefined,
        durationMs: typeof safeProps.durationMs === 'number' ? safeProps.durationMs : undefined,
      },
    });
    scheduleFlush();
  };

  // ---- public report
  cybersygn.report = function report(err, context) {
    if (errorQueue.length >= MAX_QUEUE) return;
    var ctx = typeof context === 'string' ? context : 'unknown';
    var name = (err && err.name) ? String(err.name) : 'Error';
    var msg  = (err && err.message) ? String(err.message) : String(err || '');
    var stack = (err && err.stack) ? String(err.stack).slice(0, 800) : '';
    errorQueue.push({
      context: ctx,
      name: name,
      message: msg,
      stack: stack,
      props: { senderId: senderId(), path: w.location.pathname || '/', tier: tier(), source: inferSource() },
    });
    // Also log to console so dev sees it. Production users only see this if devtools is open.
    if (w.console && console.error) console.error('[cybersygn:error]', context || '', err);
    scheduleFlush();
  };

  // ---- global error catchers so unhandled exceptions reach the sink
  w.addEventListener('error', function (e) {
    if (!e || !e.error) return;
    cybersygn.report(e.error, 'window.onerror');
  });
  w.addEventListener('unhandledrejection', function (e) {
    var r = e && e.reason;
    cybersygn.report(r instanceof Error ? r : new Error(String(r)), 'unhandledrejection');
  });

  // ---- best-effort flush on hide / unload
  w.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'hidden') flush();
  });
  w.addEventListener('pagehide', flush);
  w.addEventListener('beforeunload', flush);

  // ---- automatic pageview
  function inferSource() {
    var p = w.location.pathname || '/';
    if (p.indexOf('/preview') === 0)    return 'preview';
    if (p.indexOf('/dashboard') === 0)  return 'dashboard';
    if (p.indexOf('/alternatives') === 0) return 'alternatives';
    return 'marketing';
  }
  cybersygn.track('pageview', { source: inferSource() });

  // ---- affiliate ref capture
  // If ?ref=<code> is in the URL, drop a cookie so the code survives
  // the visit's lifetime and the eventual checkout button sends it as
  // Stripe metadata. Cookie TTL is 60 days. Same-domain only, no
  // third-party cookies, no analytics-network leakage.
  try {
    var params = new URLSearchParams(w.location.search);
    var ref = params.get('ref');
    if (ref && /^[a-z0-9]{4,16}$/.test(ref.toLowerCase())) {
      var code = ref.toLowerCase();
      var expires = new Date(Date.now() + 60 * 24 * 60 * 60 * 1000).toUTCString();
      document.cookie = 'cybersygn_ref=' + code + '; path=/; expires=' + expires + '; SameSite=Lax';
      // Fire the click counter once per page load when the ref was
      // explicitly in the URL (cookie reads don't count as clicks).
      try {
        if (navigator.sendBeacon) {
          navigator.sendBeacon('/api/affiliate/click', JSON.stringify({ code: code }));
        } else {
          fetch('/api/affiliate/click', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ code: code }),
            keepalive: true,
          }).catch(function () {});
        }
      } catch (e) {}
      cybersygn.track('affiliate_landing', { code: code });
    }
  } catch (e) {}
})();
