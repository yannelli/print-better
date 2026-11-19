import { env } from 'cloudflare:workers'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { verifySvix } from '../worker/email/svix'
import { setSecret } from '../worker/services/instance-store'
import { call, readReply } from './helpers/http'
import { emailWorld, expectOk, INBOUND_DOMAIN, newEmailJobs, PDF, RESEND_KEY, setUserEmail, svixHeaders, WEBHOOK_KEY, WEBHOOK_SECRET, type EmailWorld } from './helpers/mail'
import { routeFetch, type FetchHandler } from './helpers/outbound'
import { addMember } from './helpers/world'

const API = 'https://api.resend.com/emails/receiving'
const FILES = 'https://files.resend.test'

let w: EmailWorld

beforeAll(async () => {
  w = await emailWorld('resend')
  const member = await addMember(w.owner)
  await setUserEmail(member.user.id, 'member@home.example')
})

afterEach(() => vi.restoreAllMocks())

type Attachment = { filename: string | null; content_type: string; content_disposition: string | null; size: number; download_url: string }

/** Stubs the Resend Receiving API for one email id. */
function resendApi(id: string, email: Record<string, unknown>, attachments: Attachment[] = [], files: Record<string, FetchHandler> = {}) {
  const json = (body: unknown) => () => Response.json(body)
  return routeFetch({
    [`${API}/${id}`]: json({ from: 'Member <member@home.example>', to: [`office@${INBOUND_DOMAIN}`], subject: 'Report', text: 'see attached', authentication: { dmarc: 'pass' }, ...email }),
    [`${API}/${id}/attachments`]: json({ data: attachments }),
    ...files,
  })
}

const pdfAttachment = (name = 'report.pdf'): Attachment => ({ filename: name, content_type: 'application/pdf', content_disposition: 'attachment', size: PDF.byteLength, download_url: `${FILES}/${name}` })
const event = (emailId: string, type = 'email.received') => JSON.stringify({ type, created_at: '2026-11-18T10:00:00Z', data: { email_id: emailId } })

async function post(body: string, headers: Record<string, string>) {
  return readReply(await call('/api/hooks/resend', { method: 'POST', body, headers: { 'Content-Type': 'application/json', ...headers } }))
}

async function signedPost(body: string, id?: string) {
  return post(body, await svixHeaders(body, id))
}

describe('Resend inbound webhook', () => {
  it('fetches the received email and prints its attachment', async () => {
    const { seen } = resendApi('em_1', {}, [pdfAttachment()], { [`${FILES}/report.pdf`]: () => new Response(PDF) })
    let reply = { status: 0, body: null as unknown }
    const jobs = await newEmailJobs(async () => {
      reply = await signedPost(event('em_1'))
    })
    expect(reply).toMatchObject({ status: 200, body: { ok: true, accepted: 1 } })
    expect(jobs).toHaveLength(1)
    expect(jobs[0]).toMatchObject({ title: 'report.pdf', content_type: 'application/pdf', size: PDF.byteLength, printer_id: w.station.printerId })
    const apiCalls = seen.filter((r) => r.url.startsWith(API))
    expect(apiCalls.map((r) => r.headers.get('Authorization'))).toEqual([`Bearer ${RESEND_KEY}`, `Bearer ${RESEND_KEY}`])
    expect(apiCalls.some((r) => new URL(r.url).searchParams.get('limit') === '100')).toBe(true)
  })

  it('is idempotent per svix-id, so Svix retries do not print twice', async () => {
    resendApi('em_2', {}, [pdfAttachment()], { [`${FILES}/report.pdf`]: () => new Response(PDF) })
    const body = event('em_2')
    const first = await signedPost(body, 'msg_retry')
    const jobs = await newEmailJobs(async () => {
      const again = await signedPost(body, 'msg_retry')
      expect(again.body).toEqual({ ok: true, accepted: 0 })
    })
    expect(first.body.accepted).toBe(1)
    expect(jobs).toEqual([])
  })

  it('acknowledges other event types without calling the API', async () => {
    const { seen } = resendApi('em_3', {})
    const reply = await signedPost(event('em_3', 'email.delivered'))
    expect(reply.body).toEqual({ ok: true, accepted: 0 })
    expect(seen).toEqual([])
  })

  it('prints the body text when no attachment survives filtering', async () => {
    const attachments: Attachment[] = [
      { ...pdfAttachment('logo.pdf'), content_disposition: 'inline' },
      { ...pdfAttachment('huge.pdf'), size: 101 * 1024 * 1024 },
      { filename: 'notes.docx', content_type: 'application/msword', content_disposition: 'attachment', size: 10, download_url: `${FILES}/notes.docx` },
      pdfAttachment('gone.pdf'),
    ]
    const { seen } = resendApi('em_4', { text: 'Body instead' }, attachments, { [`${FILES}/gone.pdf`]: () => new Response('nope', { status: 404 }) })
    const jobs = await newEmailJobs(() => signedPost(event('em_4')))
    expect(jobs.map((j) => [j.content_type, j.title])).toEqual([['text/plain', 'Report']])
    expect(seen.filter((r) => r.url.startsWith(FILES)).map((r) => r.url)).toEqual([`${FILES}/gone.pdf`])
  })

  it('drops mail whose DMARC result is not pass', async () => {
    resendApi('em_5', { authentication: { dmarc: 'fail' } }, [pdfAttachment()], { [`${FILES}/report.pdf`]: () => new Response(PDF) })
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const jobs = await newEmailJobs(async () => {
      expect((await signedPost(event('em_5'))).body).toEqual({ ok: true, accepted: 0 })
    })
    expect(jobs).toEqual([])
  })

  it('fails with 500 when the Resend API is down, and a retry succeeds later', async () => {
    routeFetch({ [`${API}/em_6`]: () => new Response('down', { status: 503 }) })
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const body = event('em_6')
    expect((await signedPost(body, 'msg_down')).status).toBe(500)
    vi.restoreAllMocks()
    resendApi('em_6', {}, [pdfAttachment()], { [`${FILES}/report.pdf`]: () => new Response(PDF) })
    expect((await signedPost(body, 'msg_down')).body).toEqual({ ok: true, accepted: 1 })
  })

  it('rejects a valid signature over a body that is not JSON', async () => {
    expect((await signedPost('not json')).status).toBe(400)
  })
})

