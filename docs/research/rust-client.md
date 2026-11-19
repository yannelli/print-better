# Print Better Rust client: verified research (2026-11-18)

Host: macOS arm64, rustc 1.97.1, zig 0.17.0, cargo-zigbuild 0.24.0 (latest 0.24.1), no cargo-xwin. Nothing installed or compiled; code samples are NOT compiled.
UNVERIFIED = not confirmed from a primary source today. "Weight" = crate counts from my own crates.io-metadata resolver (newest compatible versions, target cfg evaluated, includes proc-macro/build crates), not `cargo tree`.

## 1. Crates

Source: crates.io API (/api/v1/crates/NAME/VER[/dependencies]); API reads from crate tarballs on static.crates.io and docs.rs; Context7 /kevinmehall/nusb, /laurenzv/hayro, /snapview/tokio-tungstenite, /snapview/tungstenite-rs, /rustls/rustls.

| crate | version (published) | MSRV | license |
|---|---|---|---|
| tokio | 1.54.1 (2026-10-21) | 1.85 | MIT |
| hyper / hyper-util / http-body-util | 1.12.0 / 0.1.21 / 0.1.5 | 1.63 / 1.85 / 1.61 | MIT |
| rustls / tokio-rustls | 0.23.46 (2026-10-14) / 0.26.6 | 1.71 | Apache-2.0 OR ISC OR MIT / MIT OR Apache-2.0 |
| webpki-roots / rustls-platform-verifier | 1.0.12 (2026-11-10) / 0.7.1 | 1.71 / 1.85 | CDLA-Permissive-2.0 / MIT OR Apache-2.0 |
| tokio-tungstenite (tungstenite) | 0.30.0 (2026-07-11) | 1.85 | MIT |
| serde / serde_json | 1.0.229 / 1.0.154 | - | MIT OR Apache-2.0 |
| mdns-sd | 0.22.0 (2026-11-17, yesterday) | 1.71 | Apache-2.0 OR MIT |
| nusb | 0.2.9 (2026-10-24) | 1.85 | Apache-2.0 OR MIT |
| hayro | 0.9.0 (2026-11-02) | 1.92 | Apache-2.0 OR MIT |
| png / zune-jpeg / miniz_oxide | 0.18.1 / 0.5.15 (0.5.16-rc3 pre) / 0.9.1 | 1.73 / 1.75 / - | MIT OR Apache-2.0 / MIT OR Apache-2.0 OR Zlib / MIT OR Zlib OR Apache-2.0 |
| lexopt / clap | 0.3.2 / 4.6.8 | - | MIT / MIT OR Apache-2.0 |
| ring | 0.17.14 (2025-03-11, no release in 20 months) | - | - |

### tokio
- Minimal: `tokio = { version = "1.54.1", features = ["rt","net","time","sync","io-util"] }` = 6 crates (tokio, bytes, libc, mio, pin-project-lite, socket2). Skip `macros` (pulls proc-macro2/quote/syn) and `rt-multi-thread`; use `Builder::new_current_thread().enable_all()` (Pi Zero is single core). `signal`/`process` add signal-hook-registry/more windows-sys features.

### hyper 1.x over tokio-rustls (no hyper-rustls)
- Verified API: `hyper::client::conn::http1::handshake<T: hyper::rt::Read+Write+Unpin, B>(io) -> Result<(SendRequest<B>, Connection<T,B>)>` (hyper-1.12.0 src/client/conn/http1.rs:150). `TokioIo` (adapter tokio<->hyper IO) is behind hyper-util feature `tokio`.
- Features: `hyper = { version="1.12.0", default-features=false, features=["client","http1"] }`, `hyper-util = { version="0.1.21", default-features=false, features=["tokio"] }`, `http-body-util = "0.1.5"`. hyper+util+body-util+tokio = 18 crates total (adds atomic-waker, futures-core, http, http-body, httparse, itoa, smallvec, try-lock, want).
- Sketch (not compiled): `let tls = TlsConnector::from(Arc::new(cfg)).connect(ServerName::try_from(host.to_owned())?, tcp).await?; let (mut tx, conn) = hyper::client::conn::http1::handshake(TokioIo::new(tls)).await?; tokio::spawn(conn);` then `tx.send_request(Request::builder().uri(path).header(HOST, host).body(Empty::<Bytes>::new())?)`.

### rustls: choose ring, not aws-lc-rs
- 0.23.x: provider chosen by cargo feature; default features = aws_lc_rs+logging+prefer-post-quantum+std+tls12 (rustls-0.23.46 Cargo features). Use `default-features=false`. tokio-rustls defaults ALSO enable aws_lc_rs (default = logging, tls12, aws_lc_rs), so set `default-features=false` there too.
```toml
rustls = { version = "0.23.46", default-features = false, features = ["ring", "std", "tls12"] }
tokio-rustls = { version = "0.26.6", default-features = false, features = ["ring", "tls12"] }
webpki-roots = "1.0.12"
```
- Be explicit, never rely on the process default (panics with "Could not automatically determine the process-level CryptoProvider" if both or neither provider features unify): `ClientConfig::builder_with_provider(Arc::new(rustls::crypto::ring::default_provider())).with_safe_default_protocol_versions()?.with_root_certificates(roots).with_no_client_auth()` (builder_with_provider client_conn.rs:354, builder.rs:200 verified). Roots: `roots.extend(webpki_roots::TLS_SERVER_ROOTS.iter().cloned())`. CI guard: `cargo tree -i aws-lc-rs` must be empty.
- ring tradeoff (rustls README): "easier to build on a variety of platforms" but no post-quantum (X25519MLKEM768 is aws-lc-rs only). Fine for Cloudflare (classical X25519 accepted; UNVERIFIED that Workers never require PQ).
- SURPRISE: rustls 0.24 is unreleased (0.24.0-dev.0..3, newest 2026-11-12). It removes provider cargo features; providers become crates (`rustls-ring` 0.24.0-dev.3 exists). tokio-rustls/tokio-tungstenite pin ^0.23, so pin `rustls = "0.23"` and expect a migration. Source: https://rustls.dev/blog/2026-09-08-a-decade-of-rustls/
- ring 0.17.14 is 20 months old; RustSec RUSTSEC-2025-0010 only flags ring <0.17 as unmaintained, 0.17 unaffected. Debian shipped 0.17.14-5 in 2026-04 (search result). No ring 0.18 found. Risk: low-activity dependency under every TLS connection.
- Stack weight: rustls(ring)+tokio-rustls+webpki-roots+tokio = 21 crates (ring, cc, shlex, find-msvc-tools, getrandom 0.2, untrusted, subtle, zeroize, once_cell, rustls-webpki, rustls-pki-types).

