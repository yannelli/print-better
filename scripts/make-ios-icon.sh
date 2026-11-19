#!/usr/bin/env bash
# Regenerates the iPhone app icon PNG from ios/PrintBetter/AppIcon.svg (macOS only; needs swift + sips).
set -euo pipefail
. "$(dirname "$0")/lib/common.sh"

src="$ROOT_DIR/ios/PrintBetter/AppIcon.svg"
out="$ROOT_DIR/ios/PrintBetter/Assets.xcassets/AppIcon.appiconset/AppIcon.png"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
swiftc -O -o "$work/render" "$ROOT_DIR/scripts/macos/render-svg.swift"
"$work/render" "$src" "$work/icon.png" 1024
# App Store Connect rejects an app icon with an alpha channel, so it goes through JPEG to drop it.
sips -s format jpeg -s formatOptions 100 "$work/icon.png" --out "$work/icon.jpg" >/dev/null
sips -s format png "$work/icon.jpg" --out "$out" >/dev/null
say "wrote $out"
