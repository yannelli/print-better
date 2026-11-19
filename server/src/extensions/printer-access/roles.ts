import { NO_ACCESS, type PrinterRole, type WorkspaceAccess } from '@shared/access'
import { permissionSummary, roleName, type ReasonNames } from '@/lib/words'
import type { Choice } from '@/routes/settings/fields'
import { type SubjectSources, subjectName } from './subjects'

/** Everyone selector value meaning "follow the workspace default" (`everyoneRole: null`). */
export const WORKSPACE_DEFAULT = 'default'

export function roleChoice(role: PrinterRole): Choice<string> {
  return { value: role.id, label: role.name, description: role.description || permissionSummary(role.permissions) }
}

/** Role options for a select: optionally led by "Workspace default (User)" and ended by "No access". */
export function roleChoices(
  access: Pick<WorkspaceAccess, 'roles' | 'defaultRole'>,
  extra: { workspaceDefault?: boolean; none?: string } = {},
): Choice<string>[] {
  const choices = access.roles.map(roleChoice)
  if (extra.workspaceDefault) {
    choices.unshift({
      value: WORKSPACE_DEFAULT,
      label: `Workspace default (${roleName(access.defaultRole, access.roles)})`,
      description: 'Follows the default in Workspace settings',
    })
  }
  if (extra.none) choices.push({ value: NO_ACCESS, label: 'No access', description: extra.none })
  return choices
}

/** Names for `accessReason`, from what the page has loaded. */
export function reasonNames(access: WorkspaceAccess, sources: SubjectSources): ReasonNames {
  const wide = new Set(access.grants.map((g) => g.id))
  return {
    role: (id) => roleName(id, access.roles),
    subject: (subject) => subjectName(subject, sources),
    everyPrinter: (grantId) => !!grantId && wide.has(grantId),
  }
}
