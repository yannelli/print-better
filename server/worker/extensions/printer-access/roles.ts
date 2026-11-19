import { BUILT_IN_ROLES, PRINTER_PERMISSIONS, withImplied, type PrinterPermission, type PrinterRole } from '../../../shared/access'
import type { Json } from '../../http/body'
import { badRequest, conflict, notFound } from '../../http/errors'
import { nullableStr, optStr, str } from '../../http/validate'
import { newId } from '../../lib/crypto'
import { first, run } from '../../lib/db'
import type { Ctx } from '../../services/context'
import { changed, enter } from './guard'
import { BUILT_IN_ROLE_LIST, customRoles, defaultRole, toRole, type RoleRow } from './store'

const ROLE_NAME = { max: 60 }
const DESCRIPTION = { max: 200 }
const RESERVED = new Set([...Object.values(BUILT_IN_ROLES).map((r) => r.name.toLowerCase()), 'no access', 'none'])

/** At least one permission; implied ones are stored too, so a role always shows everything it allows. */
function parsePermissions(value: unknown): PrinterPermission[] {
  if (!Array.isArray(value) || value.length === 0) throw badRequest(`permissions must list at least one of: ${PRINTER_PERMISSIONS.join(', ')}`)
  const unknown = value.filter((p) => !PRINTER_PERMISSIONS.includes(p as PrinterPermission))
  if (unknown.length > 0) throw badRequest(`Unknown permission ${unknown.map(String).join(', ')}. Use: ${PRINTER_PERMISSIONS.join(', ')}`)
  return withImplied(value as PrinterPermission[])
}

const andList = (items: string[]) => (items.length > 1 ? `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}` : items[0])

function checkName(name: string): string {
  if (RESERVED.has(name.toLowerCase())) throw conflict(`"${name}" is the name of a built-in role`, 'name_taken')
  return name
}

/** Writes that hit the unique name index become a plain 409. */
async function named<T>(write: () => Promise<T>): Promise<T> {
  try {
    return await write()
  } catch (e) {
    if (String(e).includes('UNIQUE')) throw conflict('Another role already has that name', 'name_taken')
    throw e
  }
}

async function loadRole(env: Env, workspaceId: string, id: string): Promise<RoleRow> {
  const row = await first<RoleRow>(env.DB, 'SELECT * FROM printer_roles WHERE id = ? AND workspace_id = ?', id, workspaceId)
  if (!row) throw notFound('Role not found')
  return row
}

export async function listRoles(ctx: Ctx, workspaceId: string): Promise<PrinterRole[]> {
  await enter(ctx, workspaceId, 'read')
  return [...BUILT_IN_ROLE_LIST, ...(await customRoles(ctx.env, workspaceId)).map(toRole)]
}

export async function createRole(ctx: Ctx, workspaceId: string, body: Json): Promise<PrinterRole> {
  await enter(ctx, workspaceId, 'write', true)
  const name = checkName(str(body, 'name', ROLE_NAME))
  const permissions = parsePermissions(body.permissions)
  const now = Date.now()
  const row = await named(() =>
    first<RoleRow>(
      ctx.env.DB,
      'INSERT INTO printer_roles (id, workspace_id, name, description, permissions, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING *',
      newId(),
      workspaceId,
      name,
      nullableStr(body, 'description', DESCRIPTION) ?? null,
      JSON.stringify(permissions),
      now,
      now,
    ),
  )
  if (!row) throw new Error('role insert returned no row')
  await changed(ctx, workspaceId, 'access.role_create', row.id, { name, permissions })
  return toRole(row)
}

/** Everyone holding the role changes at once. */
export async function updateRole(ctx: Ctx, workspaceId: string, id: string, body: Json): Promise<PrinterRole> {
  await enter(ctx, workspaceId, 'write', true)
  const row = await loadRole(ctx.env, workspaceId, id)
  const name = optStr(body, 'name', ROLE_NAME)
  const description = nullableStr(body, 'description', DESCRIPTION)
  const permissions = body.permissions === undefined ? undefined : parsePermissions(body.permissions)
  const updated = await named(() =>
    first<RoleRow>(
      ctx.env.DB,
      'UPDATE printer_roles SET name = ?, description = ?, permissions = ?, updated_at = ? WHERE id = ? RETURNING *',
      name === undefined ? row.name : checkName(name),
      description === undefined ? row.description : description,
      permissions === undefined ? row.permissions : JSON.stringify(permissions),
      Date.now(),
      id,
    ),
  )
  if (!updated) throw notFound('Role not found')
  await changed(ctx, workspaceId, 'access.role_update', id, { fields: Object.keys(body) })
  return toRole(updated)
}

/** Refused while any grant, printer or the workspace default uses it, so nobody's access changes silently. */
export async function deleteRole(ctx: Ctx, workspaceId: string, id: string): Promise<void> {
  await enter(ctx, workspaceId, 'write', true)
  const row = await loadRole(ctx.env, workspaceId, id)
  const use = await first<{ grants: number; printers: number }>(
    ctx.env.DB,
    `SELECT (SELECT COUNT(*) FROM printer_grants WHERE workspace_id = ? AND role = ?) AS grants,
            (SELECT COUNT(*) FROM printer_everyone WHERE workspace_id = ? AND role = ?) AS printers`,
    workspaceId,
    id,
    workspaceId,
    id,
  )
  const uses = [
    use?.grants ? `${use.grants} grant${use.grants === 1 ? '' : 's'}` : '',
    use?.printers ? `the Everyone setting of ${use.printers} printer${use.printers === 1 ? '' : 's'}` : '',
    (await defaultRole(ctx.env, workspaceId)) === id ? 'the workspace default role' : '',
  ].filter(Boolean)
  if (uses.length > 0) throw conflict(`"${row.name}" is still used by ${andList(uses)}. Change those first.`, 'role_in_use')
  await run(ctx.env.DB, 'DELETE FROM printer_roles WHERE id = ?', id)
  await changed(ctx, workspaceId, 'access.role_delete', id, { name: row.name })
}
