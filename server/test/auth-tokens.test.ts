import { env } from 'cloudflare:workers'
import { beforeAll, describe, expect, it } from 'vitest'
import { sha256Hex } from '../worker/lib/crypto'
import { Agent } from './helpers/http'
import { insertToken } from './helpers/tokens'
import { addMember, createPat, PASSWORD, setupOwner, type Owner } from './helpers/world'

const NEW_PASSWORD = 'a much better passphrase'

let owner: Owner
beforeAll(async () => {
  owner = await setupOwner()
})

const signIn = async (username: string, password = PASSWORD) => {
  const agent = new Agent()
  return { agent, reply: await agent.post('/api/auth/login', { login: username, password }) }
}

describe('personal API tokens', () => {
  it('authenticates as the user, is shown once, and is stored only as a hash', async () => {
    const created = await owner.agent.post('/api/me/tokens', { name: 'cli' })
    expect(created.body.token).toMatch(/^pbt_/)
    expect(created.body.apiToken).toMatchObject({ kind: 'pat', name: 'cli', scopes: ['read', 'write', 'print'], expiresAt: null })
    const api = new Agent({ token: created.body.token })
    expect((await api.get('/api/auth/session')).body.user.id).toBe(owner.user.id)
    const listed = await owner.agent.get('/api/me/tokens')
    expect(JSON.stringify(listed.body)).not.toContain(created.body.token)
    const row = await env.DB.prepare('SELECT token_hash FROM api_tokens WHERE id = ?').bind(created.body.apiToken.id).first<{ token_hash: string }>()
    expect(row!.token_hash).toBe(await sha256Hex(created.body.token))
  })

  it('cannot change account security (403 session_required)', async () => {
    const api = new Agent({ token: await createPat(owner) })
    const attempts = [
      api.post('/api/me/tokens', { name: 'more' }),
      api.put('/api/me/password', { current: PASSWORD, next: NEW_PASSWORD }),
      api.post('/api/me/recovery-codes'),
      api.get('/api/me/sessions'),
      api.post('/api/auth/passkey/register/options'),
    ]
    for (const r of await Promise.all(attempts)) {
      expect(r.status).toBe(403)
      expect(r.body.error.code).toBe('session_required')
    }
  })

  it('pins a token to one workspace', async () => {
    const work = await owner.agent.post('/api/workspaces', { name: 'Work' })
    const api = new Agent({ token: await createPat(owner, owner.workspaceId) })
    expect((await api.get('/api/workspaces')).body.map((w: { id: string }) => w.id)).toEqual([owner.workspaceId])
    expect((await api.get(`/api/workspaces/${work.body.id}`)).status).toBe(404)
    expect((await api.get(`/api/workspaces/${owner.workspaceId}`)).status).toBe(200)
  })

  it('rejects unknown, malformed, expired and deleted tokens', async () => {
    const expired = await owner.agent.post('/api/me/tokens', { name: 'short', expiresInDays: 1 })
    await env.DB.prepare('UPDATE api_tokens SET expires_at = ? WHERE id = ?').bind(Date.now() - 1, expired.body.apiToken.id).run()
    const deleted = await owner.agent.post('/api/me/tokens', { name: 'gone' })
    expect((await owner.agent.del(`/api/me/tokens/${deleted.body.apiToken.id}`)).status).toBeLessThan(300)
    for (const token of ['pbt_unknown', 'nonsense', 'pbs_session', expired.body.token, deleted.body.token]) {
      const r = await new Agent({ token }).get('/api/auth/session')
      expect(r.status, token.slice(0, 8)).toBe(401)
      expect(r.body.error.code).toBe('invalid_token')
    }
  })

  it('enforces token scopes on the REST API', async () => {
    const reader = new Agent({ token: await insertToken(owner.user.id, { scopes: ['read'] }) })
    expect((await reader.get('/api/workspaces')).status).toBe(200)
    const write = await reader.post('/api/workspaces', { name: 'Nope' })
    expect(write.status).toBe(403)
    expect(write.body.error.code).toBe('insufficient_scope')
    const legacy = new Agent({ token: await insertToken(owner.user.id, { scopes: null }) })
    expect((await legacy.post('/api/workspaces', { name: 'Legacy default scopes' })).status).toBe(200)
  })

  it('refuses OAuth access tokens, which are bound to /mcp', async () => {
    const token = await insertToken(owner.user.id, { kind: 'oauth-access', resource: 'https://print.test/mcp' })
    const r = await new Agent({ token }).get('/api/auth/session')
    expect(r.status).toBe(401)
    expect(r.body.error.code).toBe('invalid_token')
  })
})

