#!/usr/bin/env bash
# Uploads build/<version>/dist to R2 for /install.sh and /dl/*. Arg: local (dev server state) | remote.
set -euo pipefail
. "$(dirname "$0")/lib/common.sh"

mode="${1:?usage: publish-downloads.sh local|remote}"
case "$mode" in local | remote) ;; *) die "mode must be local or remote" ;; esac
[ -f "$DIST_DIR/latest.json" ] || die "no manifest at $DIST_DIR/latest.json; run scripts/release.sh first"
bucket="${R2_BUCKET:-print-better-files}"

content_type() {
  case "$1" in
    *.json) echo application/json ;;
    *.zip) echo application/zip ;;
    *.tar.gz) echo application/gzip ;;
    *.exe) echo application/vnd.microsoft.portable-executable ;;
    *) echo application/octet-stream ;;
  esac
}

for file in "$DIST_DIR"/*; do
  name="$(basename "$file")"
  [ "$name" = latest.json ] && continue
  say "uploading $name ($mode)"
  wrangler r2 object put "$bucket/downloads/$VERSION/$name" --file "$file" \
    --content-type "$(content_type "$name")" "--$mode"
done
wrangler r2 object put "$bucket/downloads/$VERSION/manifest.json" --file "$DIST_DIR/latest.json" \
  --content-type application/json "--$mode"
# The manifest goes last so clients never see a version whose files are missing.
wrangler r2 object put "$bucket/downloads/latest.json" --file "$DIST_DIR/latest.json" \
  --content-type application/json --cache-control no-store "--$mode"
say "published $VERSION to $bucket ($mode)"
