import { DEFAULT_ENTERPRISE_SETTINGS, type CostCenter, type EnterpriseSettings, type PrinterControls } from '../../../shared/enterprise'
import type { ExtensionId } from '../../../shared/extensions'
import { isObj } from '../../http/validate'
import { all } from '../../lib/db'
import { memo, type Ctx } from '../../services/context'
import { extensionConfig } from '../state'

export const EXTENSION: ExtensionId = 'enterprise'

/** The stored config over the defaults, keeping only known keys of the right type. */
export function settingsFrom(config: Record<string, unknown>): EnterpriseSettings {
  const out = structuredClone(DEFAULT_ENTERPRISE_SETTINGS)
  for (const part of Object.keys(out) as (keyof EnterpriseSettings)[]) {
    const saved = config[part]
    if (!isObj(saved)) continue
    const target = out[part] as Record<string, unknown>
    for (const [key, fallback] of Object.entries(target)) {
      const value = saved[key]
      const fits = key === 'recipients' ? value === null || (Array.isArray(value) && value.every((v) => typeof v === 'string')) : typeof value === typeof fallback
      if (fits) target[key] = value
    }
  }
  return out
}

// Shares holdAvailable's memo key (usage/active.ts), so a request reads the config once.
const configKey = (workspaceId: string) => `enterprise-config:${workspaceId}`

export const loadSettings = async (env: Env, workspaceId: string): Promise<EnterpriseSettings> => settingsFrom(await extensionConfig(env, workspaceId, EXTENSION))

export async function settingsOf(ctx: Ctx, workspaceId: string): Promise<EnterpriseSettings> {
  return settingsFrom(await memo(ctx, configKey(workspaceId), () => extensionConfig(ctx.env, workspaceId, EXTENSION)))
}

/** After a save, later checks in the same request see the new settings. */
export function remember(ctx: Ctx, workspaceId: string, settings: EnterpriseSettings): void {
  ctx.memo ??= new Map()
  ctx.memo.set(configKey(workspaceId), Promise.resolve(settings))
}

interface ControlRow {
  printer_id: string
  approval: number
  secure_release: number
}

/** Printers with a control turned on. */
export async function printerControls(env: Env, workspaceId: string): Promise<Record<string, PrinterControls>> {
  const rows = await all<ControlRow>(
    env.DB,
    'SELECT printer_id, approval, secure_release FROM printer_controls WHERE workspace_id = ? AND (approval = 1 OR secure_release = 1)',
    workspaceId,
  )
  return Object.fromEntries(rows.map((r) => [r.printer_id, { approval: r.approval === 1, secureRelease: r.secure_release === 1 }]))
}

export const NO_CONTROLS: PrinterControls = { approval: false, secureRelease: false }

export async function controlsOf(ctx: Ctx, workspaceId: string, printerId: string): Promise<PrinterControls> {
  const all = await memo(ctx, `printer-controls:${workspaceId}`, () => printerControls(ctx.env, workspaceId))
  return all[printerId] ?? NO_CONTROLS
}

interface CostCenterRow {
  id: string
  name: string
  code: string | null
  active: number
  created_at: number
  updated_at: number
}

export const toCostCenter = (r: CostCenterRow): CostCenter => ({
  id: r.id,
  name: r.name,
  code: r.code,
  active: r.active === 1,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
})

export async function costCenters(env: Env, workspaceId: string): Promise<CostCenter[]> {
  const rows = await all<CostCenterRow>(env.DB, 'SELECT * FROM cost_centers WHERE workspace_id = ? ORDER BY name COLLATE NOCASE', workspaceId)
  return rows.map(toCostCenter)
}

/** Loaded once per request. */
export const costCentersOf = (ctx: Ctx, workspaceId: string): Promise<CostCenter[]> => memo(ctx, `cost-centers:${workspaceId}`, () => costCenters(ctx.env, workspaceId))

/** By id, or by code ignoring case. */
export const findCostCenter = (list: readonly CostCenter[], value: string): CostCenter | undefined =>
  list.find((c) => c.id === value) ?? list.find((c) => c.code !== null && c.code.toLowerCase() === value.toLowerCase())
