#!/usr/bin/env bash
# Archives the iPhone app and exports a signed IPA without uploading it. Signing: docs/ios.md.
set -euo pipefail
. "$(dirname "$0")/lib/common.sh"

IOS_DIR="$ROOT_DIR/ios"
OUT="$ROOT_DIR/build/ios/release"
TEAM="${APPLE_TEAM_ID:?export APPLE_TEAM_ID}"
BUILD_NUMBER="${BUILD_NUMBER:-$(date -u +%Y%m%d.%H%M)}"
command -v xcodegen >/dev/null || die "XcodeGen is required: brew install xcodegen"

# Without an App Store Connect API key, xcodebuild signs with the account signed in to Xcode.
auth=()
if [ -n "${ASC_KEY_ID:-}" ]; then
  key="${ASC_KEY_PATH:-$HOME/.appstoreconnect/private_keys/AuthKey_$ASC_KEY_ID.p8}"
  [ -f "$key" ] || die "no API key at $key"
  [ -n "${ASC_ISSUER_ID:-}" ] || die "export ASC_ISSUER_ID, the issuer ID shown with the key in App Store Connect"
  auth=(-authenticationKeyPath "$key" -authenticationKeyID "$ASC_KEY_ID" -authenticationKeyIssuerID "$ASC_ISSUER_ID")
fi

rm -rf "$OUT"
mkdir -p "$OUT"
say "generating the Xcode project"
xcodegen generate --spec "$IOS_DIR/project.yml" --quiet

say "archiving $VERSION ($BUILD_NUMBER)"
xcodebuild -project "$IOS_DIR/PrintBetter.xcodeproj" -scheme PrintBetter -configuration Release \
  -destination 'generic/platform=iOS' -archivePath "$OUT/PrintBetter.xcarchive" \
  -allowProvisioningUpdates ${auth[@]+"${auth[@]}"} \
  DEVELOPMENT_TEAM="$TEAM" MARKETING_VERSION="$VERSION" CURRENT_PROJECT_VERSION="$BUILD_NUMBER" archive

cat >"$OUT/ExportOptions.plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>method</key><string>app-store-connect</string>
  <key>destination</key><string>export</string>
  <key>teamID</key><string>$TEAM</string>
  <key>signingStyle</key><string>automatic</string>
  <key>uploadSymbols</key><true/>
</dict>
</plist>
EOF

say "exporting the IPA"
xcodebuild -exportArchive -archivePath "$OUT/PrintBetter.xcarchive" -exportPath "$OUT" \
  -exportOptionsPlist "$OUT/ExportOptions.plist" -allowProvisioningUpdates ${auth[@]+"${auth[@]}"}
say "wrote $OUT/PrintBetter.ipa"
