import { createExecutionContext, createScheduledController, waitOnExecutionContext } from 'cloudflare:test'
import { env } from 'cloudflare:workers'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { runCron } from '../worker/cron'
import worker from '../worker/index'
import { DAY, exists, HOUR, jobRow, patchWorkspaceSettings, setJob, sha256Hex, textJob } from './helpers/cron'
import { connectPrinter, type Station } from './helpers/device'
import { call, readReply } from './helpers/http'
import { addMember, createPat, jsonInit, setupOwner, type Owner } from './helpers/world'

let owner: Owner
let station: Station

beforeAll(async () => {
  owner = await setupOwner()
  station = await connectPrinter(owner)
  station.device.close()
})

afterEach(() => vi.restoreAllMocks())

const hasObject = async (key: string | null) => key !== null && (await env.FILES.head(key)) !== null

describe('cron: document purge', () => {
  it('deletes documents of finished jobs past keepDocumentsHours and keeps the rest', async () => {
    const now = Date.now()
    const [old, oldFailed, recent, active] = [
      await textJob(owner, station.printerId, 'old'),
      await textJob(owner, station.printerId, 'old failed'),
      await textJob(owner, station.printerId, 'recent'),
      await textJob(owner, station.printerId, 'still queued'),
    ]
    const keys = Object.fromEntries(await Promise.all([old, oldFailed, recent, active].map(async (id) => [id, (await jobRow(id)).file_key])))
    await setJob(old, { status: 'completed', completed_at: now - 25 * HOUR })
    await setJob(oldFailed, { status: 'failed', completed_at: null, updated_at: now - 30 * HOUR })
    await setJob(recent, { status: 'completed', completed_at: now - 3 * HOUR })
    await setJob(active, { created_at: now - 3 * DAY })

    await runCron(env)

    for (const id of [old, oldFailed]) {
      expect((await jobRow(id)).file_key).toBeNull()
      expect(await hasObject(keys[id])).toBe(false)
    }
    for (const id of [recent, active]) expect(await hasObject((await jobRow(id)).file_key)).toBe(true)
    const view = await owner.agent.get(`/api/workspaces/${owner.workspaceId}/jobs/${old}`)
    expect(view.body.hasFile).toBe(false)
    expect((await owner.agent.fetch(`/api/workspaces/${owner.workspaceId}/jobs/${old}/file`)).status).toBeGreaterThanOrEqual(400)

    await patchWorkspaceSettings(owner, { keepDocumentsHours: 2 })
    await runCron(env)
    expect((await jobRow(recent)).file_key).toBeNull()
    expect(await hasObject((await jobRow(active)).file_key)).toBe(true)
    await patchWorkspaceSettings(owner, { keepDocumentsHours: 24 })
  })

  it('keeps going when one task fails, logging which one', async () => {
    const job = await textJob(owner, station.printerId)
    await setJob(job, { status: 'completed', completed_at: Date.now() - 2 * DAY })
    await env.DB.prepare("INSERT INTO challenges (id, kind, user_id, data, expires_at) VALUES ('isolation', 'test', NULL, '{}', ?)").bind(Date.now() - 1).run()
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    const brokenFiles = { delete: async () => Promise.reject(new Error('R2 is down')) } as unknown as R2Bucket

    await runCron({ ...env, FILES: brokenFiles })

    expect(errors).toHaveBeenCalledWith('cron purgeDocuments failed', expect.any(Error))
    expect(await exists('challenges', "id = 'isolation'")).toBe(false)
    expect((await jobRow(job)).file_key).not.toBeNull()
  })
})

