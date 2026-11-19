#!/usr/bin/env bash
# Builds, packages, and writes latest.json. Flags: --no-notarize, --publish local|remote, --platforms "…".
set -euo pipefail
. "$(dirname "$0")/lib/common.sh"

notarize_flag=""
publish=""
platforms="macos linux windows"
while [ $# -gt 0 ]; do
  case "$1" in
    --no-notarize) notarize_flag="--no-notarize" ;;
    --publish) publish="${2:?--publish needs local or remote}"; shift ;;
    --platforms) platforms="${2:?}"; shift ;;
    *) die "unknown option: $1" ;;
  esac
  shift
done

# Its own target dir, so dev builds and test runs can never race the release artifacts.
export CARGO_TARGET_DIR="${CARGO_TARGET_DIR:-$CLIENT_DIR/target/dist}"
rm -rf "$DIST_DIR"
mkdir -p "$DIST_DIR"
# shellcheck disable=SC2086 # word splitting of the platform list is intended
"$ROOT_DIR/scripts/build-client.sh" $platforms

case " $platforms " in *" macos "*) "$ROOT_DIR/scripts/package-macos.sh" $notarize_flag ;; esac

for dir in "$BIN_DIR"/linux-*; do
  [ -d "$dir" ] || continue
  platform="$(basename "$dir")"
  tar -czf "$DIST_DIR/printbetter-$VERSION-$platform.tar.gz" -C "$dir" printbetter
done
for dir in "$BIN_DIR"/windows-*; do
  [ -d "$dir" ] || continue
  platform="$(basename "$dir")"
  cp "$dir/printbetter.exe" "$DIST_DIR/printbetter-$VERSION-$platform.exe"
done

say "writing manifest"
manifest="$DIST_DIR/latest.json"
{
  printf '{\n  "version": "%s",\n  "files": {' "$VERSION"
  sep=""
  for file in "$DIST_DIR"/*; do
    name="$(basename "$file")"
    case "$name" in
      *-macos-universal.zip) key="macos-universal" ;;
      PrintBetter-*.pkg) key="macos-pkg" ;;
      printbetter-*-linux-*.tar.gz) key="${name#printbetter-"$VERSION"-}"; key="${key%.tar.gz}" ;;
      printbetter-*-windows-*.exe) key="${name#printbetter-"$VERSION"-}"; key="${key%.exe}" ;;
      *) continue ;;
    esac
    printf '%s\n    "%s": { "name": "%s", "sha256": "%s", "size": %s }' \
      "$sep" "$key" "$name" "$(sha256_of "$file")" "$(size_of "$file")"
    sep=","
  done
  printf '\n  }\n}\n'
} >"$manifest"
jq . "$manifest" >/dev/null || die "manifest is not valid JSON"
say "artifacts in $DIST_DIR"

if [ -n "$publish" ]; then "$ROOT_DIR/scripts/publish-downloads.sh" "$publish"; fi
