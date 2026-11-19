# MCP Server

Endpoint: `POST <origin>/mcp`, streamable HTTP, stateless, JSON responses only.

Goal: An agent can do everything the web UI can, including a full first-time setup, with the same permission checks as the REST API. Tools call the same service functions as REST, so there is no parallel logic.

Code: `server/worker/mcp/` and `server/worker/oauth/`. Background: `docs/research/mcp-auth.md`.

## Protocol Eras
- **2026-07-28 (modern)**: chosen when `params._meta` carries `io.modelcontextprotocol/protocolVersion` (or the `MCP-Protocol-Version` header says 2026-07-28).
  - Every request must also carry `_meta["io.modelcontextprotocol/clientCapabilities"]` (missing → 400 `-32602`) and these headers:
    - `MCP-Protocol-Version` (= `_meta`)
    - `Mcp-Method` (= `method`)
    - `Mcp-Name` for `tools/call` (= `params.name`, `=?base64?…?=` decoded)
  - A header mismatch is 400 `-32020`. Any other version is 400 `-32022` with `data: { supported, requested }`.
  - Methods: `server/discover`, `tools/list` (`ttlMs` 1 h, `cacheScope: "private"`), `tools/call`, `subscriptions/listen`.
  - `subscriptions/listen` completes at once with nothing. The tool list changes only when a server admin makes an extension available or unavailable, and clients see that on their next `tools/list`.
  - Every result has `resultType: "complete"` and `_meta["io.modelcontextprotocol/serverInfo"]`.
  - Unknown method: 404 `-32601`.
- **2025-11-25, 2025-06-18, 2025-03-26 (legacy)**:
  - `initialize` echoes a supported version, else answers 2025-11-25. No session id is ever minted.
  - `ping` → `{}`.
  - `tools/list` and `tools/call` work as above, without `resultType`, `ttlMs` or `cacheScope`.
  - After `initialize`, a `MCP-Protocol-Version` header naming an unsupported version is 400 `-32022`.
  - Unknown method: 200 with `-32601`.
- Both:
  - Notifications get 202 with no body.
  - JSON arrays (batches) are 400 `-32600`.
  - GET and DELETE are 405.
  - Bodies over 16 MB are 413 `-32600`. Base64 documents are sent inside `tools/call`, so the limit is about 12 MB decoded.

## Auth
- Bearer tokens only, never cookies, so `Origin` is not checked.
- Accepted tokens: a personal token `pbt_…` (Account → API tokens) or an OAuth access token `pbo_…` whose audience is exactly `<origin>/mcp`.
- Missing or invalid token: 401 with `WWW-Authenticate: Bearer resource_metadata="<origin>/.well-known/oauth-protected-resource/mcp", scope="read write print"` (plus `error="invalid_token"` when one was sent).
- Scopes:
  - `read`: list/get tools
  - `write`: manage tools
  - `print`: `print`, `print_test_page`, `cancel_job`, `retry_job`
- PATs hold all 3 scopes. A missing scope is 403 with `WWW-Authenticate: Bearer error="insufficient_scope", scope="read write print", resource_metadata="…"`, so a client steps up once.
- The services enforce the scopes (`requireScope`), so REST and MCP always apply the same checks.
- `offline_access` is never a permission. Refresh tokens are always issued.
- A request that names none of `read`, `write`, `print` is granted all 3, and the consent page lists exactly what is granted.

## OAuth 2.1 Authorization Server (Issuer = Origin, Path-Less)
| Endpoint | Notes |
|---|---|
| `GET /.well-known/oauth-protected-resource` and `…/mcp` | RFC 9728: `resource` `<origin>/mcp`, `authorization_servers` `[origin]`, `scopes_supported` read/write/print |
| `GET /.well-known/oauth-authorization-server` | RFC 8414: S256 only, `token_endpoint_auth_methods_supported: ["none"]`, `client_id_metadata_document_supported`, `authorization_response_iss_parameter_supported`, registration and revocation endpoints, scopes read/write/print/offline_access |
| `GET /oauth/authorize` | resolves the client, requires an exact redirect match (loopback: any port), PKCE S256, `response_type=code`, `resource` = `<origin>/mcp` when present; stores the request (`challenges` kind `oauth-request`, 10 min) and 302s to `/oauth/consent?request=<id>`. Unknown client or redirect → JSON error; other errors redirect back with `error`, `state`, `iss` |
| `POST /oauth/token` | form body. `authorization_code`: single-use code (5 min), same client, same `redirect_uri`, PKCE verifier, `resource` check. `refresh_token`: rotation. Response `{ access_token, token_type, expires_in, refresh_token, scope }`, `Cache-Control: no-store` |
| `POST /oauth/register` | RFC 7591 for public clients (`token_endpoint_auth_method` `none`); redirect URIs must be https, http on localhost/127.0.0.1/[::1], or an app scheme, never with a fragment |
| `POST /oauth/revoke` | RFC 7009: 200 even for unknown tokens (400 only without `token`); a refresh token revokes its whole connection, an access token only itself |

