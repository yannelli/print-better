import type { PrinterPermission } from '../../shared/access'
import type { Job, Printer } from '../../shared/printing'
import { JOB_VIEW, PRINTER_VIEW, printerSettings, toJob, toPrinter, workspaceSettings } from '../db/map'
import type { JobViewRow, PrinterViewRow, UserRow } from '../db/rows'
import type { Json } from '../http/body'
import { conflict, notFound } from '../http/errors'
import { NAME, nullableStr, optBool, optObj, optStr } from '../http/validate'
import { all, first, run } from '../lib/db'
import { requireScope } from './access'
import { audit } from './audit'
import { sendCommand, type CommandResult } from './clients'
import type { Ctx } from './context'
import { hubFor, notifyHub } from './hub'
import { parseJobOptions } from './job-options'
import { queueJob, workspaceLimits } from './job-create'
import { memberAccess, requirePermission } from './permissions'
import { testPagePdf } from './test-page'
import { loadWorkspace, saveWorkspaceSettings } from './workspaces'

const ALIAS = { max: 64, pattern: /^[a-z0-9][a-z0-9._-]*$/i, hint: 'email alias may use letters, digits, ".", "_" and "-"' }

export async function loadPrinter(env: Env, workspaceId: string, id: string): Promise<PrinterViewRow> {
  const row = await first<PrinterViewRow>(env.DB, `${PRINTER_VIEW} WHERE p.id = ? AND p.workspace_id = ?`, id, workspaceId)
  if (!row) throw notFound('Printer not found')
  return row
}

/** The printer, once the caller is known to hold `perm` on it (404 when they can't see it, 403 when they can). */
async function printerFor(ctx: Ctx, workspaceId: string, id: string, perm: PrinterPermission): Promise<{ row: PrinterViewRow; user: UserRow }> {
  const { user, access } = await memberAccess(ctx, workspaceId, perm)
  const row = await loadPrinter(ctx.env, workspaceId, id)
  requirePermission(access, row.id, perm)
  return { row, user }
}

export async function listPrinters(ctx: Ctx, workspaceId: string, added?: string | null): Promise<Printer[]> {
  requireScope(ctx, 'read')
  const { access } = await memberAccess(ctx, workspaceId)
  const flag = added === 'true' ? 1 : added === 'false' ? 0 : null
  const rows = await all<PrinterViewRow>(
    ctx.env.DB,
    `${PRINTER_VIEW} WHERE p.workspace_id = ? AND (? IS NULL OR p.added = ?) ORDER BY p.added DESC, p.name COLLATE NOCASE`,
    workspaceId,
    flag,
    flag,
  )
  return rows.filter((r) => access.can(r.id, 'view')).map(toPrinter)
}

export async function getPrinter(ctx: Ctx, workspaceId: string, id: string): Promise<Printer> {
  requireScope(ctx, 'read')
  return toPrinter((await printerFor(ctx, workspaceId, id, 'view')).row)
}

/** A forgotten or removed default printer must not stay the workspace default. */
async function clearDefaultIf(ctx: Ctx, workspaceId: string, printerId: string): Promise<void> {
  const settings = workspaceSettings((await loadWorkspace(ctx.env, workspaceId)).settings)
  if (settings.defaultPrinterId !== printerId) return
  await saveWorkspaceSettings(ctx.env, workspaceId, { ...settings, defaultPrinterId: null })
  notifyHub(ctx, workspaceId, (hub) => hub.broadcastWorkspace(workspaceId))
}

