import { env } from 'cloudflare:workers'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import { connectPrinter, eventually, type Station } from './helpers/device'
import { callTool, legacy, modern } from './helpers/mcp'
import { insertToken } from './helpers/tokens'
import { addMember, createPat, enrollDevice, setupOwner, type Owner } from './helpers/world'

const TOOL_NAMES = [
  'get_setup_status', 'whoami', 'list_workspaces', 'create_workspace', 'update_workspace', 'list_members', 'invite_member',
  'update_member_role', 'remove_member', 'list_audit', 'list_devices', 'update_device', 'remove_device', 'create_device_install',
  'device_command', 'list_printers', 'get_printer', 'update_printer', 'remove_printer', 'identify_printer', 'print_test_page',
  'print', 'list_jobs', 'get_job', 'cancel_job', 'retry_job', 'get_instance_settings', 'update_instance_settings',
]

let owner: Owner
let token: string
const stations: Station[] = []

beforeAll(async () => {
  owner = await setupOwner()
  token = await createPat(owner)
})
afterEach(() => {
  for (const s of stations.splice(0)) s.device.close()
})

describe('tool catalog', () => {
  it('lists the 28 tools with strict schemas and explicit annotations', async () => {
    const tools = (await legacy(token, 'tools/list')).body.result.tools
    expect(tools.map((t: { name: string }) => t.name)).toEqual(TOOL_NAMES)
    for (const t of tools) {
      expect(t.inputSchema).toMatchObject({ type: 'object', additionalProperties: false })
      expect(t.annotations).toMatchObject({ title: t.title, openWorldHint: false })
      expect(typeof t.annotations.readOnlyHint).toBe('boolean')
      expect(t.annotations.readOnlyHint).toBe(/^(get|list|whoami)/.test(t.name))
      if (t.name.startsWith('remove_')) expect(t.annotations.destructiveHint).toBe(true)
    }
  })
})

