import type { ExtensionId } from '../../shared/extensions'
import type { Job } from '../../shared/printing'
import { SOURCE_CLIENT_NAME, toJob } from '../db/map'
import type { JobViewRow } from '../db/rows'
import { first } from '../lib/db'
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

/** The title the device printing a job may see, when a view hides it; undefined otherwise, with no lookup while no view applies. */
export async function deviceTitle(ctx: Ctx, workspaceId: string, jobId: string): Promise<string | undefined> {
  const view = await jobViews(ctx, workspaceId)
  if (!view) return undefined
  const row = await first<JobViewRow & { client_id: string | null }>(
    ctx.env.DB,
    `SELECT j.*, p.name AS printer_name, p.client_id, ${SOURCE_CLIENT_NAME} FROM jobs j LEFT JOIN printers p ON p.id = j.printer_id WHERE j.id = ? AND j.workspace_id = ?`,
    jobId,
    workspaceId,
  )
  if (!row?.client_id) return undefined
  const { title } = view(toJob(row), { kind: 'device', clientId: row.client_id })
  return title === row.title ? undefined : title
}
