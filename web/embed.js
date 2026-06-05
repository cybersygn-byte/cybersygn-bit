/**
 * Embedded "Sign with CyberSygn" widget.
 *
 * Third-party sites drop a single <script src="https://cybersygn.io/embed.js"></script>
 * and any element with `data-cybersygn-sign` becomes a launcher that
 * opens the CyberSygn preview flow in an iframe modal.
 *
 * Usage:
 *   <button data-cybersygn-sign="https://my-site.com/contracts/nda.pdf"
 *           data-cybersygn-source="agency-portal">
 *     Sign this NDA
 *   </button>
 *
 * Attribution:
 *   The embedding domain is forwarded as ?embed=<host> on the launcher
 *   URL so analytics can attribute distribution to specific partners.
 *   data-cybersygn-source overrides the inferred source.
 *
 * Tracking:
 *   We do NOT send anything from the embed iframe back to the parent
 *   page. CyberSygn owns the signing surface end-to-end. The parent
 *   gets a 'cybersygn:complete' postMessage when signing finishes.
 *
 * Zero dependencies. Plain ES5 so it loads everywhere. Idempotent —
 * double-loading is safe.
 */
(function () {
  if (typeof window === 'undefined') return;
  if (window.__cybersygnEmbedLoaded) return;
  window.__cybersygnEmbedLoaded = true;

  var CYBERSYGN_ORIGIN = 'https://cybersygn.io';
  var SELECTOR = '[data-cybersygn-sign]';

  function open(pdfUrl, opts) {
    if (!pdfUrl) return;
    opts = opts || {};
    var source = opts.source || (location && location.hostname) || 'embed';
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

    // Backdrop.
    var backdrop = document.createElement('div');
    backdrop.setAttribute('data-cybersygn-modal', '');
    backdrop.style.cssText =
      'position:fixed;inset:0;z-index:2147483646;' +
      'background:rgba(1,20,52,0.72);backdrop-filter:saturate(140%) blur(8px);' +
      '-webkit-backdrop-filter:saturate(140%) blur(8px);' +
      'display:grid;place-items:center;padding:24px;';

    var card = document.createElement('div');
    card.style.cssText =
      'position:relative;width:100%;max-width:1200px;height:90vh;' +
      'background:#011434;border-radius:14px;overflow:hidden;' +
      'box-shadow:0 30px 90px rgba(0,0,0,0.45);';

    var closeBtn = document.createElement('button');
    closeBtn.type = 'button';
    closeBtn.setAttribute('aria-label', 'Close');
    closeBtn.textContent = '×';
    closeBtn.style.cssText =
      'position:absolute;top:10px;right:14px;z-index:2;' +
      'width:36px;height:36px;border:0;border-radius:18px;' +
      'background:rgba(255,255,255,0.12);color:#fff;font-size:24px;' +
      'cursor:pointer;line-height:32px;padding:0;';

    var iframe = document.createElement('iframe');
    iframe.src = CYBERSYGN_ORIGIN + '/preview/?' + params.toString();
    iframe.style.cssText = 'width:100%;height:100%;border:0;display:block;background:#011434;';
    iframe.setAttribute('allow', 'clipboard-read; clipboard-write; camera');
    iframe.setAttribute('title', 'Sign with CyberSygn');

    card.appendChild(closeBtn);
    card.appendChild(iframe);
    backdrop.appendChild(card);
    document.body.appendChild(backdrop);
    document.documentElement.style.overflow = 'hidden';

    function close() {
      try { document.body.removeChild(backdrop); } catch (e) {}
      document.documentElement.style.overflow = '';
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('message', onMessage);
    }
    function onKey(e) { if (e.key === 'Escape') close(); }
    function onMessage(e) {
      if (e.origin !== CYBERSYGN_ORIGIN) return;
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
  }

  function wire(el) {
    if (el.__cybersygnWired) return;
    el.__cybersygnWired = true;
    el.addEventListener('click', function (e) {
      e.preventDefault();
      open(el.getAttribute('data-cybersygn-sign'), {
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
    if (typeof MutationObserver !== 'undefined') {
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
