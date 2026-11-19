import { env } from 'cloudflare:workers'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { AT, Authenticator, BE, BS, UP, UV, userHandleFor, type AssertOverrides } from './helpers/authenticator'
import { Agent, type Reply } from './helpers/http'
import { addMember, setupOwner, type Owner, type Person } from './helpers/world'

let owner: Owner
let member: Person
let ownerKey: Authenticator
let memberKey: Authenticator

afterEach(() => vi.restoreAllMocks())

async function enroll(person: Person): Promise<Authenticator> {
  const auth = await Authenticator.create()
  const { body } = await person.agent.post('/api/auth/passkey/register/options')
  const r = await person.agent.post('/api/auth/passkey/register/verify', { challengeId: body.challengeId, credential: await auth.register(body.options) })
  expect(r.status).toBe(200)
  return auth
}

beforeAll(async () => {
  owner = await setupOwner()
  member = await addMember(owner)
  ownerKey = await enroll(owner)
  memberKey = await enroll(member)
})

async function loginOptions(browser: Agent, login?: string) {
  const r = await browser.post('/api/auth/passkey/login/options', login === undefined ? {} : { login })
  expect(r.status).toBe(200)
  return r.body as { challengeId: string; options: { challenge: string; rpId: string; allowCredentials: unknown[] } & Record<string, unknown> }
}

/** One full sign-in ceremony in a fresh browser. */
async function signIn(auth: Authenticator, over: AssertOverrides = {}, browser = new Agent()): Promise<Reply> {
  const { challengeId, options } = await loginOptions(browser)
  return browser.post('/api/auth/passkey/login/verify', { challengeId, credential: await auth.assert(options, over) })
}

const storedCount = async (id: string) =>
  (await env.DB.prepare('SELECT sign_count FROM passkeys WHERE id = ?').bind(id).first<{ sign_count: number }>())?.sign_count

describe('passkey sign-in options', () => {
  it('allow any discoverable credential when no account is named', async () => {
    const { options } = await loginOptions(new Agent())
    expect(options).toMatchObject({ rpId: 'print.test', userVerification: 'required', allowCredentials: [] })
    expect(options.challenge).toMatch(/^[A-Za-z0-9_-]{43}$/)
  })

  it("list the named account's passkeys, by username or email", async () => {
    const { options } = await loginOptions(new Agent(), 'OWNER')
    expect(options.allowCredentials).toEqual([{ type: 'public-key', id: ownerKey.id, transports: ['internal', 'hybrid'] }])
    expect((await loginOptions(new Agent(), 'nobody-here')).options.allowCredentials).toEqual([])
  })
})

