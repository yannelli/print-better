# Print Better: Printing Protocol Research (as of 2026-11-18)

The Print Better client has to find printers on the LAN, read what they support, and send them jobs in a format they accept. It also shares those printers to phones and laptops as AirPrint/IPP Everywhere printers, and has to run on a Raspberry Pi set up on first boot.

Markers used below:
- [V]: read in the primary text this session.
- [I]: inference.
- UNVERIFIED: not confirmed.

All integers are big-endian. Sources are listed under each section.

## 1. IPP Wire Encoding
An IPP request is an HTTP POST with Content-Type `application/ipp`. The body is a short binary header, groups of tagged attributes, an end tag (03), and then the document bytes. The response uses the same layout with a status code in place of the operation id.

Sources: RFC 8010 (rfc-editor.org/rfc/rfc8010), RFC 8011 (.../rfc8011), IANA IPP registry (iana.org/assignments/ipp-registrations/ipp-registrations.xml), cups.org/doc/spec-ipp.html

```
message = version(2) op-id|status(2) request-id(4, 1..2^31-1) group* 03 data?
group   = group-tag(1) attr*
attr    = value-tag(1) name-len(2) name value-len(2) value
more    = value-tag(1) 00 00 value-len(2) value        (next value of previous attr)
```

Versions: 0101=1.1, 0200=2.0, 0201=2.1, 0202=2.2. First two operation attrs MUST be attributes-charset then attributes-natural-language [V 8011 4.1.4].

| Class | Tags (hex) |
|---|---|
| Group (IANA) | 01 operation, 02 job, 03 end, 04 printer, 05 unsupported, 06 subscription, 07 event, 08 resource, 09 document, 0A system |
| Out-of-band (len 0) | 10 unsupported, 12 unknown, 13 no-value, 15 not-settable, 16 delete-attribute, 17 admin-define |
| Numeric | 21 integer(4), 22 boolean(1), 23 enum(4), 33 rangeOfInteger(8: lo,hi), 32 resolution(9: xres i32, yres i32, unit i8; 3=dpi 4=dpcm), 31 dateTime(11) |
| Strings | 41 text, 42 name, 44 keyword, 45 uri, 46 uriScheme, 47 charset, 48 naturalLanguage, 49 mimeMediaType, 4A memberAttrName, 30 octetString, 7F extension (next 4 bytes = real tag) |
| Collection | 34 begCollection, 35 textWithLanguage, 36 nameWithLanguage, 37 endCollection |

WithLanguage value = len(2) lang len(2) text. Collection (RFC 8010 3.1.6/3.1.7):
```
34 name-len name 00 00                    begCollection, value-len 0 (more values: 34 00 00 00 00)
  4A 00 00 len member-name  <tag> 00 00 len member-value     (repeat per member)
37 00 00 00 00                            endCollection (nested member collection uses the same 34..37 form [I])
```
Operations (hex): 0002 Print-Job, 0003 Print-URI, 0004 Validate-Job, 0005 Create-Job, 0006 Send-Document, 0007 Send-URI, 0008 Cancel-Job, 0009 Get-Job-Attributes, 000A Get-Jobs, 000B Get-Printer-Attributes, 000C Hold-Job, 000D Release-Job, 000E Restart-Job, 0010 Pause-Printer, 0011 Resume-Printer, 0015 Get-Printer-Supported-Values, 0039 Cancel-My-Jobs, 003B Close-Job, 003C Identify-Printer (PWG 5100.13). CUPS vendor: 4001 CUPS-Get-Default, 4002 CUPS-Get-Printers, 4027 CUPS-Get-Document (CUPS servers only; attrs: first-printer-name, limit, printer-id, printer-location, printer-type(+mask), requested-attributes, requested-user-name).

Job operations:
- Print-Job request: group 01: attributes-charset(47) "utf-8", attributes-natural-language(48) "en", printer-uri(45, absolute ipp/ipps), then optional requesting-user-name(42, SHOULD), job-name(42), ipp-attribute-fidelity(22), document-name(42), document-format(49), compression(44). Group 02 Job Template (copies, sides, media, media-col, print-color-mode, printer-resolution, print-quality, orientation-requested, page-ranges). Then 03, then raw document bytes.
- Print-Job response: group 01 (+05 unsupported) + group 02: job-id, job-uri, job-state, job-state-reasons.
- Validate-Job = same minus data.
- Create-Job returns job-id; Send-Document needs job-id (or job-uri), last-document(22, REQUIRED) and data.
- Cancel-Job: printer-uri+job-id or job-uri.
- Get-Jobs: which-jobs (completed|not-completed), my-jobs, limit, requested-attributes (default only job-uri, job-id).
- Identify-Printer: identify-actions (sound and display confirmed [V CUPS tests]; flash, speak UNVERIFIED) + message for display.
- ipp-attribute-fidelity=false: printer accepts and may substitute (0001 + group 05 lists what it ignored); true: rejects with 040B; Validate-Job first to probe [V 8011 4.2.1].
- dateTime(31) = year(2) month day hour min sec decisec dir('+'/'-') utc-hour utc-min.

