import type { Job, JobHold, JobOptions, JobPolicy } from '../../../shared/printing'
import { forbidden } from '../../http/errors'
import { stmt } from '../../lib/db'
import { audit } from '../../services/audit'
import type { Ctx } from '../../services/context'
import type { JobDecision, JobDraft, WriteGuard } from '../hooks'

export const HOLD_MESSAGES: Record<JobHold['kind'], string> = {
  approval: 'Waiting for approval',
  release: 'Waiting to be released at the printer',
}

/** What the sender asked for, before any rule changed it. */
export interface Requested {
  printerId: string
  options: JobOptions
}

/** What an accepted attempt stores on its job row. */
export interface Accepted {
  decision: JobDecision
  status: 'queued' | 'held'
  statusMessage: string | null
  printerId: string
  options: string
  policy: string | null
  held: string | null
  usage: string
  costCenterId: string | null
  /** Every guard of the check as one condition for the statement that stores the job; null when there are none. */
  guard: WriteGuard | null
}

// D1 binds at most 100 parameters a statement: 10 guards of up to 7 leave room for the job's own.
const MAX_GUARDS = 10

function guardOf(guards: readonly WriteGuard[]): WriteGuard | null {
  const kept = guards.slice(0, MAX_GUARDS)
  return kept.length === 0 ? null : { sql: kept.map((g) => `(${g.sql})`).join(' AND '), params: kept.flatMap((g) => g.params) }
}

const canonical = (o: JobOptions): string => JSON.stringify(Object.entries(o).sort(([a], [b]) => a.localeCompare(b)))

/** A refused job is audited as job.block and answers 403 policy_blocked with the refusal message. */
export async function refuse(ctx: Ctx, job: JobDraft, decision: JobDecision): Promise<never> {
  const message = decision.block ?? 'This job was refused'
  await audit(ctx, job.workspaceId, 'job.block', job.jobId, { source: job.source, printerId: decision.printer.id, message })
  throw forbidden(message, 'policy_blocked')
}

export async function refuseIfBlocked(ctx: Ctx, job: JobDraft, decision: JobDecision): Promise<void> {
  if (decision.block !== null) await refuse(ctx, job, decision)
}

export function accepted(decision: JobDecision, requested: Requested): Accepted {
  const changed = decision.printer.id !== requested.printerId || canonical(decision.options) !== canonical(requested.options)
  const policy: JobPolicy | null = decision.notes.length > 0 || changed ? { notes: decision.notes, ...(changed && { requested }) } : null
  return {
    decision,
    status: decision.hold ? 'held' : 'queued',
    statusMessage: decision.hold ? HOLD_MESSAGES[decision.hold.kind] : null,
    printerId: decision.printer.id,
    options: JSON.stringify(decision.options),
    policy: policy && JSON.stringify(policy),
    held: decision.hold && JSON.stringify(decision.hold),
    usage: JSON.stringify(decision.usage),
    costCenterId: decision.costCenterId,
    guard: guardOf(decision.guards),
  }
}

/** The attempt's ledger row, written in the same batch and only if its job really became queued or held. */
export function entryInsert(env: Env, job: JobDraft, a: Accepted): D1PreparedStatement {
  const u = a.decision.usage
  return stmt(
    env.DB,
    `INSERT INTO usage_entries (workspace_id, job_id, attempt, at, source, user_id, client_id, printer_id, cost_center_id, jobs, pages, sheets, color_pages, cost_micros)
     SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM jobs WHERE id = ? AND attempts = ? AND status IN ('queued', 'held'))
     ON CONFLICT (job_id, attempt) DO NOTHING`,
    job.workspaceId,
    job.jobId,
    job.attempt,
    job.at,
    job.source,
    job.userId,
    job.clientId,
    a.printerId,
    a.costCenterId,
    u.pages,
    u.sheets,
    u.colorPages,
    u.costMicros,
    job.jobId,
    job.attempt,
  )
}

/** Alerts and approval emails, once the job is stored; a failure never undoes the job. */
export function runAfter(ctx: Ctx, decision: JobDecision, job: Job): void {
  if (decision.after.length === 0) return
  ctx.waitUntil(Promise.all(decision.after.map((effect) => effect(ctx, job))).catch((e: unknown) => console.error('job check side effect failed', e)))
}
