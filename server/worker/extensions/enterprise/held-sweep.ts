import type { JobHold } from '../../../shared/printing'
import { JOB_VIEW } from '../../db/map'
import type { JobViewRow } from '../../db/rows'
import { all, parseJson } from '../../lib/db'
import { systemCtx, type Ctx } from '../../services/context'
import { extensionActive } from '../state'
import { endHeld, heldJobs, OFF_MESSAGE, type Ending } from './holds'
import { EXTENSION, loadSettings } from './store'

/** Turning it off, by either switch: nothing held may print without the checks that held it. */
export async function cancelAllHeld(ctx: Ctx, workspaceIds: readonly string[]): Promise<void> {
  for (const workspaceId of workspaceIds) await endHeld(ctx, workspaceId, await heldJobs(ctx.env, workspaceId), { message: OFF_MESSAGE, action: 'job.cancel' })
}

/** Turning off approvals or secure release alone. */
export const PART_OFF: Record<JobHold['kind'], Ending> = {
  approval: { message: 'Approvals were turned off', action: 'job.cancel' },
  release: { message: 'Secure release was turned off', action: 'job.cancel' },
}

const EXPIRED: Record<JobHold['kind'], Ending> = {
  approval: { message: 'Not approved in time', action: 'approval.expire' },
  release: { message: 'Not released in time', action: 'release.expire', deleteDocuments: true },
}

/** Every 15 minutes: expires held jobs, and cancels any held while their part or the extension went off. */
export async function sweepHeld(env: Env): Promise<void> {
  const rows = await all<JobViewRow>(env.DB, `${JOB_VIEW} WHERE j.status = 'held' ORDER BY j.created_at LIMIT 500`)
  const ctx = systemCtx(env, '', (p) => void p.catch(() => undefined))
  const now = Date.now()
  for (const workspaceId of new Set(rows.map((r) => r.workspace_id))) {
    const held = rows.filter((r) => r.workspace_id === workspaceId)
    if (!(await extensionActive(env, workspaceId, EXTENSION))) {
      await endHeld(ctx, workspaceId, held, { message: OFF_MESSAGE, action: 'job.cancel' })
      continue
    }
    const settings = await loadSettings(env, workspaceId)
    for (const kind of ['approval', 'release'] as const) {
      const ofKind = held.filter((r) => parseJson<JobHold | null>(r.held, null)?.kind === kind)
      const on = kind === 'approval' ? settings.approvals.enabled : settings.release.enabled
      if (!on) await endHeld(ctx, workspaceId, ofKind, PART_OFF[kind])
      else await endHeld(ctx, workspaceId, ofKind.filter((r) => (parseJson<JobHold | null>(r.held, null)?.until ?? 0) <= now), EXPIRED[kind])
    }
  }
}