### webpki-roots vs rustls-platform-verifier
- webpki-roots 1.0.12: static Mozilla roots, 1 dep (rustls-pki-types), no system access, needs a release when roots change, no corporate/TLS-inspection roots. CDLA-Permissive-2.0 requires attribution notice in distributions.
- rustls-platform-verifier 0.7.1: macOS security-framework 3.5 + core-foundation; Windows windows-sys (Win32_Foundation, Win32_Security_Cryptography); Linux rustls-native-certs + webpki (reads system CA bundle once at startup; a bare Pi image without ca-certificates fails). rustls team README: "the best default available for client-side libraries" on common OSes. Wiring: `builder_with_provider(p).with_safe_default_protocol_versions()?.with_platform_verifier()?.with_no_client_auth()` via `BuilderVerifierExt`. `Verifier::new_with_extra_roots` exists (signature UNVERIFIED), usable to add webpki-roots as fallback.
- Recommendation: webpki-roots default (deterministic, headless Linux safe); platform verifier behind `cfg(any(windows, target_os="macos"))` only if enterprise TLS inspection matters.

### tokio-tungstenite 0.30 (WSS + Authorization)
- Features: `rustls-tls-webpki-roots`, `rustls-tls-native-roots`, `native-tls`, `connect` (default), `handshake`. Its rustls/tokio-rustls deps are no-default-features, so no aws-lc-rs, but it needs a provider installed globally (README warns of the panic, issue #353 fix = `rustls::crypto::ring::default_provider().install_default()`). Its webpki-roots dep is ^0.26 (shim over 1.x) so enabling its feature duplicates webpki-roots.
- Preferred: skip its TLS and connector; own TLS stream + `client_async`. Verified signature: `client_async<R: IntoClientRequest+Unpin, S: AsyncRead+AsyncWrite+Unpin>(request, stream) -> Result<(WebSocketStream<S>, Response), WsError>` (src/lib.rs:81). Header: `ClientRequestBuilder::new(uri).with_header("Authorization", format!("Bearer {token}"))` (tungstenite src/client.rs:293-309; implements IntoClientRequest). Or `connect_async_tls_with_config(req, None, false, Some(Connector::Rustls(Arc<ClientConfig>)))`.
```toml
tokio-tungstenite = { version = "0.30.0", default-features = false, features = ["handshake"] }
```
- Weight: tungstenite 0.30 drags rand 0.10 (chacha20, getrandom 0.4), sha1 0.11 (digest, crypto-common, typenum, hybrid-array), data-encoding, thiserror (syn). tokio+tokio-tungstenite[handshake] alone = 37 crates; with its rustls-tls-webpki-roots feature = 52. Alternative if minimizing: hand-rolled RFC 6455 client over the hyper/TLS stream (~200 lines; UNVERIFIED effort).

### serde / serde_json
- `serde = { version="1.0.229", default-features=false, features=["derive","std"] }`, `serde_json = "1.0.154"` = 11 crates; derive adds serde_derive, proc-macro2, quote, syn 3.0.10, unicode-ident (build-time). serde_json now depends on `zmij` (float formatting), not ryu (resolver output).

### mdns-sd 0.22 (browse + register)
- Deps (12 crates incl. itself): fastrand, flume 0.12, futures-core/sink, if-addrs 0.15, libc, log, mio, socket-pktinfo, socket2, spin. Own daemon thread, no tokio; events via flume channels (`recv_async()` with default feature `async`). Raw UDP sockets on 5353, not the macOS Bonjour API. README: "still beta"; no unicast responses (QU), no multipacket known-answer on responder.
- Verified API: `ServiceDaemon::new()`, `browse("_ipp._tcp.local.")` (must end `._tcp.local.`/`._udp.local.`) -> `Receiver<ServiceEvent>` with `SearchStarted | ServiceFound(ty,fullname) | ServiceResolved(Box<ResolvedService{host,port,addresses,txt_properties,fullname}>) | ServiceRemoved | SearchStopped`. Register: `daemon.register(ServiceInfo::new("_printbetter._tcp.local.", "instance", "host.local.", "", 8631, &props[..])?.enable_addr_auto())`; also `unregister`, `monitor`, `shutdown`, `enable_interface/disable_interface(IfKind::..)`.
- Printer browse set: `_ipp._tcp`, `_ipps._tcp`, `_printer._tcp` (LPD), `_pdl-datastream._tcp` (raw 9100). Use resolved IPs directly (see musl note in section 4).

### nusb 0.2.9
- Pure Rust, no libusb. Deps: Linux rustix+linux-raw-sys+slab+log+futures-core (9 crates); macOS core-foundation+io-kit-sys+mach2 (9); Windows windows-sys only (6). Features: `tokio` or `smol` only needed to `.await` blocking ops; otherwise `.wait()` via `MaybeFuture`. Global event-loop thread started on first open.
- API (docs.rs/nusb/0.2.9 + src): `nusb::list_devices().wait()?` -> `DeviceInfo`; `info.interfaces()` -> `InterfaceInfo::{interface_number,class,subclass,protocol}`; `info.open().wait()?` -> `Device`; `dev.claim_interface(n)` / `dev.detach_and_claim_interface(n)` (detach is Linux-only) -> `Interface`; `intf.endpoint::<Bulk,Out>(addr)?.writer(4096)` (std `Write`, async with tokio feature); `intf.control_in(ControlIn{control_type,recipient,request,value,index,length}, timeout)`; `nusb::watch_devices()` hotplug.
- Printer filter: interface class 0x07, subclass 0x01, protocol 1 uni / 2 bidi / 3 IEEE1284.4 (4 = IPP-over-USB, UNVERIFIED).
- GET_DEVICE_ID (verified against CUPS backend/usb-libusb.c:1090): `ControlIn{control_type: Class, recipient: Interface, request: 0, value: config_index, index: (iface<<8)|alt, length: 1024}`, 5 s. Reply: first 2 bytes = length big-endian (CUPS retries LSB-first if <14 or >buflen), then `MFG:..;MDL:..;CMD:..;`. Linux kernel confirms wIndex=(iface<<8|alt).
- Platform: Linux needs write access to /dev/bus/usb/BBB/DDD (section 6); usblp holds the interface, so use `detach_and_claim_interface` (CUPS also detaches usblp). macOS: IOKit, no permission setup, "devices with a kernel driver are inaccessible"; whether Apple's stack owns printer-class interfaces: UNVERIFIED. Windows: needs WinUSB; `interfaces()` is empty unless composite on usbccgp; `Device::control_in` unsupported (use `Interface::control_in`), and with Interface recipient the low byte of `index` must equal the interface number, which GET_DEVICE_ID's (iface<<8|alt) violates (inference). Printers bind usbprint.sys, so on Windows use the spooler only; nusb is pointless for printer-class there.

### hayro 0.9.0 (PDF to pixels)
- Facade over hayro-syntax/-interpret/-font/-cmap/-jpeg2000/-jbig2/-ccitt + vello_cpu 0.3, kurbo, image(png), pic-scale, fearless_simd. 77 crates total (largest single contributor; includes moxcms, skrifa/read-fonts, brotli, phf, thiserror, syn). Default features `embed-fonts` (+~240 KB, 14 standard font substitutes) and `embed-cmaps` (size UNVERIFIED). `forbid(unsafe_code)`, CPU only.
- Verified API (hayro-0.9.0 src/lib.rs:278, examples/render.rs):
```rust
let pdf = hayro::hayro_syntax::Pdf::new(bytes)?; // Vec<u8>; Pdf::new_with_password exists
let cache = hayro::RenderCache::new();
let s = 300.0 / 72.0; // page units are 1/72 in
for page in pdf.pages().iter() {
    let px = hayro::render(page, &cache, &hayro::hayro_interpret::InterpreterSettings::default(),
        &hayro::RenderSettings::default(),
        &hayro::PixmapSettings { x_scale: s, y_scale: s, bg_color: hayro::vello_cpu::color::palette::css::WHITE });
    let (w, h, rgba) = (px.width(), px.height(), px.data_as_u8_slice()); // u16 dims, premultiplied RGBA8
}
```
- Memory: 300 dpi Letter = 2550x3300x4 = 33.7 MB, 600 dpi = 134.7 MB; dims are u16 (max 65535). Banding via `render_into(page,&cache,..,&mut RenderContext, Affine)` is possible (advanced example) but untested here.
- Maturity (README + CHANGELOG): "experimental"; 0.9.0 (2026-11-02) had breaking changes (RenderSettings fields, RenderCache not Clone, removed `simd`/`logging` features); every 0.x bump breaks API. Gaps: knockout groups, CMYK blending, 3D, blending/isolation, color-key masking; "ways to trigger timeouts and out-of-memory errors on untrusted input"; CJK fallback fonts must be supplied via `InterpreterSettings.font_resolver` (example loads Noto CJK from disk). Doc discrepancy: lib docs say no encryption support but hayro-syntax 0.9.0 ships RC4/AES/SHA crypto and `new_with_password`.
- Pi Zero (ARM1176, 512 MB): expect slow and memory-heavy; prefer sending PDF natively over IPP (most AirPrint/IPP Everywhere printers accept application/pdf) and rasterize only for GDI/raw-only paths. UNVERIFIED perf; fearless_simd/pic-scale on 32-bit ARM fall back to scalar (UNVERIFIED).

### Image decoders, deflate, CLI
- png 0.18.1 (10 crates: bitflags, crc32fast, fdeflate, flate2, miniz_oxide 0.8+0.9, simd-adler32, adler2, cfg-if): `Decoder::new(reader)`, `set_transformations(Transformations::EXPAND | STRIP_16)`, `read_info()?`, `output_buffer_size() -> Option<usize>`, `next_frame(&mut buf)`.
- zune-jpeg 0.5.15 (2 crates: zune-core): `JpegDecoder::new(&data).decode()? -> Vec<u8>`; options via `new_with_options(.., DecoderOptions)`; CMYK/gray supported; default features x86, neon, std (SIMD intrinsics, `unsafe` only there). hayro already pulls both, so cost is shared if hayro ships.
- miniz_oxide 0.9.1: pure-Rust deflate/inflate; already transitive via png/flate2; add directly only for raw zlib needs.
- lexopt 0.3.2: 0 deps, ~37 KiB release overhead vs clap 574 KiB, clap-minimal 377 KiB (rosetta-rs/argparse-rosetta-rs, snapshot date UNVERIFIED). clap deps: default 11 crates, derive 17, `default-features=false, features=["std"]` 4. Use lexopt.

### Stack weight (Linux musl, my resolver)
- tokio+hyper+rustls(ring)+tungstenite[handshake]+mdns-sd+nusb+serde(derive)+png+zune-jpeg+hayro+lexopt = 141 crates (macOS +objc2 min = 147; Windows +windows-sys = 140). hayro is 77 of them. Adding ksni: 183.
```toml
[dependencies]
tokio = { version = "1.54.1", features = ["rt","net","time","sync","io-util"] }
hyper = { version = "1.12.0", default-features = false, features = ["client","http1"] }
hyper-util = { version = "0.1.21", default-features = false, features = ["tokio"] }
http-body-util = "0.1.5"
tokio-tungstenite = { version = "0.30.0", default-features = false, features = ["handshake"] }
mdns-sd = { version = "0.22.0", default-features = false, features = ["async"] }
nusb = "0.2.9"
lexopt = "0.3.2"
```

## 2. Tray / menu bar

Source: crates.io API (features/deps), objc2-app-kit-0.3.2 src/generated/*.rs, dispatch2-0.3.1 src, windows-sys-0.61.2 src, https://github.com/iovxw/ksni, https://developer.apple.com/documentation/bundleresources/information-property-list/lsuielement, MS Learn Window Features + Shell_NotifyIcon.

### macOS (objc2 0.6.5, objc2-app-kit 0.3.2, objc2-foundation 0.3.2; Zlib OR Apache-2.0 OR MIT)
- SURPRISE: objc2-app-kit default features enable ALL ~315 class features plus cloud-kit/core-data/core-image/etc; objc2-foundation default = 175. Always `default-features=false`. tray-icon uses exactly: std, objc2-core-foundation, NSButton, NSCell, NSControl, NSEvent, NSImage, NSMenu, NSResponder, NSStatusBar, NSStatusBarButton, NSStatusItem, NSTrackingArea, NSView, NSWindow. Minimal set for a status item + menu: std, NSApplication, NSStatusBar, NSStatusItem, NSStatusBarButton, NSMenu, NSMenuItem, NSButton, NSControl, NSView, NSResponder (+NSImage for icons) = 6 crates total (objc2, objc2-encode, objc2-foundation, objc2-core-foundation, objc2-app-kit, bitflags).
```toml
objc2 = "0.6.5"
objc2-foundation = { version = "0.3.2", default-features = false, features = ["std", "NSString"] }
objc2-app-kit = { version = "0.3.2", default-features = false, features = ["std","NSApplication","NSStatusBar","NSStatusItem","NSStatusBarButton","NSMenu","NSMenuItem","NSButton","NSControl","NSView","NSResponder","NSImage"] }
dispatch2 = "0.3.1"
```
- Verified signatures: `NSStatusBar::systemStatusBar()`, `statusItemWithLength(NSVariableStatusItemLength)`, `NSStatusItem::button(mtm) -> Option<Retained<NSStatusBarButton>>`, `setMenu(Option<&NSMenu>)`, `NSMenu::new(mtm)`, `addItem`, `unsafe NSMenuItem::initWithTitle_action_keyEquivalent`, `NSApplication::sharedApplication(mtm)`, `setActivationPolicy`, `run()`, `NSImage::setTemplate(bool)`.
```rust
let mtm = MainThreadMarker::new().expect("main thread");
std::thread::spawn(|| { /* current_thread tokio runtime + bridge */ });
let app = NSApplication::sharedApplication(mtm);
app.setActivationPolicy(NSApplicationActivationPolicy::Accessory);
let item = NSStatusBar::systemStatusBar().statusItemWithLength(NSVariableStatusItemLength);
if let Some(b) = item.button(mtm) { b.setTitle(&NSString::from_str("PB")); }
let menu = NSMenu::new(mtm);
let quit = unsafe { NSMenuItem::initWithTitle_action_keyEquivalent(mtm.alloc(),
    &NSString::from_str("Quit"), Some(sel!(terminate:)), &NSString::from_str("q")) };
