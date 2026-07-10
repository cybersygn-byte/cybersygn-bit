#!/usr/bin/env node
/**
 * Turnkey, idempotent creation of the six new CyberSygn Stripe prices
 * (Pro monthly + annual, Business monthly + annual, extra seat, white-label).
 *
 * These are the only launch blocker for the new pricing tiers: until the
 * price ids exist and are set as Worker secrets, Pro/Business/add-ons show
 * "opening soon" and their checkout degrades to the free funnel.
 *
 * Run (LIVE mode):
 *   STRIPE_SECRET_KEY=sk_live_... node scripts/setup-stripe-prices.mjs
 *
 * Idempotent: prices are keyed by a stable lookup_key, so re-running finds the
 * existing price and reuses its id instead of creating duplicates. It never
 * charges anyone; it only defines products and prices.
 *
 * Output: the price ids plus ready-to-run commands that set the matching
 * Worker secrets and redeploy.
 */

const KEY = process.env.STRIPE_SECRET_KEY;
if (!KEY || !/^sk_(live|test)_/.test(KEY)) {
  console.error('Set STRIPE_SECRET_KEY to your Stripe secret key first, e.g.:');
  console.error('  STRIPE_SECRET_KEY=sk_live_xxx node scripts/setup-stripe-prices.mjs');
  process.exit(1);
}
const MODE = KEY.startsWith('sk_live_') ? 'LIVE' : 'TEST';

// One product may carry two prices (monthly + annual). productName groups them.
const PLAN = [
  { env: 'STRIPE_PRICE_PRO',            productName: 'CyberSygn Pro',        tier: 'pro',        amount: 1900, interval: 'month', lookup: 'cybersygn_pro_monthly',        nickname: 'Pro monthly' },
  { env: 'STRIPE_PRICE_PRO_ANNUAL',     productName: 'CyberSygn Pro',        tier: 'pro',        amount: 18000, interval: 'year', lookup: 'cybersygn_pro_annual',         nickname: 'Pro annual (2 months free)' },
  { env: 'STRIPE_PRICE_BUSINESS',       productName: 'CyberSygn Business',   tier: 'business',   amount: 7900, interval: 'month', lookup: 'cybersygn_business_monthly',   nickname: 'Business monthly' },
  { env: 'STRIPE_PRICE_BUSINESS_ANNUAL',productName: 'CyberSygn Business',   tier: 'business',   amount: 78000, interval: 'year', lookup: 'cybersygn_business_annual',    nickname: 'Business annual (2 months free)' },
  { env: 'STRIPE_PRICE_SEAT',           productName: 'CyberSygn extra seat', tier: 'seat',       amount: 900,  interval: 'month', lookup: 'cybersygn_seat_monthly',       nickname: 'Extra seat' },
  { env: 'STRIPE_PRICE_WHITELABEL',     productName: 'CyberSygn white-label',tier: 'whitelabel', amount: 1900, interval: 'month', lookup: 'cybersygn_whitelabel_monthly', nickname: 'White-label' },
];

async function stripe(method, path, params) {
  const url = 'https://api.stripe.com/v1/' + path;
  const opts = {
    method,
    headers: {
      Authorization: 'Bearer ' + KEY,
      'Content-Type': 'application/x-www-form-urlencoded',
      'Stripe-Version': '2024-06-20',
    },
  };
  if (params) opts.body = new URLSearchParams(params).toString();
  const res = await fetch(url, opts);
  const json = await res.json();
  if (!res.ok) {
    throw new Error(`Stripe ${method} ${path} -> ${res.status}: ${json.error ? json.error.message : JSON.stringify(json)}`);
  }
  return json;
}

// Find an existing price by its stable lookup_key (active or not), expanding
// the product so we can reuse it for the sibling interval.
async function findPrice(lookup) {
  const q = new URLSearchParams({ limit: '1', 'lookup_keys[]': lookup, 'expand[]': 'data.product' });
  const list = await stripe('GET', 'prices?' + q.toString());
  return (list.data && list.data[0]) || null;
}

const productCache = new Map(); // productName -> product id

async function ensureProduct(name, tier) {
  if (productCache.has(name)) return productCache.get(name);
  // Reuse a product already attached to any sibling price we created this run.
  const created = await stripe('POST', 'products', {
    name,
    'metadata[app]': 'cybersygn',
    'metadata[tier]': tier,
  });
  productCache.set(name, created.id);
  return created.id;
}

async function main() {
  console.log(`\nCyberSygn Stripe price setup (${MODE} mode)\n`);
  const results = [];
  for (const p of PLAN) {
    let price = await findPrice(p.lookup);
    if (price) {
      const prodId = typeof price.product === 'string' ? price.product : price.product.id;
      productCache.set(p.productName, prodId);
      console.log(`  reuse  ${p.env.padEnd(28)} ${price.id}  (existing, ${p.nickname})`);
    } else {
      const productId = await ensureProduct(p.productName, p.tier);
      price = await stripe('POST', 'prices', {
        product: productId,
        unit_amount: String(p.amount),
        currency: 'usd',
        'recurring[interval]': p.interval,
        lookup_key: p.lookup,
        nickname: p.nickname,
        'metadata[app]': 'cybersygn',
        'metadata[tier]': p.tier,
      });
      console.log(`  create ${p.env.padEnd(28)} ${price.id}  (${p.nickname})`);
    }
    results.push({ env: p.env, id: price.id });
  }

  // Set the Worker secrets automatically (no copy-pasting six commands).
  // Falls back to printing the manual commands if wrangler is unavailable.
  console.log('\nSetting Worker secrets via wrangler...\n');
  const { execSync } = await import('node:child_process');
  let allSet = true;
  for (const r of results) {
    try {
      execSync(`npx wrangler secret put ${r.env}`, {
        input: r.id,
        stdio: ['pipe', 'ignore', 'pipe'],
        cwd: new URL('..', import.meta.url).pathname,
      });
      console.log(`  set    ${r.env.padEnd(28)} ${r.id}`);
    } catch (e) {
      allSet = false;
      console.log(`  FAILED ${r.env.padEnd(28)} run manually: echo ${r.id} | npx wrangler secret put ${r.env}`);
    }
  }
  if (allSet) {
    console.log('\nDeploying so the new secrets take effect...');
    try {
      execSync('npx wrangler deploy', {
        stdio: ['ignore', 'ignore', 'pipe'],
        cwd: new URL('..', import.meta.url).pathname,
      });
      console.log('Deployed.');
    } catch (e) {
      console.log('Deploy failed; run manually: npx wrangler deploy');
    }
  } else {
    console.log('\nSome secrets failed; run the printed commands, then: npx wrangler deploy');
  }
  console.log('\nConfirm all tiers flip to purchasable:');
  console.log('  curl -s https://cybersygn.io/api/billing/config\n');
  if (MODE === 'TEST') {
    console.log('NOTE: these are TEST-mode prices. Re-run with a sk_live_ key for production.\n');
  }
}

main().catch((err) => {
  console.error('\nSetup failed:', err.message);
  console.error('Nothing was charged. Fix the error above and re-run (it is idempotent).');
  process.exit(1);
});
