import { env } from 'cloudflare:workers'
import { beforeAll, describe, expect, it } from 'vitest'
import { AT, Authenticator, BE, BS, UP, UV, userHandleFor, type RegisterOverrides } from './helpers/authenticator'
import { Agent, type Reply } from './helpers/http'
import { addMember, createPat, setupOwner, type Owner, type Person } from './helpers/world'

let owner: Owner
let member: Person

beforeAll(async () => {
  owner = await setupOwner()
  member = await addMember(owner)
})

async function options(agent: Agent) {
  const r = await agent.post('/api/auth/passkey/register/options')
  expect(r.status).toBe(200)
  return r.body as { challengeId: string; options: { challenge: string; rp: { id: string }; user: { id: string } } & Record<string, unknown> }
}

async function register(agent: Agent, auth: Authenticator, over: RegisterOverrides = {}, name?: string): Promise<Reply> {
  const { challengeId, options: opts } = await options(agent)
  return agent.post('/api/auth/passkey/register/verify', { challengeId, credential: await auth.register(opts, over), name })
}

function expectRejected(r: Reply, reason: RegExp): void {
  expect(r.status).toBe(400)
  expect(r.body.error.code).toBe('passkey_invalid')
  expect(r.body.error.message).toMatch(reason)
}

describe('passkey registration options', () => {
  it('are bound to this origin and require user verification and a resident key', async () => {
    const { challengeId, options: opts } = await options(owner.agent)
    expect(challengeId).toEqual(expect.any(String))
    expect(opts).toMatchObject({
      rp: { id: 'print.test', name: 'Print Better' },
      user: { id: userHandleFor(owner.user.id), name: 'owner', displayName: 'Olive Owner' },
      attestation: 'none',
      authenticatorSelection: { residentKey: 'required', requireResidentKey: true, userVerification: 'required' },
      excludeCredentials: [],
    })
    expect(opts.challenge).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect((opts.pubKeyCredParams as { alg: number }[]).map((p) => p.alg).sort((a, b) => a - b)).toEqual([-257, -8, -7])
  })

  it('need a browser session', async () => {
    expect((await new Agent().post('/api/auth/passkey/register/options')).status).toBe(401)
    const pat = new Agent({ token: await createPat(owner) })
    const r = await pat.post('/api/auth/passkey/register/options')
    expect(r.status).toBe(403)
    expect(r.body.error.code).toBe('session_required')
  })
})

