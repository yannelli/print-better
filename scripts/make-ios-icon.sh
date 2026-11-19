#!/usr/bin/env bash
# Renders the iPhone app icon from ios/PrintBetter/AppIcon.svg and copies the brand mark into the app (macOS only).
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
mark="$ROOT_DIR/ios/PrintBetter/Assets.xcassets/BrandMark.imageset"
cp "$ROOT_DIR/docs/assets/print-better-logo.svg" "$mark/BrandMark.svg"
cp "$ROOT_DIR/docs/assets/print-better-logo-dark.svg" "$mark/BrandMark-dark.svg"
say "copied the brand mark into $mark"
