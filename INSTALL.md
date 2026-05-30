# Deploy CyberSygn.

You're going to click a button, sign in to three things you might already have accounts for, and paste some text into boxes. That's it. Fifteen minutes from start to finish, no code, no terminal, no commands to memorize.

## Before you start, open these in browser tabs.

1. The CyberSygn GitHub page (the URL you were given for your repo).
2. [https://cloudflare.com](https://cloudflare.com). If you don't have an account, sign up. Free.
3. [https://resend.com](https://resend.com). If you don't have an account, sign up. Free.
4. Wherever you bought `cybersygn.io` (Cloudflare Registrar, Namecheap, Porkbun, GoDaddy. Doesn't matter which). If you haven't bought it yet, do that first.

You'll also need a notepad app open to copy a few things into temporarily.

## About GitHub.

You will see GitHub during this process. **You will not have to learn it.** When you click the deploy button, Cloudflare logs into GitHub on your behalf, copies the CyberSygn code into a new repository on your account, and from that point forward Cloudflare handles everything. Think of GitHub as a folder where Cloudflare keeps the code. You will never need to open GitHub again after the first click unless you want to.

If you don't have a GitHub account, create one at [github.com](https://github.com). Pick any username. Free.

---

# The five things you'll do.

## 1. Click the button. (30 seconds)

In your CyberSygn GitHub page, you'll see a big blue button that says **Deploy to Cloudflare**. Click it.

A Cloudflare page opens. It asks if it can talk to GitHub. Click **Authorize**. Pick your GitHub account.

Cloudflare now does five things automatically:
- Makes a copy of CyberSygn in your GitHub account.
- Creates two storage buckets for documents and PDFs.
- Builds the website (this is where the fonts and detection libraries get pulled together).
- Deploys everything to a temporary URL ending in `.workers.dev`.
- Sets up automatic redeployments for any future changes.

This takes about 90 seconds. When the spinner stops, click the temporary URL Cloudflare gives you. The CyberSygn site loads. The signing tool works. **You're live.** Just not on cybersygn.io yet.

If you want to stop here and try things, do. Click around. Drop a PDF on the `/preview/` page. See detection light up the fields. The next steps add email, your custom domain, and your owner phrase.

## 2. Set up Resend for sending emails. (5 minutes)

Sign in at resend.com.

- Click **Domains** in the left sidebar.
- Click **Add Domain**.
- Type `cybersygn.io`.
- Click **Add**.

Resend will show you a list of three DNS records you need to add. **Don't copy them manually.** Look for a blue button at the top of that page that says **Sign in to Cloudflare**. Click it. Authorize. Pick `cybersygn.io` from the dropdown. Click **Add records**. Resend writes everything into Cloudflare for you.

Wait 2 to 5 minutes. Click **Verify DNS Records** at the top of Resend's page. The status changes to **Verified** with three green checkmarks.

Now:
- Click **API Keys** in the left sidebar.
- Click **Create API Key**.
- Name it: `cybersygn-production`
- Permissions: **Sending access**, domain: `cybersygn.io`
- Click **Create**.
- Copy the key. It starts with `re_` and is a long string of letters and numbers. Paste it into your notepad. You won't see it on Resend again.

## 3. Create your owner password. (2 minutes)

Pick a phrase only you know. Something like `nathan-runs-cybersygn-2026` or `my-cybersygn-master-key`. Anything you'll remember.

Now hash it (this turns your phrase into a different string Cloudflare can store safely):
- Open [https://emn178.github.io/online-tools/sha256.html](https://emn178.github.io/online-tools/sha256.html) in a new tab.
- Type your phrase into the input box.
- A 64-character string appears in the output box.
- Copy that 64-character string. Paste it into your notepad.

**Save your original phrase in 1Password, Bitwarden, or wherever you keep passwords. You'll need it later to unlock owner mode in your browser.**

## 4. Paste three secrets into Cloudflare. (3 minutes)

Open the Cloudflare dashboard at [dash.cloudflare.com](https://dash.cloudflare.com).

- Click **Workers & Pages** in the sidebar.
- Click **cybersygn** in the list.
- Click **Settings** at the top.
- Click **Variables and Secrets** in the left sidebar.
- Click **+ Add variable**.

For each of the three secrets below, choose **Type: Secret**, paste the value, click **Save**.

| Name | Value |
|---|---|
| `CYBERSYGN_APP_URL` | Paste the temporary `.workers.dev` URL from step 1, OR `https://cybersygn.io` if you've already done step 5 |
| `CYBERSYGN_OWNER_HASH` | The 64-character string from step 3 |
| `RESEND_API_KEY` | The `re_...` key from step 2 |

After adding all three, click **Deployments** at the top, then click the three dots next to your latest deployment and pick **Retry deployment**. This restarts the Worker with the secrets active. Takes 30 seconds.

## 5. Connect cybersygn.io to Cloudflare. (5 minutes)

If you bought your domain at Cloudflare Registrar, it's already connected. Skip to the next paragraph.

If you bought it elsewhere:
- In Cloudflare's dashboard, click **+ Add a site** in the top-right.
- Type `cybersygn.io`.
- Pick the **Free** plan.
- Cloudflare will show you two nameservers. Copy them.
- Open a new tab to your domain registrar (Namecheap, GoDaddy, etc.).
- Find the **Nameservers** setting for cybersygn.io. Usually under "Manage Domain" or similar.
- Replace whatever's there with the two Cloudflare nameservers.
- Save.
- Wait. Cloudflare emails you when the domain is active. Usually within an hour, sometimes within minutes.

Once your domain is on Cloudflare:
- Back in **Workers & Pages** → click **cybersygn** → **Settings** → **Domains & Routes** → **+ Add** → **Custom domain**.
- Type `cybersygn.io`. Click **Add domain**.
- Wait 30 to 90 seconds for the SSL certificate to provision.
- Click **+ Add** again, type `www.cybersygn.io`, click **Add domain**.

Visit `https://cybersygn.io` in your browser. The marketing page loads with a green padlock in the address bar. **You are live on your custom domain.**

If you used the temporary `.workers.dev` URL for `CYBERSYGN_APP_URL` in step 4, go back and change it to `https://cybersygn.io` now. Retry the deployment one more time.

---

# Unlock owner mode.

In your browser, go to `https://cybersygn.io/?owner=YOUR-ORIGINAL-PHRASE` (replace with the actual phrase from step 3). A small "Owner" pill appears in the top-right of the masthead. You can now close that tab. The unlock is remembered by your browser. You only have to do this once per browser.

---

# You're done. Welcome to set-and-forget.

Your daily life with CyberSygn now looks like this:

- **It just runs.** The signing tool works on cybersygn.io. Customers sign documents. Emails go out. Reminders trigger every hour. Audit certificates generate automatically.
- **You watch usage in one place.** Cloudflare dashboard → Workers & Pages → cybersygn → **Metrics**. Shows request volume, error rate, geography of users.
- **Email logs are at resend.com.** Shows every email that was sent.
- **Logs in real-time:** Cloudflare dashboard → cybersygn → **Logs**. Live stream of every request.

---

# When you want to change something.

You will sometimes want to change a price, edit some copy, or fix a typo.

The simplest way: open the file in GitHub's web editor. You don't need git installed. Steps:

1. Go to your GitHub repo for CyberSygn.
2. Find the file (for example, `web/index.html` for the homepage).
3. Click the file. Then click the small pencil icon in the top-right of the file viewer.
4. Edit the text.
5. Scroll to the bottom. Click **Commit changes**.
6. Cloudflare detects the change within seconds and rebuilds + redeploys automatically. About 90 seconds later, your change is live on cybersygn.io.

**You never install anything. You never run a command.** You edit text in a webpage and click a button.

---

# Things that go wrong, and what to do.

**Cloudflare build failed.** Click on the failed build in the Deployments tab. It shows the error log. Send me the last few lines and I'll diagnose.

**Emails aren't sending.** Check resend.com → **Logs**. If you see your emails listed but they show "bounced" or "complained," it's a recipient-side issue. If you see no emails at all, double-check that the `RESEND_API_KEY` secret is set in Cloudflare and that you retried the deployment after adding it.

**The site loads but the signing page is broken.** Open the browser developer console (F12, then click "Console"). If you see errors, screenshot them and send to me.

**I forgot my owner phrase.** You can change it: redo step 3 with a new phrase, paste the new hash into the `CYBERSYGN_OWNER_HASH` secret in Cloudflare, retry deployment. The old phrase stops working immediately. Your existing customer data is unaffected.

**I want to roll back to yesterday's version.** Cloudflare dashboard → cybersygn → **Deployments**. Find yesterday's deployment. Click the three dots → **Rollback**. Done in 10 seconds.

---

# The four accounts you ended up with.

| Account | What it does for you |
|---|---|
| **Cloudflare** | Hosts the site, runs the API, sends out emails (via Resend), stores documents, manages your domain's DNS, gives you live metrics. Your main dashboard. |
| **GitHub** | Stores the source code. You log in once during step 1 and never need to log in again unless you want to make a change. |
| **Resend** | Actually sends the emails. Cloudflare calls Resend behind the scenes. |
| **Your domain registrar** | Owns cybersygn.io. You only touch it during step 5 to point nameservers at Cloudflare. |

Three of the four are free. The domain is about $10/year. That's the entire ongoing cost of running CyberSygn until you cross the free-tier limits (Cloudflare Workers: 100,000 requests/day free; Resend: 100 emails/day, 3,000/month free).

---

# When you outgrow the free tier.

Cloudflare Workers paid plan is $5/month for 10 million requests. Resend paid plan is $20/month for 50,000 emails. Both bill by usage. You'll get email warnings well before you hit either limit.

---

# That's the entire deployment guide. Five steps, fifteen minutes, four accounts, one button. Set and forget.

If anything in here is unclear, screenshot what you're looking at and ask me. I will give you the exact click sequence.
