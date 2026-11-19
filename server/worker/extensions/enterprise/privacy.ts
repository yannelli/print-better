import type { EnterpriseSettings } from '../../../shared/enterprise'
import type { Job } from '../../../shared/printing'
import type { JobViewRow } from '../../db/rows'
import { run } from '../../lib/db'
import type { Ctx } from '../../services/context'
import type { JobView, JobViewer } from '../hooks'
import { settingsOf } from './store'

export const HIDDEN_TITLE = 'Document'

/** Whether `viewer` sees the job's document name: its sender always, the computer that sent it, and admins when allowed. */
export function seesName(privacy: EnterpriseSettings['privacy'], job: Pick<Job, 'userId' | 'sourceClientId'>, viewer: JobViewer): boolean {
  if (!privacy.enabled || !privacy.ownerOnlyNames) return true
  if (viewer.kind === 'device') return job.sourceClientId === viewer.clientId
  if (viewer.kind === 'report') return false
  return job.userId === viewer.userId || (privacy.adminsSeeNames && viewer.role !== 'member')
}

/** Null when names are shown to everyone, so job views cost nothing. */
export function privacyView(settings: EnterpriseSettings): JobView | null {
  const { privacy } = settings
  if (!privacy.enabled || !privacy.ownerOnlyNames) return null
  return (job, viewer) => (seesName(privacy, job, viewer) ? job : { ...job, title: HIDDEN_TITLE, fileName: null })
}

/** "Delete documents as soon as a job finishes", after usage is settled. */
export async function deleteFinished(ctx: Ctx, workspaceId: string, jobs: readonly JobViewRow[]): Promise<void> {
  const { privacy } = await settingsOf(ctx, workspaceId)
  if (!privacy.enabled || !privacy.deleteWhenFinished) return
  const stored = jobs.filter((j) => j.file_key)
  if (stored.length === 0) return
  await ctx.env.FILES.delete(stored.map((j) => j.file_key as string))
  await run(
    ctx.env.DB,
    "UPDATE jobs SET file_key = NULL WHERE id IN (SELECT value FROM json_each(?)) AND status IN ('completed', 'failed', 'canceled')",
    JSON.stringify(stored.map((j) => j.id)),
  )
}
