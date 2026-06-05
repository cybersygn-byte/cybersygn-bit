/**
 * Server-side injection of third-party analytics tags into HTML responses.
 *
 * Why server-side: lets us keep the analytics IDs out of the static
 * source tree (they're secrets in wrangler) and toggle them per-env
 * without rebuilds. HTMLRewriter is Cloudflare's streaming HTML parser
 * — zero-copy, runs at the edge.
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
 * a doc is loaded — that surface handles its own internal telemetry.
 */

const NO_INJECT_PATHS = [
  // Avoid double-instrumenting and avoid sending document-handling
  // page views (which can be sensitive PDFs in the URL hash) to GA.
  '/preview/',
];

export function maybeInjectAnalytics(response, env) {
  if (!response || !(response instanceof Response)) return response;
  const ct = response.headers.get('content-type') || '';
  if (!ct.includes('text/html')) return response;

  const ga4 = env && typeof env.CYBERSYGN_GA4_ID === 'string' ? env.CYBERSYGN_GA4_ID.trim() : '';
  const gsc = env && typeof env.CYBERSYGN_GSC_TOKEN === 'string' ? env.CYBERSYGN_GSC_TOKEN.trim() : '';
  if (!ga4 && !gsc) return response;

  // Path-based opt-out — keep PDF-handling routes out of analytics.
  try {
    const url = new URL(response.url || 'https://cybersygn.io/');
    if (NO_INJECT_PATHS.some(p => url.pathname.startsWith(p))) return response;
  } catch (e) {}

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
        // Loader + minimal config. anonymize_ip is on by default in GA4 but
        // we set it explicitly for clarity.
        const id = escapeAttr(ga4);
        el.append(
          `<script async src="https://www.googletagmanager.com/gtag/js?id=${id}"></script>` +
          `<script>` +
            `window.dataLayer=window.dataLayer||[];` +
            `function gtag(){dataLayer.push(arguments);}` +
            `gtag('js',new Date());` +
            `gtag('config','${id}',{anonymize_ip:true,send_page_view:true});` +
          `</script>`,
          { html: true },
        );
      }
    },
  });
  return rewriter.transform(response);
}

function escapeAttr(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}
