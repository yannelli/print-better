# Releasing the client

`scripts/release.sh` builds every target on this Mac, signs and notarizes the macOS app and pkg, writes `build/<version>/dist/latest.json`, and can publish to R2. The version comes from `client/Cargo.toml` (`[workspace.package] version`).

```sh
scripts/release.sh                        # all platforms, notarized
scripts/release.sh --no-notarize          # signed but not notarized (fast local check)
scripts/release.sh --platforms "macos"    # subset
scripts/release.sh --publish local        # also upload to the dev server's local R2
scripts/release.sh --publish remote       # also upload to your Cloudflare R2 bucket
```

## Requirements
- Rust targets: `aarch64-apple-darwin x86_64-apple-darwin aarch64-unknown-linux-musl x86_64-unknown-linux-musl armv7-unknown-linux-musleabihf arm-unknown-linux-musleabihf x86_64-pc-windows-gnullvm aarch64-pc-windows-gnullvm`.
- `zig` and `cargo-zigbuild` for Linux and Windows cross-builds.
- Keychain identities "Developer ID Application" and "Developer ID Installer".
- `server/node_modules` installed (`pnpm --dir server install`) for `wrangler` when publishing.

## Environment
| Variable | Use |
|---|---|
| `APPLE_SIGNING_IDENTITY` | codesign identity (default `Developer ID Application`) |
| `APPLE_INSTALLER_IDENTITY` | productbuild identity (default `Developer ID Installer`) |
| `APPLE_ID`, `APPLE_PASSWORD`, `APPLE_TEAM_ID` | notarytool with an app-specific password |
| `BUILD_NUMBER` | optional `CFBundleVersion` (defaults to the version) |
| `WINDOWS_SIGN_CMD` | optional command run on each `.exe` (Authenticode hook; unsigned by default) |
| `R2_BUCKET` | bucket name for publishing (default `print-better-files`) |

## Outputs (`build/<version>/dist/`)
| File | Consumer |
|---|---|
| `printbetter-<v>-macos-universal.zip` | `install.sh` on macOS (stapled `Print Better.app`) |
| `PrintBetter-<v>.pkg` | double-click install; postinstall runs `printbetter service install --system` (root daemon + per-user tray) |
| `printbetter-<v>-linux-{x86_64,aarch64,armv7,armv6}.tar.gz` | `install.sh` on Linux / Raspberry Pi |
| `printbetter-<v>-windows-{x86_64,aarch64}.exe` | `install.ps1` |
| `latest.json` | manifest read by the install scripts (format in `docs/cli.md`) |

Publishing uploads files to `downloads/<version>/` first and `downloads/latest.json` last, so clients never see a manifest whose files are missing.

## How updates reach devices
Bump `[workspace.package] version` in `client/Cargo.toml`, then run `scripts/release.sh --publish remote`. Once `downloads/latest.json` names the new version, paired macOS and Linux devices pick it up on their next check (within about 6 hours, or at once with "Update now" in the dashboard or `printbetter update`) and install it unless their `autoUpdate` setting is off. The dashboard marks devices behind the published version with "Update available". macOS devices only accept builds signed by the same Developer ID team as the installed app, so keep releasing with the same certificates.

## CI
`.github/workflows/release.yml` runs the same script on a macOS runner. It is manual-only for now: start it from Actions with a tag ref selected. Secrets: `APPLE_ID`, `APPLE_PASSWORD`, `APPLE_TEAM_ID`, `APPLE_SIGNING_IDENTITY`, `APPLE_INSTALLER_IDENTITY`, `MACOS_CERTS_P12` (base64 of a p12 holding both Developer ID certs), `MACOS_CERTS_PASSWORD`, and optionally `CLOUDFLARE_API_TOKEN` + `CLOUDFLARE_ACCOUNT_ID` to publish to R2.

## Known limits
- Windows builds are unsigned (SmartScreen does not prompt for files fetched by the PowerShell installer; Smart App Control, if enabled, may still block).
- armv6 (Pi Zero/1) builds compile, but ring's ARM assembly is not documented for ARMv6; verify on hardware.
- macOS slices are stripped by the linker (`-Wl,-x`), not rustc's `strip`: Xcode 27's `strip` writes Mach-O files dyld rejects ("mis-aligned LINKEDIT string pool") once a deployment target ≥ 12 enables chained fixups. `package-macos.sh` runs the packaged binary before signing to catch this class of failure.
- Releases build in `client/target/dist` so dev builds and test runs can't race release artifacts. If a toolchain ever leaves corrupt artifacts there, `cargo clean --target-dir client/target/dist` resets it.