menu.addItem(&quit);
item.setMenu(Some(&menu));
app.run(); // blocks main thread; keep `item` alive until here
```
- Cross-thread updates: `dispatch2::DispatchQueue::main().exec_async(|| ..)` (or `dispatch2::run_on_main`); UI objects are !Send, store them in `MainThreadBound`/thread_local on the main thread. Custom actions need a `define_class!` target (not shown).
- LSUIElement (Info.plist, boolean): "agent app that runs in the background and doesn't appear in the Dock" (Apple). Ship as .app (CFBundleIdentifier, LSUIElement=true, NSLocalNetworkUsageDescription); a bare binary can use Accessory policy but lacks bundle identity for privacy/Login Items (section 5).

### Windows (windows-sys 0.61.2, hand-rolled; no extra crates)
- Features: `Win32_Foundation`, `Win32_Graphics_Gdi` (gates WNDCLASSW/RegisterClassW), `Win32_System_LibraryLoader` (GetModuleHandleW), `Win32_UI_Shell` (Shell_NotifyIconW), `Win32_UI_WindowsAndMessaging` (NOTIFYICONDATAW is gated on it; windows, menus, CreatePopupMenu, TrackPopupMenu, LoadIconW, CreateIconFromResourceEx). windows-sys has Win32 flat APIs only (no COM wrappers).
- Flow: RegisterClassW, CreateWindowExW (hidden), `Shell_NotifyIconW(NIM_ADD)` with NIF_MESSAGE|NIF_ICON|NIF_TIP|NIF_SHOWTIP and uCallbackMessage=WM_APP+1, then `NIM_SETVERSION` with uVersion=NOTIFYICON_VERSION_4 (MS: must be called after every NIM_ADD, not persisted across logoff; v4 sends WM_CONTEXTMENU/NIN_SELECT in LOWORD(lParam)). On context menu: SetForegroundWindow(hwnd), CreatePopupMenu, AppendMenuW(MF_STRING|MF_SEPARATOR), TrackPopupMenu(TPM_RIGHTBUTTON), then PostMessageW(WM_NULL) (classic dismiss workaround, UNVERIFIED), DestroyMenu. `NIM_DELETE` on exit. Loop: GetMessageW/TranslateMessage/DispatchMessageW.
- Gotcha: MS says message-only windows (HWND_MESSAGE) "do not receive broadcast messages", so they cannot get the `TaskbarCreated` broadcast (RegisterWindowMessageW) used to re-add the icon after Explorer restarts (inference). Use an unshown top-level window.
- Icon without a resource compiler (zig-friendly): `CreateIconFromResourceEx` from embedded PNG/ICO bytes (UNVERIFIED for PNG payload) instead of `.rc` + embed-resource.

### Linux
- ksni 0.3.7 (Unlicense/public domain): pure D-Bus StatusNotifierItem, no GTK, musl-static OK. Deps: zbus 5 (tokio feature default), arc-swap, crossbeam-queue, futures-util, pastey, serde; 66 crates standalone (+42 over the base stack). Features `tokio` (default) | `async-io` | `blocking`. README warns of a zbus tokio runtime panic (z-galaxy/zbus#526). API: `impl ksni::Tray` (id, icon_name, title, menu -> Vec<MenuItem>), `tray.spawn().await`, `handle.update(..)`. Needs an SNI host: KDE native; GNOME needs the AppIndicator extension (README screenshot caption); Raspberry Pi OS panel support UNVERIFIED. Headless Pi: no tray at all.
- tray-icon 0.26.1 (MSRV 1.90): default feature `libappindicator` = GTK3 + libappindicator system libs (dynamic C, breaks static musl and zig cross-builds). Its `ksni` feature works (92 crates with muda). Not recommended.
- Recommendation: macOS objc2 hand-rolled; Windows windows-sys hand-rolled; Linux ksni behind an optional `tray` cargo feature or separate binary. Keep the tray a separate process from the daemon (IPC over local socket); mandatory on macOS (section 5).

## 3. Windows printing (windows-sys 0.61.2)

Source: windows-sys-0.61.2 src/Windows/Win32/{Graphics/Printing,Graphics/Gdi,Storage/Xps,System/Registry}/mod.rs; MS Learn EnumPrinters, PRINTER_INFO_2, CreateDCW, Run and RunOnce Registry Keys.
```toml
[target.'cfg(windows)'.dependencies]
windows-sys = { version = "0.61.2", features = ["Win32_Foundation","Win32_Graphics_Gdi","Win32_Graphics_Printing","Win32_Security","Win32_Storage_Xps","Win32_System_Registry","Win32_System_LibraryLoader","Win32_UI_Shell","Win32_UI_WindowsAndMessaging"] }
```
- SURPRISE: `StartDocW`, `EndDoc` (no W variant), `StartPage`, `EndPage`, `AbortDoc`, `SetAbortProc`, `DOCINFOW` live in `Win32_Storage_Xps` (+Gdi), not Win32_Graphics_Gdi. `OpenPrinterW` needs Gdi (PRINTER_DEFAULTSW); `PRINTER_INFO_2W` needs Gdi+Security; `RegCreateKeyExW` needs Security. `PRINTER_STATUS_*`, DOC_INFO_1W, PRINTER_INFO_4W, EnumPrintersW, GetPrinterW, WritePrinter need only Win32_Graphics_Printing. No Task Scheduler COM in windows-sys.
- Enumerate: `EnumPrintersW(PRINTER_ENUM_LOCAL|PRINTER_ENUM_CONNECTIONS, null, level, buf, cb, &needed, &count)`, two-call pattern (first call fails with ERROR_INSUFFICIENT_BUFFER, read `pcbNeeded`). MS: level 4 (PRINTER_INFO_4W: name, server, attributes) is "extremely fast" (registry/local cache), only LOCAL/CONNECTIONS valid, Name must be NULL; level 2 does OpenPrinter on every remote connection and can block on RPC timeouts. So: list with level 4, then `OpenPrinterW` + `GetPrinterW(h, 2, ..)` for the printers you use. Call on a blocking thread (docs: synchronous, may stall).
- Status (PRINTER_INFO_2W.Status bitmask): BUSY, DOOR_OPEN, ERROR, INITIALIZING, IO_ACTIVE, MANUAL_FEED, NO_TONER, NOT_AVAILABLE, OFFLINE, OUT_OF_MEMORY, OUTPUT_BIN_FULL, PAGE_PUNT, PAPER_JAM, PAPER_OUT, PAPER_PROBLEM, PAUSED, PENDING_DELETION, POWER_SAVE, PRINTING, PROCESSING, SERVER_UNKNOWN, TONER_LOW, USER_INTERVENTION, WAITING, WARMING_UP. Idle = no bit set (inference). `Attributes & PRINTER_ATTRIBUTE_WORK_OFFLINE` is separate; also `cJobs`.
- RAW: `OpenPrinterW(name, &mut h, null)`; `DOC_INFO_1W{pDocName, pOutputFile: null, pDatatype: "RAW"}`; `StartDocPrinterW(h, 1, &di)` (0 = failure, else job id), `StartPagePrinter`, loop `WritePrinter(h, ptr, len, &mut written)` checking `written`, `EndPagePrinter`, `EndDocPrinter`, `ClosePrinter`. Printers with PRINTER_ATTRIBUTE_RAW_ONLY or XPS-only/IPP class drivers may reject "RAW" (UNVERIFIED); fall back to GDI.
- GDI bitmap path: `CreateDCW(null, printer_name, null, devmode_or_null)` (MS: pass NULL driver for printers; device = name shown in Print Manager; DC is single-thread; `DeleteDC` when done; get DEVMODE via DocumentPropertiesW for paper/quality). Then `StartDocW(hdc, &DOCINFOW{cbSize, lpszDocName, ..})` (>0 = job id), per page `StartPage`, draw, `EndPage`, finally `EndDoc` (`AbortDoc` on error).
- Geometry via `GetDeviceCaps(hdc, idx)`: HORZRES/VERTRES = printable pixels, LOGPIXELSX/Y = DPI, PHYSICALWIDTH/HEIGHT = paper in device px, PHYSICALOFFSETX/Y = unprintable margin. GDI origin is the printable-area corner: to place on paper coordinates draw at (-PHYSICALOFFSETX, -PHYSICALOFFSETY). Render with hayro at `scale = LOGPIXELSX/72` for 1:1.
- Draw: `SetStretchBltMode(hdc, HALFTONE)`; `StretchDIBits(hdc, dx,dy,dw,dh, 0,0,w,h, bits, &BITMAPINFO, DIB_RGB_COLORS, SRCCOPY)` with BITMAPINFOHEADER{biHeight = -h (top-down), biBitCount 24 or 32, biCompression BI_RGB}; pixel order is BGR(A), so convert from hayro RGBA. Large pages (600 dpi Letter 24-bit ~101 MB): send in horizontal bands (~512 rows; driver limits UNVERIFIED).
- Autostart: HKCU\Software\Microsoft\Windows\CurrentVersion\Run (REG_SZ via `RegCreateKeyExW`/`RegSetValueExW`/`RegDeleteValueW`); no admin; MS: value is a command line "no longer than 260 characters", runs at each logon, system may delay Run programs, ignored in Safe Mode. Explorer/Task Manager disable state is stored separately under ...\Explorer\StartupApproved\Run (secondary sources; UNVERIFIED), so never force-re-enable. Task Scheduler (logon trigger gives elevation, delay, other account, restart policies) has no windows-sys bindings: shell out to `schtasks /Create /XML` or add the heavier `windows` crate. Recommend HKCU Run; a Windows service cannot own the tray (session 0; UNVERIFIED detail).

## 4. Cross-compiling from macOS arm64

Source: cargo-zigbuild 0.24.1 tarball (src/zig/*.rs, README), https://github.com/rust-cross/cargo-xwin and 0.23.1 tarball, https://doc.rust-lang.org/rustc/platform-support.html, ring-0.17.14 build.rs, rustc compiler/rustc_codegen_ssa/src/common.rs, `zig targets`, local `rustup target list --installed`.
- Installed: aarch64/x86_64-apple-darwin, aarch64/x86_64-unknown-linux-musl. `lipo`, `codesign`, `xcrun notarytool` (1.1.3) present. `x86_64-w64-mingw32-dlltool` and `llvm-dlltool` are NOT on PATH. `zig targets` lists arm-linux-musleabihf, aarch64-windows-gnu.
- To add (not run): `armv7-unknown-linux-musleabihf` (Tier 2, no host tools), `arm-unknown-linux-musleabihf` (Tier 2, ARMv6 hardfloat, features +strict-align,+v6,+vfp2, max atomics 64), `x86_64-pc-windows-gnullvm`, `aarch64-pc-windows-gnullvm` (both Tier 2 with host tools); alternatives `x86_64-pc-windows-gnu` (Tier 1), `x86_64/aarch64-pc-windows-msvc` (Tier 1, for cargo-xwin).
- macOS: no zig needed. `cargo build --release --target aarch64-apple-darwin` and `--target x86_64-apple-darwin`, then `lipo -create -output pb target/*/release/pb`. cargo-zigbuild also offers `--target universal2-apple-darwin` (README; `--message-format` unsupported). Set `MACOSX_DEPLOYMENT_TARGET=13.0` (SMAppService needs 13+).
- Linux musl: `cargo zigbuild --release --target aarch64-unknown-linux-musl` (static; `+crt-static` for glibc unsupported, musl is the route). ring compiles its C/asm with zig cc via zigbuild's wrapper.
- armv7: zigbuild default `-mcpu=generic+v7a+vfp3-d32+thumb2-neon` for C code (wrapper.rs:108) differs from rustc's armv7 musl spec (VFPv3-D16, no NEON per my memory, UNVERIFIED); fine on Pi 2+.
- armv6 (Pi Zero/1): zigbuild defaults `-mcpu=generic+v6+strict_align+vfp2-d32` (`no_unaligned_access` on zig >=0.18; wrapper.rs:83-96), so it is designed for this. RISK UNVERIFIED: ring 0.17.14 ARM asm (armv4-mont, bsaes-armv7, vpaes-armv7 `.S`, `.arch armv7-a`) is assembled for an ARMv6 target and NEON is runtime-gated via getauxval (src/cpu/arm.rs); ring documents no ARMv6 support and I found no confirmation it runs on ARM1176. Test on real Pi Zero/qemu before committing to it; fallback is a pure-Rust rustls provider.
- Windows via zig: zigbuild README lists only Linux/macOS and shows a stale `+nightly` Windows example, but 0.24.1 source handles Windows GNU: it creates `{x86_64,i686,aarch64}-w64-mingw32-dlltool` wrappers to `zig dlltool` when no system dlltool exists (src/zig/wrapper.rs:335-348).
- windows-sys + dlltool: windows-sys 0.61.2 -> windows-link 0.2.1 uses `raw-dylib` on every Windows target. rustc calls an external dlltool only when `os==windows && env==gnu && abi unspecified` (rustc common.rs `is_using_dlltool`), i.e. `*-pc-windows-gnu`; `*-windows-gnullvm` (abi llvm) uses LLVM's import-lib writer. So prefer gnullvm via zigbuild; plain gnu works only through zigbuild's dlltool shim. UNVERIFIED end to end (e.g. whether zig supplies libunwind for gnullvm).
- ring on Windows (build.rs ASM_TARGETS): x86_64 uses pregenerated NASM `.o` files shipped in the crate (no nasm needed; `.S` excluded); aarch64 uses pregenerated `win64` `.S` assembled by the C compiler. No env-specific gating, so gnu/gnullvm/msvc all plausible; UNVERIFIED in practice.
- cargo-xwin 0.23.1 (MSVC ABI): `cargo xwin build --target x86_64-pc-windows-msvc`; needs clang (`brew install llvm`, README), downloads MS CRT/SDK after license acceptance (https://go.microsoft.com/fwlink/?LinkId=2086102), `XWIN_ARCH` default x86_64,aarch64; `aarch64-pc-windows-msvc` not shown as an example target (source maps aarch64 to ARM64), UNVERIFIED. Safest release path for Windows: build natively on Windows CI runners; use zigbuild gnullvm for local smoke builds.
- musl gotcha: musl has no NSS, so nss-mdns `.local` names will not resolve through getaddrinfo in static binaries (UNVERIFIED: the musl functional-differences wiki page does not state it). Use mdns-sd resolved IPs. musl DNS-over-TCP needs musl >=1.2.4 (Rust targets ship 1.2.5, verified).

## 5. macOS: Local Network privacy, entitlements, LaunchAgent

Source: Apple TN3179 (https://developer.apple.com/documentation/technotes/tn3179-understanding-local-network-privacy, via the tutorials JSON endpoint), Apple DTS thread https://developer.apple.com/forums/thread/763753, https://eclecticlight.co/2026/01/14/how-local-network-privacy-could-affect-you/, Apple Hardened Runtime + entitlement pages, launchd.plist(5), SMAppService docs.
- Needs local network access (TN3179): outgoing TCP connect, UDP send (unicast, multicast, broadcast), connecting a UDP socket, receiving UDP multicast/broadcast, resolving `.local`, all Bonjour ops. Not needed: listen/accept TCP, receive UDP unicast. Checked in the kernel stack, so it covers BSD sockets, i.e. mdns-sd (multicast 224.0.0.251) and raw 9100/IPP connects. No multicast entitlement on macOS (iOS only).
- Exempt (no prompt, not listed): any daemon started by launchd, any process running as root, command-line tools run from Terminal/SSH (and children). "The exception for launchd daemons doesn't apply to launchd agents."
- Plain CLI binary: from Terminal it is exempt. Started by a LaunchAgent it is NOT exempt and needs a responsible app: either an .app bundle that registers it via SMAppService, or `AssociatedBundleIdentifiers` in a hand-installed plist. Standalone executables that do need the key must embed an Info.plist section (Xcode: "Create Info.plist Section in Binary"; the Rust linker flag `-sectcreate __TEXT __info_plist` is UNVERIFIED).
- .app (menu bar): Info.plist needs `NSLocalNetworkUsageDescription`; the first LAN operation raises the user prompt, decision stored per user in System Settings > Privacy & Security > Local Network. `NSBonjourServices` is for Bonjour-API browse/register; mdns-sd uses raw sockets, so enforcement does not depend on it (UNVERIFIED), but listing `_ipp._tcp`, `_ipps._tcp`, `_printer._tcp`, `_pdl-datastream._tcp` is harmless.
- Identity: tracked by code signature; ad hoc/unsigned is unreliable, sign with Developer ID (TN3179). Main executable needs a unique LC_UUID (default linker behavior; do not strip it). No reset API before the Settings (-) button (TN3179 says "macOS 27.2"); testing workaround: new user account or VM snapshot.
- Prompt quirks: processes that exit right after a denied LAN call may never show the alert (FB16131937), so do not exit on first failure. Trigger it on purpose (TN3179): connect a UDP socket to a LAN address (no packet sent).
- Daemon caveats (Apple DTS): root LaunchDaemon "should always be allowed", but 15.0 had a bad bug (fixed in 15.1+) and a known DNS/LNP bug (r. 133953401) can still block it; running a daemon with `UserName` is "an unsupported configuration". DTS design advice: put persistent network + privilege in a daemon, UI agent talks to it over IPC.
- Recommendation: root LaunchDaemon (printing, mDNS, WSS; zero prompts, nothing to click) + signed LSUIElement tray .app (agent) over a unix socket. If one agent process is preferred, expect one Allow prompt and run it as a bundle. Cost: daemon install needs admin approval once (pkg or SMAppService.daemon).
- Hardened runtime: Apple's entitlement list has runtime exceptions (allow-jit, allow-unsigned-executable-memory, allow-dyld-environment-variables, disable-library-validation, disable-executable-page-protection, debugger) and resource access (audio-input, camera, location, addressbook, calendars, photos, apple-events). No network or USB entry; `com.apple.security.device.usb` is documented for the App Sandbox. A non-sandboxed Developer ID app signed with `codesign --options runtime` + notarized needs no entitlements for sockets, mDNS, USB or CUPS (Rust has no JIT). Sandbox-only entitlements (network.client/server, device.usb, print) matter only for a Mac App Store build; the network ones were not re-fetched (UNVERIFIED).
- LaunchAgent plist (keys verified in launchd.plist(5)): `Label`, `ProgramArguments` (absolute), `RunAtLoad` true, `KeepAlive` dict `{SuccessfulExit=false}` (restart on crash, not on clean quit; `NetworkState` is "not implemented"), `ThrottleInterval` (default 10 s), `ProcessType` (Background/Adaptive/Interactive), `LimitLoadToSessionType` Aqua, `AssociatedBundleIdentifiers`, `StandardOutPath`/`StandardErrorPath`, `EnvironmentVariables`. Location `~/Library/LaunchAgents/<Label>.plist`; load with `launchctl bootstrap gui/$(id -u) <plist>` (UNVERIFIED flag details). Daemons: `/Library/LaunchDaemons` root:wheel (ownership rule UNVERIFIED).
- SMAppService (macOS 13+): `mainApp`, `agent(plistName:)`, `daemon(plistName:)`, `register()` "subject to user approval", plists inside the bundle (location UNVERIFIED). Rust binding crate `objc2-service-management` not checked (crates.io rate limit); otherwise a tiny Swift helper or write plist + launchctl.

## 6. Linux: systemd, USB, CUPS

Source: systemd.resource-control (https://www.freedesktop.org/software/systemd/man/latest/systemd.resource-control.html), systemd rules.d/50-udev-default.rules.in and 70-uaccess.rules.in (raw.githubusercontent.com/systemd/systemd/main), ChromiumOS 75-usbprinter.rules, CUPS backend/usb-libusb.c, nusb-0.2.9 src/device.rs.
- Service model: system unit running as a dedicated user (`User=printbetter`, `SupplementaryGroups=lp`). A headless Pi has no login session, and a `--user` unit needs `loginctl enable-linger`. Run the tray (if any) as a separate user unit/autostart.
```ini
[Service]
User=printbetter
SupplementaryGroups=lp
StateDirectory=print-better
ExecStart=/usr/local/bin/print-better run
Restart=on-failure
RestartSec=5
NoNewPrivileges=yes
ProtectSystem=strict
ProtectHome=yes
PrivateTmp=yes
ProtectKernelTunables=yes
ProtectControlGroups=yes
LockPersonality=yes
RestrictNamespaces=yes
RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6 AF_NETLINK
SystemCallFilter=@system-service
CapabilityBoundingSet=
DevicePolicy=closed
DeviceAllow=char-usb_device rw
DeviceAllow=char-usb rw
```
- Do NOT set `PrivateDevices=yes` (hides /dev/bus/usb and /dev/usb/lp*). `DeviceAllow=` names come from /proc/devices: `usb_device` (/dev/bus/usb) and `usb` (usblp, /dev/usb/lp*) are my expectation (UNVERIFIED, check `grep usb /proc/devices`); with DevicePolicy `auto`, any DeviceAllow entry already switches to closed behavior (man page), and groups missing at start are silently dropped. Validate with `systemd-analyze security` and strace.
- AF_NETLINK is required for nusb hotplug (rustix net, uevent) and likely musl getifaddrs/if-addrs (UNVERIFIED). mDNS needs no capability (UDP 5353 with SO_REUSEPORT, unprivileged) but needs inbound UDP 5353 open; coexists with avahi-daemon (UNVERIFIED).
- CUPS: talk IPP over `/run/cups/cups.sock` (connecting needs no write to the filesystem; ProtectSystem=strict is fine, UNVERIFIED) or `localhost:631`; prefer CUPS for queues cupsd already manages, because cupsd's libusb backend claims the interface (and detaches usblp) and a second claimant gets Busy.
- Defaults (verified in 50-udev-default.rules.in): usb_device nodes are `MODE="0664"` root:root (line 76), so a non-root nusb open (needs write) fails; `KERNEL=="lp[0-9]*", GROUP="lp"` (line 91) covers /dev/usb/lp* (group lp, 0660 typical); the `usb_id` builtin sets `ID_USB_INTERFACES` (line 20). 70-uaccess.rules.in has no printer-class entry (only scanners, 3D printers etc.), so printers get no ACL by default.
- `/etc/udev/rules.d/70-print-better.rules` (pattern from ChromiumOS 75-usbprinter.rules `*:0701??:*`):
```
SUBSYSTEM=="usb", ENV{DEVTYPE}=="usb_device", ENV{ID_USB_INTERFACES}=="*:0701??:*", GROUP="lp", MODE="0660", TAG+="uaccess"
```
  then `udevadm control --reload && udevadm trigger -s usb`. GROUP+MODE serves the service user; `uaccess` adds an ACL for the logged-in desktop user only (not service users). Matches any printer-class interface, including MFPs (composite). Rule ordering vs usb_id is fine at prefix 70 (usb_id runs in 50).
- Direct /dev/usb/lp0 writes (std::fs) need no nusb but are unidirectional and give no GET_DEVICE_ID; usblp ioctl for the ID exists (UNVERIFIED). Pick one owner per device: cupsd, usblp/lp node, or nusb.

## Open risks (UNVERIFIED, test first)
- ring 0.17.14 on ARMv6 hardware; gnullvm link with zig (libunwind); cargo-xwin aarch64-msvc; Pi Zero hayro performance.
- LNP behavior of mdns-sd raw sockets inside a signed .app on macOS 15/26 and 27.x; LaunchDaemon exemption with the 15.x DNS bug.
- nusb claim on macOS for printer-class interfaces; Windows RAW datatype on XPS/IPP class drivers.
