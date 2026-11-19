import { env } from 'cloudflare:workers'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { Agent } from './helpers/http'
import { FakeIdp, redirectTarget, serve, ssoFlow } from './helpers/oidc'
import { addMember, createPat, setupOwner, type Owner, type Person } from './helpers/world'

let owner: Owner
let idp: FakeIdp
let google: FakeIdp
let subjects = 0

beforeAll(async () => {
  owner = await setupOwner()
  idp = await FakeIdp.create()
  google = await FakeIdp.create({ issuer: 'https://accounts.google.com', clientId: 'google-client' })
  serve(idp, google)
  const r = await owner.agent.patch('/api/admin/settings', {
    sso: {
      oidc: { enabled: true, name: 'Acme SSO', issuer: idp.issuer, clientId: idp.clientId, clientSecret: idp.clientSecret },
      google: { enabled: true, clientId: google.clientId, clientSecret: google.clientSecret },
    },
  })
  expect(r.status).toBe(200)
})

beforeEach(() => void serve(idp, google))
afterEach(() => vi.restoreAllMocks())

const nextSub = () => `linked-${++subjects}`
const providerIdp = (provider: string) => (provider === 'google' ? google : idp)

interface LinkOptions {
  provider?: 'oidc' | 'google'
  claims?: Record<string, unknown>
  /** Runs between the provider approval and the callback, e.g. to switch who is signed in. */
  before?: () => Promise<void> | void
  /** The browser that returns from the provider; defaults to the one that started. */
  finishIn?: Agent
}

/** `start?link=1` → provider approval → callback, returning where the callback sent the browser. */
async function link(person: Person, o: LinkOptions = {}): Promise<URL> {
  const provider = o.provider ?? 'oidc'
  const start = await person.agent.fetch(`/api/auth/sso/${provider}/start?link=1&next=/account/security`)
  const location = start.headers.get('Location') ?? ''
  if (start.status !== 302 || !location.startsWith(providerIdp(provider).issuer)) throw new Error(`start failed: ${start.status} ${location}`)
  const query = providerIdp(provider).approve(location, { sub: nextSub(), ...o.claims })
  await o.before?.()
  return redirectTarget(await (o.finishIn ?? person.agent).fetch(`/api/auth/sso/${provider}/callback?${query}`))
}

const identities = (userId: string) =>
  env.DB.prepare('SELECT provider, subject, email FROM identities WHERE user_id = ? ORDER BY created_at').bind(userId).all().then((r) => r.results)

const auditRows = (userId: string) =>
  env.DB.prepare("SELECT action, actor_type, actor_id, data FROM audit_log WHERE target = ? AND action LIKE 'identity.%' ORDER BY id").bind(userId).all().then((r) => r.results)

async function withEmail(person: Person, email: string, verified = false): Promise<void> {
  await env.DB.prepare('UPDATE users SET email = ?, email_verified = ? WHERE id = ?').bind(email, verified ? 1 : 0, person.user.id).run()
}

async function invite(): Promise<string> {
  const r = await owner.agent.post(`/api/workspaces/${owner.workspaceId}/invites`, { role: 'member' })
  return new URL(r.body.url).pathname.split('/').pop() as string
}

/** An account whose only way in is the generic OIDC provider. */
async function ssoOnlyPerson(): Promise<Person> {
  const agent = new Agent()
  await ssoFlow(agent, idp, { invite: await invite(), claims: { sub: nextSub(), name: 'Sam Sso' } })
  const user = (await agent.get('/api/auth/session')).body.user
  expect(user).toMatchObject({ hasPassword: false })
  return { agent, user }
}

describe('listing connected accounts', () => {
  it('shows the enabled providers and nothing connected yet', async () => {
    const person = await addMember(owner)
    const r = await person.agent.get('/api/me/identities')
    expect(r.status).toBe(200)
    expect(r.body).toEqual({
      identities: [],
      available: [
        { provider: 'google', providerName: 'Google' },
        { provider: 'oidc', providerName: 'Acme SSO' },
      ],
    })
  })
})

