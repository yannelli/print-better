import type { EnterpriseSettings } from '../../../shared/enterprise'
import type { JobHold } from '../../../shared/printing'
import { JOB_VIEW } from '../../db/map'
import type { JobViewRow } from '../../db/rows'
import { all } from '../../lib/db'
import { systemCtx, type Ctx } from '../../services/context'
import { extensionActive } from '../state'
import { endHeld, heldJobs, holdOf, OFF_MESSAGE, type Ending } from './holds'
import { EXTENSION, loadSettings } from './store'

/** Turning it off, by either switch: nothing held may print without the checks that held it. */
export async function cancelAllHeld(ctx: Ctx, workspaceIds: readonly string[]): Promise<void> {
  for (const workspaceId of workspaceIds) await endHeld(ctx, workspaceId, await heldJobs(ctx.env, workspaceId), { message: OFF_MESSAGE, action: 'job.cancel' })
}

/** Turning off approvals or secure release alone. */
export const PART_OFF: Record<JobHold['kind'], Ending> = {
  approval: { message: 'Approvals were turned off', action: 'job.cancel', kind: 'approval' },
  release: { message: 'Secure release was turned off', action: 'job.cancel', kind: 'release' },
}

const EXPIRED: Record<JobHold['kind'], Ending> = {
  approval: { message: 'Not approved in time', action: 'approval.expire', kind: 'approval', expired: true },
  release: { message: 'Not released in time', action: 'release.expire', kind: 'release', expired: true, deleteDocuments: true },
}

const KINDS = ['approval', 'release'] as const
const partOn = (settings: EnterpriseSettings, kind: JobHold['kind']) => (kind === 'approval' ? settings.approvals.enabled : settings.release.enabled)

/** Every 15 minutes: cancels jobs held while their part or the extension went off, then expires held jobs. */
export async function sweepHeld(env: Env): Promise<void> {
  const ctx = systemCtx(env, '', (p) => void p.catch(() => undefined))
  await endSwitchedOff(ctx)
  await endExpired(ctx, Date.now())
}

async function endSwitchedOff(ctx: Ctx): Promise<void> {
  const workspaces = await all<{ workspace_id: string }>(ctx.env.DB, "SELECT DISTINCT workspace_id FROM jobs WHERE status = 'held'")
  for (const { workspace_id: workspaceId } of workspaces) {
    if (!(await extensionActive(ctx.env, workspaceId, EXTENSION))) {
      await endHeld(ctx, workspaceId, await heldJobs(ctx.env, workspaceId), { message: OFF_MESSAGE, action: 'job.cancel' })
      continue
    }
    const settings = await loadSettings(ctx.env, workspaceId)
    for (const kind of KINDS) if (!partOn(settings, kind)) await endHeld(ctx, workspaceId, await heldJobs(ctx.env, workspaceId, kind), PART_OFF[kind])
  }
}

/** The 500 that ran out first; every one of them ends, so the next run reaches the rest. */
async function endExpired(ctx: Ctx, now: number): Promise<void> {
  const rows = await all<JobViewRow>(
    ctx.env.DB,
    `${JOB_VIEW} WHERE j.status = 'held' AND json_extract(j.held, '$.until') <= ? ORDER BY json_extract(j.held, '$.until') LIMIT 500`,
    now,
  )
  for (const workspaceId of new Set(rows.map((r) => r.workspace_id))) {
    for (const kind of KINDS) await endHeld(ctx, workspaceId, rows.filter((r) => r.workspace_id === workspaceId && holdOf(r)?.kind === kind), EXPIRED[kind])
  }
}
