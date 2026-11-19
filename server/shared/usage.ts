// The job check, page counts, usage, cycles and prices shared by Print rules and limits and
// Enterprise controls (docs/usage.md). Active while either of them is.

import type { ExtensionId } from './extensions'
import type { DocType, JobHold, JobNote, JobOptions, JobUsage } from './printing'

/** The extensions that check jobs and count usage. */
export const USAGE_EXTENSIONS: readonly ExtensionId[] = ['print-policies', 'enterprise']

/** Money: an integer number of millionths of the workspace currency, so 25000 is 0.025. */
export type Micros = number

export const DEFAULT_CURRENCY = 'USD'
export const DEFAULT_TIME_ZONE = 'UTC'

/** When usage starts over: local midnight in the workspace time zone. */
export type Cycle =
  | { kind: 'day' }
  /** `firstDay`: 0 is Sunday, 6 is Saturday. */
  | { kind: 'week'; firstDay: number }
  /** `startDay`: 1 to 28. */
  | { kind: 'month'; startDay: number }
  /** `startMonth`: 1 to 12, when the first quarter, or the year, starts. */
  | { kind: 'quarter'; startMonth: number }
  | { kind: 'year'; startMonth: number }

export type CycleKind = Cycle['kind']

/** What a limit or budget counts; `cost` is in micros. */
export type UsageUnit = 'pages' | 'sheets' | 'jobs' | 'cost'

/** What happens to a job that would go over a limit or budget. */
export type OverAction = 'block' | 'warn' | 'approval'

/** A limit's or budget's current cycle. */
export interface UsageMeter {
  unit: UsageUnit
  /** Includes jobs still waiting or printing. */
  used: number
  /** The amount plus this cycle's extra allowance. */
  amount: number
  left: number
  /** The cycle as instants; `end` is when it resets. */
  start: number
  end: number
}

/** A limit or budget a job counts against, as the check saw it before the job. */
export interface UsageImpact extends UsageMeter {
  kind: 'limit' | 'budget'
  id: string
  name: string
  action: OverAction
  /** This job would take it over its amount. */
  over: boolean
}

export interface PriceList {
  bwPageMicros: Micros
  colorPageMicros: Micros
  /** Taken off for each sheet printed on both sides. */
  duplexSheetDiscountMicros: Micros
}

export const DEFAULT_PRICES: PriceList = { bwPageMicros: 0, colorPageMicros: 0, duplexSheetDiscountMicros: 0 }

/** `GET /api/workspaces/:ws/prices` */
export interface Prices {
  /** ISO 4217, e.g. "USD". */
  currency: string
  /** IANA name, e.g. "America/Chicago"; cycles and time conditions use it. */
  timeZone: string
  default: PriceList
  /** Printers with their own prices; the others use `default`. */
  printers: Record<string, PriceList>
}

/** `PUT /api/workspaces/:ws/prices`: omitted fields stay; a printer set to null goes back to the default. */
export interface PricesUpdate {
  currency?: string
  timeZone?: string
  default?: PriceList
  printers?: Record<string, PriceList | null>
}

/** `POST /api/workspaces/:ws/jobs/preview`: the body of `POST /jobs` without the document. */
export interface JobPreviewRequest {
  printerId?: string
  options?: JobOptions
  contentType: DocType
  size: number
  /** The caller's own count, used for this preview only: jobs are always counted again. */
  documentPages?: number | null
  /** Enterprise controls: a cost center id or code. */
  costCenter?: string
}

/** What would happen to the job if it were sent now. */
export interface JobPreview {
  /** The refusal message, or null when the job would be accepted. */
  block: string | null
  printerId: string
  options: JobOptions
  notes: JobNote[]
  hold: JobHold['kind'] | null
  costCenterId: string | null
  usage: JobUsage
  meters: UsageImpact[]
}

/** Random access to a document, so pages are counted without reading all of it. */
export interface ByteSource {
  size: number
  read(offset: number, length: number): Promise<Uint8Array>
}
