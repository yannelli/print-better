import { env } from 'cloudflare:workers'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { UiEvent } from '../shared/protocol'
import { runCron } from '../worker/cron'
import { HOUR, jobRow, patchWorkspaceSettings, setJob, textJob } from './helpers/cron'
import { connectPrinter, eventually, type Station } from './helpers/device'
import { ORIGIN } from './helpers/http'
import { enrollDevice, setupOwner, type Owner } from './helpers/world'

let owner: Owner
let station: Station
let ui: { ws: WebSocket; events: UiEvent[] }

/** The browser's live events socket for the workspace. */
async function openEvents(o: Owner) {
  const res = await o.agent.fetch(`/api/workspaces/${o.workspaceId}/events`, { headers: { Upgrade: 'websocket', Origin: ORIGIN } })
  if (!res.webSocket) throw new Error(`events upgrade failed: ${res.status}`)
  const events: UiEvent[] = []
  res.webSocket.addEventListener('message', (e) => {
    if (typeof e.data === 'string' && e.data !== 'pong') events.push(JSON.parse(e.data) as UiEvent)
  })
  res.webSocket.accept()
  return { ws: res.webSocket, events }
}

beforeAll(async () => {
  owner = await setupOwner()
  station = await connectPrinter(owner)
  ui = await openEvents(owner)
})

afterAll(() => {
  station.device.close()
  ui.ws.close()
})

/** Queues a text job and waits for its offer to reach the device. */
async function offered(text: string): Promise<string> {
  const id = await textJob(owner, station.printerId, text)
  const offer = await station.device.next('job')
  expect(offer.job.id).toBe(id)
  return id
}

const sawFailure = (id: string) => ui.events.some((e) => e.type === 'job' && e.job.id === id && e.job.status === 'failed')

describe('cron: stale jobs', () => {
  it('fails uploads abandoned for an hour and leaves fresher ones alone', async () => {
    const upload = { fileName: 'scan.pdf', contentType: 'application/pdf', size: 1000 }
    const create = async () => (await owner.agent.post(`/api/workspaces/${owner.workspaceId}/jobs`, { printerId: station.printerId, upload })).body.job.id as string
    const [stale, fresh] = [await create(), await create()]
    const now = Date.now()
    await setJob(stale, { updated_at: now - HOUR - 60_000 })
    await setJob(fresh, { updated_at: now - HOUR / 2 })

    await runCron(env)

    expect(await jobRow(stale)).toMatchObject({ status: 'failed', status_message: 'The upload never finished', completed_at: expect.any(Number) })
    expect((await jobRow(fresh)).status).toBe('uploading')
  })

  it('fails queued and dispatched jobs past jobTimeoutHours, cancels on the device, and tells browsers', async () => {
    const queued = await offered('never acknowledged')
    const dispatched = await offered('stuck on the device')
    station.device.send({ type: 'job_status', jobId: dispatched, status: 'dispatched', attempt: 1, message: 'Waiting for the printer' })
    await eventually(async () => expect((await jobRow(dispatched)).status).toBe('dispatched'))
    const longAgo = Date.now() - 25 * HOUR
    await setJob(queued, { updated_at: longAgo })
    await setJob(dispatched, { updated_at: longAgo })

    await runCron(env)

    for (const id of [queued, dispatched]) {
      expect(await jobRow(id)).toMatchObject({ status: 'failed', status_message: 'Gave up after 24 hours without finishing' })
    }
    expect((await station.device.next('cancel')).jobId).toBe(dispatched)
    await eventually(async () => expect(sawFailure(queued) && sawFailure(dispatched)).toBe(true))
    expect(station.device.drain().filter((m) => m.type === 'cancel')).toEqual([])
  })

  it('uses the workspace jobTimeoutHours', async () => {
    await patchWorkspaceSettings(owner, { jobTimeoutHours: 2 })
    try {
      const old = await offered('printing for hours')
      const recent = await offered('printing for a while')
      const now = Date.now()
      await setJob(old, { status: 'printing', updated_at: now - 3 * HOUR })
      await setJob(recent, { status: 'printing', updated_at: now - HOUR })

      await runCron(env)

      expect(await jobRow(old)).toMatchObject({ status: 'failed', status_message: 'Gave up after 2 hours without finishing' })
      expect((await jobRow(recent)).status).toBe('printing')
      expect((await station.device.next('cancel')).jobId).toBe(old)
    } finally {
      await patchWorkspaceSettings(owner, { jobTimeoutHours: 24 })
    }
  })
})

describe('cron: online sweep', () => {
  const online = async (id: string) => (await env.DB.prepare('SELECT online FROM clients WHERE id = ?').bind(id).first<{ online: number }>())?.online

  it('marks devices offline when the hub holds no socket for them, and keeps connected ones', async () => {
    const ghost = await enrollDevice(owner)
    const late = await enrollDevice(owner)
    const now = Date.now()
    const mark = env.DB.prepare('UPDATE clients SET online = 1, last_seen_at = ? WHERE id = ?')
    await mark.bind(now - 10 * 60_000, ghost.clientId).run()
    // A hello that lands after the sweep's snapshot carries a newer last_seen_at and must survive.
    await mark.bind(now + 60_000, late.clientId).run()

    await runCron(env)

    expect(await online(ghost.clientId)).toBe(0)
    expect(await online(late.clientId)).toBe(1)
    expect(await online(station.clientId)).toBe(1)
    await eventually(async () => expect(ui.events.some((e) => e.type === 'client' && e.client.id === ghost.clientId && !e.client.online)).toBe(true))
  })
})
