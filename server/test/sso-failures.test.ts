import { env } from 'cloudflare:workers'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { Agent } from './helpers/http'
import { FakeIdp, loginError, redirectTarget, serve, ssoFlow, useIdp } from './helpers/oidc'
import { setupOwner, type Owner } from './helpers/world'

let owner: Owner
let idp: FakeIdp
let strict: FakeIdp

beforeAll(async () => {
  owner = await setupOwner()
  idp = await FakeIdp.create()
  strict = await FakeIdp.create({ issParam: true })
  await useIdp(owner.agent, idp)
  expect((await owner.agent.patch('/api/admin/settings', { signup: 'open' })).status).toBe(200)
})

beforeEach(() => {
  serve(idp, strict)
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.useRealTimers()
  idp.tokenError = null
  idp.tokenHeader = {}
  idp.mangle = null
})

const callback = (browser: Agent, query: URLSearchParams, provider = 'oidc') => browser.fetch(`/api/auth/sso/${provider}/callback?${query}`)

async function started(browser = new Agent()): Promise<{ browser: Agent; query: URLSearchParams }> {
  const start = await browser.fetch('/api/auth/sso/oidc/start')
  return { browser, query: idp.approve(redirectTarget(start).href, { sub: 'state-tester' }) }
}

describe('SSO state binding', () => {
  it('requires the state cookie set in the browser that started', async () => {
    const { query } = await started()
    expect(loginError(await callback(new Agent(), query))).toMatchObject({ path: '/login', error: 'sso_expired' })
  })

  it("rejects a state that is not this browser's current one", async () => {
    const browser = new Agent()
    const first = await started(browser)
    await started(browser)
    expect(loginError(await callback(browser, first.query)).error).toBe('sso_expired')
  })

  it('rejects a forged state even when the cookie agrees with it', async () => {
    const browser = new Agent()
    browser.cookies.set('pb_sso', 'forged-state')
    expect(loginError(await callback(browser, new URLSearchParams({ state: 'forged-state', code: 'x' }))).error).toBe('sso_expired')
  })

  it('consumes the state once', async () => {
    const browser = new Agent()
    const { callback: first, query } = await ssoFlow(browser, idp, { claims: { sub: 'once-1' } })
    expect(redirectTarget(first).pathname).toBe('/')
    browser.cookies.set('pb_sso', query.get('state') ?? '')
    expect(loginError(await callback(browser, query)).error).toBe('sso_expired')
  })

  it('ties the state to the provider that started it', async () => {
    const { browser, query } = await started()
    expect(loginError(await callback(browser, query, 'google')).error).toBe('sso_expired')
  })

  it('expires the state after its lifetime', async () => {
    const { browser, query } = await started()
    await env.DB.prepare("UPDATE challenges SET expires_at = ? WHERE kind = 'oidc'").bind(Date.now() - 1).run()
    expect(loginError(await callback(browser, query)).error).toBe('sso_expired')
  })
})

describe('SSO authorization response', () => {
  it("passes the provider's error through as sso_<error>", async () => {
    const { callback: res } = await ssoFlow(new Agent(), idp, {
      edit: (q) => {
        q.delete('code')
        q.set('error', 'access_denied')
        q.set('error_description', 'The user cancelled')
      },
    })
    expect(loginError(res)).toMatchObject({ error: 'sso_access_denied', message: 'The user cancelled' })
  })

  it('requires an authorization code', async () => {
    const { callback: res } = await ssoFlow(new Agent(), idp, { edit: (q) => q.delete('code') })
    expect(loginError(res).error).toBe('sso_failed')
  })

  it('surfaces a token endpoint rejection', async () => {
    idp.tokenError = { error: 'invalid_grant', error_description: 'Authorization code expired' }
    const browser = new Agent()
    const { callback: res } = await ssoFlow(browser, idp)
    expect(loginError(res)).toMatchObject({ error: 'sso_failed', message: 'Authorization code expired' })
    expect(browser.cookies.has('pb_session')).toBe(false)
  })

  it('rejects an iss parameter from another issuer (RFC 9207)', async () => {
    const { callback: res } = await ssoFlow(new Agent(), idp, { claims: { sub: 'iss-1' }, edit: (q) => q.set('iss', 'https://evil.example') })
    expect(loginError(res).error).toBe('sso_failed')
  })
})

