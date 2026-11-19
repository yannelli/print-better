import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import { ids, setAvailable, setEnabled, setEveryone } from './helpers/access'
import { connectPrinter, type Station } from './helpers/device'
import { callTool, legacy, modern } from './helpers/mcp'
import { addMember, createPat, setupOwner, type Owner, type Person } from './helpers/world'

const ACCESS_TOOLS = [
  'list_groups', 'create_group', 'update_group', 'delete_group', 'set_group_member', 'list_printer_roles', 'create_printer_role',
  'update_printer_role', 'delete_printer_role', 'get_printer_access', 'set_printer_everyone_role', 'grant_printer_access',
  'revoke_printer_access', 'explain_printer_access',
]
const TURNED_OFF = 'Printer access is turned off for this workspace.'

let owner: Owner
let token: string
let bob: Person
let bobToken: string
const stations: Station[] = []

beforeAll(async () => {
  owner = await setupOwner()
  token = await createPat(owner, owner.workspaceId)
  bob = await addMember(owner)
  bobToken = await createPat(bob, owner.workspaceId)
})
afterEach(async () => {
  for (const s of stations.splice(0)) s.device.close()
  await setEnabled(owner, owner.workspaceId, false)
  await setAvailable(owner, false)
})

let keys = 0
async function printer(): Promise<string> {
  const s = await connectPrinter(owner, `usb:mcp${++keys}`)
  stations.push(s)
  return s.printerId
}

async function turnOn(): Promise<void> {
  await setAvailable(owner, true)
  await setEnabled(owner, owner.workspaceId, true)
}

const names = async (t: string) => (await legacy(t, 'tools/list')).body.result.tools.map((x: { name: string }) => x.name)

describe('printer access tools', () => {
  it('are listed only while the extension is available on the instance', async () => {
    const core = await names(token)
    expect(core).toHaveLength(28)
    await setAvailable(owner, true)
    expect(await names(token)).toEqual([...core, ...ACCESS_TOOLS])
    expect(await names(bobToken)).toHaveLength(42)
    const modernList = (await modern(token, 'tools/list')).body.result.tools
    for (const t of modernList.slice(28)) {
      expect(t.inputSchema).toMatchObject({ type: 'object', additionalProperties: false })
      expect(t.annotations.readOnlyHint).toBe(/^(get|list|explain)/.test(t.name))
      if (t.name.startsWith('delete_') || t.name.startsWith('revoke_')) expect(t.annotations.destructiveHint).toBe(true)
    }
    await setAvailable(owner, false)
    const gone = await callTool(token, 'list_groups')
    expect(gone.reply.body.error).toMatchObject({ code: -32602, message: 'Unknown tool: list_groups' })
  })

  it('explain that the extension is off in the workspace', async () => {
    await setAvailable(owner, true)
    const off = await callTool(token, 'list_groups')
    expect(off.isError).toBe(true)
    expect(off.summary).toContain(TURNED_OFF)
    expect((await callTool(token, 'grant_printer_access', { subject: { type: 'everyone' }, role: 'user' })).summary).toContain(TURNED_OFF)
  })

  it('manage groups, roles and grants, and explain the result', async () => {
    await turnOn()
    const printerId = await printer()
    const group = (await callTool(token, 'create_group', { name: 'Front office' })).data.group
    const joined = await callTool(token, 'set_group_member', { groupId: group.id, memberType: 'user', memberId: bob.user.id, inGroup: true })
    expect(joined.summary).toBe(`Front office: ${bob.user.name}.`)
    const role = (await callTool(token, 'create_printer_role', { name: 'Prints only', permissions: ['print'] })).data.role
    expect(role.permissions).toEqual(['view', 'print'])
    expect((await callTool(token, 'list_printer_roles')).data.roles.map((r: { id: string }) => r.id)).toEqual(['viewer', 'user', 'manager', role.id])

    expect((await callTool(token, 'set_printer_everyone_role', { printerId, role: 'none' })).summary).toBe('Everyone now gets none on this printer.')
    const granted = await callTool(token, 'grant_printer_access', { printerId, subject: { type: 'group', id: group.id }, role: role.id })
    expect(granted.summary).toBe(`Granted Front office: ${role.id} (grant ${granted.data.grant.id}).`)
    const why = await callTool(token, 'explain_printer_access', { printerId, subject: { type: 'user', id: bob.user.id } })
    expect(why.data.explanation.permissions).toEqual(['view', 'print'])
    expect(why.summary).toBe(`view, print (grant ${granted.data.grant.id}: ${role.id}).`)
    const access = (await callTool(token, 'get_printer_access', { printerId })).data.access
    expect(access).toMatchObject({ everyoneRole: 'none', effectiveEveryoneRole: 'none', grants: [{ id: granted.data.grant.id }] })

    expect((await callTool(token, 'delete_printer_role', { roleId: role.id })).summary).toContain('is still used')
    expect((await callTool(token, 'revoke_printer_access', { grantId: granted.data.grant.id })).isError).toBe(false)
    expect((await callTool(token, 'delete_printer_role', { roleId: role.id })).data).toEqual({ removed: role.id })
    expect((await callTool(token, 'set_printer_everyone_role', { role: 'viewer' })).data.access.defaultRole).toBe('viewer')
    await callTool(token, 'set_printer_everyone_role', { role: 'user' })
    expect((await callTool(token, 'set_printer_everyone_role', { printerId })).summary).toContain('role is required')
    expect((await callTool(token, 'delete_group', { groupId: group.id })).isError).toBe(false)
  })

  it('keep management to admins and people with access on the printer', async () => {
    await turnOn()
    const printerId = await printer()
    expect((await callTool(bobToken, 'create_group', { name: 'Mine' })).summary).toBe('Only admins can do that')
    expect((await callTool(bobToken, 'list_groups')).isError).toBe(false)
    const denied = await callTool(bobToken, 'grant_printer_access', { printerId, subject: { type: 'user', id: bob.user.id }, role: 'manager' })
    expect(denied.summary).toBe("You don't have permission to change who can use this printer")
    await callTool(token, 'grant_printer_access', { printerId, subject: { type: 'user', id: bob.user.id }, role: 'manager' })
    expect((await callTool(bobToken, 'get_printer_access', { printerId })).isError).toBe(false)
  })
})

describe('core tools with printer access on', () => {
  it('follow the same rules as the REST API', async () => {
    await turnOn()
    const printerId = await printer()
    await setEveryone(owner.agent, owner.workspaceId, printerId, 'none')
    const listed = async () => ids((await callTool(bobToken, 'list_printers')).data.printers)
    expect(await listed()).not.toContain(printerId)
    expect((await callTool(bobToken, 'get_printer', { printerId })).summary).toBe('Printer not found')
    await setEveryone(owner.agent, owner.workspaceId, printerId, 'viewer')
    expect(await listed()).toContain(printerId)
    const refused = await callTool(bobToken, 'print', { printerId, text: 'Hello' })
    expect(refused.summary).toBe("You don't have permission to print to this printer")
    expect((await callTool(bobToken, 'identify_printer', { printerId })).summary).toBe("You don't have permission to print to this printer")
    await setEveryone(owner.agent, owner.workspaceId, printerId, null)
    expect((await callTool(bobToken, 'print', { printerId, text: 'Hello' })).data.job.status).toBe('queued')
  })
})
