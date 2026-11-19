# REST API (v1)

Base path: `/api`. Requests and responses are JSON, with types in `server/shared/types.ts` and `printing.ts`.

Errors return an HTTP status and `{ error: { code, message } }` (`ApiErrorBody`).

Paginated lists return `{ items, nextCursor }`. The cursor is an opaque string, and `?limit=` defaults to 50 (max 200).

Requests authenticate with the session cookie `pb_session` or `Authorization: Bearer pbt_…` (a personal API token). OAuth access tokens (`pbo_…`) are bound to `/mcp` (RFC 8707) and get 401 here.

Cookie-authenticated non-GET requests must send an `Origin` that matches the server.

`:ws` routes require workspace membership. Marks in the tables below:
- **A**: admin or owner
- **O**: owner only
- **I**: instance admin

Token scopes:
- `read`: gets and lists
- `print`: create, upload, cancel, retry and delete jobs; test pages
- `write`: every other change

PATs hold all 3 scopes. A token without the scope a route needs gets 403 `insufficient_scope`.

Password, passkey, session, PAT-creation, recovery-code and OAuth-consent routes refuse tokens with 403 `session_required`.

## Instance and Auth
| Route | Notes |
|---|---|
| `GET /instance` | `InstanceInfo` (public) |
| `POST /auth/setup` | first run only: `{ setupToken, username, name, password?, workspaceName }` → `{ user }` + session. `setupToken` must equal the `SETUP_TOKEN` secret when set |
| `GET /auth/session` | `{ user: User \| null, workspaces: WorkspaceSummary[] }` |
| `POST /auth/register` | `{ username, name, password, email?, inviteToken? }`; allowed when signup is open or the invite is valid |
| `POST /auth/login` | `{ login, password }` (`login` = username or email) |
| `POST /auth/logout` | |
| `POST /auth/passkey/register/options` | signed in → `{ challengeId, options }` (`PublicKeyCredentialCreationOptionsJSON`) |
| `POST /auth/passkey/register/verify` | `{ challengeId, credential, name? }` → `Passkey` |
| `POST /auth/passkey/signup/options` | `{ username, name, inviteToken? }` → passwordless account creation options |
| `POST /auth/passkey/signup/verify` | `{ challengeId, credential }` → session |
| `POST /auth/passkey/login/options` | `{ login? }` → `{ challengeId, options }` (empty allowCredentials for discoverable/autofill) |
| `POST /auth/passkey/login/verify` | `{ challengeId, credential }` → session |
| `GET /auth/sso/:provider/start?next=` | 302 to Google or the configured OIDC issuer (PKCE + nonce + state). With `link=1` (browser session required; `next` defaults to `/account/security`) the callback connects the provider to that user instead of signing in |
| `GET /auth/sso/:provider/callback` | sets session, 302 to `next` (same-origin paths only). Link flows set no session; they need the same signed-in user who started, mark the email verified when the provider's verified email matches it, and send failures to `next?error=<code>&message=<text>` (`identity_in_use`, `identity_exists`, `sso_wrong_user`) |
| `POST /auth/verify-email` | `{ token }` (signed in or out) → `{ user }` when signed in as that user, else `{}`. Single use; valid only while the account's email still equals the one the link was sent to; otherwise 400 `invalid_token` |
| `POST /auth/recover` | `{ login, code, newPassword? }` → session (recovery codes are single-use) |
| `POST /auth/reset/request` | `{ email }` → 204 whether or not the address exists; 400 `email_disabled` when outbound email is not configured |
| `POST /auth/reset/confirm` | `{ token, password }` → session (signs in; other sessions are revoked) |

## Me
| Route | Notes |
|---|---|
| `GET /me`, `PATCH /me` | `User`; patch `{ name?, email?, username? }` |
| `PUT /me/password` | `{ current?, next }` (`current` required when one exists) |
| `POST /me/email/verification` | session only → 204; emails `<origin>/verify-email#token=<pbv_…>` (24 h). 400 `email_disabled` or `no_email`, 409 `already_verified`, 429 `rate_limited` (1 per minute, 5 per hour per user), 502 `email_failed`. Also sent in the background after register with an email and after an email change in `PATCH /me` |
| `GET /me/identities` | `IdentityList`: connected Google/OIDC accounts and the enabled providers (`available`) |
| `DELETE /me/identities/:provider` | session only; 409 `last_sign_in_method` when no password, passkey or other identity would remain. Connect with `/auth/sso/:provider/start?link=1` |
| `GET /me/passkeys`, `PATCH /me/passkeys/:id`, `DELETE /me/passkeys/:id` | cannot delete the last sign-in method |
| `GET /me/sessions`, `DELETE /me/sessions/:id` | |
| `POST /me/recovery-codes` | → `{ codes: string[] }` (10 codes, shown once, replaces old) |
| `GET /me/tokens`, `POST /me/tokens`, `DELETE /me/tokens/:id` | PATs: `{ name, workspaceId?, expiresInDays? }` → `{ token, apiToken }`; no `expiresInDays` = never expires. Connected OAuth apps are listed as kind `oauth` (one row per connection, named after the app); DELETE revokes the whole connection |

