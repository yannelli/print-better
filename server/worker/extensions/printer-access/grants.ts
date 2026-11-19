import type { AccessSubject, PrinterAccess, PrinterGrant } from '../../../shared/access'
import type { Json } from '../../http/body'
import { badRequest, forbidden, notFound } from '../../http/errors'
import { newId } from '../../lib/crypto'
import { first, run } from '../../lib/db'
import type { Scope } from '../../services/access'
import type { Ctx } from '../../services/context'
import { requirePermission } from '../../services/permissions'
import { changed, enter } from './guard'
import { defaultRole, GRANT_VIEW, grantRows, toGrant, type GrantRow } from './store'
import { parseRole, parseSubject, principalOf } from './values'

/** Callers with `access` on the printer (owners and admins always have it). */
async function printerWithAccess(ctx: Ctx, workspaceId: string, printerId: string, scope: Scope): Promise<string> {
  const { access } = await enter(ctx, workspaceId, scope)
  const printer = await first<{ id: string }>(ctx.env.DB, 'SELECT id FROM printers WHERE id = ? AND workspace_id = ?', printerId, workspaceId)
  if (!printer) throw notFound('Printer not found')
  requirePermission(access, printer.id, 'access')
  return printer.id
}

async function printerAccess(env: Env, workspaceId: string, printerId: string): Promise<PrinterAccess> {
  const [own, fallback, grants, inherited] = await Promise.all([
    first<{ role: string }>(env.DB, 'SELECT role FROM printer_everyone WHERE printer_id = ?', printerId),
    defaultRole(env, workspaceId),
    grantRows(env, workspaceId, printerId),
    grantRows(env, workspaceId, null),
  ])
  return {
    printerId,
    everyoneRole: own?.role ?? null,
    effectiveEveryoneRole: own?.role ?? fallback,
    grants: grants.map(toGrant),
    inherited: inherited.map(toGrant),
  }
}

export async function getPrinterAccess(ctx: Ctx, workspaceId: string, printerId: string): Promise<PrinterAccess> {
  return printerAccess(ctx.env, workspaceId, await printerWithAccess(ctx, workspaceId, printerId, 'read'))
}

/** `everyoneRole`: a role, `none` (restricted), or null to follow the workspace default. */
export async function setEveryoneRole(ctx: Ctx, workspaceId: string, printerId: string, body: Json): Promise<PrinterAccess> {
  const id = await printerWithAccess(ctx, workspaceId, printerId, 'write')
  if (body.everyoneRole === undefined) throw badRequest('everyoneRole is required (a role, "none", or null for the workspace default)')
  const role = body.everyoneRole === null ? null : await parseRole(ctx.env, workspaceId, body.everyoneRole, 'everyoneRole', true)
  const current = await first<{ role: string }>(ctx.env.DB, 'SELECT role FROM printer_everyone WHERE printer_id = ?', id)
  if ((current?.role ?? null) !== role) {
    if (role === null) await run(ctx.env.DB, 'DELETE FROM printer_everyone WHERE printer_id = ?', id)
    else {
      await run(
        ctx.env.DB,
        `INSERT INTO printer_everyone (printer_id, workspace_id, role, updated_at) VALUES (?, ?, ?, ?)
         ON CONFLICT (printer_id) DO UPDATE SET role = excluded.role, updated_at = excluded.updated_at`,
        id,
        workspaceId,
        role,
        Date.now(),
      )
    }
    await changed(ctx, workspaceId, 'access.update', id, { everyoneRole: role })
  }
  return printerAccess(ctx.env, workspaceId, id)
}

/** A subject holds one role per scope, so granting again replaces the role and keeps the grant id. */
async function saveGrant(ctx: Ctx, workspaceId: string, printerId: string | null, body: Json): Promise<PrinterGrant> {
  const subject = parseSubject(body.subject)
  // A grant to Everyone would unlock restricted printers; the Everyone settings cover that instead.
  if (subject.type === 'everyone') {
    throw badRequest(
      printerId
        ? "Set the printer's Everyone role instead of granting Everyone access to one printer"
        : 'Change the workspace default role instead of granting Everyone access to every printer',
    )
  }
  await principalOf(ctx.env, workspaceId, subject)
  const role = await parseRole(ctx.env, workspaceId, body.role, 'role', false)
  const subjectId = subject.id
  const idIf = (type: AccessSubject['type']) => (subject.type === type ? subjectId : null)
  const existing = await first<{ id: string; role: string }>(
    ctx.env.DB,
    `SELECT id, role FROM printer_grants WHERE workspace_id = ? AND printer_id IS ? AND subject_type = ? AND COALESCE(user_id, group_id, client_id) IS ?`,
    workspaceId,
    printerId,
    subject.type,
    subjectId,
  )
  const id = existing?.id ?? newId()
  if (existing && existing.role !== role) await run(ctx.env.DB, 'UPDATE printer_grants SET role = ? WHERE id = ?', role, id)
  if (!existing) {
    await run(
      ctx.env.DB,
      `INSERT INTO printer_grants (id, workspace_id, printer_id, subject_type, user_id, group_id, client_id, role, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id,
      workspaceId,
      printerId,
      subject.type,
      idIf('user'),
      idIf('group'),
      idIf('client'),
      role,
      Date.now(),
    )
  }
  if (existing?.role !== role) await changed(ctx, workspaceId, 'access.grant', id, { printerId, subject, role })
  return toGrant((await first<GrantRow>(ctx.env.DB, `${GRANT_VIEW} WHERE g.id = ?`, id)) as GrantRow)
}

/** `POST /access/grants`: a role on every printer in the workspace (admins). */
export async function grantWorkspaceAccess(ctx: Ctx, workspaceId: string, body: Json): Promise<PrinterGrant> {
  await enter(ctx, workspaceId, 'write', true)
  return saveGrant(ctx, workspaceId, null, body)
}

export async function grantPrinterAccess(ctx: Ctx, workspaceId: string, printerId: string, body: Json): Promise<PrinterGrant> {
  return saveGrant(ctx, workspaceId, await printerWithAccess(ctx, workspaceId, printerId, 'write'), body)
}

/** Admins remove any grant; people with `access` on a printer remove that printer's grants. */
export async function revokeGrant(ctx: Ctx, workspaceId: string, grantId: string): Promise<void> {
  const { role, access } = await enter(ctx, workspaceId, 'write')
  const grant = await first<GrantRow>(ctx.env.DB, `${GRANT_VIEW} WHERE g.id = ? AND g.workspace_id = ?`, grantId, workspaceId)
  if (!grant) throw notFound('Grant not found')
  if (grant.printer_id) requirePermission(access, grant.printer_id, 'access')
  else if (role === 'member') throw forbidden('Only admins can do that')
  await run(ctx.env.DB, 'DELETE FROM printer_grants WHERE id = ?', grantId)
  const { subject, role: grantRole } = toGrant(grant)
  await changed(ctx, workspaceId, 'access.revoke', grantId, { printerId: grant.printer_id, subject, role: grantRole })
}
