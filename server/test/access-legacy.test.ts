import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { PRINTER_PERMISSIONS } from '../shared/access'
import { myAccess, newGroup, ok, setAvailable, setEnabled, turnOnAccess, wsPath } from './helpers/access'
import { connectPrinter, printerReport, type Station } from './helpers/device'
import { Agent } from './helpers/http'
import { freshWorkspace, textJob } from './helpers/jobs'
import { addMember, createPat, enrollDevice, setupOwner, type Owner, type Person } from './helpers/world'

const USER = ['view', 'print', 'jobs.read']

let owner: Owner
let member: Person
let s: Station
let spare: string
let ws: string

beforeAll(async () => {
  owner = await setupOwner()
  ws = owner.workspaceId
  member = await addMember(owner)
  s = await connectPrinter(owner, 'usb:legacy')
  const config = await s.device.report([printerReport('usb:legacy'), printerReport('net:spare', { local: false })])
  spare = config.printers.find((p) => p.key === 'net:spare')?.id as string
  ok(await owner.agent.patch(wsPath(ws, `/printers/${spare}`), { added: false }), 'leave spare discovered')
})
afterAll(() => s.device.close())

describe('with printer access off', () => {
  it('reports today’s access in /access/me: members everything but admin work, owners everything', async () => {
    expect(await myAccess(member.agent, ws)).toEqual({ managed: false, all: false, printers: { [s.printerId]: USER, [spare]: USER } })
    const mine = await myAccess(owner.agent, ws)
    expect(mine).toMatchObject({ managed: false, all: true })
    expect(mine.printers[spare]).toEqual(PRINTER_PERMISSIONS)
    const pat = new Agent({ token: await createPat(member), origin: null })
    expect((await pat.get(wsPath(ws, '/access/me'))).status).toBe(200)
    expect((await new Agent().get(wsPath(ws, '/access/me'))).status).toBe(401)
    expect((await member.agent.get(wsPath(await freshWorkspace(owner), '/access/me'))).status).toBe(404)
  })

  it('answers every printer-access route with 404 extension_inactive', async () => {
    const routes: [string, string][] = [
      ['GET', '/access'],
      ['PATCH', '/access'],
      ['GET', '/access/printers'],
      ['GET', `/access/explain?printer=${s.printerId}&subject=everyone`],
      ['POST', '/access/roles'],
      ['PATCH', '/access/roles/r1'],
      ['DELETE', '/access/roles/r1'],
      ['POST', '/access/grants'],
      ['DELETE', '/access/grants/g1'],
      ['GET', '/groups'],
      ['POST', '/groups'],
      ['PATCH', '/groups/g1'],
      ['DELETE', '/groups/g1'],
      ['PUT', `/groups/g1/members/user/${member.user.id}`],
      ['DELETE', `/groups/g1/members/user/${member.user.id}`],
      ['GET', `/printers/${s.printerId}/access`],
      ['PATCH', `/printers/${s.printerId}/access`],
      ['POST', `/printers/${s.printerId}/access/grants`],
    ]
    for (const [method, path] of routes) {
      for (const agent of [owner.agent, member.agent]) {
        const r = await agent.json(method, wsPath(ws, path), method === 'GET' || method === 'DELETE' ? undefined : {})
        expect([method, path, r.status, r.body.error?.code]).toEqual([method, path, 404, 'extension_inactive'])
      }
    }
    expect((await member.agent.get(wsPath(await freshWorkspace(owner), '/groups'))).body.error.code).toBe('not_found')
  })

  it('keeps the old refusals and their order: members are turned away before any lookup', async () => {
    const forbidden = { status: 403, body: { error: { code: 'forbidden', message: 'Only admins can do that' } } }
    expect(await member.agent.patch(wsPath(ws, '/printers/no-such-printer'), { name: 'x' })).toMatchObject(forbidden)
    expect(await member.agent.del(wsPath(ws, '/printers/no-such-printer'))).toMatchObject(forbidden)
    expect(await member.agent.del(wsPath(ws, '/jobs/no-such-job'))).toMatchObject(forbidden)
    expect((await member.agent.get(wsPath(ws, '/printers/no-such-printer'))).status).toBe(404)
    const job = await textJob(owner.agent, ws, s.printerId)
    const cancel = await member.agent.post(wsPath(ws, `/jobs/${job.id}/cancel`))
    expect(cancel).toMatchObject({ status: 403, body: { error: { code: 'forbidden', message: 'Only admins can manage other people’s jobs' } } })
    expect((await member.agent.get(wsPath(ws, `/jobs/${job.id}`))).status).toBe(200)
  })

  it('reports a subject’s access with today’s rules, admins only', async () => {
    await setAvailable(owner, true)
    await setEnabled(owner, ws, true)
    const groupId = await newGroup(owner.agent, ws, 'Desk')
    await setEnabled(owner, ws, false)
    const desk = await enrollDevice(owner)
    const of = async (subject: string) => ok(await owner.agent.get(wsPath(ws, `/access/subject?subject=${subject}`)), subject).printers
    expect(await of(`user:${member.user.id}`)).toEqual({ [s.printerId]: USER, [spare]: USER })
    expect((await of(`user:${owner.user.id}`))[spare]).toEqual(PRINTER_PERMISSIONS)
    expect(await of(`client:${desk.clientId}`)).toEqual({ [s.printerId]: ['view', 'print'] })
    expect(await of(`client:${s.clientId}`)).toEqual({})
    expect(await of(`group:${groupId}`)).toEqual({ [s.printerId]: USER, [spare]: USER })
    expect(await of('everyone')).toEqual(await of('everyone:'))
    expect((await member.agent.get(wsPath(ws, '/access/subject?subject=everyone'))).status).toBe(403)
    expect((await owner.agent.get(wsPath(ws, '/access/subject?subject=user:nobody'))).status).toBe(404)
    expect((await owner.agent.get(wsPath(ws, '/access/subject?subject=robot:1'))).status).toBe(400)
  })
})

describe('turning printer access on', () => {
  it('changes nothing by itself: same printers, jobs, and permissions', async () => {
    const theirs = await textJob(owner.agent, ws, s.printerId)
    const before = {
      printers: (await member.agent.get(wsPath(ws, '/printers'))).body,
      jobs: (await member.agent.get(wsPath(ws, '/jobs'))).body,
      access: (await myAccess(member.agent, ws)).printers,
      cancel: (await member.agent.post(wsPath(ws, `/jobs/${theirs.id}/cancel`))).status,
      patch: (await member.agent.patch(wsPath(ws, `/printers/${s.printerId}`), { name: 'x' })).status,
    }
    await turnOnAccess(owner, ws)
    expect((await member.agent.get(wsPath(ws, '/printers'))).body).toEqual(before.printers)
    expect((await member.agent.get(wsPath(ws, '/jobs'))).body).toEqual(before.jobs)
    expect(await myAccess(member.agent, ws)).toEqual({ managed: true, all: false, printers: before.access })
    expect((await member.agent.post(wsPath(ws, `/jobs/${theirs.id}/cancel`))).status).toBe(before.cancel)
    expect((await member.agent.patch(wsPath(ws, `/printers/${s.printerId}`), { name: 'x' })).status).toBe(before.patch)
    expect((await member.agent.post(wsPath(ws, '/jobs'), { printerId: s.printerId, text: 'still prints' })).status).toBe(200)
  })
})
