import { env } from 'cloudflare:workers'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import { grant, newGroup, ok, setAvailable, setEnabled, setEveryone, turnOnAccess, wsPath } from './helpers/access'
import { connectPrinter, Device } from './helpers/device'
import { EventSocket, freshWorkspace } from './helpers/jobs'
import { addMember, enrollDevice, setupOwner, type Owner } from './helpers/world'

let owner: Owner
beforeAll(async () => {
  owner = await setupOwner()
})

const sockets: { close(): void }[] = []
afterEach(() => {
  for (const s of sockets.splice(0)) s.close()
})

const INFO = { id: 'printer-access', name: 'Printer access', summary: expect.any(String), docs: 'docs/printer-access.md' }
/** The other catalog entries, listed after printer access and off by default; Enterprise controls joins once it is built. */
const LATER = [{ id: 'print-policies', name: 'Print rules and limits', summary: expect.any(String), docs: 'docs/print-policies.md' }]
const workspaceSwitch = async (ws: string) => (await owner.agent.get(wsPath(ws, '/extensions'))).body[0]
const auditActions = async (ws: string | null) =>
  (await env.DB.prepare("SELECT action, target, data FROM audit_log WHERE workspace_id IS ? AND action = 'extension.update' ORDER BY id").bind(ws).all()).results

describe('instance switch', () => {
  it('lists the catalog for instance admins only, everything off by default', async () => {
    expect((await owner.agent.get('/api/admin/extensions')).body).toEqual([INFO, ...LATER].map((e) => ({ ...e, available: false, enabledWorkspaces: 0 })))
    const member = await addMember(owner)
    expect((await member.agent.get('/api/admin/extensions')).status).toBe(403)
    expect((await member.agent.patch('/api/admin/extensions/printer-access', { available: true })).status).toBe(403)
  })

  it('validates the extension id and the switch value', async () => {
    expect((await owner.agent.patch('/api/admin/extensions/nope', { available: true })).status).toBe(404)
    expect((await owner.agent.patch('/api/admin/extensions/printer-access', { available: 'yes' })).body.error.code).toBe('invalid_request')
    expect((await owner.agent.patch(wsPath(owner.workspaceId, '/extensions/nope'), { enabled: true })).status).toBe(404)
  })
})

describe('workspace switch', () => {
  it('shows members the state, lets only owners flip it, and needs availability to turn on', async () => {
    const ws = await freshWorkspace(owner, 'Switches')
    const admin = await addMember(owner, 'admin', ws)
    expect((await admin.agent.get(wsPath(ws, '/extensions'))).body).toEqual([INFO, ...LATER].map((e) => ({ ...e, available: false, enabled: false, active: false })))
    expect((await admin.agent.patch(wsPath(ws, '/extensions/printer-access'), { enabled: true })).status).toBe(403)
    const refused = await owner.agent.patch(wsPath(ws, '/extensions/printer-access'), { enabled: true })
    expect(refused).toMatchObject({ status: 409, body: { error: { code: 'extension_unavailable' } } })

    await setAvailable(owner, true)
    expect(await setEnabled(owner, ws, true)).toEqual({ ...INFO, available: true, enabled: true, active: true })
    await setAvailable(owner, false)
    expect(await workspaceSwitch(ws)).toEqual({ ...INFO, available: false, enabled: true, active: false })
    expect((await owner.agent.get('/api/admin/extensions')).body[0]).toMatchObject({ available: false, enabledWorkspaces: 1 })
    expect(await setEnabled(owner, ws, false)).toMatchObject({ enabled: false, active: false })
    expect((await owner.agent.get('/api/admin/extensions')).body[0].enabledWorkspaces).toBe(0)
  })

  it('makes the extension active only while both switches are on, keeping its data while off', async () => {
    const ws = await freshWorkspace(owner, 'Keeps data')
    const s = await connectPrinter(owner, 'usb:keep', ws)
    sockets.push(s.device)
    await turnOnAccess(owner, ws)
    const groupId = await newGroup(owner.agent, ws, 'Front office')
    const role = ok(await owner.agent.post(wsPath(ws, '/access/roles'), { name: 'Prints only', permissions: ['print'] }), 'role')
    await grant(owner.agent, ws, s.printerId, { type: 'group', id: groupId }, role.id)
    await setEveryone(owner.agent, ws, s.printerId, 'none')

    const inactive = async () => {
      const r = await owner.agent.get(wsPath(ws, '/groups'))
      expect(r).toMatchObject({ status: 404, body: { error: { code: 'extension_inactive' } } })
      expect((await owner.agent.get(wsPath(ws, '/access/me'))).body.managed).toBe(false)
    }
    await setEnabled(owner, ws, false)
    await inactive()
    await setEnabled(owner, ws, true)
    await setAvailable(owner, false)
    await inactive()
    await setAvailable(owner, true)

    expect((await owner.agent.get(wsPath(ws, '/groups'))).body.map((g: { name: string }) => g.name)).toEqual(['Front office'])
    const printer = (await owner.agent.get(wsPath(ws, `/printers/${s.printerId}/access`))).body
    expect(printer).toMatchObject({ everyoneRole: 'none', grants: [{ subject: { type: 'group', id: groupId }, role: role.id }] })
    expect((await owner.agent.get(wsPath(ws, '/access/me'))).body.managed).toBe(true)
  })

  it('audits both switches, only when they move', async () => {
    const ws = await freshWorkspace(owner, 'Audited')
    await setAvailable(owner, false)
    await setAvailable(owner, true)
    await setAvailable(owner, true)
    await setEnabled(owner, ws, true)
    await setEnabled(owner, ws, true)
    await setEnabled(owner, ws, false)
    const instance = (await auditActions(null)).slice(-2)
    expect(instance.map((a) => [a.target, JSON.parse(String(a.data))])).toEqual([
      ['printer-access', { available: false }],
      ['printer-access', { available: true }],
    ])
    expect((await auditActions(ws)).map((a) => JSON.parse(String(a.data)))).toEqual([{ enabled: true }, { enabled: false }])
  })

  it('tells open pages and refreshes device snapshots whenever a switch moves', async () => {
    const ws = await freshWorkspace(owner, 'Live')
    const s = await connectPrinter(owner, 'usb:live', ws)
    sockets.push(s.device)
    const { token } = await enrollDevice(owner, ws)
    const desk = await Device.connect(token)
    sockets.push(desk)
    await desk.hello({ os: 'macos' })
    expect((await desk.next('remote_printers')).printers.map((p) => p.id)).toEqual([s.printerId])
    const ui = await EventSocket.open(owner.agent, ws)
    sockets.push(ui)

    await turnOnAccess(owner, ws)
    await ui.next('access')
    await setEveryone(owner.agent, ws, s.printerId, 'none')
    await ui.next('access')
    expect((await desk.next('remote_printers')).printers).toEqual([])

    await setEnabled(owner, ws, false)
    await ui.next('access')
    expect((await desk.next('remote_printers')).printers.map((p) => p.id)).toEqual([s.printerId])
    await setEnabled(owner, ws, true)
    expect((await desk.next('remote_printers')).printers).toEqual([])
    await setAvailable(owner, false)
    await ui.next('access', () => true, 5000)
    expect((await desk.next('remote_printers')).printers.map((p) => p.id)).toEqual([s.printerId])
    await setAvailable(owner, true)
  })
})