describe('password change', () => {
  it('needs the current password and signs out every other session', async () => {
    const member = await addMember(owner)
    const other = await signIn(member.user.username)
    const wrong = await member.agent.put('/api/me/password', { current: 'wrong password', next: NEW_PASSWORD })
    expect(wrong.status).toBe(401)
    expect(wrong.body.error.code).toBe('invalid_credentials')

    expect((await member.agent.put('/api/me/password', { current: PASSWORD, next: NEW_PASSWORD })).status).toBeLessThan(300)
    expect((await member.agent.get('/api/auth/session')).body.user.id).toBe(member.user.id)
    expect((await other.agent.get('/api/auth/session')).body.user).toBeNull()
    expect((await signIn(member.user.username)).reply.status).toBe(401)
    expect((await signIn(member.user.username, NEW_PASSWORD)).reply.status).toBe(200)
  })
})

describe('recovery codes', () => {
  it('issues ten single-use codes that can sign in and set a new password', async () => {
    const member = await addMember(owner)
    const { codes } = (await member.agent.post('/api/me/recovery-codes')).body
    expect(codes).toHaveLength(10)
    for (const c of codes) expect(c).toMatch(/^[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}$/i)

    const agent = new Agent()
    const recovered = await agent.post('/api/auth/recover', { login: member.user.username, code: codes[0], newPassword: NEW_PASSWORD })
    expect(recovered.status).toBe(200)
    expect(agent.cookies.get('pb_session')).toMatch(/^pbs_/)
    expect((await member.agent.get('/api/auth/session')).body.user).toBeNull()
    expect((await signIn(member.user.username, NEW_PASSWORD)).reply.status).toBe(200)

    const reused = await new Agent().post('/api/auth/recover', { login: member.user.username, code: codes[0] })
    expect(reused.status).toBe(401)
    expect(reused.body.error.code).toBe('invalid_credentials')
    expect((await new Agent().post('/api/auth/recover', { login: member.user.username, code: codes[1] })).status).toBe(200)
    expect((await signIn(member.user.username, NEW_PASSWORD)).reply.status).toBe(200)
  })

  it('replaces all earlier codes when new ones are generated', async () => {
    const member = await addMember(owner)
    const first = (await member.agent.post('/api/me/recovery-codes')).body.codes
    await member.agent.post('/api/me/recovery-codes')
    const r = await new Agent().post('/api/auth/recover', { login: member.user.username, code: first[0] })
    expect(r.status).toBe(401)
  })
})

describe('admin reset links', () => {
  it('lets an instance admin issue a one-time link that signs the user in', async () => {
    const member = await addMember(owner)
    const link = await owner.agent.post(`/api/admin/users/${member.user.id}/reset-password`)
    expect(link.body.url).toMatch(/^https:\/\/print\.test\/reset-password#token=pbp_/)
    const token = new URL(link.body.url).hash.slice('#token='.length)

    const agent = new Agent()
    const done = await agent.post('/api/auth/reset/confirm', { token, password: NEW_PASSWORD })
    expect(done.status).toBe(200)
    expect(done.body.user.id).toBe(member.user.id)
    expect((await member.agent.get('/api/auth/session')).body.user).toBeNull()
    expect((await signIn(member.user.username, NEW_PASSWORD)).reply.status).toBe(200)

    const replay = await new Agent().post('/api/auth/reset/confirm', { token, password: PASSWORD })
    expect(replay.status).toBe(400)
    expect(replay.body.error.code).toBe('reset_invalid')
  })

  it('is limited to instance admins', async () => {
    const member = await addMember(owner, 'admin')
    const r = await member.agent.post(`/api/admin/users/${owner.user.id}/reset-password`)
    expect(r.status).toBe(403)
  })
})