## Workspaces
| Route | Notes |
|---|---|
| `GET /workspaces`, `POST /workspaces` | `{ name }`; creator becomes owner |
| `GET /workspaces/:ws` | `Workspace` |
| `PATCH /workspaces/:ws` **A** | `{ name?, settings?: Partial<WorkspaceSettings> }` (deep-merged) |
| `DELETE /workspaces/:ws` **O** | |
| `GET /workspaces/:ws/members` | `Member[]` |
| `PATCH /workspaces/:ws/members/:userId` **A** | `{ role }`; only owners grant/revoke owner; the last owner cannot be demoted |
| `DELETE /workspaces/:ws/members/:userId` **A** | members may remove themselves |
| `GET/POST /workspaces/:ws/invites` **A** | `{ role, email? }` → `{ invite, url }` (url carries `pbi_` token; emailed when outbound email is on) |
| `DELETE /workspaces/:ws/invites/:id` **A** | |
| `GET /invites/:token` | public preview `{ workspaceName, inviterName, role, expiresAt }` |
| `POST /invites/:token/accept` | signed in → `WorkspaceSummary` |
| `GET /workspaces/:ws/audit?cursor=` **A** | `AuditEntry` page |
| `GET /workspaces/:ws/events` | WebSocket; server pushes `UiEvent` |

## Devices (Clients)
| Route | Notes |
|---|---|
| `GET /workspaces/:ws/clients`, `GET …/clients/:id` | `Client[]`, `Client` |
| `PATCH /workspaces/:ws/clients/:id` **A** | `{ name?, settings?: Partial<ClientSettings> }` → pushes `settings` to the client |
| `DELETE /workspaces/:ws/clients/:id` **A** | revokes its token, cancels its open jobs, sends `unpair` if online, deletes its printers |
| `POST /workspaces/:ws/clients/:id/commands` **A** | `{ name, args? }`, name one of `discover`, `refresh`, `identify`, `logs`, `diagnose`, `restart`, `update` → `{ ok, data?, error? }` (409 `client_offline`); `unpair` is only sent by DELETE |
| `POST /workspaces/:ws/enrollments` **A** | `{ label?, maxUses?, ttlHours? }` → `Enrollment` |
| `GET /workspaces/:ws/enrollments`, `DELETE …/:id` **A** | `EnrollmentToken[]` |
| `GET /device/:userCode` | signed in → `{ hostname, os, arch, version, expiresAt, workspaces }`; `workspaces` lists those where the caller is admin or owner |
| `POST /device/:userCode/approve` | `{ workspaceId, name? }` (caller must be admin there) |
| `POST /device/:userCode/deny` | |

## Printers
| Route | Notes |
|---|---|
| `GET /workspaces/:ws/printers?added=` | `Printer[]` |
| `GET /workspaces/:ws/printers/:id` | `Printer` |
| `PATCH /workspaces/:ws/printers/:id` **A** | `{ name?, location?, added?, defaults?, settings? }`; `added: false` removes it from the workspace (it stays `discovered` and stops being the default printer); `defaults` replaces the whole object; `settings.email.alias` must be unique, `""` or `null` clears it |
| `DELETE /workspaces/:ws/printers/:id` **A** | forget; rediscovery brings it back as `discovered` |
| `POST /workspaces/:ws/printers/:id/identify` | relays `identify` |
| `POST /workspaces/:ws/printers/:id/refresh` | relays `refresh` |
| `POST /workspaces/:ws/printers/:id/test-page` | queues the built-in one-page test PDF (source `test`) → `{ job }` |

With printer access active (docs/printer-access.md), each printer's permissions replace the **A** marks here and under Jobs. Printers and jobs the caller can't see are left out of lists and answer 404. Other refusals are 403 `printer_access_denied`.

