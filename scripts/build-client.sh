#!/usr/bin/env bash
# Cross-builds printbetter into build/<version>/bin/<platform>/. Args: [macos] [linux] [windows].
set -euo pipefail
. "$(dirname "$0")/lib/common.sh"

platforms="${*:-macos linux windows}"
cd "$CLIENT_DIR"
out="${CARGO_TARGET_DIR:-$CLIENT_DIR/target}"

build_macos() {
  for target in aarch64-apple-darwin x86_64-apple-darwin; do
    say "building $target"
    # Xcode 27's strip corrupts chained-fixup Mach-O files (dyld: "mis-aligned LINKEDIT string pool"),
    # so the linker drops local symbols instead; scoped here so Linux/Windows builds are unaffected.
    MACOSX_DEPLOYMENT_TARGET=13.0 CARGO_PROFILE_RELEASE_STRIP=none RUSTFLAGS="-C link-arg=-Wl,-x" \
      cargo build --release --locked -p printbetter --target "$target"
  done
  mkdir -p "$BIN_DIR/macos-universal"
  lipo -create -output "$BIN_DIR/macos-universal/printbetter" \
    "$out/aarch64-apple-darwin/release/printbetter" "$out/x86_64-apple-darwin/release/printbetter"
}

# target:platform:features (the Linux tray only makes sense on desktop-class hardware)
LINUX_SPECS="x86_64-unknown-linux-musl:linux-x86_64:tray-linux
aarch64-unknown-linux-musl:linux-aarch64:tray-linux
armv7-unknown-linux-musleabihf:linux-armv7:
arm-unknown-linux-musleabihf:linux-armv6:"

build_linux() {
  command -v cargo-zigbuild >/dev/null || die "cargo-zigbuild is required for Linux builds"
  echo "$LINUX_SPECS" | while IFS=: read -r target platform features; do
    say "building $target"
    if [ -n "$features" ]; then
      cargo zigbuild --release --locked -p printbetter --target "$target" --features "$features"
    else
      cargo zigbuild --release --locked -p printbetter --target "$target"
    fi
    mkdir -p "$BIN_DIR/$platform"
    cp "$out/$target/release/printbetter" "$BIN_DIR/$platform/printbetter"
  done
}

build_windows() {
  command -v cargo-zigbuild >/dev/null || die "cargo-zigbuild is required for Windows builds"
  for spec in x86_64-pc-windows-gnullvm:windows-x86_64 aarch64-pc-windows-gnullvm:windows-aarch64; do
    target="${spec%%:*}"
    platform="${spec##*:}"
    say "building $target"
    cargo zigbuild --release --locked -p printbetter --target "$target"
    mkdir -p "$BIN_DIR/$platform"
    cp "$out/$target/release/printbetter.exe" "$BIN_DIR/$platform/printbetter.exe"
    # Authenticode hook for when a certificate exists (osslsigncode, Azure Artifact Signing, ...).
    if [ -n "${WINDOWS_SIGN_CMD:-}" ]; then $WINDOWS_SIGN_CMD "$BIN_DIR/$platform/printbetter.exe"; fi
  done
}

for p in $platforms; do
  case "$p" in
    macos) build_macos ;;
    linux) build_linux ;;
    windows) build_windows ;;
    *) die "unknown platform: $p" ;;
  esac
done
say "binaries in $BIN_DIR"
