import type { Job } from '../../../shared/printing'
import { toJob } from '../../db/map'
import { ApiError, forbidden } from '../../http/errors'
import { audit } from '../../services/audit'
import type { Ctx } from '../../services/context'
import { callerView, visibleJob } from './approvals'
import { enter, isAdmin } from './guard'
import { heldJobs, moveOn, requireHeld } from './holds'

/** The caller's own jobs ready to release; owners and admins may ask for everyone's. Oldest first. */
export async function listRelease(ctx: Ctx, workspaceId: string, everyone: boolean): Promise<Job[]> {
  const caller = await enter(ctx, workspaceId, 'read', 'release')
  if (everyone && !isAdmin(caller.role)) throw forbidden('Only owners and admins can see everyone’s jobs waiting for release')
  const rows = (await heldJobs(ctx.env, workspaceId, 'release')).filter((r) => everyone || r.user_id === caller.user.id)
  const view = await callerView(ctx, workspaceId, caller)
  return rows.map((r) => view(toJob(r)))
}

/** Only the sender, owners and admins release a job; one from a computer's print window has no sender here. */
export async function releaseJob(ctx: Ctx, workspaceId: string, id: string): Promise<Job> {
  const caller = await enter(ctx, workspaceId, 'print', 'release')
  const row = await visibleJob(ctx, workspaceId, id, caller)
  requireHeld(row, 'release')
  if (row.user_id !== caller.user.id && !isAdmin(caller.role)) throw forbidden('Only the person who sent this job, owners, and admins can release it')
  const job = await moveOn(ctx, row, 'release', { status: 'queued' })
  await audit(ctx, workspaceId, 'release.release', id)
  return (await callerView(ctx, workspaceId, caller))(job)
}

/** Every job of the caller's that is ready to release. */
export async function releaseAll(ctx: Ctx, workspaceId: string): Promise<{ released: Job[] }> {
  const caller = await enter(ctx, workspaceId, 'print', 'release')
  const view = await callerView(ctx, workspaceId, caller)
  const released: Job[] = []
  for (const row of (await heldJobs(ctx.env, workspaceId, 'release')).filter((r) => r.user_id === caller.user.id)) {
    try {
      released.push(view(await moveOn(ctx, row, 'release', { status: 'queued' })))
      await audit(ctx, workspaceId, 'release.release', row.id, { all: true })
    } catch (e) {
      // Canceled or expired since the list was read.
      if (!(e instanceof ApiError && e.code === 'job_not_held')) throw e
    }
  }
  return { released }
}
