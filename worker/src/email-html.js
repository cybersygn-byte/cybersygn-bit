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

function ctaButton({ url, label, color }) {
  // Two-layer button: outer table acts as the button surface; inner anchor
  // is the click target. Style on both so Outlook renders the surface
  // and webmail renders the anchor.
  //
  // `color` lets paid-tier senders override the default cyan with their
  // brand accent. Falls back to CYAN when absent.
  const bg = (typeof color === 'string' && /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(color)) ? color : CYAN;
  return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:16px 0 8px 0;">
  <tr><td bgcolor="${bg}" style="background-color:${bg};border-radius:10px;mso-padding-alt:14px 28px;">
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

export function renderInviteHtml({ name, senderName, docTitle, magicLink, brand }) {
  const heading = `${esc(senderName || 'A CyberSygn sender')} needs your signature.`;
  // Branded headers for paid-tier senders. If a logo URL is present we
  // emit a top banner with the sender's logo above the standard email
  // body. accentColor (when present) flows into the CTA button color.
  const brandLogo = brand && brand.logoUrl
    ? `<div style="text-align:center;padding:12px 0 18px 0;">
         <img src="${esc(brand.logoUrl)}" alt="${esc(brand.name || senderName || '')}"
              style="max-height:48px;max-width:240px;display:inline-block;" />
       </div>`
    : '';
  const ctaColor = (brand && brand.accentColor && /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(brand.accentColor))
    ? brand.accentColor
    : CYAN;
  return shell({
    preheader: `${senderName || 'Someone'} sent you ${docTitle || 'a document'} to sign on CyberSygn.`,
    body: `
      ${brandLogo}
      <h1 class="cs-title" style="margin:0 0 12px 0;font-family:${FONT_STACK};font-size:24px;line-height:1.2;font-weight:700;letter-spacing:-0.02em;color:${NAVY};">${heading}</h1>
      <p class="cs-text" style="margin:0 0 8px 0;font-family:${FONT_STACK};font-size:15px;line-height:1.55;color:${INK};">
        Hello ${esc(name || 'there')}. ${esc(senderName || 'Someone')} sent you a document to sign through CyberSygn. Click the button below to review and sign in your browser. You do not need an account.
      </p>
      ${kvTable([
        docTitle ? ['Document', docTitle] : null,
        ['Sender',  senderName || 'A CyberSygn sender'],
        ['Action',  'Review and sign'],
      ].filter(Boolean))}
      ${ctaButton({ url: magicLink, label: 'Review and sign →', color: ctaColor })}
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

export function renderCompletionHtml({ name, docTitle, downloadUrl, auditUrl, notice }) {
  const title = notice ? 'A document was signed.' : 'Signed and ready.';
  const opener = notice
    ? `Hello ${esc(name || 'there')}. You were CC'd on this signing for your records. Every signer has completed their part. ${esc(docTitle ? '"' + docTitle + '" is' : 'The document is')} below.`
    : `Hello ${esc(name || 'there')}. Every signer has completed their part. ${esc(docTitle ? '"' + docTitle + '" is' : 'Your document is')} ready to download.`;
  return shell({
    preheader: notice
      ? `${docTitle || 'A CyberSygn document'} was signed. CC notice.`
      : `${docTitle || 'Your CyberSygn document'} is signed and ready.`,
    body: `
      <h1 class="cs-title" style="margin:0 0 12px 0;font-family:${FONT_STACK};font-size:24px;line-height:1.2;font-weight:700;letter-spacing:-0.02em;color:${NAVY};">${esc(title)}</h1>
      <p class="cs-text" style="margin:0 0 8px 0;font-family:${FONT_STACK};font-size:15px;line-height:1.55;color:${INK};">
        ${opener}
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

// ─────────────────────────────────────────────────────────────────────
// Free-tier email drip campaign HTML renderers
//
// Three templates, escalating intent. Brand voice: factual, no
// wheedling, no caps, no exclamation marks. Style matches the rest of
// the transactional-email shell.
// ─────────────────────────────────────────────────────────────────────

/**
 * Day 1. Welcome + first-action nudge. No pitch.
 */
export function renderDripDay1Html({ name, url }) {
  const preview = `${url}/preview/`;
  return shell({
    preheader: 'Your first contract in 3 seconds. Here is how.',
    body: `
      <h1 class="cs-title" style="margin:0 0 12px 0;font-family:${FONT_STACK};font-size:24px;line-height:1.2;font-weight:700;letter-spacing:-0.02em;color:${NAVY};">
        Your first contract in 3 seconds.
      </h1>
      <p class="cs-text" style="margin:0 0 8px 0;font-family:${FONT_STACK};font-size:15px;line-height:1.55;color:${INK};">
        Hello ${esc(name || 'there')},
      </p>
      <p class="cs-text" style="margin:0 0 16px 0;font-family:${FONT_STACK};font-size:15px;line-height:1.55;color:${INK};">
        Yesterday you signed up for CyberSygn. Three free documents, no card.
        Today, here is the one thing that makes the product worth the email:
      </p>
      <p class="cs-text" style="margin:0 0 16px 0;font-family:${FONT_STACK};font-size:15px;line-height:1.6;color:${INK};">
        Drop a contract PDF on the preview page. Watch every signature line,
        initial, date, and checkbox appear automatically in about 3 seconds.
        No dragging. No box placement. No 30-minute manual field ritual.
      </p>
      ${ctaButton({ url: preview, label: 'Try the preview now →' })}
      <p class="cs-text" style="margin:16px 0 0 0;font-family:${FONT_STACK};font-size:14px;line-height:1.55;color:${INK};">
        That is the whole email. The rest is silence.
      </p>
      <hr class="cs-rule" style="border:0;border-top:1px solid ${LINE};margin:24px 0 16px 0;" />
      <p class="cs-muted" style="margin:0;font-family:${FONT_STACK};font-size:12px;line-height:1.55;color:${MUTED};">
        Nathan, founder. <a href="${esc(url)}" style="color:${CYAN};">cybersygn.io</a>
      </p>`,
  });
}

/**
 * Day 3. Templates tip — the lock-in mechanic.
 */
export function renderDripDay3Html({ name, url }) {
  const preview = `${url}/preview/`;
  return shell({
    preheader: 'Stop re-detecting the same PDF every week.',
    body: `
      <h1 class="cs-title" style="margin:0 0 12px 0;font-family:${FONT_STACK};font-size:24px;line-height:1.2;font-weight:700;letter-spacing:-0.02em;color:${NAVY};">
        Stop re-detecting the same PDF.
      </h1>
      <p class="cs-text" style="margin:0 0 12px 0;font-family:${FONT_STACK};font-size:15px;line-height:1.55;color:${INK};">
        Hello ${esc(name || 'there')},
      </p>
      <p class="cs-text" style="margin:0 0 16px 0;font-family:${FONT_STACK};font-size:15px;line-height:1.6;color:${INK};">
        If you sign the same kind of contract every week — NDAs, intake forms,
        invoices, vendor agreements, retainers — there is a tip that pays for
        itself the second time you upload one.
      </p>
      <p class="cs-text" style="margin:0 0 16px 0;font-family:${FONT_STACK};font-size:15px;line-height:1.6;color:${INK};">
        After CyberSygn detects the fields, click <strong>Save as template</strong> in the
        preview sidebar. Every future upload of that exact PDF auto-loads the
        saved fields at 100% confidence. No second detection. No second review.
        Pure muscle memory.
      </p>
      ${ctaButton({ url: preview, label: 'Save your first template →' })}
      <p class="cs-text" style="margin:16px 0 0 0;font-family:${FONT_STACK};font-size:14px;line-height:1.55;color:${INK};">
        One contract, one template, infinite repeat sends. The way every signing
        tool should work and somehow none of them do.
      </p>
      <hr class="cs-rule" style="border:0;border-top:1px solid ${LINE};margin:24px 0 16px 0;" />
      <p class="cs-muted" style="margin:0;font-family:${FONT_STACK};font-size:12px;line-height:1.55;color:${MUTED};">
        Nathan, founder. <a href="${esc(url)}" style="color:${CYAN};">cybersygn.io</a>
      </p>`,
  });
}

/**
 * Day 7. Conversion ask — Origin with FOMO + Solo as soft secondary.
 */
export function renderDripDay7Html({ name, url }) {
  const founding = `${url}/#founding`;
  const pricing = `${url}/#pricing`;
  return shell({
    preheader: 'One week in. Lock $9 for life with Origin.',
    body: `
      <h1 class="cs-title" style="margin:0 0 12px 0;font-family:${FONT_STACK};font-size:24px;line-height:1.2;font-weight:700;letter-spacing:-0.02em;color:${NAVY};">
        Origin rate is still open.
      </h1>
      <p class="cs-text" style="margin:0 0 12px 0;font-family:${FONT_STACK};font-size:15px;line-height:1.55;color:${INK};">
        Hello ${esc(name || 'there')},
      </p>
      <p class="cs-text" style="margin:0 0 16px 0;font-family:${FONT_STACK};font-size:15px;line-height:1.6;color:${INK};">
        A week ago you signed up for the Demo. If CyberSygn is the right tool for
        you, this is the right time to lock the founder rate before it closes
        for good.
      </p>
      <p class="cs-text" style="margin:0 0 16px 0;font-family:${FONT_STACK};font-size:15px;line-height:1.6;color:${INK};">
        <strong>Origin:</strong> $9/month, locked for the life of your account.
        100 spots, limited, never re-opens. Same product as Solo, $3 less every
        month forever, direct line to me, a vote on what we build next, and
        your name on the Origin wall when we ship it.
      </p>
      ${ctaButton({ url: founding, label: 'Claim an Origin spot →' })}
      <p class="cs-text" style="margin:16px 0 0 0;font-family:${FONT_STACK};font-size:14px;line-height:1.55;color:${INK};">
        If Origin is full or not your thing, <a href="${esc(pricing)}" style="color:${CYAN};">Solo is $12/month with no cap</a>.
      </p>
      <p class="cs-text" style="margin:16px 0 0 0;font-family:${FONT_STACK};font-size:14px;line-height:1.55;color:${INK};">
        Honest math: at $60/hour, Origin pays for itself the first time you
        avoid 9 minutes of placing fields by hand. Two contracts a month
        and the math is no longer interesting.
      </p>
      <hr class="cs-rule" style="border:0;border-top:1px solid ${LINE};margin:24px 0 16px 0;" />
      <p class="cs-muted" style="margin:0;font-family:${FONT_STACK};font-size:12px;line-height:1.55;color:${MUTED};">
        Nathan, founder. I read and reply to every email at
        <a href="mailto:nathan@cybersygn.io" style="color:${CYAN};">nathan@cybersygn.io</a>.
      </p>`,
  });
}

/**
 * Welcome-to-Origin email. Fires once when a founding number is
 * assigned by the webhook. Earned, personal, no upsell — they
 * already paid. The job of this email is to anchor the relationship.
 */
export function renderOriginWelcomeHtml({ name, foundingNumber, url }) {
  const num = String(foundingNumber).padStart(3, '0');
  const dashboard = `${url}/dashboard/`;
  const wall = `${url}/origin/`;
  const preview = `${url}/preview/`;
  return shell({
    preheader: `You are Origin member #${num}. \$9 for life, locked.`,
    body: `
      <p style="margin:0 0 4px 0;font-family:${FONT_STACK};font-size:12px;line-height:1.2;letter-spacing:0.14em;text-transform:uppercase;color:${CYAN};">
        Origin member.
      </p>
      <h1 class="cs-title" style="margin:0 0 16px 0;font-family:${FONT_STACK};font-size:32px;line-height:1.1;font-weight:700;letter-spacing:-0.025em;color:${NAVY};">
        Welcome. You are #${num}.
      </h1>
      <p class="cs-text" style="margin:0 0 16px 0;font-family:${FONT_STACK};font-size:15px;line-height:1.6;color:${INK};">
        Hello ${esc(name || 'there')},
      </p>
      <p class="cs-text" style="margin:0 0 16px 0;font-family:${FONT_STACK};font-size:15px;line-height:1.6;color:${INK};">
        That means $9 per month, locked for the life of your account, forever.
        A direct line to me. A vote on what we build next. And a permanent
        place on the public <a href="${esc(wall)}" style="color:${CYAN};">Origin wall</a>.
      </p>
      <p class="cs-text" style="margin:0 0 20px 0;font-family:${FONT_STACK};font-size:15px;line-height:1.6;color:${INK};">
        <strong>Two things to do in the next minute,</strong> if you want them:
      </p>
      <ol style="margin:0 0 20px 20px;padding:0;font-family:${FONT_STACK};font-size:15px;line-height:1.65;color:${INK};">
        <li style="margin-bottom:10px;">
          Open your <a href="${esc(dashboard)}" style="color:${CYAN};">dashboard</a> and find the Origin card.
          Set how your name and city appear on the wall — or leave it minimal.
          Whatever you prefer.
        </li>
        <li>
          Reply to this email and tell me what you sign and how often. Even
          one sentence helps me build the product around your use case.
        </li>
      </ol>
      ${ctaButton({ url: preview, label: 'Sign your first unlimited document →' })}
      <p class="cs-text" style="margin:16px 0 0 0;font-family:${FONT_STACK};font-size:14px;line-height:1.55;color:${INK};">
        Either way, you are set. The product is yours now. No upsells, no
        limits, no friction.
      </p>
      <hr class="cs-rule" style="border:0;border-top:1px solid ${LINE};margin:24px 0 16px 0;" />
      <p class="cs-muted" style="margin:0;font-family:${FONT_STACK};font-size:12px;line-height:1.6;color:${MUTED};">
        Nathan, founder. <a href="mailto:nathan@cybersygn.io" style="color:${CYAN};">nathan@cybersygn.io</a>.
        <br>
        Built in Colorado. Replies within a day, every day.
      </p>`,
  });
}
