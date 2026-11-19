import { ctxOf } from '../../http/authenticate'
import { readJson } from '../../http/body'
import type { Router } from '../../http/router'
import { getPrinterAccess, grantPrinterAccess, grantWorkspaceAccess, revokeGrant, setEveryoneRole } from './grants'
import { createGroup, deleteGroup, listGroups, setGroupMember, updateGroup } from './groups'
import { createRole, deleteRole, updateRole } from './roles'
import { explainAccess, getWorkspaceAccess, printerSummaries, setDefaultRole, subjectAccess } from './settings'

const WS = '/api/workspaces/:ws'

/** docs/printer-access.md. Every route answers 404 extension_inactive while the extension is off, except /access/subject. */
export function printerAccessRoutes(r: Router): void {
  r.get(`${WS}/access`, async (h) => getWorkspaceAccess(await ctxOf(h), h.params.ws))
  r.patch(`${WS}/access`, async (h) => setDefaultRole(await ctxOf(h), h.params.ws, await readJson(h.req)))
  r.get(`${WS}/access/printers`, async (h) => printerSummaries(await ctxOf(h), h.params.ws))
  r.get(`${WS}/access/explain`, async (h) => explainAccess(await ctxOf(h), h.params.ws, h.url.searchParams.get('printer'), h.url.searchParams.get('subject')))
  r.get(`${WS}/access/subject`, async (h) => subjectAccess(await ctxOf(h), h.params.ws, h.url.searchParams.get('subject')))
  r.post(`${WS}/access/roles`, async (h) => createRole(await ctxOf(h), h.params.ws, await readJson(h.req)))
  r.patch(`${WS}/access/roles/:id`, async (h) => updateRole(await ctxOf(h), h.params.ws, h.params.id, await readJson(h.req)))
  r.delete(`${WS}/access/roles/:id`, async (h) => {
    await deleteRole(await ctxOf(h), h.params.ws, h.params.id)
  })
  r.post(`${WS}/access/grants`, async (h) => grantWorkspaceAccess(await ctxOf(h), h.params.ws, await readJson(h.req)))
  r.delete(`${WS}/access/grants/:id`, async (h) => {
    await revokeGrant(await ctxOf(h), h.params.ws, h.params.id)
  })

  r.get(`${WS}/groups`, async (h) => listGroups(await ctxOf(h), h.params.ws))
  r.post(`${WS}/groups`, async (h) => createGroup(await ctxOf(h), h.params.ws, await readJson(h.req)))
  r.patch(`${WS}/groups/:id`, async (h) => updateGroup(await ctxOf(h), h.params.ws, h.params.id, await readJson(h.req)))
  r.delete(`${WS}/groups/:id`, async (h) => {
    await deleteGroup(await ctxOf(h), h.params.ws, h.params.id)
  })
  r.put(`${WS}/groups/:id/members/:type/:memberId`, async (h) => setGroupMember(await ctxOf(h), h.params.ws, h.params.id, h.params.type, h.params.memberId, true))
  r.delete(`${WS}/groups/:id/members/:type/:memberId`, async (h) => setGroupMember(await ctxOf(h), h.params.ws, h.params.id, h.params.type, h.params.memberId, false))

  r.get(`${WS}/printers/:id/access`, async (h) => getPrinterAccess(await ctxOf(h), h.params.ws, h.params.id))
  r.patch(`${WS}/printers/:id/access`, async (h) => setEveryoneRole(await ctxOf(h), h.params.ws, h.params.id, await readJson(h.req)))
  r.post(`${WS}/printers/:id/access/grants`, async (h) => grantPrinterAccess(await ctxOf(h), h.params.ws, h.params.id, await readJson(h.req)))
}
