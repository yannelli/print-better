# Printer Access

**Printer access** is an [extension](extensions.md) that controls who can see, print to, and manage each printer. It is off by default.

Without it, every member can see every printer, print to every added printer, and see every job. Owners and admins can change everything.

## Turning It On

1. A server admin opens **Server admin > Extensions** and turns on **Available to workspaces** for **Printer access**.
2. A workspace owner opens **Workspace settings > Extensions**, turns on **Printer access**, and clicks **Turn on** to confirm. A **Printer access** tab appears in **Workspace settings**.

Turning it on changes nothing by itself. Every printer starts open to everyone with the **User** role, which is exactly today's access. You then restrict printers one at a time, or change the default for all of them.

## Concepts

### Permissions

| Permission | Allows |
|---|---|
| `view` | Seeing the printer, its status, supplies, and options; refreshing its status |
| `print` | Printing to it from anywhere (web, API, AI assistants, email, a computer's print window), test pages, and making it identify itself |
| `jobs.read` | Seeing everyone's jobs on it and downloading their documents. Without it you see only your own jobs |
| `jobs.manage` | Canceling, retrying, and deleting anyone's jobs on it |
| `settings` | Renaming it, location, default options, adding or removing it, LAN sharing, deleting it |
| `access` | Changing who has access to it |

Every permission includes `view`, and `jobs.manage` includes `jobs.read`. You can always see, cancel, and retry your **own** jobs; retrying still needs `print`.

### Roles

A role is a named set of permissions.

| Built-in role | Permissions |
|---|---|
| **Viewer** | `view` |
| **User** | `view`, `print`, `jobs.read` |
| **Manager** | all 6 |

Admins can create **custom roles** from any combination of the 6 permissions, for example "Prints, sees only own jobs" (`view`, `print`).

Admins can edit a custom role while it's in use, and everyone holding it changes at once. A custom role can't be deleted while a grant, a printer's Everyone setting, or the workspace default uses it.

### Who Can Be Granted Access

- **Everyone**: every member and every device of the workspace.
- **A member**: a single person. Their API tokens and AI assistant connections act as them, still limited by the token's scopes.
- **A group**: a named set of members and devices, managed under **Members > Groups**.
- **A device**: a single paired computer or Raspberry Pi. Device access decides which printers appear in that computer's print window and which jobs it may send.

### Grants

A grant gives a role to a member, a group, or a device, either on **1 printer** or on **every printer** in the workspace (a workspace-wide grant, for example "IT group: Manager on every printer").

Grants never go to Everyone. What Everyone gets is set per printer and by the workspace default, so a restricted printer stays restricted.

Each printer also has an **Everyone** setting, set to one of:
- **Workspace default** (the default is **User**)
- any role
- **No access**

Setting Everyone to **No access** makes a printer **restricted**: Only owners, admins, and explicit grants can use it.

## How Access Is Decided

For an actor and a printer, in order:

1. Workspace **owners and admins** get every permission on every printer. This cannot be turned off, so nobody can lock the workspace out.
2. The **system** (scheduled tasks, internal delivery) is never limited.
3. Otherwise the permissions are the union of:
   - the printer's **Everyone** role (its own setting, or the workspace default), for any member or device of the workspace;
   - every grant **on this printer** whose subject matches: the member, a group containing the member or device, or the device;
   - every **workspace-wide grant** whose subject matches.
4. Implied permissions are added (see above). No permissions means the printer doesn't exist for that actor: Lists leave it out and direct requests get `404`.

Grants only add access. There are no deny rules.

To keep someone out of a printer:
1. Set the printer's **Everyone** setting to **No access**.
2. Grant a role on that printer to the people who need it.

## What Changes Where

| Place | With the extension active |
|---|---|
| Printer lists, details, status, supplies (REST, MCP, web app) | Only printers with `view` |
| Printing (web upload, REST, MCP, test page, identify) | Needs `print` |
| Email to print | A sender who is a member needs `print`. Allowlisted non-members can print only where Everyone has `print` |
| A computer's print window (remote printers) | Shows a printer only if that **device** has `print`. A job the device sends without it fails in the print queue with "You can't print to this printer from this computer" |
| Job lists, job details, documents | Your own jobs, plus jobs on printers where you have `jobs.read` |
| Cancel and retry jobs | Your own jobs (retry needs `print`), or `jobs.manage` on the job's printer |
| Delete jobs | `jobs.manage` on the job's printer, also for your own jobs (without the extension only admins can) |
| Printer settings, add, remove, delete, LAN sharing | Needs `settings` |
| A printer's grants and Everyone setting | Needs `access` |
| Groups, custom roles, workspace-wide grants, workspace default role | Workspace admins and owners |
| Live updates in open browsers | Printer and job events reach only people who can see them; an `access` event tells pages to refresh after any access change |

LAN sharing is outside access control: A printer shared on the local network can be used by anyone on that network. The printer settings page warns about this when a restricted printer is shared.

## Turning It Off

Turn off either switch from [Turning It On](#turning-it-on). The default rules apply immediately.

Groups, roles, and grants are kept, so turning it back on restores them.

## API

All routes are under `/api/workspaces/:ws`. While the extension is off they answer `404 extension_inactive`, except `GET /access/me` and `GET /access/subject`.

| Method and path | Who | Body or result |
|---|---|---|
| `GET /access/me` | members | `MyPrinterAccess` (works with the extension off) |
| `GET /access` | members | `WorkspaceAccess` |
| `PATCH /access` | admins | `{ "defaultRole": "user" }` (a role, or `none` to restrict every printer without its own setting) |
| `GET /access/printers` | members | `PrinterAccessSummary[]` for printers they can see |
| `GET /access/explain?printer=<id>&subject=<type>:<id>` | admins, or `access` on that printer | `AccessExplanation`; `subject` is `everyone`, `user:<id>`, `group:<id>` or `client:<id>` |
| `GET /access/subject?subject=<type>:<id>` | admins | `{ "printers": { "<printerId>": [...] } }`: the subject's permissions on every printer it can see. Works with the extension off, using today's rules (members `view`, `print`, `jobs.read` everywhere; devices `view`, `print` on added printers of other devices) |
| `POST /access/roles` | admins | `{ "name", "description"?, "permissions": [...] }` returns `PrinterRole` |
| `PATCH /access/roles/:id`, `DELETE /access/roles/:id` | admins | Edit, or delete when unused (`409 role_in_use`) |
| `POST /access/grants` | admins | Workspace-wide grant: `{ "subject": { "type", "id" }, "role" }` returns `PrinterGrant`. Granting the same subject again replaces its role. Everyone is not a subject here: change the workspace default role |
| `DELETE /access/grants/:id` | admins, or `access` on the grant's printer | Remove any grant |
| `GET /groups`, `POST /groups` | members read, admins write | `Group[]`; create `{ "name", "description"? }` |
| `PATCH /groups/:id`, `DELETE /groups/:id` | admins | Rename, describe, delete (its grants go with it) |
| `PUT /groups/:id/members/:type/:memberId`, `DELETE` the same | admins | Add or remove a member (`user`) or device (`client`) |
| `GET /printers/:id/access` | `access` on the printer | `PrinterAccess` |
| `PATCH /printers/:id/access` | `access` on the printer | `{ "everyoneRole": "none" }` (or a role, or `null` for the default) |
| `POST /printers/:id/access/grants` | `access` on the printer | `{ "subject", "role" }` returns `PrinterGrant`. Everyone is not a subject here: use the printer's Everyone setting |

Every change is audited (`access.update`, `access.grant`, `access.revoke`, `access.role_create`, `access.role_update`, `access.role_delete`, `group.create`, `group.update`, `group.delete`, `group.add`, `group.remove`) and followed by an `access` event.

Errors:
- `403 printer_access_denied`: a permission is missing.
- `404 not_found`: a printer or job the caller can't see. A device's job for a printer it can't see gets `404 printer_access_denied`.
- `409 role_in_use`: deleting a role that's still in use.
- `409 name_taken`: a group or role name already in use, built-in role names included.

## MCP

These tools are listed when the extension is available on the instance. While it is inactive in the workspace, each call fails with a message that says how to turn it on.

- `list_groups`
- `create_group`, `update_group`, `delete_group`
- `set_group_member`
- `list_printer_roles`
- `create_printer_role`, `update_printer_role`, `delete_printer_role`
- `get_printer_access`
- `set_printer_everyone_role`
- `grant_printer_access`
- `revoke_printer_access`
- `explain_printer_access`

Existing printer and job tools follow the same rules as the REST API.
