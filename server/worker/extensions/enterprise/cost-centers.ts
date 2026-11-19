import type { CostCenter, CostCenterList } from '../../../shared/enterprise'
import type { Json } from '../../http/body'
import { conflict, notFound } from '../../http/errors'
import { nullableStr, optBool, optStr, str } from '../../http/validate'
import { newId } from '../../lib/crypto'
import { first, run } from '../../lib/db'
import type { Ctx } from '../../services/context'
import { memberDefault } from './defaults'
import { changed, enter } from './guard'
import { costCenters } from './store'
import { onlyKeys } from './values'

const NAME = { max: 80 }
const CODE = { max: 32 }
const FIELDS = ['name', 'code', 'active']

/** Writes that hit a unique index become 409 name_taken. */
async function unique(write: () => Promise<unknown>): Promise<void> {
  try {
    await write()
  } catch (e) {
    if (String(e).includes('UNIQUE')) throw conflict('Another cost center already has that name or code', 'name_taken')
    throw e
  }
}

async function costCenter(env: Env, workspaceId: string, id: string): Promise<CostCenter> {
  const found = (await costCenters(env, workspaceId)).find((c) => c.id === id)
  if (!found) throw notFound('Cost center not found')
  return found
}

/** Every cost center, active or not, and what the caller's jobs are charged to by default. */
export async function listCostCenters(ctx: Ctx, workspaceId: string): Promise<CostCenterList> {
  const caller = await enter(ctx, workspaceId, 'read', 'costCenters')
  const list = await costCenters(ctx.env, workspaceId)
  return { costCenters: list, myDefault: await memberDefault(ctx, workspaceId, caller.user.id, list) }
}

export async function createCostCenter(ctx: Ctx, workspaceId: string, body: Json): Promise<CostCenter> {
  await enter(ctx, workspaceId, 'write', 'costCenters', 'admin')
  onlyKeys(body, FIELDS)
  const id = newId()
  const name = str(body, 'name', NAME)
  const now = Date.now()
  await unique(() =>
    run(
      ctx.env.DB,
      'INSERT INTO cost_centers (id, workspace_id, name, code, active, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      id,
      workspaceId,
      name,
      nullableStr(body, 'code', CODE) ?? null,
      optBool(body, 'active') ?? true,
      now,
      now,
    ),
  )
  await changed(ctx, workspaceId, 'cost_center.create', id, { name })
  return costCenter(ctx.env, workspaceId, id)
}

export async function updateCostCenter(ctx: Ctx, workspaceId: string, id: string, body: Json): Promise<CostCenter> {
  await enter(ctx, workspaceId, 'write', 'costCenters', 'admin')
  onlyKeys(body, FIELDS)
  const current = await costCenter(ctx.env, workspaceId, id)
  const code = nullableStr(body, 'code', CODE)
  await unique(() =>
    run(
      ctx.env.DB,
      'UPDATE cost_centers SET name = ?, code = ?, active = ?, updated_at = ? WHERE id = ?',
      optStr(body, 'name', NAME) ?? current.name,
      code === undefined ? current.code : code,
      optBool(body, 'active') ?? current.active,
      Date.now(),
      id,
    ),
  )
  await changed(ctx, workspaceId, 'cost_center.update', id, { fields: Object.keys(body) })
  return costCenter(ctx.env, workspaceId, id)
}

/** Only until a job is charged to it; after that, deactivate it so its history stays. */
export async function deleteCostCenter(ctx: Ctx, workspaceId: string, id: string): Promise<void> {
  await enter(ctx, workspaceId, 'write', 'costCenters', 'admin')
  const current = await costCenter(ctx.env, workspaceId, id)
  const used = await first(
    ctx.env.DB,
    'SELECT 1 AS one WHERE EXISTS (SELECT 1 FROM jobs WHERE cost_center_id = ?1) OR EXISTS (SELECT 1 FROM usage_entries WHERE cost_center_id = ?1)',
    id,
  )
  if (used) throw conflict('Jobs were charged to this cost center. Turn it off instead, so its history stays.', 'cost_center_in_use')
  await run(ctx.env.DB, 'DELETE FROM cost_centers WHERE id = ?', id)
  await changed(ctx, workspaceId, 'cost_center.delete', id, { name: current.name })
}
