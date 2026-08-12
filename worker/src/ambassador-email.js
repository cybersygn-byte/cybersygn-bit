/**
 * Ambassador lifecycle emails.
 *
 * Four sends, all on the existing email shell (email-html.js) and the existing
 * Resend delivery path (email.js). Nothing new was invented for transport.
 *
 * AT-MOST-ONCE. Every automated send to a real person claims its KV guard
 * BEFORE the send, never after. A duplicate email is worse than a missed one,
 * so a crash between claim and send loses that one message rather than looping.
 *
 * HONEST NUMBERS. Every figure comes from the ambassador record. There are no
 * projected earnings anywhere: we say what each sale paid, never what someone
 * "could" make.
 *
 *   you-are-live   once, on enrollment, with a SIGNED-IN dashboard link
 *   sale alert     per qualifying sale, with the milestone line when one hit
 *   weekly digest  ONLY to ambassadors with sales that week (quiet weeks send nothing)
 *   monthly        to every active ambassador, exactly ONE behavior-branched nudge
 */

import { deliver } from './email.js';

const GUARD = 'ambmail:';
const GUARD_TTL = 60 * 60 * 24 * 400;   // outlives a yearly cycle

function money(n) {
  const v = Number(n) || 0;
  return '$' + (Math.round(v * 100) / 100).toLocaleString('en-US', { maximumFractionDigits: 2 });
}

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/**
 * Claim a one-time guard. Returns true only if THIS call won the claim.
 * Claimed before every send, per Law 4.
 */
async function claimGuard(env, key) {
  if (!env || !env.CYBERSYGN_DOCS) return true;   // dev/test: do not block
  const k = GUARD + key;
  try {
    const seen = await env.CYBERSYGN_DOCS.get(k);
    if (seen) return false;
    await env.CYBERSYGN_DOCS.put(k, new Date().toISOString(), { expirationTtl: GUARD_TTL });
    return true;
  } catch (e) {
    // If KV is unreachable we cannot prove at-most-once, so we do NOT send.
    return false;
  }
}

/** Shared shell: reuses the product's email look through email-html.js. */
async function shellHtml({ preheader, body }) {
  const mod = await import('./email-html.js');
  // renderAmbassadorHtml is a thin wrapper over the same shell the rest of the
  // product uses, so ambassador mail cannot drift from the brand.
  return mod.renderAmbassadorHtml({ preheader, body });
}

// ---- 1. You are live ------------------------------------------------------

/**
 * Sent once when someone becomes an ambassador. Carries a SIGNED-IN dashboard
 * link: they just proved they own this email, so we do not make them do a
 * second round trip to read their own dashboard.
 */
export async function sendYouAreLive(env, { to, code, shareUrl, discount, signedInUrl, bounty }) {
  if (!to || !code) return { delivered: false, reason: 'missing_fields' };
  if (!await claimGuard(env, `live:${code}`)) return { delivered: false, reason: 'already_sent' };

  const subject = 'You are live. Here is your CyberSygn code.';
  const text = [
    'You are an ambassador now. Here is everything you need.',
    '',
    `Your code: ${code.toUpperCase()}`,
    `Your link: ${shareUrl}`,
    `Everyone who uses it gets ${discount}.`,
    `Every qualifying sale pays you ${money(bounty)}, and that rises as you go.`,
    '',
    'Open your dashboard (you are already signed in on this link):',
    signedInUrl,
    '',
    'One suggestion for today: run CyberSygn on one of your own contracts',
    'first. The pitch that works is "here is what it did for me".',
    '',
    'Reply to this email any time. It reaches me directly.',
    'CyberSygn',
  ].join('\n');

  const body =
    `<h1 class="cs-title">You are live.</h1>` +
    `<p class="cs-text">Here is your code, your link, and what each sale pays you.</p>` +
    `<div class="cs-kv"><span class="cs-kv-key">Your code</span><span class="cs-kv-val">${esc(code.toUpperCase())}</span></div>` +
    `<div class="cs-kv"><span class="cs-kv-key">Your link</span><span class="cs-kv-val">${esc(shareUrl)}</span></div>` +
    `<div class="cs-kv"><span class="cs-kv-key">They get</span><span class="cs-kv-val">${esc(discount)}</span></div>` +
    `<div class="cs-kv"><span class="cs-kv-key">You earn</span><span class="cs-kv-val">${esc(money(bounty))} per qualifying sale</span></div>` +
    `<p class="cs-text"><a href="${esc(signedInUrl)}">Open your dashboard</a>. You are already signed in on that link.</p>` +
    `<p class="cs-text">One suggestion for today: run CyberSygn on one of your own contracts first. The pitch that works is "here is what it did for me".</p>`;

  return deliver(env, { to, subject, text, html: await shellHtml({ preheader: 'Your code, your link, and what each sale pays.', body }) });
}

