import { env } from 'cloudflare:workers'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { safeNext } from '../worker/services/sso'
import { b64url } from './helpers/authenticator'
import { Agent, parseSetCookie } from './helpers/http'
import { FakeIdp, loginError, redirectTarget, serve, ssoFlow, useIdp } from './helpers/oidc'
import { addMember, setupOwner, type Owner } from './helpers/world'

let owner: Owner
let idp: FakeIdp

beforeAll(async () => {
  owner = await setupOwner()
  idp = await FakeIdp.create()
})

afterEach(() => vi.restoreAllMocks())

const sha256b64url = async (s: string) => b64url(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s))))
const setSignup = async (signup: 'open' | 'invite') => expect((await owner.agent.patch('/api/admin/settings', { signup })).status).toBe(200)
const identityOf = (sub: string) => env.DB.prepare('SELECT user_id, email FROM identities WHERE provider = ? AND subject = ?').bind('oidc', sub).first()

async function invite(): Promise<string> {
  const r = await owner.agent.post(`/api/workspaces/${owner.workspaceId}/invites`, { role: 'member' })
  return new URL(r.body.url).pathname.split('/').pop() as string
}

describe('SSO configuration', () => {
  it('redirects to /login with sso_disabled before a provider is set up', async () => {
    for (const provider of ['oidc', 'google', 'github']) {
      expect(loginError(await new Agent().fetch(`/api/auth/sso/${provider}/start`))).toMatchObject({ path: '/login', error: 'sso_disabled' })
    }
  })

  it('refuses an issuer whose discovery fails, is incomplete, or names another issuer', async () => {
    const down = await FakeIdp.create()
    down.discoveryStatus = 500
    const incomplete = await FakeIdp.create()
    incomplete.metadataOverrides = { jwks_uri: undefined }
    const liar = await FakeIdp.create()
    liar.metadataOverrides = { issuer: 'https://someone-else.example' }
    serve(down, incomplete, liar)
    for (const bad of [down, incomplete, liar]) {
      const r = await owner.agent.patch('/api/admin/settings', { sso: { oidc: { enabled: true, issuer: bad.issuer, clientId: 'c', clientSecret: 's' } } })
      expect(r.status).toBe(400)
      expect(r.body.error.code).toBe('oidc_discovery_failed')
    }
    const http = await owner.agent.patch('/api/admin/settings', { sso: { oidc: { issuer: 'http://insecure.example' } } })
    expect(http.status).toBe(400)
  })

  it('lists the configured provider on the public instance info', async () => {
    await useIdp(owner.agent, idp)
    expect((await new Agent().get('/api/instance')).body.sso).toEqual([{ id: 'oidc', name: 'Acme SSO' }])
  })
})

describe('SSO sign-in', () => {
  it('starts with PKCE S256, a nonce, and a state bound to this browser by cookie', async () => {
    await useIdp(owner.agent, idp)
    const browser = new Agent()
    const start = await browser.fetch('/api/auth/sso/oidc/start?next=/printers')
    const target = redirectTarget(start)
    expect(`${target.origin}${target.pathname}`).toBe(`${idp.issuer}/authorize`)
    const q = target.searchParams
    expect(Object.fromEntries(q)).toMatchObject({
      response_type: 'code',
      client_id: idp.clientId,
      redirect_uri: 'https://print.test/api/auth/sso/oidc/callback',
      scope: 'openid email profile',
      code_challenge_method: 'S256',
    })
    expect(q.get('code_challenge')).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(q.get('nonce')).toMatch(/^[A-Za-z0-9_-]{22}$/)
    const cookie = parseSetCookie(start.headers.getSetCookie().find((c) => c.startsWith('pb_sso=')) ?? '')
    expect(cookie.value).toBe(q.get('state'))
    expect(cookie.attrs).toMatchObject({ path: '/api/auth/sso/', httponly: true, secure: true, samesite: 'Lax', 'max-age': '600' })
  })

  it('creates an account when sign-up is open, sending the PKCE verifier and client credentials', async () => {
    await useIdp(owner.agent, idp)
    await setSignup('open')
    const browser = new Agent()
    const { start, callback } = await ssoFlow(browser, idp, {
      next: '/printers?tab=queue',
      claims: { sub: 'alice-1', email: 'Alice@Example.com', email_verified: true, name: 'Alice Liddell' },
    })
    expect(redirectTarget(callback).href).toBe('https://print.test/printers?tab=queue')
    expect(browser.cookies.get('pb_session')).toMatch(/^pbs_/)
    expect(browser.cookies.has('pb_sso')).toBe(false)
    const { user } = (await browser.get('/api/auth/session')).body
    expect(user).toMatchObject({ username: 'alice', name: 'Alice Liddell', email: 'alice@example.com', emailVerified: true, hasPassword: false, isAdmin: false })
    expect(await identityOf('alice-1')).toEqual({ user_id: user.id, email: 'alice@example.com' })

    const call = idp.tokenCalls.at(-1)
    expect(call?.auth).toBe(`Basic ${btoa(`${idp.clientId}:${idp.clientSecret}`)}`)
    expect(call?.form.get('grant_type')).toBe('authorization_code')
    expect(call?.form.get('redirect_uri')).toBe('https://print.test/api/auth/sso/oidc/callback')
    const challenge = redirectTarget(start).searchParams.get('code_challenge')
    expect(await sha256b64url(call?.form.get('code_verifier') ?? '')).toBe(challenge)
    await setSignup('invite')
  })

  it('signs a known subject into its linked account even after its email changes', async () => {
    await useIdp(owner.agent, idp)
    const linked = (await identityOf('alice-1')) as { user_id: string }
    const browser = new Agent()
    const { callback } = await ssoFlow(browser, idp, { claims: { sub: 'alice-1', email: 'alice@new.example', email_verified: true } })
    expect(redirectTarget(callback).pathname).toBe('/')
    expect((await browser.get('/api/auth/session')).body.user.id).toBe(linked.user_id)
  })

  it('posts client credentials in the body when the provider only supports client_secret_post', async () => {
    const postOnly = await FakeIdp.create({ authMethods: ['client_secret_post'] })
    await useIdp(owner.agent, postOnly)
    const { callback } = await ssoFlow(new Agent(), postOnly, { claims: { sub: 'alice-1' } })
    expect(redirectTarget(callback).pathname).toBe('/')
    const call = postOnly.tokenCalls.at(-1)
    expect(call?.auth).toBeNull()
    expect(call?.form.get('client_id')).toBe(postOnly.clientId)
    expect(call?.form.get('client_secret')).toBe(postOnly.clientSecret)
  })

  it('accepts RS256 ID tokens', async () => {
    const rsa = await FakeIdp.create({ alg: 'RS256' })
    await useIdp(owner.agent, rsa)
    const browser = new Agent()
    const { callback } = await ssoFlow(browser, rsa, { claims: { sub: 'alice-1' } })
    expect(redirectTarget(callback).pathname).toBe('/')
    expect(browser.cookies.get('pb_session')).toMatch(/^pbs_/)
  })
})

