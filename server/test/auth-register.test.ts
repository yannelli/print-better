import { env } from 'cloudflare:workers'
import { beforeAll, describe, expect, it } from 'vitest'
import { Agent } from './helpers/http'
import { PASSWORD, setupOwner, type Owner } from './helpers/world'

let owner: Owner
beforeAll(async () => {
  owner = await setupOwner()
})

async function invite(role = 'member'): Promise<string> {
  const r = await owner.agent.post(`/api/workspaces/${owner.workspaceId}/invites`, { role })
  expect(r.status).toBe(200)
  return new URL(r.body.url).pathname.split('/').pop() as string
}

const register = (body: Record<string, unknown>) => new Agent().post('/api/auth/register', { name: 'Someone', password: PASSWORD, ...body })

describe('registration', () => {
  it('is invite-only by default', async () => {
    const r = await register({ username: 'walkin' })
    expect(r.status).toBe(403)
    expect(r.body.error.code).toBe('signup_closed')
  })

  it('joins the inviting workspace with the invited role, once per invite', async () => {
    const token = await invite('admin')
    const agent = new Agent()
    const r = await agent.post('/api/auth/register', { username: 'ada', name: 'Ada', password: PASSWORD, inviteToken: token })
    expect(r.status).toBe(200)
    expect(r.body.user).toMatchObject({ username: 'ada', isAdmin: false, hasPassword: true })
    const session = await agent.get('/api/auth/session')
    expect(session.body.workspaces).toEqual([{ id: owner.workspaceId, name: 'Home', role: 'admin' }])

    const again = await register({ username: 'ada2', inviteToken: token })
    expect(again.status).toBe(404)
    expect(again.body.error.code).toBe('invite_invalid')
    const user = await env.DB.prepare('SELECT 1 FROM users WHERE username = ?').bind('ada2').first()
    expect(user).toBeNull()
  })

  it('rejects unknown invite tokens', async () => {
    for (const inviteToken of ['pbi_nope', 'garbage']) {
      const r = await register({ username: 'nobody', inviteToken })
      expect(r.status).toBe(404)
      expect(r.body.error.code).toBe('invite_invalid')
    }
  })

  it('enforces the username rule: 2 to 32 of letters, digits, dot, dash, underscore', async () => {
    const token = await invite()
    const ok = await register({ username: 'a.b_c-D9', inviteToken: token })
    expect(ok.status).toBe(200)
    for (const username of ['a', 'x'.repeat(33), 'has space', 'émile', 'semi;colon', '']) {
      const r = await register({ username, inviteToken: await invite() })
      expect(r.status, username).toBe(400)
      expect(r.body.error.code).toBe('invalid_request')
    }
  })

  it('keeps usernames and emails unique regardless of case', async () => {
    const taken = await register({ username: 'OWNER', inviteToken: await invite() })
    expect(taken.status).toBe(409)
    expect(taken.body.error.code).toBe('username_taken')

    expect((await register({ username: 'first', email: 'Same@Example.com', inviteToken: await invite() })).status).toBe(200)
    const dup = await register({ username: 'second', email: 'same@example.COM', inviteToken: await invite() })
    expect(dup.status).toBe(409)
    expect(dup.body.error.code).toBe('email_taken')
  })

  it('requires a real password', async () => {
    for (const password of ['', 'short', 'x'.repeat(300)]) {
      const r = await register({ username: 'weak', password, inviteToken: await invite() })
      expect(r.status).toBe(400)
    }
  })

  it('opens sign-up when the instance admin allows it', async () => {
    const member = new Agent()
    await member.post('/api/auth/register', { username: 'plain', name: 'Plain', password: PASSWORD, inviteToken: await invite() })
    const denied = await member.patch('/api/admin/settings', { signup: 'open' })
    expect(denied.status).toBe(403)

    expect((await owner.agent.patch('/api/admin/settings', { signup: 'open' })).status).toBe(200)
    expect((await new Agent().get('/api/instance')).body.signup).toBe('open')
    const agent = new Agent()
    const r = await agent.post('/api/auth/register', { username: 'opendoor', name: 'Open Door', password: PASSWORD })
    expect(r.status).toBe(200)
    expect((await agent.get('/api/auth/session')).body.workspaces).toEqual([])
    await owner.agent.patch('/api/admin/settings', { signup: 'invite' })
  })
})

describe('password storage', () => {
  it('salts every hash and never stores the password', async () => {
    const rows = await env.DB.prepare('SELECT password_hash FROM users WHERE password_hash IS NOT NULL').all<{ password_hash: string }>()
    const hashes = rows.results.map((r) => r.password_hash)
    expect(hashes.length).toBeGreaterThan(2)
    expect(new Set(hashes).size).toBe(hashes.length)
    for (const h of hashes) {
      expect(h).toMatch(/^\$scrypt\$ln=15,r=8,p=3\$/)
      expect(h).not.toContain(PASSWORD)
    }
  })

  it('does not offer email resets when outbound email is off', async () => {
    const r = await new Agent().post('/api/auth/reset/request', { email: 'same@example.com' })
    expect(r.status).toBe(400)
    expect(r.body.error.code).toBe('email_disabled')
  })
})
