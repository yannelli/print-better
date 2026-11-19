import { Buffer } from 'node:buffer'
import { scrypt } from 'node:crypto'
import { env } from 'cloudflare:workers'
import { beforeAll, describe, expect, it } from 'vitest'
import { hmacSha256 } from '../worker/lib/crypto'
import { Agent, call, parseSetCookie } from './helpers/http'
import { addMember, PASSWORD, setupOwner, type Owner } from './helpers/world'

let owner: Owner
beforeAll(async () => {
  owner = await setupOwner()
})

const login = (agent: Agent, name: string, password = PASSWORD) => agent.post('/api/auth/login', { login: name, password })

async function oldStyleHash(input: Uint8Array | string, ln: number): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16))
  const key = await new Promise<Buffer>((resolve, reject) =>
    scrypt(input, salt, 32, { N: 2 ** ln, r: 8, p: 3, maxmem: 64 * 1024 * 1024 }, (e, k) => (e ? reject(e) : resolve(k))),
  )
  return `$scrypt$ln=${ln},r=8,p=3$${Buffer.from(salt).toString('base64')}$${key.toString('base64')}`
}

const hashOf = async (username: string) =>
  (await env.DB.prepare('SELECT password_hash FROM users WHERE username = ?').bind(username).first<{ password_hash: string }>())?.password_hash

describe('sign-in', () => {
  it('accepts the username or the email, case-insensitively', async () => {
    const { user } = await addMember(owner)
    await env.DB.prepare('UPDATE users SET email = ? WHERE id = ?').bind('pat@example.com', user.id).run()
    for (const name of [user.username, user.username.toUpperCase(), 'PAT@example.com']) {
      const agent = new Agent()
      const r = await login(agent, name)
      expect(r.status, name).toBe(200)
      expect(r.body.user.id).toBe(user.id)
      expect(agent.cookies.get('pb_session')).toMatch(/^pbs_/)
    }
  })

  it('answers the same way for a wrong password and an unknown account', async () => {
    const wrong = await login(new Agent(), 'owner', 'not the password')
    const unknown = await login(new Agent(), 'nobody-here', 'not the password')
    for (const r of [wrong, unknown]) {
      expect(r.status).toBe(401)
      expect(r.body.error).toEqual({ code: 'invalid_credentials', message: 'Wrong username or password' })
      expect(r.res.headers.getSetCookie()).toEqual([])
    }
  })

  it('locks an account name after 10 failures, even from new IPs and with the right password', async () => {
    const { user } = await addMember(owner)
    for (let i = 0; i < 10; i++) expect((await login(new Agent(), user.username, 'nope')).status).toBe(401)
    const blocked = await login(new Agent(), user.username)
    expect(blocked.status).toBe(429)
    expect(blocked.body.error.code).toBe('rate_limited')
  })

  it('clears the failure count on a successful sign-in', async () => {
    const { user } = await addMember(owner)
    for (let round = 0; round < 2; round++) {
      for (let i = 0; i < 9; i++) await login(new Agent(), user.username, 'nope')
      expect((await login(new Agent(), user.username)).status).toBe(200)
    }
  })

  it('upgrades a hash with older scrypt parameters at sign-in', async () => {
    const { user } = await addMember(owner)
    const old = await oldStyleHash(await hmacSha256(env.AUTH_PEPPER, PASSWORD), 14)
    await env.DB.prepare('UPDATE users SET password_hash = ? WHERE id = ?').bind(old, user.id).run()
    expect((await login(new Agent(), user.username)).status).toBe(200)
    const upgraded = await hashOf(user.username)
    expect(upgraded).toMatch(/^\$scrypt\$ln=15,r=8,p=3\$/)
    expect((await login(new Agent(), user.username)).status).toBe(200)
  })

  it('mixes the pepper into every hash', async () => {
    const { user } = await addMember(owner)
    const unpeppered = await oldStyleHash(PASSWORD, 15)
    await env.DB.prepare('UPDATE users SET password_hash = ? WHERE id = ?').bind(unpeppered, user.id).run()
    expect((await login(new Agent(), user.username)).status).toBe(401)
  })
})