export async function patchPrinter(ctx: Ctx, workspaceId: string, id: string, body: Json): Promise<Printer> {
  requireScope(ctx, 'write')
  const { row } = await printerFor(ctx, workspaceId, id, 'settings')
  const settings = printerSettings(row.settings)
  const patch = optObj(body, 'settings')
  if (patch) {
    settings.lanShare = optBool(patch, 'lanShare') ?? settings.lanShare
    const email = optObj(patch, 'email')
    if (email) {
      settings.email.enabled = optBool(email, 'enabled') ?? settings.email.enabled
      const alias = nullableStr(email, 'alias', ALIAS)
      if (alias !== undefined) settings.email.alias = alias?.toLowerCase() ?? null
    }
  }
  const location = nullableStr(body, 'location', { max: 200 })
  const added = optBool(body, 'added') ?? row.added === 1
  const defaults = body.defaults === undefined ? row.defaults : JSON.stringify(parseJobOptions(body.defaults))
  try {
    await run(
      ctx.env.DB,
      'UPDATE printers SET name = ?, location = ?, added = ?, defaults = ?, settings = ?, email_alias = ?, updated_at = ? WHERE id = ?',
      optStr(body, 'name', NAME) ?? row.name,
      location === undefined ? row.location : location,
      added,
      defaults,
      JSON.stringify(settings),
      settings.email.alias,
      Date.now(),
      id,
    )
  } catch (e) {
    if (String(e).includes('email_alias')) throw conflict('That email alias is already used by another printer', 'alias_taken')
    throw e
  }
  if (!added) await clearDefaultIf(ctx, workspaceId, id)
  await audit(ctx, workspaceId, 'printer.update', id, { fields: Object.keys(body) })
  const updated = await loadPrinter(ctx.env, workspaceId, id)
  notifyHub(ctx, workspaceId, async (hub) => {
    await hub.pushPrinterConfig(workspaceId, row.client_id)
    await hub.broadcast([{ type: 'printer', printer: toPrinter(updated) }])
  })
  return toPrinter(updated)
}

/** Forgets the printer; open jobs are canceled (and the device told to stop). Rediscovery brings it back as discovered. */
export async function deletePrinter(ctx: Ctx, workspaceId: string, id: string): Promise<void> {
  requireScope(ctx, 'write')
  const { row } = await printerFor(ctx, workspaceId, id, 'settings')
  const open = await all<JobViewRow>(ctx.env.DB, `${JOB_VIEW} WHERE j.printer_id = ? AND j.status IN ('uploading', 'queued', 'dispatched', 'printing')`, id)
  const hub = hubFor(ctx.env, workspaceId)
  for (const job of open.filter((j) => j.status === 'dispatched' || j.status === 'printing')) {
    await hub.cancelJob(workspaceId, job.id).catch(() => false)
  }
  const now = Date.now()
  await run(
    ctx.env.DB,
    `UPDATE jobs SET status = 'canceled', status_message = 'Printer removed', completed_at = ?, updated_at = ?
     WHERE printer_id = ? AND status IN ('uploading', 'queued', 'dispatched', 'printing')`,
    now,
    now,
    id,
  )
  await run(ctx.env.DB, 'DELETE FROM printers WHERE id = ?', id)
  await clearDefaultIf(ctx, workspaceId, id)
  await audit(ctx, workspaceId, 'printer.delete', id, { name: row.name })
  notifyHub(ctx, workspaceId, async (h) => {
    await h.broadcast([
      ...open.map((j) => ({ type: 'job' as const, job: { ...toJob(j), status: 'canceled' as const, printerId: null, printerName: null } })),
      { type: 'printer_removed', id },
    ])
    await h.pushPrinterConfig(workspaceId, row.client_id)
  })
}

/** Identifying makes the printer act, so it takes `print`; refreshing its status only `view`. */
async function printerCommand(ctx: Ctx, workspaceId: string, id: string, name: 'identify' | 'refresh'): Promise<CommandResult> {
  requireScope(ctx, 'write')
  const { row } = await printerFor(ctx, workspaceId, id, name === 'identify' ? 'print' : 'view')
  return sendCommand(ctx, workspaceId, row.client_id, name, { key: row.key })
}

export const identifyPrinter = (ctx: Ctx, workspaceId: string, id: string) => printerCommand(ctx, workspaceId, id, 'identify')
export const refreshPrinter = (ctx: Ctx, workspaceId: string, id: string) => printerCommand(ctx, workspaceId, id, 'refresh')

export async function printTestPage(ctx: Ctx, workspaceId: string, id: string): Promise<{ job: Job }> {
  requireScope(ctx, 'print')
  const { row: printer, user } = await printerFor(ctx, workspaceId, id, 'print')
  if (printer.added !== 1) throw conflict('Add this printer to the workspace before printing to it', 'printer_not_added')
  const pdf = testPagePdf({
    printerName: printer.name,
    deviceName: printer.client_name,
    mediaDefault: toPrinter(printer).capabilities.mediaDefault,
    time: new Date(),
  })
  const { job } = await queueJob(ctx, {
    workspaceId,
    printer,
    userId: user.id,
    source: 'test',
    title: 'Test page',
    options: {},
    document: { kind: 'bytes', data: pdf, contentType: 'application/pdf', fileName: 'test-page.pdf' },
    maxBytes: (await workspaceLimits(ctx.env, workspaceId)).maxBytes,
  })
  return { job }
}
