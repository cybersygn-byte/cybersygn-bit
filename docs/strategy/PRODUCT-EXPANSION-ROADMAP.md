# Product expansion roadmap (slice 101)

Five scaffolds queued behind paying-customer signal. Build when there's data demanding it, not before.

## 1. Custom signing domain (`sign.yourfirm.com`)

**Tier:** Studio + Lifetime
**Signal threshold:** First Studio customer asks for it
**Effort:** 2–3 days

**Approach:**
- Customer configures `sign.theirfirm.com` CNAME → `cybersygn.io` (or A-record to Cloudflare).
- Worker reads `Host` header on every request. If it matches a configured `custom-domain:<host>` KV record, set `req.brandedSender = senderId`.
- Magic-link emails generate URLs against `sign.theirfirm.com` instead of `cybersygn.io/preview/?doc=`.
- TLS via Cloudflare Origin Cert or SaaS (Custom Hostnames API).

**KV shape:**
```
custom-domain:sign.theirfirm.com → { senderId, addedAt, verifiedAt }
```

**Endpoint stubs (not yet wired):**
- POST `/api/sender/:id/custom-domain` — add a domain
- GET  `/api/sender/:id/custom-domain` — list configured
- DELETE `/api/sender/:id/custom-domain/:host` — remove

## 2. Templates marketplace

**Tier:** Free + paid (free to browse, gated by send-allowance)
**Signal threshold:** 50+ public templates accumulated
**Effort:** 4–6 days

**Approach:**
- `/templates/` browseable index of public templates (already exists per-doc via `tpl:` KV records).
- Add categorization metadata: industry, doc-type, popularity.
- Click → preview the template, click "Use this" → opens `/preview/` with template loaded.
- Templates can be authored (Studio) or curated (CyberSygn).
- Search via Cloudflare Vectorize for semantic search ("photography release for clients under 18").

**KV shape (extends existing tpl: records):**
```
tpl:<docId> already has fields; add: { tags, category, author, useCount, rating }
```

## 3. White-label

**Tier:** New "Agency" tier ($199/mo) or per-customer surcharge
**Signal threshold:** First agency reaches out
**Effort:** 1 week

**Approach:**
- Extends custom branding (slice 90) to remove "Powered by CyberSygn" from signing pages.
- White-label senders configure their own footer, audit cert masthead, email-from address (requires DKIM delegation).
- Resellers get a multi-customer dashboard at `/agency/`.

**KV shape:**
```
agency:<agencyId> → { name, members[], hideViralFooter: true, ... }
```

## 4. SSO for Studio teams

**Tier:** Studio
**Signal threshold:** Studio customer asks "can we use Google sign-in?"
**Effort:** 2–4 days

**Approach:**
- Google + Microsoft OAuth via Cloudflare Workers OAuth helper or raw OAuth flow.
- Customer enters their Workspace domain → we redirect to Google with `hd=<domain>` parameter.
- Returning users skip the magic-link email; their email is verified via OIDC instead.
- Existing senderId-localStorage model degrades gracefully — SSO returns the same senderId.

**Library:** `cloudflare-oauth` or hand-rolled with PKCE.

## 5. AI signer suggestion

**Tier:** Solo + above
**Signal threshold:** Free-tier corpus accumulates 1000 docs of repeat patterns
**Effort:** 3–5 days

**Approach:**
- When a sender uploads a contract they've sent before (matching SHA-256), check the historical signer list and pre-fill the signers panel.
- For first-time uploads, run a Vision pass: "this looks like the kind of contract usually signed by [client + lawyer + witness] — should I add those slots?"
- LLM call is expensive (~$0.01 per analysis); gate by tier and by usage cap.

**Endpoints (stubbed):**
- POST `/api/detect-signers` — accepts PDF, returns suggested signer roles + counts
- Backs to `worker/src/vision.js` with a different prompt template

---

## Build order

When you have 5 paying customers and 200 signups: pick whichever ONE is most-requested.

When you have 25 paying customers: build the second one.

Don't build any of these before that.
