import type {
  AccessExplanation,
  AccessSubject,
  Group,
  PrinterAccess,
  PrinterAccessSummary,
  PrinterGrant,
  PrinterPermission,
  PrinterRole,
  WorkspaceAccess,
} from '@shared/access'
import { subjectParam } from '@/lib/api/access'
import { enc, http, items, qs } from '@/lib/api/http'

export interface RoleInput {
  name: string
  description?: string | null
  permissions: PrinterPermission[]
}

const base = (ws: string) => `/workspaces/${enc(ws)}`
type List<T> = T[] | { items: T[] }

export const accessApi = {
  workspace: (ws: string) => http.get<WorkspaceAccess>(`${base(ws)}/access`),
  setDefaultRole: (ws: string, defaultRole: string) => http.patch<WorkspaceAccess>(`${base(ws)}/access`, { defaultRole }),
  summaries: async (ws: string) => items(await http.get<List<PrinterAccessSummary>>(`${base(ws)}/access/printers`)),
  explain: (ws: string, printerId: string, subject: AccessSubject) =>
    http.get<AccessExplanation>(`${base(ws)}/access/explain${qs({ printer: printerId, subject: subjectParam(subject) })}`),

  createRole: (ws: string, input: RoleInput) => http.post<PrinterRole>(`${base(ws)}/access/roles`, input),
  updateRole: (ws: string, id: string, input: Partial<RoleInput>) => http.patch<PrinterRole>(`${base(ws)}/access/roles/${enc(id)}`, input),
  deleteRole: (ws: string, id: string) => http.del(`${base(ws)}/access/roles/${enc(id)}`),

  grantEveryPrinter: (ws: string, subject: AccessSubject, role: string) =>
    http.post<PrinterGrant>(`${base(ws)}/access/grants`, { subject, role }),
  revoke: (ws: string, grantId: string) => http.del(`${base(ws)}/access/grants/${enc(grantId)}`),

  printer: (ws: string, printerId: string) => http.get<PrinterAccess>(`${base(ws)}/printers/${enc(printerId)}/access`),
  setEveryone: (ws: string, printerId: string, everyoneRole: string | null) =>
    http.patch<PrinterAccess>(`${base(ws)}/printers/${enc(printerId)}/access`, { everyoneRole }),
  grantPrinter: (ws: string, printerId: string, subject: AccessSubject, role: string) =>
    http.post<PrinterGrant>(`${base(ws)}/printers/${enc(printerId)}/access/grants`, { subject, role }),

  groups: async (ws: string) => items(await http.get<List<Group>>(`${base(ws)}/groups`)),
  createGroup: (ws: string, input: { name: string; description?: string | null }) => http.post<Group>(`${base(ws)}/groups`, input),
  updateGroup: (ws: string, id: string, input: { name?: string; description?: string | null }) =>
    http.patch<Group>(`${base(ws)}/groups/${enc(id)}`, input),
  deleteGroup: (ws: string, id: string) => http.del(`${base(ws)}/groups/${enc(id)}`),
  setGroupMember: (ws: string, id: string, member: { type: 'user' | 'client'; id: string }, inGroup: boolean) => {
    const path = `${base(ws)}/groups/${enc(id)}/members/${member.type}/${enc(member.id)}`
    return inGroup ? http.put<unknown>(path, {}) : http.del(path)
  },
}
