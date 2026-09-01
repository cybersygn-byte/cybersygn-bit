/*
 * CyberSygn app shell (classic script, no imports).
 *
 * Renders a persistent bottom tab bar + an account sheet so the separate app
 * surfaces feel like one installable app, and registers the service worker.
 *
 * Mounts when <body data-app-shell> is present AND we are not in signer mode,
 * an embed iframe, or the owner console. Opt out per-page with
 * <body data-no-shell>. Exposes window.CyberSygnShell.
 */
(function () {
  'use strict';
  if (window.CyberSygnShell) return;

  var K = {
    sender: 'cybersygn.senderId',
    email: 'cybersygn.email',
    used: 'cybersygn.hasUsed',
    freeToken: 'cybersygn.freeToken',
    docTokens: 'cybersygn.docTokens',
    workspaces: 'cybersygn.workspaces',
    activeWs: 'cybersygn.activeWorkspaceId',
    installDismiss: 'cybersygn.installDismiss',
  };

  function ls(key) { try { return localStorage.getItem(key); } catch (e) { return null; } }
  function lsSet(key, val) { try { localStorage.setItem(key, val); } catch (e) {} }
  function lsDel(key) { try { localStorage.removeItem(key); } catch (e) {} }

  function isValidKey(v) { return typeof v === 'string' && /^[a-f0-9]{24,64}$/i.test(v.trim()); }

  // Mirror preview/identity.js: 16 random bytes -> 32 hex chars. Keeping the
  // format identical means getSenderId() there reads the same value.
  function ensureSenderId() {
    var cur = ls(K.sender);
    if (isValidKey(cur)) return cur.trim();
    var bytes = new Uint8Array(16);
    (self.crypto || window.crypto).getRandomValues(bytes);
    var hex = Array.prototype.map.call(bytes, function (b) {
      return ('0' + b.toString(16)).slice(-2);
    }).join('');
    lsSet(K.sender, hex);
    return hex;
  }

  function isSignedIn() { return !!ls(K.email) || ls(K.used) === '1'; }
  function isStandalone() {
    return (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches) ||
      window.navigator.standalone === true;
  }
  function isIOS() { return /iP(hone|ad|od)/.test(navigator.userAgent) && !window.MSStream; }

  // ---- Guards ---------------------------------------------------------------
  function shouldMount() {
    var b = document.body;
    if (!b || !('appShell' in b.dataset)) return false;
    if ('noShell' in b.dataset) return false;
    if ('signer' in b.dataset) return false;
    try { if (window.top !== window.self) return false; } catch (e) { return false; } // embedded
    var s = location.search || '';
    if (/[?&](doc|sign|s|sig)=/.test(s)) return false; // signer magic-link view
    if (/^\/control/.test(location.pathname)) return false;
    return true;
  }

  // ---- Icons ----------------------------------------------------------------
  var ICON = {
    home: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 10.5 12 4l9 6.5"/><path d="M5 9.5V20h14V9.5"/></svg>',
    plus: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="8.4"/><path d="M12 8.4v7.2M8.4 12h7.2"/></svg>',
    docs: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M7 3.5h7l4 4V20a.5.5 0 0 1-.5.5h-10A.5.5 0 0 1 7 20z" transform="translate(-1 0)"/><path d="M13 3.5V8h4"/><path d="M8.5 12.5h6M8.5 15.5h6"/></svg>',
    user: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="8.5" r="3.6"/><path d="M5.5 19c.7-3.2 3.3-5 6.5-5s5.8 1.8 6.5 5"/></svg>',
    copy: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="11" height="11" rx="2.5"/><path d="M15 9V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v7a2 2 0 0 0 2 2h3"/></svg>',
    key: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><circle cx="8" cy="8" r="4"/><path d="m11 11 8 8M16 16l2-2M18.5 18.5l1.5-1.5"/></svg>',
    mail: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="5.5" width="18" height="13" rx="2.5"/><path d="m4 7 8 5.5L20 7"/></svg>',
    install: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3.5v10M8 10l4 4 4-4"/><path d="M5 16.5v2A1.5 1.5 0 0 0 6.5 20h11a1.5 1.5 0 0 0 1.5-1.5v-2"/></svg>',
    out: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M14 4.5H6.5A1.5 1.5 0 0 0 5 6v12a1.5 1.5 0 0 0 1.5 1.5H14"/><path d="M17 8.5 20.5 12 17 15.5M20 12H9.5"/></svg>',
    shield: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3.5 19 6v5c0 4.4-3 8-7 9.5C8 19 5 15.4 5 11V6z"/><path d="m9 12 2 2 4-4"/></svg>',
  };

  var deferredInstall = null;
  window.addEventListener('beforeinstallprompt', function (e) {
    e.preventDefault();
    deferredInstall = e;
    var row = document.getElementById('csx-install-row');
    if (row) row.classList.remove('csx-hide');
    // The browser says we are installable: proactively offer it (mobile).
    maybeShowInstallBanner('android');
  });
  window.addEventListener('appinstalled', function () {
    lsSet(K.installDismiss, String(Date.now()));
    hideInstallBanner();
  });

  // ---- Proactive install prompt (mobile) ------------------------------------
  // Android/Chrome: shown when the browser fires beforeinstallprompt.
  // iOS Safari: shown with Add-to-Home-Screen instructions (no JS install API).
  // Dismissible, remembered for 14 days, never shown when already installed.
  var installBanner = null;
  function isIosSafari() {
    var ua = navigator.userAgent;
    return isIOS() && /Safari/.test(ua) && !/CriOS|FxiOS|EdgiOS|GSA|OPiOS|Chrome/.test(ua);
  }
  function installSuppressed() {
    if (isStandalone()) return true;
    var t = ls(K.installDismiss);
    if (t && (Date.now() - parseInt(t, 10)) < 14 * 24 * 3600 * 1000) return true;
    return false;
  }
  function hideInstallBanner() { if (installBanner) installBanner.classList.add('csx-hide'); }
  function maybeShowInstallBanner(kind) {
    if (installSuppressed()) return;
    if (kind === 'android' && !deferredInstall) return;
    if (kind === 'ios' && !isIosSafari()) return;
    if (installBanner) { installBanner.classList.remove('csx-hide'); return; }
    var bar = document.createElement('div');
    bar.className = 'csx-install-banner csx-ib-enter';
    bar.setAttribute('role', 'dialog');
    bar.setAttribute('aria-label', 'Install CyberSygn');
    var line = kind === 'ios'
      ? 'Tap the Share icon, then "Add to Home Screen".'
      : 'Add it to your home screen for one-tap signing.';
    var actionBtn = kind === 'ios' ? '' : '<button type="button" class="csx-ib__go">Install</button>';
    bar.innerHTML =
      '<img class="csx-ib__icon" src="/brand/icon-192.png" alt="" />' +
      '<div class="csx-ib__txt"><strong>Install CyberSygn</strong><span>' + line + '</span></div>' +
      actionBtn +
      '<button type="button" class="csx-ib__x" aria-label="Not now">×</button>';
    document.body.appendChild(bar);
    installBanner = bar;
    var go = bar.querySelector('.csx-ib__go');
    if (go) go.addEventListener('click', function () { doInstall(); });
    bar.querySelector('.csx-ib__x').addEventListener('click', function () {
      lsSet(K.installDismiss, String(Date.now()));
      hideInstallBanner();
    });
    // Rest state is visible (see CSS). Remove the entrance class on a timer
    // (setTimeout fires even in a background tab, unlike rAF) so it slides in
    // but is never left invisible if the timer is delayed.
    setTimeout(function () { bar.classList.remove('csx-ib-enter'); }, 30);
  }

  // ---- Tab bar --------------------------------------------------------------
  function tab(href, id, label, icon, active, onClick) {
    var el = document.createElement(onClick ? 'button' : 'a');
    el.className = 'csx-tab' + (active ? ' is-active' : '');
    if (!onClick) { el.href = href; } else { el.type = 'button'; el.addEventListener('click', onClick); }
    el.setAttribute('aria-label', label);
    if (active) el.setAttribute('aria-current', 'page');
    el.innerHTML = '<span class="csx-tab__icon">' + icon + '</span><span>' + label + '</span>';
    return el;
  }

  function currentTab() {
    var p = location.pathname.replace(/\/+$/, '') || '/';
    if (p === '' || p === '/') return 'home';
    if (p.indexOf('/preview') === 0 || p.indexOf('/draft') === 0) return 'new';
    if (p.indexOf('/dashboard') === 0) return 'docs';
    return '';
  }

  function buildTabbar() {
    var cur = currentTab();
    var bar = document.createElement('nav');
    bar.className = 'csx-tabbar';
    bar.setAttribute('aria-label', 'App');
    bar.appendChild(tab('/', 'home', 'Home', ICON.home, cur === 'home'));
    bar.appendChild(tab('/preview/', 'new', 'New', ICON.plus, cur === 'new'));
    bar.appendChild(tab('/dashboard/', 'docs', 'Documents', ICON.docs, cur === 'docs'));
    bar.appendChild(tab(null, 'account', 'Account', ICON.user, false, openAccount));
    document.body.appendChild(bar);
    document.body.classList.add('has-app-shell');
  }

  // ---- Account sheet --------------------------------------------------------
  var scrim, sheet;

  function row(icon, title, hint, cls, onClick, id) {
    var tag = onClick ? 'button' : 'div';
    var el = document.createElement(tag);
    el.className = 'csx-row' + (cls ? ' ' + cls : '');
    if (onClick) { el.type = 'button'; el.addEventListener('click', onClick); }
    if (id) el.id = id;
    el.innerHTML = '<span class="csx-row__ico">' + icon + '</span>' +
      '<span class="csx-row__t">' + title + (hint ? '<br><span class="csx-row__hint">' + hint + '</span>' : '') + '</span>';
    return el;
  }

  function buildSheet() {
    scrim = document.createElement('div');
    scrim.className = 'csx-scrim';
    scrim.addEventListener('click', closeAccount);

    sheet = document.createElement('div');
    sheet.className = 'csx-sheet';
    sheet.setAttribute('role', 'dialog');
    sheet.setAttribute('aria-modal', 'true');
    sheet.setAttribute('aria-label', 'Account');

    document.body.appendChild(scrim);
    document.body.appendChild(sheet);
  }

  function planLine() {
    // Every branch here used to resolve to 'Free plan' for a paying customer,
    // because the only non-free branch keyed on a 'paid:' token prefix that
    // nothing has ever written. Telling a subscriber they are on the free plan
    // is worse than saying nothing, so say nothing until the real tier is known.
    // planLineFromTier() below is called once /api/billing/subscription answers.
    var t = window.__cybersygnTier
      || (window.__cybersygnSub && window.__cybersygnSub.tier);
    if (t && t !== 'free') return 'Unlimited plan';
    if (t === 'free') return 'Free plan';
    return '';
  }

  // Resolve the real plan once. Nothing else in the shell knew the tier, which
  // is why the label defaulted to "Free plan" for everyone including paying
  // customers. Best-effort and silent: a failed lookup leaves the label blank
  // rather than asserting a plan we cannot confirm.
  function resolveTier() {
    try {
      if (window.__cybersygnTier) return;
      // handleBillingSubscription reads senderId from the QUERY STRING, not a
      // header. Sending it as a header returned the anonymous shape and the
      // label would have stayed blank forever.
      var sid = ls('cybersygn.senderId') || '';
      if (!sid) return;
      fetch('/api/billing/subscription?senderId=' + encodeURIComponent(sid))
        .then(function (r) { return r.ok ? r.json() : null; })
        .then(function (d) {
          if (d && d.tier) { window.__cybersygnTier = d.tier; try { renderSheet(); } catch (e) {} }
        })
        .catch(function () {});
    } catch (e) {}
  }

  try { resolveTier(); } catch (e) {}

  function renderSheet() {
    var email = ls(K.email);
    sheet.innerHTML = '';
    var grip = document.createElement('div'); grip.className = 'csx-sheet__grip'; sheet.appendChild(grip);

    var brand = document.createElement('img');
    brand.className = 'csx-sheet__wordmark';
    brand.src = '/brand/lockup-navy-2x.png';
    brand.alt = 'CyberSygn';
    sheet.appendChild(brand);

    var h = document.createElement('h2'); h.textContent = email ? 'Your account' : 'Your workspace';
    sheet.appendChild(h);
    var sub = document.createElement('p'); sub.className = 'csx-sheet__sub';
    sub.textContent = (email ? email + '  ·  ' : '') + planLine();
    sheet.appendChild(sub);

    // Install (hidden until installable; hidden entirely if already installed).
    if (!isStandalone()) {
      if (isIOS()) {
        sheet.appendChild(row(ICON.install, 'Add to Home Screen',
          'Tap the Share icon, then "Add to Home Screen"', '', function () {
            alert('To install CyberSygn: tap the Share button in Safari, then choose "Add to Home Screen".');
          }));
      } else {
        var ir = row(ICON.install, 'Install app', 'Use CyberSygn like a native app', '', doInstall, 'csx-install-row');
        if (!deferredInstall) ir.classList.add('csx-hide');
        sheet.appendChild(ir);
      }
    }

    // Move / recover account.
    sheet.appendChild(row(ICON.copy, 'Copy sign-in key', 'Paste it on another device to sign in', '', copyKey));
    sheet.appendChild(row(ICON.key, 'Use a sign-in key', 'Bring an existing workspace to this device', '', showPasteKey));
    sheet.appendChild(row(ICON.mail, 'Email me a sign-in link', 'The simple way to sign in on your phone', '', showEmailLink));

    // Trust + help.
    sheet.appendChild(row(ICON.shield, 'Verify a document', '', '', function () { location.href = '/verify/'; }));

    // Sign out (only meaningful once there is something to sign out of).
    if (isSignedIn() || ls(K.freeToken)) {
      sheet.appendChild(row(ICON.out, 'Sign out of this device', '', 'csx-row--danger', signOut));
    }

    var note = document.createElement('p'); note.className = 'csx-note';
    note.textContent = 'No passwords. Your sign-in key and email link are two ways to open the same workspace anywhere.';
    sheet.appendChild(note);
  }

  var lastFocus = null;

  function onSheetKeydown(e) {
    if (e.key === 'Escape' || e.keyCode === 27) { closeAccount(); }
  }

  function openAccount() {
    if (!sheet) buildSheet();
    renderSheet();
    lastFocus = document.activeElement;
    scrim.classList.add('is-open');
    // Next frame so the transform transition runs.
    requestAnimationFrame(function () {
      sheet.classList.add('is-open');
      // Move focus into the dialog and let Escape close it.
      sheet.setAttribute('tabindex', '-1');
      try { sheet.focus(); } catch (e) {}
      document.addEventListener('keydown', onSheetKeydown);
    });
  }
  function closeAccount() {
    if (!sheet) return;
    sheet.classList.remove('is-open');
    scrim.classList.remove('is-open');
    document.removeEventListener('keydown', onSheetKeydown);
    // Return focus to whatever opened the sheet.
    if (lastFocus && lastFocus.focus) { try { lastFocus.focus(); } catch (e) {} }
  }

  function toast(el, msg) {
    var n = document.createElement('p'); n.className = 'csx-note csx-ok'; n.textContent = msg;
    el.appendChild(n);
  }

  function copyKey() {
    var id = ensureSenderId();
    var done = function () { renderSheet(); toast(sheet, 'Sign-in key copied. Keep it private.'); };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(id).then(done, function () { fallbackCopy(id, done); });
    } else { fallbackCopy(id, done); }
  }
  function fallbackCopy(text, cb) {
    try {
      var t = document.createElement('textarea'); t.value = text;
      t.style.position = 'fixed'; t.style.opacity = '0'; document.body.appendChild(t);
      t.select(); document.execCommand('copy'); document.body.removeChild(t);
    } catch (e) {}
    cb();
  }

  function showPasteKey() {
    renderSheet();
    var wrap = document.createElement('div'); wrap.className = 'csx-field';
    wrap.innerHTML = '<label for="csx-key-in">Paste your sign-in key</label>' +
      '<input id="csx-key-in" type="text" autocomplete="off" autocapitalize="off" spellcheck="false" inputmode="latin" placeholder="Your key" />';
    var btn = row(ICON.key, 'Sign in with this key', '', 'csx-row--primary', function () {
      var v = (document.getElementById('csx-key-in').value || '').trim();
      if (!isValidKey(v)) { toast(sheet, 'That does not look like a valid key.'); return; }
      lsSet(K.sender, v.toLowerCase());
      lsSet(K.used, '1');
      location.href = '/';
    });
    sheet.appendChild(wrap); sheet.appendChild(btn);
    var inp = document.getElementById('csx-key-in'); if (inp) inp.focus();
  }

  function showEmailLink() {
    renderSheet();
    var wrap = document.createElement('div'); wrap.className = 'csx-field';
    wrap.innerHTML = '<label for="csx-mail-in">Your email</label>' +
      '<input id="csx-mail-in" type="email" autocomplete="email" inputmode="email" placeholder="you@example.com" />';
    var btn = row(ICON.mail, 'Email me a link', '', 'csx-row--primary', function () {
      var v = (document.getElementById('csx-mail-in').value || '').trim();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v)) { toast(sheet, 'Enter a valid email.'); return; }
      btn.setAttribute('disabled', 'true');
      fetch('/api/auth/request-link', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: v }),
      }).then(function () {
        lsSet(K.email, v);
        renderSheet();
        toast(sheet, 'If that email has an account, a sign-in link is on the way. Open it on this device.');
      }).catch(function () {
        toast(sheet, 'Could not send right now. Try again in a moment.');
      });
    });
    sheet.appendChild(wrap); sheet.appendChild(btn);
    var inp = document.getElementById('csx-mail-in'); if (inp && ls(K.email)) inp.value = ls(K.email);
  }

  function signOut() {
    if (!confirm('Sign out of CyberSygn on this device? Your documents stay safe and you can sign back in with your key or email link.')) return;
    [K.sender, K.email, K.used, K.freeToken, K.docTokens, K.workspaces, K.activeWs].forEach(lsDel);
    location.href = '/';
  }

  function doInstall() {
    if (!deferredInstall) return;
    deferredInstall.prompt();
    deferredInstall.userChoice.finally(function () {
      deferredInstall = null;
      var row = document.getElementById('csx-install-row');
      if (row) row.classList.add('csx-hide');
      hideInstallBanner();
    });
  }

  // ---- Service worker -------------------------------------------------------
  function registerSW() {
    if (!('serviceWorker' in navigator)) return;
    if (location.protocol !== 'https:' && location.hostname !== 'localhost') return;
    window.addEventListener('load', function () {
      navigator.serviceWorker.register('/sw.js').catch(function () {});
    });
  }

  // ---- Mount ----------------------------------------------------------------
  function mount() {
    if (!shouldMount()) return;
    buildTabbar();
    registerSW();
    // iOS Safari never fires beforeinstallprompt, so offer the Add-to-Home-
    // Screen hint directly after a short beat. Android is handled by the
    // beforeinstallprompt event when the browser deems the app installable.
    if (isIosSafari() && !installSuppressed()) {
      setTimeout(function () { maybeShowInstallBanner('ios'); }, 1600);
    }
  }

  window.CyberSygnShell = {
    openAccount: openAccount,
    closeAccount: closeAccount,
    ensureSenderId: ensureSenderId,
    isSignedIn: isSignedIn,
    isStandalone: isStandalone,
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', mount);
  } else {
    mount();
  }
})();
