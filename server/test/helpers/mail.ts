import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test'
import { env } from 'cloudflare:workers'
import worker from '../../worker/index'
import { connectPrinter, type Station } from './device'
import type { Reply } from './http'
import { setupOwner, type Owner } from './world'

export const INBOUND_DOMAIN = 'print.example.com'
export const RESEND_KEY = 're_test_key'
/** Svix keys are base64 behind a `whsec_` prefix. */
export const WEBHOOK_KEY = new TextEncoder().encode('test-webhook-signing-key-32bytes')
export const WEBHOOK_SECRET = `whsec_${btoa(String.fromCharCode(...WEBHOOK_KEY))}`
export const CF_PASS = 'mx.cloudflare.net; dkim=pass header.d=example.com; spf=pass smtp.mailfrom=example.com; dmarc=pass header.from=example.com'

export interface Part {
  contentType: string
  data: Uint8Array | string
  fileName?: string
  inline?: boolean
}

export interface MailSpec {
  from: string
  to: string
  subject?: string
  text?: string
  parts?: Part[]
  /** Authentication-Results values, topmost first; defaults to Cloudflare's dmarc=pass. */
  auth?: string[]
}

const CRLF = '\r\n'

function base64(data: Uint8Array | string): string {
  const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data
  let s = ''
  for (const b of bytes) s += String.fromCharCode(b)
  return btoa(s).replace(/.{1,76}/g, `$&${CRLF}`).trimEnd()
}

/** A real RFC 5322 message: plain text alone, or multipart/mixed with base64 parts. */
export function mime(spec: MailSpec): string {
  const head = [
    ...(spec.auth ?? [CF_PASS]).map((a) => `Authentication-Results: ${a}`),
    `From: ${spec.from}`,
    `To: ${spec.to}`,
    `Subject: ${spec.subject ?? 'Please print'}`,
    'Date: Wed, 18 Nov 2026 10:00:00 +0000',
    `Message-ID: <${crypto.randomUUID()}@mail.test>`,
    'MIME-Version: 1.0',
  ]
  const parts = spec.parts ?? []
  if (parts.length === 0) return [...head, 'Content-Type: text/plain; charset=utf-8', '', spec.text ?? ''].join(CRLF)
  const boundary = `b-${crypto.randomUUID()}`
  const body = [`Content-Type: multipart/mixed; boundary="${boundary}"`, '']
  if (spec.text !== undefined) body.push(`--${boundary}`, 'Content-Type: text/plain; charset=utf-8', '', spec.text)
  for (const p of parts) {
    const name = p.fileName ? `; filename="${p.fileName}"` : ''
    body.push(
      `--${boundary}`,
      `Content-Type: ${p.contentType}${p.fileName ? `; name="${p.fileName}"` : ''}`,
      'Content-Transfer-Encoding: base64',
      `Content-Disposition: ${p.inline ? 'inline' : 'attachment'}${name}`,
      ...(p.inline ? ['Content-ID: <logo@mail.test>'] : []),
      '',
      base64(p.data),
    )
  }
  body.push(`--${boundary}--`, '')
  return [...head, ...body].join(CRLF)
}

/** Delivers through the Worker's `email()` handler; returns the setReject reason, or null when accepted. */
export async function deliver(spec: MailSpec, envelopeFrom = /<([^>]+)>/.exec(spec.from)?.[1] ?? spec.from): Promise<string | null> {
  const raw = mime(spec)
  const rejected: string[] = []
  const message = {
    from: envelopeFrom,
    to: spec.to,
    headers: new Headers(),
    raw: new Response(raw).body,
    rawSize: raw.length,
    setReject: (reason: string) => void rejected.push(reason),
    forward: async () => {},
    reply: async () => {},
  }
  const ctx = createExecutionContext()
  await worker.email(message as unknown as ForwardableEmailMessage, env, ctx)
  await waitOnExecutionContext(ctx)
  return rejected[0] ?? null
}

export interface EmailJob {
  id: string
  printer_id: string
  user_id: string | null
  source: string
  title: string
  file_name: string | null
  content_type: string
  size: number
  status: string
  file_key: string | null
}

/** Runs `act` and returns the email jobs it created, oldest first. */
export async function newEmailJobs(act: () => Promise<unknown>): Promise<EmailJob[]> {
  const ids = async () => new Set((await env.DB.prepare("SELECT id FROM jobs WHERE source = 'email'").all<{ id: string }>()).results.map((r) => r.id))
  const before = await ids()
  await act()
  const rows = await env.DB.prepare("SELECT * FROM jobs WHERE source = 'email' ORDER BY created_at, rowid").all<EmailJob>()
  return rows.results.filter((r) => !before.has(r.id))
}

export async function svixHeaders(body: string, id = `msg_${crypto.randomUUID()}`, at = Math.floor(Date.now() / 1000), key = WEBHOOK_KEY): Promise<Record<string, string>> {
  const k = await crypto.subtle.importKey('raw', key, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', k, new TextEncoder().encode(`${id}.${at}.${body}`)))
  return { 'svix-id': id, 'svix-timestamp': String(at), 'svix-signature': `v1,${btoa(String.fromCharCode(...mac))}` }
}

export function expectOk(reply: Reply, what: string): Reply {
  if (reply.status >= 300) throw new Error(`${what}: ${reply.status} ${JSON.stringify(reply.body)}`)
  return reply
}

export interface EmailWorld {
  owner: Owner
  station: Station
}

/** Owner + one added printer aliased `office`, email-to-print on for members and two allowlist entries. */
export async function emailWorld(channel: 'cloudflare' | 'resend' = 'cloudflare'): Promise<EmailWorld> {
  const owner = await setupOwner()
  const station = await connectPrinter(owner)
  station.device.close()
  const secrets = channel === 'resend' ? { apiKey: RESEND_KEY, webhookSecret: WEBHOOK_SECRET } : {}
  expectOk(await owner.agent.patch('/api/admin/settings', { email: { inbound: channel, inboundDomain: INBOUND_DOMAIN, ...secrets } }), 'instance email')
  const emailToPrint = { enabled: true, allowMembers: true, allowlist: ['Boss@Corp.example', '@partner.example'] }
  expectOk(await owner.agent.patch(`/api/workspaces/${owner.workspaceId}`, { settings: { emailToPrint } }), 'workspace email')
  await setPrinterEmail(owner, station.printerId, { enabled: true, alias: 'Office' })
  return { owner, station }
}

export async function setPrinterEmail(owner: Owner, printerId: string, email: { enabled?: boolean; alias?: string | null }): Promise<void> {
  expectOk(await owner.agent.patch(`/api/workspaces/${owner.workspaceId}/printers/${printerId}`, { settings: { email } }), 'printer email')
}

/** Gives a user a verified (or unverified) email address directly, as the reset/SSO flows would. */
export async function setUserEmail(userId: string, email: string, verified = true): Promise<void> {
  await env.DB.prepare('UPDATE users SET email = ?, email_verified = ? WHERE id = ?').bind(email, verified ? 1 : 0, userId).run()
}

export const PDF = new TextEncoder().encode('%PDF-1.4\n1 0 obj << /Type /Catalog >> endobj\ntrailer << /Root 1 0 R >>\n%%EOF\n')
export const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52])
export const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 16, 0x4a, 0x46, 0x49, 0x46, 0, 1, 0xff, 0xd9])
