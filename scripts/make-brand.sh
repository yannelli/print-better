#!/usr/bin/env bash
# Renders the README hero (light and dark) and the social preview from docs/assets/brand (needs Google Chrome).
set -euo pipefail
. "$(dirname "$0")/lib/common.sh"

chrome="${CHROME:-/Applications/Google Chrome.app/Contents/MacOS/Google Chrome}"
[ -x "$chrome" ] || die "Google Chrome not found; set CHROME to its binary"
[ -d "$SERVER_DIR/node_modules/@fontsource-variable/geist" ] || die "fonts missing: run pnpm install in server/"
src="$ROOT_DIR/docs/assets/brand"
out="$ROOT_DIR/docs/assets"
profile="$(mktemp -d)"
trap 'rm -rf "$profile"' EXIT

# page, window size, device scale, output file
shot() {
  "$chrome" --headless=new --disable-gpu --hide-scrollbars --allow-file-access-from-files --user-data-dir="$profile" \
    --window-size="$2" --force-device-scale-factor="$3" --virtual-time-budget=3000 --screenshot="$out/$4" "file://$src/$1" >/dev/null 2>&1
  [ -s "$out/$4" ] || die "Chrome did not write $4"
  say "wrote docs/assets/$4"
}

shot hero.html 1600,560 1.5 hero.png
shot 'hero.html#dark' 1600,560 1.5 hero-dark.png
shot social.html 1280,640 1 social-preview.png