describe('passkey sign-in', () => {
  it('signs in with a discoverable passkey and starts a session', async () => {
    const browser = new Agent()
    const r = await signIn(memberKey, {}, browser)
    expect(r.status).toBe(200)
    expect(r.body.user.id).toBe(member.user.id)
    expect(browser.cookies.get('pb_session')).toMatch(/^pbs_/)
    expect((await browser.get('/api/auth/session')).body.user.id).toBe(member.user.id)
    const row = await env.DB.prepare('SELECT last_used_at FROM passkeys WHERE id = ?').bind(memberKey.id).first<{ last_used_at: number }>()
    expect(row?.last_used_at).toBeGreaterThan(0)
  })

  it('keeps the highest sign counter it has seen', async () => {
    expect((await signIn(ownerKey, { signCount: 7 })).status).toBe(200)
    expect(await storedCount(ownerKey.id)).toBe(7)
    expect((await signIn(ownerKey, { signCount: 9 })).status).toBe(200)
    expect(await storedCount(ownerKey.id)).toBe(9)
  })

  it('flags a counter that did not increase (possible clone) without lowering it', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const r = await signIn(ownerKey, { signCount: 3 })
    expect(r.status).toBe(200)
    expect(warn).toHaveBeenCalledWith('passkey sign counter did not increase', ownerKey.id)
    expect(await storedCount(ownerKey.id)).toBe(9)
  })

  it('accepts synced passkeys whose counter is always zero, without flagging them', async () => {
    const synced = await Authenticator.create()
    const { body } = await owner.agent.post('/api/auth/passkey/register/options')
    await owner.agent.post('/api/auth/passkey/register/verify', { challengeId: body.challengeId, credential: await synced.register(body.options, { flags: UP | UV | AT | BE | BS }) })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect((await signIn(synced, { signCount: 0, flags: UP | UV | BE | BS })).status).toBe(200)
    expect((await signIn(synced, { signCount: 0, flags: UP | UV | BE | BS })).status).toBe(200)
    expect(warn).not.toHaveBeenCalled()
    expect(await storedCount(synced.id)).toBe(0)
  })

  it('rejects a passkey this server does not know', async () => {
    const r = await signIn(await Authenticator.create())
    expect(r.status).toBe(401)
    expect(r.body.error.code).toBe('passkey_unknown')
  })

  it('rejects a user handle that belongs to another account', async () => {
    const r = await signIn(memberKey, { userHandle: userHandleFor(owner.user.id) })
    expect(r.status).toBe(401)
    expect(r.body.error.code).toBe('passkey_invalid')
  })

  it('accepts an assertion without a user handle (non-discoverable flow)', async () => {
    const browser = new Agent()
    const { challengeId, options } = await loginOptions(browser, 'owner')
    const r = await browser.post('/api/auth/passkey/login/verify', { challengeId, credential: await ownerKey.assert(options, { userHandle: null }) })
    expect(r.status).toBe(200)
    expect(r.body.user.id).toBe(owner.user.id)
  })

  it.each<[string, AssertOverrides, RegExp]>([
    ['a forged signature', { tamper: true }, /signature is not valid/],
    ['no user verification', { flags: UP }, /user verification is missing/],
    ['no user presence', { flags: UV }, /user presence is missing/],
    ['another origin', { origin: 'https://evil.test' }, /origin mismatch/],
    ['another RP ID', { rpId: 'evil.test' }, /RP ID mismatch/],
    ['a different challenge', { challenge: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' }, /challenge mismatch/],
    ['the registration ceremony type', { type: 'webauthn.create' }, /wrong ceremony type/],
    ['a cross-origin iframe', { crossOrigin: true }, /cross-origin/],
  ])('rejects %s', async (_, over, reason) => {
    const browser = new Agent()
    const r = await signIn(memberKey, over, browser)
    expect(r.status).toBe(400)
    expect(r.body.error.code).toBe('passkey_invalid')
    expect(r.body.error.message).toMatch(reason)
    expect(browser.cookies.has('pb_session')).toBe(false)
  })

  it('consumes each sign-in challenge exactly once', async () => {
    const browser = new Agent()
    const { challengeId, options } = await loginOptions(browser)
    const credential = await memberKey.assert(options)
    expect((await browser.post('/api/auth/passkey/login/verify', { challengeId, credential })).status).toBe(200)
    const replay = await new Agent().post('/api/auth/passkey/login/verify', { challengeId, credential })
    expect(replay.status).toBe(400)
    expect(replay.body.error.code).toBe('challenge_expired')
  })

  it('does not accept a registration challenge', async () => {
    const { body } = await member.agent.post('/api/auth/passkey/register/options')
    const credential = await memberKey.assert({ challenge: body.options.challenge, rpId: 'print.test' })
    const r = await new Agent().post('/api/auth/passkey/login/verify', { challengeId: body.challengeId, credential })
    expect(r.status).toBe(400)
    expect(r.body.error.code).toBe('challenge_expired')
  })

  it('rejects an expired challenge', async () => {
    const browser = new Agent()
    const { challengeId, options } = await loginOptions(browser)
    await env.DB.prepare('UPDATE challenges SET expires_at = ? WHERE id = ?').bind(Date.now() - 1, challengeId).run()
    const r = await browser.post('/api/auth/passkey/login/verify', { challengeId, credential: await memberKey.assert(options) })
    expect(r.status).toBe(400)
    expect(r.body.error.code).toBe('challenge_expired')
  })
})