## Jobs
| Route | Notes |
|---|---|
| `GET /workspaces/:ws/jobs?printerId=&status=&cursor=` | `Job` page, newest first |
| `POST /workspaces/:ws/jobs` | JSON (6 MB max). Either `{ printerId?, title?, options?, upload: { fileName, contentType, size } }` → `{ job, uploadUrl }` (job status `uploading`), or `{ printerId?, title?, options?, text }` / `{ …, url }` / `{ …, base64, contentType, fileName }` → `{ job }` (the server fetches the URL). Without `printerId` the workspace default printer is used (400 `printer_required` when none) |
| `PUT /workspaces/:ws/jobs/:id/file` | raw body, `Content-Type` = the declared type (else 415 `unsupported_type`), exactly the declared size (else 400 `size_mismatch`); streams to R2 while hashing → `{ job }` now `queued` and dispatched |
| `GET /workspaces/:ws/jobs/:id` | `Job` |
| `GET /workspaces/:ws/jobs/:id/file` | the document (until purged) |
| `POST /workspaces/:ws/jobs/:id/cancel` | → `Job` (not wrapped); a job already with the device shows "Canceling…" until it reports back |
| `POST /workspaces/:ws/jobs/:id/retry` | failed/canceled jobs with a file; `attempts + 1`, back to `queued` → `Job` (not wrapped) |
| `DELETE /workspaces/:ws/jobs/:id` **A** | terminal jobs only; deletes the file |

Members can print, and cancel/retry their own jobs. Admins can cancel/retry any job.

Format allowlist: `DOC_TYPES`. Size limit: `settings.maxUploadMb`.

Jobs printed from a paired computer's own print dialog have source `device` and `userId: null`, and carry:
- `sourceClientId` and `sourceClientName` (null once that device is removed)
- `requestedBy` (the computer account name)

Other sources leave all 3 null. Devices create these jobs with `/api/client/jobs` (protocol.md, "Remote Printers").

While Print rules and limits or Enterprise controls is on, every job is checked before it is queued (docs/usage.md). A rule or limit can change its options or printer, recorded in `policy`, or refuse it with 403 `policy_blocked` and the rule's or limit's message. Jobs counted then carry `usage`. These fields appear only on jobs they were recorded for.

## Instance Admin
| Route | Notes |
|---|---|
| `GET /admin/settings`, `PATCH /admin/settings` **I** | `InstanceSettings`; secrets are write-only fields: `sso.google.clientSecret`, `sso.oidc.clientSecret`, `email.apiKey` |
| `GET /admin/users` **I** | `User[]` |
| `PATCH /admin/users/:id` **I** | `{ isAdmin? }`; `POST /admin/users/:id/reset-password` → one-time reset URL |
| `DELETE /admin/users/:id` **I** | |

## Extensions
Extensions are optional modules. Each stays off until a server admin makes it available and a workspace owner turns it on (docs/extensions.md). Types are in `server/shared/extensions.ts` and `access.ts`.

| Route | Notes |
|---|---|
| `GET /admin/extensions` **I** | `InstanceExtension[]`: availability and how many workspaces turned each on |
| `PATCH /admin/extensions/:id` **I** | `{ available }` → `InstanceExtension`; turning one off makes it inactive everywhere and keeps every workspace's data |
| `GET /workspaces/:ws/extensions` | `WorkspaceExtension[]` (`available`, `enabled`, `active`) |
| `PATCH /workspaces/:ws/extensions/:id` **O** | `{ enabled }` → `WorkspaceExtension`; 409 `extension_unavailable` when turning on one that isn't available |
| `GET /workspaces/:ws/access/me` | `MyPrinterAccess`: the caller's permissions on each printer they can see; also answers while printer access is off |

docs/printer-access.md lists the printer access routes (`/workspaces/:ws/access…`, `/groups…`, `/printers/:id/access…`). While printer access is off they answer 404 `extension_inactive`, except `GET /access/me` and `GET /access/subject`.

Moving either switch sends an `access` event to open pages and refreshes the printers devices offer in their print windows.

docs/usage.md lists the routes shared by Print rules and limits and Enterprise controls. They answer 404 `extension_inactive` while both are off:

| Route | Notes |
|---|---|
| `POST /workspaces/:ws/jobs/preview` | `JobPreviewRequest` → `JobPreview`: what would happen to a job sent now. Needs `print` on the printer; nothing is stored or sent |
| `GET /workspaces/:ws/prices` | `Prices`: currency, time zone, default prices, and the prices of printers the caller can see |
| `PUT /workspaces/:ws/prices` **A** | `PricesUpdate` → `Prices` |

