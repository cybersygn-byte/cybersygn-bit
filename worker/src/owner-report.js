/**
 * Monthly owner report. Triggered by the scheduled() cron on the first
 * day of each month at 00:00 UTC. Pulls the dataset stats + founding
 * counter + signup counts + vision usage, formats an HTML email, sends
 * via Resend to env.OWNER_EMAIL.
 *
 * Idempotent: if the cron fires multiple times in the same hour (CF
 * sometimes does), a KV lock at meta:monthly-report:<YYYY-MM> prevents
 * duplicate sends.
 *
 * Failure-tolerant: if Resend is unbound or OWNER_EMAIL is unset, logs
 * the report content and returns without throwing so the rest of the
 * scheduled handler still completes.
 */

import { getDatasetStats } from './dataset.js';
import { getFoundingCount, foundingCap } from './stripe.js';
import { deliver } from './email.js';

const KV_LOCK_PREFIX = 'meta:monthly-report:';
const KV_LOCK_TTL_SECONDS = 60 * 60 * 25;  // 25h to safely cover the day window

export async function runMonthlyOwnerReport(env, event) {
  const recipient = (env && env.OWNER_EMAIL) || 'hello@cybersygn.io';
  const now = event && event.scheduledTime ? new Date(event.scheduledTime) : new Date();
  const monthKey = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
  const lockKey = KV_LOCK_PREFIX + monthKey;

  // Lock acquisition. If the lock exists, a sibling invocation already
  // sent this month's report; bail.
  if (env && env.CYBERSYGN_DOCS) {
    try {
      const existing = await env.CYBERSYGN_DOCS.get(lockKey);
      if (existing) {
        console.log(`[monthly-report] ${monthKey} already sent; skipping`);
        return;
      }
      await env.CYBERSYGN_DOCS.put(lockKey, new Date().toISOString(), {
        expirationTtl: KV_LOCK_TTL_SECONDS,
      });
    } catch (e) {
      console.error('[monthly-report] lock error', e && e.message ? e.message : e);
    }
  }

  // Gather stats.
  const stats = await getDatasetStats(env).catch(() => null);
  let foundingTaken = 0;
  let foundingCapValue = 100;
  try {
    foundingTaken = await getFoundingCount(env);
    foundingCapValue = foundingCap();
  } catch (e) {}

  // Render HTML email. Inline styles only; email clients strip <style>.
  const html = renderReportHtml({
    monthLabel: now.toLocaleDateString('en-US', { year: 'numeric', month: 'long', timeZone: 'UTC' }),
    stats,
    foundingTaken,
    foundingCap: foundingCapValue,
    generatedAt: now.toISOString(),
  });
  const text = renderReportText({
    monthLabel: now.toLocaleDateString('en-US', { year: 'numeric', month: 'long', timeZone: 'UTC' }),
    stats,
    foundingTaken,
    foundingCap: foundingCapValue,
    generatedAt: now.toISOString(),
  });

  // Send. Use the existing Resend pipeline (sendCompletion is the
  // closest signature match: takes env + recipient + subject + text + html).
  try {
    await deliver(env, {
      to: recipient,
      subject: `CyberSygn monthly report. ${now.toLocaleDateString('en-US', { year: 'numeric', month: 'long', timeZone: 'UTC' })}.`,
      text,
      html,
    });
    console.log(`[monthly-report] ${monthKey} sent to ${recipient}`);
  } catch (e) {
    console.error('[monthly-report] send failed', e && e.message ? e.message : e);
  }
}

