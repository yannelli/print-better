import type { ExtensionId } from '../../shared/extensions'
import type { Job } from '../../shared/printing'
import { memo, type Ctx } from '../services/context'
import { JOB_VIEW_HOOKS, type JobView, type JobViewer } from './hooks'
import { isActive } from './state'

/** Every active extension's view composed; null when none changes anything (no lookups while none is registered). */
export async function loadJobViews(env: Env, workspaceId: string, active: (id: ExtensionId) => Promise<boolean>): Promise<JobView | null> {
  const views: JobView[] = []
  for (const hook of JOB_VIEW_HOOKS) {
    if (!(await active(hook.extension))) continue
    const view = await hook.load(env, workspaceId)
    if (view) views.push(view)
  }
  return views.length === 0 ? null : (job, viewer) => views.reduce((shown, view) => view(shown, viewer), job)
}

const jobViews = (ctx: Ctx, workspaceId: string): Promise<JobView | null> =>
  memo(ctx, `job-views:${workspaceId}`, () => loadJobViews(ctx.env, workspaceId, (id) => isActive(ctx, workspaceId, id)))

/** What `viewer` may see of each job, e.g. without document names. */
export async function jobViewer(ctx: Ctx, workspaceId: string, viewer: JobViewer): Promise<(job: Job) => Job> {
  const view = await jobViews(ctx, workspaceId)
  return view ? (job) => view(job, viewer) : (job) => job
}