// ---- 2. Sale alert --------------------------------------------------------

/** Fires per qualifying sale. Guarded per conversion so a webhook retry cannot double-send. */
export async function sendSaleAlert(env, { to, code, guardKey, amount, bonuses, tierLabel, totalSales, dashUrl }) {
  if (!to) return { delivered: false, reason: 'missing_to' };
  if (!await claimGuard(env, `sale:${guardKey}`)) return { delivered: false, reason: 'already_sent' };

  const bonusLine = (bonuses && bonuses.length)
    ? `Includes a bonus for ${bonuses.join(' and ')}.`
    : '';
  const subject = `You earned ${money(amount)}.`;
  const text = [
    `Somebody bought through your link. You earned ${money(amount)}.`,
    bonusLine,
    '',
    `That is ${totalSales} ${totalSales === 1 ? 'sale' : 'sales'} so far, ${tierLabel} tier.`,
    '',
    dashUrl,
    '',
    'CyberSygn',
  ].filter(Boolean).join('\n');

  const body =
    `<h1 class="cs-title">You earned ${esc(money(amount))}.</h1>` +
    `<p class="cs-text">Somebody bought through your link.${bonusLine ? ' ' + esc(bonusLine) : ''}</p>` +
    `<div class="cs-kv"><span class="cs-kv-key">Sales so far</span><span class="cs-kv-val">${totalSales}</span></div>` +
    `<div class="cs-kv"><span class="cs-kv-key">Your tier</span><span class="cs-kv-val">${esc(tierLabel)}</span></div>` +
    `<p class="cs-text"><a href="${esc(dashUrl)}">See it on your dashboard</a>.</p>`;

  return deliver(env, { to, subject, text, html: await shellHtml({ preheader: `You earned ${money(amount)}.`, body }) });
}

// ---- 3. Weekly digest (only when there were sales) ------------------------

/**
 * Quiet weeks send NOTHING. An ambassador with no sales this week does not
 * need a weekly reminder that they had no sales this week.
 */
export async function sendWeeklyDigest(env, { to, code, weekKey, sales, earned, dashUrl }) {
  if (!to || !sales || sales < 1) return { delivered: false, reason: 'no_sales_this_week' };
  if (!await claimGuard(env, `weekly:${code}:${weekKey}`)) return { delivered: false, reason: 'already_sent' };

  const subject = `Your week: ${sales} ${sales === 1 ? 'sale' : 'sales'}, ${money(earned)}.`;
  const text = [
    `Good week. ${sales} ${sales === 1 ? 'sale' : 'sales'}, ${money(earned)} earned.`,
    '',
    dashUrl,
    '',
    'CyberSygn',
  ].join('\n');
  const body =
    `<h1 class="cs-title">Good week.</h1>` +
    `<div class="cs-kv"><span class="cs-kv-key">Sales</span><span class="cs-kv-val">${sales}</span></div>` +
    `<div class="cs-kv"><span class="cs-kv-key">Earned</span><span class="cs-kv-val">${esc(money(earned))}</span></div>` +
    `<p class="cs-text"><a href="${esc(dashUrl)}">Open your dashboard</a>.</p>`;

  return deliver(env, { to, subject, text, html: await shellHtml({ preheader: `${sales} sales, ${money(earned)}.`, body }) });
}

// ---- 4. Monthly scoreboard -----------------------------------------------

/**
 * Goes to every ACTIVE ambassador with exactly ONE nudge, branched on what
 * they actually did. Three branches, never more than one shown:
 *   no activity     -> a ready-to-send warm script with their code inside
 *   clicks, no sale -> the warm-send reframe plus a script
 *   sales           -> the lifetime-multiplier play plus next-tier distance
 */
