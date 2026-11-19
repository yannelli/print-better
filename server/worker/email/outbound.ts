import { getSecret, loadInstance, outboundEnabled, type Instance } from '../services/instance-store'

export interface MailAttachment {
  filename: string
  contentType: string
  /** Text, e.g. a CSV. */
  content: string
}

export interface Mail {
  to: string[]
  subject: string
  text: string
  attachments?: MailAttachment[]
}

const base64 = (text: string): string => {
  let binary = ''
  for (const byte of new TextEncoder().encode(text)) binary += String.fromCharCode(byte)
  return btoa(binary)
}

/** Sends through Resend or the Cloudflare EMAIL binding; returns false when outbound email is off. */
export async function sendMail(env: Env, mail: Mail, inst?: Instance): Promise<boolean> {
  const instance = inst ?? (await loadInstance(env))
  const { provider, from } = instance.config.email
  if (!from || mail.to.length === 0 || !outboundEnabled(env, instance)) return false
  if (provider === 'cloudflare' && env.EMAIL) {
    const attachments = mail.attachments?.map((a) => ({ disposition: 'attachment' as const, filename: a.filename, type: a.contentType, content: a.content }))
    await env.EMAIL.send({ from, to: mail.to, subject: mail.subject, text: mail.text, ...(attachments && { attachments }) })
    return true
  }
  const key = await getSecret(env, 'email.apiKey')
  if (!key) return false
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from,
      to: mail.to,
      subject: mail.subject,
      text: mail.text,
      ...(mail.attachments && { attachments: mail.attachments.map((a) => ({ filename: a.filename, content_type: a.contentType, content: base64(a.content) })) }),
    }),
  })
  if (!res.ok) throw new Error(`Resend rejected the email: HTTP ${res.status} ${(await res.text()).slice(0, 200)}`)
  return true
}
