import { env } from 'cloudflare:workers'
import { describe, expect, it } from 'vitest'
import { Agent, nextIp, parseSetCookie } from './helpers/http'
import { PASSWORD, SETUP_TOKEN } from './helpers/world'

const SETUP = { setupToken: SETUP_TOKEN, username: 'olive', name: 'Olive Owner', password: PASSWORD, workspaceName: 'Home' }

describe('first-run setup', () => {
  it('reports setup required and refuses sign-up or sign-in before it', async () => {
    const agent = new Agent()
    expect((await agent.get('/api/instance')).body).toMatchObject({ setupRequired: true, signup: 'invite' })
    const register = await agent.post('/api/auth/register', { username: 'early', name: 'Early', password: PASSWORD })
    expect(register.status).toBe(409)
    expect(register.body.error.code).toBe('setup_required')
    const login = await agent.post('/api/auth/login', { login: 'olive', password: PASSWORD })
    expect(login.status).toBe(401)
    expect(login.body.error.code).toBe('invalid_credentials')
  })

  it('requires the exact setup token', async () => {
    const agent = new Agent()
    for (const setupToken of [undefined, '', 'test-setup-tokeN', `${SETUP_TOKEN}x`]) {
      const r = await agent.post('/api/auth/setup', { ...SETUP, setupToken })
      expect(r.status).toBe(403)
      expect(r.body.error.code).toBe('bad_setup_token')
    }
    expect(agent.cookies.size).toBe(0)
  })

  it('validates the owner fields', async () => {
    const agent = new Agent()
    expect((await agent.post('/api/auth/setup', { ...SETUP, username: 'o' })).status).toBe(400)
    expect((await agent.post('/api/auth/setup', { ...SETUP, username: 'bad name!' })).status).toBe(400)
    expect((await agent.post('/api/auth/setup', { ...SETUP, workspaceName: '' })).status).toBe(400)
    expect((await agent.post('/api/auth/setup', { ...SETUP, password: 'short' })).status).toBe(400)
  })

  it('creates the instance admin, the first workspace, and a hardened session cookie', async () => {
    const agent = new Agent()
    const r = await agent.post('/api/auth/setup', SETUP)
    expect(r.status).toBe(200)
    expect(r.body.user).toMatchObject({ username: 'olive', name: 'Olive Owner', isAdmin: true, hasPassword: true })

    const cookie = parseSetCookie(r.res.headers.getSetCookie()[0])
    expect(cookie.name).toBe('pb_session')
    expect(cookie.value).toMatch(/^pbs_/)
    expect(cookie.attrs).toMatchObject({ path: '/', httponly: true, secure: true, samesite: 'Lax', 'max-age': String(30 * 24 * 3600) })

    const session = await agent.get('/api/auth/session')
    expect(session.body.user.username).toBe('olive')
    expect(session.body.workspaces).toEqual([expect.objectContaining({ name: 'Home', role: 'owner' })])
    expect((await agent.get('/api/instance')).body.setupRequired).toBe(false)

    const stored = await env.DB.prepare('SELECT password_hash FROM users WHERE username = ?').bind('olive').first<{ password_hash: string }>()
    expect(stored?.password_hash).toMatch(/^\$scrypt\$ln=15,r=8,p=3\$[A-Za-z0-9+/=]+\$[A-Za-z0-9+/=]+$/)
    const sessionRow = await env.DB.prepare('SELECT id FROM sessions').first<{ id: string }>()
    expect(sessionRow?.id).not.toContain(cookie.value)
  })

  it('refuses a second setup even with the right token', async () => {
    const r = await new Agent().post('/api/auth/setup', { ...SETUP, username: 'mallory' })
    expect(r.status).toBe(409)
    expect(r.body.error.code).toBe('setup_complete')
  })

  it('throttles setup attempts per IP', async () => {
    const agent = new Agent({ ip: nextIp() })
    const codes: number[] = []
    for (let i = 0; i < 11; i++) codes.push((await agent.post('/api/auth/setup', { ...SETUP, setupToken: 'wrong' })).status)
    expect(codes.slice(0, 10).every((c) => c === 403)).toBe(true)
    expect(codes[10]).toBe(429)
  })
})
