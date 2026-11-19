import type { DocType, JobOptions, JobSource } from '../../../shared/printing'
import type { Role } from '../../../shared/types'
import type { PrinterViewRow } from '../../db/rows'
import { all } from '../../lib/db'
import type { Ctx } from '../../services/context'
import type { Access } from '../../services/permissions'
import { JOB_STEPS, type JobDecision, type JobDraft } from '../hooks'
import { isActive } from '../state'
import { estimateUsage, printerFacts } from './estimate'
import { pricesFor, usageSettings } from './settings'

/** Who sent a job, as the check sees them: a member, a device, or an email sender who isn't a member. */
export interface Sender {
  userId: string | null
  role: Role | null
  clientId: string | null
  access: Access
}

export interface DraftInput {
  workspaceId: string
  jobId: string
  attempt: number
  source: Exclude<JobSource, 'lan'>
  sender: Sender
  contentType: DocType
  size: number
  documentPages: number | null
  costCenter: unknown
}

/** Printer access groups of a member or device; none while Printer access is off. */
export async function groupsOf(ctx: Ctx, workspaceId: string, sender: Pick<Sender, 'userId' | 'clientId'>): Promise<string[]> {
  if ((!sender.userId && !sender.clientId) || !(await isActive(ctx, workspaceId, 'printer-access'))) return []
  const rows = await all<{ group_id: string }>(
    ctx.env.DB,
    'SELECT group_id FROM group_members WHERE workspace_id = ? AND (user_id = ? OR client_id = ?)',
    workspaceId,
    sender.userId,
    sender.clientId,
  )
  return rows.map((r) => r.group_id)
}

export async function jobDraft(ctx: Ctx, input: DraftInput): Promise<JobDraft> {
  const [settings, groups] = await Promise.all([usageSettings(ctx, input.workspaceId), groupsOf(ctx, input.workspaceId, input.sender)])
  const { sender, ...rest } = input
  return { ...rest, userId: sender.userId, role: sender.role, clientId: sender.clientId, groups, access: sender.access, timeZone: settings.timeZone, at: Date.now() }
}

/** Works the usage out again from the job as the check left it. */
export async function reestimate(ctx: Ctx, job: JobDraft, decision: JobDecision): Promise<void> {
  const settings = await usageSettings(ctx, job.workspaceId)
  decision.usage = estimateUsage(printerFacts(decision.printer), decision.options, job.documentPages, pricesFor(settings, decision.printer.id))
}

/** Each active extension's steps in order; a block stops the check. Nothing is stored here. */
export async function runJobCheck(ctx: Ctx, job: JobDraft, printer: PrinterViewRow, options: JobOptions): Promise<JobDecision> {
  const decision: JobDecision = {
    printer,
    options: { ...options },
    notes: [],
    approval: [],
    release: false,
    hold: null,
    costCenterId: null,
    usage: { documentPages: job.documentPages, pages: 0, sheets: 0, colorPages: 0, costMicros: 0, estimated: true },
    meters: [],
    block: null,
    after: [],
  }
  await reestimate(ctx, job, decision)
  for (const step of JOB_STEPS) {
    if (!(await isActive(ctx, job.workspaceId, step.extension))) continue
    await step.run(ctx, job, decision)
    await reestimate(ctx, job, decision)
    if (decision.block !== null) break
  }
  return decision
}
