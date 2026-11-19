// Plain-language wording for printer access (docs/printer-access.md). Re-exported from words.ts.
import { type AccessExplanation, type AccessSubject, BUILT_IN_ROLES, type GroupMember, NO_ACCESS, type PrinterPermission, withImplied } from '@shared/access'
import { plural } from './format'

export const PERMISSION_WORDS: Record<PrinterPermission, { label: string; help: string; phrase: string }> = {
  view: { label: 'See it', help: 'See the printer, its status, supplies, and options', phrase: 'see it' },
  print: { label: 'Print', help: 'Print to it from anywhere, print test pages, and make it beep or flash', phrase: 'print' },
  'jobs.read': {
    label: 'See everyone’s jobs',
    help: 'See everyone’s print jobs on it and download their documents. Without this, people see only their own',
    phrase: 'see everyone’s jobs',
  },
  'jobs.manage': { label: 'Manage everyone’s jobs', help: 'Cancel, retry, and delete anyone’s print jobs on it', phrase: 'manage everyone’s jobs' },
  settings: {
    label: 'Change settings',
    help: 'Rename it, set where it is and its default options, add or remove it, and share it on the local network',
    phrase: 'change its settings',
  },
  access: { label: 'Choose who has access', help: 'Change who can use this printer and what they can do', phrase: 'choose who has access' },
}

const capitalized = (text: string) => text.charAt(0).toUpperCase() + text.slice(1)

/** "a", "a and b", "a, b, and c". */
export function joinAnd(parts: string[]): string {
  if (parts.length <= 2) return parts.join(' and ')
  return `${parts.slice(0, -1).join(', ')}, and ${parts[parts.length - 1]}`
}

/** "can see it and print", for sentences like "Sam can see it and print". */
export function canPhrase(permissions: readonly PrinterPermission[]): string {
  const all = withImplied(permissions)
  if (all.length === 0) return 'can’t use this printer'
  if (all.length === BUILT_IN_ROLES.manager.permissions.length) return 'can do everything'
  const shown = all.filter((p) => !(p === 'jobs.read' && all.includes('jobs.manage')))
  return `can ${joinAnd(shown.map((p) => PERMISSION_WORDS[p].phrase))}`
}

/** "Can see it and print", or "No access". */
export function permissionSummary(permissions: readonly PrinterPermission[]): string {
  return withImplied(permissions).length === 0 ? 'No access' : capitalized(canPhrase(permissions))
}

/** A role's display name from its id: built-in, custom (from `roles`), or No access. */
export function roleName(id: string, roles: readonly { id: string; name: string }[] = []): string {
  if (id === NO_ACCESS) return 'No access'
  if (id in BUILT_IN_ROLES) return BUILT_IN_ROLES[id as keyof typeof BUILT_IN_ROLES].name
  return roles.find((r) => r.id === id)?.name ?? 'A removed role'
}

export const SUBJECT_KINDS: Record<AccessSubject['type'], string> = {
  everyone: 'Everyone in the workspace',
  user: 'Person',
  group: 'Group',
  client: 'Device',
}

/** "2 people and 1 device", or "No one yet". */
export function groupSize(members: readonly Pick<GroupMember, 'type'>[]): string {
  const people = members.filter((m) => m.type === 'user').length
  const devices = members.length - people
  const parts = [people && plural(people, 'person', 'people'), devices && plural(devices, 'device')].filter(Boolean) as string[]
  return parts.length ? joinAnd(parts) : 'No one yet'
}

export function extensionUsage(workspaces: number): string {
  return workspaces === 0 ? 'No workspace has turned it on yet' : `Turned on in ${plural(workspaces, 'workspace')}`
}

export interface ReasonNames {
  role: (id: string) => string
  subject: (subject: AccessSubject) => string
  /** Whether a grant applies to every printer rather than just this one. */
  everyPrinter: (grantId: string | undefined) => boolean
}

/** One line of "why" for an access check, e.g. "In the Office group, which has the User role on every printer". */
export function accessReason(source: AccessExplanation['sources'][number], names: ReasonNames): string {
  const role = `the ${names.role(source.role)} role`
  if (source.kind === 'workspace-role') {
    return `Workspace ${source.role === 'owner' ? 'owner' : 'admin'}, which allows everything on every printer`
  }
  if (source.kind === 'everyone') return `Everyone has ${role} on this printer`
  const where = names.everyPrinter(source.grantId) ? 'on every printer' : 'on this printer'
  switch (source.via?.type) {
    case 'group':
      return `In the ${names.subject(source.via)} group, which has ${role} ${where}`
    case 'client':
      return `This device has ${role} ${where}`
    case 'everyone':
      return `Everyone has ${role} ${where}`
    default:
      return `Given ${role} ${where}`
  }
}

export const VIEW_ONLY = 'You can see this printer but not print to it.'

export const NO_PRINT_ACCESS = 'You can see printers here but not print to them yet. Ask an admin of this workspace to give you access.'

/** Whether a device may print to a printer, e.g. "Not allowed on this Mac" (`where` from `thisComputer`). */
export function devicePrintWords(allowed: boolean, where: string): { label: string; tone: 'ok' | 'neutral' } {
  return allowed ? { label: 'Can print', tone: 'ok' } : { label: `Not allowed on ${where}`, tone: 'neutral' }
}
