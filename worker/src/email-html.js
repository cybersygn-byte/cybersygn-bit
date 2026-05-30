/**
 * HTML email templates for CyberSygn transactional mail.
 *
 * Constraints:
 *   - Inline styles only. Gmail strips <style> blocks; Outlook strips a
 *     subset of CSS regardless. Every style we care about goes inline.
 *   - Table-based layout. Divs are unreliable across the matrix of
 *     Gmail, Outlook (desktop, mobile, web), Apple Mail, Yahoo, Proton.
 *   - 600px max width. Mobile clients scale down; this width survives
 *     every desktop client without horizontal scroll.
 *   - Web-safe fallback fonts. We declare Inter for clients that allow
 *     custom fonts (Apple Mail), but the stack falls through to
 *     -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif so the
 *     email reads cleanly even where Inter is blocked.
 *   - Palette per Section 4 of the CyberSygn constitution. Navy ink
 *     (#011434), electric cyan (#00CBF6), cool paper (#F7F8FB). The
 *     cyan is reserved for the primary CTA per Section 4.6.
 *   - One primary action per email per Section 1.12. CTA is the magic
 *     link or the download URL; no other competing buttons.
 *   - prefers-color-scheme honored via a tiny <style> block in <head>.
 *     Most clients ignore it, but the ones that respect it (Apple Mail,
 *     iOS Mail) will switch to a dark surface automatically.
 *
 * All three render functions take a typed args object and return the
 * full HTML document as a string suitable for the `html` field on the
 * Resend (or any other transactional-email API) payload.
 */

const NAVY  = '#011434';
const CYAN  = '#00CBF6';
const PAPER = '#F7F8FB';
const INK   = '#3A4258';   // body text on light
const MUTED = '#7079A0';   // tertiary
const LINE  = '#E7EAF2';   // hairline borders
const FONT_STACK = "Inter, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif";

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Shared shell: head, dark-mode <style> hint, outer wrapper table.
 * Caller provides the inner body markup.
 */
