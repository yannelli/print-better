import { env } from 'cloudflare:workers'
import { beforeAll, describe, expect, it } from 'vitest'
import { sha256Hex } from '../worker/lib/crypto'
import { Agent, call, nextIp, readReply } from './helpers/http'
import { addMember, DEVICE_INFO, jsonInit, setupOwner, type Owner } from './helpers/world'

let owner: Owner
beforeAll(async () => {
  owner = await setupOwner()
})

const enroll = async (token: string, extra: Record<string, unknown> = {}, ip = nextIp()) =>
  readReply(await call('/api/client/enroll', jsonInit({ token, ...DEVICE_INFO, ...extra }, { 'CF-Connecting-IP': ip })))
const mint = async (body: Record<string, unknown> = {}) => (await owner.agent.post(`/api/workspaces/${owner.workspaceId}/enrollments`, body)).body
const deviceGet = (path: string, token: string) => call(path, { headers: { Authorization: `Bearer ${token}` } })

describe('enrollment tokens', () => {
  it('mint copy-paste install commands for this origin, admins only', async () => {
    const e = await mint()
    expect(e.token).toMatch(/^pbe_/)
    expect(e.server).toBe('https://print.test')
    expect(e.commands.unix).toBe(`curl -fsSL https://print.test/install.sh | sh -s -- --token ${e.token}`)
    expect(e.commands.windows).toBe(`$env:PB_TOKEN='${e.token}'; irm https://print.test/install.ps1 | iex`)
    expect(e.expiresAt).toBeGreaterThan(Date.now() + 23 * 3600_000)
    const member = await addMember(owner)
    expect((await member.agent.post(`/api/workspaces/${owner.workspaceId}/enrollments`, {})).status).toBe(403)
  })

  it('pair a device once and hand back its device token', async () => {
    const e = await mint({ label: 'Pi' })
    const r = await enroll(e.token, { name: 'Office Pi' })
    expect(r.status).toBe(200)
    expect(r.body).toMatchObject({ workspaceId: owner.workspaceId, name: 'Office Pi' })
    expect(r.body.token).toMatch(/^pbc_/)
    const clients = (await owner.agent.get(`/api/workspaces/${owner.workspaceId}/clients`)).body
    expect(clients).toEqual(expect.arrayContaining([expect.objectContaining({ id: r.body.clientId, name: 'Office Pi', online: false, os: 'linux' })]))
    const again = await enroll(e.token)
    expect(again.status).toBe(401)
    expect(again.body.error.code).toBe('invalid_token')
  })

  it('honor maxUses, expiry and deletion', async () => {
    const multi = await mint({ maxUses: 2 })
    expect((await enroll(multi.token)).status).toBe(200)
    expect((await enroll(multi.token)).status).toBe(200)
    expect((await enroll(multi.token)).status).toBe(401)

    const stale = await mint()
    await env.DB.prepare('UPDATE enrollment_tokens SET expires_at = ? WHERE token_hash = ?').bind(Date.now() - 1, await sha256Hex(stale.token)).run()
    expect((await enroll(stale.token)).status).toBe(401)

    const doomed = await mint({ label: 'doomed' })
    const listed = (await owner.agent.get(`/api/workspaces/${owner.workspaceId}/enrollments`)).body
    const row = listed.find((t: { label: string | null }) => t.label === 'doomed')
    expect(JSON.stringify(listed)).not.toContain(doomed.token)
    expect((await owner.agent.del(`/api/workspaces/${owner.workspaceId}/enrollments/${row.id}`)).status).toBeLessThan(300)
    expect((await enroll(doomed.token)).status).toBe(401)
  })

  it('use the hostname as the default name and validate device info', async () => {
    const named = await enroll((await mint()).token)
    expect(named.body.name).toBe('office-pi')
    expect((await enroll((await mint()).token, { os: 'beos' })).status).toBe(400)
  })

  it('throttle enrollment attempts per IP', async () => {
    const ip = nextIp()
    for (let i = 0; i < 30; i++) expect((await enroll('pbe_wrong', {}, ip)).status).toBe(401)
    expect((await enroll('pbe_wrong', {}, ip)).status).toBe(429)
  })

  it('stop a removed device from using its token anywhere', async () => {
    const { body } = await enroll((await mint()).token)
    expect((await deviceGet('/api/client/latest?os=linux&arch=aarch64', body.token)).status).not.toBe(401)
    expect((await owner.agent.del(`/api/workspaces/${owner.workspaceId}/clients/${body.clientId}`)).status).toBeLessThan(300)
    for (const path of ['/api/client/latest?os=linux&arch=aarch64', '/api/client/jobs/x/file']) {
      expect((await deviceGet(path, body.token)).status).toBe(401)
    }
    const ws = await call('/api/client/ws', { headers: { Upgrade: 'websocket', Authorization: `Bearer ${body.token}` } })
    expect(ws.status).toBe(401)
  })
})

