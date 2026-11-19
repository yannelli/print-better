#!/bin/sh
# Print Better installer (POSIX sh). Re-running upgrades in place and keeps the existing pairing.
set -eu

PB_ORIGIN='__PB_ORIGIN__'
TOKEN=''
NAME=''
SYSTEM=0
NO_TRAY=0
VERSION=''

say() { printf 'print-better: %s\n' "$*"; }
die() {
  printf 'print-better: error: %s\n' "$*" >&2
  exit 1
}
need() { command -v "$1" >/dev/null 2>&1 || die "this installer needs '$1'"; }

usage() {
  cat <<EOF
Usage: curl -fsSL $PB_ORIGIN/install.sh | sh -s -- [options]
  --token TOKEN    pair with this server using a pbe_ enrollment token
  --name NAME      device name shown in Print Better
  --system         install a system service (root); implies --no-tray
  --no-tray        no menu bar or tray icon
  --version V      install a specific version instead of the latest
EOF
}

value() {
  [ $# -ge 2 ] || die "$1 needs a value"
  printf '%s' "$2"
}

while [ $# -gt 0 ]; do
  case "$1" in
    --token) TOKEN=$(value "$@"); shift 2 ;;
    --token=*) TOKEN=${1#*=}; shift ;;
    --name) NAME=$(value "$@"); shift 2 ;;
    --name=*) NAME=${1#*=}; shift ;;
    --version) VERSION=$(value "$@"); shift 2 ;;
    --version=*) VERSION=${1#*=}; shift ;;
    --system) SYSTEM=1; shift ;;
    --no-tray) NO_TRAY=1; shift ;;
    -h | --help) usage; exit 0 ;;
    *) die "unknown option: $1 (see --help)" ;;
  esac
done

need curl
need uname
OS=$(uname -s)
ARCH=$(uname -m)

case "$OS" in
  Darwin) PLATFORM=macos-universal ;;
  Linux)
    # The userland picks the build, not the kernel: 64-bit Pi kernels often run a 32-bit armhf userland.
    USERLAND=$ARCH
    if command -v dpkg >/dev/null 2>&1; then USERLAND=$(dpkg --print-architecture 2>/dev/null || echo "$ARCH"); fi
    case "$USERLAND" in
      amd64 | x86_64) PLATFORM=linux-x86_64 ;;
      arm64 | aarch64)
        if [ "$(getconf LONG_BIT 2>/dev/null || echo 64)" = 32 ]; then PLATFORM=linux-armv7; else PLATFORM=linux-aarch64; fi ;;
      armhf | armv7* | armv8l) PLATFORM=linux-armv7 ;;
      armv6*) PLATFORM=linux-armv6 ;;
      *) die "unsupported CPU architecture: $USERLAND" ;;
    esac
    # Raspberry Pi OS ships one armhf userland for every Pi, so ARMv6 boards (Zero, 1) need a CPU check.
    if [ "$PLATFORM" = linux-armv7 ] && { [ "$ARCH" = armv6l ] || grep -qiE 'ARMv6|ARM1176|^CPU part[[:space:]]*:[[:space:]]*0xb76' /proc/cpuinfo 2>/dev/null; }; then
      PLATFORM=linux-armv6
    fi
    if [ "$(id -u)" -eq 0 ] || { [ -z "${DISPLAY:-}" ] && [ -z "${WAYLAND_DISPLAY:-}" ]; }; then
      SYSTEM=1
    fi ;;
  *) die "unsupported operating system: $OS (on Windows use install.ps1)" ;;
esac
if [ "$SYSTEM" -eq 1 ]; then NO_TRAY=1; fi

SUDO=0
if [ "$SYSTEM" -eq 1 ] && [ "$(id -u)" -ne 0 ]; then
  command -v sudo >/dev/null 2>&1 || die "a system install needs root: re-run as root or install sudo"
  SUDO=1
fi
privileged() {
  if [ "$SUDO" -eq 1 ]; then sudo "$@"; else "$@"; fi
}

sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | cut -d' ' -f1
  elif command -v shasum >/dev/null 2>&1; then shasum -a 256 "$1" | cut -d' ' -f1
  elif command -v openssl >/dev/null 2>&1; then openssl dgst -sha256 "$1" | sed 's/^.*= *//'
  else die "no SHA-256 tool found (sha256sum, shasum or openssl)"
  fi
}

