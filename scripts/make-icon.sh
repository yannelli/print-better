#!/usr/bin/env bash
# Regenerates client/packaging/macos/AppIcon.icns from AppIcon.svg (macOS only; needs swift + iconutil).
set -euo pipefail
. "$(dirname "$0")/lib/common.sh"

src="$CLIENT_DIR/packaging/macos/AppIcon.svg"
out="$CLIENT_DIR/packaging/macos/AppIcon.icns"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
mkdir "$work/AppIcon.iconset"
swiftc -O -o "$work/render" "$ROOT_DIR/scripts/macos/render-svg.swift"
for size in 16 32 128 256 512; do
  "$work/render" "$src" "$work/AppIcon.iconset/icon_${size}x${size}.png" "$size"
  "$work/render" "$src" "$work/AppIcon.iconset/icon_${size}x${size}@2x.png" "$((size * 2))"
done
iconutil -c icns -o "$out" "$work/AppIcon.iconset"
say "wrote $out"