describe('connecting an account', () => {
  it('links the identity to the signed-in user, verifies a matching email, and audits it', async () => {
    const person = await addMember(owner)
    await withEmail(person, 'pat@example.com')
    const sessionBefore = person.agent.cookies.get('pb_session')
    const target = await link(person, { claims: { email: 'Pat@Example.com', email_verified: true } })
    expect(target.pathname).toBe('/account/security')
    expect(target.searchParams.has('error')).toBe(false)
    expect(person.agent.cookies.get('pb_session')).toBe(sessionBefore)
    expect(person.agent.cookies.has('pb_sso')).toBe(false)

    const listed = (await person.agent.get('/api/me/identities')).body.identities
    expect(listed).toEqual([{ provider: 'oidc', providerName: 'Acme SSO', email: 'pat@example.com', createdAt: expect.any(Number) }])
    expect((await person.agent.get('/api/auth/session')).body.user.emailVerified).toBe(true)
    expect(await auditRows(person.user.id)).toEqual([
      { action: 'identity.link', actor_type: 'user', actor_id: person.user.id, data: JSON.stringify({ provider: 'oidc' }) },
    ])
  })

  it('leaves the email unverified when the provider vouches for a different or unverified address', async () => {
    const person = await addMember(owner)
    await withEmail(person, 'quinn@example.com')
    expect((await link(person, { claims: { email: 'quinn@other.example', email_verified: true } })).searchParams.get('error')).toBeNull()
    expect((await link(person, { provider: 'google', claims: { email: 'quinn@example.com', email_verified: false } })).searchParams.get('error')).toBeNull()
    expect((await person.agent.get('/api/auth/session')).body.user.emailVerified).toBe(false)
    expect((await identities(person.user.id)).map((r) => r.provider)).toEqual(['oidc', 'google'])
  })

  it('then lets the person sign in with that account', async () => {
    const person = await addMember(owner)
    const sub = nextSub()
    await link(person, { provider: 'google', claims: { sub } })
    const browser = new Agent()
    await ssoFlow(browser, google, { provider: 'google', claims: { sub } })
    expect((await browser.get('/api/auth/session')).body.user.id).toBe(person.user.id)
  })

  it('refuses an identity that belongs to another account, in plain words', async () => {
    const first = await addMember(owner)
    const sub = nextSub()
    await link(first, { provider: 'google', claims: { sub } })
    const second = await addMember(owner)
    const target = await link(second, { provider: 'google', claims: { sub } })
    expect(target.pathname).toBe('/account/security')
    expect(target.searchParams.get('error')).toBe('identity_in_use')
    expect(target.searchParams.get('message')).toBe('That Google account is already connected to another Print Better account.')
    expect(await identities(second.user.id)).toEqual([])
    expect((await identities(first.user.id)).length).toBe(1)
  })

  it('refuses a second account from the same provider', async () => {
    const person = await addMember(owner)
    await link(person)
    const target = await link(person)
    expect(target.searchParams.get('error')).toBe('identity_exists')
    expect(await identities(person.user.id)).toHaveLength(1)
  })

  it('rejects a callback finished by a different signed-in user', async () => {
    const alice = await addMember(owner)
    const bob = await addMember(owner)
    const target = await link(alice, { before: () => void alice.agent.cookies.set('pb_session', bob.agent.cookies.get('pb_session') ?? '') })
    expect(target.searchParams.get('error')).toBe('sso_wrong_user')
    expect(await identities(alice.user.id)).toEqual([])
    expect(await identities(bob.user.id)).toEqual([])
  })

  it('rejects a callback after signing out, or in a browser that did not start it', async () => {
    const carol = await addMember(owner)
    const signedOut = await link(carol, { before: () => void carol.agent.cookies.delete('pb_session') })
    expect(signedOut.searchParams.get('error')).toBe('sso_wrong_user')

    const dave = await addMember(owner)
    const elsewhere = await link(dave, { finishIn: new Agent() })
    expect(elsewhere.pathname).toBe('/login')
    expect(elsewhere.searchParams.get('error')).toBe('sso_expired')
    expect(await identities(carol.user.id)).toEqual([])
    expect(await identities(dave.user.id)).toEqual([])
  })

  it('needs a signed-in browser session to start', async () => {
    const anonymous = redirectTarget(await new Agent().fetch('/api/auth/sso/oidc/start?link=1&next=/account/security'))
    expect(anonymous.pathname).toBe('/account/security')
    expect(anonymous.searchParams.get('error')).toBe('unauthorized')

    const person = await addMember(owner)
    const viaToken = redirectTarget(await new Agent({ token: await createPat(person) }).fetch('/api/auth/sso/oidc/start?link=1'))
    expect(viaToken.pathname).toBe('/account/security')
    expect(viaToken.searchParams.get('error')).toBe('session_required')
  })

  it('keeps the redirect on this site', async () => {
    const person = await addMember(owner)
    const r = await person.agent.fetch('/api/auth/sso/nope/start?link=1&next=https://evil.example/')
    expect(r.headers.get('Location')).toMatch(/^\/\?error=sso_disabled&/)
  })
})

describe('disconnecting an account', () => {
  it('unlinks and audits it', async () => {
    const person = await addMember(owner)
    await link(person, { provider: 'google' })
    expect((await person.agent.del('/api/me/identities/google')).status).toBe(204)
    expect(await identities(person.user.id)).toEqual([])
    expect((await auditRows(person.user.id)).map((r) => r.action)).toEqual(['identity.link', 'identity.unlink'])
    expect((await person.agent.del('/api/me/identities/google')).status).toBe(404)
  })

  it('refuses to remove the last way to sign in, but allows it once another exists', async () => {
    const person = await ssoOnlyPerson()
    const refused = await person.agent.del('/api/me/identities/oidc')
    expect(refused.status).toBe(409)
    expect(refused.body.error.code).toBe('last_sign_in_method')
    expect(await identities(person.user.id)).toHaveLength(1)

    await link(person, { provider: 'google' })
    expect((await person.agent.del('/api/me/identities/oidc')).status).toBe(204)
    const last = await person.agent.del('/api/me/identities/google')
    expect(last.body.error.code).toBe('last_sign_in_method')
  })

  it('needs a browser session', async () => {
    const person = await addMember(owner)
    await link(person)
    const api = new Agent({ token: await createPat(person) })
    expect((await api.get('/api/me/identities')).body.identities).toHaveLength(1)
    const r = await api.del('/api/me/identities/oidc')
    expect(r.status).toBe(403)
    expect(r.body.error.code).toBe('session_required')
  })
})