describe('device code pairing (RFC 8628)', () => {
  const start = async () => (await readReply(await call('/api/client/device/code', jsonInit(DEVICE_INFO)))).body
  const poll = async (deviceCode: string) => readReply(await call('/api/client/device/token', jsonInit({ deviceCode })))
  const age = (userCode: string) =>
    env.DB.prepare('UPDATE device_codes SET last_poll_at = ? WHERE user_code = ?').bind(Date.now() - 6000, userCode.replace('-', '')).run()

  it('issues a readable user code with verification links', async () => {
    const d = await start()
    expect(d.deviceCode).toMatch(/^pbd_/)
    expect(d.userCode).toMatch(/^[BCDFGHJKLMNPQRSTVWXZ]{4}-[BCDFGHJKLMNPQRSTVWXZ]{4}$/)
    expect(d).toMatchObject({ verificationUri: 'https://print.test/device', interval: 5, expiresIn: 600 })
    expect(d.verificationUriComplete).toBe(`https://print.test/device?code=${d.userCode}`)
  })

  it('answers pending, then slow_down when polled faster than the interval', async () => {
    const d = await start()
    const first = await poll(d.deviceCode)
    expect(first.status).toBe(400)
    expect(first.body.error.code).toBe('authorization_pending')
    expect((await poll(d.deviceCode)).body.error.code).toBe('slow_down')
    await age(d.userCode)
    expect((await poll(d.deviceCode)).body.error.code).toBe('authorization_pending')
  })

  it('shows the device to signed-in admins with the workspaces they can approve into', async () => {
    const d = await start()
    const member = await addMember(owner)
    const memberWs = await member.agent.post('/api/workspaces', { name: 'Member Home' })
    const view = await member.agent.get(`/api/device/${d.userCode.toLowerCase().replace('-', '')}`)
    expect(view.status).toBe(200)
    expect(view.body).toMatchObject({ hostname: 'office-pi', os: 'linux', arch: 'aarch64', version: '0.1.0' })
    expect(view.body.workspaces).toEqual([expect.objectContaining({ id: memberWs.body.id, role: 'owner' })])
    expect((await new Agent().get(`/api/device/${d.userCode}`)).status).toBe(401)
  })

  it('pairs into the approved workspace exactly once', async () => {
    const d = await start()
    const member = await addMember(owner)
    expect((await member.agent.post(`/api/device/${d.userCode}/approve`, { workspaceId: owner.workspaceId })).status).toBe(403)
    expect((await owner.agent.post(`/api/device/${d.userCode}/approve`, { workspaceId: owner.workspaceId, name: 'Front desk' })).status).toBeLessThan(300)
    await age(d.userCode)
    const done = await poll(d.deviceCode)
    expect(done.status).toBe(200)
    expect(done.body).toMatchObject({ workspaceId: owner.workspaceId, name: 'Front desk' })
    expect(done.body.token).toMatch(/^pbc_/)
    expect((await poll(d.deviceCode)).body.error.code).toBe('expired_token')
    expect((await owner.agent.post(`/api/device/${d.userCode}/approve`, { workspaceId: owner.workspaceId })).body.error.code).toBe('device_code_invalid')
  })

  it('reports denial and expiry to the polling device', async () => {
    const denied = await start()
    expect((await owner.agent.post(`/api/device/${denied.userCode}/deny`)).status).toBeLessThan(300)
    expect((await poll(denied.deviceCode)).body.error.code).toBe('access_denied')

    const late = await start()
    await env.DB.prepare('UPDATE device_codes SET expires_at = ? WHERE user_code = ?').bind(Date.now() - 1, late.userCode.replace('-', '')).run()
    expect((await poll(late.deviceCode)).body.error.code).toBe('expired_token')
    expect((await owner.agent.get(`/api/device/${late.userCode}`)).body.error.code).toBe('device_code_invalid')
  })

  it('limits wrong user-code guesses per user', async () => {
    const guesser = await addMember(owner)
    for (let i = 0; i < 10; i++) expect((await guesser.agent.get('/api/device/BCDF-GHJK')).status).toBe(404)
    const real = await start()
    expect((await guesser.agent.get(`/api/device/${real.userCode}`)).status).toBe(429)
  })
})
