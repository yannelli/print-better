import type { JobUsage } from '../../../shared/printing'
import type { UsageImpact, UsageUnit } from '../../../shared/usage'
import type { JobViewRow } from '../../db/rows'
import { sendMail } from '../../email/outbound'
import { usageAlertMail } from '../../email/templates'
import { all, first, run } from '../../lib/db'
import type { Ctx } from '../../services/context'
import { appName, loadInstance, outboundEnabled } from '../../services/instance-store'
import type { JobDraft } from '../hooks'
import { usageSettings } from '../usage/settings'
import { amountOf, budgetMeter, budgetRows, toBudget } from './meters'
import { formatMoney } from './csv'
import { settingsOf } from './store'
import { cycleWord } from './values'

const THRESHOLDS = [80, 100] as const

/** One count that may have crossed a threshold. `subject` names the count ('' when shared); `person` gets a personal alert. */
export interface Count {
  meter: Pick<UsageImpact, 'kind' | 'id' | 'name' | 'unit' | 'amount' | 'start' | 'end'>
  used: number
  subject: string
  person: string | null
}

interface LimitScope {
  id: string
  scope: string
  user_id: string | null
  client_id: string | null
}

/** Whose count of a limit the job landed in; personal limits count one member. */
function limitCount(limit: LimitScope | undefined, job: JobDraft): Pick<Count, 'subject' | 'person'> {
  const user = job.userId ? `user:${job.userId}` : null
  const client = job.clientId ? `client:${job.clientId}` : null
  switch (limit?.scope) {
    case 'each-member':
      return { subject: user ?? '', person: job.userId }
    case 'member':
      return { subject: `user:${limit.user_id}`, person: limit.user_id }
    case 'group-each':
      return { subject: user ?? client ?? '', person: job.userId }
    case 'each-device':
      return { subject: client ?? '', person: null }
    case 'device':
      return { subject: `client:${limit.client_id}`, person: null }
    default:
      return { subject: '', person: null }
  }
}

/** After a job is stored: every limit and budget it counted against, with the job added. */
export async function alertAfterJob(ctx: Ctx, job: JobDraft, meters: readonly UsageImpact[], usage: JobUsage): Promise<void> {
  const limitIds = meters.filter((m) => m.kind === 'limit').map((m) => m.id)
  const limits = limitIds.length
    ? await all<LimitScope>(ctx.env.DB, 'SELECT id, scope, user_id, client_id FROM print_limits WHERE id IN (SELECT value FROM json_each(?))', JSON.stringify(limitIds))
    : []
  const counts = meters.map((meter): Count => {
    const used = meter.used + amountOf(meter.unit, usage)
    return meter.kind === 'budget' ? { meter, used, subject: '', person: null } : { meter, used, ...limitCount(limits.find((l) => l.id === meter.id), job) }
  })
  await sendAlerts(ctx, job.workspaceId, counts)
}

/** After jobs end: what the printers reported may take a budget over a threshold. */
export async function alertSettled(ctx: Ctx, workspaceId: string, rows: readonly JobViewRow[]): Promise<void> {
  if (!(await settingsOf(ctx, workspaceId)).alerts.enabled) return
  const centers = [...new Set(rows.flatMap((r) => (r.cost_center_id && r.usage ? [r.cost_center_id] : [])))]
  if (centers.length === 0) return
  const { timeZone } = await usageSettings(ctx, workspaceId)
  const counts: Count[] = []
  for (const centerId of centers) {
    const name = (await first<{ name: string }>(ctx.env.DB, 'SELECT name FROM cost_centers WHERE id = ?', centerId))?.name ?? 'Cost center'
    for (const budget of (await budgetRows(ctx.env, workspaceId, centerId)).map(toBudget).filter((b) => b.enabled)) {
      const meter = await budgetMeter(ctx.env, workspaceId, budget, timeZone)
      counts.push({ meter: { ...meter, kind: 'budget', id: budget.id, name: `${name} ${cycleWord(budget.cycle)} budget` }, used: meter.used, subject: '', person: null })
    }
  }
  await sendAlerts(ctx, workspaceId, counts)
}

/** Records the highest threshold each count reached for the first time this cycle, then emails it. */
export async function sendAlerts(ctx: Ctx, workspaceId: string, counts: readonly Count[]): Promise<void> {
  const settings = await settingsOf(ctx, workspaceId)
  if (!settings.alerts.enabled) return
  for (const count of counts) {
    const { meter } = count
    if (meter.amount <= 0) continue
    let reached = 0
    for (const threshold of THRESHOLDS.filter((t) => count.used * 100 >= t * meter.amount)) {
      const inserted = await run(
        ctx.env.DB,
        'INSERT OR IGNORE INTO usage_alerts (workspace_id, limit_id, budget_id, subject, cycle_start, threshold, sent_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
        workspaceId,
        meter.kind === 'limit' ? meter.id : null,
        meter.kind === 'budget' ? meter.id : null,
        count.subject,
        meter.start,
        threshold,
        Date.now(),
      )
      if (inserted > 0) reached = threshold
    }
    if (reached > 0) await emailAlert(ctx, workspaceId, count, reached)
  }
}

async function emailAlert(ctx: Ctx, workspaceId: string, count: Count, threshold: number): Promise<void> {
  const inst = await loadInstance(ctx.env)
  if (!outboundEnabled(ctx.env, inst)) return
  const { alerts } = await settingsOf(ctx, workspaceId)
  const { currency, timeZone } = await usageSettings(ctx, workspaceId)
  const members = await all<{ user_id: string; role: string; name: string; email: string | null }>(
    ctx.env.DB,
    'SELECT m.user_id, m.role, u.name, u.email FROM members m JOIN users u ON u.id = m.user_id WHERE m.workspace_id = ?',
    workspaceId,
  )
  const workspace = (await first<{ name: string }>(ctx.env.DB, 'SELECT name FROM workspaces WHERE id = ?', workspaceId))?.name ?? 'your workspace'
  const person = count.meter.kind === 'limit' && count.person ? members.find((m) => m.user_id === count.person) : undefined
  const admins = members.filter((m) => (alerts.recipients ? alerts.recipients.includes(m.user_id) : m.role !== 'member') && m.user_id !== person?.user_id)
  const base = {
    app: appName(ctx.env, inst),
    workspace,
    name: count.meter.name,
    threshold,
    used: amountText(count.meter.unit, count.used, currency),
    amount: amountText(count.meter.unit, count.meter.amount, currency),
    resets: new Intl.DateTimeFormat('en-US', { timeZone, dateStyle: 'medium' }).format(count.meter.end),
  }
  const send = (to: string[], whose: string | null, url: string) =>
    to.length > 0 && sendMail(ctx.env, usageAlertMail({ ...base, to, whose, url }), inst).catch((e: unknown) => console.error('usage alert failed', e))
  if (person?.email && alerts.personal) await send([person.email], 'Your', `${ctx.origin}/w/${workspaceId}`)
  if (alerts.admins) await send(admins.flatMap((a) => (a.email ? [a.email] : [])), person ? `${person.name}’s` : null, `${ctx.origin}/w/${workspaceId}/usage`)
}

const UNIT_WORDS: Record<Exclude<UsageUnit, 'cost'>, string> = { pages: 'pages', sheets: 'sheets', jobs: 'jobs' }

export const amountText = (unit: UsageUnit, value: number, currency: string): string =>
  unit === 'cost' ? formatMoney(value, currency) : `${value.toLocaleString('en-US')} ${UNIT_WORDS[unit]}`
