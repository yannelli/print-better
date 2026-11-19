import type { PolicySubject } from '../../../shared/policies'
import { badRequest } from '../../http/errors'
import { isObj } from '../../http/validate'
import { all } from '../../lib/db'

const TABLES = {
  user: { sql: 'SELECT user_id AS id FROM members WHERE workspace_id = ? AND user_id IN (SELECT value FROM json_each(?))', what: 'Member' },
  group: { sql: 'SELECT id FROM groups WHERE workspace_id = ? AND id IN (SELECT value FROM json_each(?))', what: 'Group' },
  client: { sql: 'SELECT id FROM clients WHERE workspace_id = ? AND id IN (SELECT value FROM json_each(?))', what: 'Device' },
  printer: { sql: 'SELECT id FROM printers WHERE workspace_id = ? AND id IN (SELECT value FROM json_each(?))', what: 'Printer' },
} as const

export type Named = keyof typeof TABLES

/** `{ type, id }` naming a member (`user`), group or device (`client`). */
export function parsePolicySubject(value: unknown, path: string, types: readonly PolicySubject['type'][] = ['user', 'group', 'client']): PolicySubject {
  if (!isObj(value) || !types.includes(value.type as PolicySubject['type']) || typeof value.id !== 'string' || !value.id.trim()) {
    throw badRequest(`${path} must be { "type": ${types.map((t) => `"${t}"`).join(' | ')}, "id": "…" }`)
  }
  const extra = Object.keys(value).filter((k) => k !== 'type' && k !== 'id')
  if (extra.length > 0) throw badRequest(`Unknown key in ${path}: ${extra.join(', ')}`)
  return { type: value.type as PolicySubject['type'], id: value.id.trim() }
}

/** Members, groups, devices and printers named in a rule or limit must exist when it is saved. */
export async function requireExisting(env: Env, workspaceId: string, named: Partial<Record<Named, string[]>>): Promise<void> {
  for (const [kind, ids] of Object.entries(named) as [Named, string[]][]) {
    if (ids.length === 0) continue
    const found = new Set((await all<{ id: string }>(env.DB, TABLES[kind].sql, workspaceId, JSON.stringify(ids))).map((r) => r.id))
    const missing = [...new Set(ids)].filter((id) => !found.has(id))
    if (missing.length > 0) throw badRequest(`${TABLES[kind].what} not found: ${missing.join(', ')}`)
  }
}
