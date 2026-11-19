import type { AccessSubject } from '../../shared/access'
import type { Agent, Body, Reply } from './http'
import type { Owner } from './world'

export const wsPath = (ws: string, path = ''): string => `/api/workspaces/${ws}${path}`

export function ok(reply: Reply, what: string): Body {
  if (reply.status >= 300) throw new Error(`${what} failed: ${reply.status} ${JSON.stringify(reply.body)}`)
  return reply.body
}

/** Makes printer access available (the setup owner is the instance admin) and turns it on in `ws`. */
export async function turnOnAccess(owner: Owner, ws = owner.workspaceId): Promise<void> {
  ok(await owner.agent.patch('/api/admin/extensions/printer-access', { available: true }), 'make available')
  ok(await owner.agent.patch(wsPath(ws, '/extensions/printer-access'), { enabled: true }), 'enable')
}

export const setAvailable = async (owner: Owner, available: boolean) =>
  ok(await owner.agent.patch('/api/admin/extensions/printer-access', { available }), 'availability')

export const setEnabled = async (owner: Owner, ws: string, enabled: boolean) =>
  ok(await owner.agent.patch(wsPath(ws, '/extensions/printer-access'), { enabled }), 'workspace switch')

/** A printer's Everyone role: a role id, `none` (restricted), or null for the workspace default. */
export const setEveryone = async (agent: Agent, ws: string, printerId: string, everyoneRole: string | null) =>
  ok(await agent.patch(wsPath(ws, `/printers/${printerId}/access`), { everyoneRole }), 'everyone role')

/** A grant on one printer, or on every printer when `printerId` is null. */
export async function grant(agent: Agent, ws: string, printerId: string | null, subject: AccessSubject, role: string): Promise<Body> {
  const path = printerId ? `/printers/${printerId}/access/grants` : '/access/grants'
  return ok(await agent.post(wsPath(ws, path), { subject, role }), 'grant')
}

export async function newGroup(agent: Agent, ws: string, name: string, members: { type: 'user' | 'client'; id: string }[] = []): Promise<string> {
  const id = ok(await agent.post(wsPath(ws, '/groups'), { name }), 'create group').id
  for (const m of members) ok(await agent.put(wsPath(ws, `/groups/${id}/members/${m.type}/${m.id}`), {}), 'add group member')
  return id
}

export const myAccess = async (agent: Agent, ws: string): Promise<Body> => ok(await agent.get(wsPath(ws, '/access/me')), 'access/me')

export const ids = (items: { id: string }[]): string[] => items.map((i) => i.id)
