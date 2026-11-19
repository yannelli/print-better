import type { Job } from '../../../shared/printing'
import type { Role } from '../../../shared/types'
import { sendMail } from '../../email/outbound'
import { approvalRequestMail } from '../../email/templates'
import { all, first } from '../../lib/db'
import { audit } from '../../services/audit'
import type { Ctx } from '../../services/context'
import { notifyHub } from '../../services/hub'
import { appName, loadInstance, outboundEnabled } from '../../services/instance-store'
import { accessFor } from '../../services/permissions'
import { jobViewer } from '../job-view'
import { usageSettings } from '../usage/settings'
import { mayApprove } from './approvals'

interface MemberRow {
  user_id: string
  role: Role
  name: string
  email: string | null
}

/** Everyone who may approve the job, with their role and email. */
async function approvers(ctx: Ctx, job: Job): Promise<MemberRow[]> {
  const members = await all<MemberRow>(
    ctx.env.DB,
    'SELECT m.user_id, m.role, u.name, u.email FROM members m JOIN users u ON u.id = m.user_id WHERE m.workspace_id = ?',
    job.workspaceId,
  )
  const allowed: MemberRow[] = []
  for (const m of members) {
    const access = await accessFor(ctx, job.workspaceId, { kind: 'member', userId: m.user_id, role: m.role })
    if (mayApprove({ role: m.role, access, userId: m.user_id }, { user_id: job.userId, printer_id: job.printerId })) allowed.push(m)
  }
  return allowed
}

/** Who sent the job, in words. */
async function senderName(env: Env, job: Job): Promise<string> {
  if (job.userId) return (await first<{ name: string }>(env.DB, 'SELECT name FROM users WHERE id = ?', job.userId))?.name ?? 'Someone'
  if (job.source === 'device') return job.sourceClientName ?? 'A computer'
  return 'Someone'
}

export const localTime = (at: number, timeZone: string): string =>
  new Intl.DateTimeFormat('en-US', { timeZone, month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short' }).format(at)

/** A job started waiting for approval: audited, a live notice to open pages, and an email to each approver. */
export async function announceApproval(ctx: Ctx, job: Job): Promise<void> {
  await audit(ctx, job.workspaceId, 'approval.request', job.id, { reasons: job.held?.reasons ?? [] })
  notifyHub(ctx, job.workspaceId, (hub) => hub.broadcast([{ type: 'approval', job }]))
  const inst = await loadInstance(ctx.env)
  if (!outboundEnabled(ctx.env, inst)) return
  const [people, workspace, sender, settings] = await Promise.all([
    approvers(ctx, job),
    first<{ name: string }>(ctx.env.DB, 'SELECT name FROM workspaces WHERE id = ?', job.workspaceId),
    senderName(ctx.env, job),
    usageSettings(ctx, job.workspaceId),
  ])
  for (const person of people.filter((p) => p.email)) {
    const shown = (await jobViewer(ctx, job.workspaceId, { kind: 'member', userId: person.user_id, role: person.role }))(job)
    const mail = approvalRequestMail({
      to: [person.email as string],
      app: appName(ctx.env, inst),
      workspace: workspace?.name ?? 'your workspace',
      sender,
      title: shown.title,
      printer: job.printerName ?? 'a printer',
      reasons: job.held?.reasons ?? [],
      until: localTime(job.held?.until ?? Date.now(), settings.timeZone),
      url: `${ctx.origin}/w/${job.workspaceId}/jobs/approvals`,
    })
    await sendMail(ctx.env, mail, inst).catch((e: unknown) => console.error('approval email failed', e))
  }
}