Get-Printer-Attributes example (180 bytes, built and checked):
```
02 00 00 0B 00 00 00 01 01
47 0012 "attributes-charset" 0005 "utf-8"   48 001B "attributes-natural-language" 0002 "en"
45 000B "printer-uri" 001C "ipp://10.0.0.5:631/ipp/print"
44 0014 "requested-attributes" 000D "printer-state"   44 0000 0015 "printer-state-reasons"   03
```
HTTP [V 8010 s4-5]:
- POST to the printer path, Content-Type: application/ipp, Host required.
- ipp:// maps to http://host:631, ipps:// to https://host:631 (both default port 631); printer-uri in the body stays ipp(s):// and MUST name the same object as the request target.
- Servers MUST accept chunked requests; clients MUST accept chunked responses; a server MAY answer early (even before reading the body) or send 100 Continue. CUPS client sends `Expect: 100-continue` on POST (cups/http.c) [V]. Sending Content-Length when size is known is the safer default for embedded servers [I].
- IPP Everywhere also demands Host validation and `Cache-Control: no-cache` on POST responses [V 5100.14 5.1].
- TLS on the ipp scheme is HTTP Upgrade (RFC 2817, `Upgrade: TLS/1.2`, advertised by TXT TLS=1.2 [V Bonjour 9.2.14; ippeveprinter handles it]); ipps is TLS from byte 0.

| Enum | Values |
|---|---|
| job-state | 3 pending, 4 pending-held, 5 processing, 6 processing-stopped, 7 canceled, 8 aborted, 9 completed (final: 7/8/9) |
| printer-state | 3 idle, 4 processing, 5 stopped |
| status-code | 0000 ok, 0001 ok-ignored-or-substituted-attributes, 0002 ok-conflicting-attributes, 0400 bad-request, 0401 forbidden, 0402 not-authenticated, 0403 not-authorized, 0404 not-possible, 0405 timeout, 0406 not-found, 0407 gone, 0408 entity-too-large, 040A document-format-not-supported, 040B attributes-or-values-not-supported, 040E conflicting-attributes, 0411 document-format-error, 0412 document-access-error, 0500 internal-error, 0501 operation-not-supported, 0502 service-unavailable, 0503 version-not-supported, 0504 device-error, 0505 temporary-error, 0506 not-accepting-jobs, 0507 busy, 0508 job-canceled |

printer-state-reasons: keyword plus optional `-report|-warning|-error`; any `-error` forces printer-state=stopped; no suffix means error if stopped else warning. Surface: media-empty, media-needed, media-low, media-jam, toner-empty, toner-low, marker-supply-empty, marker-supply-low, marker-waste-almost-full, marker-waste-full, cover-open, door-open, input-tray-missing, output-area-full, output-area-almost-full, paused, shutdown, timed-out, spool-area-full, connecting-to-device, other, interpreter-resource-unavailable, fuser-over-temp, opc-life-over (all in RFC 8011), identify-printer-requested (IANA, PWG 5100.13). `offline-report` is NOT in RFC 8011, IANA, or CUPS master backends: no standard "offline" keyword; treat connect failure as offline yourself.

## 2. Capability Model (Get-Printer-Attributes)
Sources: RFC 8011 4.2.5, PWG 5100.14 v1.1 (ftp.pwg.org/pub/pwg/candidates/cs-ippeve11-20200515-5100.14.pdf) tables 5-7, PWG 5102.4, cups.org/doc/spec-ipp.html. Omit requested-attributes = "all". Pass `document-format` to get per-format values.

| Attribute | Syntax / notes |
|---|---|
| document-format-supported/default | 1setOf mimeMediaType; drop application/octet-stream when advertising |
| media-supported, media-ready | keyword/name, PWG 5101.1 style `iso_a4_210x297mm` (name format from memory, UNVERIFIED) |
| media-col-database / media-col-ready | 1setOf collection: media-size{x-dimension,y-dimension} in 1/100 mm (integer, or rangeOfInteger for custom; roll: x int, y range), media-source, media-type, margins; portrait axes |
| sides-supported | one-sided, two-sided-long-edge, two-sided-short-edge |
| print-color-mode-supported | PWG 5100.13: auto, color, monochrome (+ bi-level, process-monochrome UNVERIFIED) |
| printer-resolution-supported | 1setOf resolution (tag 32) |
| pwg-raster-document-resolution-supported / -type-supported / -sheet-back | resolutions; keywords sgray_8, srgb_8, black_1, cmyk_8...; normal/flipped/rotated/manual-tumble [V sheet-back values: Normal, Flipped, Rotated, ManualTumble] |
| urf-supported | 1setOf keyword (see 3) |
| copies-supported | rangeOfInteger |
| marker-names/types/levels/low-levels/high-levels/colors/message | levels 0-100; -1 unavailable, -2 unknown, -3 unknown-but-not-empty [V CUPS]; colors "#RRGGBB"; types toner, ink, waste-ink |
| printer-uuid, printer-more-info, printer-device-id, printer-make-and-model, printer-location, printer-info | uuid is `urn:uuid:...` (TXT UUID drops prefix); more-info URI max 1023 (TXT adminurl max 246) |
| printer-state, printer-state-reasons, printer-is-accepting-jobs, queued-job-count, printer-state-change-time | poll these; rest only at add-time |
| ipp-versions-supported, ipp-features-supported (`ipp-everywhere`), operations-supported, identify-actions-supported, uri-security-supported, uri-authentication-supported, printer-uri-supported | drive capability gating |

