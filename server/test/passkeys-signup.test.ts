import { env } from 'cloudflare:workers'
import { describe, expect, it } from 'vitest'
import { Authenticator, type RegisterOverrides } from './helpers/authenticator'
import { Agent, type Reply } from './helpers/http'
import { SETUP_TOKEN } from './helpers/world'

// This file starts with an empty database, so the first tests exercise first-run setup; order matters.
let founder: Agent
let workspaceId: string

interface Ceremony {
  browser: Agent
  challengeId: string
  options: { challenge: string; rp: { id: string }; user: { id: string } }
}

async function begin(body: Record<string, unknown>, browser = new Agent()): Promise<Ceremony & { reply: Reply }> {
  const reply = await browser.post('/api/auth/passkey/signup/options', body)
  return { browser, reply, challengeId: reply.body.challengeId, options: reply.body.options }
}

async function complete(c: Ceremony, auth?: Authenticator, over: RegisterOverrides = {}): Promise<Reply> {
  const credential = await (auth ?? (await Authenticator.create())).register(c.options, over)
  return c.browser.post('/api/auth/passkey/signup/verify', { challengeId: c.challengeId, credential })
}

const userCount = async () => (await env.DB.prepare('SELECT COUNT(*) AS n FROM users').first<{ n: number }>())?.n

async function invite(role: string): Promise<string> {
  const r = await founder.post(`/api/workspaces/${workspaceId}/invites`, { role })
  expect(r.status).toBe(200)
  return new URL(r.body.url).pathname.split('/').pop() as string
}

describe('first-run setup with a passkey', () => {
  it('requires the setup token and a workspace name', async () => {
    const wrong = await begin({ username: 'founder', name: 'Fran Founder', setupToken: 'nope', workspaceName: 'HQ' })
    expect(wrong.reply.status).toBe(403)
    expect(wrong.reply.body.error.code).toBe('bad_setup_token')
    const unnamed = await begin({ username: 'founder', name: 'Fran Founder', setupToken: SETUP_TOKEN })
    expect(unnamed.reply.status).toBe(400)
  })

  it('creates the admin account and its workspace; a concurrent second setup loses', async () => {
    const first = await begin({ username: 'founder', name: 'Fran Founder', setupToken: SETUP_TOKEN, workspaceName: 'HQ' })
    const rival = await begin({ username: 'rival', name: 'Rita Rival', setupToken: SETUP_TOKEN, workspaceName: 'Other' })
    expect(first.reply.status).toBe(200)
    expect(rival.reply.status).toBe(200)

    const done = await complete(first)
    expect(done.status).toBe(200)
    expect(done.body.user).toMatchObject({ username: 'founder', isAdmin: true, hasPassword: false })
    founder = first.browser
    const session = await founder.get('/api/auth/session')
    expect(session.body.workspaces).toEqual([expect.objectContaining({ name: 'HQ', role: 'owner' })])
    workspaceId = session.body.workspaces[0].id

    const lost = await complete(rival)
    expect(lost.status).toBe(409)
    expect(lost.body.error.code).toBe('setup_complete')
    expect(await userCount()).toBe(1)
    expect((await new Agent().get('/api/instance')).body.setupRequired).toBe(false)
  })
})