describe('SSO account linking', () => {
  it('links to an existing account whose email is verified on both sides', async () => {
    await useIdp(owner.agent, idp)
    const bob = await addMember(owner)
    await env.DB.prepare('UPDATE users SET email = ?, email_verified = 1 WHERE id = ?').bind('bob@example.com', bob.user.id).run()
    const browser = new Agent()
    await ssoFlow(browser, idp, { claims: { sub: 'bob-1', email: 'BOB@example.com', email_verified: true } })
    expect((await browser.get('/api/auth/session')).body.user.id).toBe(bob.user.id)
    const audit = await env.DB.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'identity.link' AND target = ?").bind(bob.user.id).first<{ n: number }>()
    expect(audit?.n).toBe(1)
  })

  it('refuses to link to an account whose own email is unverified', async () => {
    await useIdp(owner.agent, idp)
    const carol = await addMember(owner)
    await env.DB.prepare('UPDATE users SET email = ? WHERE id = ?').bind('carol@example.com', carol.user.id).run()
    const { callback } = await ssoFlow(new Agent(), idp, { claims: { sub: 'carol-1', email: 'carol@example.com', email_verified: true } })
    expect(loginError(callback).error).toBe('sso_unverified_account')
    expect(await identityOf('carol-1')).toBeNull()
  })

  it('never links on an email the provider has not verified', async () => {
    await useIdp(owner.agent, idp)
    const { callback } = await ssoFlow(new Agent(), idp, { claims: { sub: 'mallory-1', email: 'bob@example.com', email_verified: false } })
    expect(loginError(callback).error).toBe('signup_closed')
    expect(await identityOf('mallory-1')).toBeNull()
  })

  it('lets a new person in only with an invite while sign-up is invite-only', async () => {
    await useIdp(owner.agent, idp)
    expect(loginError((await ssoFlow(new Agent(), idp, { claims: { sub: 'dave-1', name: 'Dave' } })).callback).error).toBe('signup_closed')
    const browser = new Agent()
    const { callback } = await ssoFlow(browser, idp, { invite: await invite(), claims: { sub: 'dave-1', name: 'Dave' } })
    expect(redirectTarget(callback).pathname).toBe('/')
    const session = (await browser.get('/api/auth/session')).body
    expect(session.user).toMatchObject({ name: 'Dave', email: null, emailVerified: false })
    expect(session.workspaces).toEqual([expect.objectContaining({ id: owner.workspaceId, role: 'member' })])
  })
})

describe('SSO redirects', () => {
  it.each([
    ['/printers?x=1#top', '/printers?x=1#top'],
    ['https://evil.example/', '/'],
    ['//evil.example/', '/'],
    ['/\\evil.example', '/'],
    ['javascript:alert(1)', '/'],
    ['', '/'],
    [`/${'a'.repeat(600)}`, '/'],
  ])('sanitizes next=%s to %s', (next, expected) => {
    expect(safeNext(next)).toBe(expected)
  })

  it('never sends the browser off-site after sign-in', async () => {
    await useIdp(owner.agent, idp)
    const { callback } = await ssoFlow(new Agent(), idp, { next: 'https://evil.example/phish', claims: { sub: 'alice-1' } })
    expect(callback.headers.get('Location')).toBe('/')
  })
})

describe('Google sign-in', () => {
  it('asks Google to show the account chooser and accepts its scheme-less issuer', async () => {
    const google = await FakeIdp.create({ issuer: 'https://accounts.google.com', clientId: 'google-client' })
    serve(google)
    const patch = await owner.agent.patch('/api/admin/settings', { signup: 'open', sso: { google: { enabled: true, clientId: 'google-client', clientSecret: google.clientSecret } } })
    expect(patch.status).toBe(200)
    expect((await new Agent().get('/api/instance')).body.sso).toContainEqual({ id: 'google', name: 'Google' })
    const browser = new Agent()
    const { start, callback } = await ssoFlow(browser, google, { provider: 'google', claims: { iss: 'accounts.google.com', sub: 'g-123', email: 'gina@gmail.com', email_verified: 'true' } })
    expect(redirectTarget(start).searchParams.get('prompt')).toBe('select_account')
    expect(redirectTarget(callback).pathname).toBe('/')
    expect((await browser.get('/api/auth/session')).body.user).toMatchObject({ email: 'gina@gmail.com', emailVerified: true })
    await setSignup('invite')
  })
})
