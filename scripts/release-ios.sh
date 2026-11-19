#!/usr/bin/env bash
# Archives the iPhone app and exports a signed IPA, or uploads the build to App Store Connect. Args: [--upload]. Signing: docs/ios.md.
set -euo pipefail
. "$(dirname "$0")/lib/common.sh"

case "${1:-}" in
  "") DESTINATION="export" ;;
  --upload) DESTINATION="upload" ;;
  *) die "usage: scripts/release-ios.sh [--upload]" ;;
esac

IOS_DIR="$ROOT_DIR/ios"
OUT="$ROOT_DIR/build/ios/release"
KEYS="$HOME/.appstoreconnect/private_keys"
TEAM="${APPLE_TEAM_ID:?export APPLE_TEAM_ID}"
# Every upload needs a higher build number than the last one.
BUILD_NUMBER="${BUILD_NUMBER:-$(date -u +%Y%m%d.%H%M%S)}"
command -v xcodegen >/dev/null || die "XcodeGen is required: brew install xcodegen"

# The App Store Connect API key lets xcodebuild register the IDs, make the profiles and upload.
if [ -z "${ASC_KEY_ID:-}" ]; then
  keys=("$KEYS"/AuthKey_*.p8)
  [ "${#keys[@]}" -eq 1 ] && [ -f "${keys[0]}" ] || die "keep one AuthKey_<key ID>.p8 in $KEYS, or export ASC_KEY_ID"
  ASC_KEY_ID="$(basename "${keys[0]}" .p8)"
  ASC_KEY_ID="${ASC_KEY_ID#AuthKey_}"
fi
key="$KEYS/AuthKey_$ASC_KEY_ID.p8"
[ -f "$key" ] || die "missing $key"

if [ -z "${ASC_ISSUER_ID:-}" ]; then
  # The issuer ID is the Public ID of the team's provider. altool reads the password from the environment itself.
  lookup="xcrun altool --list-providers -u \"\$APPLE_ID\" -p @env:APPLE_PASSWORD"
  [ -n "${APPLE_ID:-}" ] && [ -n "${APPLE_PASSWORD:-}" ] || die "export ASC_ISSUER_ID, or APPLE_ID and APPLE_PASSWORD to look it up"
  providers="$(xcrun altool --list-providers -u "$APPLE_ID" -p @env:APPLE_PASSWORD 2>&1)" ||
    die "couldn't list providers. Run $lookup to see why, or export ASC_ISSUER_ID"
  ASC_ISSUER_ID="$(printf '%s\n' "$providers" | grep -w "$TEAM" |
    grep -Eo '[0-9A-Fa-f]{8}(-[0-9A-Fa-f]{4}){3}-[0-9A-Fa-f]{12}' | head -n1 || true)"
  [ -n "$ASC_ISSUER_ID" ] || die "no provider for team $TEAM in $lookup. Export ASC_ISSUER_ID"
fi
auth=(-allowProvisioningUpdates -authenticationKeyPath "$key" -authenticationKeyID "$ASC_KEY_ID"
  -authenticationKeyIssuerID "$ASC_ISSUER_ID")

rm -rf "$OUT"
mkdir -p "$OUT"
say "generating the Xcode project"
xcodegen generate --spec "$IOS_DIR/project.yml" --quiet

say "archiving $VERSION ($BUILD_NUMBER)"
xcodebuild -project "$IOS_DIR/PrintBetter.xcodeproj" -scheme PrintBetter -configuration Release \
  -destination 'generic/platform=iOS' -archivePath "$OUT/PrintBetter.xcarchive" "${auth[@]}" \
  DEVELOPMENT_TEAM="$TEAM" MARKETING_VERSION="$VERSION" CURRENT_PROJECT_VERSION="$BUILD_NUMBER" archive

# manageAppVersionAndBuildNumber is off so App Store Connect gets the build number above unchanged.
cat >"$OUT/ExportOptions.plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>method</key><string>app-store-connect</string>
  <key>destination</key><string>$DESTINATION</string>
  <key>teamID</key><string>$TEAM</string>
  <key>signingStyle</key><string>automatic</string>
  <key>uploadSymbols</key><true/>
  <key>manageAppVersionAndBuildNumber</key><false/>
</dict>
</plist>
EOF

if [ "$DESTINATION" = upload ]; then
  say "uploading $VERSION ($BUILD_NUMBER) to App Store Connect"
else
  say "exporting the IPA"
fi
xcodebuild -exportArchive -archivePath "$OUT/PrintBetter.xcarchive" -exportPath "$OUT" \
  -exportOptionsPlist "$OUT/ExportOptions.plist" "${auth[@]}"
if [ "$DESTINATION" = upload ]; then
  say "uploaded; the build shows in TestFlight once App Store Connect has processed it"
else
  say "wrote $OUT/PrintBetter.ipa"
fi
