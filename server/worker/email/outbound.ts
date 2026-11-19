import { getSecret, loadInstance, outboundEnabled, type Instance } from '../services/instance-store'

export interface Mail {
  to: string[]
  subject: string
  text: string
}

/** Sends through Resend or the Cloudflare EMAIL binding; returns false when outbound email is off. */
export async function sendMail(env: Env, mail: Mail, inst?: Instance): Promise<boolean> {
  const instance = inst ?? (await loadInstance(env))
  const { provider, from } = instance.config.email
  if (!from || mail.to.length === 0 || !outboundEnabled(env, instance)) return false
  if (provider === 'cloudflare' && env.EMAIL) {
    await env.EMAIL.send({ from, to: mail.to, subject: mail.subject, text: mail.text })
    return true
  }
  const key = await getSecret(env, 'email.apiKey')
  if (!key) return false
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from, to: mail.to, subject: mail.subject, text: mail.text }),
  })
  if (!res.ok) throw new Error(`Resend rejected the email: HTTP ${res.status} ${(await res.text()).slice(0, 200)}`)
  return true
}