function shell({ preheader, body }) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="color-scheme" content="light dark" />
<meta name="supported-color-schemes" content="light dark" />
<title>CyberSygn</title>
<style>
  @media (prefers-color-scheme: dark) {
    .cs-bg     { background-color: #0A0E1A !important; }
    .cs-card   { background-color: ${NAVY} !important; border-color: rgba(255,255,255,0.08) !important; }
    .cs-title  { color: #F7F8FB !important; }
    .cs-text   { color: rgba(247,248,251,0.78) !important; }
    .cs-muted  { color: rgba(247,248,251,0.55) !important; }
    .cs-rule   { border-top-color: rgba(255,255,255,0.10) !important; }
    .cs-kv-key { color: rgba(247,248,251,0.55) !important; }
    .cs-kv-val { color: #F7F8FB !important; }
  }
  a { color: ${CYAN}; }
</style>
</head>
<body style="margin:0;padding:0;background-color:${PAPER};">
<div style="display:none;max-height:0;overflow:hidden;mso-hide:all;font-size:1px;line-height:1px;color:${PAPER};">${esc(preheader || '')}</div>
<table role="presentation" class="cs-bg" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:${PAPER};">
  <tr><td align="center" style="padding:32px 16px;">
    <table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="max-width:600px;width:100%;">
      <!-- Brand -->
      <tr><td style="padding:0 8px 24px 8px;">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
          <tr>
            <td align="left" style="font-family:${FONT_STACK};font-size:14px;font-weight:600;letter-spacing:0.16em;text-transform:uppercase;color:${NAVY};">
              <span class="cs-title">CYBERSYGN</span>
            </td>
            <td align="right" style="font-family:${FONT_STACK};font-size:11px;letter-spacing:0.06em;text-transform:uppercase;color:${MUTED};" class="cs-muted">
              Built in Colorado
            </td>
          </tr>
        </table>
      </td></tr>

      <!-- Card -->
      <tr><td class="cs-card" style="background-color:#FFFFFF;border:1px solid ${LINE};border-radius:14px;padding:32px;">
        ${body}
      </td></tr>

      <!-- Footer -->
      <tr><td align="center" style="padding:24px 8px 8px 8px;font-family:${FONT_STACK};font-size:12px;line-height:1.55;color:${MUTED};" class="cs-muted">
        You received this because a CyberSygn sender added your email to a document signing list. <br />
        Reply to this email with questions or visit
        <a href="https://cybersygn.io/" style="color:${CYAN};text-decoration:underline;">cybersygn.io</a>.
      </td></tr>
    </table>
  </td></tr>
</table>
</body>
</html>`;
}

function ctaButton({ url, label }) {
  // Two-layer button: outer table acts as the button surface; inner anchor
  // is the click target. Style on both so Outlook renders the surface
  // and webmail renders the anchor.
  return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:16px 0 8px 0;">
  <tr><td bgcolor="${CYAN}" style="background-color:${CYAN};border-radius:10px;mso-padding-alt:14px 28px;">
    <a href="${esc(url)}"
       style="display:inline-block;padding:14px 28px;font-family:${FONT_STACK};font-size:15px;font-weight:600;letter-spacing:-0.005em;color:${NAVY};text-decoration:none;border-radius:10px;">
      ${esc(label)}
    </a>
  </td></tr>
</table>`;
}

function kvTable(rows) {
  if (!rows || rows.length === 0) return '';
  const trs = rows.map(([k, v]) => `
    <tr>
      <td class="cs-kv-key" style="padding:8px 0;font-family:${FONT_STACK};font-size:12px;letter-spacing:0.04em;text-transform:uppercase;color:${MUTED};vertical-align:top;width:30%;">${esc(k)}</td>
      <td class="cs-kv-val" style="padding:8px 0;font-family:${FONT_STACK};font-size:14px;color:${NAVY};vertical-align:top;">${esc(v)}</td>
    </tr>`).join('');
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:12px 0 0 0;border-top:1px solid ${LINE};">${trs}</table>`;
}

// ---- Public renderers -------------------------------------------------------

export function renderInviteHtml({ name, senderName, docTitle, magicLink }) {
  const heading = `${esc(senderName || 'A CyberSygn sender')} needs your signature.`;
  return shell({
    preheader: `${senderName || 'Someone'} sent you ${docTitle || 'a document'} to sign on CyberSygn.`,
    body: `
      <h1 class="cs-title" style="margin:0 0 12px 0;font-family:${FONT_STACK};font-size:24px;line-height:1.2;font-weight:700;letter-spacing:-0.02em;color:${NAVY};">${heading}</h1>
      <p class="cs-text" style="margin:0 0 8px 0;font-family:${FONT_STACK};font-size:15px;line-height:1.55;color:${INK};">
        Hello ${esc(name || 'there')}. ${esc(senderName || 'Someone')} sent you a document to sign through CyberSygn. Click the button below to review and sign in your browser. You do not need an account.
      </p>
      ${kvTable([
        docTitle ? ['Document', docTitle] : null,
        ['Sender',  senderName || 'A CyberSygn sender'],
        ['Action',  'Review and sign'],
      ].filter(Boolean))}
      ${ctaButton({ url: magicLink, label: 'Review and sign →' })}
      <p class="cs-muted" style="margin:16px 0 0 0;font-family:${FONT_STACK};font-size:12px;line-height:1.55;color:${MUTED};">
        This link is unique to you. Do not forward it. Anyone with the link can sign as you.
      </p>
      <hr class="cs-rule" style="border:0;border-top:1px solid ${LINE};margin:24px 0 16px 0;" />
      <p class="cs-muted" style="margin:0;font-family:${FONT_STACK};font-size:12px;line-height:1.55;color:${MUTED};">
        Trouble with the button? Paste this URL into your browser:<br />
        <span style="word-break:break-all;color:${INK};">${esc(magicLink)}</span>
      </p>`,
  });
}

export function renderReminderHtml({ name, senderName, docTitle, magicLink, tone }) {
  const t = tone || 'first';
  const heading = t === 'final'
    ? 'Final reminder.'
    : t === 'second'
    ? 'Still waiting on your signature.'
    : 'Reminder: your signature is needed.';
  const opening = t === 'final'
    ? `This is the last reminder we will send. After today the link expires and ${senderName || 'the sender'} will need to issue a new one.`
    : t === 'second'
    ? `It has been a few days. ${senderName || 'The sender'} is still waiting on your signature.`
    : `${senderName || 'A CyberSygn sender'} is waiting for you to sign.`;
  return shell({
    preheader: `${docTitle || 'A CyberSygn document'} still needs your signature.`,
    body: `
      <h1 class="cs-title" style="margin:0 0 12px 0;font-family:${FONT_STACK};font-size:24px;line-height:1.2;font-weight:700;letter-spacing:-0.02em;color:${NAVY};">${heading}</h1>
      <p class="cs-text" style="margin:0 0 8px 0;font-family:${FONT_STACK};font-size:15px;line-height:1.55;color:${INK};">
        Hello ${esc(name || 'there')}. ${esc(opening)}
      </p>
      ${kvTable([
        docTitle ? ['Document', docTitle] : null,
        ['Sender',  senderName || 'A CyberSygn sender'],
        ['Reminder', t.charAt(0).toUpperCase() + t.slice(1)],
      ].filter(Boolean))}
      ${ctaButton({ url: magicLink, label: 'Open and sign →' })}
      <p class="cs-muted" style="margin:16px 0 0 0;font-family:${FONT_STACK};font-size:12px;line-height:1.55;color:${MUTED};">
        This link is unique to you. Do not forward it.
      </p>`,
  });
}

export function renderCompletionHtml({ name, docTitle, downloadUrl, auditUrl }) {
  return shell({
    preheader: `${docTitle || 'Your CyberSygn document'} is signed and ready.`,
    body: `
      <h1 class="cs-title" style="margin:0 0 12px 0;font-family:${FONT_STACK};font-size:24px;line-height:1.2;font-weight:700;letter-spacing:-0.02em;color:${NAVY};">Signed and ready.</h1>
      <p class="cs-text" style="margin:0 0 8px 0;font-family:${FONT_STACK};font-size:15px;line-height:1.55;color:${INK};">
        Hello ${esc(name || 'there')}. Every signer has completed their part. ${esc(docTitle ? '"' + docTitle + '" is' : 'Your document is')} ready to download.
      </p>
      ${ctaButton({ url: downloadUrl, label: 'Download signed PDF →' })}
      ${auditUrl ? `
      <p class="cs-text" style="margin:16px 0 4px 0;font-family:${FONT_STACK};font-size:14px;line-height:1.55;color:${INK};">
        Audit certificate, a one-page PDF listing every signer, every event, and the SHA-256 fingerprint of the original document. Keep it with the signed PDF as proof of who signed what and when.
      </p>
      <p style="margin:0;font-family:${FONT_STACK};font-size:14px;">
        <a href="${esc(auditUrl)}" style="color:${CYAN};text-decoration:underline;">Download audit certificate →</a>
      </p>` : ''}
      <hr class="cs-rule" style="border:0;border-top:1px solid ${LINE};margin:24px 0 16px 0;" />
      <p class="cs-muted" style="margin:0;font-family:${FONT_STACK};font-size:12px;line-height:1.55;color:${MUTED};">
        Trouble with the button? Paste this URL into your browser:<br />
        <span style="word-break:break-all;color:${INK};">${esc(downloadUrl)}</span>
      </p>`,
  });
}
