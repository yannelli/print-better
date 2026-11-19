# Extensions

Extensions are optional modules that ship with Print Better and stay **off until someone turns them on**. They keep the core small and let a deployment opt into heavier features, such as [printer access control](printer-access.md), without changing anything for deployments that don't.

| Extension | What it does |
|---|---|
| `printer-access` | Who can see, print to, and manage each printer: groups, device rules, built-in and custom roles. [Docs](printer-access.md) |

## Turning one on

An extension is **active** in a workspace only when both switches are on:

1. **Available** (instance level): a server admin turns it on under **Admin > Extensions**. Default: off.
2. **Enabled** (workspace level): a workspace owner turns it on under **Workspace settings > Extensions**. Default: off.

Turning either switch off makes the extension inactive at once. Its data (groups, roles, grants, settings) is kept, so turning it back on restores the previous setup. Nothing is deleted unless the workspace or printer it belongs to is deleted.

## Rules every extension follows

- **Inactive means invisible.** With the extension inactive, the core behaves exactly as if the extension didn't exist: same responses, same permissions, same events. Its routes answer `404 extension_inactive`, and its MCP tools are listed only when the extension is available on the instance.
- **Schema ships with the core.** Tables live in the normal D1 migrations and stay empty and unused while the extension is off, so turning it on never needs a deploy.
- **Hooks, not forks.** The core asks extensions through a small set of hooks (for example "what may this actor do with this printer?") and falls back to its built-in behavior when no active extension answers. Extensions don't patch core services.
- **Audit everything.** Every change an extension makes is written to the audit log like any core change.
- **Same permissions everywhere.** REST, MCP, email, and devices go through the same service layer, so an extension's rules apply to all of them.

## Where things live

| Piece | Location |
|---|---|
| Catalog (ids, names, summaries) shared by the Worker and the web app | `server/shared/extensions.ts` |
| Instance availability | `settings` table, key `extensions` (`{ "available": ["printer-access"] }`) |
| Workspace state and config | `workspace_extensions` table (`workspace_id`, `extension_id`, `enabled`, `config` JSON, `updated_at`) |
| Server registry and hooks | `server/worker/extensions/` (one folder per extension) |
| Web app registry and slots | `server/src/extensions/` (one folder per extension) |

## API

| Method and path | Who | What |
|---|---|---|
| `GET /api/admin/extensions` | instance admins | `InstanceExtension[]`: availability and how many workspaces enabled each |
| `PATCH /api/admin/extensions/:id` `{ "available": true }` | instance admins | Make an extension available or unavailable everywhere |
| `GET /api/workspaces/:ws/extensions` | members | `WorkspaceExtension[]`: available, enabled, active |
| `PATCH /api/workspaces/:ws/extensions/:id` `{ "enabled": true }` | workspace owners | Turn an available extension on or off for the workspace |

Changing either switch sends an `access` event to the workspace's open browsers and refreshes what its devices see, so pages and print windows update without a reload.

## Writing an extension

1. Add its id and catalog entry to `server/shared/extensions.ts`.
2. Add its tables in a new migration. Every row must cascade on workspace delete.
3. Create `server/worker/extensions/<id>/` with an `index.ts` that registers its hooks, routes (under `/api/workspaces/:ws/...`), and MCP tools with the registry. Use `isActive(ctx, workspaceId, '<id>')` at every entry point.
4. Create `server/src/extensions/<id>/` and register its UI with the slots it needs (for example a printer tab, a workspace settings section, a device page section). Slots render nothing while the extension is inactive.
5. Write tests that prove the core is unchanged while the extension is off, then test the extension itself.
6. Document it in `docs/<id>.md` and add it to the table above.