Printers may return link-local or foreign-host URIs in more-info/icons: rewrite to the address you connected to [I].

## 3. Sharing via DNS-SD (IPP Everywhere + AirPrint)
A printer shares itself by registering DNS-SD services over multicast DNS. A PTR record names the instance, SRV gives the host and port, and TXT carries capability keys. Clients browse for `_ipp._tcp` (and subtypes such as `_universal` for AirPrint), then talk IPP to the advertised host.

Sources: PWG 5100.14 s4.2 and s5; Apple Bonjour Printing Spec 1.2.1 (developer.apple.com/bonjour/printing-specification/bonjourprinting-1.2.1.pdf); Apple deployment guide (support.apple.com/guide/deployment/airprint-payload-settings-dep3b4cf515/web); CUPS scheduler/dirsvc.c + conf.c; PAPPL pappl/dnssd.c; Microsoft Printers CSP.

| Registration | Port | Notes |
|---|---|---|
| `Name._printer._tcp` | 0 | LPD placeholder defends the name ("flagship naming"); MUST in 5100.14 4.2.2 and Bonjour 7.6 |
| `Name._ipp._tcp` + subtypes `_universal._sub._ipp._tcp` (AirPrint), `_print._sub._ipp._tcp` (IPP Everywhere) | IPP port | CUPS default subtypes `_cups,_print,_universal` [V conf.c:832]; Apple: `dns-sd -Z _ipp._tcp,_universal` finds AirPrint printers |
| `Name._ipps._tcp` + `_universal`, `_print` subtypes | same port ok | PAPPL serves ipp and ipps on one port |
| LOC record | | MUST per 5100.14 4.2.3 (geo, 0x99 if accuracy unknown) |
| `_http._tcp,_printer` (web UI), `_pdl-datastream._tcp` (only if raw 9100 truly served) | | optional |

mDNS wire notes [V RFC 6762/6763 at rfc-editor.org]: UDP 5353 to 224.0.0.251 / FF02::FB. Probe 3x (random 0-250 ms delay, then 250 ms apart), then announce at least 2x 1 second apart. TTL 120 s for records naming a host (A, AAAA, SRV), 75 min (4500 s) for PTR and TXT. Cache-flush bit = top bit of rrclass on unique records (SRV, TXT, A, AAAA), not on shared PTR. Records: PTR `_ipp._tcp.local` -> `Name._ipp._tcp.local`; subtype PTR `_universal._sub._ipp._tcp.local` -> same instance; SRV (port, target `host.local`); TXT; A/AAAA. Two responders on one host give conflicting answers (airprint-usb-bridge README): on hosts already running avahi or mDNSResponder, register through them instead of binding 5353 yourself [I].

Instance name: <=63 bytes UTF-8, no unique id by default, same name on every service, conflict suffix " (2)"; host label letters/digits/hyphen. Name/host stable across reboots (persist). Re-register all services on name change.

TXT wire: length byte + `key=value` (<=255 each, keys case-insensitive). Apple suggests <=512 total; PWG: SHOULD <=400 (unicast), MUST NOT exceed 1300 (mDNS), `rp` within first 400, txtvers first. Omit keys equal to default.

