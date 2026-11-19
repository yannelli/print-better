import type { Role } from '../../shared/types'
import { printerSettings, workspaceSettings } from '../db/map'
import type { PrinterViewRow } from '../db/rows'
import { MB } from '../http/body'
import { ApiError } from '../http/errors'
import { first } from '../lib/db'
import { utf8 } from '../lib/encoding'
import { systemCtx } from '../services/context'
import { docType } from '../services/doc-types'
import { loadInstance } from '../services/instance-store'
import { queueJob } from '../services/job-create'
import { accessFor } from '../services/permissions'

export interface InboundAttachment {
  fileName: string | null
  contentType: string
  data: Uint8Array
  /** Inline parts (logos, signatures) are never printed. */
  inline: boolean
}

export interface InboundMail {
  /** Header From address, which is what DMARC authenticates. */
  from: string
  to: string[]
  subject: string
  text: string | null
  attachments: InboundAttachment[]
  /** Verdict from a trusted source; null when the provider gave none. */
  dmarc: 'pass' | 'fail' | null
}

export interface InboundResult {
  accepted: number
  rejected: string | null
}

const MAX_DOCS = 10

function allowlisted(list: string[], sender: string): boolean {
  return list.some((entry) => (entry.startsWith('@') ? sender.endsWith(entry) : entry === sender))
}

function printable(mail: InboundMail, maxBytes: number) {
  const docs = mail.attachments
    .filter((a) => !a.inline && a.data.byteLength > 0 && a.data.byteLength <= maxBytes)
    .flatMap((a) => {
      const type = docType(a.contentType, a.fileName)
      return type ? [{ data: a.data, contentType: type, fileName: a.fileName }] : []
    })
    .slice(0, MAX_DOCS)
  if (docs.length > 0) return docs
  const body = mail.text?.trim()
  return body ? [{ data: utf8(body).slice(0, maxBytes), contentType: 'text/plain' as const, fileName: null }] : []
}

/** Recipient alias selects the printer; the sender must be a verified member email or on the workspace allowlist,
 *  and allowed to print there (a member as themselves, anyone else as Everyone). */
export async function processInbound(env: Env, mail: InboundMail, channel: 'cloudflare' | 'resend', waitUntil: (p: Promise<unknown>) => void): Promise<InboundResult> {
  const inst = await loadInstance(env)
  if (inst.config.email.inbound !== channel) return { accepted: 0, rejected: 'Email-to-print is not enabled on this server' }
  if (mail.dmarc === 'fail') return { accepted: 0, rejected: 'The sender could not be verified (DMARC)' }
  const sender = mail.from.trim().toLowerCase()
  const domain = inst.config.email.inboundDomain
  const ctx = systemCtx(env, '', waitUntil, { type: 'email', sender })
  let accepted = 0
  let reason = 'No printer accepts email at this address'
  for (const rcpt of new Set(mail.to.map((t) => t.trim().toLowerCase()))) {
    const at = rcpt.lastIndexOf('@')
    if (at < 1 || (domain && rcpt.slice(at + 1) !== domain)) continue
    const printer = await first<PrinterViewRow & { ws_settings: string }>(
      env.DB,
      `SELECT p.*, c.name AS client_name, c.online AS client_online, w.settings AS ws_settings
       FROM printers p JOIN clients c ON c.id = p.client_id JOIN workspaces w ON w.id = p.workspace_id
       WHERE p.email_alias = ?`,
      rcpt.slice(0, at),
    )
    if (!printer || printer.added !== 1 || !printerSettings(printer.settings).email.enabled) continue
    const settings = workspaceSettings(printer.ws_settings)
    if (!settings.emailToPrint.enabled) continue
    const member = settings.emailToPrint.allowMembers
      ? await first<{ id: string; role: Role }>(
          env.DB,
          'SELECT u.id, m.role FROM users u JOIN members m ON m.user_id = u.id WHERE m.workspace_id = ? AND u.email = ? AND u.email_verified = 1',
          printer.workspace_id,
          sender,
        )
      : null
    const access = await accessFor(ctx, printer.workspace_id, member ? { kind: 'member', userId: member.id, role: member.role } : { kind: 'everyone' })
    if ((!member && !allowlisted(settings.emailToPrint.allowlist, sender)) || !access.can(printer.id, 'print')) {
      reason = 'This sender is not allowed to print here'
      continue
    }
    const maxBytes = settings.maxUploadMb * MB
    const docs = printable(mail, maxBytes)
    if (docs.length === 0) {
      reason = 'The message has nothing printable'
      continue
    }
    for (const doc of docs) {
      try {
        await queueJob(ctx, {
          workspaceId: printer.workspace_id,
          printer,
          userId: member?.id ?? null,
          source: 'email',
          title: (doc.fileName ?? mail.subject) || 'Email',
          options: {},
          document: { kind: 'bytes', ...doc },
          maxBytes,
          access,
          role: member?.role ?? null,
        })
        accepted += 1
      } catch (e) {
        // Each attachment is checked as its own job; a refusal becomes the rejection reason.
        if (!(e instanceof ApiError) || e.code !== 'policy_blocked') throw e
        reason = e.message
      }
    }
  }
  return { accepted, rejected: accepted > 0 ? null : reason }
}