describe('SSO with a provider that sends iss (RFC 9207)', () => {
  beforeAll(async () => {
    await useIdp(owner.agent, strict)
  })
  afterAll(async () => {
    await useIdp(owner.agent, idp)
  })

  it('accepts the matching iss', async () => {
    const { callback: res } = await ssoFlow(new Agent(), strict, { claims: { sub: 'strict-1' } })
    expect(redirectTarget(res).pathname).toBe('/')
  })

  it.each([
    ['missing', (q: URLSearchParams) => q.delete('iss')],
    ['wrong', (q: URLSearchParams) => q.set('iss', 'https://evil.example')],
  ])('rejects a %s iss', async (_, edit) => {
    const { callback: res } = await ssoFlow(new Agent(), strict, { claims: { sub: 'strict-1' }, edit })
    expect(loginError(res).error).toBe('sso_failed')
  })
})

describe('ID token validation', () => {
  const now = () => Math.floor(Date.now() / 1000)

  it.each<[string, () => Record<string, unknown>, RegExp]>([
    ['a nonce from another request', () => ({ nonce: 'replayed-nonce' }), /nonce mismatch/],
    ['no nonce', () => ({ nonce: undefined }), /nonce mismatch/],
    ['another issuer', () => ({ iss: 'https://evil.example' }), /wrong issuer/],
    ['another audience', () => ({ aud: 'someone-else' }), /wrong audience/],
    ['an extra audience without azp', () => ({ aud: ['print-better', 'other-app'] }), /wrong authorized party/],
    ['a foreign authorized party', () => ({ azp: 'other-app' }), /wrong authorized party/],
    ['an expired token', () => ({ exp: now() - 120 }), /expired/],
    ['a token issued in the future', () => ({ iat: now() + 3600 }), /issued in the future/],
    ['an empty subject', () => ({ sub: '' }), /missing subject/],
  ])('rejects %s', async (_, claims, reason) => {
    const browser = new Agent()
    const { callback: res } = await ssoFlow(browser, idp, { claims: { sub: 'claims-1', ...claims() } })
    const { error, message } = loginError(res)
    expect(error).toBe('sso_invalid_token')
    expect(message).toMatch(reason)
    expect(browser.cookies.has('pb_session')).toBe(false)
  })

  it('allows 60 seconds of clock skew on exp', async () => {
    const { callback: res } = await ssoFlow(new Agent(), idp, { claims: { sub: 'skew-1', exp: now() - 30 } })
    expect(redirectTarget(res).pathname).toBe('/')
  })

  it.each<[string, (p: FakeIdp) => void, RegExp]>([
    ['a forged signature', (p) => (p.mangle = (jwt) => `${jwt.slice(0, -8)}${jwt.at(-8) === 'A' ? 'B' : 'A'}${jwt.slice(-7)}`), /bad signature/],
    ['a key id missing from the JWKS', (p) => (p.tokenHeader = { kid: 'rotated-away' }), /signing key not found/],
    ['alg "none"', (p) => (p.tokenHeader = { alg: 'none' }), /unsupported algorithm/],
    ['an HMAC algorithm', (p) => (p.tokenHeader = { alg: 'HS256' }), /unsupported algorithm/],
    ['a token that is not a JWS', (p) => (p.mangle = (jwt) => jwt.split('.').slice(0, 2).join('.')), /malformed token/],
  ])('rejects %s', async (_, tamper, reason) => {
    tamper(idp)
    const { callback: res } = await ssoFlow(new Agent(), idp, { claims: { sub: 'sig-1' } })
    const { error, message } = loginError(res)
    expect(error).toBe('sso_invalid_token')
    expect(message).toMatch(reason)
  })
})

describe('SSO discovery outages', () => {
  it('sends people back to /login when discovery fails after the cache expires', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(Date.now() + 2 * 60 * 60 * 1000)
    idp.discoveryStatus = 503
    try {
      expect(loginError(await new Agent().fetch('/api/auth/sso/oidc/start')).error).toBe('oidc_discovery_failed')
    } finally {
      idp.discoveryStatus = 200
    }
  })
})
