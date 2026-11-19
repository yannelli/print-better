import { env } from 'cloudflare:workers'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { sha256Hex } from '../worker/lib/crypto'
import { Agent, ORIGIN } from './helpers/http'
import { routeFetch } from './helpers/outbound'
import { addMember, createPat, PASSWORD, setupOwner, type Owner, type Person } from './helpers/world'

const RESEND = 'https://api.resend.com/emails'
const SEND = '/api/me/email/verification'

interface SentMail {
  to: string[]
  subject: string
  text: string
}

let owner: Owner
let outbox: SentMail[]
let resendStatus: number

beforeAll(async () => {
  owner = await setupOwner()
})

afterEach(() => vi.restoreAllMocks())

/** Records every email the Worker hands to Resend; `resendStatus` lets a test make Resend fail. */
function stubResend(): void {
  outbox = []
  resendStatus = 200
  routeFetch({
    [RESEND]: async (req) => {
      outbox.push((await req.json()) as SentMail)
      return resendStatus === 200 ? Response.json({ id: 'em_test' }) : new Response('down', { status: resendStatus })
    },
  })
}

let people = 0
async function personWithEmail(verified = false): Promise<Person & { email: string }> {
  const person = await addMember(owner)
  people += 1
  const email = `reader${people}@example.com`
  await env.DB.prepare('UPDATE users SET email = ?, email_verified = ? WHERE id = ?').bind(email, verified ? 1 : 0, person.user.id).run()
  return { ...person, email }
}

const tokenIn = (mail: SentMail | undefined): string => {
  const m = /\/verify-email#token=(pbv_[a-z0-9]+)/.exec(mail?.text ?? '')
  if (!m) throw new Error(`no verification link in ${JSON.stringify(mail)}`)
  return m[1]
}

const verifiedFlag = async (userId: string) =>
  (await env.DB.prepare('SELECT email_verified FROM users WHERE id = ?').bind(userId).first<{ email_verified: number }>())?.email_verified

const verify = (agent: Agent, token: unknown) => agent.post('/api/auth/verify-email', { token })

/** Lets the next send through the 1-per-minute window without waiting a real minute. */
const skipMinute = (userId: string) => env.DB.prepare('DELETE FROM challenges WHERE id = ?').bind(`throttle:verify-email-minute:${userId}`).run()

describe('email verification without outbound email', () => {
  it('answers email_disabled so the page can explain it', async () => {
    const reader = await personWithEmail()
    const r = await reader.agent.post(SEND)
    expect(r.status).toBe(400)
    expect(r.body.error.code).toBe('email_disabled')
  })

  it('still saves email changes', async () => {
    const reader = await personWithEmail()
    expect((await reader.agent.patch('/api/me', { email: 'changed@example.com' })).status).toBe(200)
  })
})

