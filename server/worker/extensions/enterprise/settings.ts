import type { EnterpriseConfig, EnterpriseSettings, PrinterControls } from '../../../shared/enterprise'
import type { Json } from '../../http/body'
import { badRequest, notFound } from '../../http/errors'
import { isObj } from '../../http/validate'
import { first, run } from '../../lib/db'
import { HOUR } from '../../lib/time'
import type { Ctx } from '../../services/context'
import { requirePermission } from '../../services/permissions'
import { saveExtensionConfig } from '../state'
import { changed, enter, requirePart, type Part } from './guard'
import { PART_OFF } from './held-sweep'
import { endHeld, heldJobs } from './holds'
import { EXTENSION, printerControls, remember } from './store'
import { memberIds, onlyKeys } from './values'

type Check = (value: unknown, key: string) => unknown

const bool: Check = (value, key) => {
  if (typeof value !== 'boolean') throw badRequest(`${key} must be true or false`)
  return value
}
const hours =
  (max: number): Check =>
  (value, key) => {
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > max) throw badRequest(`${key} must be a whole number of hours from 1 to ${max}`)
    return value
  }

const FIELDS: Record<Part, Record<string, Check>> = {
  approvals: { enabled: bool, expiryHours: hours(168) },
  release: { enabled: bool, expiryHours: hours(72) },
  costCenters: { enabled: bool, required: bool },
  reports: { enabled: bool },
  // Recipients are checked against the members table separately.
  alerts: { enabled: bool, personal: bool, admins: bool, recipients: (value) => value },
  privacy: { enabled: bool, deleteWhenFinished: bool, ownerOnlyNames: bool, adminsSeeNames: bool },
}

const PARTS = Object.keys(FIELDS) as Part[]

async function config(env: Env, workspaceId: string, settings: EnterpriseSettings): Promise<EnterpriseConfig> {
  return { settings, printers: await printerControls(env, workspaceId) }
}

export async function getEnterprise(ctx: Ctx, workspaceId: string): Promise<EnterpriseConfig> {
  const { settings } = await enter(ctx, workspaceId, 'read', null)
  return config(ctx.env, workspaceId, settings)
}

/** Each part is merged; turning approvals or secure release off cancels the jobs waiting for it. */
export async function patchEnterprise(ctx: Ctx, workspaceId: string, body: Json): Promise<EnterpriseConfig> {
  onlyKeys(body, PARTS, 'The settings')
  const caller = await enter(ctx, workspaceId, 'write', null, body.privacy === undefined ? 'admin' : 'owner')
  const next = structuredClone(caller.settings)
  for (const part of PARTS) {
    const update = body[part]
    if (update === undefined) continue
    if (!isObj(update)) throw badRequest(`${part} must be an object`)
    onlyKeys(update, Object.keys(FIELDS[part]), part)
    const target = next[part] as Record<string, unknown>
    for (const [key, value] of Object.entries(update)) target[key] = FIELDS[part][key](value, `${part}.${key}`)
  }
  if (isObj(body.alerts) && body.alerts.recipients !== undefined) {
    const recipients = body.alerts.recipients
    next.alerts.recipients = recipients === null ? null : await memberIds(ctx.env, workspaceId, recipients, 'alerts.recipients')
  }
  await saveExtensionConfig(ctx.env, workspaceId, EXTENSION, { ...next })
  remember(ctx, workspaceId, next)
  await changed(ctx, workspaceId, 'enterprise.update', workspaceId, { changes: body })
  if (caller.settings.approvals.enabled && !next.approvals.enabled) await endHeld(ctx, workspaceId, await heldJobs(ctx.env, workspaceId, 'approval'), PART_OFF.approval)
  if (caller.settings.release.enabled && !next.release.enabled) await endHeld(ctx, workspaceId, await heldJobs(ctx.env, workspaceId, 'release'), PART_OFF.release)
  return config(ctx.env, workspaceId, next)
}

const CONTROL_PARTS = { approval: 'approvals', secureRelease: 'release' } as const

/** Admins, or anyone with `settings` on the printer. Each switch needs its part on. */
export async function setPrinterControls(ctx: Ctx, workspaceId: string, printerId: string, body: Json): Promise<PrinterControls> {
  onlyKeys(body, Object.keys(CONTROL_PARTS), 'The printer controls')
  const { access, settings } = await enter(ctx, workspaceId, 'write', null)
  const printer = await first<{ id: string }>(ctx.env.DB, 'SELECT id FROM printers WHERE id = ? AND workspace_id = ?', printerId, workspaceId)
  if (!printer) throw notFound('Printer not found')
  requirePermission(access, printer.id, 'settings')
  const keys = Object.keys(body) as (keyof typeof CONTROL_PARTS)[]
  if (keys.length === 0) throw badRequest('Send approval, secureRelease, or both')
  for (const key of keys) {
    bool(body[key], key)
    requirePart(settings, CONTROL_PARTS[key])
  }
  const current = (await printerControls(ctx.env, workspaceId))[printer.id] ?? { approval: false, secureRelease: false }
  const next: PrinterControls = { approval: (body.approval as boolean | undefined) ?? current.approval, secureRelease: (body.secureRelease as boolean | undefined) ?? current.secureRelease }
  await run(
    ctx.env.DB,
    `INSERT INTO printer_controls (printer_id, workspace_id, approval, secure_release, updated_at) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (printer_id) DO UPDATE SET approval = excluded.approval, secure_release = excluded.secure_release, updated_at = excluded.updated_at`,
    printer.id,
    workspaceId,
    next.approval,
    next.secureRelease,
    Date.now(),
  )
  await changed(ctx, workspaceId, 'enterprise.printer', printer.id, { ...next })
  return next
}

/** When a hold that starts now runs out. */
export const holdUntil = (settings: EnterpriseSettings, kind: 'approval' | 'release', from: number): number =>
  from + (kind === 'approval' ? settings.approvals.expiryHours : settings.release.expiryHours) * HOUR