json_field() {
  printf '%s' "$1" | sed -n "s/.*\"$2\"[[:space:]]*:[[:space:]]*\"\\([^\"]*\\)\".*/\\1/p"
}

if [ -n "$VERSION" ]; then MANIFEST_URL="$PB_ORIGIN/dl/$VERSION/manifest.json"; else MANIFEST_URL="$PB_ORIGIN/dl/latest.json"; fi
MANIFEST=$(curl -fsSL --retry 3 "$MANIFEST_URL") || die "could not download $MANIFEST_URL"
MANIFEST=$(printf '%s' "$MANIFEST" | tr -d '\r\n')
ENTRY=$(printf '%s' "$MANIFEST" | sed -n "s/.*\"$PLATFORM\"[[:space:]]*:[[:space:]]*{\\([^}]*\\)}.*/\\1/p")
[ -n "$ENTRY" ] || die "this release has no build for $PLATFORM"
RELEASE=$(json_field "$MANIFEST" version)
FILE=$(json_field "$ENTRY" name)
SUM=$(json_field "$ENTRY" sha256 | tr 'A-F' 'a-f')
case "$FILE" in '' | */* | *..*) die "the release manifest is malformed" ;; esac
[ ${#SUM} -eq 64 ] || die "the release manifest has no valid checksum for $PLATFORM"

TMP=$(mktemp -d 2>/dev/null || mktemp -d -t printbetter)
trap 'rm -rf "$TMP"' EXIT INT TERM
say "downloading Print Better $RELEASE for $PLATFORM"
curl -fL --retry 3 --progress-bar -o "$TMP/$FILE" "$PB_ORIGIN/dl/$RELEASE/$FILE" || die "download failed"
[ "$(sha256_of "$TMP/$FILE")" = "$SUM" ] || die "download failed verification (SHA-256 mismatch)"

if [ "$OS" = Darwin ]; then
  APP="$HOME/Applications/Print Better.app"
  BIN="$APP/Contents/MacOS/printbetter"
  if [ -x "$BIN" ]; then privileged "$BIN" service stop >/dev/null 2>&1 || true; fi
  mkdir -p "$HOME/Applications" "$HOME/.local/bin" "$TMP/unpacked"
  ditto -x -k "$TMP/$FILE" "$TMP/unpacked" || die "could not unpack $FILE"
  [ -d "$TMP/unpacked/Print Better.app" ] || die "the archive does not contain Print Better.app"
  rm -rf "$APP"
  mv "$TMP/unpacked/Print Better.app" "$APP"
  ln -sf "$BIN" "$HOME/.local/bin/printbetter"
else
  need tar
  if [ "$SYSTEM" -eq 1 ]; then DEST=/usr/local/bin; else DEST="$HOME/.local/bin"; fi
  BIN="$DEST/printbetter"
  tar -xzf "$TMP/$FILE" -C "$TMP" || die "could not unpack $FILE"
  [ -f "$TMP/printbetter" ] || die "the archive does not contain printbetter"
  if [ -x "$BIN" ]; then privileged "$BIN" service stop >/dev/null 2>&1 || true; fi
  privileged mkdir -p "$DEST"
  privileged cp "$TMP/printbetter" "$BIN.new"
  privileged chmod 0755 "$BIN.new"
  privileged mv -f "$BIN.new" "$BIN"
fi
say "installed $BIN"

PAIRED=1
if [ -n "$TOKEN" ]; then
  set -- pair --server "$PB_ORIGIN" --token "$TOKEN"
  if [ -n "$NAME" ]; then set -- "$@" --name "$NAME"; fi
  # pair succeeds when already paired with this server, so a failure is real: finish the install, then exit non-zero.
  privileged "$BIN" "$@" || PAIRED=0
fi

set -- service install
if [ "$SYSTEM" -eq 1 ]; then set -- "$@" --system; fi
if [ "$NO_TRAY" -eq 1 ]; then set -- "$@" --no-tray; fi
privileged "$BIN" "$@" || die "could not install the background service"
privileged "$BIN" service start || die "could not start the background service"

case ":$PATH:" in
  *":$(dirname "$BIN"):"*) ;;
  *) say "add $(dirname "$BIN") to your PATH to use the printbetter command" ;;
esac
[ "$PAIRED" -eq 1 ] || die "Print Better $RELEASE is running but not paired (see the error above); re-run this command, or run: printbetter pair --server $PB_ORIGIN"
say "done: Print Better $RELEASE is running"