describe('passwordless sign-up', () => {
  it('is invite-only once setup is done', async () => {
    const r = await begin({ username: 'walkin', name: 'Walk In' })
    expect(r.reply.status).toBe(403)
    expect(r.reply.body.error.code).toBe('signup_closed')
  })

  it('joins the invited workspace with the invited role, once', async () => {
    const token = await invite('admin')
    const c = await begin({ username: 'invitee', name: 'Ivy Invitee', inviteToken: token })
    const r = await complete(c)
    expect(r.status).toBe(200)
    expect(r.body.user).toMatchObject({ username: 'invitee', isAdmin: false, hasPassword: false })
    const session = await c.browser.get('/api/auth/session')
    expect(session.body.workspaces).toEqual([expect.objectContaining({ id: workspaceId, role: 'admin' })])
    const reuse = await begin({ username: 'second', name: 'Second Try', inviteToken: token })
    expect(reuse.reply.status).toBe(404)
    expect(reuse.reply.body.error.code).toBe('invite_invalid')
  })

  it('rejects a username that is taken, ignoring case', async () => {
    const r = await begin({ username: 'FOUNDER', name: 'Copy Cat', inviteToken: await invite('member') })
    expect(r.reply.status).toBe(409)
    expect(r.reply.body.error.code).toBe('username_taken')
  })

  it('fails cleanly when the username is claimed between options and verify', async () => {
    const slow = await begin({ username: 'contested', name: 'Slow', inviteToken: await invite('member') })
    const fast = await begin({ username: 'contested', name: 'Fast', inviteToken: await invite('member') })
    expect((await complete(fast)).status).toBe(200)
    const r = await complete(slow)
    expect(r.status).toBe(409)
    expect(r.body.error.code).toBe('username_taken')
  })

  it('verifies the credential before creating anything', async () => {
    const before = await userCount()
    const c = await begin({ username: 'phished', name: 'Phil Ished', inviteToken: await invite('member') })
    const r = await complete(c, undefined, { origin: 'https://print.test.evil.example' })
    expect(r.status).toBe(400)
    expect(r.body.error.code).toBe('passkey_invalid')
    expect(await userCount()).toBe(before)
  })

  it('consumes the challenge once and only for sign-up', async () => {
    const c = await begin({ username: 'once', name: 'Only Once', inviteToken: await invite('member') })
    const auth = await Authenticator.create()
    const credential = await auth.register(c.options)
    expect((await c.browser.post('/api/auth/passkey/signup/verify', { challengeId: c.challengeId, credential })).status).toBe(200)
    const replay = await new Agent().post('/api/auth/passkey/signup/verify', { challengeId: c.challengeId, credential })
    expect(replay.body.error.code).toBe('challenge_expired')

    const login = await new Agent().post('/api/auth/passkey/login/options', {})
    const crossed = await new Agent().post('/api/auth/passkey/signup/verify', { challengeId: login.body.challengeId, credential })
    expect(crossed.status).toBe(400)
    expect(crossed.body.error.code).toBe('challenge_expired')
  })

  it('needs no invite when sign-up is open', async () => {
    expect((await founder.patch('/api/admin/settings', { signup: 'open' })).status).toBe(200)
    const c = await begin({ username: 'opendoor', name: 'Open Door' })
    const r = await complete(c)
    expect(r.status).toBe(200)
    expect((await c.browser.get('/api/auth/session')).body.workspaces).toEqual([])
    expect((await founder.patch('/api/admin/settings', { signup: 'invite' })).status).toBe(200)
  })
})

describe('last sign-in method', () => {
  it('keeps a passkey-only account from deleting its only passkey', async () => {
    const first = await Authenticator.create()
    const c = await begin({ username: 'keyonly', name: 'Key Only', inviteToken: await invite('member') })
    expect((await complete(c, first)).status).toBe(200)
    const me = c.browser
    const blocked = await me.del(`/api/me/passkeys/${first.id}`)
    expect(blocked.status).toBe(409)
    expect(blocked.body.error.code).toBe('last_sign_in_method')

    const second = await Authenticator.create()
    const { body } = await me.post('/api/auth/passkey/register/options')
    expect((await me.post('/api/auth/passkey/register/verify', { challengeId: body.challengeId, credential: await second.register(body.options) })).status).toBe(200)
    expect((await me.del(`/api/me/passkeys/${first.id}`)).status).toBe(204)
    expect((await me.del(`/api/me/passkeys/${second.id}`)).body.error.code).toBe('last_sign_in_method')
  })
})
