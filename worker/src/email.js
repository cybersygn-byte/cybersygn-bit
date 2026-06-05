/**
 * CyberSygn email abstraction.
 *
 * Production uses Resend (https://resend.com), chosen because it
 * delivers transactional mail with a one-line API and reasonable
 * deliverability defaults.
 *
 * Dev (no RESEND_API_KEY) prints the would-have-sent message to the
 * Worker log so we can see exactly what each signer is about to
 * receive, and so that a developer running wrangler dev can copy magic
 * links out of the log without having a real email account configured.
 *
 * The API surface is intentionally tiny:
 *   sendInvite(env, { to, name, docTitle, magicLink })
 *   sendCompletion(env, { to, name, docTitle, downloadUrl })
 *
 * Both return { delivered: bool, mode: 'resend' | 'console', id?, error? }.
 */

import {
  renderInviteHtml,
  renderReminderHtml,
  renderCompletionHtml,
  renderDripDay1Html,
  renderDripDay3Html,
  renderDripDay7Html,
  renderOriginWelcomeHtml,
} from './email-html.js';

const FROM_DEFAULT = 'CyberSygn <hello@cybersygn.io>';
const REPLY_TO_DEFAULT = 'hello@cybersygn.io';

export async function sendInvite(env, { to, name, docTitle, magicLink, senderName }) {
  const subject = `${senderName || 'A CyberSygn sender'} needs your signature on ${docTitle || 'a document'}.`;
  const text = [
    `${name || 'Hello'},`,
    '',
    `${senderName || 'Someone'} sent you a document to sign on CyberSygn.`,
    docTitle ? `Document: ${docTitle}` : '',
    '',
    'Open the link below to review and sign. You do not need an account.',
    magicLink,
    '',
    'This link is unique to you. Do not forward it; anyone with the link can sign as you.',
    '',
    'CyberSygn. The signature tool you\'ll actually like. Built in Colorado.',
  ].filter(Boolean).join('\n');
  const html = renderInviteHtml({ name, senderName, docTitle, magicLink });

  return deliver(env, { to, subject, text, html });
}

export async function sendCompletion(env, { to, name, docTitle, downloadUrl, auditUrl, notice }) {
  // `notice: true` means this recipient was CC'd by the sender — they
  // didn't sign anything, they're notice-only. Copy adjusts to make
  // that distinction clear so the CC doesn't think someone forged their
  // signature on a document they never saw before.
  const subject = notice
    ? `For your records: ${docTitle || 'CyberSygn document'} has been signed.`
    : `Signed: ${docTitle || 'CyberSygn document'}.`;
  const opener = notice
    ? 'You were CC\'d on this signing. Every signer has completed their part, and the signed document is below for your records.'
    : 'Every signer has completed their part. The signed document is ready.';
  const text = [
    `${name || 'Hello'},`,
    '',
    opener,
    '',
    `Download: ${downloadUrl}`,
    auditUrl ? `Audit certificate: ${auditUrl}` : '',
    '',
    'The audit certificate is a one-page PDF listing every signer, every',
    'event, and the SHA-256 of the document. Keep it with the signed PDF',
    'as proof of who signed what and when.',
    '',
    'CyberSygn.',
  ].filter(Boolean).join('\n');
  const html = renderCompletionHtml({ name, docTitle, downloadUrl, auditUrl, notice });

  return deliver(env, { to, subject, text, html });
}

/**
 * Reminder email for a signer who has not yet completed.
 *
 *   tone:
 *     'first'  | gentle nudge, used by manual remind and the 24h cron
 *     'second' | slightly firmer, used by the 72h cron
 *     'final'  | last call, used by the 7-day cron before doc expires
 *
 * The copy stays in CyberSygn's voice: factual, never wheedling.
 */
