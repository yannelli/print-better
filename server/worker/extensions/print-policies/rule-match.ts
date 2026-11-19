import type { FileKind, RuleConditions } from '../../../shared/policies'
import type { DocType } from '../../../shared/printing'
import { MB } from '../../http/body'
import type { JobDecision, JobDraft } from '../hooks'
import { localTime } from '../usage/cycles'
import { asksTwoSided, copiesOf, printerFacts, printsInColor } from '../usage/estimate'

const FILE_KINDS: Record<DocType, FileKind> = { 'application/pdf': 'pdf', 'image/jpeg': 'image', 'image/png': 'image', 'text/plain': 'text' }

const minutes = (hhmm: string): number => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3))

/** On one of `days`, from `from` to `to` in the workspace time zone. A window past midnight belongs to the day it starts; equal times mean all day. */
export function inWindow(time: NonNullable<RuleConditions['time']>, timeZone: string, at: number): boolean {
  const now = localTime(timeZone, at)
  const t = now.hour * 60 + now.minute
  const [from, to] = [minutes(time.from), minutes(time.to)]
  const on = (weekday: number) => time.days.includes((weekday + 7) % 7)
  if (from === to) return on(now.weekday)
  if (from < to) return on(now.weekday) && t >= from && t < to
  return (on(now.weekday) && t >= from) || (on(now.weekday - 1) && t < to)
}

/** Every condition the rule sets matches the job, as earlier rules left it. */
export function matches(c: RuleConditions, job: JobDraft, d: JobDecision): boolean {
  const printer = printerFacts(d.printer)
  const sender = (s: NonNullable<RuleConditions['who']>[number]) =>
    s.type === 'user' ? s.id === job.userId : s.type === 'client' ? s.id === job.clientId : job.groups.includes(s.id)
  if (c.who && !c.who.some(sender)) return false
  if (c.sources && !c.sources.includes(job.source)) return false
  if (c.printers && !c.printers.includes(d.printer.id)) return false
  if (c.pages?.min !== undefined && d.usage.pages < c.pages.min) return false
  if (c.pages?.max !== undefined && d.usage.pages > c.pages.max) return false
  if (c.minCopies !== undefined && copiesOf(printer, d.options) < c.minCopies) return false
  if (c.color !== undefined && printsInColor(printer, d.options) !== c.color) return false
  if (c.sides && (asksTwoSided(printer, d.options) ? 'two-sided' : 'one-sided') !== c.sides) return false
  if (c.fileKinds && !c.fileKinds.includes(FILE_KINDS[job.contentType])) return false
  if (c.minSizeMb !== undefined && job.size < c.minSizeMb * MB) return false
  if (c.time && !inWindow(c.time, job.timeZone, job.at)) return false
  return true
}
