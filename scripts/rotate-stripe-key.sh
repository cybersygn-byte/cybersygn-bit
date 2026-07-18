#!/usr/bin/env bash
# Rotate the Worker's Stripe secret key from your macOS clipboard, deploy, and
# verify the live service. The key is read from the clipboard, so it never
# appears in the command line or shell history.
#
# Use it:
#   1. Stripe Dashboard -> Developers -> API keys -> reveal the live "Secret
#      key" and copy it (Cmd+C).
#   2. Run:  bash scripts/rotate-stripe-key.sh
set -uo pipefail
cd "$(dirname "$0")/.."

KEY="$(pbpaste | tr -d '[:space:]')"
if [[ ! "$KEY" =~ ^sk_(live|test)_[A-Za-z0-9]+$ ]]; then
  echo "Your clipboard does not look like a Stripe secret key."
  echo "Copy the live Secret key from Stripe (Developers -> API keys), then re-run this."
  exit 1
fi

echo "Setting STRIPE_SECRET_KEY on the Worker (value hidden, from clipboard)..."
printf '%s' "$KEY" | npx wrangler secret put STRIPE_SECRET_KEY || { echo "secret put failed"; exit 1; }

echo "Deploying..."
npx wrangler deploy || { echo "deploy failed"; exit 1; }

echo ""
echo "Verifying Stripe on the live service..."
sleep 3
STRIPE_LINE="$(curl -s https://cybersygn.io/api/health | grep -o '"stripe":[^}]*}' || true)"
echo "  $STRIPE_LINE"
if echo "$STRIPE_LINE" | grep -q '"ok":true'; then
  echo ""
  echo "SUCCESS. Payments are live again. Try a checkout on cybersygn.io/#pricing."
else
  echo ""
  echo "Stripe still not healthy. Double-check you copied the CURRENT (not rolled/expired) live Secret key, then re-run."
fi
