import type { Role, User } from '../../shared/types'
import { Agent, call, nextIp, readReply } from './http'

export const SETUP_TOKEN = 'test-setup-token'
export const PASSWORD = 'correct horse battery staple'

export interface Person {
  agent: Agent
  user: User
}

export interface Owner extends Person {
  workspaceId: string
}

function ok<T extends { status: number; body: unknown }>(reply: T, what: string): T {
  if (reply.status >= 300) throw new Error(`${what} failed: ${reply.status} ${JSON.stringify(reply.body)}`)
  return reply
}

/** First-run setup: the instance admin, owner of workspace "Home", signed in. */
export async function setupOwner(username = 'owner'): Promise<Owner> {
  const agent = new Agent()
  const r = ok(await agent.post('/api/auth/setup', { setupToken: SETUP_TOKEN, username, name: 'Olive Owner', password: PASSWORD, workspaceName: 'Home' }), 'setup')
  const session = ok(await agent.get('/api/auth/session'), 'session')
  return { agent, user: r.body.user, workspaceId: session.body.workspaces[0].id }
}

let people = 0

/** Invites a new account into the workspace with `role` and signs it in. */
export async function addMember(owner: Owner, role: Role = 'member', workspaceId = owner.workspaceId): Promise<Person> {
  const invite = ok(await owner.agent.post(`/api/workspaces/${workspaceId}/invites`, { role }), 'invite')
  const inviteToken = new URL(invite.body.url).pathname.split('/').pop()
  people += 1
  const agent = new Agent()
  const r = ok(await agent.post('/api/auth/register', { username: `person${people}`, name: `Person ${people}`, password: PASSWORD, inviteToken }), 'register')
  return { agent, user: r.body.user }
}

/** A personal API token (`pbt_`) for `person`, optionally pinned to a workspace. */
export async function createPat(person: Person, workspaceId?: string): Promise<string> {
  const r = ok(await person.agent.post('/api/me/tokens', { name: 'test token', workspaceId }), 'create token')
  return r.body.token
}

export const DEVICE_INFO = { hostname: 'office-pi', os: 'linux', arch: 'aarch64', version: '0.1.0' }

/** Mints an enrollment token and pairs a device with it, returning the device token (`pbc_`). */
export async function enrollDevice(owner: Owner, workspaceId = owner.workspaceId): Promise<{ clientId: string; token: string }> {
  const e = ok(await owner.agent.post(`/api/workspaces/${workspaceId}/enrollments`, {}), 'enrollment')
  const r = ok(await readReply(await call('/api/client/enroll', jsonInit({ token: e.body.token, ...DEVICE_INFO }))), 'enroll')
  return { clientId: r.body.clientId, token: r.body.token }
}

/** A POST with a JSON body from an anonymous caller (device endpoints, webhooks). */
export function jsonInit(body: unknown, headers: Record<string, string> = {}): RequestInit {
  return { method: 'POST', body: JSON.stringify(body), headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': nextIp(), ...headers } }
}
