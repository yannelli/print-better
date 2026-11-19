// Printer and job types. Mirrored in client/crates/print/src/model.rs; keep both in sync.

export type RouteKind = 'ipps' | 'ipp' | 'socket' | 'lpd' | 'usb' | 'os'

export interface Route {
  kind: RouteKind
  uri: string
}

export type PrinterState = 'idle' | 'printing' | 'stopped' | 'offline' | 'unknown'

export interface Supply {
  name: string
  kind: 'toner' | 'ink' | 'drum' | 'waste' | 'other'
  color: string | null
  /** 0..100, or -1 when the printer does not report a level. */
  level: number
}

export interface PrinterStatus {
  state: PrinterState
  /** IPP printer-state-reasons keywords without severity suffixes, e.g. "media-empty". */
  reasons: string[]
  message: string | null
  supplies: Supply[]
}

export interface Capabilities {
  /** MIME types the printer accepts natively. */
  formats: string[]
  color: boolean
  duplex: boolean
  /** PWG self-describing media names, e.g. "na_letter_8.5x11in". */
  media: string[]
  mediaDefault: string | null
  resolutions: number[]
  copiesMax: number
  /** Paper trays (IPP media-source keywords, e.g. "auto", "tray-1"); absent when unknown or from older devices. */
  sources?: string[]
  /** Paper types (IPP media-type keywords, e.g. "stationery", "labels"); absent when unknown. */
  mediaTypes?: string[]
  /** Absent when unknown, which means any quality may be asked for. */
  qualities?: Quality[]
}

/** What a client knows about one physical printer. `key` is stable per client. */
export interface PrinterReport {
  key: string
  name: string
  makeModel: string | null
  uuid: string | null
  location: string | null
  local: boolean
  /** Ordered by preference; the client fails over down the list. */
  routes: Route[]
  capabilities: Capabilities
  status: PrinterStatus
}

export interface PrinterSettings {
  lanShare: boolean
  email: { enabled: boolean; alias: string | null }
}

export const DEFAULT_PRINTER_SETTINGS: PrinterSettings = {
  lanShare: true,
  email: { enabled: false, alias: null },
}

export type Sides = 'one-sided' | 'two-sided-long-edge' | 'two-sided-short-edge'
export type Quality = 'draft' | 'normal' | 'high'

export interface JobOptions {
  copies?: number
  media?: string
  sides?: Sides
  colorMode?: 'auto' | 'color' | 'monochrome'
  orientation?: 'auto' | 'portrait' | 'landscape'
  pageRanges?: string
  fit?: 'fit' | 'fill' | 'none'
  quality?: Quality
  /** Paper tray, one of `capabilities.sources`. */
  source?: string
  /** Paper type, one of `capabilities.mediaTypes`. */
  mediaType?: string
}

export interface Printer extends PrinterReport {
  id: string
  workspaceId: string
  clientId: string
  clientName: string
  clientOnline: boolean
  added: boolean
  defaults: JobOptions
  settings: PrinterSettings
  createdAt: number
  updatedAt: number
}

/** `held` exists only with Enterprise controls: waiting for approval or release (docs/enterprise.md). */
export type JobStatus = 'uploading' | 'held' | 'queued' | 'dispatched' | 'printing' | 'completed' | 'failed' | 'canceled'
export type JobSource = 'web' | 'api' | 'mcp' | 'email' | 'lan' | 'test' | 'device'

export const TERMINAL_JOB_STATUSES: readonly JobStatus[] = ['completed', 'failed', 'canceled']

/** Formats accepted for upload in phase 1. */
export const DOC_TYPES = ['application/pdf', 'image/jpeg', 'image/png', 'text/plain'] as const
export type DocType = (typeof DOC_TYPES)[number]

/** Something that checked or changed a job before it printed (docs/usage.md). */
export interface JobNote {
  source: 'rule' | 'limit' | 'budget' | 'cost-center' | 'approval' | 'release'
  /** The rule, limit, budget or cost center; null for approvals and releases. */
  id: string | null
  /** Its name, or the approver's, when the note was written. */
  name: string
  /** One plain sentence, e.g. "Printed two-sided". */
  message: string
}

export interface JobPolicy {
  /** In the order they happened. */
  notes: JobNote[]
  /** What the sender asked for, kept when a rule changed the printer or options. */
  requested?: { printerId: string; options: JobOptions }
}

/** Why a `held` job waits, and when it is canceled if nobody acts. */
export interface JobHold {
  kind: 'approval' | 'release'
  until: number
  /** Approval: why the job needs one, e.g. "Over the limit Monthly pages". */
  reasons?: string[]
  /** Approval: once approved, the job waits for its sender to release it. */
  release?: boolean
}

/** The current attempt's usage: estimated when it is queued, then what printed. */
export interface JobUsage {
  /** Pages in the document, before page ranges and copies; null when they couldn't be counted. */
  documentPages: number | null
  /** Printed sides, times copies. */
  pages: number
  sheets: number
  colorPages: number
  /** Millionths of the workspace currency. */
  costMicros: number
  /** False once the job ended and its printed pages are known. */
  estimated: boolean
}

export interface Job {
  id: string
  workspaceId: string
  printerId: string | null
  printerName: string | null
  userId: string | null
  source: JobSource
  title: string
  fileName: string | null
  contentType: string
  size: number
  options: JobOptions
  status: JobStatus
  statusMessage: string | null
  pages: number | null
  attempts: number
  hasFile: boolean
  createdAt: number
  updatedAt: number
  completedAt: number | null
  /** Source `device`: the paired device that submitted it (null once that device is removed). */
  sourceClientId: string | null
  sourceClientName: string | null
  /** Source `device`: the computer account that printed, e.g. from IPP requesting-user-name. */
  requestedBy: string | null
  /** The fields below are absent until Print rules and limits or Enterprise controls set them (docs/usage.md). */
  policy?: JobPolicy
  /** Present exactly while `status` is `held`. */
  held?: JobHold
  costCenterId?: string
  usage?: JobUsage
}
