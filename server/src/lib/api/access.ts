import type { AccessSubject, MyPrinterAccess, PrinterPermission } from '@shared/access'
import { enc, http, qs } from './http'

/** `GET /access/subject`: one person's or device's permissions on every printer (admins). */
export interface SubjectPrinterAccess {
  printers: Record<string, PrinterPermission[]>
}

/** `user:abc`, or `everyone`, as the access routes expect. */
export const subjectParam = (subject: AccessSubject) => (subject.type === 'everyone' ? 'everyone' : `${subject.type}:${subject.id}`)

/** Both work with printer access off too: they then report today's role-based rules. */
export const myAccess = (ws: string) => http.get<MyPrinterAccess>(`/workspaces/${enc(ws)}/access/me`)
export const subjectAccess = (ws: string, subject: AccessSubject) =>
  http.get<SubjectPrinterAccess>(`/workspaces/${enc(ws)}/access/subject${qs({ subject: subjectParam(subject) })}`)
