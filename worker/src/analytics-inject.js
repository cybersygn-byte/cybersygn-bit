/**
 * Server-side injection of third-party analytics tags into HTML responses.
 *
 * Why server-side: lets us keep the analytics IDs out of the static
 * source tree (they're secrets in wrangler) and toggle them per-env
 * without rebuilds. HTMLRewriter is Cloudflare's streaming HTML parser
 *, zero-copy, runs at the edge.
 *
 * Two integrations:
 *
 *   GA4 (Google Analytics 4)
 *     Env: CYBERSYGN_GA4_ID  (e.g. "G-XXXXXXXXXX")
 *     Effect: injects gtag.js + the GA4 config snippet into <head>.
 *
 *   GSC (Google Search Console) site verification
 *     Env: CYBERSYGN_GSC_TOKEN  (the meta-tag content value GSC issues)
 *     Effect: injects <meta name="google-site-verification" content="..."/>
 *     into <head>.
 *
 * Privacy: GA4 is loaded with anonymize_ip and respects do_not_track.
 * No PII is sent. We do NOT inject the script on /preview/ pages while
 * a doc is loaded, that surface handles its own internal telemetry.
 */

const NO_INJECT_PATHS = [
  // Avoid double-instrumenting and avoid sending document-handling
  // page views (which can be sensitive PDFs in the URL hash) to GA.
  '/preview/',
];

// CSP note: the site's script-src is hash-locked (no 'unsafe-inline'). When GA4
// is enabled this function injects gtag.js (an external script) plus an inline
// config snippet, so it also RELAXES the CSP on that one response to allow the
// Google tag hosts and the exact inline snippet (by hash). When GA4/GSC are
// unset (the default) the function early-returns and touches nothing.
export async function maybeInjectAnalytics(response, env) {
  if (!response || !(response instanceof Response)) return response;
  const ct = response.headers.get('content-type') || '';
  if (!ct.includes('text/html')) return response;

  const ga4 = env && typeof env.CYBERSYGN_GA4_ID === 'string' ? env.CYBERSYGN_GA4_ID.trim() : '';
  const gsc = env && typeof env.CYBERSYGN_GSC_TOKEN === 'string' ? env.CYBERSYGN_GSC_TOKEN.trim() : '';
  if (!ga4 && !gsc) return response;

  // Path-based opt-out, keep PDF-handling routes out of analytics.
  try {
    const url = new URL(response.url || 'https://cybersygn.io/');
    if (NO_INJECT_PATHS.some(p => url.pathname.startsWith(p))) return response;
  } catch (e) {}

  const id = escapeAttr(ga4);
  // The exact inline config snippet, built once so the CSP hash matches it byte for byte.
  const gaInline = ga4
    ? `window.dataLayer=window.dataLayer||[];function gtag(){dataLayer.push(arguments);}gtag('js',new Date());gtag('config','${id}',{anonymize_ip:true,send_page_view:true});`
    : '';

  // HTMLRewriter is available in the Worker runtime globally.
  const rewriter = new HTMLRewriter();
  rewriter.on('head', {
    element(el) {
      if (gsc) {
        el.append(
          `<meta name="google-site-verification" content="${escapeAttr(gsc)}" />`,
          { html: true },
        );
      }
      if (ga4) {
        el.append(
          `<script async src="https://www.googletagmanager.com/gtag/js?id=${id}"></script>` +
          `<script>${gaInline}</script>`,
          { html: true },
        );
      }
    },
  });
  const out = rewriter.transform(response);
  if (!ga4) return out;

  // Relax the hash-locked CSP for the injected Google tag on this response only.
  const csp = out.headers.get('content-security-policy');
  if (!csp) return out;
  try {
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(gaInline));
    const bytes = new Uint8Array(digest);
    let bin = '';
    for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    const hash = `'sha256-${btoa(bin)}'`;
    const relaxed = csp
      .replace(/script-src ([^;]*)/, `script-src $1 https://www.googletagmanager.com ${hash}`)
      .replace(/connect-src ([^;]*)/, `connect-src $1 https://www.google-analytics.com https://www.googletagmanager.com`)
      .replace(/img-src ([^;]*)/, `img-src $1 https://www.google-analytics.com`);
    const headers = new Headers(out.headers);
    headers.set('content-security-policy', relaxed);
    return new Response(out.body, { status: out.status, statusText: out.statusText, headers });
  } catch (e) {
    return out;
  }
}

function escapeAttr(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}
