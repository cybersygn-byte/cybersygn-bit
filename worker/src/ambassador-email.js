/**
 * Ambassador lifecycle emails.
 *
 * Four sends, all on the existing email shell (email-html.js) and the existing
 * Resend delivery path (email.js). Nothing new was invented for transport.
 *
 * AT-MOST-ONCE, AS CLOSE AS KV GETS. Every automated send to a real person
 * claims its KV guard BEFORE the send, never after. A duplicate email is worse
 * than a missed one, so a crash between claim and send loses that one message
 * rather than looping. The claim is get-then-put plus a nonce read-back, not a
 * true compare-and-set; see claimGuard for what that does and does not cover.
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
  const v = Math.round((Number(n) || 0) * 100) / 100;
  // The minus sign belongs OUTSIDE the dollar sign. Formatting the signed
  // number put it inside, and a real cron run produced the subject line
  // "Your week: 1 sale, $-20."
  return (v < 0 ? '-$' : '$') + Math.abs(v).toLocaleString('en-US', { maximumFractionDigits: 2 });
}

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/**
 * Claim a one-time guard. Returns 'claimed' only if THIS call won the claim,
 * 'already_sent' if another run holds it, 'guard_unavailable' if KV would not
 * answer. Claimed before every send, per Law 4.
 *
 * NOT ATOMIC, and this comment is the honest version. KV has no
 * compare-and-set, so get-then-put has a window where two cron fires both read
 * an empty key and both claim. The write-then-confirm below closes the half of
 * that window we can close: after writing our own random nonce we read the key
 * back, and if someone else's nonce is sitting there we stand down. What it
 * cannot cover is the read-back returning null or a stale miss (KV caches
 * lookups, including misses, for up to a minute), and in that case we proceed,
 * which is exactly today's behavior and no worse. Real at-most-once needs a
 * Durable Object; until there is one, this is a narrowed race, not a solved one.
 */
async function claimGuard(env, key) {
  if (!env || !env.CYBERSYGN_DOCS) return 'claimed';   // dev/test: do not block
  const k = GUARD + key;
  const nonce = `${Date.now().toString(36)}.${Math.random().toString(36).slice(2, 12)}`;
  try {
    const seen = await env.CYBERSYGN_DOCS.get(k);
    if (seen) return 'already_sent';
    await env.CYBERSYGN_DOCS.put(k, JSON.stringify({ at: new Date().toISOString(), nonce }),
      { expirationTtl: GUARD_TTL });
    const back = await env.CYBERSYGN_DOCS.get(k);
    if (back) {
      let winner = null;
      try { winner = JSON.parse(back).nonce; } catch (e) { /* legacy timestamp value */ }
      if (winner && winner !== nonce) return 'already_sent';
    }
    return 'claimed';
  } catch (e) {
    // If KV is unreachable we cannot prove at-most-once, so we do NOT send.
    return 'guard_unavailable';
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
  const claim = await claimGuard(env, `live:${code}`);
  if (claim !== 'claimed') return { delivered: false, reason: claim };

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
  const claim = await claimGuard(env, `sale:${guardKey}`);
  if (claim !== 'claimed') return { delivered: false, reason: claim };

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
 *
 * A week can hold a sale AND a clawback: a refund or a chargeback on an older
 * sale writes a negative ledger entry dated today, so the net for the window
 * can be zero or below. That week is not a "Good week" and saying so was a
 * false claim, so the copy branches on the net instead of assuming it is up.
 */
export async function sendWeeklyDigest(env, { to, code, weekKey, sales, earned, reversed, dashUrl, redirectTo }) {
  const recipient = redirectTo || to;
  if (!recipient || !sales || sales < 1) return { delivered: false, reason: 'no_sales_this_week' };
  // In redirect (owner test) mode the guard is skipped so the owner can send
  // repeatedly. Claiming it would burn the REAL ambassador's weekly guard and
  // silently suppress the digest they were owed. Mirrors sendMonthlyScoreboard.
  if (!redirectTo) {
    const claim = await claimGuard(env, `weekly:${code}:${weekKey}`);
    if (claim !== 'claimed') return { delivered: false, reason: claim };
  }

  const saleWord = sales === 1 ? 'sale' : 'sales';
  const net = Math.round((Number(earned) || 0) * 100) / 100;
  const clawedBack = Math.abs(Math.round((Number(reversed) || 0) * 100) / 100);
  const up = net > 0;

  const subject = up
    ? `Your week: ${sales} ${saleWord}, ${money(net)}.`
    : `Your week: ${sales} ${saleWord}, and a reversal.`;
  const headline = up ? 'Good week.' : 'A sale, and a reversal.';
  const explain = up
    ? ''
    : `You made ${sales} ${saleWord} this week. A refund or chargeback on an earlier sale`
      + `${clawedBack ? ` clawed back ${money(clawedBack)}` : ' was also clawed back'}`
      + `, so the week nets ${money(net)}. Nothing is owed back to us; it comes off the running total.`;

  const text = [
    up ? `Good week. ${sales} ${saleWord}, ${money(net)} earned.` : `${headline} ${explain}`,
    '',
    dashUrl,
    '',
    'CyberSygn',
  ].join('\n');
  const body =
    `<h1 class="cs-title">${esc(headline)}</h1>` +
    (explain ? `<p class="cs-text">${esc(explain)}</p>` : '') +
    `<div class="cs-kv"><span class="cs-kv-key">Sales</span><span class="cs-kv-val">${sales}</span></div>` +
    `<div class="cs-kv"><span class="cs-kv-key">${up ? 'Earned' : 'Net for the week'}</span><span class="cs-kv-val">${esc(money(net))}</span></div>` +
    `<p class="cs-text"><a href="${esc(dashUrl)}">Open your dashboard</a>.</p>` +
    (redirectTo ? `<p class="cs-muted">Test send. The real recipient would be ${esc(to || 'the ambassador')}.</p>` : '');

  return deliver(env, {
    to: recipient,
    subject: redirectTo ? `[test] ${subject}` : subject,
    text,
    html: await shellHtml({ preheader: `${sales} ${saleWord}, ${money(net)}.`, body }),
  });
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
  if (!redirectTo) {
    const claim = await claimGuard(env, `monthly:${code}:${monthKey}`);
    if (claim !== 'claimed') return { delivered: false, reason: claim };
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
      } else {
        out.skipped += 1;
        // A KV outage during the guard claim is not a skip. Reporting it as
        // one made a total email outage read exactly like a quiet, healthy run.
        if (r && r.reason === 'guard_unavailable') out.errors.push(`guard_unavailable:${rec.code}`);
      }
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
  const out = { weekKey, sent: 0, quiet: 0, errors: [] };

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
    // What came back off the total, so the copy can name the number instead of
    // leaving the reader to work out why a week with a sale went backwards.
    const reversed = Math.round(week.reduce((s, e) => s + Math.min(0, Number(e.amount) || 0), 0) * 100) / 100;
    const r = await sendWeeklyDigest(env, {
      to: rec.email,
      code: rec.code, weekKey, sales, earned, reversed,
      dashUrl: `${base}/ambassador/`,
      // Threaded through, so a test send never claims the real guard.
      redirectTo,
    });
    if (r && r.delivered) out.sent += 1;
    else if (r && r.reason === 'guard_unavailable') out.errors.push(`guard_unavailable:${rec.code}`);
  });
  return out;
}
