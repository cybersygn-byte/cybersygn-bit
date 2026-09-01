/**
 * Embedded "Sign with CyberSygn" widget.
 *
 * Third-party sites drop a single script tag and any element with
 * `data-cybersygn-sign` becomes a launcher that opens the CyberSygn
 * signing flow in a full-viewport iframe modal:
 *
 *   <script src="https://cybersygn.io/embed.js"></script>
 *   <button data-cybersygn-sign="https://cybersygn.io/preview/?doc=DOC&t=TOKEN"
 *           data-cybersygn-source="agency-portal">
 *     Sign this NDA
 *   </button>
 *
 * THE URL MUST BE ON cybersygn.io. The signing page fetches the document from
 * our origin and our connect-src 'self' policy blocks a PDF served from your
 * own domain before the request leaves the browser. There is no proxy endpoint
 * yet, so create the document through POST /api/v1/documents and embed the
 * signing_url it returns. This example used to read my-site.com, which cannot
 * work and fails at launch.
 *
 * `data-cybersygn-sign` accepts either:
 *   - a PDF URL on cybersygn.io: opens the send flow with it preloaded, or
 *   - a signing_url from POST /api/v1/documents, shaped
 *     https://cybersygn.io/preview/?doc=...&t=... : opens that signer's
 *     session directly, so API-created documents get signed in place.
 *
 * Optional launcher attributes (PDF mode):
 *   data-cybersygn-source  attribution tag (default: location.hostname)
 *   data-cybersygn-email   pre-fill the signer email
 *   data-cybersygn-name    pre-fill the signer name
 *   data-cybersygn-theme   light | dark | auto
 *   data-cybersygn-accent  #hex accent for primary CTAs
 *
 * Completion:
 *   When a signer finishes inside the iframe, the signing page posts
 *   { type: 'cybersygn:complete', docComplete, docId, signerEmail } to
 *   the parent. This widget verifies the message origin, re-dispatches
 *   it on window as a 'cybersygn:complete' CustomEvent (event.detail is
 *   that payload), then closes the modal after a short hold:
 *
 *     window.addEventListener('cybersygn:complete', function (e) {
 *       // e.detail = { type, docComplete, docId, signerEmail }
 *     });
 *
 * Programmatic control:
 *   window.CyberSygn.open(url, { source, signerEmail, signerName,
 *   theme, accent })
 *
 * Beyond that one completion message, nothing flows from the signing
 * iframe back to the parent page. CyberSygn owns the signing surface
 * end-to-end. Zero dependencies. Plain ES5 so it loads everywhere.
 * Idempotent: double-loading is safe.
 */