| Key | Value (example) | Note |
|---|---|---|
| txtvers | 1 | |
| qtotal | 1 | Apple s9.2.4: MUST be present, yet table marks it deprecated for IPP; CUPS and PAPPL emit it |
| rp | ipp/print | no leading slash; PWG: "ipp/print" or "ipp/print/queue" |
| ty | Brand Model | printer-make-and-model |
| adminurl | http://host.local.:8080/ | <=246 bytes value |
| note | Front office | printer-location |
| product | (Brand Model) | legacy PostScript product string with parentheses |
| pdl | image/urf,image/jpeg,image/pwg-raster | never application/octet-stream; whole pair <=255 |
| URF | CP1,V1.5,W8,SRGB24,RS300,DM1 | Apple devices browse only printers that support URF [V Apple]; third-party notes say the key must be present and non-empty (UNVERIFIED). Meaning of CP/IS/MT/OB/PQ/DM/FN not in public Apple docs (UNVERIFIED); copy CUPS ippeveprinter/PAPPL values. Resolution `RS300` or `RS300-600` |
| Color, Duplex, Copies, Collate, Staple, Punch, Bind, Sort, Fax, Scan | T / F (U unknown) | |
| TLS | 1.2 or 1.3 | highest TLS; Bonjour: "1.2" means HTTP Upgrade supported; MUST be present when ipps offered (5100.14) |
| UUID | 40989ed5-... | bare uuid = printer-uuid minus `urn:uuid:` |
| kind | document,photo,envelope,label,postcard,receipt,roll,large-format,disc | |
| PaperMax | `<legal-A4` legal-A4 tabloid-A3 isoC-A2 `>isoC-A2` | |
| priority / air | 0 / none | CUPS emits priority=0 |
| usb_MFG, usb_MDL, usb_CMD | from IEEE 1284 ID | Apple: MUST when device has a 1284 ID |
| mopria-certified | 1.3 | CUPS and PAPPL emit it unconditionally; it is a certification claim, do not copy blindly |

Operations to implement (5100.14 Table 4, REQUIRED): Print-Job, Validate-Job, Create-Job, Send-Document, Cancel-Job, Get-Job-Attributes, Get-Jobs, Get-Printer-Attributes, Cancel-My-Jobs, Close-Job, Identify-Printer; ippeveprinter also serves Print-URI, Send-URI, Cancel-Jobs. ipp-versions-supported 1.1 and 2.0; ipp-features-supported ipp-everywhere. Printer attribute list: 5100.14 Tables 5 and 7 (about 120 attributes; media-col-database, media-col-ready, urf/pwg-raster attrs, printer-uuid, identify-actions, job-creation-attributes-supported, job-ids-supported, multiple-document-jobs-supported...). Job attrs: job-id never reused, job-uri, job-uuid, times, job-state-reasons. Bonjour s1.1: IPP printers must pass CUPS ipptool tests for the IPP version they claim. What iOS/macOS actually call: UNVERIFIED (AirPrint spec is under NDA).

TLS/IPPS: no public Apple document requires IPPS for iOS or macOS; Apple's deployment guide calls TLS optional (UNVERIFIED for current iOS behavior). Windows: RequireIppsPolicy default 0 (off), ConfigureIppTlsCertificatePolicy default ignores cert errors so self-signed works, and Windows prefers the inbox Microsoft IPP Class Driver by default (Printers CSP, learn.microsoft.com/en-us/windows/client-management/mdm/policy-csp-printers). Serve both ipp and ipps with a self-signed cert [I].

Formats iOS sends: UNVERIFIED. Evidence: URF is the only hard requirement; cups-filters ships `urftopdf` (iOS to CUPS queues, [I]); PAPPL accepts JPEG, PNG, PWG Raster, Apple Raster and no PDF. Windows and Android format choice: UNVERIFIED. Plan: decode URF, PWG raster, JPEG; PDF only if you add a rasterizer.

## 4. Raster Formats
Each format below wraps rasterized page pixels in a header the printer can read. PWG Raster and Apple URF share the same compression scheme.

Sources: PWG 5102.4 (ftp.pwg.org/pub/pwg/candidates/cs-ippraster10-20120420-5102.4.pdf), CUPS cups/raster-stream.c + raster.h, cups-filters urftopdf.cpp, HP PCL 5 Technical Reference (hp.com/ctg/Manual/bpl13210.pdf), HP Color LaserJet Developer's Guide (mirror pic.hallikainen.org/techref/language/pcl/LJCQREF.PDF), Adobe PLRM 3rd ed. (adobe.com/jp/print/postscript/pdfs/PLRM.pdf).

### PWG Raster (image/pwg-raster)
File = sync "RaS2" (52 61 53 32) then pages; page = 1796-byte header + compressed bitmap. All u32 BE, reserved = 0, CString = 64 bytes NUL padded.

