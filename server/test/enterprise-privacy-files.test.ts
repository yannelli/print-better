import { env } from 'cloudflare:workers'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { ok, wsPath } from './helpers/access'
import { connectPrinter, Device, type Station } from './helpers/device'
import { job, setEnterprise, turnOnEnterprise } from './helpers/enterprise'
import type { Agent } from './helpers/http'
import { freshWorkspace } from './helpers/jobs'
import { pdfJob } from './helpers/usage'
import { addMember, setupOwner, type Owner, type Person } from './helpers/world'

let owner: Owner
let ws: string
let bob: Person
let station: Station

beforeAll(async () => {
  owner = await setupOwner()
  ws = await freshWorkspace(owner, 'Private files')
  bob = await addMember(owner, 'member', ws)
  await turnOnEnterprise(owner, ws, { privacy: { enabled: true, ownerOnlyNames: true } })
  station = await connectPrinter(owner, 'usb:ent:files', ws)
})
afterAll(() => station.device.close())

async function downloadName(agent: Agent, id: string): Promise<string | null> {
  const res = await agent.fetch(wsPath(ws, `/jobs/${id}/file`))
  expect(res.status).toBe(200)
  await res.arrayBuffer()
  return /filename="([^"]*)"/.exec(res.headers.get('Content-Disposition') ?? '')?.[1] ?? null
}

describe('downloads while names are private', () => {
  it('keep the name for the sender and use a generic one for everyone else', async () => {
    const pdf = ok(await pdfJob(bob.agent, ws, station.printerId, 1), 'pdf').job.id
    const text = ok(await job(bob.agent, ws, station.printerId, { title: 'Salary review' }), 'text').job.id
    expect(await downloadName(bob.agent, pdf)).toBe('notes.pdf')
    expect(await downloadName(bob.agent, text)).toBe('Salary review')
    expect(await downloadName(owner.agent, pdf)).toBe('document.pdf')
    expect(await downloadName(owner.agent, text)).toBe('document.txt')
  })

  it('show owners and admins the name once they may see names', async () => {
    const pdf = ok(await pdfJob(bob.agent, ws, station.printerId, 1), 'pdf').job.id
    await setEnterprise(owner.agent, ws, { privacy: { adminsSeeNames: true } })
    expect(await downloadName(owner.agent, pdf)).toBe('notes.pdf')
    await setEnterprise(owner.agent, ws, { privacy: { adminsSeeNames: false } })
  })
})

describe('jobs offered to the printing computer', () => {
  it('carry a generic title, except on the computer that sent them', async () => {
    station.device.drain()
    const other = ok(await job(bob.agent, ws, station.printerId, { title: 'Offer letter' }), 'job').job.id
    expect((await station.device.next('job')).job).toMatchObject({ id: other, title: 'Document' })
    const own = ok(await job(bob.agent, ws, station.printerId, { title: 'Shift plan' }), 'job').job.id
    await station.device.next('job')
    await env.DB.prepare('UPDATE jobs SET source_client_id = ? WHERE id = ?').bind(station.clientId, own).run()

    const again = await Device.connect(station.token)
    try {
      await again.hello()
      const offers = new Map<string, string>()
      while (!offers.has(own) || !offers.has(other)) {
        const { job: offer } = await again.next('job')
        offers.set(offer.id, offer.title)
      }
      expect([offers.get(other), offers.get(own)]).toEqual(['Document', 'Shift plan'])
    } finally {
      again.close()
    }
  })
})
