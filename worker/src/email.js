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
    'CyberSygn. The signature tool engineers actually like.',
  ].filter(Boolean).join('\n');

  return deliver(env, { to, subject, text });
}

export async function sendCompletion(env, { to, name, docTitle, downloadUrl, auditUrl }) {
  const subject = `Signed: ${docTitle || 'CyberSygn document'}.`;
  const text = [
    `${name || 'Hello'},`,
    '',
    'Every signer has completed their part. The signed document is ready.',
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

  return deliver(env, { to, subject, text });
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

  return deliver(env, { to, subject, text });
}

async function deliver(env, { to, subject, text }) {
  const apiKey = env && env.RESEND_API_KEY;
  if (!apiKey) {
    // Console fallback: print the would-have-sent message.
    console.log('[cybersygn:email:dev]', JSON.stringify({ to, subject, text }, null, 2));
    return { delivered: true, mode: 'console' };
  }

  const body = JSON.stringify({
    from: env.CYBERSYGN_FROM || FROM_DEFAULT,
    reply_to: env.CYBERSYGN_REPLY_TO || REPLY_TO_DEFAULT,
    to: [to],
    subject,
    text,
  });
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
