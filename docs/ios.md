# Print Better for iPhone

`ios/` holds the iPhone and iPad app (iOS 26 or later). It pairs with a server, lists the printers this device may use, prints files, photos and document scans, follows and cancels jobs, adds **Print Better** to the share sheet of other apps, and adds a **Print with Print Better** action to Shortcuts. XcodeGen generates the Xcode project from `ios/project.yml`, so the `.xcodeproj` isn't committed.

```sh
scripts/build-ios.sh                                  # generate the project, build for the iPhone 17 Pro simulator
scripts/build-ios.sh test                             # also run the PrintBetterKit and app unit tests
SIMULATOR="iPad Air 11-inch (M4)" scripts/build-ios.sh
scripts/release-ios.sh                                # signed archive and IPA in build/ios/release/
scripts/make-ios-icon.sh                              # re-renders the app icon, copies the brand mark from docs/assets
```

The app version comes from `client/Cargo.toml`, like the other clients.

## Requirements
- Xcode 26 or later and XcodeGen (`brew install xcodegen`).
- For a device build or a release: a paid Apple Developer team, with `APPLE_TEAM_ID` exported before the project is generated.
- For the app unit tests on a simulator: Developer Mode on the Mac (`DevToolsSecurity -status`). While it's off, the test runner never connects and `xcodebuild test` stops with "The test runner hung before establishing connection". Turn it on with `sudo DevToolsSecurity -enable`.

## Layout
| Path | Contents |
|---|---|
| `ios/project.yml` | XcodeGen spec for the app, the share extension and the unit tests |
| `ios/PrintBetter/` | The app: pairing, the Print, Printers, Jobs and Settings tabs, the Shortcuts action |
| `ios/PrintBetterShare/` | The share extension; `Preprocess.js` hands it Safari's copy of the page |
| `ios/Shared/` | The print form and print session both targets use |
| `ios/PrintBetterKit/` | Swift package: API client, pairing, document conversion and the app's wording, with its own tests (`swift test`) |
| `ios/PrintBetterTests/` | App unit tests for the print session |

## Identifiers
| Item | Value |
|---|---|
| App | `dev.yannelli.printbetter.ios` |
| Share extension | `dev.yannelli.printbetter.ios.share` |
| App Group | `group.dev.yannelli.printbetter`, also the Keychain access group that holds the device token |
| URL scheme | `printbetter://pair?server=<origin>&token=pbe_…`, the QR code under **Devices > Add a device > iPhone or iPad** |

## How it talks to the server
- Pairing with an address: `GET /api/instance` checks it, then the device code flow (`POST /api/client/device/code`) opens the approval page in a Safari sheet that shares Safari's sign-in. The app polls `POST /api/client/device/token` and closes the sheet once the server issues a token.
- Pairing with the QR code: `POST /api/client/enroll` with the `pbe_` code from the link.
- The phone has no WebSocket. It polls `GET /api/client/printers` and `GET /api/client/jobs` while those screens are open, and `GET /api/client/jobs/:id` while a job it sent is running.
- Printing: `POST /api/client/jobs`, then `PUT` the file to this server. Photos are sent as JPEG, several photos become one PDF with a photo on each page, scans become a PDF, and Safari pages become a PDF laid out by WebKit's print layout.
- The share extension and the Shortcuts action read the token from the shared Keychain item, so they work without opening the app.
- The app pairs with `os: ios` on an iPhone and `os: ipados` on an iPad, so the web app names, and shows an icon for, the right one. Its own text names the device the same way, from `UIDevice.current.model`.

## Signing
Signing is automatic and uses an App Store Connect API key with access to Certificates, Identifiers & Profiles. `scripts/release-ios.sh` passes the key with `-allowProvisioningUpdates`, so Xcode registers the two bundle IDs and the App Group and makes the profiles. The key file goes in `~/.appstoreconnect/private_keys/`, named `AuthKey_<key ID>.p8` as App Store Connect downloads it.

| Variable | Use |
|---|---|
| `APPLE_TEAM_ID` | Team for signing; XcodeGen writes it into the project |
| `ASC_KEY_ID` | The key ID, the part of the key's file name after `AuthKey_` |
| `ASC_ISSUER_ID` | The issuer ID shown above the keys under **Users and Access > Integrations** in App Store Connect |
| `BUILD_NUMBER` | `CFBundleVersion` (defaults to the UTC date and time, such as `20261119.1530`) |
| `SIMULATOR` | Simulator for `build-ios.sh` (default `iPhone 17 Pro`) |

## Releasing to TestFlight
NOTE: You need the App Manager or Admin role in App Store Connect, and `APPLE_TEAM_ID`, `ASC_KEY_ID` and `ASC_ISSUER_ID` exported.

1. Run `scripts/release-ios.sh`. The first run registers the two bundle IDs and the App Group, then it writes `build/ios/release/PrintBetter.ipa`.
2. In App Store Connect, open **Apps**, click **+**, then **New App**. Choose iOS, name it Print Better, pick the bundle ID `dev.yannelli.printbetter.ios`, and enter any SKU. The bundle ID is only in the list once step 1 has registered it.
3. Upload the IPA with the Transporter app, or double-click `build/ios/release/PrintBetter.xcarchive` to open it in the Xcode Organizer and click **Distribute App**.
4. In App Store Connect, open the app's **TestFlight** tab, wait for the build to finish processing, and add testers. The app declares that it uses no non-exempt encryption, so there is no export compliance question.

Testers get the build in the TestFlight app. Internal testers get it as soon as it's processed; the first build for external testers goes through Beta App Review.
