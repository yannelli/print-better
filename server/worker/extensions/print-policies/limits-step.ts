import type { PrintLimit } from '../../../shared/policies'
import type { Cycle, UsageImpact } from '../../../shared/usage'
import { amountOf, formatAmount, formatLeft } from '../../../shared/usage-text'
import { memo } from '../../services/context'
import type { JobStep } from '../hooks'
import { holdAvailable } from '../usage/active'
import { cycleAt } from '../usage/cycles'
import { usageSettings } from '../usage/settings'
import { type Count, countOf, measure } from './meters'
import { EXTENSION, loadLimits } from './store'

const CYCLE_WORDS: Record<Cycle['kind'], string> = { day: 'today', week: 'this week', month: 'this month', quarter: 'this quarter', year: 'this year' }

interface Words {
  currency: string
  timeZone: string
}

/** The refusal: what the job needs, what is left, and when the count starts over. */
function overMessage(limit: PrintLimit, impact: UsageImpact, need: number, w: Words): string {
  const left = Math.max(0, impact.left)
  const verb = limit.unit === 'cost' || left === 1 ? 'is' : 'are'
  const resets = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', timeZone: w.timeZone }).format(impact.end)
  return (
    `Over the limit ${limit.name}: this job needs ${formatAmount(limit.unit, need, w.currency, 'en-US')} and ` +
    `${formatAmount(limit.unit, left, w.currency, 'en-US')} ${verb} left ${CYCLE_WORDS[limit.cycle.kind]}. It starts over on ${resets}.`
  )
}

/** Every limit that counts the job, with what it has left; the first one the job goes over and that blocks refuses it. */
export const limitsStep: JobStep = {
  extension: EXTENSION,
  name: 'limits',
  run: async (ctx, job, decision) => {
    const limits = await memo(ctx, `print-limits:${job.workspaceId}`, () => loadLimits(ctx.env, job.workspaceId))
    const admin = job.role === 'owner' || job.role === 'admin'
    const counts: Count[] = limits.flatMap((limit) => {
      const found = limit.enabled && !(limit.exemptAdmins && admin) ? countOf(limit, job, (id) => id === decision.printer.id) : null
      return found ? [{ limit, whose: found.whose, span: cycleAt(limit.cycle, job.timeZone, job.at) }] : []
    })
    const meters = await measure(ctx.env, job.workspaceId, counts)
    const words = await usageSettings(ctx, job.workspaceId)
    const impacts = counts.map(({ limit }, i): UsageImpact => {
      const need = amountOf(decision.usage, limit.unit)
      return { kind: 'limit', id: limit.id, name: limit.name, ...meters[i], action: limit.action, over: need > 0 && meters[i].used + need > meters[i].amount }
    })
    decision.meters.push(...impacts)
    for (const [i, { limit }] of counts.entries()) {
      const impact = impacts[i]
      if (!impact.over) continue
      const approval = limit.action === 'approval' && (await holdAvailable(ctx, job.workspaceId, 'approval'))
      if (limit.action === 'warn') {
        const left = formatLeft(limit.unit, impact.left, impact.amount, words.currency, 'en-US')
        decision.notes.push({ source: 'limit', id: limit.id, name: limit.name, message: `Went over the limit, with ${left} left ${CYCLE_WORDS[limit.cycle.kind]}` })
      } else if (approval) {
        decision.approval.push(`Over the limit ${limit.name}`)
      } else {
        // A limit set to require approval blocks while approvals aren't available.
        decision.block = overMessage(limit, impact, amountOf(decision.usage, limit.unit), words)
        return
      }
    }
  },
}
