import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import { connectPrinter } from './helpers/device'
import { Agent, readReply } from './helpers/http'
import { EventSocket, freshWorkspace, textJob } from './helpers/jobs'
import { addMember, createPat, setupOwner, type Owner } from './helpers/world'

let owner: Owner
beforeAll(async () => {
  owner = await setupOwner()
})

const open: Array<{ close(): void }> = []
afterEach(() => {
  for (const s of open.splice(0)) s.close()
})

const upgrade = async (agent: Agent, ws: string, headers: Record<string, string>) =>
  readReply(await agent.fetch(`/api/workspaces/${ws}/events`, { headers }))

describe('browser events socket', () => {
  it('requires an upgrade, and a matching Origin for cookie sessions', async () => {
    const ws = owner.workspaceId
    expect((await upgrade(owner.agent, ws, {})).status).toBe(426)
    const missing = await upgrade(owner.agent, ws, { Upgrade: 'websocket' })
    expect(missing.status).toBe(403)
    expect(missing.body.error.code).toBe('bad_origin')
    expect((await upgrade(owner.agent, ws, { Upgrade: 'websocket', Origin: 'https://evil.example' })).body.error.code).toBe('bad_origin')
    const ok = await EventSocket.open(owner.agent, ws)
    open.push(ok)
  })

  it('lets a personal API token listen without an Origin', async () => {
    const api = new Agent({ token: await createPat(owner), origin: null })
    open.push(await EventSocket.open(api, owner.workspaceId, {}))
  })

  it('refuses people outside the workspace and signed-out visitors', async () => {
    const ws = await freshWorkspace(owner)
    const outsider = await addMember(owner, 'member')
    expect((await upgrade(outsider.agent, ws, { Upgrade: 'websocket', Origin: 'https://print.test' })).status).toBe(404)
    expect((await upgrade(new Agent(), ws, { Upgrade: 'websocket', Origin: 'https://print.test' })).status).toBe(401)
  })

  it('streams device, printer and job changes as they happen', async () => {
    const ws = await freshWorkspace(owner)
    const events = await EventSocket.open(owner.agent, ws)
    open.push(events)
    const s = await connectPrinter(owner, 'usb:events', ws)
    open.push(s.device)
    expect((await events.next('client', (e) => e.client.id === s.clientId && e.client.online)).client.name).toBe('office-pi')
    expect((await events.next('printer', (e) => e.printer.id === s.printerId)).printer).toMatchObject({ key: 'usb:events', added: true })

    const job = await textJob(owner.agent, ws, s.printerId)
    await events.next('job', (e) => e.job.id === job.id && e.job.status === 'queued')
    s.device.send({ type: 'job_status', jobId: job.id, status: 'printing' })
    expect((await events.next('job', (e) => e.job.id === job.id && e.job.status === 'printing')).job.printerId).toBe(s.printerId)

    s.device.close()
    await events.next('client', (e) => e.client.id === s.clientId && !e.client.online)
  })

  it('tells each browser its own role when workspace settings change', async () => {
    const ws = await freshWorkspace(owner)
    const member = await addMember(owner, 'member', ws)
    const mine = await EventSocket.open(owner.agent, ws)
    const theirs = await EventSocket.open(member.agent, ws)
    open.push(mine, theirs)
    expect((await owner.agent.patch(`/api/workspaces/${ws}`, { name: 'Renamed office' })).status).toBe(200)
    expect((await mine.next('workspace')).workspace).toMatchObject({ name: 'Renamed office', role: 'owner' })
    expect((await theirs.next('workspace')).workspace).toMatchObject({ name: 'Renamed office', role: 'member' })
  })

  it('removes a device from every open tab when it is deleted', async () => {
    const ws = await freshWorkspace(owner)
    const events = await EventSocket.open(owner.agent, ws)
    open.push(events)
    const s = await connectPrinter(owner, 'usb:gone', ws)
    open.push(s.device)
    expect((await owner.agent.del(`/api/workspaces/${ws}/clients/${s.clientId}`)).status).toBe(204)
    expect(await events.next('printer_removed', (e) => e.id === s.printerId)).toEqual({ type: 'printer_removed', id: s.printerId })
    expect(await events.next('client_removed')).toEqual({ type: 'client_removed', id: s.clientId })
  })
})
