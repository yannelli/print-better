import { HUB_HEADERS, upgradeRequest } from '../hub/sockets'
import { ctxOf, publicCtx } from '../http/authenticate'
import { readJson } from '../http/body'
import type { Router } from '../http/router'
import { requireMember } from '../services/access'
import { listAudit } from '../services/audit'
import { hubFor } from '../services/hub'
import { acceptInvite, createInvite, deleteInvite, listInvites, previewInvite } from '../services/invites'
import { listMembers, removeMember, updateMemberRole } from '../services/members'
import { createWorkspace, deleteWorkspace, getWorkspace, listWorkspaces, patchWorkspace } from '../services/workspaces'
import { requireUpgrade } from './respond'

export function workspaceRoutes(r: Router): void {
  r.get('/api/workspaces', async (h) => listWorkspaces(await ctxOf(h)))
  r.post('/api/workspaces', async (h) => createWorkspace(await ctxOf(h), await readJson(h.req)))
  r.get('/api/workspaces/:ws', async (h) => getWorkspace(await ctxOf(h), h.params.ws))
  r.patch('/api/workspaces/:ws', async (h) => patchWorkspace(await ctxOf(h), h.params.ws, await readJson(h.req)))
  r.delete('/api/workspaces/:ws', async (h) => {
    await deleteWorkspace(await ctxOf(h), h.params.ws)
  })

  r.get('/api/workspaces/:ws/members', async (h) => listMembers(await ctxOf(h), h.params.ws))
  r.patch('/api/workspaces/:ws/members/:userId', async (h) => updateMemberRole(await ctxOf(h), h.params.ws, h.params.userId, await readJson(h.req)))
  r.delete('/api/workspaces/:ws/members/:userId', async (h) => {
    await removeMember(await ctxOf(h), h.params.ws, h.params.userId)
  })

  r.get('/api/workspaces/:ws/invites', async (h) => listInvites(await ctxOf(h), h.params.ws))
  r.post('/api/workspaces/:ws/invites', async (h) => createInvite(await ctxOf(h), h.params.ws, await readJson(h.req)))
  r.delete('/api/workspaces/:ws/invites/:id', async (h) => {
    await deleteInvite(await ctxOf(h), h.params.ws, h.params.id)
  })
  r.get('/api/invites/:token', (h) => previewInvite(publicCtx(h), h.params.token))
  r.post('/api/invites/:token/accept', async (h) => acceptInvite(await ctxOf(h), h.params.token))

  r.get('/api/workspaces/:ws/audit', async (h) => listAudit(await ctxOf(h), h.params.ws, h.url.searchParams.get('cursor'), h.url.searchParams.get('limit')))

  r.get('/api/workspaces/:ws/events', async (h) => {
    requireUpgrade(h)
    const { user } = await requireMember(await ctxOf(h), h.params.ws)
    return hubFor(h.env, h.params.ws).fetch(
      upgradeRequest(h.req.url, {
        [HUB_HEADERS.kind]: 'ui',
        [HUB_HEADERS.workspace]: h.params.ws,
        [HUB_HEADERS.user]: user.id,
        [HUB_HEADERS.origin]: h.url.origin,
      }),
    )
  })
}