| Offset | Field | Offset | Field |
|---|---|---|---|
| 0 | "PwgRaster" | 340 | NumCopies |
| 64 / 128 | MediaColor / MediaType | 344 | Orientation (0 port,1 land,2 rev port,3 rev land) |
| 192 | PrintContentOptimize | 352 | PageSize x,y (points) |
| 268 | CutMedia (WhenEnum 0-4) | 368 | Tumble |
| 272 | Duplex | 372 / 376 | Width / Height (px, full bleed) |
| 276 | HWResolution x,y (dpi) | 384 / 388 | BitsPerColor / BitsPerPixel |
| 300 / 304 | InsertSheet / Jog | 392 | BytesPerLine = (bpp*Width+7)/8, no padding |
| 308 | LeadingEdge (0 short, 1 long first) | 396 | ColorOrder (0 chunky only) |
| 324 | MediaPosition (0 auto, 1 main, 4 manual, 20+ tray n) | 400 | ColorSpace: 1 rgb, 3 black, 6 cmyk, 18 sgray, 19 srgb, 20 adobe-rgb, 48+ deviceN |
| 328 | MediaWeightMetric | 420 | NumColors |
| 452 | TotalPageCount (0 if unknown) | 456 / 460 | CrossFeedTransform / FeedTransform (i32, 1 or -1) |
| 464/468/472/476 | ImageBox L/T/R/B (0 = unknown) | 480 / 484 | AlternatePrimary 0x00RRGGBB (CUPS writes 0xFFFFFF) / PrintQuality (0,3 draft,4 normal,5 high) |
| 508 / 512 / 516 | VendorIdentifier / VendorLength / VendorData[1088] | 1668 / 1732 | RenderingIntent / PageSizeName |

Type keywords (BitsPerColor,BitsPerPixel,ColorSpace,NumColors): sgray_8 (8,8,18,1), srgb_8 (8,24,19,3), black_1 (1,1,3,1), sgray_1 (1,1,18,1), black_8 (8,8,3,1), rgb_8 (8,24,1,3), cmyk_8 (8,32,6,4), adobe-rgb_8 (8,24,20,3); 16-bit variants exist. In practice offer sgray_8 + srgb_8 (UNVERIFIED as mandatory).

Compression (always on for pwg-raster): per line: repeat byte = lines-1 (1..256 identical lines), then runs over PIXELS (unit = ceil(bpp/8) bytes; 1-bit data is byte-wise): `n-1` (0x00-0x7F) + 1 pixel = n repeats (1..128); `257-n` (0x81-0xFF) + n pixels = literals (2..128). Example 3 literal bytes = FE 8F 78 F7 [V spec: "00 FE 8F 78 F7"].

Gotchas: runs never cross a line; line repeats never cross a page; 0x80 is undefined in the spec (CUPS reader treats it as "fill rest of line with white/zero"): never emit; single pixel = repeat form `00 px`; Duplex/Tumble: (0,x)=one-sided, (1,0)=two-sided-long-edge, (1,1)=two-sided-short-edge [V table 10, text garbled in extraction]; backside flips use CrossFeed/FeedTransform (table 9); honor pwg-raster-document-sheet-back; Width/Height must match a media size the printer advertised; long-edge-feed media needs media-source-properties from media-col-database (5100.14 s6.1).

### Apple URF (image/urf)
File header 12 bytes: "UNIRAST\0" + u32 page count. Then per page a 32-byte header + bitmap [V cups raster-stream.c, cups-filters urftopdf]. No per-page sync.

| Byte | Field |
|---|---|
| 0 | bits per pixel (8 gray, 24 rgb, 32 cmyk) |
| 1 | colorspace: 0 sGray, 1 sRGB, 2 CIELab, 3 AdobeRGB, 4 device gray, 5 device RGB, 6 CMYK |
| 2 | sides: 1 one-sided, 2 two-sided short-edge (tumble), 3 two-sided long-edge |
| 3 | quality (0 default, 3 draft, 4 normal, 5 high) |
| 4 | media type index (0 auto, 1 stationery, 2 transparency, 3 envelope, 4 cardstock, 5 labels, 6 letterhead, 7 disc, 8-12 photo matte/satin/semi-gloss/glossy/high-gloss, 13 other) |
| 5 | input slot (CUPS maps to MediaPosition) |
| 6-11 | unknown, written as 0 |
| 12 / 16 / 20 | width / height / dpi (u32; ONE dpi, square pixels; CUPS writer rejects non-integer x/y ratios) |
| 24-31 | 0 |

Bitmap compression = identical line-repeat + PixelPackBits scheme as PWG Raster (CUPS uses 1 decoder for both). CUPS/PAPPL advertise 8-bit minimum ("W8") and never 1-bit URF [I]. Height of the whole page is in the header, so buffering or known page size is required.

### PCL 5 Minimal Raster Job (HP TRM Ch. 4, 5, 15; Color LJ Guide Ch. 4)
```
ESC%-12345X @PJL ENTER LANGUAGE = PCL\r\n    UEL + PJL; HP sample also uses @PJL COMMENT
ESC E                  reset          ESC&l26A  size: 1 exec, 2 letter, 3 legal, 6 ledger, 26 A4, 27 A3
ESC&l0O ESC&l0E        portrait, top margin 0          ESC&l1S duplex long edge (2 short, 0 simplex)
ESC*t300R              dpi 75|100|150|200|300|600 (default 75, MUST precede start raster)
ESC*r0F ESC*r<w>S ESC*r<h>T       presentation 0, source width/height px (default presentation is 3)
ESC*r1A                start raster at current X      ESC*b2M  method 0 raw, 1 RLE pairs, 2 PackBits, 3 delta, 5 adaptive
ESC*b<n>W <n bytes>    one row each, MSB first, 1 = black (mono)
ESC*rC                 end raster (resets compression and seed row; old printers need ESC*rB)   0C  form feed
ESC E ESC%-12345X
```

