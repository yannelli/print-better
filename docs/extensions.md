# Extensions

Extensions are optional modules that ship with Print Better and stay off until someone turns them on. They keep the core small. A deployment can opt into a heavier feature, such as [printer access control](printer-access.md), without changing anything for deployments that don't.

| Extension | What it does |
|---|---|
| `printer-access` | Who can see, print to, and manage each printer: groups, device rules, built-in and custom roles. [Docs](printer-access.md) |

## Turning One On

An extension is **active** in a workspace only when both switches are on. Both are off by default.

1. **Available** (instance level): A server admin opens **Server admin > Extensions** and turns on **Available to workspaces** for the extension.
2. **Enabled** (workspace level): A workspace owner opens **Workspace settings > Extensions**, turns on the extension, and clicks **Turn on** to confirm. The extension's row shows "On for this workspace".

Turning either switch off makes the extension inactive at once. Its data (groups, roles, grants, settings) is kept, so turning it back on restores the previous setup. Nothing is deleted unless the workspace or printer it belongs to is deleted.

## Rules Every Extension Follows

- **Inactive**: With the extension inactive, the core behaves exactly as if the extension didn't exist, with the same responses, permissions and events. Its routes answer `404 extension_inactive`, and its MCP tools are listed only when the extension is available on the instance.
- **Schema**: The tables ship with the core in the normal D1 migrations and stay empty and unused while the extension is off, so turning it on never needs a deploy.
- **Hooks**: The core asks extensions through a small set of hooks (for example "what may this actor do with this printer?") and falls back to its built-in behavior when no active extension answers. Extensions don't patch core services.
- **Audit**: Every change an extension makes is written to the audit log like any core change.
- **Permissions**: REST, MCP, email, and devices go through the same service layer, so an extension's rules apply to all of them.

## Where Things Live

| Piece | Location |
|---|---|
| Catalog (ids, names, summaries) shared by the Worker and the web app | `server/shared/extensions.ts` |
| Instance availability | `settings` table, key `extensions` (`{ "available": ["printer-access"] }`) |
| Workspace state and config | `workspace_extensions` table (`workspace_id`, `extension_id`, `enabled`, `config` JSON, `updated_at`) |
| Server registry and hooks | `server/worker/extensions/` (`hooks.ts`, `routes.ts`, `tools.ts`, and one folder per extension) |
| Web app registry and slots | `server/src/extensions/` (one folder per extension) |

## API

| Method and path | Who | What |
|---|---|---|
| `GET /api/admin/extensions` | instance admins | `InstanceExtension[]`: availability and how many workspaces enabled each |
| `PATCH /api/admin/extensions/:id` `{ "available": true }` | instance admins | Make an extension available or unavailable everywhere |
| `GET /api/workspaces/:ws/extensions` | members | `WorkspaceExtension[]`: available, enabled, active |
| `PATCH /api/workspaces/:ws/extensions/:id` `{ "enabled": true }` | workspace owners | Turn an available extension on or off for the workspace (`409 extension_unavailable` while it isn't available) |

Changing either switch is audited (`extension.update`). It also sends an `access` event to the workspace's open browsers and refreshes what its devices see, so pages and print windows update without a reload. The instance switch does this for every workspace.

## Writing an Extension

1. Add its id and catalog entry to `server/shared/extensions.ts`.
2. Add its tables in a new migration. Every row must cascade on workspace delete.
3. Create `server/worker/extensions/<id>/`. List its hooks in `extensions/hooks.ts`, its routes (under `/api/workspaces/:ws/...`) in `extensions/routes.ts`, and its MCP tools in `extensions/tools.ts`. Use `isActive(ctx, workspaceId, '<id>')` or `requireActive` at every entry point.
4. Create `server/src/extensions/<id>/` and register its UI with the slots it needs (for example a printer tab, a workspace settings tab, a device page section). Slots render nothing while the extension is inactive.
5. Write tests that prove the core is unchanged while the extension is off, then test the extension itself.
6. Document it in `docs/<id>.md` and add it to the table above.
