import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import { connectPrinter, Device, eventually, type Station } from './helpers/device'
import { call, nextIp, ORIGIN, readReply, type Reply } from './helpers/http'
import { freshWorkspace, PDF, sha256Hex, textJob } from './helpers/jobs'
import { createPat, enrollDevice, setupOwner, type Owner } from './helpers/world'

let owner: Owner
beforeAll(async () => {
  owner = await setupOwner()
})

const sockets: Device[] = []
afterEach(() => {
  for (const d of sockets.splice(0)) d.close()
})

async function api(token: string | null, method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<Reply> {
  const h: Record<string, string> = { 'CF-Connecting-IP': nextIp(), ...headers }
  if (token) h.Authorization = `Bearer ${token}`
  let payload: BodyInit | undefined
  if (body instanceof Uint8Array) payload = body
  else if (body !== undefined) {
    payload = JSON.stringify(body)
    h['Content-Type'] ??= 'application/json'
  }
  return readReply(await call(path, { method, body: payload, headers: h }))
}

interface World {
  ws: string
  station: Station
  desk: { clientId: string; token: string }
}

/** A device with an added printer, and a second device (the desk computer) that prints to it. */
async function world(): Promise<World> {
  const ws = await freshWorkspace(owner)
  const station = await connectPrinter(owner, 'usb:04f9:0042:A1B2', ws)
  sockets.push(station.device)
  const desk = await enrollDevice(owner, ws)
  await owner.agent.patch(`/api/workspaces/${ws}/clients/${desk.clientId}`, { name: 'Kitchen Mac' })
  return { ws, station, desk }
}

const slot = (token: string | null, printerId: string, over: Record<string, unknown> = {}) =>
  api(token, 'POST', '/api/client/jobs', {
    printerId,
    contentType: 'application/pdf',
    size: PDF.byteLength,
    title: 'Quarterly report',
    fileName: 'report.pdf',
    requestedBy: 'sam',
    ...over,
  })

const putFile = (token: string, uploadUrl: string, bytes: Uint8Array = PDF, type = 'application/pdf') =>
  api(token, 'PUT', new URL(uploadUrl).pathname, bytes, { 'Content-Type': type })

async function uploaded(w: World): Promise<string> {
  const s = await slot(w.desk.token, w.station.printerId)
  expect((await putFile(w.desk.token, s.body.uploadUrl)).status).toBe(200)
  return s.body.job.id
}

describe('POST /api/client/jobs', () => {
  it('opens an upload slot on another device’s printer and records who printed', async () => {
    const w = await world()
    const r = await slot(w.desk.token, w.station.printerId, { options: { copies: 2, sides: 'two-sided-long-edge' } })
    expect(r.status).toBe(201)
    const fields = {
      status: 'uploading',
      source: 'device',
      sourceClientId: w.desk.clientId,
      sourceClientName: 'Kitchen Mac',
      requestedBy: 'sam',
      userId: null,
      title: 'Quarterly report',
      fileName: 'report.pdf',
      printerId: w.station.printerId,
      options: { copies: 2, sides: 'two-sided-long-edge' },
      hasFile: false,
    }
    expect(r.body.job).toMatchObject(fields)
    expect(r.body.uploadUrl).toBe(`${ORIGIN}/api/client/jobs/${r.body.job.id}/file`)
    const listed = await owner.agent.get(`/api/workspaces/${w.ws}/jobs`)
    expect(listed.body.items.find((j: { id: string }) => j.id === r.body.job.id)).toMatchObject(fields)
  })

  it('needs a valid device token on every endpoint', async () => {
    const w = await world()
    const id = (await slot(w.desk.token, w.station.printerId)).body.job.id
    const pat = await createPat(owner)
    for (const token of [null, pat, 'pbc_not-a-real-token']) {
      expect(await slot(token, w.station.printerId)).toMatchObject({ status: 401, body: { error: { code: 'invalid_token' } } })
      expect((await api(token, 'GET', `/api/client/jobs/${id}`)).status).toBe(401)
      expect((await api(token, 'PUT', `/api/client/jobs/${id}/file`, PDF)).status).toBe(401)
      expect((await api(token, 'POST', `/api/client/jobs/${id}/cancel`)).status).toBe(401)
    }
    expect((await owner.agent.del(`/api/workspaces/${w.ws}/clients/${w.desk.clientId}`)).status).toBe(204)
    expect((await api(w.desk.token, 'GET', `/api/client/jobs/${id}`)).status).toBe(401)
  })

  it('only prints to added printers in the device’s own workspace', async () => {
    const w = await world()
    const elsewhere = await connectPrinter(owner, 'usb:elsewhere', await freshWorkspace(owner, 'Elsewhere'))
    sockets.push(elsewhere.device)
    const notFound = { status: 404, body: { error: { code: 'printer_not_found' } } }
    expect(await slot(w.desk.token, 'no-such-printer')).toMatchObject(notFound)
    expect(await slot(w.desk.token, elsewhere.printerId)).toMatchObject(notFound)
    expect((await owner.agent.patch(`/api/workspaces/${w.ws}/printers/${w.station.printerId}`, { added: false })).status).toBe(200)
    expect(await slot(w.desk.token, w.station.printerId)).toMatchObject(notFound)
  })

  it('validates the document and options like the REST API', async () => {
    const w = await world()
    const p = w.station.printerId
    expect((await slot(w.desk.token, p, { contentType: 'application/zip' })).body.error.code).toBe('unsupported_type')
    expect((await slot(w.desk.token, p, { contentType: 'application/octet-stream', fileName: 'scan.png' })).body.job.contentType).toBe('image/png')
    expect((await slot(w.desk.token, p, { size: 0 })).status).toBe(400)
    expect((await slot(w.desk.token, p, { size: '12' })).status).toBe(400)
    expect((await slot(w.desk.token, p, { printerId: undefined })).status).toBe(400)
    expect((await slot(w.desk.token, p, { options: { copies: 0 } })).status).toBe(400)
    expect((await slot(w.desk.token, p, { options: { colour: 'mono' } })).body.error.message).toContain('Unknown job option')
    expect((await slot(w.desk.token, p, { requestedBy: 42 })).status).toBe(400)
  })

  it('clips long names from the print dialog instead of refusing the job', async () => {
    const w = await world()
    const r = await slot(w.desk.token, w.station.printerId, { title: 'T'.repeat(300), requestedBy: 'u'.repeat(150), fileName: undefined })
    expect(r.status).toBe(201)
    expect(r.body.job.title).toHaveLength(200)
    expect(r.body.job.requestedBy).toHaveLength(100)
    expect(r.body.job.fileName).toBeNull()
    const untitled = await slot(w.desk.token, w.station.printerId, { title: '  ', fileName: undefined, requestedBy: undefined })
    expect(untitled.body.job).toMatchObject({ title: 'Document', requestedBy: null })
  })

  it('enforces the workspace upload limit with 413', async () => {
    const w = await world()
    expect((await owner.agent.patch(`/api/workspaces/${w.ws}`, { settings: { maxUploadMb: 1 } })).status).toBe(200)
    expect(await slot(w.desk.token, w.station.printerId, { size: 1024 * 1024 + 1 })).toMatchObject({ status: 413, body: { error: { code: 'too_large' } } })
    expect((await slot(w.desk.token, w.station.printerId, { size: 1024 * 1024 })).status).toBe(201)
  })
})

describe('PUT /api/client/jobs/:id/file', () => {
  it('stores the file, queues the job, and offers it to the printer’s device', async () => {
    const w = await world()
    const s = await slot(w.desk.token, w.station.printerId)
    const put = await putFile(w.desk.token, s.body.uploadUrl)
    expect(put.status).toBe(200)
    expect(put.body.job).toMatchObject({ id: s.body.job.id, status: 'queued', hasFile: true, source: 'device', requestedBy: 'sam' })
    const { job: offer } = await w.station.device.next('job')
    expect(offer).toMatchObject({ id: s.body.job.id, printerKey: w.station.printerKey, title: 'Quarterly report', sha256: await sha256Hex(PDF) })
    const file = await call(offer.fileUrl, { headers: { Authorization: `Bearer ${w.station.token}` } })
    expect(new Uint8Array(await file.arrayBuffer())).toEqual(PDF)
  })

  it('refuses the wrong type or size, other devices, and a second upload', async () => {
    const w = await world()
    const s = await slot(w.desk.token, w.station.printerId)
    expect((await putFile(w.desk.token, s.body.uploadUrl, PDF, 'text/plain')).status).toBe(415)
    expect((await putFile(w.desk.token, s.body.uploadUrl, PDF.slice(1))).body.error.code).toBe('size_mismatch')
    expect((await putFile(w.station.token, s.body.uploadUrl)).status).toBe(404)
    expect((await putFile(w.desk.token, s.body.uploadUrl)).status).toBe(200)
    expect((await putFile(w.desk.token, s.body.uploadUrl)).body.error.code).toBe('not_uploading')
  })
})

describe('GET and cancel', () => {
  it('shows a device only the jobs it created', async () => {
    const w = await world()
    const id = (await slot(w.desk.token, w.station.printerId)).body.job.id
    const other = await enrollDevice(owner, w.ws)
    expect(await api(w.desk.token, 'GET', `/api/client/jobs/${id}`)).toMatchObject({ status: 200, body: { job: { id, status: 'uploading' } } })
    expect((await api(w.station.token, 'GET', `/api/client/jobs/${id}`)).status).toBe(404)
    expect((await api(other.token, 'GET', `/api/client/jobs/${id}`)).status).toBe(404)
    expect((await api(other.token, 'POST', `/api/client/jobs/${id}/cancel`)).status).toBe(404)
    const web = await textJob(owner.agent, w.ws, w.station.printerId)
    expect((await api(w.desk.token, 'GET', `/api/client/jobs/${web.id}`)).status).toBe(404)
  })

  it('follows the progress the printer’s device reports', async () => {
    const w = await world()
    const id = await uploaded(w)
    await w.station.device.next('job')
    w.station.device.send({ type: 'job_status', jobId: id, status: 'printing' })
    await eventually(async () => expect((await api(w.desk.token, 'GET', `/api/client/jobs/${id}`)).body.job.status).toBe('printing'))
    w.station.device.send({ type: 'job_status', jobId: id, status: 'completed', pages: 2 })
    await eventually(async () => expect((await api(w.desk.token, 'GET', `/api/client/jobs/${id}`)).body.job).toMatchObject({ status: 'completed', pages: 2 }))
  })

  it('cancels before the upload, and asks the printer’s device to stop afterwards', async () => {
    const w = await world()
    const early = (await slot(w.desk.token, w.station.printerId)).body.job.id
    expect((await api(w.desk.token, 'POST', `/api/client/jobs/${early}/cancel`)).body.job).toMatchObject({ status: 'canceled', statusMessage: 'Canceled' })
    expect((await api(w.desk.token, 'POST', `/api/client/jobs/${early}/cancel`)).body.error.code).toBe('job_finished')

    const id = await uploaded(w)
    await w.station.device.next('job')
    w.station.device.send({ type: 'job_status', jobId: id, status: 'dispatched' })
    await eventually(async () => expect((await api(w.desk.token, 'GET', `/api/client/jobs/${id}`)).body.job.status).toBe('dispatched'))
    const r = await api(w.desk.token, 'POST', `/api/client/jobs/${id}/cancel`)
    expect(r.body.job).toMatchObject({ status: 'dispatched', statusMessage: 'Canceling…' })
    expect(await w.station.device.next('cancel')).toEqual({ type: 'cancel', jobId: id })
  })
})