describe('passkey registration', () => {
  it('stores a verified passkey and excludes it from later ceremonies', async () => {
    const auth = await Authenticator.create()
    const r = await register(owner.agent, auth, {}, 'Laptop')
    expect(r.status).toBe(200)
    expect(r.body).toMatchObject({ id: auth.id, name: 'Laptop', backedUp: false, lastUsedAt: null })
    const listed = await owner.agent.get('/api/me/passkeys')
    expect(listed.body.map((p: { id: string }) => p.id)).toContain(auth.id)
    const row = await env.DB.prepare('SELECT alg, sign_count, transports FROM passkeys WHERE id = ?').bind(auth.id).first()
    expect(row).toEqual({ alg: -7, sign_count: 0, transports: '["internal","hybrid"]' })
    const next = await options(owner.agent)
    expect(next.options.excludeCredentials).toContainEqual({ type: 'public-key', id: auth.id, transports: ['internal', 'hybrid'] })
  })

  it('records backup eligibility and state', async () => {
    const r = await register(owner.agent, await Authenticator.create(), { flags: UP | UV | AT | BE | BS })
    expect(r.status).toBe(200)
    expect(r.body.backedUp).toBe(true)
  })

  it('rejects registering the same credential twice', async () => {
    const auth = await Authenticator.create()
    expect((await register(member.agent, auth)).status).toBe(200)
    const again = await register(member.agent, auth)
    expect(again.status).toBe(409)
    expect(again.body.error.code).toBe('passkey_exists')
  })

  it('consumes each challenge exactly once', async () => {
    const auth = await Authenticator.create()
    const { challengeId, options: opts } = await options(owner.agent)
    const credential = await auth.register(opts)
    expect((await owner.agent.post('/api/auth/passkey/register/verify', { challengeId, credential })).status).toBe(200)
    const replay = await owner.agent.post('/api/auth/passkey/register/verify', { challengeId, credential })
    expect(replay.status).toBe(400)
    expect(replay.body.error.code).toBe('challenge_expired')
  })

  it('binds the challenge to the account that requested it', async () => {
    const { challengeId, options: opts } = await options(member.agent)
    const credential = await (await Authenticator.create()).register(opts)
    const r = await owner.agent.post('/api/auth/passkey/register/verify', { challengeId, credential })
    expect(r.status).toBe(400)
    expect(r.body.error.code).toBe('challenge_expired')
  })

  it('does not accept a sign-in challenge', async () => {
    const login = await new Agent().post('/api/auth/passkey/login/options', {})
    const credential = await (await Authenticator.create()).register({ challenge: login.body.options.challenge, rp: { id: 'print.test' }, user: { id: userHandleFor(owner.user.id) } })
    const r = await owner.agent.post('/api/auth/passkey/register/verify', { challengeId: login.body.challengeId, credential })
    expect(r.status).toBe(400)
    expect(r.body.error.code).toBe('challenge_expired')
  })

  const otherAuth = Authenticator.create()
  it.each<[string, RegisterOverrides | (() => Promise<RegisterOverrides>), RegExp]>([
    ['another origin', { origin: 'https://evil.test' }, /origin mismatch/],
    ['an origin on another port', { origin: 'https://print.test:8443' }, /origin mismatch/],
    ['another RP ID', { rpId: 'evil.test' }, /RP ID mismatch/],
    ['a parent-domain RP ID', { rpId: 'test' }, /RP ID mismatch/],
    ['a different challenge', { challenge: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' }, /challenge mismatch/],
    ['the sign-in ceremony type', { type: 'webauthn.get' }, /wrong ceremony type/],
    ['a cross-origin iframe', { crossOrigin: true }, /cross-origin/],
    ['no user verification', { flags: UP | AT }, /user verification is missing/],
    ['no user presence', { flags: UV | AT }, /user presence is missing/],
    ['backup state without eligibility', { flags: UP | UV | AT | BS }, /backup flags are inconsistent/],
    ['no attested credential data', { flags: UP | UV }, /attested credential data is missing/],
    ['a credential id that differs from the attested one', async () => ({ id: (await otherAuth).id }), /credential id mismatch/],
  ])('rejects %s', async (_, over, reason) => {
    const overrides = typeof over === 'function' ? await over() : over
    expectRejected(await register(owner.agent, await Authenticator.create(), overrides), reason)
  })

  it('rejects malformed credential JSON', async () => {
    const { challengeId } = await options(owner.agent)
    expectRejected(await owner.agent.post('/api/auth/passkey/register/verify', { challengeId, credential: { id: 'x', type: 'password' } }), /PublicKeyCredential JSON/)
  })
})

describe('passkey management', () => {
  it('renames and deletes a passkey while another sign-in method remains', async () => {
    const auth = await Authenticator.create()
    expect((await register(owner.agent, auth)).status).toBe(200)
    const renamed = await owner.agent.patch(`/api/me/passkeys/${auth.id}`, { name: 'Work phone' })
    expect(renamed.body.name).toBe('Work phone')
    expect((await owner.agent.del(`/api/me/passkeys/${auth.id}`)).status).toBe(204)
    const listed = await owner.agent.get('/api/me/passkeys')
    expect(listed.body.map((p: { id: string }) => p.id)).not.toContain(auth.id)
  })

  it("cannot touch someone else's passkey", async () => {
    const auth = await Authenticator.create()
    expect((await register(member.agent, auth)).status).toBe(200)
    expect((await owner.agent.del(`/api/me/passkeys/${auth.id}`)).status).toBe(404)
    expect((await owner.agent.patch(`/api/me/passkeys/${auth.id}`, { name: 'Mine now' })).status).toBe(404)
  })

  it('refuses API tokens for passkey changes', async () => {
    const pat = new Agent({ token: await createPat(member) })
    const r = await pat.del('/api/me/passkeys/anything')
    expect(r.status).toBe(403)
    expect(r.body.error.code).toBe('session_required')
  })
})
