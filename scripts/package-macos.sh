#!/usr/bin/env bash
# Signs + notarizes Print Better.app, then emits the install.sh zip and a signed pkg. See docs/release.md.
set -euo pipefail
. "$(dirname "$0")/lib/common.sh"
. "$(dirname "$0")/lib/notarize.sh"

notarize_enabled=1
[ "${1:-}" = "--no-notarize" ] && notarize_enabled=0

APP_IDENTITY="${APPLE_SIGNING_IDENTITY:-Developer ID Application}"
PKG_IDENTITY="${APPLE_INSTALLER_IDENTITY:-Developer ID Installer}"
PACKAGING="$CLIENT_DIR/packaging/macos"
binary="$BIN_DIR/macos-universal/printbetter"
[ -x "$binary" ] || die "missing $binary; run scripts/build-client.sh macos first"
[ -f "$PACKAGING/Info.plist" ] || die "missing $PACKAGING/Info.plist"

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
mkdir -p "$DIST_DIR"
app="$work/Print Better.app"

say "assembling $(basename "$app")"
mkdir -p "$app/Contents/MacOS" "$app/Contents/Resources"
cp "$binary" "$app/Contents/MacOS/printbetter"
# Fails fast if dyld rejects the binary (e.g. a toolchain that writes malformed Mach-O).
"$app/Contents/MacOS/printbetter" version >/dev/null || die "the packaged binary does not run"
cp "$PACKAGING/Info.plist" "$app/Contents/Info.plist"
plutil -replace CFBundleShortVersionString -string "$VERSION" "$app/Contents/Info.plist"
plutil -replace CFBundleVersion -string "${BUILD_NUMBER:-$VERSION}" "$app/Contents/Info.plist"
if [ -f "$PACKAGING/AppIcon.icns" ]; then cp "$PACKAGING/AppIcon.icns" "$app/Contents/Resources/"; fi

say "signing with $APP_IDENTITY"
entitlements=()
if [ -f "$PACKAGING/entitlements.plist" ]; then entitlements=(--entitlements "$PACKAGING/entitlements.plist"); fi
codesign --force --options runtime --timestamp "${entitlements[@]}" --sign "$APP_IDENTITY" "$app"
codesign --verify --strict --verbose=2 "$app"

if [ "$notarize_enabled" = 1 ]; then
  ditto -c -k --keepParent "$app" "$work/app.zip"
  notarize "$work/app.zip"
  xcrun stapler staple "$app"
fi
zip_out="$DIST_DIR/printbetter-$VERSION-macos-universal.zip"
ditto -c -k --keepParent "$app" "$zip_out"
say "wrote $zip_out"

say "building pkg"
mkdir -p "$work/root/Applications"
ditto "$app" "$work/root/Applications/Print Better.app"
pkgbuild --analyze --root "$work/root" "$work/components.plist" >/dev/null
# Installer would otherwise "relocate" the update onto any stray copy of the app it finds.
plutil -replace 0.BundleIsRelocatable -bool NO "$work/components.plist"
chmod 755 "$ROOT_DIR/scripts/macos/pkg-scripts/postinstall"
pkgbuild --root "$work/root" --component-plist "$work/components.plist" --install-location / \
  --scripts "$ROOT_DIR/scripts/macos/pkg-scripts" --identifier dev.yannelli.printbetter.pkg \
  --version "$VERSION" "$work/component.pkg"
pkg_out="$DIST_DIR/PrintBetter-$VERSION.pkg"
productbuild --package "$work/component.pkg" --sign "$PKG_IDENTITY" "$pkg_out"
if [ "$notarize_enabled" = 1 ]; then
  notarize "$pkg_out"
  xcrun stapler staple "$pkg_out"
fi
pkgutil --check-signature "$pkg_out" >/dev/null
say "wrote $pkg_out"
