import type { Job, JobNote } from '../../../shared/printing'
import { JOB_VIEW, toJob } from '../../db/map'
import type { JobViewRow } from '../../db/rows'
import type { Json } from '../../http/body'
import { forbidden, notFound } from '../../http/errors'
import { optStr, str } from '../../http/validate'
import { first } from '../../lib/db'
import { audit } from '../../services/audit'
import type { Ctx } from '../../services/context'
import { canSeeJob } from '../../services/job-access'
import type { Access } from '../../services/permissions'
import { jobViewer } from '../job-view'
import { enter, isAdmin, type Caller } from './guard'
import { endHeld, heldJobs, moveOn, notHeld, requireHeld } from './holds'
import { holdUntil } from './settings'
import { onlyKeys } from './values'

/** Owners and admins approve any job, their own too; with Printer access, `jobs.manage` on the printer approves other people's. */
export function mayApprove(caller: Pick<Caller, 'role' | 'access'> & { userId: string }, job: Pick<JobViewRow, 'user_id' | 'printer_id'>): boolean {
  if (isAdmin(caller.role)) return true
  return caller.access.managed && job.user_id !== caller.userId && caller.access.can(job.printer_id, 'jobs.manage')
}

const sees = (access: Access, userId: string, row: JobViewRow) => canSeeJob(access, userId, row.user_id, row.printer_id)

/** A job of this workspace the caller can see; 404 otherwise, like the core. */
export async function visibleJob(ctx: Ctx, workspaceId: string, id: string, caller: Caller): Promise<JobViewRow> {
  const row = await first<JobViewRow>(ctx.env.DB, `${JOB_VIEW} WHERE j.id = ? AND j.workspace_id = ?`, id, workspaceId)
  if (!row || !sees(caller.access, caller.user.id, row)) throw notFound('Job not found')
  return row
}

export const callerView = (ctx: Ctx, workspaceId: string, caller: Caller) => jobViewer(ctx, workspaceId, { kind: 'member', userId: caller.user.id, role: caller.role })

/** Jobs waiting for approval that the caller may approve, oldest first; empty for anyone who approves nothing. */
export async function listApprovals(ctx: Ctx, workspaceId: string): Promise<Job[]> {
  const caller = await enter(ctx, workspaceId, 'read', 'approvals')
  const who = { ...caller, userId: caller.user.id }
  const rows = (await heldJobs(ctx.env, workspaceId, 'approval')).filter((r) => sees(caller.access, caller.user.id, r) && mayApprove(who, r))
  const view = await callerView(ctx, workspaceId, caller)
  return rows.map((r) => view(toJob(r)))
}

async function approvable(ctx: Ctx, workspaceId: string, id: string) {
  const caller = await enter(ctx, workspaceId, 'print', 'approvals')
  const row = await visibleJob(ctx, workspaceId, id, caller)
  const hold = requireHeld(row, 'approval')
  if (!mayApprove({ ...caller, userId: caller.user.id }, row)) throw forbidden(row.user_id === caller.user.id ? 'You can’t approve your own job' : 'You can’t approve jobs on this printer')
  return { caller, row, hold }
}

const approvalNote = (name: string, message: string): JobNote => ({ source: 'approval', id: null, name, message })

/** Prints the job, or holds it for release next when its printer or a rule asked for that. */
export async function approveJob(ctx: Ctx, workspaceId: string, id: string, body: Json): Promise<Job> {
  onlyKeys(body, ['note'])
  const note = optStr(body, 'note', { max: 500 })
  const { caller, row, hold } = await approvable(ctx, workspaceId, id)
  const release = hold.release === true && caller.settings.release.enabled
  const next = release ? ({ status: 'held', hold: { kind: 'release', until: holdUntil(caller.settings, 'release', Date.now()) } } as const) : ({ status: 'queued' } as const)
  const job = await moveOn(ctx, row, 'approval', next, approvalNote(caller.user.name, note ? `Approved: ${note}` : 'Approved'))
  await audit(ctx, workspaceId, 'approval.approve', id, { ...(note && { note }), next: job.status })
  return (await callerView(ctx, workspaceId, caller))(job)
}

/** Cancels the job; the sender sees "Not approved: reason". */
export async function denyJob(ctx: Ctx, workspaceId: string, id: string, body: Json): Promise<Job> {
  onlyKeys(body, ['reason'])
  const reason = str(body, 'reason', { max: 500 })
  const { caller, row } = await approvable(ctx, workspaceId, id)
  const message = `Not approved: ${reason}`
  const [ended] = await endHeld(ctx, workspaceId, [row], { message, action: 'approval.deny', note: approvalNote(caller.user.name, message) })
  if (!ended) throw notHeld('approval')
  return (await callerView(ctx, workspaceId, caller))(toJob(ended))
}