(function () {
  if (typeof window === 'undefined') return;
  if (window.__cybersygnEmbedLoaded) return;
  window.__cybersygnEmbedLoaded = true;

  var DEFAULT_ORIGIN = 'https://cybersygn.io';
  var SELECTOR = '[data-cybersygn-sign]';

  // Resolve the CyberSygn origin from the script tag itself so the widget
  // also works on cybersygn.io subdomains and local static previews. Any
  // other host (a partner copying the file to their own CDN) keeps the
  // production origin.
  var CYBERSYGN_ORIGIN = DEFAULT_ORIGIN;
  try {
    var cs = document.currentScript;
    if (cs && cs.src) {
      var u = new URL(cs.src, location.href);
      var devHost = u.hostname === 'localhost' || u.hostname === '127.0.0.1';
      var ownHost = u.hostname === 'cybersygn.io' || /\.cybersygn\.io$/.test(u.hostname);
      if ((u.protocol === 'https:' || u.protocol === 'http:') && (devHost || ownHost)) {
        CYBERSYGN_ORIGIN = u.origin;
      }
    }
  } catch (e) {}

  function warn(msg) {
    try { console.warn('[cybersygn-embed] ' + msg); } catch (e) {}
  }

  // A CyberSygn signing link (signing_url from the v1 API or a magic
  // link) is iframed as-is; anything else is treated as a PDF URL and
  // wrapped in the send flow.
  function signingLinkOrigin(url) {
    if (typeof url !== 'string') return null;
    var origins = [CYBERSYGN_ORIGIN, DEFAULT_ORIGIN];
    for (var i = 0; i < origins.length; i++) {
      if (url.indexOf(origins[i] + '/preview/?') === 0 &&
          url.indexOf('doc=') !== -1 && /[?&]t=/.test(url)) {
        return origins[i];
      }
    }
    return null;
  }

  function open(pdfUrl, opts) {
    if (!pdfUrl) {
      warn('CyberSygn.open needs a PDF URL or a signing_url. Nothing to open.');
      return;
    }
    opts = opts || {};
    var source = opts.source || (location && location.hostname) || 'embed';

    var linkOrigin = signingLinkOrigin(pdfUrl);
    var src;
    if (linkOrigin) {
      src = pdfUrl;
    } else {
      var params = new URLSearchParams();
      params.set('embed', source);
      params.set('pdf', pdfUrl);
      if (opts.signerEmail) params.set('email', opts.signerEmail);
      if (opts.signerName)  params.set('name',  opts.signerName);
      // Slice 95 theming. theme: light|dark|auto. accent: hex.
      if (opts.theme && /^(light|dark|auto)$/.test(opts.theme)) params.set('theme', opts.theme);
      if (opts.accent && /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(opts.accent)) {
        params.set('accent', opts.accent);
      }
      src = CYBERSYGN_ORIGIN + '/preview/?' + params.toString();
    }
    var frameOrigin = linkOrigin || CYBERSYGN_ORIGIN;

    // Backdrop.
    var backdrop = document.createElement('div');
    backdrop.setAttribute('data-cybersygn-modal', '');
    backdrop.style.cssText =
      'position:fixed;inset:0;z-index:2147483646;' +
      'background:rgba(1,20,52,0.72);backdrop-filter:saturate(140%) blur(8px);' +
      '-webkit-backdrop-filter:saturate(140%) blur(8px);' +
      'display:grid;place-items:center;padding:24px;';

    // On small screens go full-bleed: a 90vh card inside a 24px-padded
    // backdrop nests two viewports and is unstable under the iOS dynamic
    // URL bar. Below 600px we drop the backdrop padding to 0 and let the
    // card fill the dynamic viewport (100dvh) edge-to-edge.
    var isSmall = window.matchMedia && window.matchMedia('(max-width:600px)').matches;
    if (isSmall) {
      backdrop.style.padding = '0';
    }

    var card = document.createElement('div');
    card.setAttribute('role', 'dialog');
    card.setAttribute('aria-modal', 'true');
    card.setAttribute('aria-label', 'Sign with CyberSygn');
    card.style.cssText =
      'position:relative;width:100%;max-width:1200px;height:90dvh;' +
      'background:#011434;border-radius:14px;overflow:hidden;' +
      'box-shadow:0 30px 90px rgba(0,0,0,0.45);';
    if (isSmall) {
      card.style.height = '100dvh';
      card.style.maxWidth = 'none';
      card.style.borderRadius = '0';
    }

    var closeBtn = document.createElement('button');
    closeBtn.type = 'button';
    closeBtn.setAttribute('aria-label', 'Close');
    closeBtn.textContent = '×';
    closeBtn.style.cssText =
      'position:absolute;top:8px;right:8px;z-index:2;' +
      'width:44px;height:44px;border:0;border-radius:22px;' +
      'background:rgba(255,255,255,0.12);color:#fff;font-size:24px;' +
      'cursor:pointer;line-height:44px;padding:0;';
    if (isSmall) {
      // Full-bleed card: keep the close button out of the notch and the
      // rounded corners. Browsers without env() ignore these and keep 8px.
      closeBtn.style.top = 'calc(8px + env(safe-area-inset-top, 0px))';
      closeBtn.style.right = 'calc(8px + env(safe-area-inset-right, 0px))';
    }

    var iframe = document.createElement('iframe');
    iframe.src = src;
    iframe.style.cssText = 'width:100%;height:100%;border:0;display:block;background:#011434;';
    iframe.setAttribute('allow', 'clipboard-read; clipboard-write; camera');
    iframe.setAttribute('title', 'Sign with CyberSygn');

    card.appendChild(closeBtn);
    card.appendChild(iframe);
    backdrop.appendChild(card);
    document.body.appendChild(backdrop);
    document.documentElement.style.overflow = 'hidden';

    var restoreFocus = document.activeElement;

    function close() {
      try { document.body.removeChild(backdrop); } catch (e) {}
      document.documentElement.style.overflow = '';
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('message', onMessage);
      try {
        if (restoreFocus && typeof restoreFocus.focus === 'function') restoreFocus.focus();
      } catch (e) {}
    }
    function onKey(e) { if (e.key === 'Escape') close(); }
    function onMessage(e) {
      if (e.origin !== frameOrigin) return;
      if (e.data && e.data.type === 'cybersygn:complete') {
        // Notify the embedding page so they can update their UI.
        try {
          window.dispatchEvent(new CustomEvent('cybersygn:complete', { detail: e.data }));
        } catch (err) {}
        // Auto-close after a short hold so the user reads the
        // confirmation in the iframe.
        setTimeout(close, 1200);
      }
      if (e.data && e.data.type === 'cybersygn:close') {
        close();
      }
    }
    closeBtn.addEventListener('click', close);
    backdrop.addEventListener('click', function (e) { if (e.target === backdrop) close(); });
    window.addEventListener('keydown', onKey);
    window.addEventListener('message', onMessage);
    try { closeBtn.focus(); } catch (e) {}
  }

  function wire(el) {
    if (el.__cybersygnWired) return;
    el.__cybersygnWired = true;
    el.addEventListener('click', function (e) {
      e.preventDefault();
      var url = el.getAttribute('data-cybersygn-sign');
      if (!url) {
        warn('data-cybersygn-sign is empty on the clicked element. Set it to a PDF URL or a signing_url.');
        return;
      }
      open(url, {
        source: el.getAttribute('data-cybersygn-source') || undefined,
        signerEmail: el.getAttribute('data-cybersygn-email') || undefined,
        signerName: el.getAttribute('data-cybersygn-name') || undefined,
        // Slice 95: theming opt-ins on the launcher element.
        theme: el.getAttribute('data-cybersygn-theme') || undefined,
        accent: el.getAttribute('data-cybersygn-accent') || undefined,
      });
    });
  }

  function init() {
    var els = document.querySelectorAll(SELECTOR);
    for (var i = 0; i < els.length; i++) wire(els[i]);
    // Watch for elements added after load.
    if (typeof MutationObserver !== 'undefined' && document.body) {
      var mo = new MutationObserver(function (muts) {
        for (var j = 0; j < muts.length; j++) {
          var added = muts[j].addedNodes;
          for (var k = 0; k < added.length; k++) {
            var node = added[k];
            if (node.nodeType !== 1) continue;
            if (node.matches && node.matches(SELECTOR)) wire(node);
            if (node.querySelectorAll) {
              var nested = node.querySelectorAll(SELECTOR);
              for (var n = 0; n < nested.length; n++) wire(nested[n]);
            }
          }
        }
      });
      mo.observe(document.body, { childList: true, subtree: true });
    }
  }

  // Public API for sites that want programmatic control.
  window.CyberSygn = window.CyberSygn || {};
  window.CyberSygn.open = open;

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
