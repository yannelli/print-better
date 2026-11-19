import type { PrintRule, RuleAction } from '../../../shared/policies'
import { PRINTER_VIEW } from '../../db/map'
import type { PrinterViewRow } from '../../db/rows'
import { first } from '../../lib/db'
import { type Ctx, memo } from '../../services/context'
import type { JobDecision, JobDraft, JobStep } from '../hooks'
import { holdAvailable } from '../usage/active'
import { reestimate } from '../usage/check'
import { asksTwoSided, copiesOf, printerFacts, printsInColor } from '../usage/estimate'
import { matches } from './rule-match'
import { EXTENSION, loadRules } from './store'

const addedPrinter = (env: Env, workspaceId: string, id: string) =>
  first<PrinterViewRow>(env.DB, `${PRINTER_VIEW} WHERE p.id = ? AND p.workspace_id = ? AND p.added = 1`, id, workspaceId)

/** Applies one action; only what it really changes becomes a note. */
async function apply(ctx: Ctx, job: JobDraft, d: JobDecision, rule: PrintRule, action: RuleAction): Promise<void> {
  const note = (message: string) => d.notes.push({ source: 'rule', id: rule.id, name: rule.name, message })
  const printer = printerFacts(d.printer)
  switch (action.type) {
    case 'block':
      d.block = action.message
      break
    case 'two-sided':
      if (!asksTwoSided(printer, d.options) && printer.capabilities.duplex) {
        d.options.sides = 'two-sided-long-edge'
        note('Printed two-sided')
      }
      break
    case 'monochrome':
      if (printsInColor(printer, d.options)) {
        d.options.colorMode = 'monochrome'
        note('Printed in black and white')
      }
      break
    case 'max-copies':
      if (copiesOf(printer, d.options) > action.copies) {
        d.options.copies = action.copies
        note(`Copies limited to ${action.copies}`)
      }
      break
    case 'redirect':
      if (action.printerId !== d.printer.id) await redirect(ctx, job, d, action.printerId, note)
      break
    case 'approval':
      if (await holdAvailable(ctx, job.workspaceId, 'approval')) d.approval.push(rule.name)
      break
    case 'release':
      if (await holdAvailable(ctx, job.workspaceId, 'release')) d.release = true
      break
    case 'note':
      note(action.message)
      break
  }
}

/** Only to an added printer the sender may print to, on a device that's online; otherwise the job stays and a note says why. */
async function redirect(ctx: Ctx, job: JobDraft, d: JobDecision, printerId: string, note: (message: string) => void): Promise<void> {
  const target = await addedPrinter(ctx.env, job.workspaceId, printerId)
  if (!target) note('Not sent to another printer: that printer was removed')
  else if (!job.access.can(target.id, 'print')) note(`Not sent to ${target.name}, since the sender can't print there`)
  else if (target.client_online !== 1) note(`Not sent to ${target.name}, since ${target.client_name} is offline`)
  else {
    d.printer = target
    note(`Sent to ${target.name}`)
  }
}

/** Rules top to bottom; each matching rule acts on the job as earlier ones left it, and a block ends the check. */
export const rulesStep: JobStep = {
  extension: EXTENSION,
  name: 'rules',
  run: async (ctx, job, decision) => {
    const rules = await memo(ctx, `print-rules:${job.workspaceId}`, () => loadRules(ctx.env, job.workspaceId))
    const admin = job.role === 'owner' || job.role === 'admin'
    for (const rule of rules) {
      if (!rule.enabled || (rule.exemptAdmins && admin) || !matches(rule.conditions, job, decision)) continue
      for (const action of rule.actions) {
        await apply(ctx, job, decision, rule, action)
        if (decision.block !== null) return
      }
      await reestimate(ctx, job, decision)
    }
  },
}
