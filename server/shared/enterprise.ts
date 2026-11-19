// Enterprise controls (docs/enterprise.md). Shared parts live in usage.ts.

import type { Cycle, OverAction, UsageMeter } from './usage'

/** Each part has its own switch, off until an admin turns it on. */
export interface EnterpriseSettings {
  approvals: { enabled: boolean; expiryHours: number }
  release: { enabled: boolean; expiryHours: number }
  /** `required`: every job needs a cost center. */
  costCenters: { enabled: boolean; required: boolean }
  reports: { enabled: boolean }
  /** `recipients`: member ids for admin alerts; null means every owner and admin. */
  alerts: { enabled: boolean; personal: boolean; admins: boolean; recipients: string[] | null }
  /** Only owners change these. */
  privacy: { enabled: boolean; deleteWhenFinished: boolean; ownerOnlyNames: boolean; adminsSeeNames: boolean }
}

export const DEFAULT_ENTERPRISE_SETTINGS: EnterpriseSettings = {
  approvals: { enabled: false, expiryHours: 24 },
  release: { enabled: false, expiryHours: 4 },
  costCenters: { enabled: false, required: false },
  reports: { enabled: false },
  alerts: { enabled: false, personal: true, admins: true, recipients: null },
  privacy: { enabled: false, deleteWhenFinished: false, ownerOnlyNames: false, adminsSeeNames: false },
}

/** `PATCH /enterprise`: each part is merged. */
export type EnterpriseSettingsUpdate = { [K in keyof EnterpriseSettings]?: Partial<EnterpriseSettings[K]> }

/** A printer's own controls. */
export interface PrinterControls {
  /** Every job needs approval. */
  approval: boolean
  /** Hold every job until the sender releases it. */
  secureRelease: boolean
}

/** `GET /enterprise` */
export interface EnterpriseConfig {
  settings: EnterpriseSettings
  /** Printers with a control turned on. */
  printers: Record<string, PrinterControls>
}

export interface CostCenter {
  id: string
  name: string
  code: string | null
  /** Inactive ones can't be picked but keep their history. */
  active: boolean
  createdAt: number
  updatedAt: number
}

/** `POST /cost-centers`; `PATCH /cost-centers/:id` takes any of these. */
export interface CostCenterInput {
  name: string
  code?: string | null
  active?: boolean
}

/** `GET /cost-centers` */
export interface CostCenterList {
  costCenters: CostCenter[]
  /** What the caller's jobs are charged to when they don't pick one. */
  myDefault: string | null
}

/** `GET /cost-centers/defaults`: member, group and device ids to cost center ids. */
export interface CostCenterDefaults {
  members: Record<string, string>
  groups: Record<string, string>
  devices: Record<string, string>
}

/** `PUT /cost-centers/defaults`: merged; null removes a default. */
export type CostCenterDefaultsUpdate = { [K in keyof CostCenterDefaults]?: Record<string, string | null> }

export interface Budget {
  id: string
  costCenterId: string
  enabled: boolean
  unit: 'cost' | 'pages'
  /** Micros for cost. */
  amount: number
  cycle: Cycle
  action: OverAction
  createdAt: number
  updatedAt: number
}

/** `POST /budgets`; `PATCH /budgets/:id` takes any of these but `costCenterId`. */
export interface BudgetInput {
  costCenterId: string
  enabled?: boolean
  unit: 'cost' | 'pages'
  amount: number
  cycle: Cycle
  /** Default `block`. */
  action?: OverAction
}

/** `GET /budgets` */
export interface BudgetView extends Budget {
  usage: UsageMeter
}

export type ReportDimension = 'member' | 'group' | 'device' | 'printer' | 'cost-center' | 'source'

export interface UsageTotals {
  jobs: number
  pages: number
  sheets: number
  colorPages: number
  costMicros: number
}

export interface UsageReportRow extends UsageTotals {
  /** The member, group, device, printer or cost center id, or the source; null for none. */
  key: string | null
  name: string
}

/** `GET /reports/usage?by=&from=&to=`; `from` and `to` are local dates, both included. */
export interface UsageReport {
  by: ReportDimension
  from: string
  to: string
  currency: string
  rows: UsageReportRow[]
  totals: UsageTotals
  /** One entry per local day ("YYYY-MM-DD"), for the chart. */
  days: (UsageTotals & { day: string })[]
}

export interface ReportSchedule {
  id: string
  name: string
  by: ReportDimension
  /** Sent at 08:00 on the first day of each cycle, covering the one that just ended. */
  cycle: Extract<Cycle, { kind: 'week' | 'month' }>
  /** Member ids. */
  recipients: string[]
  nextRunAt: number
  lastRunAt: number | null
  createdAt: number
}

/** `POST /reports/schedules` */
export interface ReportScheduleInput {
  name: string
  by: ReportDimension
  cycle: Extract<Cycle, { kind: 'week' | 'month' }>
  recipients: string[]
}

/** `POST /jobs/:id/approve` */
export interface ApproveInput {
  note?: string
}

/** `POST /jobs/:id/deny` */
export interface DenyInput {
  reason: string
}
