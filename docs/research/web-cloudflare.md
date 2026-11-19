# Print Better: web + Cloudflare platform research

The Print Better server is a React web app and a Cloudflare Worker in one project, using D1, R2, Durable Objects, email, Cron Triggers and passkey sign-in. These notes check the current version, API and limits of each piece. Section 0 lists where they differ from common assumptions.

Verified 2026-11-18 against npm registry `latest` tags, vendor docs, and MDN BCD 8.1.9 / web-features 3.46.0. UNVERIFIED marks a claim not confirmed from a primary source this session.

## 0. Surprises vs common assumptions
- TypeScript 7.0.2 (native Go `tsc`) is `latest`; `baseUrl` is now a hard error, which breaks the shadcn manual-install tsconfig step.
- `@cloudflare/vitest-pool-workers` is deprecated; renamed `@cloudflare/vitest-plugin` (1.x, supports Vitest 4.1 and 5).
- `@cloudflare/vite-plugin` 2.0 (rc) drops wrangler.jsonc for `cloudflare.config.ts` and the `cf` CLI. Pin `^1` for now.
- shadcn: Base UI is the default (not Radix); components.json `style` is `<base>-<style>` (`base-nova`).
- DO config has a new declarative `exports` key (wrangler >= 4.107.0) that is mutually exclusive with `migrations`.
- Workers PBKDF2 is still capped at 100k iterations; Cloudflare Email Service sending is public beta (not GA) and can reach arbitrary recipients.
- Resend inbound webhook carries metadata only; body and attachments must be fetched by API.