Color (PCL 5c): before `*r1A` send `ESC*v6W 00 03 00 08 08 08` (device RGB, direct by pixel, 8 bits each; HP 24bitcol sample) then rows of RGB triplets (`*b<3w>W`). Planar mode uses `ESC*r-3U` and `*b#V` per plane (U values listed -4,-3,1,3; meaning UNVERIFIED). CID and `*r#U` are locked out after Start Raster.

PackBits in PCL (method 2): control 0-127 = n+1 literals, 129-255 = (257-c) repeats, 128 = NOP; `*b#W` count wins over control bytes. Gotchas: raster is placed in the LOGICAL page, inset from paper (300 dpi: Letter 2550x3300 physical, 2400 wide logical, 75 px left offset; A4 2480x3507 physical, 2338 wide, 71 px) so full-bleed is clipped (table 2-1 col E, offset meaning [I]), and A4 is 3507 rows not 3508; `*rC` not on LaserJet III; PJL JOB/EOJ/USTATUS framing UNVERIFIED (PJL manual not fetched). PCL XL is a separate binary language, out of scope.

### PostScript Raster Page (LanguageLevel 2, PLRM 3.13, 4.10)
```
%!PS-Adobe-3.0
<< /PageSize [595 842] >> setpagedevice
/DeviceGray setcolorspace  0 0 translate  595 842 scale          % use /DeviceRGB + Decode [0 1 0 1 0 1] for color
<< /ImageType 1 /Width 2480 /Height 3507 /BitsPerComponent 8 /Decode [0 1]
   /ImageMatrix [2480 0 0 -3507 0 3507] /DataSource currentfile /ASCII85Decode filter /RunLengthDecode filter >> image
ascii85 data lines ... ~>
showpage
```

RunLengthEncode: length 0-127 copies n+1 literals, 129-255 repeats next byte 257-n times, 128 = EOD (PackBits plus EOD). Encode RunLength first, then ASCII85 (5 chars per 4 bytes, `~>` ends, whitespace ignored, `z` = 4 zero bytes, +25% size). The filter data has NO leading `<~` (PLRM example 3.5 starts at the first data char). Level 1 fallback: `w h 8 [matrix] { currentfile picstr readhexstring pop } false 3 colorimage`. Gotchas: negative ImageMatrix d flips so row 0 is the top; data must start right after `image`; unwrapped binary RunLength needs a binary-clean channel (TXT Binary=T); PJL `@PJL ENTER LANGUAGE=POSTSCRIPT` wrapper (UNVERIFIED, by analogy with the PCL sample); JPEG via `/DCTDecode filter` is LL2 too.

## 5. AppSocket, LPD, IEEE 1284, SNMP
Sources: RFC 1179, CUPS backend/socket.c, lpd.c, usb-libusb.c, snmp.c, backend-private.h; USB Printer Class 1.1 (usb.org/sites/default/files/usbprint11a021811.pdf); Bonjour spec s9.2.10-12.
- AppSocket: TCP 9100 (CUPS default), raw bytes, no framing or ack. CUPS flow: connect with retry (1 client at a time [I]), write all, `shutdown(SHUT_WR)`, drain back-channel up to 90 s ("waiteof" default on), optionally read page count via SNMP. Completion detection: PJL USTATUS or SNMP prtMarkerLifeCount (UNVERIFIED for PJL). Closing early can truncate [I].
- LPD (RFC 1179, TCP 515, source port 721-731 per RFC; CUPS uses an unreserved port when not root, many printers accept [V code, I]): `02 <queue> LF` -> ack(00); `02 <len> SP cfA<3-digit job><host> LF` -> ack; control file bytes + `00` -> ack; `03 <len> SP dfA<nnn><host> LF` -> ack; data + `00` -> ack; close. Control file lines: `H<host>`, `P<user>`, `J<job>`, `N<name>`, `l dfA<nnn><host>` (raw print, no filtering), `U dfA...`. Control first (CUPS default); servers MUST accept it first, SHOULD accept data first. Size 0 = unknown (no trailing byte semantics, UNVERIFIED). Queue names are vendor specific (TXT `rp`).
- USB IEEE 1284 ID [V class spec 4.2.1 + CUPS]: control IN, bmRequestType A1, bRequest 0 GET_DEVICE_ID, wValue = config index (0-based), wIndex = (interface index << 8) | alt setting, wLength = buffer (1024). Reply = u16 BE total length including itself, then `MFG:Brand;MDL:Model;CMD:PJL,PCL,PCLXL,POSTSCRIPT;CLS:PRINTER;DES:...;`. Buggy printers send the length little-endian: if length > bufsize or < 14, swap bytes (CUPS). Keys also written MANUFACTURER, MODEL, COMMAND SET. CMD tokens to PDL: `PS,PDF17,PCL` is Bonjour's example; map POSTSCRIPT/PS to application/postscript, PCL to application/vnd.hp-PCL, PDF to application/pdf, URF, PWG (token spellings UNVERIFIED). GET_PORT_STATUS: A1/1, 1 byte: bit5 paper empty, bit4 selected, bit3 NOT error (1 = ok). SOFT_RESET: 21/2 (v1.0 spec said 23).
- SNMP discovery [V CUPS snmp.c]: SNMPv1, community "public", UDP 161; CUPS sends a GetRequest of hrDeviceType.1 to each interface broadcast address (IFF_BROADCAST), waits 3 s, then unicasts 1 OID per request: hrDeviceDescr.1, ppmPrinterIEEE1284DeviceId.1, ppmPortServiceNameOrURI.1.1, sysLocation.0, plus vendor IDs. Modern printers often disable v1/public (UNVERIFIED).

