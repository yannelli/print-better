import { env } from 'cloudflare:workers'
import type { EnterpriseSettingsUpdate } from '../../shared/enterprise'
import { ok, wsPath } from './access'
import { connectPrinter } from './device'
import type { Agent, Body, Reply } from './http'
import { routeFetch } from './outbound'
import { switchExtension } from './usage'
import type { Owner } from './world'

/** Makes Enterprise controls available, turns it on in `ws`, then switches on the given parts. */
export async function turnOnEnterprise(owner: Owner, ws: string, parts: EnterpriseSettingsUpdate = {}): Promise<Body> {
  await switchExtension(owner, 'enterprise', ws, true)
  return Object.keys(parts).length > 0 ? setEnterprise(owner.agent, ws, parts) : null
}

export const setEnterprise = async (agent: Agent, ws: string, parts: EnterpriseSettingsUpdate): Promise<Body> =>
  ok(await agent.patch(wsPath(ws, '/enterprise'), parts), 'enterprise settings')

export const setControls = async (agent: Agent, ws: string, printerId: string, controls: { approval?: boolean; secureRelease?: boolean }): Promise<Body> =>
  ok(await agent.patch(wsPath(ws, `/printers/${printerId}/enterprise`), controls), 'printer controls')

let printers = 0
/** An added printer whose device is offline, so jobs wait in the queue instead of printing. */
export async function quietPrinter(owner: Owner, ws: string): Promise<string> {
  const s = await connectPrinter(owner, `usb:ent:${++printers}`, ws)
  s.device.close()
  return s.printerId
}

export const job = (agent: Agent, ws: string, printerId: string, extra: Body = {}): Promise<Reply> =>
  agent.post(wsPath(ws, '/jobs'), { printerId, text: 'Quarterly numbers', ...extra })

export const code = (r: Reply): [number, string | null] => [r.status, r.body?.error?.code ?? null]

export const auditOf = async (ws: string, action: string): Promise<{ target: string | null; data: string | null; actor_type: string }[]> =>
  (await env.DB.prepare('SELECT target, data, actor_type FROM audit_log WHERE workspace_id = ? AND action = ? ORDER BY id').bind(ws, action).all<{ target: string | null; data: string | null; actor_type: string }>()).results

export interface SentMail {
  to: string[]
  subject: string
  text: string
  attachments?: { filename: string; content_type: string; content: string }[]
}

/** Turns on outbound email through Resend and records what the Worker sends. */
export async function outbox(owner: Owner): Promise<SentMail[]> {
  ok(await owner.agent.patch('/api/admin/settings', { email: { provider: 'resend', from: 'Print Better <print@print.test>', apiKey: 're_test' } }), 'outbound email')
  const sent: SentMail[] = []
  routeFetch({
    'https://api.resend.com/emails': async (req) => {
      sent.push((await req.json()) as SentMail)
      return Response.json({ id: 'em_test' })
    },
  })
  return sent
}

/** Gives a user an email address, as a verified profile would. */
export const giveEmail = (userId: string, email: string) => env.DB.prepare('UPDATE users SET email = ?, email_verified = 1 WHERE id = ?').bind(email, userId).run()

export const heldUntil = (id: string, until: number) =>
  env.DB.prepare("UPDATE jobs SET held = json_set(held, '$.until', ?) WHERE id = ?").bind(until, id).run()