## 1. Versions and Worker types
Sources: `npm view <pkg> version/dist-tags/peerDependencies`; https://developers.cloudflare.com/workers/languages/typescript/ ; https://developers.cloudflare.com/changelog/post/2026-07-03-workers-types-v5/
- react / react-dom 19.3.1; vite 8.3.8 (Rolldown + Oxc; node ^20.19 || >=22.12); tailwindcss + @tailwindcss/vite 4.3.5 (peer vite ^5.2..^8).
- typescript 7.0.2 (`latest`); 7.1.0-beta exists. @vitejs/plugin-react 6.3.0 (peer `vite ^8` only, Oxc-based; React Compiler needs @rolldown/plugin-babel).
- @cloudflare/vite-plugin 1.70.0 (peers: vite ^6.1 || ^7 || ^8, wrangler ^4.163.0); tags `rc` 2.0.0-rc.1, `beta` 2.0.0-beta.v.17.
- wrangler 4.164.0 (engines node >=22.12). vitest 5.1.1 (node ^22.12 || ^24 || >=26). shadcn 4.23.0. lucide-react 1.75.0. postal-mime 4.2.1.
- Testing pkg: `@cloudflare/vitest-plugin` 1.8.4 (peer `vitest ^4.1 || ^5`). Old `@cloudflare/vitest-pool-workers` 0.23.0 carries an npm deprecation notice and peers `vitest ^4.1` only. Codemod: `npx @cloudflare/codemods vitest:pool-workers-to-vitest-plugin` (https://developers.cloudflare.com/changelog/post/2026-08-19-vitest-plugin/).
```ts
// vitest.config.ts (https://developers.cloudflare.com/workers/testing/vitest-integration/get-started/write-your-first-test/)
import { defineConfig } from "vitest/config";
import { cloudflareTest } from "@cloudflare/vitest-plugin";
export default defineConfig({ plugins: [cloudflareTest({ wrangler: { configPath: "./wrangler.jsonc" } })] });
```
- Test tsconfig `types`: `"@cloudflare/vitest-plugin/types"` (gives `cloudflare:test` + `cloudflare:workers`). Tests use `env`/`exports` from `cloudflare:workers`, `createExecutionContext` from `cloudflare:test`.
- Runtime types: `npx wrangler types` writes `worker-configuration.d.ts` (Env from bindings + runtime types matched to compat date/flags). tsconfig: `"types": ["./worker-configuration.d.ts"]`; with nodejs_compat also install `@types/node` and add `"node"`. CI: commit file, run `wrangler types --check`. Official template script: `"cf-typegen": "wrangler types"`. Augment via `Cloudflare.Env` declaration merging, never edit the file.
- `@cloudflare/workers-types` 5.20261118.1 is not deprecated but is now the "libraries only" path; v5 ships latest-only types, dated entrypoints (`/2023-07-01`) removed. The Vite tutorial tsconfig.worker.json still references one (stale docs). Mixing both packages overrides `Env` typing (withastro/astro#14481).
- TS 7 (https://devblogs.microsoft.com/typescript/announcing-typescript-7-0-rc/, RC post; 7.0.2 is npm latest): hard errors on `baseUrl`, `moduleResolution: node10`, `target: es5`; defaults `strict: true`, `module: esnext`, `types: []`, `rootDir: ./`. Programmatic API not stable until 7.1; typescript-eslint 8.73.0 peers `typescript >=4.8.4 <6.1.0`. Workaround: alias `@typescript/typescript6` (`tsc6`) for tooling. Official CF templates still pin TS 5.9.3, Vite 7, plugin-react 5.1.1.
- Vite 8 (https://vite.dev/guide/migration): `build.rollupOptions` -> `build.rolldownOptions`, `esbuild` option -> `oxc`, Oxc minifier default, CJS default-import interop changed (`legacy.inconsistentCjsInterop`).
- Plugin 2.0 rc (https://raw.githubusercontent.com/cloudflare/workers-sdk/main/packages/vite-plugin-cloudflare/CHANGELOG.md): Vite >= 7, no Wrangler config (only `cloudflare.config.ts`), wrangler not a dependency, deploy via `cf deploy`, entry env name `ssr`, builds to `.cloudflare/output`. `cf` CLI (npm `cf` 1.0.0-rc.1) is open beta; Wrangler gets 18 months maintenance after beta ends (https://blog.cloudflare.com/cloudflare-cf-cli-launch/).

## 2. shadcn/ui
Sources: https://ui.shadcn.com/docs/cli ; /docs/installation/vite ; /docs/components-json ; /docs/theming ; /docs/dark-mode/vite ; /docs/components/sidebar ; /docs/changelog ; https://ui.shadcn.com/schema.json
- CLI `shadcn@4.23.0` (node >=20.18.1). Commands: init (alias create), add, apply, preset decode|resolve|url|open, view, search, build, docs, info, migrate (cn|icons|base-color|rtl|radix), eject.
- Base UI default since 2026-07-02 (https://raw.githubusercontent.com/shadcn-ui/ui/main/apps/v4/content/docs/changelog/2026-07-base-ui-default.mdx). Radix not deprecated: `init -b radix`. React Aria also first-class: `--base aria`. Non-interactive init without `-b` now yields Base UI. Base UI composition uses `render` prop instead of `asChild`.
- Init flags: `-t/--template next|vite|start|react-router|laravel|astro`, `-b/--base base|radix|aria`, `-p/--preset [name|code]`, `-n/--name`, `-y`, `-d` (= `--template=next --preset=nova`), `-f`, `-c`, `--css-variables/--no-css-variables`, `--monorepo`, `--rtl`, `--pointer`, `--reinstall`.
- Styles per base: vega (classic), nova (compact), maia (soft/rounded), lyra (boxy, mono), mira (dense), luma, sera, rhea (compact Luma, 2026-05). Schema `style` enum: `default`, `new-york`, plus `radix-|base-|aria-` x 8 styles (e.g. `base-nova`).
- Presets: https://ui.shadcn.com/create builds a short code (e.g. `b5owWMfJ8l` decodes to mira/mauve/hugeicons/inter/large radius; also chart color, menuAccent, menuColor). Use `init --preset <code> --template vite`; `shadcn apply <preset> [--only theme|font]` on existing projects (https://ui.shadcn.com/docs/changelog/2026-04-preset-commands).
- Docs flow, existing Vite project: `npm create vite@latest` (react-ts) -> `npm i tailwindcss @tailwindcss/vite` -> `src/index.css` = `@import "tailwindcss";` -> tsconfig `paths` `@/*` -> `npm i -D @types/node` -> alias in vite.config -> `npx shadcn@latest init` -> `npx shadcn@latest add button sidebar`. New project: `npx shadcn@latest init -t vite` (prompts base, preset, monorepo). Whether `-t vite -d` works non-interactively and whether init tolerates tsconfig without `baseUrl` (needed on TS 7): UNVERIFIED.
```ts
// vite.config.ts: path alias + Tailwind v4 plugin + Cloudflare (cloudflare after react)
import path from "node:path";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { cloudflare } from "@cloudflare/vite-plugin";
export default defineConfig({ plugins: [react(), tailwindcss(), cloudflare()], resolve: { alias: { "@": path.resolve(__dirname, "./src") } } });
```
```json
{ "$schema": "https://ui.shadcn.com/schema.json", "style": "base-nova", "rsc": false, "tsx": true,
  "tailwind": { "config": "", "css": "src/index.css", "baseColor": "neutral", "cssVariables": true, "prefix": "" },
  "aliases": { "components": "@/components", "utils": "@/lib/utils", "ui": "@/components/ui", "lib": "@/lib", "hooks": "@/hooks" },
  "iconLibrary": "lucide" }
```
- components.json: `style`, `baseColor`, `cssVariables` cannot change after init. `tailwind.config` blank for v4. baseColor options: neutral, stone, zinc, mauve, olive, mist, taupe. Also `rtl`, `menuColor` (default|inverted|default-translucent|inverted-translucent), `menuAccent` (subtle|bold), `registries` (`@ns` -> URL with `{name}`, headers/params, `${ENV}` expansion; private GitHub registries since 2026-08).
- Theming: oklch CSS vars under `:root` and `.dark`; `@theme inline { --color-background: var(--background); }`; `@custom-variant dark (&:is(.dark *));`; stylesheet starts `@import "tailwindcss"; @import "shadcn/tailwind.css";`. Tokens: background, card, popover, primary, secondary, muted, accent, destructive, border, input, ring, chart-1..5, sidebar-*. `--radius` base with calc() scale sm..4xl. Custom token: define in `:root` + `.dark`, map in `@theme inline`.
- Dark mode (Vite): ThemeProvider toggles `light`/`dark` class on `<html>`, `localStorage` key `vite-ui-theme`, values light|dark|system, plus ModeToggle (DropdownMenu + Sun/Moon). Docs code reads `prefers-color-scheme` once (no live OS listener) and has no pre-paint script (inferred: FOUC possible).
- `cn` moved to its own package `cn` (2026-09): `lib/utils.ts` becomes `export { cn } from "cn"`; `shadcn migrate cn` drops clsx/tailwind-merge.
- Sidebar: `add sidebar`; `SidebarProvider` (defaultOpen/open/onOpenChange), `Sidebar variant="sidebar|floating|inset" collapsible="offcanvas|icon|none"`, `SidebarInset` for inset, `useSidebar()`, Cmd/Ctrl+B, vars `--sidebar-width`, `--sidebar-width-mobile`, `--sidebar-*` colors. Cookie persistence not confirmed.
- New in 2026 (titles only, details UNVERIFIED): Questionnaire, Trace, Code Block, AI Elements, Toast, chat components, Human in the Loop (`@shadcn/helpers`), `shadcn/typeset`, `shadcn eject`.
- Icons: Lucide is default (`iconLibrary: "lucide"`); create also offers Tabler, Hugeicons, Phosphor, Remix. Switch later with `shadcn migrate icons`.

## 3. One project: SPA + Worker via @cloudflare/vite-plugin
The React app and the Worker build from one Vite project. Cloudflare serves the built SPA as static assets, and `run_worker_first` plus the navigation rules under Gotchas decide which requests reach the Worker.

Sources: https://developers.cloudflare.com/workers/vite-plugin/tutorial/ ; /workers/framework-guides/web-apps/react/ ; /workers/static-assets/routing/single-page-application/ ; /workers/static-assets/binding/ ; https://github.com/cloudflare/templates/tree/main/react-starter-template
- Scaffold: `npm create cloudflare@latest -- print-better --framework=react`.
- Layout: `public/`, `src/` (App.tsx), `worker/index.ts`, `index.html`, `vite.config.ts`, `wrangler.json` (docs say `.jsonc`), `worker-configuration.d.ts` (committed), `tsconfig.json` referencing `tsconfig.app.json` / `.node.json` / `.worker.json` (worker: extends node, `types: ["./worker-configuration.d.ts","vite/client"]`, `include: ["worker"]`). `.gitignore` adds `.wrangler`, `.dev.vars*`.
- Template scripts: `dev: vite`, `build: tsc -b && vite build`, `preview: npm run build && vite preview`, `deploy: wrangler deploy`, `cf-typegen`, `check: tsc && vite build && wrangler deploy --dry-run`. Template wrangler: compat 2025-10-08, nodejs_compat, observability, upload_source_maps, SPA fallback. Hono variant `vite-react-template` exists (one fetch said unmaintained, another said alternative: UNVERIFIED).
- Plugin options: `configPath`, `config(cb)`, `viteEnvironment {name, childEnvironments}`, `persistState` (default `.wrangler/state`), `inspectorPort` (9229), `auxiliaryWorkers`, `remoteBindings` (default true). Tutorial uses `cloudflare({ viteEnvironment: { name: "worker" } })`; plugin goes after framework plugin.
- `vite build`: client assets to `dist/client`, Worker + generated flattened `wrangler.json` in `dist`; `wrangler deploy` consumes it. `CLOUDFLARE_ENV` picks env at dev/build only.
```jsonc
{
  "$schema": "./node_modules/wrangler/config-schema.json",
  "name": "print-better",
  "main": "./worker/index.ts",
  "compatibility_date": "2026-11-18",
  "compatibility_flags": ["nodejs_compat"],
  "upload_source_maps": true,
  "assets": {
    "binding": "ASSETS",
    "not_found_handling": "single-page-application",
    "run_worker_first": ["/api/*", "/mcp", "/.well-known/*", "/auth/*"]
  }
}
```
- `assets` keys: `directory` (unused with Vite), `binding` (`env.ASSETS.fetch(req|url|string)`, hostname ignored), `run_worker_first` (bool or patterns; `*` deep; `!` negation wins; max 100 entries; needs plugin >= 1.7.0 / wrangler >= 4.20.0), `not_found_handling` (`single-page-application|404-page|none`), `html_handling` (default `auto-trailing-slash`). One asset collection per Worker.
- Gotchas: (a) default routing: navigations (`Sec-Fetch-Mode: navigate`, needs `main` + compat >= 2025-04-01) skip the Worker and get `index.html` 200, so opening `/api/x` or an OAuth callback in the browser returns HTML; `fetch()` reaches the Worker. (b) Any `run_worker_first` array disables that auto-detect, so list every Worker-owned route (api, mcp, webhooks, auth callbacks, ws). (c) Unknown paths under SPA fallback return 200 HTML, so have the Worker return JSON 404 for `/api/*`. (d) React code cannot touch bindings; use `fetch`.
- compat: set date to today. `nodejs_compat` + `nodejs_compat_v2` are on by default for dates >= 2026-08-04 (opt out `no_nodejs_compat`); earlier dates need the flag (v2 auto 2024-09-23..2026-08-03, v2 increases bundle size). Source: https://developers.cloudflare.com/workers/configuration/compatibility-flags/

## 4. D1
Sources: https://developers.cloudflare.com/d1/platform/limits/ ; /d1/reference/migrations/ ; /d1/worker-api/d1-database/ ; /d1/worker-api/prepared-statements/ ; /d1/best-practices/local-development/ ; /workers/wrangler/commands/d1/
```jsonc
"d1_databases": [{ "binding": "DB", "database_name": "print-better", "database_id": "<uuid or omit>", "migrations_dir": "migrations" }]
```
- Migrations: `wrangler d1 migrations create <DB> "<msg>"`, `list|apply <DB> --local|--remote [--persist-to dir] [--preview]`. Top-level `*.sql` in `migrations_dir` (default `migrations/`), applied in order, tracked in `d1_migrations` (`migrations_table` to rename); `migrations_pattern` glob for nested dirs. No down/rollback. `apply` asks confirmation unless forced. Use `PRAGMA defer_foreign_keys = true` for FK-violating steps.
- Default target: docs say `wrangler d1` commands without `--local` hit the REMOTE db; `apply` default itself UNVERIFIED, so always pass the flag.
- `db.batch([stmt,...])`: one transaction, sequential, abort/rollback on failure, returns `D1Result[]` in order; counts as ONE query against per-invocation limit. Per-statement limits still apply.
- API: `prepare(sql).bind(...)` (`?` or `?NNN`; named params unsupported), `.first(col?)` (null if no row), `.all()`, `.run()`, `.raw({columnNames})`, `db.exec()` (maintenance only), `db.withSession("first-primary"|"first-unconstrained"|bookmark)` for read replicas. `meta`: duration, changes, last_row_id, rows_read, rows_written, size_after.
- Limits: bound params per query 100 (both plans; bites bulk INSERT, chunk rows); SQL statement 100 KB; row/string/BLOB 2 MB; columns 100; result size 50 MB (enforced from 2026-11-04); queries per invocation 50 Free / 1000 Paid; DB size 500 MB Free / 10 GB Paid (hard); DBs per account 10 Free / 1M Paid.
- Local: persisted by default in `.wrangler/state` (Wrangler and Vite plugin share it if same path; `--persist-to` needs `--local`; plugin `persistState.path`). Delete the dir to reset. Seed: `wrangler d1 execute DB --local --file seed.sql`. Subdir name `v3/d1` UNVERIFIED.

## 5. R2
Sources: https://developers.cloudflare.com/r2/api/workers/workers-api-reference/ ; /r2/platform/limits/ ; /workers/platform/limits/ ; https://developers.cloudflare.com/workers/runtime-apis/streams/transformstream/
```jsonc
"r2_buckets": [{ "binding": "FILES", "bucket_name": "print-better-files" }]
```
- `put(key, value, opts?)`: value `ReadableStream | ArrayBuffer | ArrayBufferView | string | null | Blob`; opts `httpMetadata`, `customMetadata`, `onlyIf`; returns `R2Object | null` (null when precondition fails).
- Known length: `request.body` with Content-Length, or readable side of `new FixedLengthStream(n)`; `req.body.pipeTo(fixed.writable)` then `put(key, fixed.readable)`. Unknown length (chunked body, TransformStream): `put` throws TypeError. Options: buffer (`await request.arrayBuffer()`, bounded by 128 MB isolate memory), or `createMultipartUpload` (parts, `resumeMultipartUpload`, auto-abort after 7 days, max 10,000 parts).
- `get(key, {range, onlyIf})`: null if missing; `R2ObjectBody` with `.body` stream, `.arrayBuffer()/.text()/.json()/.blob()`; failed precondition returns object without body. Stream out: `const h = new Headers(); obj.writeHttpMetadata(h); h.set("etag", obj.httpEtag); return new Response(obj.body, { headers: h });`
- `head`, `delete(key|keys[<=1000])`, `list` (<=1000, check `truncated`/`cursor`).
- Limits: object 5 TiB (4.995), single PUT 5 GiB (S3 API; via Worker bounded by request body limit), key 1,024 B, metadata 8,192 B, same-key writes 1/s (429), bucket mgmt ops 50/s.
- Worker request body limit follows the zone's Cloudflare plan, not the Workers plan: Free 100 MB, Pro 100 MB, Business 200 MB, Enterprise up to 5 GB self-serve (higher via account team). Outbound body from DO/Container: 100 MiB default.

## 6. Durable Objects
A Durable Object (`PrinterHub` in the samples below) holds the client WebSocket connections. It can hibernate between messages without closing them.

Sources: https://developers.cloudflare.com/durable-objects/reference/durable-objects-migrations/ ; /durable-objects/api/state/ ; /api/base/ ; /api/alarms/ ; /best-practices/websockets/ ; /platform/limits/ ; https://developers.cloudflare.com/changelog/post/2026-07-09-restrict-new-kv-backed-namespaces/
```jsonc
"durable_objects": { "bindings": [{ "name": "HUB", "class_name": "PrinterHub" }] },
"exports": { "PrinterHub": { "type": "durable-object", "storage": "sqlite" } }
```
- Legacy equivalent: `"migrations": [{ "tag": "v1", "new_sqlite_classes": ["PrinterHub"] }]`. `exports` and `migrations` are mutually exclusive; no way back once deployed with `exports`; rename/delete via `state: "renamed"|"deleted"|"transferred"` tombstones. `exports` added in wrangler 4.107.0 (workers-sdk CHANGELOG). New KV-backed namespaces are blocked for accounts without one; use SQLite.
- Class: `import { DurableObject } from "cloudflare:workers"; export class PrinterHub extends DurableObject<Env> { constructor(ctx, env) { super(ctx, env); } async listPrinters() {...} }`. Public methods are RPC; stub `env.HUB.getByName("tenant")`, `await stub.listPrinters()`. Args/returns must be serializable; thrown errors cross without stack. RPC recommended for compat >= 2024-04-03; `stub.fetch()` still works (required to forward a WebSocket upgrade).
- D1 from a DO: `this.env` holds all bindings from the Worker config (base-class docs), so `this.env.DB` works. No D1-specific page found, so treat as inferred.
```ts
async fetch(req: Request) {
  const [client, server] = Object.values(new WebSocketPair());
  this.ctx.acceptWebSocket(server, ["agent:" + id]);
  server.serializeAttachment({ id, printerIds });
  return new Response(null, { status: 101, webSocket: client });
}
async webSocketMessage(ws: WebSocket, msg: string | ArrayBuffer) { const a = ws.deserializeAttachment(); }
async webSocketClose(ws: WebSocket, code: number, reason: string, wasClean: boolean) {}
async webSocketError(ws: WebSocket, error: unknown) {}
// constructor: this.ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
```
- Hibernation details: `acceptWebSocket(ws, tags?)` max 10 tags, 256 chars each. `getWebSockets(tag?)` omits disconnected, may include CLOSING. `getTags(ws)`. `serializeAttachment` max 16,384 bytes (page says; older docs said 2,048), survives hibernation, lost on close. `setWebSocketAutoResponse(pair)` request/response strings each <= 2,048 chars; auto-replies do not wake the DO; `getWebSocketAutoResponseTimestamp(ws)` returns `Date | null` (last auto-response, usable as liveness). `setHibernatableWebSocketEventTimeout(ms)` max 7 days. Constructor re-runs on wake: rebuild in-memory state from attachments/`getWebSockets()`. Compat date < 2026-04-07: `webSocketClose` must call `ws.close(code, reason)`; later dates auto-reply. Timers, alarms, in-flight requests and outbound sockets block hibernation; ping/pong frames handled by runtime. No duration billing while hibernated.
- Limits: 32,768 WebSockets per DO; received message 32 MiB; soft 1,000 req/s per object; storage per DO 10 GB Paid / 1 GB Free; KV key+value 8 MB; SQL: 100 bound params, 100 KB statement, 8 MB row, 100 cols; CPU 30 s default (to 5 min); classes 100 Free / 500 Paid; `blockConcurrencyWhile` 30 s.
- Alarms: one per DO; `ctx.storage.setAlarm(epochMs)` overrides, `getAlarm()`, `deleteAlarm()`; `alarm({ retryCount, isRetry })`. At-least-once; retries on throw with exponential backoff from 2 s, up to 6, then stops until re-set; handlers must be idempotent; do not `setAlarm` unconditionally in constructor; wall time 15 min.

## 7. Email (inbound Worker, outbound Cloudflare, Resend)
Sources: https://developers.cloudflare.com/email-routing/email-workers/runtime-api/ ; /email-workers/local-development/ ; https://developers.cloudflare.com/email-service/ (api/send-emails/workers-api, rest-api, platform/limits, platform/changelog) ; https://resend.com/docs
- Inbound: `export default { async email(message: ForwardableEmailMessage, env: Env, ctx: ExecutionContext) {} }`. Props: `from`, `to` (envelope), `headers`, `raw` (ReadableStream), `rawSize`, `canBeForwarded`. Methods: `setReject(reason)`, `forward(rcptTo, headers?)` (only `X-` headers kept), `reply(msg)` (needs valid DMARC, one per event, References <= 100). `EmailMessage` from `cloudflare:email`.
- Parser: `postal-mime` 4.2.1 (zero deps, TS, node >=20, Workers-safe), recommended by CF: `const email = await PostalMime.parse(message.raw);` (stream typed `ReadableStream<Uint8Array>`; attachments on `email.attachments`).
- Auth results: Cloudflare checks DMARC before invoking and prepends `Authentication-Results: mx.cloudflare.net; spf=pass; dkim=pass; dmarc=pass`. Trust only the FIRST such header and only if the service id is `mx.cloudflare.net`. Whether failing mail is still delivered to the Worker: UNVERIFIED. Forwarding requires SPF or DKIM (since 2025-07-03). Inbound limit 25 MiB.
- Local test: run `wrangler dev` / `vite`, then `curl -X POST 'http://localhost:8787/cdn-cgi/local/email' --url-query 'from=a@x.com' --url-query 'to=b@y.com' --data-raw "$RFC5322"` (raw must include `Message-ID`). Vite default port is 5173. Plugin 2.0 removes the legacy `/cdn-cgi/handler/scheduled` rewrite (email alias presumably too, UNVERIFIED); use `/cdn-cgi/local/*`. Routing rules can be managed from wrangler via `addresses` (2026-09-04; syntax UNVERIFIED).
- Cloudflare outbound (Email Service): public beta since 2026-04-16 on Workers Paid; SMTP submission beta `smtp.mx.cloudflare.net:465` since 2026-06-08; no GA entry through 2026-09-25. Arbitrary recipients: allowed once your sender domain is onboarded for Email Sending; before that only verified destination addresses (`E_RECIPIENT_NOT_ALLOWED`/`E_RECIPIENT_PLAN_RESTRICTED`). Can only send from your onboarded domains. Daily quota is account-specific and starts conservative (number UNVERIFIED); pricing UNVERIFIED.
```ts
// wrangler: "send_email": [{ "name": "EMAIL" }]
const { messageId } = await env.EMAIL.send({ from: "Print Better <no-reply@example.com>", to: "u@x.com", subject, text, html,
  attachments: [{ content, filename: "a.pdf", type: "application/pdf", disposition: "attachment" }] });
```
- Builder fields: to/cc/bcc (string | {email,name} | array), from, subject, text, html, replyTo, headers, attachments. Limits: 50 recipients total, 25 MiB message, 32 attachments, subject 998 chars, 16 KB custom headers. Errors have `E_*` codes (E_SENDER_DOMAIN_NOT_CONFIGURED, E_RATE_LIMIT_EXCEEDED, E_DAILY_LIMIT_EXCEEDED, ...). Legacy `EmailMessage` + `mimetext` still supported. REST: `POST https://api.cloudflare.com/client/v4/accounts/{account_id}/email/sending/send` (Bearer token) returns `result: { message_id, delivered, permanent_bounces, queued, suppressed_recipients }`.
- Resend send: `POST https://api.resend.com/emails`, `Authorization: Bearer re_...`; body `from,to(<=50),subject,html,text,cc,bcc,reply_to,headers,attachments[{content(base64)|path,filename}],scheduled_at,tags,template`; header `Idempotency-Key` (24 h, <=256 chars); returns `{ id }`; 40 MB per email after base64. Rate limit UNVERIFIED.
- Resend inbound: add MX on your domain; webhook event `email.received` carries metadata only (`data.email_id`), "no body, headers or attachments". Fetch `GET https://api.resend.com/emails/receiving/{id}` (html, text, headers, `authentication` SPF/DKIM/DMARC computed by Resend, `raw.download_url` signed URL, `attachments[]` metadata) and `GET /emails/receiving/{id}/attachments` (`download_url` valid 1 h with `expires_at`; `limit<=100`, `after|before`, `has_more`). SDK `resend.emails.receiving.get(id)`. Size limits and plan gating UNVERIFIED.
- Resend webhook signature (Svix): headers `svix-id`, `svix-timestamp`, `svix-signature` (space-separated `v1,<base64>`). signed = `${svix-id}.${svix-timestamp}.${rawBody}`; key = base64decode(secret minus `whsec_`); HMAC-SHA256, base64; constant-time compare; reject stale timestamps (tolerance not in docs; Svix libs default 5 min: UNVERIFIED). Verify against the RAW body. SDK: `resend.webhooks.verify({ payload, headers: { id, timestamp, signature }, webhookSecret })`. Svix docs: https://docs.svix.com/receiving/verifying-payloads/how-manual . ~15 lines of WebCrypto replace the `svix` dependency.

## 8. Workers crypto
Sources: https://developers.cloudflare.com/workers/runtime-apis/web-crypto/ ; /nodejs/crypto/ ; https://github.com/cloudflare/workerd/issues/1346 ; https://developer.mozilla.org/en-US/docs/Web/API/SubtleCrypto/sign
- PBKDF2: official docs state no max, but production caps iterations at 100,000 (workerd#1346, open; reporter hit the error at 210,000 in Jan 2026; maintainers removed the workerd default cap in Jan 2024 but kept the production limit). Error text UNVERIFIED. OWASP 600k (SHA-256) is unreachable via WebCrypto here.
- `node:crypto` under nodejs_compat: "all APIs supported except" DSA/DH `generateKeyPair`, `argon2`/`argon2Sync`, `randomUUIDv7`, ed448/x448, FIPS toggles. So `scrypt`/`scryptSync`/`pbkdf2`/`createHmac`/`timingSafeEqual`/`randomBytes`/`hkdf` are documented as supported. Actual runtime behavior and whether Node-compat `pbkdf2` skips the 100k cap: UNVERIFIED (no benchmark found; measure in `wrangler dev` and deploy). Free plan CPU is 10 ms, so scrypt/PBKDF2 hashing effectively needs Workers Paid.
- Ed25519: supported by `crypto.subtle` (`{ name: "Ed25519" }`, Secure Curves): sign/verify/generateKey/exportKey/importKey. Legacy `NODE-ED25519` requires both `name` and `namedCurve` set; no raw private key import. X25519 also supported.
- ECDSA: `verify()` expects IEEE P1363 raw `r || s` (64 bytes for P-256), not ASN.1 DER (MDN). DER signatures (OpenSSL; WebAuthn ES256 assertions, from general knowledge, UNVERIFIED here) must be converted to raw first. ECDSA curves list not given on the page (P-256 supported in practice, UNVERIFIED in docs).
- `crypto.subtle.timingSafeEqual(a, b)`: Workers non-standard extension on SubtleCrypto; args `ArrayBuffer | TypedArray`; returns boolean. Behavior on unequal lengths UNVERIFIED (Node's throws). Also: HMAC, HKDF, AES-GCM/CBC/CTR/KW, ECDH, SHA-1/256/384/512, MD5 (digest only), `DigestStream`, `randomUUID()`, `getRandomValues()`.

## 9. Cron Triggers and limits
Sources: https://developers.cloudflare.com/workers/configuration/cron-triggers/ ; /workers/runtime-apis/handlers/scheduled/ ; /workers/platform/limits/
```jsonc
"triggers": { "crons": ["*/15 * * * *", "0 3 * * *"] }
```
```ts
export default { async scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext) {
  switch (controller.cron) { case "0 3 * * *": ctx.waitUntil(purge(env)); } } } satisfies ExportedHandler<Env>;
```
- `controller`: `cron`, `type` ("scheduled"), `scheduledTime` (ms), `noRetry()`. UTC. 5 fields; supports `L`, `W`, `#`; weekdays 1=Sun..7=Sat. Changes take up to 15 min to propagate. Empty `crons: []` removes; omitting key leaves existing triggers. The `crons` list in the config file defines the triggers.
- Local: not auto-run. `curl "http://localhost:8787/cdn-cgi/local/scheduled?cron=*/15+*+*+*+*"` (`time`, `format=json` params; Local Explorer needs wrangler >= 4.139.0 / plugin >= 1.60.0).
- Free vs Paid: CPU per request 10 ms vs default 30 s (configurable to 5 min; key `limits.cpu_ms`, per changelog, UNVERIFIED in config docs); cron CPU 10 ms vs 30 s (interval < 1 h) or 15 min (>= 1 h); wall time cron/alarm/queue 15 min both; subrequests 50 vs 10,000 (configurable to 10M); internal-service subrequests 1,000 vs matches config; memory 128 MB; script 64 MiB uncompressed; startup 1 s; 6 simultaneous open connections; env vars 64 vs 128 (5 KB each); Workers 100 vs 500; Cron Triggers 5 vs 1,000 per account; requests 100k/day on Free; `waitUntil` adds 30 s after response.

## 10. Deploy to Cloudflare button and auto-provisioning
Sources: https://developers.cloudflare.com/workers/platform/deploy-buttons/ ; https://developers.cloudflare.com/workers/wrangler/configuration/ ; https://developers.cloudflare.com/changelog/2025-10-24-automatic-resource-provisioning/
- Button: `[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/<you>/print-better)`. Flow: clones repo into the user's GitHub/GitLab, setup page (repo name, Worker name, resource names), Workers Builds build + deploy, provisions and binds resources, writes back IDs.
- Resources it provisions: KV, D1, R2, Hyperdrive, Vectorize, Secrets Store, Durable Objects, Workers AI, Queues. Repo must be public (github.com / gitlab.com only, not Pages, monorepo subdir must be self-contained). Wrangler config needs default names/values and a current `compatibility_date`.
- Prompts: vars in config `vars`; secrets in `.dev.vars.example` or `.env.example` (dotenv, inline comments ok); per-binding help text in `package.json` `cloudflare.bindings` (markdown ok). `build`/`deploy` scripts from package.json are pre-filled (default `npx wrangler deploy`). D1 migrations: add `wrangler d1 migrations apply <binding> --remote` to the `deploy` script; deploy-button docs say reference the BINDING name while D1 migration docs recommend the database name (conflict, UNVERIFIED which works for auto-provisioned DBs).
- Auto-provisioning: omit IDs (`{ "binding": "DB" }`, `{ "binding": "FILES" }`, `{ "binding": "KV" }`); `wrangler deploy` creates resources named with the Worker name as prefix and writes IDs back to the config file. Needs wrangler >= 4.45.0; on by default (`--no-x-provision` disables); changelog labelled open beta, current config docs list KV, R2, D1, Flagship, AI Search, Agent Memory, Dispatch Namespaces, Queues. Dashboard/Git (Workers Builds) deploys do not write IDs to the repo but stay linked across deploys. `wrangler dev`/`vite` create empty local resources automatically. Interactive prompt/CI behavior UNVERIFIED. D1 config docs list `database_name` as required, auto-provision example omits it: UNVERIFIED which form is safest.

## 11. Browser WebAuthn (MDN BCD 8.1.9, web-features 3.46.0)
Sources: https://developer.mozilla.org/en-US/docs/Web/API/PublicKeyCredential/parseCreationOptionsFromJSON_static ; .../getClientCapabilities_static ; .../isConditionalMediationAvailable_static
- `PublicKeyCredential.parseCreationOptionsFromJSON()`, `parseRequestOptionsFromJSON()`, `credential.toJSON()`: Chrome/Edge 129, Firefox 119 (desktop and Android), Safari/iOS 18.4. Baseline "Newly available" since 2025-03-31 (not yet Widely; ~2027-09-30 by the 30-month rule, derived). Supported in all three engines, so server can exchange pure JSON; keep a manual base64url fallback only for older Safari (<18.4).
- Conditional mediation: `PublicKeyCredential.isConditionalMediationAvailable()` Chrome 108, Safari 16, Firefox 119; Baseline Widely since 2026-04-24. Call `navigator.credentials.get({ publicKey, mediation: "conditional", signal })`; keep the AbortController to cancel when the user picks another path. Input `autocomplete="username webauthn"` token is required by spec but was not on the fetched MDN page: UNVERIFIED here.
- `PublicKeyCredential.getClientCapabilities()`: Chrome/Edge 133, Firefox 135, Safari 17.4 per BCD (looks early, verify on device). Baseline Newly since 2025-02-06. Returns booleans: `conditionalGet`, `conditionalCreate`, `hybridTransport`, `passkeyPlatformAuthenticator`, `userVerifyingPlatformAuthenticator`, `relatedOrigins`, `signalAllAcceptedCredentials`, `signalCurrentUserDetails`, `signalUnknownCredential`, `extension:<id>`. Missing key means unknown, not false. Feature-detect (`typeof PublicKeyCredential.getClientCapabilities === "function"`); it can reject with SecurityError.
- Signal methods (`signalUnknownCredential`, `signalAllAcceptedCredentials`, `signalCurrentUserDetails`): Chrome/Edge 132, Safari 26, no Firefox; not Baseline.
- Whole WebAuthn L2 feature: Baseline Widely since 2024-03-07. Library versions: @simplewebauthn/server 14.1.0, @simplewebauthn/browser 14.0.0 (npm latest; not evaluated).