| OID | Meaning |
|---|---|
| `1.3.6.1.2.1.1.1.0` / `.1.6.0` | sysDescr / sysLocation |
| `1.3.6.1.2.1.25.3.2.1.2.1` / `.3.1` | hrDeviceType (printer = `1.3.6.1.2.1.25.3.1.5`, UNVERIFIED) / hrDeviceDescr |
| `1.3.6.1.2.1.43.5.1.1.17.<idx>` | prtGeneralSerialNumber (idx = hrDeviceIndex, usually 1) |
| `1.3.6.1.2.1.43.11.1.1.{6,8,9}.<idx>.<n>` | supply description / max capacity / level (RFC 3805: -1 other, -2 unknown, -3 some remaining) |
| `1.3.6.1.2.1.43.10.2.1.4.<idx>.<m>` | prtMarkerLifeCount (page counter) |
| `1.3.6.1.4.1.11.2.3.9.1.1.7.0` | HP 1284 Device ID |
| `1.3.6.1.4.1.2699.1.2.1.2.1.1.3.1` | PWG PPM MIB 1284 Device ID |
| `1.3.6.1.4.1.641.2.1.2.1.3.1` / `1.3.6.1.4.1.367.3.2.1.1.1.11.0` | Lexmark / Ricoh Device ID |

BER (built and checked, sysDescr.0, 43 bytes): `30 29 02 01 00 04 06 "public" A0 1C 02 04 00 00 00 01 02 01 00 02 01 00 30 0E 30 0C 06 08 2B 06 01 02 01 01 01 00 05 00`. Tags: 30 SEQUENCE, 02 INTEGER (v1 = 0), 04 OCTET STRING, 06 OID, 05 NULL, A0 GetRequest, A2 Response, 41 Counter, 42 Gauge, 43 TimeTicks. Length: <128 one byte, else 81 LL or 82 HH LL. OID: first two arcs = 40*a+b (1.3 = 2B), rest base-128 with high-bit continuation. v1 returns noSuchName (error-status 2) for the whole PDU if any varbind is missing, hence one OID per request. INTEGER is minimal two's complement.

## 6. IPP-over-USB
Sources: github.com/OpenPrinting/ipp-usb, mankier.com/8/ipp-usb, robots.org.uk/IPPOverUSB (secondary), USB-IF "IPP Protocol 1.0" usb.org/sites/default/files/IPP_0.zip (2012-12-05, not opened).
- Interface class 07 subclass 01 protocol 04 [V]; class descriptor bCapabilitiesType 00 carries capability bits, IPP versions, printer-uuid [secondary]. At least 2 such interfaces so status and a job run concurrently [secondary]. HTTP/1.1 over each interface's Bulk OUT/IN, `Host: localhost`, printer at /ipp/print, web UI at / [secondary].
- ipp-usb is an HTTP reverse proxy, not a TCP relay (unread response bytes would leak to the next client); 2-3 USB connections, localhost port 60000-65535 persisted per VID/PID/serial, quirks files, blocks HTTP Upgrade (would pin a USB connection) [V].
- Phase 1 recommendation [I]: skip. You need an HTTP/IPP stack anyway, but USB adds interface claiming (Linux usblp detach, Windows needs WinUSB or spooler), quirks, and truncated-job risks. Do raw USB (7/1/2 or 7/1/1 bulk OUT after reading 1284 ID) first, or the OS spooler on Windows; add IPP-USB in phase 2 as a transport that reuses the IPP client. Whether 7/1/4 devices also keep a 7/1/2 interface: UNVERIFIED.