export function monthlyNudge({ clicks, sales, code, shareUrl, nextTier, bounty }) {
  const CODE = String(code || '').toUpperCase();
  if (sales > 0) {
    const dist = nextTier
      ? `You are ${nextTier.salesRemaining} ${nextTier.salesRemaining === 1 ? 'sale' : 'sales'} from ${nextTier.label} tier, which pays ${Math.round(nextTier.mult*100-100)} percent more on every sale.`
      : `You are at the top tier.`;
    return {
      branch: 'has_sales',
      title: 'One play for this month',
      body: `The people who already bought through you are the best source of the next one. Ask the happiest one who else on their team sends contracts. ${dist}`,
      script: null,
    };
  }
  if (clicks > 0) {
    return {
      branch: 'clicks_no_sales',
      title: 'People are looking. Try one warm send.',
      body: 'Clicks mean the link works. Sales usually come from a message to one person you know, not from a post. Send this to a single person today.',
      script: `Hey, are you still emailing PDFs back and forth to get signed? I have been using CyberSygn and it finds every signature field for you in about 3 seconds. First one is free. My link gets you 20% off your first 3 months: ${shareUrl}`,
    };
  }
  return {
    branch: 'no_activity',
    title: 'Send this to one person today',
    body: 'Nothing has moved yet, and that is normal. One warm message beats ten posts. Copy this, pick one person, send it.',
    script: `Hey, are you still emailing PDFs back and forth to get signed? I have been using CyberSygn and it finds every signature field for you in about 3 seconds. First one is free. My link gets you 20% off your first 3 months (code ${CODE}): ${shareUrl}`,
  };
}

export async function sendMonthlyScoreboard(env, opts) {
  const { to, code, monthKey, clicks, sales, earned, earnedYtd, dashUrl, shareUrl, nextTier, bounty, redirectTo } = opts;
  const recipient = redirectTo || to;
  if (!recipient) return { delivered: false, reason: 'missing_to' };
  // In redirect (owner test) mode the guard is skipped so the owner can send
  // repeatedly, but the recipient is ALWAYS the owner, never the ambassador.
  if (!redirectTo && !await claimGuard(env, `monthly:${code}:${monthKey}`)) {
    return { delivered: false, reason: 'already_sent' };
  }

  const nudge = monthlyNudge({ clicks, sales, code, shareUrl, nextTier, bounty });
  const subject = `Your ${monthKey} scoreboard.`;
  const lines = [
    `Here is your month.`,
    '',
    `Clicks: ${clicks}`,
    `Sales: ${sales}`,
    `Earned this month: ${money(earned)}`,
    `Earned this year: ${money(earnedYtd)}`,
    '',
    nudge.title,
    nudge.body,
  ];
  if (nudge.script) lines.push('', nudge.script);
  lines.push('', dashUrl, '', 'CyberSygn');

  const body =
    `<h1 class="cs-title">Your ${esc(monthKey)} scoreboard.</h1>` +
    `<div class="cs-kv"><span class="cs-kv-key">Clicks</span><span class="cs-kv-val">${clicks}</span></div>` +
    `<div class="cs-kv"><span class="cs-kv-key">Sales</span><span class="cs-kv-val">${sales}</span></div>` +
    `<div class="cs-kv"><span class="cs-kv-key">Earned this month</span><span class="cs-kv-val">${esc(money(earned))}</span></div>` +
    `<div class="cs-kv"><span class="cs-kv-key">Earned this year</span><span class="cs-kv-val">${esc(money(earnedYtd))}</span></div>` +
    `<h2 class="cs-title" style="font-size:18px">${esc(nudge.title)}</h2>` +
    `<p class="cs-text">${esc(nudge.body)}</p>` +
    (nudge.script ? `<p class="cs-text" style="padding:12px;background:rgba(0,0,0,0.04);border-radius:8px">${esc(nudge.script)}</p>` : '') +
    `<p class="cs-text"><a href="${esc(dashUrl)}">Open your dashboard</a>.</p>` +
    (redirectTo ? `<p class="cs-muted">Test send. The real recipient would be ${esc(to || 'the ambassador')}.</p>` : '');

  const res = await deliver(env, {
    to: recipient,
    subject: redirectTo ? `[test] ${subject}` : subject,
    text: lines.join('\n'),
    html: await shellHtml({ preheader: `${sales} sales, ${money(earned)} this month.`, body }),
  });
  return { ...res, branch: nudge.branch, redirected: !!redirectTo };
}

// ---- Monthly + weekly runners --------------------------------------------

/**
 * Iterate every ambassador. KV list is bounded; a solo program will not have
 * thousands, and the cap keeps a runaway list from burning the cron budget.
 */
async function eachAmbassador(env, fn, cap = 500) {
  if (!env || !env.CYBERSYGN_DOCS) return 0;
  let cursor, seen = 0, pages = 0;
  while (seen < cap) {
    const page = await env.CYBERSYGN_DOCS.list({ prefix: 'affiliate:code:', limit: 100, cursor });
    for (const k of page.keys || []) {
      try {
        const raw = await env.CYBERSYGN_DOCS.get(k.name);
        if (!raw) continue;
        const rec = JSON.parse(raw);
        if (rec && rec.code) { await fn(rec); seen += 1; }
      } catch (e) {}
      if (seen >= cap) break;
    }
    pages += 1;
    if (page.list_complete || !page.cursor || pages > 10) break;
    cursor = page.cursor;
  }
  return seen;
}

