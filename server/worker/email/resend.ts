import { KB, MB, readBytes, readText } from '../http/body'
import { ApiError, badRequest, notFound, unauthorized } from '../http/errors'
import { putChallenge } from '../lib/challenges'
import { first } from '../lib/db'
import { DAY } from '../lib/time'
import { docType } from '../services/doc-types'
import { getSecret, loadInstance } from '../services/instance-store'
import { processInbound, type InboundAttachment, type InboundMail } from './inbound'
import { verifySvix } from './svix'

const API = 'https://api.resend.com'
const MAX_ATTACHMENT = 100 * MB

interface ReceivedEmail {
  from: string
  to: string[]
  subject: string | null
  text: string | null
  authentication: { dmarc?: string } | null
}

interface AttachmentList {
  data: { filename: string | null; content_type: string; content_disposition: string | null; size: number; download_url: string }[]
}

async function api<T>(apiKey: string, path: string): Promise<T> {
  const res = await fetch(`${API}${path}`, { headers: { Authorization: `Bearer ${apiKey}`, Accept: 'application/json' } })
  if (!res.ok) throw new Error(`Resend API ${path} failed: HTTP ${res.status}`)
  return (await res.json()) as T
}

/** The webhook carries metadata only, so body and attachments come from the Receiving API. */
async function fetchMail(apiKey: string, emailId: string): Promise<InboundMail> {
  const id = encodeURIComponent(emailId)
  const [email, list] = await Promise.all([
    api<ReceivedEmail>(apiKey, `/emails/receiving/${id}`),
    api<AttachmentList>(apiKey, `/emails/receiving/${id}/attachments?limit=100`),
  ])
  const attachments: InboundAttachment[] = []
  for (const a of list.data) {
    const inline = a.content_disposition === 'inline'
    if (inline || a.size > MAX_ATTACHMENT || !docType(a.content_type, a.filename)) continue
    const res = await fetch(a.download_url)
    if (!res.ok) continue
    attachments.push({ fileName: a.filename, contentType: a.content_type, data: await readBytes(res, MAX_ATTACHMENT), inline })
  }
  const from = /<([^>]+)>/.exec(email.from)?.[1] ?? email.from
  const dmarc = email.authentication ? (email.authentication.dmarc === 'pass' ? 'pass' : 'fail') : null
  return { from, to: email.to, subject: email.subject ?? '', text: email.text, attachments, dmarc }
}

/** `POST /api/hooks/resend`: Svix-verified, idempotent per delivery id (Svix retries until it gets a 2xx). */
export async function resendWebhook(env: Env, req: Request, waitUntil: (p: Promise<unknown>) => void): Promise<{ ok: true; accepted: number }> {
  const inst = await loadInstance(env)
  if (inst.config.email.inbound !== 'resend') throw notFound('Resend inbound email is not enabled', 'not_enabled')
  const [secret, apiKey] = await Promise.all([getSecret(env, 'email.webhookSecret'), getSecret(env, 'email.apiKey')])
  if (!secret || !apiKey) throw new ApiError(503, 'not_configured', 'Resend inbound email is not configured')
  const raw = await readText(req, 256 * KB)
  if (!(await verifySvix(secret, req.headers, raw))) throw unauthorized('Webhook signature is not valid', 'bad_signature')
  let event: { type?: string; data?: { email_id?: string } }
  try {
    event = JSON.parse(raw) as typeof event
  } catch {
    throw badRequest('Body must be JSON')
  }
  const emailId = event.data?.email_id
  if (event.type !== 'email.received' || typeof emailId !== 'string') return { ok: true, accepted: 0 }
  const delivery = `webhook:${req.headers.get('svix-id')}`
  if (await first(env.DB, 'SELECT 1 AS one FROM challenges WHERE id = ?', delivery)) return { ok: true, accepted: 0 }
  const result = await processInbound(env, await fetchMail(apiKey, emailId), 'resend', waitUntil)
  await putChallenge(env, delivery, 'webhook', null, { accepted: result.accepted }, DAY)
  if (result.rejected) console.warn('resend inbound rejected', result.rejected)
  return { ok: true, accepted: result.accepted }
}
