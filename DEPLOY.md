# Deploy CyberSygn.

The hands-off install procedure is in [INSTALL.md](./INSTALL.md). One click, three secrets, one domain, fifteen minutes.

This file is intentionally short. There is no longer a wrangler-CLI deployment path. Cloudflare's Deploy button handles everything: it auto-provisions KV namespaces, runs the build, configures CI/CD on every push to main, and adds preview URLs to pull requests.

For local development without Cloudflare, the static site can be served by any HTTP server pointed at `web/dist/` after running `npm install && npm run vendor && npm run build`.
