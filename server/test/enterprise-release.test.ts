import { env } from 'cloudflare:workers'
import { beforeAll, describe, expect, it } from 'vitest'
import { runCron } from '../worker/cron'
import { endHeld } from '../worker/extensions/enterprise/holds'
import { systemCtx } from '../worker/services/context'
import { loadJobView } from '../worker/services/job-create'
import { ok, wsPath } from './helpers/access'
import { auditOf, code, heldUntil, job, quietPrinter, setControls, setEnterprise, turnOnEnterprise } from './helpers/enterprise'
import { freshWorkspace, jobRow } from './helpers/jobs'
import { switchExtension } from './helpers/usage'
import { addMember, setupOwner, type Owner, type Person } from './helpers/world'

let owner: Owner
let ws: string
let bob: Person
let admin: Person
let printer: string

beforeAll(async () => {
  owner = await setupOwner()
  ws = await freshWorkspace(owner, 'Release')
  bob = await addMember(owner, 'member', ws)
  admin = await addMember(owner, 'admin', ws)
  await turnOnEnterprise(owner, ws, { approvals: { enabled: true }, release: { enabled: true } })
  printer = await quietPrinter(owner, ws)
  await setControls(owner.agent, ws, printer, { secureRelease: true })
})

const ids = (list: { id: string }[]) => list.map((x) => x.id)
const release = (agent: Owner['agent'], id: string) => agent.post(wsPath(ws, `/jobs/${id}/release`))

describe('a printer that holds jobs until released', () => {
  it('holds each job for its sender, listed on their Release page only', async () => {
    const held = ok(await job(bob.agent, ws, printer), 'job').job
    expect(held).toMatchObject({ status: 'held', statusMessage: 'Waiting to be released at the printer', held: { kind: 'release' } })
    expect(held.held).not.toHaveProperty('reasons')
    expect(ids(ok(await bob.agent.get(wsPath(ws, '/release')), 'mine'))).toContain(held.id)
    expect(ids(ok(await owner.agent.get(wsPath(ws, '/release')), 'mine'))).not.toContain(held.id)
    expect(ids(ok(await admin.agent.get(wsPath(ws, '/release?everyone=true')), 'everyone'))).toContain(held.id)
    expect(code(await bob.agent.get(wsPath(ws, '/release?everyone=true')))).toEqual([403, 'forbidden'])
  })

  it('lets only the sender, owners and admins release a job', async () => {
    const carol = await addMember(owner, 'member', ws)
    const id = ok(await job(bob.agent, ws, printer), 'job').job.id
    expect(code(await release(carol.agent, id))).toEqual([403, 'forbidden'])
    expect(ok(await release(bob.agent, id), 'release')).toMatchObject({ status: 'queued', statusMessage: null })
    expect(code(await release(bob.agent, id))).toEqual([409, 'job_not_held'])
    const other = ok(await job(bob.agent, ws, printer), 'job').job.id
    expect(ok(await release(admin.agent, other), 'release').status).toBe('queued')
    expect(await auditOf(ws, 'release.release')).toEqual(expect.arrayContaining([expect.objectContaining({ target: id }), expect.objectContaining({ target: other })]))
  })

  it('releases all of the caller’s own jobs at once', async () => {
    for (const r of ok(await bob.agent.get(wsPath(ws, '/release')), 'mine')) ok(await release(bob.agent, r.id), 'clear')
    const mine = [ok(await job(bob.agent, ws, printer), 'job').job.id, ok(await job(bob.agent, ws, printer), 'job').job.id]
    const theirs = ok(await job(owner.agent, ws, printer), 'job').job.id
    const { released } = ok(await bob.agent.post(wsPath(ws, '/release/all')), 'all')
    expect(ids(released).sort()).toEqual(mine.sort())
    expect(ok(await owner.agent.get(wsPath(ws, `/jobs/${theirs}`)), 'theirs').status).toBe('held')
  })

  it('leaves a job from a computer’s print window to owners and admins', async () => {
    const id = ok(await job(owner.agent, ws, printer), 'job').job.id
    await env.DB.prepare("UPDATE jobs SET user_id = NULL, source = 'device' WHERE id = ?").bind(id).run()
    expect(code(await release(bob.agent, id))).toEqual([403, 'forbidden'])
    expect(ok(await release(admin.agent, id), 'release').status).toBe('queued')
  })
})

describe('expiry', () => {
  it('cancels unanswered approvals and unreleased jobs, deleting the unreleased documents', async () => {
    const approvalPrinter = await quietPrinter(owner, ws)
    await setControls(owner.agent, ws, approvalPrinter, { approval: true })
    const waiting = ok(await job(bob.agent, ws, approvalPrinter), 'job').job.id
    const unreleased = ok(await job(bob.agent, ws, printer), 'job').job.id
    const fresh = ok(await job(bob.agent, ws, printer), 'job').job.id
    await heldUntil(waiting, Date.now() - 1)
    await heldUntil(unreleased, Date.now() - 1)
    await runCron(env)
    expect(await jobRow(waiting)).toMatchObject({ status: 'canceled', status_message: 'Not approved in time' })
    expect(await jobRow(unreleased)).toMatchObject({ status: 'canceled', status_message: 'Not released in time', file_key: null })
    expect((await jobRow(fresh))?.status).toBe('held')
    expect(ok(await bob.agent.get(wsPath(ws, `/jobs/${unreleased}`)), 'job')).not.toHaveProperty('held')
    expect(await auditOf(ws, 'approval.expire')).toEqual([expect.objectContaining({ target: waiting, actor_type: 'system' })])
    expect(await auditOf(ws, 'release.expire')).toEqual([expect.objectContaining({ target: unreleased })])
  })
})

