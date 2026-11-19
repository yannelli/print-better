import { beforeAll, describe, expect, it } from 'vitest'
import { grant, ids, ok, setEveryone, turnOnAccess, wsPath } from './helpers/access'
import { connectPrinter } from './helpers/device'
import { readReply, type Agent, type Reply } from './helpers/http'
import { PDF, textJob } from './helpers/jobs'
import { addMember, setupOwner, type Owner, type Person } from './helpers/world'

let owner: Owner
let ws: string
let bob: Person
let ownOnly: string
let jobsDesk: string

beforeAll(async () => {
  owner = await setupOwner()
  ws = owner.workspaceId
  await turnOnAccess(owner)
  bob = await addMember(owner)
  ownOnly = ok(await owner.agent.post(wsPath(ws, '/access/roles'), { name: 'Prints, sees own jobs', permissions: ['view', 'print'] }), 'role').id
  jobsDesk = ok(await owner.agent.post(wsPath(ws, '/access/roles'), { name: 'Jobs desk', permissions: ['jobs.manage'] }), 'role').id
})

let keys = 0
async function printer(everyone: string | null = null): Promise<string> {
  const s = await connectPrinter(owner, `usb:j${++keys}`)
  s.device.close()
  if (everyone) await setEveryone(owner.agent, ws, s.printerId, everyone)
  return s.printerId
}

const BOB = () => ({ type: 'user' as const, id: bob.user.id })
const j = (id: string, rest = '') => wsPath(ws, `/jobs/${id}${rest}`)
const code = (r: Reply) => [r.status, r.body?.error?.code ?? null]

/** Every job the agent can list, page by page; asserts every page but the last is full. */
async function pages(agent: Agent, query: string, limit = 2): Promise<string[]> {
  const seen: string[] = []
  let cursor: string | null = null
  do {
    const page = ok(await agent.get(wsPath(ws, `/jobs?limit=${limit}${query}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`)), 'page')
    if (page.nextCursor) expect(page.items).toHaveLength(limit)
    seen.push(...ids(page.items))
    cursor = page.nextCursor
  } while (cursor)
  return seen
}

describe('job lists with printer access on', () => {
  it('show your own jobs plus jobs on printers with jobs.read, filtered in SQL so pages stay full', async () => {
    const open = await printer()
    const ownOnlyPrinter = await printer('none')
    const hidden = await printer('none')
    await grant(owner.agent, ws, ownOnlyPrinter, BOB(), ownOnly)
    const made: { id: string; visible: boolean }[] = []
    for (let round = 0; round < 3; round++) {
      made.push({ id: (await textJob(owner.agent, ws, open)).id, visible: true })
      made.push({ id: (await textJob(owner.agent, ws, ownOnlyPrinter)).id, visible: false })
      made.push({ id: (await textJob(bob.agent, ws, ownOnlyPrinter)).id, visible: true })
      made.push({ id: (await textJob(owner.agent, ws, hidden)).id, visible: false })
    }
    const everything = await pages(owner.agent, '', 5)
    const expected = everything.filter((id) => made.find((m) => m.id === id)?.visible ?? true)
    expect(made.filter((m) => m.visible).every((m) => expected.includes(m.id))).toBe(true)
    expect(await pages(bob.agent, '')).toEqual(expected)
    expect(await pages(bob.agent, '', 1)).toEqual(expected)
    expect(await pages(bob.agent, `&printerId=${hidden}`)).toEqual([])
    expect(await pages(bob.agent, `&printerId=${ownOnlyPrinter}&status=queued`)).toEqual(made.filter((_, i) => i % 4 === 2).map((m) => m.id).reverse())
  })

  it('hide other people’s jobs and documents on printers without jobs.read, but never your own', async () => {
    const id = await printer('none')
    const granted = await grant(owner.agent, ws, id, BOB(), ownOnly)
    const theirs = await textJob(owner.agent, ws, id)
    const mine = await textJob(bob.agent, ws, id)
    expect(code(await bob.agent.get(j(theirs.id)))).toEqual([404, 'not_found'])
    expect(code(await bob.agent.get(j(theirs.id, '/file')))).toEqual([404, 'not_found'])
    expect((await bob.agent.get(j(mine.id))).status).toBe(200)
    expect((await bob.agent.fetch(j(mine.id, '/file'))).status).toBe(200)
    expect((await owner.agent.del(wsPath(ws, `/access/grants/${granted.id}`))).status).toBe(204)
    expect(code(await bob.agent.get(wsPath(ws, `/printers/${id}`)))).toEqual([404, 'not_found'])
    expect((await bob.agent.get(j(mine.id))).status).toBe(200)
  })
})

describe('managing jobs with printer access on', () => {
  it('lets you cancel your own jobs anywhere, and retry them only where you may print', async () => {
    const id = await printer('user')
    const mine = await textJob(bob.agent, ws, id)
    await setEveryone(owner.agent, ws, id, 'none')
    expect((await bob.agent.post(j(mine.id, '/cancel'))).body.status).toBe('canceled')
    const retry = await bob.agent.post(j(mine.id, '/retry'))
    expect(retry).toMatchObject({ status: 403, body: { error: { code: 'printer_access_denied', message: "You don't have permission to print to this printer" } } })
    await setEveryone(owner.agent, ws, id, 'user')
    expect((await bob.agent.post(j(mine.id, '/retry'))).body).toMatchObject({ status: 'queued', attempts: 2 })
  })

  it('needs jobs.manage for other people’s jobs and for deleting any job', async () => {
    const id = await printer('user')
    const theirs = await textJob(owner.agent, ws, id)
    const mine = await textJob(bob.agent, ws, id)
    expect((await bob.agent.post(j(theirs.id, '/cancel'))).body.error).toEqual({ code: 'printer_access_denied', message: 'You can only cancel your own jobs on this printer' })
    await bob.agent.post(j(mine.id, '/cancel'))
    expect((await bob.agent.del(j(mine.id))).body.error).toEqual({ code: 'printer_access_denied', message: "You don't have permission to delete jobs on this printer" })

    await grant(owner.agent, ws, id, BOB(), jobsDesk)
    expect((await bob.agent.post(j(theirs.id, '/cancel'))).body.status).toBe('canceled')
    expect((await bob.agent.post(j(theirs.id, '/retry'))).body.status).toBe('queued')
    await bob.agent.post(j(theirs.id, '/cancel'))
    expect((await bob.agent.del(j(theirs.id))).status).toBe(204)
    expect((await bob.agent.del(j(mine.id))).status).toBe(204)
  })

  it('needs print to upload a document into your own job', async () => {
    const id = await printer('user')
    const slot = ok(await bob.agent.post(wsPath(ws, '/jobs'), { printerId: id, upload: { fileName: 'a.pdf', contentType: 'application/pdf', size: PDF.byteLength } }), 'slot')
    await setEveryone(owner.agent, ws, id, 'viewer')
    const put = (agent: Agent) => agent.fetch(new URL(slot.uploadUrl).pathname, { method: 'PUT', body: PDF, headers: { 'Content-Type': 'application/pdf' } })
    expect(code(await readReply(await put(bob.agent)))).toEqual([403, 'printer_access_denied'])
    await setEveryone(owner.agent, ws, id, 'user')
    expect((await readReply(await put(bob.agent))).body.job.status).toBe('queued')
  })
})