export async function sendReminder(env, { to, name, docTitle, magicLink, senderName, tone }) {
  const t = tone || 'first';
  const subject = t === 'final'
    ? `Final reminder: ${docTitle || 'CyberSygn document'} still needs your signature.`
    : t === 'second'
    ? `Still waiting: ${docTitle || 'CyberSygn document'}.`
    : `Reminder: ${docTitle || 'CyberSygn document'} is waiting for you.`;

  const opening = t === 'final'
    ? `This is the last reminder we will send. After today the link expires and ${senderName || 'the sender'} will need to issue a new one.`
    : t === 'second'
    ? `It has been a few days. ${senderName || 'The sender'} is still waiting on your signature.`
    : `${senderName || 'A CyberSygn sender'} is waiting for you to sign.`;

  const text = [
    `${name || 'Hello'},`,
    '',
    opening,
    docTitle ? `Document: ${docTitle}` : '',
    '',
    'Open the link below to review and sign. You do not need an account.',
    magicLink,
    '',
    'This link is unique to you. Do not forward it.',
    '',
    'CyberSygn.',
  ].filter(Boolean).join('\n');
  const html = renderReminderHtml({ name, senderName, docTitle, magicLink, tone: t });

  return deliver(env, { to, subject, text, html });
}

/**
 * Notify the sender that a signer has declined to sign. Plain text +
 * optional reason; no signing link (nothing to nudge them with — the
 * sender has to issue a fresh doc to a different signer).
 */
export async function deliverDeclineNotice(env, { to, senderName, signerName, signerEmail, docTitle, reason, dashUrl }) {
  const subject = `${signerName || 'A signer'} declined to sign ${docTitle ? `"${docTitle}"` : 'your document'}.`;
  const text = [
    `${senderName || 'Hello'},`,
    '',
    `${signerName || 'The signer'} ${signerEmail ? `(${signerEmail}) ` : ''}declined to sign your document${docTitle ? ` "${docTitle}"` : ''}.`,
    reason ? '' : null,
    reason ? `Reason given: ${reason}` : null,
    '',
    'No further reminders will be sent. To proceed, send a fresh document',
    'to a different signer or update the terms and re-send.',
    '',
    dashUrl ? `Open your dashboard: ${dashUrl}` : '',
    '',
    'CyberSygn.',
  ].filter(x => x !== null).filter(x => x !== '' || x === '').join('\n');
  return deliver(env, { to, subject, text });
}

/**
 * Snapshot email send. Attaches the flattened PDF and a short note.
 * Used by the /api/snapshot/email endpoint for direct PDF-to-CC sharing
 * outside the signing flow.
 */
export async function deliverSnapshot(env, { to, senderName, senderEmailDisplay, filename, pdfBase64, note }) {
  const subject = `${senderName || 'A CyberSygn user'} shared a signed document: ${filename}`;
  const text = [
    'Hello,',
    '',
    `${senderName || 'A CyberSygn user'}${senderEmailDisplay ? ` (${senderEmailDisplay})` : ''} sent you a signed document.`,
    '',
    note ? `Note: ${note}` : '',
    '',
    `The document is attached as ${filename}.`,
    '',
    'CyberSygn.',
  ].filter(Boolean).join('\n');
  return deliver(env, {
    to,
    subject,
    text,
    attachments: [{ filename, content: pdfBase64 }],
  });
}

/**
 * Drip day 1 — welcome + activation nudge.
 * Sent 24 hours after free signup. No selling, pure value: show the
 * one thing they need to do first to unlock the magic moment. The
 * reciprocity primer for later asks.
 */
export async function sendDripDay1(env, { to, name, appUrl }) {
  const url = appUrl || 'https://cybersygn.io';
  const subject = `${name || 'Welcome'} — your first contract in 3 seconds.`;
  const text = [
    `${name || 'Hello'},`,
    '',
    'Yesterday you signed up for CyberSygn. Three free documents, no card.',
    'Today, here is the one thing that makes the product worth the email:',
    '',
    'Drop a contract PDF on the preview page. Watch every signature line,',
    'initial, date, and checkbox appear automatically in about 3 seconds.',
    'No dragging. No box placement. No 30-minute DocuSign ritual.',
    '',
    `Try it now: ${url}/preview/`,
    '',
    'That is the whole pitch. The rest of the email is silence.',
    '',
    'Nathan',
    'Founder, CyberSygn',
    `${url}`,
  ].join('\n');
  const html = renderDripDay1Html({ name, url });
  return deliver(env, { to, subject, text, html });
}

