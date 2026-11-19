import { runDurableObjectAlarm } from 'cloudflare:test'
import { env } from 'cloudflare:workers'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import { connectPrinter, Device, eventually, type Station } from './helpers/device'
import { call } from './helpers/http'
import { consistently, freshWorkspace, PDF, sha256Hex, textJob, uploadJob } from './helpers/jobs'
import { setupOwner, type Owner } from './helpers/world'

let owner: Owner
beforeAll(async () => {
  owner = await setupOwner()
})

const sockets: Device[] = []
afterEach(() => {
  for (const d of sockets.splice(0)) d.close()
})

async function station(): Promise<Station & { ws: string }> {
  const ws = await freshWorkspace(owner)
  const s = await connectPrinter(owner, 'usb:04f9:0042:A1B2', ws)
  sockets.push(s.device)
  return { ...s, ws }
}

const jobOf = async (ws: string, id: string) => (await owner.agent.get(`/api/workspaces/${ws}/jobs/${id}`)).body
const report = (device: Device, jobId: string, status: string, extra: Record<string, unknown> = {}) => device.send({ type: 'job_status', jobId, status, ...extra })

describe('job delivery', () => {
  it('offers an uploaded job to its device, which downloads and verifies it', async () => {
    const s = await station()
    const job = await uploadJob(owner.agent, s.ws, s.printerId, PDF)
    const { job: offer } = await s.device.next('job')
    expect(offer).toMatchObject({
      id: job.id,
      printerKey: s.printerKey,
      title: 'report.pdf',
      contentType: 'application/pdf',
      size: PDF.byteLength,
      sha256: await sha256Hex(PDF),
      fileUrl: `/api/client/jobs/${job.id}/file`,
      attempt: 1,
    })
    const file = await call(offer.fileUrl, { headers: { Authorization: `Bearer ${s.token}` } })
    expect(file.status).toBe(200)
    expect(file.headers.get('X-PB-SHA256')).toBe(offer.sha256)
    expect(new Uint8Array(await file.arrayBuffer())).toEqual(PDF)
  })

  it('re-offers queued and dispatched jobs, oldest first, after a reconnect', async () => {
    const s = await station()
    const acked = await textJob(owner.agent, s.ws, s.printerId, 'first')
    await s.device.next('job')
    report(s.device, acked.id, 'dispatched')
    await eventually(async () => expect((await jobOf(s.ws, acked.id)).status).toBe('dispatched'))
    const waiting = await textJob(owner.agent, s.ws, s.printerId, 'second')
    await s.device.next('job')
    s.device.close()

    const again = await Device.connect(s.token)
    sockets.push(again)
    await again.hello()
    expect([(await again.next('job')).job.id, (await again.next('job')).job.id]).toEqual([acked.id, waiting.id])
  })

  it('re-offers a queued job the device has not acknowledged within a minute', async () => {
    const s = await station()
    const job = await textJob(owner.agent, s.ws, s.printerId)
    expect((await s.device.next('job')).job.id).toBe(job.id)
    await env.DB.prepare('UPDATE jobs SET updated_at = ? WHERE id = ?').bind(Date.now() - 120_000, job.id).run()
    expect(await runDurableObjectAlarm(env.HUB.getByName(s.ws))).toBe(true)
    expect((await s.device.next('job')).job).toMatchObject({ id: job.id, attempt: 1 })
  })
})

describe('job status reports', () => {
  it('records progress in rank order with pages on completion', async () => {
    const s = await station()
    const job = await textJob(owner.agent, s.ws, s.printerId)
    await s.device.next('job')
    report(s.device, job.id, 'dispatched', { message: 'Waiting for the printer' })
    await eventually(async () => expect(await jobOf(s.ws, job.id)).toMatchObject({ status: 'dispatched', statusMessage: 'Waiting for the printer' }))
    report(s.device, job.id, 'printing')
    await eventually(async () => expect((await jobOf(s.ws, job.id)).status).toBe('printing'))
    report(s.device, job.id, 'completed', { pages: 3 })
    await eventually(async () => expect(await jobOf(s.ws, job.id)).toMatchObject({ status: 'completed', pages: 3, statusMessage: null }))
    expect((await jobOf(s.ws, job.id)).completedAt).toEqual(expect.any(Number))
  })

  it('accepts printing → dispatched when the device backs off to retry', async () => {
    const s = await station()
    const job = await textJob(owner.agent, s.ws, s.printerId)
    await s.device.next('job')
    report(s.device, job.id, 'printing')
    await eventually(async () => expect((await jobOf(s.ws, job.id)).status).toBe('printing'))
    report(s.device, job.id, 'dispatched', { message: 'Printer is offline; retrying' })
    await eventually(async () => expect(await jobOf(s.ws, job.id)).toMatchObject({ status: 'dispatched', statusMessage: 'Printer is offline; retrying' }))
  })

  it('keeps terminal states final', async () => {
    const s = await station()
    const job = await textJob(owner.agent, s.ws, s.printerId)
    await s.device.next('job')
    report(s.device, job.id, 'failed')
    await eventually(async () => expect(await jobOf(s.ws, job.id)).toMatchObject({ status: 'failed', statusMessage: 'Printing failed' }))
    report(s.device, job.id, 'printing')
    report(s.device, job.id, 'completed', { pages: 1 })
    await consistently(async () => expect(await jobOf(s.ws, job.id)).toMatchObject({ status: 'failed', pages: null }))
  })

  it('ignores reports for another attempt; an omitted attempt means the current one', async () => {
    const s = await station()
    const job = await textJob(owner.agent, s.ws, s.printerId)
    await s.device.next('job')
    report(s.device, job.id, 'completed', { attempt: 2 })
    report(s.device, job.id, 'printing')
    await eventually(async () => expect((await jobOf(s.ws, job.id)).status).toBe('printing'))
    await consistently(async () => expect((await jobOf(s.ws, job.id)).status).toBe('printing'))
    report(s.device, job.id, 'completed', { attempt: 1, pages: 2 })
    await eventually(async () => expect(await jobOf(s.ws, job.id)).toMatchObject({ status: 'completed', pages: 2 }))
  })

  it('ignores reports from a device that does not own the job', async () => {
    const s = await station()
    const other = await connectPrinter(owner, 'usb:other', s.ws)
    sockets.push(other.device)
    const job = await textJob(owner.agent, s.ws, s.printerId)
    report(other.device, job.id, 'completed')
    report(other.device, 'no-such-job', 'completed')
    await consistently(async () => expect((await jobOf(s.ws, job.id)).status).toBe('queued'))
    expect(other.device.closed).toBeNull()
  })
})