describe('tool calls', () => {
  it('return a summary, the same data as JSON text, and structuredContent', async () => {
    const r = await callTool(token, 'whoami')
    const content = r.reply.body.result.content
    expect(content).toHaveLength(2)
    expect(JSON.parse(content[1].text)).toEqual(r.data)
    expect(r.data.user.id).toBe(owner.user.id)
    expect(r.data.workspaces).toEqual([expect.objectContaining({ id: owner.workspaceId, role: 'owner' })])
    expect(r.data.limitedTo).toBeNull()
    expect(r.summary).toContain('instance admin')
  })

  it('report bad calls in a form the model can fix', async () => {
    const unknown = await modern(token, 'tools/call', { name: 'nope', arguments: {} }, { 'Mcp-Name': 'nope' })
    expect(unknown.body.error).toMatchObject({ code: -32602, message: 'Unknown tool: nope' })
    const notObject = await modern(token, 'tools/call', { name: 'whoami', arguments: [1] })
    expect(notObject.body.error.code).toBe(-32602)
    const extra = await callTool(token, 'list_jobs', { bogus: 1 })
    expect(extra.isError).toBe(true)
    expect(extra.summary).toMatch(/^Unknown argument bogus\. Allowed: /)
    const missing = await callTool(token, 'get_job', {})
    expect(missing.summary).toBe('Missing required argument jobId.')
    const service = await callTool(token, 'get_job', { jobId: 'missing' })
    expect(service.isError).toBe(true)
    expect(service.reply.status).toBe(200)
  })

  it('walk a new workspace through setup, naming the next tool each time', async () => {
    const next = async () => (await callTool(token, 'get_setup_status')).data.next
    expect(await next()).toMatchObject({ tool: 'create_device_install', arguments: { workspaceId: owner.workspaceId } })
    await enrollDevice(owner)
    expect((await next()).tool).toBe('list_devices')
    const station = await connectPrinter(owner)
    stations.push(station)
    expect(await next()).toMatchObject({ tool: 'print_test_page', arguments: { printerId: station.printerId } })
    const status = await callTool(token, 'get_setup_status')
    expect(status.data.checklist).toMatchObject({ devicesPaired: 2, devicesOnline: 1, printersAdded: 1, firstPrintDone: false, members: 1 })

    const loner = await addMember(owner)
    await loner.agent.del(`/api/workspaces/${owner.workspaceId}/members/${loner.user.id}`)
    const empty = await callTool(await createPat(loner), 'get_setup_status')
    expect(empty.data).toMatchObject({ checklist: null, next: { tool: 'create_workspace' } })
  })

  it('resolve the workspace from the pin, the argument, or the only membership', async () => {
    const work = (await callTool(token, 'create_workspace', { name: 'Work' })).data.workspace
    const ambiguous = await callTool(token, 'list_printers')
    expect(ambiguous.isError).toBe(true)
    expect(ambiguous.summary).toContain(`Home (${owner.workspaceId})`)
    expect(ambiguous.summary).toContain(`Work (${work.id})`)
    expect((await callTool(token, 'list_printers', { workspaceId: work.id })).isError).toBe(false)

    const pinned = await createPat(owner, owner.workspaceId)
    expect((await callTool(pinned, 'list_printers')).isError).toBe(false)
    const crossing = await callTool(pinned, 'list_printers', { workspaceId: work.id })
    expect(crossing.summary).toContain('limited to workspace')
    expect((await callTool(pinned, 'whoami')).data.limitedTo).toBe(owner.workspaceId)
  })

  it('print text end to end and manage the job', async () => {
    const station = await connectPrinter(owner, 'usb:04f9:0042:MCP1')
    stations.push(station)
    const ws = { workspaceId: owner.workspaceId }
    const printed = await callTool(token, 'print', { ...ws, printerId: station.printerId, text: 'Hello from MCP', title: 'Greeting' })
    expect(printed.data.job).toMatchObject({ title: 'Greeting', status: 'queued', source: 'mcp', printerId: station.printerId })
    const offer = await station.device.next('job')
    expect(offer.job).toMatchObject({ id: printed.data.job.id, contentType: 'text/plain', attempt: 1 })

    station.device.send({ type: 'job_status', jobId: offer.job.id, status: 'dispatched', attempt: 1 })
    await eventually(async () => expect((await callTool(token, 'get_job', { ...ws, jobId: offer.job.id })).data.job.status).toBe('dispatched'))
    const cancel = await callTool(token, 'cancel_job', { ...ws, jobId: offer.job.id })
    expect(cancel.data.job.statusMessage).toBe('Canceling…')
    expect((await station.device.next('cancel')).jobId).toBe(offer.job.id)
    station.device.send({ type: 'job_status', jobId: offer.job.id, status: 'canceled', attempt: 1 })
    await eventually(async () => expect((await callTool(token, 'get_job', { ...ws, jobId: offer.job.id })).data.job.status).toBe('canceled'))

    const retried = await callTool(token, 'retry_job', { ...ws, jobId: offer.job.id })
    expect(retried.data.job.status).toBe('queued')
    expect((await station.device.next('job')).job.attempt).toBe(2)
    const listed = await callTool(token, 'list_jobs', { ...ws, printerId: station.printerId })
    expect(listed.data.items.map((j: { id: string }) => j.id)).toContain(offer.job.id)
  })

  it('print base64 documents and explain what is missing', async () => {
    const station = await connectPrinter(owner, 'usb:04f9:0042:MCP2')
    stations.push(station)
    const ws = { workspaceId: owner.workspaceId }
    const pdf = btoa('%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n')
    const job = await callTool(token, 'print', { ...ws, printerId: station.printerId, base64: pdf, contentType: 'application/pdf', fileName: 'pass.pdf' })
    expect(job.data.job).toMatchObject({ contentType: 'application/pdf', size: atob(pdf).length })
    const both = await callTool(token, 'print', { ...ws, printerId: station.printerId, text: 'a', url: 'https://example.com/a.pdf' })
    expect(both.summary).toBe('Provide exactly one of upload, text, url, or base64')
    const noPrinter = await callTool(token, 'print', { ...ws, text: 'hi' })
    expect(noPrinter.summary).toContain('Choose a printer')
  })

  it('surface offline devices, admin-only tools and audit attribution', async () => {
    const offline = await enrollDevice(owner)
    const ws = { workspaceId: owner.workspaceId }
    const cmd = await callTool(token, 'device_command', { ...ws, deviceId: offline.clientId, name: 'discover' })
    expect(cmd.summary).toBe('The device is offline')

    const member = await addMember(owner)
    const memberToken = await createPat(member)
    expect((await callTool(memberToken, 'get_instance_settings')).summary).toBe('Instance administrators only')
    expect((await callTool(memberToken, 'create_device_install', ws)).isError).toBe(true)
    const settings = await callTool(token, 'get_instance_settings')
    expect(settings.data.settings.sso.google).toHaveProperty('hasSecret', false)

    const invite = await callTool(token, 'invite_member', { ...ws, role: 'member' })
    expect(invite.data.url).toMatch(/^https:\/\/print\.test\/invite\/pbi_/)
    const audit = await callTool(token, 'list_audit', ws)
    expect(audit.data.items[0]).toMatchObject({ action: 'invite.create', actorType: 'token' })
  })

  it('accept read-only OAuth tokens for reads only', async () => {
    const reader = await insertToken(owner.user.id, { kind: 'oauth-access', scopes: ['read'], resource: 'https://print.test/mcp', workspaceId: owner.workspaceId })
    expect((await callTool(reader, 'list_devices')).isError).toBe(false)
    expect((await callTool(reader, 'print_test_page', { printerId: 'x' })).reply.status).toBe(403)
    const rows = await env.DB.prepare("SELECT COUNT(*) AS n FROM jobs WHERE source = 'test'").first<{ n: number }>()
    expect(rows?.n).toBe(0)
  })
})
