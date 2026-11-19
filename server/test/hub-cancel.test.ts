import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import { connectPrinter, Device, eventually, type Station } from './helpers/device'
import { call } from './helpers/http'
import { consistently, freshWorkspace, jobsPath, textJob } from './helpers/jobs'
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

/** A job the device has acknowledged, so it counts as with the device. */
async function dispatchedJob(s: Station & { ws: string }) {
  const job = await textJob(owner.agent, s.ws, s.printerId)
  await s.device.next('job')
  report(s.device, job.id, 'dispatched')
  await eventually(async () => expect((await jobOf(s.ws, job.id)).status).toBe('dispatched'))
  return job
}

describe('cancel', () => {
  it('cancels a queued job locally and answers a late acknowledgement with cancel', async () => {
    const s = await station()
    const job = await textJob(owner.agent, s.ws, s.printerId)
    await s.device.next('job')
    const r = await owner.agent.post(`${jobsPath(s.ws)}/${job.id}/cancel`)
    expect(r.status).toBe(200)
    expect(r.body).toMatchObject({ id: job.id, status: 'canceled', statusMessage: 'Canceled' })
    report(s.device, job.id, 'dispatched')
    expect(await s.device.next('cancel')).toEqual({ type: 'cancel', jobId: job.id })
    expect((await jobOf(s.ws, job.id)).status).toBe('canceled')
  })

  it('asks the device to stop a dispatched job and records its final report', async () => {
    const s = await station()
    const job = await dispatchedJob(s)
    const r = await owner.agent.post(`${jobsPath(s.ws)}/${job.id}/cancel`)
    expect(r.body).toMatchObject({ status: 'dispatched', statusMessage: 'Canceling…' })
    expect((await s.device.next('cancel')).jobId).toBe(job.id)
    report(s.device, job.id, 'canceled')
    await eventually(async () => expect((await jobOf(s.ws, job.id)).status).toBe('canceled'))
  })

  it('cancels directly while the device is offline and repeats the cancel when it returns', async () => {
    const s = await station()
    const job = await dispatchedJob(s)
    s.device.close()
    await eventually(async () => expect((await owner.agent.get(`/api/workspaces/${s.ws}/clients/${s.clientId}`)).body.online).toBe(false))
    const r = await owner.agent.post(`${jobsPath(s.ws)}/${job.id}/cancel`)
    expect(r.body).toMatchObject({ status: 'canceled', statusMessage: 'Canceled while the device was offline' })

    const back = await Device.connect(s.token)
    sockets.push(back)
    await back.hello()
    report(back, job.id, 'printing')
    expect((await back.next('cancel')).jobId).toBe(job.id)
    expect(back.drain().filter((m) => m.type === 'job')).toEqual([])
  })

  it('refuses to cancel a finished job', async () => {
    const s = await station()
    const job = await dispatchedJob(s)
    report(s.device, job.id, 'completed')
    await eventually(async () => expect((await jobOf(s.ws, job.id)).status).toBe('completed'))
    const r = await owner.agent.post(`${jobsPath(s.ws)}/${job.id}/cancel`)
    expect(r.status).toBe(409)
    expect(r.body.error.code).toBe('job_finished')
  })
})

describe('retry', () => {
  it('offers a fresh attempt and ignores late reports from the old one', async () => {
    const s = await station()
    const job = await dispatchedJob(s)
    report(s.device, job.id, 'failed', { message: 'Out of paper' })
    await eventually(async () => expect((await jobOf(s.ws, job.id)).status).toBe('failed'))

    const r = await owner.agent.post(`${jobsPath(s.ws)}/${job.id}/retry`)
    expect(r.body).toMatchObject({ id: job.id, status: 'queued', attempts: 2, statusMessage: null })
    expect((await s.device.next('job')).job).toMatchObject({ id: job.id, attempt: 2 })
    report(s.device, job.id, 'completed', { attempt: 1 })
    report(s.device, job.id, 'dispatched', { attempt: 2 })
    await eventually(async () => expect((await jobOf(s.ws, job.id)).status).toBe('dispatched'))
    await consistently(async () => expect((await jobOf(s.ws, job.id)).status).toBe('dispatched'))
  })
})

describe('LAN jobs', () => {
  const lanJobs = async (ws: string) =>
    (await owner.agent.get(`${jobsPath(ws)}?limit=50`)).body.items.filter((j: { source: string }) => j.source === 'lan')

  it('upserts one history row per local id and never reopens a finished one', async () => {
    const s = await station()
    const lan = { type: 'lan_job', localId: 'ipp-17', printerKey: s.printerKey, title: 'Boarding pass', user: 'ann', contentType: 'image/jpeg', size: 2048 }
    s.device.send({ ...lan, status: 'printing' })
    await eventually(async () => expect(await lanJobs(s.ws)).toMatchObject([{ status: 'printing', title: 'Boarding pass', printerId: s.printerId, hasFile: false }]))
    s.device.send({ ...lan, status: 'completed' })
    await eventually(async () => expect((await lanJobs(s.ws))[0].status).toBe('completed'))
    s.device.send({ ...lan, status: 'printing' })
    s.device.send({ ...lan, localId: 'ipp-17', status: 'uploading' })
    await consistently(async () => expect(await lanJobs(s.ws)).toMatchObject([{ status: 'completed' }]))

    s.device.send({ ...lan, localId: 'ipp-18', title: '', status: 'queued' })
    await eventually(async () => expect((await lanJobs(s.ws)).map((j: { title: string }) => j.title).sort()).toEqual(['Boarding pass', 'LAN print']))
  })
})

describe('device removal', () => {
  it('unpairs the device, closes it with 4401, cancels its open jobs and forgets its printers', async () => {
    const s = await station()
    const sent = await dispatchedJob(s)
    const waiting = await textJob(owner.agent, s.ws, s.printerId)
    expect((await owner.agent.del(`/api/workspaces/${s.ws}/clients/${s.clientId}`)).status).toBe(204)

    expect(await s.device.next('command')).toMatchObject({ type: 'command', name: 'unpair' })
    expect(await s.device.waitClosed()).toEqual({ code: 4401, reason: 'Device removed' })
    for (const id of [sent.id, waiting.id]) expect(await jobOf(s.ws, id)).toMatchObject({ status: 'canceled', statusMessage: 'Device removed', printerId: null })
    expect((await owner.agent.get(`/api/workspaces/${s.ws}/printers/${s.printerId}`)).status).toBe(404)
    const again = await call('/api/client/ws', { headers: { Upgrade: 'websocket', Authorization: `Bearer ${s.token}` } })
    expect(again.status).toBe(401)
  })
})
