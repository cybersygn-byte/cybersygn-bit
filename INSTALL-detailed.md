# Deploy CyberSygn in 15 minutes.

You will not touch a terminal. You will not edit any code. You will click the button, paste three secrets, and connect a domain. Everything else is automatic.

## What you need first.

| Thing | Where to get it | Cost |
|---|---|---|
| A Cloudflare account | https://dash.cloudflare.com/sign-up | Free |
| A GitHub account | https://github.com/join | Free |
| The domain `cybersygn.io` | Any registrar (Cloudflare Registrar is easiest) | ~$10/year |
| A Resend account | https://resend.com/signup | Free (100 emails/day) |

Have all four open in browser tabs before you start.

---

## Step 1. Click the Deploy button.

In the CyberSygn GitHub repository, click the button labeled **Deploy to Cloudflare**.

A Cloudflare dashboard page opens. It will ask you to:

1. **Authorize GitHub.** Click the button, log into GitHub, allow Cloudflare to create a repo on your behalf. Cloudflare clones the CyberSygn source into a new repo on your GitHub account so future updates auto-deploy.
2. **Name the project.** Default is `cybersygn`. Keep it.
3. **Click Deploy.**

Cloudflare now:
- Creates two KV namespaces (`CYBERSYGN_DOCS` and `CYBERSYGN_PDFS`) automatically. You do not create these manually.
- Runs the build command (`npm install && npm run vendor && npm run build`) to assemble the static site.
- Deploys the Worker to `cybersygn-<random>.workers.dev`.

This takes about 90 seconds. When it finishes, click the workers.dev URL. The CyberSygn marketing page loads. The signing tool works at `/preview/`. The dashboard works at `/dashboard/`. **You are live on a Cloudflare URL.** No domain yet, no email yet, but the app is running.

Test:
- Click around the marketing page. Toggle the moon/sun in the masthead.
- Open `/preview/`, drop any PDF on it, watch detection light up the fields.

If anything looks wrong here, stop and tell me what you see. Don't proceed to the next step.

---

## Step 2. Set three secrets in the Cloudflare dashboard.

In the Cloudflare dashboard, open **Workers & Pages** → click `cybersygn` → **Settings** → **Variables and Secrets** → **Add variable**. For each of the three secrets below, set **Type = Secret**, paste the value, click **Save**.

### Secret 1: `CYBERSYGN_APP_URL`

**Value:** `https://cybersygn.io`

(This is the public URL where magic-link emails will point. If you haven't connected the domain yet, paste the workers.dev URL from Step 1 temporarily. You'll update this after Step 4.)

### Secret 2: `CYBERSYGN_OWNER_HASH`

This is the SHA-256 hash of a private phrase only you know. You don't need to run any commands. Use this web tool:

1. Open https://emn178.github.io/online-tools/sha256.html
2. Type your private phrase (e.g. `nathan-cybersygn-master-2026`). Make it something you'll remember.
3. Copy the 64-character hex result.

**Value:** the 64-character hex.

**Save your plaintext phrase in 1Password / Bitwarden / your password manager.** You'll need it to activate owner mode in the browser later. Never type the plaintext into Cloudflare.

### Secret 3: `RESEND_API_KEY`

You'll create this in Step 3.

---

## Step 3. Set up Resend for email.

Sign in at https://resend.com.

1. Click **Domains** → **Add Domain** → enter `cybersygn.io` → click **Add**.
2. Resend shows you a list of DNS records. **Click "Sign in to Cloudflare"** at the top of that page. Authorize, pick `cybersygn.io` from the dropdown, click **Add records**. Resend writes the SPF, DKIM, and DMARC records into Cloudflare for you automatically. No copy-pasting.
3. Wait 1 to 5 minutes. Click **Verify DNS Records**. All three checks should turn green.
4. Once verified, click **API Keys** in the left sidebar → **Create API Key** → name it `cybersygn-production` → permissions: **Sending access**, domain: `cybersygn.io` → **Create**.
5. Copy the key (starts with `re_`). **You will not see it again.**
6. Back in the Cloudflare dashboard tab from Step 2: add the third secret.

**Name:** `RESEND_API_KEY`
**Value:** the `re_...` key.
**Type:** Secret. Click Save.

(Optional fourth secret: `CYBERSYGN_FROM` = `CyberSygn <hello@cybersygn.io>` if you want a custom From address.)

After saving, in the Cloudflare dashboard, click **Deployments** → **Retry deployment** on the latest build. The Worker restarts with the new secrets baked in.

---

## Step 4. Connect the cybersygn.io domain.

Before this works, `cybersygn.io` must be on Cloudflare DNS.

- **If you bought it at Cloudflare Registrar**, it's already a zone in your account. Skip to the substeps below.
- **If you bought it elsewhere**: in the Cloudflare dashboard, click **+ Add a site** in the top-right, enter `cybersygn.io`, pick the **Free** plan, follow the prompts. Cloudflare gives you two nameservers. Log into your registrar (Namecheap, GoDaddy, etc.), find the nameserver setting, paste in Cloudflare's two nameservers, save. Wait 10 to 60 minutes for the change to propagate. You'll get an email from Cloudflare when the domain is active.

Once the domain is active on Cloudflare DNS:

1. **Workers & Pages** → click `cybersygn` → **Settings** → **Domains & Routes** → **+ Add** → **Custom domain**.
2. Enter `cybersygn.io`. Click **Add domain**. Cloudflare creates the DNS record and provisions an SSL certificate. Takes 30 to 90 seconds.
3. Click **+ Add** again, enter `www.cybersygn.io`, **Add domain**.

Visit `https://cybersygn.io`. The marketing page loads on your custom domain with a valid SSL certificate. Now go back to **Variables and Secrets** and update `CYBERSYGN_APP_URL` from the workers.dev URL to `https://cybersygn.io` if you used the temporary value earlier. Save, retry the deployment.

---

## Step 5. Activate owner mode.

In your browser, visit `https://cybersygn.io/?owner=YOUR_PRIVATE_PHRASE` (replace with the actual phrase from Step 2). The Owner pill appears in the top-right of the masthead. Done. The pill persists across page loads in this browser; the phrase never appears in the URL bar after the first navigation.

---

## You are now live. Set and forget.

Future updates: any time the CyberSygn GitHub repository on your account gets a push to `main`, Cloudflare automatically runs the build, deploys it, and pushes to production. You don't have to lift a finger.

To make changes to the code, you can either:
- Edit files directly in the GitHub web UI (click any file, click the pencil icon, commit). Cloudflare auto-deploys on commit.
- Or clone the repo locally and push.

Neither requires touching Wrangler or the terminal.

---

## How to check things are healthy.

- `https://cybersygn.io/api/status` should return JSON with `"ok":true,"service":"cybersygn"`.
- In the Cloudflare dashboard, **Workers & Pages** → `cybersygn` → **Logs** shows live request logs.
- In the dashboard, **Metrics** shows request volume and error rate.

If any request errors, Cloudflare's logs will show the cause. You don't need to run any commands to diagnose.

---

## Things I cannot do for you.

- **Buy the domain.** That's you, at any registrar.
- **Sign up for Cloudflare or GitHub or Resend.** Those are your accounts.
- **Generate the owner-hash secret.** Use the SHA-256 web tool linked in Step 2.

Everything else is automated.

---

## If something breaks.

Tell me exactly what you see. The dashboard error, the URL that misbehaves, the log line. I will diagnose and ship a fix as a one-line commit to the repo, which auto-deploys.

That's the whole point of this setup: bugs become commits, commits become deploys, deploys become live, all without you ever opening a terminal.
