import type { Role } from '../../shared/types'
import type { JobViewRow, UserRow } from '../db/rows'
import { forbidden, notFound } from '../http/errors'
import { all, type SqlValue } from '../lib/db'
import type { Ctx } from './context'
import { loadJobView } from './job-create'
import { memberAccess, type Access } from './permissions'

/** `retry` and `upload` print the document again, so they also need `print`. */
export type JobAction = 'cancel' | 'retry' | 'upload' | 'delete'

const LEGACY_DENIAL: Record<Exclude<JobAction, 'delete'>, string> = {
  cancel: 'Only admins can manage other people’s jobs',
  retry: 'Only admins can manage other people’s jobs',
  upload: 'Only the person who created this job can upload its file',
}

/** Everyone sees every job without the extension; with it, your own plus jobs on printers with `jobs.read`. */
export const canSeeJob = (access: Access, userId: string, ownerId: string | null, printerId: string | null): boolean =>
  !access.managed || access.all || ownerId === userId || access.can(printerId, 'jobs.read')

/** Why `action` is refused on a job the caller can see, or null when it is allowed. */
export function jobDenial(access: Access, role: Role, userId: string, job: Pick<JobViewRow, 'user_id' | 'printer_id'>, action: JobAction): string | null {
  const own = job.user_id === userId
  if (!access.managed) return action === 'delete' || role !== 'member' || own ? null : LEGACY_DENIAL[action]
  if (access.all) return null
  const manage = access.can(job.printer_id, 'jobs.manage')
  if (action === 'delete') return manage ? null : "You don't have permission to delete jobs on this printer"
  if (!own && !manage) return action === 'upload' ? LEGACY_DENIAL.upload : `You can only ${action} your own jobs on this printer`
  if (action !== 'cancel' && !access.can(job.printer_id, 'print')) return "You don't have permission to print to this printer"
  return null
}

/** A job the caller may see (404 otherwise) and, with `action`, act on (403 otherwise). */
export async function jobFor(ctx: Ctx, workspaceId: string, id: string, action?: JobAction): Promise<{ job: JobViewRow; user: UserRow; access: Access }> {
  const { user, role, access } = await memberAccess(ctx, workspaceId, action === 'delete' ? 'jobs.manage' : undefined)
  const job = await loadJobView(ctx.env, workspaceId, id)
  if (!canSeeJob(access, user.id, job.user_id, job.printer_id)) throw notFound('Job not found')
  const denial = action ? jobDenial(access, role, user.id, job, action) : null
  if (denial) throw access.managed ? forbidden(denial, 'printer_access_denied') : forbidden(denial)
  return { job, user, access }
}

/** Extra WHERE clause for job lists, in SQL so every page is full and cursors stay valid. */
export async function jobScope(env: Env, workspaceId: string, userId: string, access: Access): Promise<{ sql: string; args: SqlValue[] }> {
  if (!access.managed || access.all) return { sql: '', args: [] }
  const printers = await all<{ id: string }>(env.DB, 'SELECT id FROM printers WHERE workspace_id = ?', workspaceId)
  const readable = printers.filter((p) => access.can(p.id, 'jobs.read')).map((p) => p.id)
  return { sql: ' AND (j.user_id = ? OR j.printer_id IN (SELECT value FROM json_each(?)))', args: [userId, JSON.stringify(readable)] }
}
