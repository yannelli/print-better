#!/usr/bin/env bash
# notarize <zip|pkg|dmg>: submit with the app-specific password from the environment and wait.
notarize() {
  local file="$1" out status
  out=$(xcrun notarytool submit "$file" --apple-id "${APPLE_ID:?export APPLE_ID}" \
    --password "${APPLE_PASSWORD:?export APPLE_PASSWORD}" --team-id "${APPLE_TEAM_ID:?export APPLE_TEAM_ID}" \
    --wait --output-format json)
  status=$(printf '%s' "$out" | plutil -extract status raw -)
  if [ "$status" != "Accepted" ]; then
    printf '%s\n' "$out" >&2
    die "notarization of $(basename "$file"): $status"
  fi
  say "notarized $(basename "$file")"
}
