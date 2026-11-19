import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import type { UiEvent } from '../shared/protocol'
import { grant, ok, setEveryone, turnOnAccess, wsPath } from './helpers/access'
import { connectPrinter, type Station } from './helpers/device'
import { EventSocket, freshWorkspace, textJob } from './helpers/jobs'
import { addMember, setupOwner, type Owner, type Person } from './helpers/world'

let owner: Owner
beforeAll(async () => {
  owner = await setupOwner()
})

const sockets: { close(): void }[] = []
afterEach(() => {
  for (const s of sockets.splice(0)) s.close()
})

interface World {
  ws: string
  laser: Station
  inkjet: Station
  bob: Person
  mine: EventSocket
  bobs: EventSocket
}

/** Printer access on, the laser restricted, the inkjet open to everyone; the owner and Bob have a tab open each. */
async function world(): Promise<World> {
  const ws = await freshWorkspace(owner)
  await turnOnAccess(owner, ws)
  const laser = await connectPrinter(owner, 'usb:laser', ws)
  const inkjet = await connectPrinter(owner, 'usb:inkjet', ws)
  sockets.push(laser.device, inkjet.device)
  await setEveryone(owner.agent, ws, laser.printerId, 'none')
  const bob = await addMember(owner, 'member', ws)
  const mine = await EventSocket.open(owner.agent, ws)
  const bobs = await EventSocket.open(bob.agent, ws)
  sockets.push(mine, bobs)
  return { ws, laser, inkjet, bob, mine, bobs }
}

let level = 0
/** A status change, which reaches browsers as a `printer` event. */
function poke(s: Station): void {
  level = (level + 1) % 100
  s.device.send({ type: 'printer_status', key: s.printerKey, status: { state: 'idle', reasons: [], message: null, supplies: [{ name: 'Toner', kind: 'toner', color: null, level }] } })
}

const printerEvent = (id: string) => (e: Extract<UiEvent, { type: 'printer' }>) => e.printer.id === id
const jobEvent = (id: string) => (e: Extract<UiEvent, { type: 'job' }>) => e.job.id === id

/** Events arrive in order, so once a later event is in, an earlier one that never came was filtered out. */
const neverCame = (ui: EventSocket, type: 'printer' | 'job', where: (e: never) => boolean) => expect(ui.next(type, where as never, 50)).rejects.toThrow()

describe('live updates with printer access on', () => {
  it('send printer events only to people who can see the printer', async () => {
    const w = await world()
    poke(w.laser)
    await w.mine.next('printer', printerEvent(w.laser.printerId))
    poke(w.inkjet)
    await w.bobs.next('printer', printerEvent(w.inkjet.printerId))
    await neverCame(w.bobs, 'printer', printerEvent(w.laser.printerId))

    await grant(owner.agent, w.ws, w.laser.printerId, { type: 'user', id: w.bob.user.id }, 'viewer')
    await w.bobs.next('access')
    poke(w.laser)
    await w.bobs.next('printer', printerEvent(w.laser.printerId))
  })

  it('send job events to their owner and to people with jobs.read on the printer', async () => {
    const w = await world()
    const ownOnly = ok(await owner.agent.post(wsPath(w.ws, '/access/roles'), { name: 'Own jobs', permissions: ['print'] }), 'role').id
    await grant(owner.agent, w.ws, w.laser.printerId, { type: 'user', id: w.bob.user.id }, ownOnly)
    await w.bobs.next('access')
    const theirs = await textJob(owner.agent, w.ws, w.laser.printerId)
    const his = await textJob(w.bob.agent, w.ws, w.laser.printerId)
    const open = await textJob(owner.agent, w.ws, w.inkjet.printerId)
    await w.mine.next('job', jobEvent(open.id))
    await w.bobs.next('job', jobEvent(his.id))
    await w.bobs.next('job', jobEvent(open.id))
    await neverCame(w.bobs, 'job', jobEvent(theirs.id))
  })

  it('send removals, device and access events to everyone', async () => {
    const w = await world()
    expect((await owner.agent.del(wsPath(w.ws, `/printers/${w.laser.printerId}`))).status).toBe(204)
    await w.bobs.next('printer_removed', (e) => e.id === w.laser.printerId)
    w.inkjet.device.close()
    await w.bobs.next('client', (e) => e.client.id === w.inkjet.clientId && !e.client.online)
  })

  it('pick up people who join, and admins once promoted', async () => {
    const w = await world()
    const carol = await addMember(owner, 'member', w.ws)
    const hers = await EventSocket.open(carol.agent, w.ws)
    sockets.push(hers)
    poke(w.inkjet)
    await hers.next('printer', printerEvent(w.inkjet.printerId))

    ok(await owner.agent.patch(wsPath(w.ws, `/members/${w.bob.user.id}`), { role: 'admin' }), 'promote')
    await w.bobs.next('workspace', (e) => e.workspace.role === 'admin')
    poke(w.laser)
    await w.bobs.next('printer', printerEvent(w.laser.printerId))
    await neverCame(hers, 'printer', printerEvent(w.laser.printerId))
  })
})
