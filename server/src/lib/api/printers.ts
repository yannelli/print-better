import type { Job, JobOptions, Printer, PrinterSettings } from '@shared/types'
import { enc, http, items, qs } from './http'

export interface PrinterPatch {
  name?: string
  location?: string | null
  added?: boolean
  defaults?: JobOptions
  settings?: { lanShare?: boolean; email?: Partial<PrinterSettings['email']> }
}

const base = (ws: string) => `/workspaces/${enc(ws)}/printers`

export const printersApi = {
  list: async (ws: string, added?: boolean) =>
    items(await http.get<Printer[] | { items: Printer[] }>(`${base(ws)}${qs({ added })}`)),
  get: (ws: string, id: string) => http.get<Printer>(`${base(ws)}/${enc(id)}`),
  update: (ws: string, id: string, patch: PrinterPatch) => http.patch<Printer>(`${base(ws)}/${enc(id)}`, patch),
  remove: (ws: string, id: string) => http.del(`${base(ws)}/${enc(id)}`),
  identify: (ws: string, id: string) => http.post<void>(`${base(ws)}/${enc(id)}/identify`),
  refresh: (ws: string, id: string) => http.post<void>(`${base(ws)}/${enc(id)}/refresh`),
  testPage: (ws: string, id: string) => http.post<{ job: Job }>(`${base(ws)}/${enc(id)}/test-page`),
}
