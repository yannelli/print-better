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

# Uploads use an App Store Connect API key; altool finds the key file by its ID. Checked before the archive.
if [ "$DESTINATION" = upload ]; then
  [ -n "${ASC_ISSUER_ID:-}" ] || die "export ASC_ISSUER_ID (docs/ios.md)"
  if [ -z "${ASC_KEY_ID:-}" ]; then
    keys=("$KEYS"/AuthKey_*.p8)
    [ "${#keys[@]}" -eq 1 ] && [ -f "${keys[0]}" ] || die "keep one AuthKey_<key ID>.p8 in $KEYS, or export ASC_KEY_ID"
    ASC_KEY_ID="$(basename "${keys[0]}" .p8)"
    ASC_KEY_ID="${ASC_KEY_ID#AuthKey_}"
  fi
  [ -f "$KEYS/AuthKey_$ASC_KEY_ID.p8" ] || die "missing $KEYS/AuthKey_$ASC_KEY_ID.p8"
  # App Store Connect turns down builds from an older beta (error 90534). Beta build versions end in a letter.
  xcode_build="$(xcodebuild -version | awk '/Build version/ { print $3 }')"
  case "$xcode_build" in
    *[a-z]) [ -n "${ALLOW_BETA_XCODE:-}" ] ||
      die "Xcode $xcode_build is a beta. Export DEVELOPER_DIR=<release Xcode>/Contents/Developer, or ALLOW_BETA_XCODE=1 for the current beta" ;;
  esac
fi

# Manual signing with the App Store profiles from docs/ios.md, picked per target.
APP_PROFILE="${APP_PROFILE:-PB iOS App Store}"
SHARE_PROFILE="${SHARE_PROFILE:-PB iOS Share App Store}"
# shellcheck disable=SC2016 # Xcode expands $(TARGET_NAME), not the shell.
signing=(CODE_SIGN_STYLE=Manual CODE_SIGN_IDENTITY="Apple Distribution"
  'PROVISIONING_PROFILE_SPECIFIER=$(PB_PROFILE_$(TARGET_NAME))'
  "PB_PROFILE_PrintBetter=$APP_PROFILE" "PB_PROFILE_PrintBetterShare=$SHARE_PROFILE")

rm -rf "$OUT"
mkdir -p "$OUT"
say "generating the Xcode project"
xcodegen generate --spec "$IOS_DIR/project.yml" --quiet

say "archiving $VERSION ($BUILD_NUMBER)"
xcodebuild -project "$IOS_DIR/PrintBetter.xcodeproj" -scheme PrintBetter -configuration Release \
  -destination 'generic/platform=iOS' -archivePath "$OUT/PrintBetter.xcarchive" "${signing[@]}" \
  DEVELOPMENT_TEAM="$TEAM" MARKETING_VERSION="$VERSION" CURRENT_PROJECT_VERSION="$BUILD_NUMBER" archive

# manageAppVersionAndBuildNumber is off so App Store Connect gets the build number above unchanged.
cat >"$OUT/ExportOptions.plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>method</key><string>app-store-connect</string>
  <key>destination</key><string>export</string>
  <key>teamID</key><string>$TEAM</string>
  <key>signingStyle</key><string>manual</string>
  <key>signingCertificate</key><string>Apple Distribution</string>
  <key>provisioningProfiles</key>
  <dict>
    <key>dev.yannelli.printbetter.ios</key><string>$APP_PROFILE</string>
    <key>dev.yannelli.printbetter.ios.share</key><string>$SHARE_PROFILE</string>
  </dict>
  <key>uploadSymbols</key><true/>
  <key>manageAppVersionAndBuildNumber</key><false/>
</dict>
</plist>
EOF

say "exporting the IPA"
xcodebuild -exportArchive -archivePath "$OUT/PrintBetter.xcarchive" -exportPath "$OUT" \
  -exportOptionsPlist "$OUT/ExportOptions.plist"
say "wrote $OUT/PrintBetter.ipa"
[ "$DESTINATION" = upload ] || exit 0

say "uploading $VERSION ($BUILD_NUMBER) to App Store Connect"
xcrun altool --upload-package "$OUT/PrintBetter.ipa" --api-key "$ASC_KEY_ID" --api-issuer "$ASC_ISSUER_ID"
say "uploaded; the build shows in TestFlight once App Store Connect has processed it"