docs/print-policies.md lists the Print rules and limits routes (`/workspaces/:ws/policies/rules…`, `/policies/limits…`, `/usage/me`, `/usage`). While it is off they answer 404 `extension_inactive`.

## Webhooks and Non-API Routes
| Route | Notes |
|---|---|
| `POST /api/hooks/resend` | Resend inbound email webhook (signature verified) |
| `GET /install.sh`, `GET /install.ps1` | install scripts templated with the origin; token passed as an argument |
| `GET /dl/:file` | client builds from R2 `downloads/` (`latest.json` manifest) |
| `/mcp`, `/.well-known/oauth-*`, `/oauth/*`, `/api/oauth/requests/:id` | see docs/mcp.md |

## Error Codes
Generic: `invalid_request` 400, `unauthorized` 401, `forbidden` 403, `not_found` 404, `method_not_allowed` 405, `conflict` 409, `too_large` 413, `upgrade_required` 426, `rate_limited` 429.
- Auth: `bad_origin`, `invalid_token`, `session_required`, `insufficient_scope`, `invalid_credentials`, `setup_required`, `setup_complete`, `bad_setup_token`, `signup_closed`, `username_taken`, `email_taken`, `reset_invalid`, `email_disabled`, `no_email`, `already_verified`, `email_failed`.
- Passkeys and SSO: `challenge_expired`, `passkey_invalid`, `passkey_exists`, `passkey_unknown`, `last_sign_in_method`, `sso_disabled`, `sso_expired`, `sso_failed`, `sso_invalid_token`, `sso_unverified_account`, `sso_wrong_user`, `identity_in_use`, `identity_exists`, `sso_<provider error>`, `oidc_discovery_failed`.
- People: `last_owner`, `sole_owner` (deleting a user who alone owns a workspace), `last_admin`, `invite_invalid`, `oauth_request_expired`.
- Devices: `client_offline`, `device_code_invalid`; device endpoints add `unsupported_protocol`, `no_build`, `printer_not_found` and the RFC 8628 poll codes (protocol.md).
- Printers and jobs: `alias_taken`, `printer_required`, `printer_not_added`, `printer_missing`, `unsupported_type`, `size_mismatch`, `not_uploading`, `fetch_failed`, `job_finished`, `job_active`, `job_not_retryable`, `file_purged`.
- Extensions and printer access: `extension_inactive` 404, `extension_unavailable` 409, `printer_access_denied` 403 (404 for a device that can't see the printer), `role_in_use` 409, `name_taken` 409.
- Rules and limits: `policy_blocked` 403, with the rule's or limit's message.
- Resend webhook: `not_enabled` 404, `not_configured` 503, `bad_signature` 401.

## SPA Conventions
- Links the server generates:
  - invites: `<origin>/invite/<pbi_…>`
  - password resets: `<origin>/reset-password#token=<pbp_…>` (a fragment; the page posts `{ token, password }` to `/auth/reset/confirm`)
  - device approval: `<origin>/device?code=XXXX-XXXX`
  - first run: `<origin>/setup?token=<SETUP_TOKEN>`
- SSO is a full-page navigation to `/api/auth/sso/:provider/start?next=/path[&invite=pbi_…]`. Success 302s to `next`, failure to `/login?error=<code>&message=<text>`.
- Every session-creating endpoint (setup, register, login, passkey signup/login verify, recover, reset confirm) returns `{ user }` and sets `pb_session`.
- Passkey signup options accept `{ username, name, inviteToken?, setupToken?, workspaceName? }`. With `setupToken` and `workspaceName` while setup is required, it creates the first account.
- `/workspaces/:ws/events`: The SPA sends the text frame `ping` every 25 s. The hub auto-replies `pong` and drops sockets idle for 90 s. The `workspace` event carries the receiving user's own role.
- Device commands answer 200 `{ ok, data?, error? }` (`error: "timeout"` after 20 s) or 409 `client_offline`.
- Instance secrets in `PATCH /admin/settings` (`sso.google.clientSecret`, `sso.oidc.clientSecret`, `email.apiKey`, `email.webhookSecret`): A string sets the secret, `null` clears it, and an omitted key keeps it. `InstanceSettings.email.hasWebhookSecret` reports whether the webhook secret is set.
- `POST /workspaces/:ws/jobs` returns an absolute `uploadUrl`. The PUT body must be exactly the declared size.
- Usernames: 2 to 32 characters of letters, digits, `.`, `-` and `_`.
- Audit `action` strings are `noun.verb` (`printer.update`, `member.remove`, `job.create`, `passkey.add`, `app.approve`, `extension.update`, `access.grant`, `group.add`, …).