describe('cron: expired rows', () => {
  it('deletes expired sessions, challenges, enrollment and device codes, tokens and open invites', async () => {
    const now = Date.now()
    const insertSession = env.DB.prepare('INSERT INTO sessions (id, user_id, user_agent, ip, created_at, last_seen_at, expires_at) VALUES (?, ?, NULL, NULL, ?, ?, ?)')
    await insertSession.bind('expired-session', owner.user.id, now - 2 * DAY, now - 2 * DAY, now - 1).run()
    const insertChallenge = env.DB.prepare("INSERT INTO challenges (id, kind, user_id, data, expires_at) VALUES (?, 'test', NULL, '{}', ?)")
    await insertChallenge.bind('old-challenge', now - 1).run()
    await insertChallenge.bind('live-challenge', now + HOUR).run()

    const ws = `/api/workspaces/${owner.workspaceId}`
    const [deadEnrollment, liveEnrollment] = [(await owner.agent.post(`${ws}/enrollments`, {})).body.token, (await owner.agent.post(`${ws}/enrollments`, {})).body.token]
    await env.DB.prepare('UPDATE enrollment_tokens SET expires_at = ? WHERE token_hash = ?').bind(now - 1, await sha256Hex(deadEnrollment)).run()

    const code = await readReply(await call('/api/client/device/code', jsonInit({ hostname: 'laptop', os: 'macos', arch: 'aarch64', version: '0.1.0' })))
    await env.DB.prepare('UPDATE device_codes SET expires_at = ? WHERE id = ?').bind(now - 1, await sha256Hex(code.body.deviceCode)).run()

    const expiring = (await owner.agent.post('/api/me/tokens', { name: 'short', expiresInDays: 1 })).body.token
    await env.DB.prepare('UPDATE api_tokens SET expires_at = ? WHERE token_hash = ?').bind(now - 1, await sha256Hex(expiring)).run()
    const forever = await createPat(owner)

    const member = await addMember(owner)
    await env.DB.prepare('UPDATE invites SET expires_at = ? WHERE accepted_by = ?').bind(now - 1, member.user.id).run()
    const openInvite = new URL((await owner.agent.post(`${ws}/invites`, { role: 'member' })).body.url).pathname.split('/').pop() ?? ''
    await env.DB.prepare('UPDATE invites SET expires_at = ? WHERE token_hash = ?').bind(now - 1, await sha256Hex(openInvite)).run()

    await runCron(env)

    expect(await exists('sessions', "id = 'expired-session'")).toBe(false)
    expect((await owner.agent.get('/api/auth/session')).body.user.id).toBe(owner.user.id)
    expect(await exists('challenges', "id = 'old-challenge'")).toBe(false)
    expect(await exists('challenges', "id = 'live-challenge'")).toBe(true)
    expect(await exists('enrollment_tokens', 'token_hash = ?', await sha256Hex(deadEnrollment))).toBe(false)
    expect(await exists('enrollment_tokens', 'token_hash = ?', await sha256Hex(liveEnrollment))).toBe(true)
    expect(await exists('device_codes', 'id = ?', await sha256Hex(code.body.deviceCode))).toBe(false)
    expect(await exists('api_tokens', 'token_hash = ?', await sha256Hex(expiring))).toBe(false)
    expect(await exists('api_tokens', 'token_hash = ?', await sha256Hex(forever))).toBe(true)
    expect(await exists('invites', 'token_hash = ?', await sha256Hex(openInvite))).toBe(false)
    expect(await exists('invites', 'accepted_by = ?', member.user.id)).toBe(true)
  })

  it('drops OAuth client records older than 30 days only when no token uses them', async () => {
    const now = Date.now()
    const insertClient = env.DB.prepare("INSERT INTO oauth_clients (id, name, redirect_uris, metadata, created_at) VALUES (?, ?, '[]', '{}', ?)")
    await insertClient.bind('stale-client', 'Stale', now - 31 * DAY).run()
    await insertClient.bind('used-client', 'Used', now - 31 * DAY).run()
    await insertClient.bind('new-client', 'New', now - DAY).run()
    await env.DB.prepare(
      `INSERT INTO api_tokens (id, user_id, workspace_id, kind, name, token_hash, scopes, oauth_client_id, parent_id, created_at, last_used_at, expires_at)
       VALUES ('used-token', ?, NULL, 'oauth-refresh', 'Used', 'used-token-hash', '["read"]', 'used-client', NULL, ?, NULL, ?)`,
    )
      .bind(owner.user.id, now, now + DAY)
      .run()

    await runCron(env)

    expect(await exists('oauth_clients', "id = 'stale-client'")).toBe(false)
    expect(await exists('oauth_clients', "id = 'used-client'")).toBe(true)
    expect(await exists('oauth_clients', "id = 'new-client'")).toBe(true)
  })

  it('runs from the scheduled() entry point', async () => {
    await env.DB.prepare("INSERT INTO challenges (id, kind, user_id, data, expires_at) VALUES ('scheduled', 'test', NULL, '{}', ?)").bind(Date.now() - 1).run()
    const ctx = createExecutionContext()
    await worker.scheduled(createScheduledController({ cron: '*/15 * * * *' }), env, ctx)
    await waitOnExecutionContext(ctx)
    expect(await exists('challenges', "id = 'scheduled'")).toBe(false)
  })
})
