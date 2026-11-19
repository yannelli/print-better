import { badRequest } from '../../http/errors'
import type { Ctx } from '../../services/context'
import type { JobDecision, JobDraft, JobStep } from '../hooks'
import { holdAvailable } from '../usage/active'
import { alertAfterJob } from './alerts'
import { defaultFor } from './defaults'
import { amountOf, budgetMeter, budgetRows, toBudget } from './meters'
import { announceApproval } from './notify'
import { holdUntil } from './settings'
import { controlsOf, costCentersOf, findCostCenter, settingsOf } from './store'
import { cycleWord } from './values'

/** The sender's pick, else their default; with "Every job needs a cost center", none refuses the job. Test pages never are. */
async function chargeCostCenter(ctx: Ctx, job: JobDraft, d: JobDecision): Promise<void> {
  const settings = await settingsOf(ctx, job.workspaceId)
  if (!settings.costCenters.enabled) return
  const centers = await costCentersOf(ctx, job.workspaceId)
  const asked = job.costCenter
  if (asked !== undefined && asked !== null && asked !== '') {
    const found = typeof asked === 'string' ? findCostCenter(centers, asked.trim()) : undefined
    if (!found?.active) {
      throw badRequest(found ? `The cost center ${found.name} is turned off` : 'costCenter must be the id or code of a cost center', 'cost_center_invalid')
    }
    d.costCenterId = found.id
    return
  }
  d.costCenterId = await defaultFor(ctx.env, job.workspaceId, job, centers)
  if (!d.costCenterId && settings.costCenters.required && job.source !== 'test') d.block = 'Choose a cost center to charge this job to'
}

/** Each enabled budget of the job's cost center; one it would go over blocks, warns, or asks for approval. */
async function checkBudgets(ctx: Ctx, job: JobDraft, d: JobDecision): Promise<void> {
  const settings = await settingsOf(ctx, job.workspaceId)
  if (!settings.costCenters.enabled || !d.costCenterId) return
  const center = (await costCentersOf(ctx, job.workspaceId)).find((c) => c.id === d.costCenterId)
  if (!center) return
  for (const row of await budgetRows(ctx.env, job.workspaceId, center.id)) {
    const budget = toBudget(row)
    if (!budget.enabled) continue
    const meter = await budgetMeter(ctx.env, job.workspaceId, budget, job.timeZone, job.at)
    const over = meter.used + amountOf(budget.unit, d.usage) > budget.amount
    const name = `${center.name} ${cycleWord(budget.cycle)} budget`
    d.meters.push({ ...meter, kind: 'budget', id: budget.id, name, action: budget.action, over })
    if (!over) continue
    if (budget.action === 'warn') d.notes.push({ source: 'budget', id: budget.id, name, message: `Over the ${name}` })
    else if (budget.action === 'approval' && (await holdAvailable(ctx, job.workspaceId, 'approval'))) d.approval.push(`Over the ${name}`)
    else {
      d.block = `This job would go over the ${name}`
      return
    }
  }
}

/** The printer's switch and earlier steps' requests become a hold, announced once the job is stored. */
async function askApproval(ctx: Ctx, job: JobDraft, d: JobDecision): Promise<void> {
  const settings = await settingsOf(ctx, job.workspaceId)
  if (!settings.approvals.enabled) return
  const controls = await controlsOf(ctx, job.workspaceId, d.printer.id)
  const reasons = [...(controls.approval ? [`Every job on ${d.printer.name} needs approval`] : []), ...d.approval]
  if (reasons.length === 0) return
  d.hold = { kind: 'approval', until: holdUntil(settings, 'approval', job.at), reasons }
  d.after.push((after, stored) => announceApproval(after, stored))
}

/** Last step, so it also queues alerts for every limit and budget the job counted against. */
async function askRelease(ctx: Ctx, job: JobDraft, d: JobDecision): Promise<void> {
  const settings = await settingsOf(ctx, job.workspaceId)
  const wanted = settings.release.enabled && (d.release || (await controlsOf(ctx, job.workspaceId, d.printer.id)).secureRelease)
  if (wanted) d.hold = d.hold?.kind === 'approval' ? { ...d.hold, release: true } : { kind: 'release', until: holdUntil(settings, 'release', job.at) }
  if (settings.alerts.enabled && d.meters.length > 0) d.after.push((after) => alertAfterJob(after, job, d.meters, d.usage))
}

const step = (name: JobStep['name'], run: JobStep['run']): JobStep => ({ extension: 'enterprise', name, run })

/** In JobStepName order, after Print rules and limits' rules and limits. */
export const ENTERPRISE_STEPS: JobStep[] = [
  step('cost-center', (ctx, job, d) => chargeCostCenter(ctx, job, d)),
  step('budgets', (ctx, job, d) => checkBudgets(ctx, job, d)),
  step('approval', (ctx, job, d) => askApproval(ctx, job, d)),
  step('release', (ctx, job, d) => askRelease(ctx, job, d)),
]