## 7. Raspberry Pi OS First Boot
Sources: downloads.raspberrypi.com/os_list_imagingutility_v4.json (parsed), github.com/raspberrypi/rpi-imager (doc/os_customisation_formats.md, src/customization_generator.cpp, src/downloadthread.cpp, src/cmdline_params.h, releases), raspberrypi.com/news/cloud-init-on-raspberry-pi-os/, docs.cloud-init.io/en/latest/reference/modules.html, doc.rust-lang.org/rustc/platform-support.html.
- Current: Raspberry Pi OS Trixie images dated 2026-10-06 (armhf and arm64; Legacy Bookworm same date); Imager latest 2.0.12 (2026-10-08) [V manifest/releases].
- Imager 2.x writes cloud-init for Trixie (`init_format: cloudinit-rpi`): FAT boot partition (/boot/firmware) gets `user-data` (Imager prepends `#cloud-config`), `network-config`, `meta-data` (`instance-id: rpi-imager-<epoch ms>`), and cmdline.txt gets ` ds=nocloud;i=<same id>` (plus `cfg80211.ieee80211_regdom=XX` when no SSID). Bookworm and the initial 2025-10-01 Trixie use `firstrun.sh` (`systemd`); Imager 1.x cannot customise Trixie (silently writes firstrun.sh). Imager 2.0.11+ also knows `rpi-preseed` (single rpi-preseed.toml) but the current Trixie manifest entries say cloudinit-rpi. Imager CLI flags `--cloudinit-userdata/--cloudinit-networkconfig`: UNVERIFIED (forum report only).
- Contradiction: the Pi blog example uses `enable_ssh: true` and `users:`; Imager 2.0.9+ dropped `enable_ssh` (comment: not an upstream key, silently ignored) and uses singular `user:` plus a runcmd. Follow Imager.
```
#cloud-config
manage_resolv_conf: false
hostname: "printbridge"
manage_etc_hosts: true
user:
  name: "pb"
  shell: /bin/bash
  lock_passwd: false
  passwd: "<crypt-hash>"
  ssh_authorized_keys:
    - "ssh-ed25519 AAAA..."
  sudo: ALL=(ALL) NOPASSWD:ALL
ssh_pwauth: false
runcmd:
  - [ systemctl, enable, --now, ssh ]
  - [ sh, -c, "curl -fsSL https://example.invalid/install.sh | sh" ]
```
```
network:
  version: 2
  ethernets: { eth0: { dhcp4: true, dhcp6: true, optional: true } }
  wifis:
    wlan0:
      dhcp4: true
      regulatory-domain: "US"
      access-points:
        "MySSID": { password: "plaintext passphrase" }
      optional: true
```
(Imager also adds `packages: [avahi-daemon]` and an apt Check-Date tweak when a hostname is set. network-config: block style; 2.0.12 stores the raw passphrase, not a PBKDF2 key, so WPA3/SAE works; open network uses `auth: { key-management: none }`.) Hidden SSID: `hidden: true`. `meta-data` contains only `instance-id: <unique>`.
- runcmd [V cloud-init docs]: once per instance; string items run via `sh`, list items via execve; the module only writes a script, `scripts_user` runs it in the Final stage; YAML quoting rules apply. Editing user-data after first boot does nothing unless instance-id changes or `cloud-init clean` [I]. Ordering after network-online: UNVERIFIED, so retry the download. `#cloud-config` header mandatory. Reports of Trixie Lite 32-bit failing with cloud-init (blog comments): UNVERIFIED.
- Architecture [V manifest Imager filters + website compat text]: arm64 Trixie: Pi 3B/3B+/3A+, Zero 2 W, 4B/400, 5/500/500+, CM3/CM3+/CM4/CM4S/CM5. armhf Trixie (`raspios_armhf`): tagged for Pi Zero/Zero W/1 (armv6), 2 (armv7), 3, Zero 2 W, 4, 5, i.e. Pi Zero is still supported on Trixie in 32-bit [I from manifest tags, not run on hardware]. An automated summary of the Pi download page claimed Zero/1/2 are Legacy-only; the manifest contradicts it, re-check before promising Zero support. Pi 1/Zero/2 have no arm64 image.

| Rust target | Use |
|---|---|
| arm-unknown-linux-gnueabihf (Armv6 hardfloat, tier 2) | Pi Zero, Zero W, Pi 1 |
| armv7-unknown-linux-gnueabihf (tier 2) | Pi 2 and any 32-bit userland on 3/4/5 |
| aarch64-unknown-linux-gnu (tier 1) | 64-bit Pi OS on 3/Zero 2 W/4/5 |

Installer must detect userland with `dpkg --print-architecture` (armhf|arm64), not `uname -m`, since a 64-bit kernel can run 32-bit userland [I]. Zero W has 512 MB RAM and 1 armv6 core: keep the client small.
