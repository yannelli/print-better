import { HUB_HEADERS, upgradeRequest } from '../hub/sockets'
import { PROTOCOL_VERSION } from '../../shared/protocol'
import { clientCtx, ctxOf, publicCtx, requireClient } from '../http/authenticate'
import { readJson } from '../http/body'
import { badRequest } from '../http/errors'
import type { Router } from '../http/router'
import { latestBuild } from '../install/serve'
import { cancelClientJob, createClientJob, getClientJob, uploadClientJob } from '../services/client-jobs'
import { deleteClient, getClient, listClients, patchClient, runCommand } from '../services/clients'
import { approveDeviceCode, denyDeviceCode, describeDeviceCode, pollDeviceCode, startDeviceCode } from '../services/device-codes'
import { createEnrollment, deleteEnrollment, enroll, listEnrollments } from '../services/enrollments'
import { hubFor } from '../services/hub'
import { clientJobDocument } from '../services/jobs'
import { documentResponse, requireUpgrade } from './respond'

/** Devices (clients) as managed from the web UI, plus device-code approval. */
export function deviceRoutes(r: Router): void {
  r.get('/api/workspaces/:ws/clients', async (h) => listClients(await ctxOf(h), h.params.ws))
  r.get('/api/workspaces/:ws/clients/:id', async (h) => getClient(await ctxOf(h), h.params.ws, h.params.id))
  r.patch('/api/workspaces/:ws/clients/:id', async (h) => patchClient(await ctxOf(h), h.params.ws, h.params.id, await readJson(h.req)))
  r.delete('/api/workspaces/:ws/clients/:id', async (h) => {
    await deleteClient(await ctxOf(h), h.params.ws, h.params.id)
  })
  r.post('/api/workspaces/:ws/clients/:id/commands', async (h) => runCommand(await ctxOf(h), h.params.ws, h.params.id, await readJson(h.req)))

  r.get('/api/workspaces/:ws/enrollments', async (h) => listEnrollments(await ctxOf(h), h.params.ws))
  r.post('/api/workspaces/:ws/enrollments', async (h) => createEnrollment(await ctxOf(h), h.params.ws, await readJson(h.req)))
  r.delete('/api/workspaces/:ws/enrollments/:id', async (h) => {
    await deleteEnrollment(await ctxOf(h), h.params.ws, h.params.id)
  })

  r.get('/api/device/:userCode', async (h) => describeDeviceCode(await ctxOf(h), h.params.userCode))
  r.post('/api/device/:userCode/approve', async (h) => {
    await approveDeviceCode(await ctxOf(h), h.params.userCode, await readJson(h.req))
  })
  r.post('/api/device/:userCode/deny', async (h) => {
    await denyDeviceCode(await ctxOf(h), h.params.userCode)
  })
}

/** Endpoints the Rust client calls (docs/protocol.md). */
export function clientRoutes(r: Router): void {
  r.post('/api/client/enroll', async (h) => enroll(publicCtx(h), await readJson(h.req)))
  r.post('/api/client/device/code', async (h) => startDeviceCode(publicCtx(h), await readJson(h.req)))
  r.post('/api/client/device/token', async (h) => pollDeviceCode(publicCtx(h), await readJson(h.req)))

  r.get('/api/client/ws', async (h) => {
    requireUpgrade(h)
    const protocol = h.req.headers.get('X-PB-Protocol')
    if (protocol !== null && protocol !== String(PROTOCOL_VERSION)) throw badRequest(`Unsupported protocol ${protocol}; this server speaks ${PROTOCOL_VERSION}`, 'unsupported_protocol')
    const client = await requireClient(h)
    return hubFor(h.env, client.workspace_id).fetch(
      upgradeRequest(h.req.url, {
        [HUB_HEADERS.kind]: 'client',
        [HUB_HEADERS.workspace]: client.workspace_id,
        [HUB_HEADERS.client]: client.id,
        [HUB_HEADERS.origin]: h.url.origin,
      }),
    )
  })

  r.get('/api/client/jobs/:id/file', async (h) => {
    const client = await requireClient(h)
    const { job, object } = await clientJobDocument(h.env, client.id, h.params.id)
    return documentResponse(job, object, false)
  })

  // Jobs this device submits from its own print dialog (docs/remote-printers.md).
  r.post('/api/client/jobs', async (h) => {
    const client = await requireClient(h)
    return Response.json(await createClientJob(clientCtx(h, client), client, await readJson(h.req)), { status: 201 })
  })
  r.get('/api/client/jobs/:id', async (h) => ({ job: await getClientJob(h.env, await requireClient(h), h.params.id) }))
  r.put('/api/client/jobs/:id/file', async (h) => {
    const client = await requireClient(h)
    return { job: await uploadClientJob(clientCtx(h, client), client, h.params.id, h.req) }
  })
  r.post('/api/client/jobs/:id/cancel', async (h) => {
    const client = await requireClient(h)
    return { job: await cancelClientJob(clientCtx(h, client), client, h.params.id) }
  })

  r.get('/api/client/latest', async (h) => {
    await requireClient(h)
    return latestBuild(h.env, h.url)
  })
}