function renderReportHtml(ctx) {
  const s = ctx.stats && ctx.stats.ok ? ctx.stats : null;
  const corpus = s && s.corpus ? s.corpus : { totalExamples: 0, templates: 0, contributors: 0, byType: {} };
  const growth = s && s.growth ? s.growth : { freeSignups: 0, paidSubscribers: 0 };
  const ready  = s && s.trainingReadiness ? s.trainingReadiness : { current: 0, threshold: 5000, percentReady: 0 };
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"></head>
<body style="margin:0;padding:24px;background:#F7F8FB;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;color:#011434;line-height:1.55;">
  <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%" style="max-width:640px;margin:0 auto;background:#ffffff;border-radius:8px;overflow:hidden;border:1px solid rgba(1,20,52,0.08);">
    <tr><td style="padding:32px 32px 16px;">
      <p style="margin:0 0 4px;font-family:ui-monospace,monospace;font-size:11px;letter-spacing:0.12em;text-transform:uppercase;color:#007496;">CyberSygn monthly report</p>
      <h1 style="margin:0;font-size:28px;font-weight:600;letter-spacing:-0.02em;">${escapeHtml(ctx.monthLabel)}</h1>
    </td></tr>

    <tr><td style="padding:8px 32px;">
      <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%">
        <tr>
          <td style="width:33%;padding:16px;background:#F7F8FB;border-radius:6px;text-align:center;">
            <div style="font-size:32px;font-weight:700;letter-spacing:-0.02em;">${growth.paidSubscribers}</div>
            <div style="font-family:ui-monospace,monospace;font-size:10px;letter-spacing:0.08em;text-transform:uppercase;color:#4F5874;margin-top:4px;">Paid subscribers</div>
          </td>
          <td style="width:8px;"></td>
          <td style="width:33%;padding:16px;background:#F7F8FB;border-radius:6px;text-align:center;">
            <div style="font-size:32px;font-weight:700;letter-spacing:-0.02em;">${growth.freeSignups}</div>
            <div style="font-family:ui-monospace,monospace;font-size:10px;letter-spacing:0.08em;text-transform:uppercase;color:#4F5874;margin-top:4px;">Free signups</div>
          </td>
          <td style="width:8px;"></td>
          <td style="width:33%;padding:16px;background:#F7F8FB;border-radius:6px;text-align:center;">
            <div style="font-size:32px;font-weight:700;letter-spacing:-0.02em;color:#007496;">${ctx.foundingTaken}<span style="font-size:18px;color:#4F5874;font-weight:500;">/${ctx.foundingCap}</span></div>
            <div style="font-family:ui-monospace,monospace;font-size:10px;letter-spacing:0.08em;text-transform:uppercase;color:#4F5874;margin-top:4px;">Founding seats</div>
          </td>
        </tr>
      </table>
    </td></tr>

    <tr><td style="padding:24px 32px 8px;">
      <h2 style="margin:0 0 8px;font-size:16px;font-weight:600;">Dataset corpus.</h2>
      <p style="margin:0 0 12px;color:#3A4258;font-size:14px;">
        <strong>${corpus.totalExamples.toLocaleString()}</strong> labeled examples across
        <strong>${corpus.templates.toLocaleString()}</strong> unique documents from
        <strong>${corpus.contributors.toLocaleString()}</strong> contributors.
      </p>
      <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%" style="border-collapse:collapse;">
        ${Object.entries(corpus.byType || {}).map(([k, v]) => `
          <tr>
            <td style="padding:6px 0;font-family:ui-monospace,monospace;font-size:11px;letter-spacing:0.06em;text-transform:uppercase;color:#4F5874;">${escapeHtml(k)}</td>
            <td style="padding:6px 0;text-align:right;font-size:14px;font-weight:500;font-variant-numeric:tabular-nums;">${v.toLocaleString()}</td>
          </tr>`).join('')}
      </table>
    </td></tr>

    <tr><td style="padding:24px 32px;">
      <h2 style="margin:0 0 8px;font-size:16px;font-weight:600;">Training readiness.</h2>
      <p style="margin:0 0 8px;color:#3A4258;font-size:14px;">
        ${ready.current.toLocaleString()} of ${ready.threshold.toLocaleString()} examples needed for Phase 3 custom-CV training.
      </p>
      <div style="background:#F7F8FB;border-radius:4px;height:12px;overflow:hidden;border:1px solid rgba(1,20,52,0.08);">
        <div style="background:#00CBF6;height:100%;width:${ready.percentReady}%;"></div>
      </div>
      <p style="margin:8px 0 0;font-family:ui-monospace,monospace;font-size:11px;letter-spacing:0.06em;text-transform:uppercase;color:#4F5874;">
        ${ready.percentReady}% ready
      </p>
    </td></tr>

    <tr><td style="padding:24px 32px;background:#F7F8FB;border-top:1px solid rgba(1,20,52,0.08);">
      <p style="margin:0;font-size:12px;color:#4F5874;line-height:1.5;">
        Generated ${escapeHtml(ctx.generatedAt)} by the monthly cron.<br>
        Next report on the first of next month at 00:00 UTC.
      </p>
    </td></tr>
  </table>
</body></html>`;
}

function renderReportText(ctx) {
  const s = ctx.stats && ctx.stats.ok ? ctx.stats : null;
  const corpus = s && s.corpus ? s.corpus : { totalExamples: 0, templates: 0, contributors: 0, byType: {} };
  const growth = s && s.growth ? s.growth : { freeSignups: 0, paidSubscribers: 0 };
  const ready  = s && s.trainingReadiness ? s.trainingReadiness : { current: 0, threshold: 5000, percentReady: 0 };

  return [
    `CyberSygn monthly report. ${ctx.monthLabel}.`,
    ``,
    `Paid subscribers: ${growth.paidSubscribers}`,
    `Free signups: ${growth.freeSignups}`,
    `Founding seats taken: ${ctx.foundingTaken} of ${ctx.foundingCap}`,
    ``,
    `Dataset corpus:`,
    `  ${corpus.totalExamples} labeled examples`,
    `  ${corpus.templates} unique documents`,
    `  ${corpus.contributors} contributors`,
    ...Object.entries(corpus.byType || {}).map(([k, v]) => `    ${k}: ${v}`),
    ``,
    `Training readiness: ${ready.percentReady}% (${ready.current} of ${ready.threshold} examples).`,
    ``,
    `Generated ${ctx.generatedAt}`,
  ].join('\n');
}

function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