/**
 * Monthly scoreboard to every ACTIVE ambassador. Runs on the 1st.
 * redirectTo (owner test mode) forces every send to the owner instead.
 */
export async function runMonthlyScoreboard(env, { redirectTo, limit } = {}) {
  const [{ tierFor, TIERS: LADDER, payoutFor }, { passActive }] = await Promise.all([
    import('./affiliate.js'), import('./ambassador.js'),
  ]);
  const base = (env && env.CYBERSYGN_APP_URL) || 'https://cybersygn.io';
  const now = new Date();
  // Report on the month that just ENDED.
  const prev = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
  const monthKey = prev.toISOString().slice(0, 7);
  const year = String(now.getUTCFullYear());
  const out = { monthKey, considered: 0, sent: 0, skipped: 0, branches: {}, errors: [] };

  await eachAmbassador(env, async (rec) => {
    out.considered += 1;
    if (rec.status === 'revoked' || (!redirectTo && !passActive(rec))) { out.skipped += 1; return; }
    if (!rec.email) { out.skipped += 1; return; }

    const monthly = (rec.monthly && rec.monthly.month === monthKey) ? rec.monthly : { sales: 0 };
    const sales = Number(monthly.sales) || 0;
    // Real money from the ledger, never a bounty times a count.
    const monthEarned = (rec.ledger || [])
      .filter(e => String(e.at || '').startsWith(monthKey))
      .reduce((s2, e) => s2 + (Number(e.amount) || 0), 0);
    const tier = tierFor(rec.conversions || 0);
    const nextTier = LADDER.find(t => t.min > (rec.conversions || 0)) || null;
    const earnedYtd = ((rec.ledger || [])
      .filter(e => String(e.at || '').startsWith(year))
      .reduce((s, e) => s + (Number(e.amount) || 0), 0)) || (rec.earnedUsd || 0);

    try {
      const r = await sendMonthlyScoreboard(env, {
        to: rec.email,
        code: rec.code,
        monthKey,
        clicks: Number(rec.clicks) || 0,
        sales,
        earned: monthEarned,
        earnedYtd,
        dashUrl: `${base}/ambassador/`,
        shareUrl: `${base}/?ref=${rec.code}`,
        nextTier: nextTier ? { label: nextTier.label, mult: nextTier.mult, salesRemaining: nextTier.min - (rec.conversions || 0) } : null,
        bounty: payoutFor('pro', rec.conversions || 0),
        redirectTo,
      });
      if (r && r.delivered) {
        out.sent += 1;
        out.branches[r.branch] = (out.branches[r.branch] || 0) + 1;
      } else { out.skipped += 1; }
    } catch (e) { out.errors.push(String(e && e.message).slice(0, 120)); }
  }, limit || 500);

  return out;
}

/** Weekly digest sweep. Sends ONLY to ambassadors with sales this week. */
export async function runWeeklyDigest(env, { redirectTo } = {}) {
  const base = (env && env.CYBERSYGN_APP_URL) || 'https://cybersygn.io';
  const now = new Date();
  const weekKey = `${now.getUTCFullYear()}-w${Math.ceil((((now - new Date(Date.UTC(now.getUTCFullYear(), 0, 1))) / 86400000) + 1) / 7)}`;
  const since = Date.now() - 7 * 24 * 60 * 60 * 1000;
  const out = { weekKey, sent: 0, quiet: 0 };

  await eachAmbassador(env, async (rec) => {
    const week = (rec.ledger || []).filter(e => Date.parse(e.at || 0) >= since);
    // ONE SALE CAN WRITE THREE ENTRIES (bounty, milestone, sprint) and a
    // reversal writes negative ones, so counting entries reported a single sale
    // as three and a refund week as new sales. Count bounty entries only.
    const sales = week.filter(e => e && e.type === 'bounty' && Number(e.amount) > 0).length;
    if (!sales || !rec.email) { out.quiet += 1; return; }
    // Earnings still sum EVERY entry, including negatives, so a week with a
    // refund reports the true net rather than an inflated gross.
    const earned = Math.round(week.reduce((s, e) => s + (Number(e.amount) || 0), 0) * 100) / 100;
    const r = await sendWeeklyDigest(env, {
      to: redirectTo || rec.email,
      code: rec.code, weekKey, sales, earned,
      dashUrl: `${base}/ambassador/`,
    });
    if (r && r.delivered) out.sent += 1;
  });
  return out;
}