describe('sessions', () => {
  it('signs out: the cookie is cleared and the old value stops working', async () => {
    const { agent } = await addMember(owner)
    const cookie = agent.cookies.get('pb_session') as string
    const out = await agent.post('/api/auth/logout')
    expect(out.status).toBeLessThan(300)
    expect(parseSetCookie(out.res.headers.getSetCookie()[0]).attrs['max-age']).toBe('0')

    const replay = await call('/api/auth/session', { headers: { Cookie: `pb_session=${cookie}` } })
    expect((await replay.json<{ user: unknown }>()).user).toBeNull()
    expect(replay.headers.getSetCookie()[0]).toContain('Max-Age=0')
  })

  it('slides the expiry at most hourly and re-sends the cookie when it does', async () => {
    const { agent, user } = await addMember(owner)
    const quiet = await agent.get('/api/auth/session')
    expect(quiet.res.headers.getSetCookie()).toEqual([])

    const twoHoursAgo = Date.now() - 2 * 3600_000
    await env.DB.prepare('UPDATE sessions SET last_seen_at = ?, expires_at = ? WHERE user_id = ?').bind(twoHoursAgo, twoHoursAgo + 86_400_000, user.id).run()
    const refreshed = await agent.get('/api/auth/session')
    expect(parseSetCookie(refreshed.res.headers.getSetCookie()[0]).attrs['max-age']).toBe(String(30 * 24 * 3600))
    const row = await env.DB.prepare('SELECT expires_at FROM sessions WHERE user_id = ?').bind(user.id).first<{ expires_at: number }>()
    expect(row!.expires_at).toBeGreaterThan(Date.now() + 29 * 86_400_000)
  })

  it('drops an expired session and clears its cookie', async () => {
    const { agent, user } = await addMember(owner)
    await env.DB.prepare('UPDATE sessions SET expires_at = ? WHERE user_id = ?').bind(Date.now() - 1, user.id).run()
    const r = await agent.get('/api/auth/session')
    expect(r.body.user).toBeNull()
    expect(agent.cookies.has('pb_session')).toBe(false)
    expect(await env.DB.prepare('SELECT 1 FROM sessions WHERE user_id = ?').bind(user.id).first()).toBeNull()
  })

  it('ignores cookie values that are not session tokens', async () => {
    for (const value of ['', 'pbt_whatever', 'pbs_unknown', 'a;b']) {
      const r = await call('/api/auth/session', { headers: { Cookie: `pb_session=${value}` } })
      expect((await r.json<{ user: unknown }>()).user).toBeNull()
    }
  })
})

describe('origin rules', () => {
  const create = (agent: Agent, headers: Record<string, string>) => agent.json('POST', '/api/workspaces', { name: 'Extra' }, headers)

  it('rejects cookie-authenticated writes without our Origin', async () => {
    const agent = new Agent({ origin: null })
    agent.cookies.set('pb_session', owner.agent.cookies.get('pb_session') as string)
    for (const headers of [{}, { Origin: 'https://evil.test' }, { Origin: 'null' }, { Origin: 'http://print.test' }] as Record<string, string>[]) {
      const r = await create(agent, headers)
      expect(r.status).toBe(403)
      expect(r.body.error.code).toBe('bad_origin')
    }
    expect((await agent.get('/api/workspaces')).status).toBe(200)
    expect((await create(agent, { Origin: 'https://print.test' })).status).toBe(200)
  })

  it('guards sign-in against cross-site posts but allows non-browser callers', async () => {
    const evil = await new Agent({ origin: 'https://evil.test' }).post('/api/auth/login', { login: 'owner', password: PASSWORD })
    expect(evil.status).toBe(403)
    expect(evil.body.error.code).toBe('bad_origin')
    expect((await login(new Agent({ origin: null }), 'owner')).status).toBe(200)
  })

  it('does not apply browser origin rules to bearer, device, or webhook calls', async () => {
    const token = (await owner.agent.post('/api/me/tokens', { name: 'cli' })).body.token
    const r = await new Agent({ token, origin: 'https://evil.test' }).post('/api/workspaces', { name: 'From CLI' })
    expect(r.status).toBe(200)
    const device = await new Agent({ origin: 'https://evil.test' }).post('/api/client/enroll', { token: 'pbe_bad', hostname: 'h', os: 'linux', arch: 'x86_64', version: '1' })
    expect(device.body.error.code).toBe('invalid_token')
  })
})
