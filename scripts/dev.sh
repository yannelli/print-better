#!/usr/bin/env bash
# Local dev: migrate the local D1, then run Vite (SPA + Worker + DO + R2 emulation) with server/.dev.vars.
set -euo pipefail
. "$(dirname "$0")/lib/common.sh"

cd "$SERVER_DIR"
[ -f .dev.vars ] || { cp .dev.vars.example .dev.vars; say "created server/.dev.vars from the example"; }
pnpm install
wrangler d1 migrations apply DB --local
exec pnpm dev "$@"
