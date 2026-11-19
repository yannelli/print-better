#!/usr/bin/env bash
# Generates ios/PrintBetter.xcodeproj and builds the iPhone app for the Simulator. Args: [test]. See docs/ios.md.
set -euo pipefail
. "$(dirname "$0")/lib/common.sh"

IOS_DIR="$ROOT_DIR/ios"
DERIVED="$ROOT_DIR/build/ios/DerivedData"
SIMULATOR="${SIMULATOR:-iPhone 17 Pro}"
command -v xcodegen >/dev/null || die "XcodeGen is required: brew install xcodegen"

say "generating the Xcode project"
xcodegen generate --spec "$IOS_DIR/project.yml" --quiet

run() {
  xcodebuild -project "$IOS_DIR/PrintBetter.xcodeproj" -scheme PrintBetter -configuration Debug \
    -destination "platform=iOS Simulator,name=$SIMULATOR" -derivedDataPath "$DERIVED" \
    MARKETING_VERSION="$VERSION" "$@"
}

say "building for the $SIMULATOR simulator"
run build
say "built $DERIVED/Build/Products/Debug-iphonesimulator/PrintBetter.app"

if [ "${1:-}" = test ]; then
  say "testing PrintBetterKit"
  swift test --package-path "$IOS_DIR/PrintBetterKit"
  say "testing the app"
  run test
fi