- Clients are Client ID Metadata Documents or DCR registrations:
  - Client ID Metadata Documents: An https `client_id` is fetched from public DNS names on the default port only, with no redirects, a 5 s timeout and a 16 KB limit. The document's `client_id` must match. It is cached for its `Cache-Control` max-age, clamped to 5 min to 24 h (1 h by default), and refetched every time on `no-store`/`no-cache`.
  - DCR registrations: Cron deletes them after 30 days without tokens.
- Known redirects:
  - Claude: `https://claude.ai/api/mcp/auth_callback`
  - ChatGPT: `https://chatgpt.com/connector_platform_oauth_redirect`
  - Claude Code: loopback
- Lifetimes:
  - authorization request: 10 min
  - code: 5 min
  - access token (`pbo_`): 1 h
  - refresh token (`pbr_`): 30 days, rotated on every use
- Presenting a used refresh token revokes the connection (RFC 9700). Losing a race against a concurrent refresh is a plain `invalid_grant`.
- Throttles per IP: authorize 60 per 10 min, register 20 per hour.
- Storage: Tokens are hashed in `api_tokens` (`oauth-refresh` / `oauth-access`, `resource` = audience). A connection's first refresh token is its root, and later tokens point at it with `parent_id`.
- Account → API tokens lists each connection as kind `oauth`, named after the app. Deleting it revokes every token in the connection.

Consent flow contract (Worker ↔ SPA):
1. `GET /oauth/authorize?…` as above. The SPA sends signed-out users through `/login?next=…` first.
2. `GET /api/oauth/requests/:id` (session) → `{ client: { name, uri, logoUri }, redirectHost, scopes, workspaces: WorkspaceSummary[] }`. `uri` is the verified metadata host for CIMD clients, else the self-declared `client_uri`.
3. `POST /api/oauth/requests/:id/approve` `{ workspaceId: string | null }` → `{ redirectTo }` (code, state, iss appended). A non-null `workspaceId` pins the connection to that workspace. `POST …/deny` → `{ redirectTo }` with `error=access_denied`. An expired request is 404 `oauth_request_expired`.

## Tool Results
- Every success returns `structuredContent` plus 2 text blocks: a short human summary, then the same JSON serialized. Clients that ignore `structuredContent` still see ids.
- Service and validation errors become results with `isError: true` and a plain-language message the model can act on (for example `printer_required`, `workspace_required` listing the choices, `no_workspace`, `command_failed`).
- An unknown tool or non-object `arguments` is JSON-RPC `-32602`. Unknown or missing top-level arguments are reported by name.
- Workspace: the token's pinned workspace, else `workspaceId`, else the user's only workspace.
- Annotations are explicit on every tool (`readOnlyHint`, `destructiveHint`, `idempotentHint`, `openWorldHint: false`). Inputs are JSON Schema objects with `additionalProperties: false`.
- Every mutation is audited by the service it calls, with actor type `token`.