describe('email verification', () => {
  beforeAll(async () => {
    stubResend()
    const r = await owner.agent.patch('/api/admin/settings', { email: { provider: 'resend', from: 'Print Better <print@print.test>', apiKey: 're_test' } })
    expect(r.status).toBe(200)
  })

  beforeEach(() => stubResend())

  it('emails a 24 hour link and stores only the token hash, bound to the address', async () => {
    const reader = await personWithEmail()
    const before = Date.now()
    const r = await reader.agent.post(SEND)
    expect(r.status).toBe(204)
    expect(outbox).toHaveLength(1)
    expect(outbox[0]).toMatchObject({ to: [reader.email], subject: 'Confirm your email for Print Better' })
    const token = tokenIn(outbox[0])
    expect(outbox[0].text).toContain(`${ORIGIN}/verify-email#token=${token}`)
    const rows = await env.DB.prepare("SELECT * FROM challenges WHERE kind = 'verify-email' AND user_id = ?").bind(reader.user.id).all<{ id: string; data: string; expires_at: number }>()
    expect(rows.results).toHaveLength(1)
    expect(rows.results[0].id).toBe(await sha256Hex(token))
    expect(JSON.parse(rows.results[0].data)).toEqual({ email: reader.email })
    expect(rows.results[0].expires_at - before).toBeGreaterThanOrEqual(24 * 3600_000)
    expect(rows.results[0].expires_at - Date.now()).toBeLessThanOrEqual(24 * 3600_000)
  })

  it('verifies the signed-in user once, returning the updated user', async () => {
    const reader = await personWithEmail()
    await reader.agent.post(SEND)
    const token = tokenIn(outbox[0])
    const r = await verify(reader.agent, token)
    expect(r.status).toBe(200)
    expect(r.body.user).toMatchObject({ id: reader.user.id, email: reader.email, emailVerified: true })
    expect(await verifiedFlag(reader.user.id)).toBe(1)
    const again = await verify(reader.agent, token)
    expect(again.status).toBe(400)
    expect(again.body.error.code).toBe('invalid_token')
  })

  it('works while signed out or signed in as someone else, without revealing the account', async () => {
    const reader = await personWithEmail()
    await reader.agent.post(SEND)
    const out = await verify(new Agent(), tokenIn(outbox[0]))
    expect(out).toMatchObject({ status: 200, body: {} })
    expect(await verifiedFlag(reader.user.id)).toBe(1)

    const other = await personWithEmail()
    await skipMinute(other.user.id)
    await other.agent.post(SEND)
    const cross = await verify(owner.agent, tokenIn(outbox.at(-1)))
    expect(cross).toMatchObject({ status: 200, body: {} })
    expect(await verifiedFlag(other.user.id)).toBe(1)
  })

  it('rejects a link once the email address has changed', async () => {
    const reader = await personWithEmail()
    await reader.agent.post(SEND)
    const token = tokenIn(outbox[0])
    expect((await reader.agent.patch('/api/me', { email: 'elsewhere@example.com' })).status).toBe(200)
    const r = await verify(reader.agent, token)
    expect(r.status).toBe(400)
    expect(r.body.error.code).toBe('invalid_token')
    expect(await verifiedFlag(reader.user.id)).toBe(0)
  })

  it('rejects expired, unknown and malformed tokens', async () => {
    const reader = await personWithEmail()
    await reader.agent.post(SEND)
    const token = tokenIn(outbox[0])
    await env.DB.prepare('UPDATE challenges SET expires_at = ? WHERE id = ?').bind(Date.now() - 1, await sha256Hex(token)).run()
    for (const bad of [token, 'pbv_nope', 'garbage']) {
      const r = await verify(new Agent(), bad)
      expect(r.status, bad).toBe(400)
      expect(r.body.error.code).toBe('invalid_token')
    }
    expect((await verify(new Agent(), undefined)).body.error.code).toBe('invalid_request')
    expect(await verifiedFlag(reader.user.id)).toBe(0)
  })

  it('allows one email per minute and five per hour per user', async () => {
    const reader = await personWithEmail()
    expect((await reader.agent.post(SEND)).status).toBe(204)
    const soon = await reader.agent.post(SEND)
    expect(soon.status).toBe(429)
    expect(soon.body.error).toMatchObject({ code: 'rate_limited', message: expect.stringContaining('Wait a minute') })
    for (let i = 0; i < 4; i++) {
      await skipMinute(reader.user.id)
      expect((await reader.agent.post(SEND)).status).toBe(204)
    }
    await skipMinute(reader.user.id)
    const hourly = await reader.agent.post(SEND)
    expect(hourly.status).toBe(429)
    expect(hourly.body.error.message).toContain('last hour')
    expect(outbox).toHaveLength(5)
  })

  it('refuses users with no email, verified users and API tokens', async () => {
    const plain = await addMember(owner)
    const none = await plain.agent.post(SEND)
    expect(none.status).toBe(400)
    expect(none.body.error.code).toBe('no_email')

    const done = await personWithEmail(true)
    const already = await done.agent.post(SEND)
    expect(already.status).toBe(409)
    expect(already.body.error.code).toBe('already_verified')

    const reader = await personWithEmail()
    const viaToken = await new Agent({ token: await createPat(reader) }).post(SEND)
    expect(viaToken.status).toBe(403)
    expect(viaToken.body.error.code).toBe('session_required')
    expect(outbox).toHaveLength(0)
  })

  it('reports a provider failure in plain words', async () => {
    const reader = await personWithEmail()
    resendStatus = 500
    const r = await reader.agent.post(SEND)
    expect(r.status).toBe(502)
    expect(r.body.error.code).toBe('email_failed')
  })
})

describe('automatic verification emails', () => {
  beforeEach(() => stubResend())

  async function invite(): Promise<string> {
    const r = await owner.agent.post(`/api/workspaces/${owner.workspaceId}/invites`, { role: 'member' })
    return new URL(r.body.url).pathname.split('/').pop() as string
  }

  it('sends one after sign-up with an email address, and none without', async () => {
    const r = await new Agent().post('/api/auth/register', { username: 'newreader', name: 'New', email: 'New@Example.com', password: PASSWORD, inviteToken: await invite() })
    expect(r.status).toBe(200)
    await vi.waitFor(() => expect(outbox).toHaveLength(1))
    expect(outbox[0].to).toEqual(['new@example.com'])
    expect((await verify(new Agent(), tokenIn(outbox[0]))).status).toBe(200)
    expect(await verifiedFlag(r.body.user.id)).toBe(1)

    await new Agent().post('/api/auth/register', { username: 'noemail', name: 'None', password: PASSWORD, inviteToken: await invite() })
    expect(outbox).toHaveLength(1)
  })

  it('sends one after an email change, and none for other profile edits', async () => {
    const reader = await personWithEmail()
    await reader.agent.patch('/api/me', { name: 'Renamed' })
    expect((await reader.agent.patch('/api/me', { email: 'moved@example.com' })).body.emailVerified).toBe(false)
    await vi.waitFor(() => expect(outbox).toHaveLength(1))
    expect(outbox[0].to).toEqual(['moved@example.com'])
    expect((await reader.agent.patch('/api/me', { email: null })).status).toBe(200)
    expect(outbox).toHaveLength(1)
  })

  it('never fails the request when the email cannot be sent', async () => {
    resendStatus = 500
    const r = await new Agent().post('/api/auth/register', { username: 'unlucky', name: 'Unlucky', email: 'unlucky@example.com', password: PASSWORD, inviteToken: await invite() })
    expect(r.status).toBe(200)
    await vi.waitFor(() => expect(outbox).toHaveLength(1))
    const reader = await personWithEmail()
    expect((await reader.agent.patch('/api/me', { email: 'bounce@example.com' })).status).toBe(200)
    await vi.waitFor(() => expect(outbox).toHaveLength(2))
  })
})
