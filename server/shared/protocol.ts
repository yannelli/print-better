// Wire protocol between the client daemon and the WorkspaceHub, plus browser events.
// Mirrored in client/crates/app/src/proto.rs. Semantics: docs/protocol.md.

import type { Client, ClientSettings, Os, SystemPrinters, Workspace } from './types'
import type { Capabilities, Job, JobOptions, JobStatus, Printer, PrinterReport, PrinterState, PrinterStatus, Supply } from './printing'

export const PROTOCOL_VERSION = 1
/** Client sends this text frame; the hub auto-responds with PONG without waking. */
export const PING = 'ping'
export const PONG = 'pong'
export const PING_INTERVAL_MS = 25_000
export const STALE_SOCKET_MS = 90_000
export const LOCAL_PORT = 47631
export const LAN_SHARE_PORT = 8631
/** Loopback-only IPP server that backs the desktop's queues for remote printers (docs/remote-printers.md). */
export const REMOTE_PRINT_PORT = 8632

export type CommandName = 'discover' | 'refresh' | 'identify' | 'logs' | 'diagnose' | 'restart' | 'update' | 'unpair'

/** `update` command result: the device is installing `to` and restarts when done. */
export interface UpdateResult {
  from: string
  to: string
}

// ---- client -> server ----

export interface HelloMsg {
  type: 'hello'
  protocol: number
  version: string
  os: Os
  arch: string
  hostname: string
  /** e.g. "tray", "usb", "snmp", "lan-share", "gdi", "cups" */
  features: string[]
  settings: ClientSettings
  settingsUpdatedAt: number
}

/** Full inventory snapshot from discovery; replaces this client's previous report. */
export interface PrintersMsg {
  type: 'printers'
  printers: PrinterReport[]
}

export interface PrinterStatusMsg {
  type: 'printer_status'
  key: string
  status: PrinterStatus
}

export interface JobStatusMsg {
  type: 'job_status'
  jobId: string
  status: Exclude<JobStatus, 'uploading' | 'held' | 'queued'>
  message?: string | null
  pages?: number | null
  /** `JobOffer.attempt` this report belongs to; omitted means the current attempt. */
  attempt?: number
}

/** A job that arrived over LAN sharing, reported for history only. */
export interface LanJobMsg {
  type: 'lan_job'
  localId: string
  printerKey: string
  title: string
  user: string | null
  contentType: string
  size: number
  status: JobStatus
  message?: string | null
}

export interface ResultMsg {
  type: 'result'
  id: string
  ok: boolean
  data?: unknown
  error?: string
}

/** Local settings change (e.g. `printbetter tray off`), last write wins by updatedAt. */
export interface ClientSettingsMsg {
  type: 'settings'
  settings: ClientSettings
  updatedAt: number
}

/** Sent after `welcome` and whenever it changes (docs/remote-printers.md). */
export interface SystemPrintersMsg {
  type: 'system_printers'
  report: SystemPrinters
}

export type ClientMessage =
  | HelloMsg
  | PrintersMsg
  | PrinterStatusMsg
  | JobStatusMsg
  | LanJobMsg
  | ResultMsg
  | ClientSettingsMsg
  | SystemPrintersMsg

// ---- server -> client ----

export interface PrinterConfig {
  key: string
  id: string
  name: string
  added: boolean
  lanShare: boolean
  defaults: JobOptions
}

export interface WelcomeMsg {
  type: 'welcome'
  clientId: string
  workspaceId: string
  name: string
  settings: ClientSettings
  settingsUpdatedAt: number
  serverTime: number
  printers: PrinterConfig[]
}

export interface JobOffer {
  id: string
  printerKey: string
  title: string
  contentType: string
  size: number
  sha256: string
  options: JobOptions
  /** Path relative to the server origin; fetch with the client bearer token. */
  fileUrl: string
  attempt: number
  createdAt: number
}

export interface JobMsg {
  type: 'job'
  job: JobOffer
}

export interface CancelMsg {
  type: 'cancel'
  jobId: string
}

export interface ServerSettingsMsg {
  type: 'settings'
  settings: ClientSettings
  updatedAt: number
}

/** Sent after `welcome`, after each `printers` snapshot, and when a user edits a printer. */
export interface PrinterConfigMsg {
  type: 'printer_config'
  printers: PrinterConfig[]
}

/** An added printer on another device in the workspace, shown as a local printer on desktops. */
export interface RemotePrinter {
  id: string
  name: string
  location: string | null
  makeModel: string | null
  /** The printer's own uuid, so a device that already reaches it natively can skip it. */
  uuid: string | null
  /** The device that owns the printer. */
  clientName: string
  /** The owning device is connected and the printer is not offline. */
  online: boolean
  state: PrinterState
  capabilities: Capabilities
  defaults: JobOptions
  /** Supply levels from the printer's last status, for the desktop's printer settings. */
  supplies: Supply[]
}

/** An added printer on another device (also in `printers`) that the receiver finds itself. */
export interface DirectPrinter {
  id: string
  uuid: string | null
}

/** Full snapshot, sent after `welcome` and whenever it changes for this client. */
export interface RemotePrintersMsg {
  type: 'remote_printers'
  printers: RemotePrinter[]
  /** Omitted when empty. */
  direct?: DirectPrinter[]
}

export interface CommandMsg {
  type: 'command'
  id: string
  name: CommandName
  args?: Record<string, unknown>
}

export type ServerMessage = WelcomeMsg | JobMsg | CancelMsg | ServerSettingsMsg | PrinterConfigMsg | RemotePrintersMsg | CommandMsg

// ---- server -> browser (GET /api/workspaces/:ws/events) ----

export type UiEvent =
  | { type: 'printer'; printer: Printer }
  | { type: 'printer_removed'; id: string }
  | { type: 'job'; job: Job }
  | { type: 'client'; client: Client }
  | { type: 'client_removed'; id: string }
  | { type: 'workspace'; workspace: Workspace }
  /** Printer access or an extension switch changed: refetch printers, jobs, and `/access/me`. */
  | { type: 'access' }
  /** Enterprise controls: a job started waiting for approval. Reaches whoever can see the job; approvers get a notice. */
  | { type: 'approval'; job: Job }
  /** Usage, limits, budgets or prices changed: refetch whatever shows them. */
  | { type: 'usage' }
