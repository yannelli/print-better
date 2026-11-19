#!/usr/bin/env bash
# Deploys the server (auto-provisions D1 + R2), migrates, creates missing secrets, prints the setup link.
set -euo pipefail
. "$(dirname "$0")/lib/common.sh"

cd "$SERVER_DIR"
wrangler whoami >/dev/null 2>&1 || die "not logged in: run 'pnpm --dir server exec wrangler login'"

say "installing and building"
pnpm install --frozen-lockfile
pnpm build

say "deploying worker"
log="$(mktemp)"
trap 'rm -f "$log"' EXIT
wrangler deploy | tee "$log"
url="$(grep -Eo 'https://[A-Za-z0-9.-]+\.workers\.dev' "$log" | head -n1 || true)"

say "applying database migrations"
wrangler d1 migrations apply DB --remote

say "checking secrets"
existing="$(wrangler secret list --format json 2>/dev/null || echo '[]')"
setup_token=""
for name in SETUP_TOKEN APP_SECRET AUTH_PEPPER; do
  if printf '%s' "$existing" | jq -e --arg n "$name" 'map(.name) | index($n)' >/dev/null; then
    continue
  fi
  value="$(openssl rand -base64 48 | tr -d '/+=\n' | cut -c1-48)"
  printf '%s' "$value" | wrangler secret put "$name" >/dev/null
  say "created secret $name"
  if [ "$name" = SETUP_TOKEN ]; then setup_token="$value"; fi
done

echo
if [ -n "$setup_token" ] && [ -n "$url" ]; then
  say "Open this link to create the first account (keep it private):"
  echo "    $url/setup?token=$setup_token"
elif [ -n "$url" ]; then
  say "Deployed to $url"
else
  say "Deployed. Find the URL with 'wrangler deployments list' or in the Cloudflare dashboard."
fi
echo "Client downloads: scripts/release.sh --publish remote"
