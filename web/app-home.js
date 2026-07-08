/*
 * Root app-first boot (classic script, loaded on web/index.html).
 *
 * The marketing HTML stays in the DOM for crawlers and first-time visitors.
 * For a returning/known user (or an installed-app launch, or an arriving
 * `?signin=` magic link) this renders the App Home workspace IN PLACE, with no
 * redirect: it hides the marketing children of <body> and mounts a clean,
 * mobile-first home over them. The bottom app shell is added separately by
 * shared/app-shell.js.
 */
(function () {
  'use strict';

  var K = {
    sender: 'cybersygn.senderId',
    email: 'cybersygn.email',
    used: 'cybersygn.hasUsed',
    freeToken: 'cybersygn.freeToken',
  };
  function ls(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
  function lsSet(k, v) { try { localStorage.setItem(k, v); } catch (e) {} }

  function isStandalone() {
    return (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches) ||
      window.navigator.standalone === true;
  }
  function param(name) {
    try { return new URLSearchParams(location.search).get(name); } catch (e) { return null; }
  }
  function known() {
    return ls(K.used) === '1' || !!ls(K.freeToken) || !!ls(K.email) ||
      isStandalone() || param('app') === '1';
  }
  function stripQuery(keys) {
    try {
      var u = new URL(location.href);
      keys.forEach(function (k) { u.searchParams.delete(k); });
      history.replaceState(null, '', u.pathname + (u.searchParams.toString() ? '?' + u.searchParams : '') + u.hash);
    } catch (e) {}
  }
  function esc(s) { var d = document.createElement('div'); d.textContent = s == null ? '' : String(s); return d.innerHTML; }

  // ---- Magic-link sign-in ---------------------------------------------------
  function handleSignin(cb) {
    var token = param('signin');
    if (!token) { cb(); return; }
    // Send this device's own senderId. For an ENROLL link the server binds
    // THIS id to the email (so the person who holds the link owns the
    // workspace); for a RECOVER link the server ignores it and returns the
    // already-bound id.
    var deviceId = '';
    try {
      deviceId = (window.CyberSygnShell && window.CyberSygnShell.ensureSenderId())
        || ls(K.sender) || '';
    } catch (e) { deviceId = ls(K.sender) || ''; }
    fetch('/api/auth/verify', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: token, senderId: deviceId }),
    }).then(function (r) { return r.json().catch(function () { return null; }); })
      .then(function (j) {
        if (j && j.senderId && /^[a-f0-9]{24,64}$/i.test(j.senderId)) {
          lsSet(K.sender, j.senderId.toLowerCase());
          lsSet(K.used, '1');
        }
        stripQuery(['signin']);
        cb();
      })
      .catch(function () { stripQuery(['signin']); cb(); });
  }

  // ---- Styles (scoped, reuse styles.css tokens where present) ---------------
  function injectStyles() {
    if (document.getElementById('csx-apphome-style')) return;
    var css = ''
      + 'html.csx-app-mode, body.csx-app-mode { background: var(--bg, #F7F8FB); }'
      + 'body.csx-app-mode > *:not(.csx-apphome):not(.csx-tabbar):not(.csx-scrim):not(.csx-sheet):not(script):not(style):not(link){ display:none !important; }'
      + '.csx-apphome{ max-width: 720px; margin: 0 auto; padding: 28px 20px 40px; font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif; color: var(--text,#011434); }'
      + '.csx-ah-top{ display:flex; align-items:center; justify-content:space-between; gap:12px; margin-bottom:22px; }'
      + '.csx-ah-brand{ display:flex; align-items:center; gap:10px; font-weight:700; letter-spacing:-0.01em; font-size:17px; }'
      + '.csx-ah-brand img{ width:30px; height:30px; border-radius:8px; }'
      + '.csx-ah-acct{ appearance:none; border:1px solid var(--line,rgba(1,20,52,.12)); background:var(--surface,#fff); color:var(--text,#011434); border-radius:999px; padding:10px 16px; font:inherit; font-size:14px; font-weight:600; cursor:pointer; min-height:44px; }'
      + '.csx-ah-hello{ font-size:clamp(24px,6vw,32px); letter-spacing:-0.03em; margin:0 0 6px; font-weight:750; }'
      + '.csx-ah-sub{ color:var(--text-2,#3A4258); margin:0 0 22px; font-size:16px; }'
      + '.csx-ah-primary{ display:flex; align-items:center; gap:14px; width:100%; box-sizing:border-box; text-decoration:none; background:var(--text,#011434); color:#fff; border-radius:18px; padding:20px 22px; margin-bottom:14px; box-shadow:0 8px 24px rgba(1,20,52,.16); }'
      + '.csx-ah-primary .csx-ah-ic{ width:30px; height:30px; flex:none; }'
      + '.csx-ah-primary b{ font-size:18px; display:block; letter-spacing:-0.01em; }'
      + '.csx-ah-primary span{ font-size:14px; opacity:.82; }'
      + '.csx-ah-grid{ display:grid; grid-template-columns:1fr 1fr; gap:12px; margin-bottom:26px; }'
      + '.csx-ah-card{ display:flex; flex-direction:column; gap:8px; text-decoration:none; background:var(--surface,#fff); border:1px solid var(--line,rgba(1,20,52,.10)); border-radius:16px; padding:16px; color:var(--text,#011434); min-height:96px; }'
      + '.csx-ah-card .csx-ah-ic{ width:24px; height:24px; color:var(--accent-text,#007496); }'
      + '.csx-ah-card b{ font-size:15px; }'
      + '.csx-ah-card span{ font-size:13px; color:var(--text-2,#3A4258); }'
      + '.csx-ah-sec{ font-size:13px; font-weight:700; text-transform:uppercase; letter-spacing:0.06em; color:var(--text-3,#4F5874); margin:0 2px 12px; }'
      + '.csx-ah-doc{ display:flex; align-items:center; gap:12px; text-decoration:none; background:var(--surface,#fff); border:1px solid var(--line,rgba(1,20,52,.10)); border-radius:14px; padding:14px 16px; margin-bottom:10px; color:var(--text,#011434); }'
      + '.csx-ah-doc__t{ flex:1; min-width:0; }'
      + '.csx-ah-doc__t b{ display:block; font-size:15px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }'
      + '.csx-ah-doc__t span{ font-size:13px; color:var(--text-2,#3A4258); }'
      + '.csx-ah-pill{ font-size:12px; font-weight:700; padding:5px 10px; border-radius:999px; white-space:nowrap; }'
      + '.csx-ah-pill--done{ background:rgba(30,138,95,.12); color:#1E8A5F; }'
      + '.csx-ah-pill--wait{ background:rgba(201,131,29,.14); color:#9A6410; }'
      + '.csx-ah-empty{ text-align:center; color:var(--text-2,#3A4258); background:var(--surface,#fff); border:1px dashed var(--line-2,rgba(1,20,52,.16)); border-radius:16px; padding:26px 18px; font-size:15px; }'
      + '.csx-ah-more{ display:inline-flex; align-items:center; min-height:44px; padding:8px 4px; margin-top:2px; color:var(--accent-text,#007496); font-weight:650; text-decoration:none; font-size:14px; }'
      + '@media (prefers-color-scheme: dark){ .csx-ah-primary{ background:#EAF0FA; color:#011434; } }';
    var st = document.createElement('style');
    st.id = 'csx-apphome-style';
    st.textContent = css;
    document.head.appendChild(st);
  }

  var IC = {
    plus: '<svg class="csx-ah-ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="8.4"/><path d="M12 8.4v7.2M8.4 12h7.2"/></svg>',
    ai: '<svg class="csx-ah-ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3.5 13.7 9 19 10.7 13.7 12.4 12 18l-1.7-5.6L5 10.7 10.3 9z"/></svg>',
    docs: '<svg class="csx-ah-ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M6 3.5h7l4 4V20a.5.5 0 0 1-.5.5h-10A.5.5 0 0 1 6 20z"/><path d="M13 3.5V8h4"/></svg>',
    tmpl: '<svg class="csx-ah-ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="4" width="16" height="16" rx="2.5"/><path d="M4 9h16M9 9v11"/></svg>',
  };

  function greeting() {
    var h = new Date().getHours();
    if (h < 12) return 'Good morning';
    if (h < 18) return 'Good afternoon';
    return 'Good evening';
  }

  function pill(status) {
    var s = String(status || '').toLowerCase();
    if (s === 'completed' || s === 'complete' || s === 'signed') return '<span class="csx-ah-pill csx-ah-pill--done">Signed</span>';
    if (s === 'declined') return '<span class="csx-ah-pill csx-ah-pill--wait">Declined</span>';
    return '<span class="csx-ah-pill csx-ah-pill--wait">Awaiting</span>';
  }

  function render() {
    // Build the overlay element FULLY before hiding the marketing DOM, so a
    // failure here can never leave a blank page (marketing stays visible).
    var host = document.createElement('main');
    host.className = 'csx-apphome';
    host.innerHTML =
      '<div class="csx-ah-top">' +
        '<span class="csx-ah-brand"><img src="/brand/icon-192.png" alt="" /> CyberSygn</span>' +
        '<button class="csx-ah-acct" type="button" id="csx-ah-acct">Account</button>' +
      '</div>' +
      '<h1 class="csx-ah-hello">' + greeting() + '.</h1>' +
      '<p class="csx-ah-sub">Send a document and get it signed. CyberSygn finds every signature line for you.</p>' +
      '<a class="csx-ah-primary" href="/preview/?src=app-home">' + IC.plus +
        '<span><b>New document</b><span>Upload a PDF, place signers, send</span></span></a>' +
      '<div class="csx-ah-grid">' +
        '<a class="csx-ah-card" href="/draft/?src=app-home">' + IC.ai + '<b>Draft with AI</b><span>Describe the deal, get a contract</span></a>' +
        '<a class="csx-ah-card" href="/dashboard/?src=app-home">' + IC.docs + '<b>Your documents</b><span>Track status and signers</span></a>' +
        '<a class="csx-ah-card" href="/templates/?src=app-home">' + IC.tmpl + '<b>Templates</b><span>Start from a ready contract</span></a>' +
        '<a class="csx-ah-card" href="/verify/?src=app-home">' + IC.docs + '<b>Verify</b><span>Confirm a signed document</span></a>' +
      '</div>' +
      '<p class="csx-ah-sec">Recent</p>' +
      '<div id="csx-ah-recent"><div class="csx-ah-empty">Loading your documents...</div></div>';

    // Only now hide the marketing children and mount the overlay. Styles +
    // class + append happen with no paint in between, so there is no flash and
    // no window where marketing is hidden without the app being shown.
    injectStyles();
    document.documentElement.classList.add('csx-app-mode');
    document.body.classList.add('csx-app-mode');
    document.body.appendChild(host);

    var acct = document.getElementById('csx-ah-acct');
    if (acct) acct.addEventListener('click', function () {
      if (window.CyberSygnShell) window.CyberSygnShell.openAccount();
    });

    loadRecent();
  }

  function loadRecent() {
    var host = document.getElementById('csx-ah-recent');
    var senderId = ls(K.sender);
    if (!host) return;
    if (!senderId) { renderEmpty(host); return; }
    fetch('/api/sender/' + encodeURIComponent(senderId) + '/docs')
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (j) {
        var docs = (j && Array.isArray(j.docs)) ? j.docs : [];
        if (!docs.length) { renderEmpty(host); return; }
        docs = docs.slice(0, 4);
        host.innerHTML = docs.map(function (d) {
          var title = d.title || 'Untitled document';
          var count = (d.signers && d.signers.length) ? d.signers.length + (d.signers.length === 1 ? ' signer' : ' signers') : 'Document';
          return '<a class="csx-ah-doc" href="/dashboard/?src=app-home">' +
            '<div class="csx-ah-doc__t"><b>' + esc(title) + '</b><span>' + esc(count) + '</span></div>' +
            pill(d.status) + '</a>';
        }).join('') + '<a class="csx-ah-more" href="/dashboard/">See all documents</a>';
      })
      .catch(function () { renderEmpty(host); });
  }

  function renderEmpty(host) {
    host.innerHTML = '<div class="csx-ah-empty">No documents yet. Tap <b>New document</b> to send your first one.</div>';
  }

  // ---- Boot -----------------------------------------------------------------
  function safeRender() {
    try {
      render();
    } catch (e) {
      // Never trap the user on a blank page: if the overlay fails to mount,
      // undo the hide so the marketing page (a usable fallback) shows.
      try {
        document.documentElement.classList.remove('csx-app-mode');
        if (document.body) document.body.classList.remove('csx-app-mode');
      } catch (e2) {}
    }
  }

  function boot() {
    handleSignin(function () {
      if (known()) {
        if (document.body) safeRender();
        else document.addEventListener('DOMContentLoaded', safeRender);
      }
      // New visitors: do nothing. Marketing stays; the bottom shell mounts
      // itself and the hero CTA already starts the flow.
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