describe('Resend webhook signature (Svix)', () => {
  const body = event('em_sig')

  it('rejects a wrong key, a tampered body, and missing headers with 401 bad_signature', async () => {
    const wrongKey = await svixHeaders(body, 'msg_a', undefined, new TextEncoder().encode('another-signing-key-of-32-bytes!'))
    const tampered = await svixHeaders(body.replace('em_sig', 'em_other'), 'msg_b')
    for (const headers of [wrongKey, tampered, {}]) {
      const reply = await post(body, headers)
      expect(reply.status).toBe(401)
      expect(reply.body.error.code).toBe('bad_signature')
    }
  })

  it('rejects timestamps more than five minutes away', async () => {
    const now = Math.floor(Date.now() / 1000)
    for (const at of [now - 301, now + 301]) {
      expect((await post(body, await svixHeaders(body, `msg_${at}`, at))).status).toBe(401)
    }
  })

  it('accepts when any one of several v1 signatures matches', async () => {
    resendApi('em_sig', { text: 'hello' })
    const headers = await svixHeaders(body, 'msg_multi')
    headers['svix-signature'] = `v2,${headers['svix-signature'].slice(3)} v1,AAAA ${headers['svix-signature']}`
    expect((await post(body, headers)).status).toBe(200)
    // The same valid MAC labelled v2 must not count.
    headers['svix-signature'] = headers['svix-signature'].split(' ').slice(0, 2).join(' ')
    expect((await post(body, headers)).status).toBe(401)
  })

  it('verifies the tolerance edge and keys with or without the whsec_ prefix', async () => {
    const at = 1_800_000_000
    const headers = new Headers(await svixHeaders('{}', 'msg_edge', at))
    expect(await verifySvix(WEBHOOK_SECRET, headers, '{}', (at + 300) * 1000)).toBe(true)
    expect(await verifySvix(WEBHOOK_SECRET, headers, '{}', (at + 301) * 1000)).toBe(false)
    expect(await verifySvix(WEBHOOK_SECRET.slice(6), headers, '{}', at * 1000)).toBe(true)
    expect(await verifySvix('whsec_%%%not-base64%%%', headers, '{}', at * 1000)).toBe(false)
    expect(WEBHOOK_KEY.byteLength).toBe(32)
  })
})

describe('Resend webhook availability', () => {
  it('answers 404 not_enabled while inbound mail is not set to Resend', async () => {
    const setInbound = async (inbound: string) => expectOk(await w.owner.agent.patch('/api/admin/settings', { email: { inbound } }), 'inbound')
    await setInbound('cloudflare')
    try {
      const reply = await signedPost(event('em_x'))
      expect(reply.status).toBe(404)
      expect(reply.body.error.code).toBe('not_enabled')
    } finally {
      await setInbound('resend')
    }
  })

  it('answers 503 not_configured when the signing secret is missing', async () => {
    await setSecret(env, 'email.webhookSecret', null)
    try {
      const reply = await signedPost(event('em_y'))
      expect(reply.status).toBe(503)
      expect(reply.body.error.code).toBe('not_configured')
    } finally {
      await setSecret(env, 'email.webhookSecret', WEBHOOK_SECRET)
    }
  })
})