describe('a hold that runs out or moves on', () => {
  let late: string
  let both: string
  beforeAll(async () => {
    late = await freshWorkspace(owner, 'Late')
    await turnOnEnterprise(owner, late, { approvals: { enabled: true }, release: { enabled: true } })
    both = await quietPrinter(owner, late)
    await setControls(owner.agent, late, both, { approval: true, secureRelease: true })
  })
  const send = async () => ok(await job(owner.agent, late, both), 'job').job.id as string
  const post = (id: string, action: string) => owner.agent.post(wsPath(late, `/jobs/${id}/${action}`))

  it('can’t be approved or released once it has run out', async () => {
    const waiting = await send()
    await heldUntil(waiting, Date.now() - 1)
    expect(code(await post(waiting, 'approve'))).toEqual([409, 'job_not_held'])
    const unreleased = await send()
    ok(await post(unreleased, 'approve'), 'approve')
    await heldUntil(unreleased, Date.now() - 1)
    expect(code(await post(unreleased, 'release'))).toEqual([409, 'job_not_held'])
  })

  it('ends a job only while it is still in that hold and has run out', async () => {
    const ctx = systemCtx(env, '', () => undefined)
    const expireApproval = { message: 'Not approved in time', action: 'approval.expire', kind: 'approval', expired: true } as const
    const current = await send()
    expect(await endHeld(ctx, late, [await loadJobView(env, late, current)], expireApproval)).toEqual([])
    const approved = await send()
    const seen = await loadJobView(env, late, approved)
    ok(await post(approved, 'approve'), 'approve')
    await heldUntil(approved, Date.now() - 1)
    expect(await endHeld(ctx, late, [seen], expireApproval)).toEqual([])
    expect(await jobRow(current)).toMatchObject({ status: 'held' })
    expect(await jobRow(approved)).toMatchObject({ status: 'held', held: expect.stringContaining('"release"') })
  })

  it('expires a job behind 500 older ones still waiting', async () => {
    await env.DB.prepare(
      `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 500)
       INSERT INTO jobs (id, workspace_id, printer_id, source, title, content_type, status, held, created_at, updated_at)
       SELECT 'waiting-' || i, ?, ?, 'test', 'Waiting', 'text/plain', 'held', ?, i, i FROM n`,
    )
      .bind(late, both, JSON.stringify({ kind: 'approval', until: Date.now() + 3600_000 }))
      .run()
    try {
      const id = await send()
      await heldUntil(id, Date.now() - 1)
      await runCron(env)
      expect(await jobRow(id)).toMatchObject({ status: 'canceled', status_message: 'Not approved in time' })
    } finally {
      await env.DB.prepare("DELETE FROM jobs WHERE id LIKE 'waiting-%'").run()
    }
  })
})

describe('turning it off', () => {
  it('cancels held jobs with either switch, and the cron catches jobs held at the same moment', async () => {
    const off = await freshWorkspace(owner, 'Turning off')
    await turnOnEnterprise(owner, off, { release: { enabled: true } })
    const id = await quietPrinter(owner, off)
    await setControls(owner.agent, off, id, { secureRelease: true })
    const first = ok(await job(owner.agent, off, id), 'job').job.id
    await switchExtension(owner, 'enterprise', off, false)
    expect(await jobRow(first)).toMatchObject({ status: 'canceled', status_message: 'Enterprise controls were turned off' })
    expect(await auditOf(off, 'job.cancel')).toContainEqual(expect.objectContaining({ target: first }))

    await switchExtension(owner, 'enterprise', off, true)
    const second = ok(await job(owner.agent, off, id), 'job').job.id
    ok(await owner.agent.patch('/api/admin/extensions/enterprise', { available: false }), 'unavailable')
    expect(await jobRow(second)).toMatchObject({ status: 'canceled', status_message: 'Enterprise controls were turned off' })

    const late = ok(await job(owner.agent, off, id), 'job').job.id
    await env.DB.prepare("UPDATE jobs SET status = 'held', held = ? WHERE id = ?").bind(JSON.stringify({ kind: 'release', until: Date.now() + 3600_000 }), late).run()
    await runCron(env)
    expect(await jobRow(late)).toMatchObject({ status: 'canceled', status_message: 'Enterprise controls were turned off' })
    ok(await owner.agent.patch('/api/admin/extensions/enterprise', { available: true }), 'available again')
  })

  it('cancels jobs waiting for release when secure release alone is turned off, keeping the printer switch', async () => {
    const id = ok(await job(bob.agent, ws, printer), 'job').job.id
    await setEnterprise(owner.agent, ws, { release: { enabled: false } })
    expect(await jobRow(id)).toMatchObject({ status: 'canceled', status_message: 'Secure release was turned off' })
    expect(ok(await owner.agent.get(wsPath(ws, '/enterprise')), 'config').printers[printer]).toEqual({ approval: false, secureRelease: true })
  })
})