/**
 * Drip day 3 — templates tip. The lock-in mechanic.
 * Sent 72 hours after signup. The user has probably tried the product
 * once by now. Teach them the lock-in feature (templates) — it gives
 * them a reason to come back, and creates switching cost over time.
 */
export async function sendDripDay3(env, { to, name, appUrl }) {
  const url = appUrl || 'https://cybersygn.io';
  const subject = `Quick tip: stop re-detecting the same PDF.`;
  const text = [
    `${name || 'Hello'},`,
    '',
    'If you sign the same kind of contract every week — NDAs, intake forms,',
    'invoices, vendor agreements, retainers — there is a tip that pays for',
    'itself the second time you upload one.',
    '',
    'After CyberSygn detects the fields, click "Save as template" in the',
    'preview sidebar. Every future upload of that exact PDF auto-loads the',
    'saved fields at 100% confidence. No second detection. No second review.',
    'Pure muscle memory.',
    '',
    `Save your first template: ${url}/preview/`,
    '',
    'One contract, one template, infinite repeat sends. The way every',
    'signing tool should work and somehow none of them do.',
    '',
    'Nathan',
    'Founder, CyberSygn',
  ].join('\n');
  const html = renderDripDay3Html({ name, url });
  return deliver(env, { to, subject, text, html });
}

/**
 * Drip day 7 — conversion ask.
 * Sent 168 hours after signup. By now they have seen the product, used
 * it, maybe saved a template. They know what they are choosing between.
 * Origin is the FOMO play; Solo is the soft-sell secondary.
 */
export async function sendDripDay7(env, { to, name, appUrl }) {
  const url = appUrl || 'https://cybersygn.io';
  const subject = `One week in. Origin rate is still open.`;
  const text = [
    `${name || 'Hello'},`,
    '',
    'A week ago you signed up for the Demo. If CyberSygn is the right tool',
    'for you, this is the right time to lock the founder rate before it',
    'closes for good.',
    '',
    'Origin: $9/month, locked for the life of your account. 100 spots,',
    'limited, never re-opens. You get the same product as Solo at the same',
    'features, $3 less every month, forever. Plus a direct line to me, a',
    'vote on what we build next, and your name on the Origin wall when we',
    'ship it.',
    '',
    `Claim a Origin spot: ${url}/#founding`,
    '',
    'If Origin is full or not your thing, Solo is $12/month with no cap.',
    '',
    `See pricing: ${url}/#pricing`,
    '',
    'Honest math: at $60/hour, Origin pays for itself the first time you',
    'avoid 9 minutes of dragging boxes in DocuSign. Two contracts a month',
    'and the math is no longer interesting.',
    '',
    'Nathan',
    'Founder, CyberSygn',
    'I read and reply to every email at nathan@cybersygn.io.',
  ].join('\n');
  const html = renderDripDay7Html({ name, url });
  return deliver(env, { to, subject, text, html });
}

/**
 * Welcome-to-Origin email. Fires once per founding subscription when
 * the foundingNumber gets assigned (via Stripe webhook). Calibrated to
 * the magnitude of what just happened: someone made a 5-year+ economic
 * commitment to the product. The email should feel earned, personal,
 * and confident — not promotional.
 */
