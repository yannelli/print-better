import type { MyPrinterAccess } from '@shared/access'
import { enc, http } from './http'

/** Works with printer access off too: it then reports today's role-based rules. */
export const myAccess = (ws: string) => http.get<MyPrinterAccess>(`/workspaces/${enc(ws)}/access/me`)
