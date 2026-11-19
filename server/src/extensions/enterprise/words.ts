import type { EnterpriseSettings, ReportDimension } from '@shared/enterprise'
import type { Job } from '@shared/types'
import type { OverAction } from '@shared/usage'
import type { PrinterRights } from '@/lib/access'
import { plural } from '@/lib/format'

export type Part = keyof EnterpriseSettings

export const PARTS: { id: Part; label: string; summary: string }[] = [
  { id: 'approvals', label: 'Approvals', summary: 'Jobs wait until an owner, an admin, or a manager of the printer approves them.' },
  { id: 'release', label: 'Secure release', summary: 'Jobs wait until the person who sent them releases them at the printer.' },
  { id: 'costCenters', label: 'Cost centers', summary: 'Charge printing to departments, projects, or clients, with budgets per cycle.' },
  { id: 'reports', label: 'Reports', summary: 'Usage by member, group, device, printer, cost center, or source, and the audit export.' },
  { id: 'alerts', label: 'Alerts', summary: 'Emails at 80% and 100% of every limit and budget.' },
  { id: 'privacy', label: 'Retention and privacy', summary: 'Delete documents as soon as jobs finish, and hide document names.' },
]

/** Someone who may approve at least some jobs. */
export const isApprover = (rights: PrinterRights): boolean => rights.all || (rights.managed && rights.canAny('jobs.manage'))

export const mayRelease = (job: Pick<Job, 'userId'>, userId: string | undefined, rights: PrinterRights): boolean => rights.all || (!!userId && job.userId === userId)

/** "in 3 hours", "in 12 minutes", or "now" for a hold that is about to run out. */
export function untilWords(at: number, now = Date.now()): string {
  const minutes = Math.round((at - now) / 60_000)
  if (minutes < 1) return 'now'
  if (minutes < 60) return `in ${plural(minutes, 'minute')}`
  const hours = Math.round(minutes / 60)
  return hours < 48 ? `in ${plural(hours, 'hour')}` : `in ${plural(Math.round(hours / 24), 'day')}`
}

export const hoursLabel = (hours: number) => (hours % 24 === 0 && hours >= 48 ? `${hours / 24} days` : plural(hours, 'hour'))

export const OVER_ACTIONS: { value: OverAction; label: string; description: string }[] = [
  { value: 'block', label: 'Block', description: 'Jobs that would go over are refused' },
  { value: 'warn', label: 'Warn and allow', description: 'Jobs print with a note on them' },
  { value: 'approval', label: 'Require approval', description: 'Jobs wait for an approver; blocks while approvals are off' },
]

export const DIMENSIONS: { value: ReportDimension; label: string }[] = [
  { value: 'member', label: 'Member' },
  { value: 'group', label: 'Group' },
  { value: 'device', label: 'Device' },
  { value: 'printer', label: 'Printer' },
  { value: 'cost-center', label: 'Cost center' },
  { value: 'source', label: 'Source' },
]

/** A local date as YYYY-MM-DD, for report ranges. */
export const isoDay = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
