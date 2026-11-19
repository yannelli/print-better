import { LEGACY_MEMBER_PERMISSIONS, type MyPrinterAccess, type PrinterPermission } from '@shared/access'
import type { Job, Role } from '@shared/types'

export interface PrinterRights {
  /** Printer access is active in this workspace. */
  managed: boolean
  /** Owner or admin: everything on every printer. */
  all: boolean
  can: (printerId: string | null | undefined, permission: PrinterPermission) => boolean
  /** The permission on at least one printer. */
  canAny: (permission: PrinterPermission) => boolean
}

/** Until `/access/me` answers, and while printer access is off, today's role rules apply unchanged. */
export function printerRights(me: MyPrinterAccess | undefined, role: Role | undefined): PrinterRights {
  const all = me?.all ?? (role === 'owner' || role === 'admin')
  const managed = me?.managed ?? false
  const can = (printerId: string | null | undefined, permission: PrinterPermission) => {
    if (all) return true
    if (!managed) return LEGACY_MEMBER_PERMISSIONS.includes(permission)
    return !!printerId && !!me?.printers[printerId]?.includes(permission)
  }
  const canAny = (permission: PrinterPermission) =>
    all || (managed ? Object.values(me?.printers ?? {}).some((list) => list.includes(permission)) : LEGACY_MEMBER_PERMISSIONS.includes(permission))
  return { managed, all, can, canAny }
}

export interface JobRights {
  cancel: boolean
  retry: boolean
  remove: boolean
}

/** Cancel and retry your own jobs, or anyone's with `jobs.manage` on the job's printer; deleting needs `jobs.manage`. */
export function jobRights(job: Pick<Job, 'userId' | 'printerId'>, userId: string | null | undefined, rights: PrinterRights): JobRights {
  const own = !!userId && job.userId === userId
  const mayHandle = own || rights.can(job.printerId, 'jobs.manage')
  return {
    cancel: mayHandle,
    retry: mayHandle && rights.can(job.printerId, 'print'),
    remove: rights.can(job.printerId, 'jobs.manage'),
  }
}

/** Enterprise controls: owners and admins approve any held job; with Printer access, `jobs.manage` approves other people's. */
export const mayApprove = (job: Pick<Job, 'userId' | 'printerId'>, userId: string | null | undefined, rights: PrinterRights): boolean =>
  rights.all || (rights.managed && job.userId !== userId && rights.can(job.printerId, 'jobs.manage'))
