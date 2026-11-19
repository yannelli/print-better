import type { PrinterPermission } from '../../shared/access'
import type { ExtensionId } from '../../shared/extensions'
import type { Role } from '../../shared/types'
import { printerAccessPolicy } from './printer-access/hook'

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
