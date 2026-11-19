#!/usr/bin/env bash
# Shared helpers for release scripts. Bash 3.2 compatible (macOS /bin/bash).
# shellcheck disable=SC2034 # variables are consumed by the scripts that source this file

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
CLIENT_DIR="$ROOT_DIR/client"
SERVER_DIR="$ROOT_DIR/server"

say() { printf '\033[1m==>\033[0m %s\n' "$*"; }
die() { printf 'error: %s\n' "$*" >&2; exit 1; }

client_version() {
  sed -n '/^\[workspace.package\]/,/^\[/{s/^version = "\(.*\)"/\1/p;}' "$CLIENT_DIR/Cargo.toml" | head -n1
}

VERSION="${VERSION:-$(client_version)}"
[ -n "$VERSION" ] || die "could not read the client version from client/Cargo.toml"
BUILD_DIR="$ROOT_DIR/build/$VERSION"
BIN_DIR="$BUILD_DIR/bin"
DIST_DIR="$BUILD_DIR/dist"

sha256_of() { shasum -a 256 "$1" | cut -d' ' -f1; }
size_of() { wc -c <"$1" | tr -d ' '; }

wrangler() { pnpm --dir "$SERVER_DIR" exec wrangler "$@"; }
