import { NO_ACCESS, type AccessSubject } from '../../../shared/access'
import type { Role } from '../../../shared/types'
import { badRequest, notFound } from '../../http/errors'
import { isObj } from '../../http/validate'
import { first } from '../../lib/db'
import type { AccessPrincipal } from '../hooks'
import { isBuiltInRole } from './policy'

const SUBJECT_TYPES: readonly string[] = ['everyone', 'user', 'group', 'client']

/** A built-in role key, a custom role of this workspace, or `none` where `allowNone`. */
export async function parseRole(env: Env, workspaceId: string, value: unknown, key: string, allowNone: boolean): Promise<string> {
  if (typeof value === 'string') {
    if (value === NO_ACCESS) {
      if (allowNone) return value
      throw badRequest(`${key} can't be "none": grants only add access`)
    }
    if (isBuiltInRole(value)) return value
    if (await first(env.DB, 'SELECT 1 AS one FROM printer_roles WHERE id = ? AND workspace_id = ?', value, workspaceId)) return value
  }
  throw badRequest(`${key} must be viewer, user, manager${allowNone ? ', none' : ''} or the id of a custom role`)
}

/** `{ type, id? }` from a request body. */
export function parseSubject(value: unknown): AccessSubject {
  if (!isObj(value) || typeof value.type !== 'string' || !SUBJECT_TYPES.includes(value.type)) {
    throw badRequest('subject must be { "type": "everyone" } or { "type": "user" | "group" | "client", "id": "…" }')
  }
  if (value.type === 'everyone') return { type: 'everyone' }
  if (typeof value.id !== 'string' || value.id.trim() === '') throw badRequest('subject.id is required')
  return { type: value.type as Exclude<AccessSubject['type'], 'everyone'>, id: value.id.trim() }
}

/** `everyone` or `<type>:<id>`, as query strings carry it. */
export function subjectParam(raw: string | null): AccessSubject {
  if (!raw) throw badRequest('subject is required: everyone, user:<id>, group:<id> or client:<id>')
  const [type, ...rest] = raw.split(':')
  return parseSubject(type === 'everyone' ? { type } : { type, id: rest.join(':') })
}

/** A body object, or the `everyone` / `<type>:<id>` string query strings carry. */
export const subjectFrom = (value: unknown): AccessSubject => (typeof value === 'string' || value === null ? subjectParam(value) : parseSubject(value))

/** Who a subject stands for; 404 when its member, group or device is not in this workspace. */
export async function principalOf(env: Env, workspaceId: string, subject: AccessSubject): Promise<AccessPrincipal> {
  const exists = (sql: string) => first(env.DB, sql, subject.type === 'everyone' ? null : subject.id, workspaceId)
  switch (subject.type) {
    case 'everyone':
      return { kind: 'everyone' }
    case 'user': {
      const member = await first<{ role: Role }>(env.DB, 'SELECT role FROM members WHERE user_id = ? AND workspace_id = ?', subject.id, workspaceId)
      if (!member) throw notFound('Member not found')
      return { kind: 'member', userId: subject.id, role: member.role }
    }
    case 'group':
      if (!(await exists('SELECT 1 AS one FROM groups WHERE id = ? AND workspace_id = ?'))) throw notFound('Group not found')
      return { kind: 'group', groupId: subject.id }
    case 'client':
      if (!(await exists('SELECT 1 AS one FROM clients WHERE id = ? AND workspace_id = ?'))) throw notFound('Device not found')
      return { kind: 'device', clientId: subject.id }
  }
}