export async function sendOriginWelcome(env, { to, name, foundingNumber, appUrl }) {
  const url = appUrl || 'https://cybersygn.io';
  const numLabel = String(foundingNumber).padStart(3, '0');
  const subject = `Welcome to the Origin — you are #${numLabel}.`;
  const text = [
    `${name || 'Hello'},`,
    '',
    `You are Origin member #${numLabel}.`,
    '',
    'That means: $9 per month, locked for the life of your account, forever.',
    'A direct line to me. A vote on what we build next. A permanent place on',
    `the public Origin wall at ${url}/origin/`,
    '',
    'Two things to do in the next minute, if you want them:',
    '',
    `1. Open your dashboard at ${url}/dashboard/ and find the Origin card.`,
    '   You can set how your name and city appear on the wall — or leave it',
    '   minimal. Whatever you prefer.',
    '',
    `2. Reply to this email and tell me what you sign and how often. Even one`,
    '   sentence helps me build the product around your actual use case.',
    '',
    `Either way, you are set. Sign documents at ${url}/preview/ — unlimited,`,
    'no friction, no upsell. The product is yours now.',
    '',
    'Nathan',
    'Founder, CyberSygn',
    'nathan@cybersygn.io',
  ].join('\n');
  const html = renderOriginWelcomeHtml({ name, foundingNumber, url });
  return deliver(env, { to, subject, text, html });
}

export async function deliver(env, { to, subject, text, html, attachments }) {
  const apiKey = env && env.RESEND_API_KEY;
  if (!apiKey) {
    // Console fallback: print the would-have-sent message.
    console.log('[cybersygn:email:dev]', JSON.stringify({ to, subject, text, hasHtml: !!html }, null, 2));
    return { delivered: true, mode: 'console' };
  }

  // Resend accepts both text and html; clients render HTML when present and
  // fall through to text on text-only clients. We always send both.
  const resendBody = {
    from: env.CYBERSYGN_FROM || FROM_DEFAULT,
    reply_to: env.CYBERSYGN_REPLY_TO || REPLY_TO_DEFAULT,
    to: [to],
    subject,
    text,
  };
  if (html) resendBody.html = html;
  if (Array.isArray(attachments) && attachments.length > 0) {
    // Resend attachments shape: [{ filename, content }] where content is
    // a base64 string (their API decodes it server-side). Cap at 20 MB
    // each — Resend's documented limit is 40 MB total per request and
    // single-attachment failures fall back to plain text.
    resendBody.attachments = attachments
      .filter(a => a && typeof a.filename === 'string' && typeof a.content === 'string')
      .map(a => ({ filename: a.filename, content: a.content }));
  }
  const body = JSON.stringify(resendBody);
  const headers = {
    'Authorization': `Bearer ${apiKey}`,
    'Content-Type': 'application/json',
  };

  // One attempt + one retry (2 total). Retry on network errors, timeouts,
  // and 5xx responses; do NOT retry on 4xx (those mean the request itself
  // is malformed and a retry will not change the outcome). The 10-second
  // timeout exists because Cloudflare Workers cap CPU per invocation;
  // hanging on a slow Resend call could blow the budget for the entire
  // cron sweep.
  const TIMEOUT_MS = 10_000;
  let lastError = '';

  for (let attempt = 0; attempt < 2; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      const res = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers,
        body,
        signal: controller.signal,
      });
      if (res.ok) {
        const data = await res.json().catch(() => ({}));
        return { delivered: true, mode: 'resend', id: data.id };
      }
      const detail = await res.text().catch(() => '');
      lastError = `Resend ${res.status}: ${detail.slice(0, 200)}`;
      if (res.status < 500) {
        // 4xx: client error. No point retrying.
        return { delivered: false, mode: 'resend', error: lastError };
      }
      // 5xx: fall through to retry.
    } catch (err) {
      lastError = err && err.name === 'AbortError'
        ? `Resend request timed out after ${TIMEOUT_MS}ms`
        : String(err && err.message || err);
      // Network / abort: fall through to retry.
    } finally {
      clearTimeout(timer);
    }
  }

  return { delivered: false, mode: 'resend', error: lastError };
}