## Tools (in `tools/list` Order)
| Tool | Scope | Purpose |
|---|---|---|
| `get_setup_status` | read | Start here: checklist (devices paired/online, printers added, first print, members) and the next tool to call with its arguments |
| `whoami` | read | User, workspaces with roles, instance admin flag, pinned workspace |
| `list_workspaces` | read | Workspaces and your role in each |
| `create_workspace` | write | New workspace with you as owner |
| `update_workspace` | write | Rename; settings: auto-add, retention, job timeout, upload limit, LAN sharing default, email-to-print, default printer |
| `list_members` | read | Members and roles |
| `invite_member` | write | Invite link (7 days), emailed when an address is given and email is set up |
| `update_member_role` | write | Change a role (owner rules apply) |
| `remove_member` | write | Remove a member or leave |
| `list_audit` | read | Audit log, newest first (admins and owners) |
| `list_devices` | read | Paired devices with online state and settings |
| `update_device` | write | Rename; tray, LAN sharing, auto-add, discovery sources, pause, log level |
| `remove_device` | write | Unpair a device and remove its printers |
| `create_device_install` | write | Single-use install code with macOS/Linux and Windows commands and Raspberry Pi first-boot steps |
| `device_command` | write | `discover`, `refresh`, `identify`, `logs`, `diagnose`, `restart`, `update` on an online device |
| `list_printers` | read | Added and discovered printers with status and supplies (no routes or capabilities) |
| `get_printer` | read | One printer with capabilities, routes and defaults |
| `update_printer` | write | Add/remove from the workspace, rename, location, defaults (replaced whole), LAN share, email alias |
| `remove_printer` | write | Forget a printer |
| `identify_printer` | write | Make the printer beep, blink or show a message (device must be online) |
| `print_test_page` | print | Queue the built-in test page |
| `print` | print | Exactly one of `text`, `url`, or `base64` + `contentType` + `fileName`; optional `printerId` (default printer), `title`, `options` |
| `list_jobs` | read | Jobs, newest first, by printer or status |
| `get_job` | read | One job with status and message |
| `cancel_job` | print | Cancel an unfinished job |
| `retry_job` | print | Print a failed or canceled job again while its document is still stored |
| `get_instance_settings` | read | Instance admins: app name, signup, SSO, email (secrets reported as present/absent) |
| `update_instance_settings` | write | Instance admins: deep-merged changes; secret fields are write-only (a string sets, `null` clears) |

### Extension Tools
After the core tools, `tools/list` adds the tools of each extension a server admin has made available (docs/extensions.md). While the extension is off in the workspace, each call fails with a message that says how to turn it on.

Printer access (docs/printer-access.md):

| Tool | Scope | Purpose |
|---|---|---|
| `list_groups` | read | Groups of members and devices, with their members |
| `create_group`, `update_group`, `delete_group` | write | Admins: create, rename or describe, delete (its grants go with it) |
| `set_group_member` | write | Admins: add or remove a person (`user`) or device (`client`) |
| `list_printer_roles` | read | Built-in and custom roles with their permissions |
| `create_printer_role`, `update_printer_role`, `delete_printer_role` | write | Admins: custom roles; a role still in use can't be deleted |
| `get_printer_access` | read | A printer's Everyone role and grants; without `printerId`, the workspace default role, roles and workspace-wide grants |
| `set_printer_everyone_role` | write | A printer's Everyone role (a role, `none`, or `null` for the default); without `printerId`, the workspace default |
| `grant_printer_access` | write | A role for a member, group or device on one printer, or on every printer without `printerId` (admins; Everyone allowed there) |
| `revoke_printer_access` | write | Remove a grant |
| `explain_printer_access` | read | Why a member, group, device or Everyone has their permissions on a printer |

Print rules and limits, and Enterprise controls, share these (docs/usage.md):

| Tool | Scope | Purpose |
|---|---|---|
| `get_prices` | read | Currency, time zone, default prices, and printers' own prices |
| `set_prices` | write | Admins: change any of those; a printer set to `null` goes back to the default |
| `preview_print_job` | print | What would happen to a job sent now: refused or not, changes, notes, pages, sheets, cost, and the limits it counts against |

Print rules and limits (docs/print-policies.md):

| Tool | Scope | Purpose |
|---|---|---|
| `list_print_rules` | read | Admins: rules, top to bottom |
| `create_print_rule`, `update_print_rule`, `delete_print_rule` | write | Admins: add a rule at the bottom, change it, delete it |
| `reorder_print_rules` | write | Admins: every rule id once, top to bottom |
| `list_print_limits` | read | Admins: limits with this cycle's counts |
| `create_print_limit`, `update_print_limit`, `delete_print_limit` | write | Admins: add, change or delete a limit |
| `add_limit_allowance` | write | Admins: an extra amount for the current cycle, for one count |
| `get_my_usage` | read | The limits that count your jobs, with what is left and when each starts over |
| `get_usage` | read | Admins: every limit's counts, this cycle or the previous one |

`print` and `print_test_page` are checked like any other job, and a refused job fails with the rule's or limit's message.

Resources and prompts: none in phase 1.
