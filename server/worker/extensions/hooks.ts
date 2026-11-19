import type { PrinterPermission } from '../../shared/access'
import type { ExtensionId } from '../../shared/extensions'
import type { DocType, Job, JobHold, JobNote, JobOptions, JobSource, JobUsage } from '../../shared/printing'
import type { Role } from '../../shared/types'
import type { UsageImpact } from '../../shared/usage'
import type { JobViewRow, PrinterViewRow } from '../db/rows'
import type { Ctx } from '../services/context'
import type { Access } from '../services/permissions'
import { enterpriseCron, enterpriseFinish, enterpriseOff, enterpriseView } from './enterprise/hooks'
import { ENTERPRISE_STEPS } from './enterprise/steps'
import { limitsStep } from './print-policies/limits-step'
import { rulesStep } from './print-policies/rules-step'
import { printerAccessPolicy } from './printer-access/hook'
import { settlement } from './usage/settle'
import { settlementSweep } from './usage/sweep'

/** Whoever wants to use a printer, as the core knows them. */
export type AccessPrincipal =
  | { kind: 'member'; userId: string; role: Role }
  | { kind: 'device'; clientId: string }
  /** Any member or device of a group. */
  | { kind: 'group'; groupId: string }
  /** Gets only what Everyone gets: the Everyone subject, or an allowlisted email sender who is not a member. */
  | { kind: 'everyone' }

/** An active extension's answer for one workspace. */
export interface PrinterPolicy {
  /** Empty means the printer does not exist for this principal. */
  permissions(principal: AccessPrincipal, printerId: string): readonly PrinterPermission[]
}

/** The hook the core asks "what may this actor do with this printer?"; extensions never patch core services. */
export interface PrinterPolicyHook {
  extension: ExtensionId
  load(env: Env, workspaceId: string): Promise<PrinterPolicy>
}

const PRINTER_POLICY_HOOKS: PrinterPolicyHook[] = [printerAccessPolicy]

/** The policy of the first active extension that has one; null keeps the core's own rules. */
export async function printerPolicy(env: Env, workspaceId: string, active: (id: ExtensionId) => Promise<boolean>): Promise<PrinterPolicy | null> {
  for (const hook of PRINTER_POLICY_HOOKS) if (await active(hook.extension)) return hook.load(env, workspaceId)
  return null
}

// ---- The job check (docs/usage.md): every path asks these before a job is queued ----

/** A job about to be queued, built by the core after printer access allowed it. Steps never change it. */
export interface JobDraft {
  workspaceId: string
  /** The job's id, also before its row exists. */
  jobId: string
  /** 1, or the next attempt on retry. */
  attempt: number
  source: Exclude<JobSource, 'lan'>
  /** The member who sent it; null for devices and for email senders who aren't members. */
  userId: string | null
  role: Role | null
  /** Source `device`: the computer it came from. */
  clientId: string | null
  /** Printer access groups of the member or device; empty while Printer access is off. */
  groups: readonly string[]
  /** The sender's printer access: a redirect needs `print` on the new printer. */
  access: Access
  contentType: DocType
  size: number
  /** Pages in the document before ranges and copies. Null when not counted (yet), which counts as 1. */
  documentPages: number | null
  /** The sender's `costCenter` input, unchecked; only Enterprise controls reads it. */
  costCenter: unknown
  /** The workspace time zone, for time conditions and cycles. */
  timeZone: string
  at: number
}

/** The check so far. Each step sees the job as earlier steps left it. */
export interface JobDecision {
  printer: PrinterViewRow
  /** The job's own options; conditions and counts apply them over the printer's defaults. */
  options: JobOptions
  notes: JobNote[]
  /** Why steps want approval. Only Enterprise controls turns these into a hold. */
  approval: string[]
  /** A rule asked to hold the job until its sender releases it. */
  release: boolean
  hold: JobHold | null
  costCenterId: string | null
  /** Recomputed by the core after every step. */
  usage: JobUsage
  /** Limits and budgets the job counts against, for previews and alerts. */
  meters: UsageImpact[]
  /** The refusal message; no later step runs. */
  block: string | null
  /** Side effects (alerts, approval emails) run once the job is stored; never for previews or refusals. */
  after: ((ctx: Ctx, job: Job) => Promise<void>)[]
}

export type JobStepName = 'rules' | 'limits' | 'cost-center' | 'budgets' | 'approval' | 'release'

/** One stage of the check, run only while its extension is active. It changes `decision` and stores nothing. */
export interface JobStep {
  extension: ExtensionId
  name: JobStepName
  run(ctx: Ctx, job: JobDraft, decision: JobDecision): Promise<void>
}

/** In `JobStepName` order: rules and limits (print-policies), then the four enterprise steps. */
export const JOB_STEPS: JobStep[] = [rulesStep, limitsStep, ...ENTERPRISE_STEPS]

/** Runs once jobs end (completed, failed or canceled), with their rows as they ended. */
export interface JobFinishHook {
  /** Null: runs with both extensions off too, so usage recorded earlier still settles. */
  extension: ExtensionId | null
  finished(ctx: Ctx, workspaceId: string, jobs: readonly JobViewRow[]): Promise<void>
}

/** Usage settlement first, then Enterprise controls' retention. */
export const JOB_FINISH_HOOKS: JobFinishHook[] = [settlement, enterpriseFinish]

/** Who is looking at a job; `report` is anyone else, such as an email or an export. */
export type JobViewer = { kind: 'member'; userId: string; role: Role } | { kind: 'device'; clientId: string } | { kind: 'report' }

export type JobView = (job: Job, viewer: JobViewer) => Job

/** Changes what a viewer sees of a job; Enterprise controls hides document names. */
export interface JobViewHook {
  extension: ExtensionId
  /** Null when it changes nothing in this workspace. */
  load(env: Env, workspaceId: string): Promise<JobView | null>
}

export const JOB_VIEW_HOOKS: JobViewHook[] = [enterpriseView]

/** Runs after an extension stops applying in these workspaces, by either switch. */
export interface ExtensionOffHook {
  extension: ExtensionId
  turnedOff(ctx: Ctx, workspaceIds: readonly string[]): Promise<void>
}

/** Enterprise controls cancels held jobs here. */
export const EXTENSION_OFF_HOOKS: ExtensionOffHook[] = [enterpriseOff]

/** Work for the 15-minute cron. Each task finds the workspaces it applies to. */
export interface CronHook {
  name: string
  run(env: Env): Promise<void>
}

/** Usage settlement sweep, held job expiry, scheduled reports. */
export const CRON_HOOKS: CronHook[] = [settlementSweep, enterpriseCron]
