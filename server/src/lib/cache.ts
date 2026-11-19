import type { InfiniteData, QueryClient } from '@tanstack/react-query'
import type { Client, Job, Printer, Workspace } from '@shared/types'
import type { JobFilters, Page, SessionState } from './api/types'
import { qk } from './query'

type WithId = { id: string }

function upsert<T extends WithId>(list: T[] | undefined, item: T, prepend = false): T[] | undefined {
  if (!list) return list
  const index = list.findIndex((x) => x.id === item.id)
  if (index === -1) return prepend ? [item, ...list] : [...list, item]
  const next = list.slice()
  next[index] = item
  return next
}

const without = <T extends WithId>(list: T[] | undefined, id: string) => list?.filter((x) => x.id !== id)

export function putPrinter(qc: QueryClient, ws: string, printer: Printer) {
  qc.setQueryData<Printer[]>(qk.printers(ws), (list) => upsert(list, printer))
  qc.setQueryData(qk.printer(ws, printer.id), printer)
}

export function dropPrinter(qc: QueryClient, ws: string, id: string) {
  qc.setQueryData<Printer[]>(qk.printers(ws), (list) => without(list, id))
  qc.removeQueries({ queryKey: qk.printer(ws, id) })
}

export function putClient(qc: QueryClient, ws: string, client: Client) {
  qc.setQueryData<Client[]>(qk.clients(ws), (list) => upsert(list, client))
  // Printer cards show their computer's online state, so keep it in step.
  qc.setQueryData<Printer[]>(qk.printers(ws), (list) =>
    list?.map((p) => (p.clientId === client.id ? { ...p, clientOnline: client.online, clientName: client.name } : p)),
  )
}

export function dropClient(qc: QueryClient, ws: string, id: string) {
  qc.setQueryData<Client[]>(qk.clients(ws), (list) => without(list, id))
  qc.setQueryData<Printer[]>(qk.printers(ws), (list) => list?.filter((p) => p.clientId !== id))
}

function matches(job: Job, filters: JobFilters) {
  return (!filters.printerId || job.printerId === filters.printerId) && (!filters.status || job.status === filters.status)
}

export function putJob(qc: QueryClient, ws: string, job: Job) {
  qc.setQueryData(qk.job(ws, job.id), job)
  for (const [key, data] of qc.getQueriesData<InfiniteData<Page<Job>>>({ queryKey: qk.jobsAll(ws) })) {
    if (!data) continue
    const filters = (key[3] ?? {}) as JobFilters
    const present = data.pages.some((page) => page.items.some((x) => x.id === job.id))
    if (present) {
      const pages = data.pages.map((page) => ({
        ...page,
        items: matches(job, filters) ? page.items.map((x) => (x.id === job.id ? job : x)) : without(page.items, job.id)!,
      }))
      qc.setQueryData(key, { ...data, pages })
    } else if (matches(job, filters) && data.pages.length > 0) {
      const [first, ...rest] = data.pages
      qc.setQueryData(key, { ...data, pages: [{ ...first, items: [job, ...first.items] }, ...rest] })
    }
  }
}

export function dropJob(qc: QueryClient, ws: string, id: string) {
  qc.removeQueries({ queryKey: qk.job(ws, id) })
  for (const [key, data] of qc.getQueriesData<InfiniteData<Page<Job>>>({ queryKey: qk.jobsAll(ws) })) {
    if (!data) continue
    qc.setQueryData(key, { ...data, pages: data.pages.map((p) => ({ ...p, items: without(p.items, id)! })) })
  }
}

export function putWorkspace(qc: QueryClient, workspace: Workspace) {
  qc.setQueryData(qk.workspace(workspace.id), workspace)
  qc.setQueryData<SessionState>(qk.session, (s) =>
    s && {
      ...s,
      workspaces: s.workspaces.map((w) => (w.id === workspace.id ? { ...w, name: workspace.name, role: workspace.role } : w)),
    },
  )
}

/** After any access or extension change: what people can see, print to, and manage may all differ. */
export function refreshAccess(qc: QueryClient, ws: string) {
  for (const key of [qk.printers(ws), ['ws', ws, 'printer'], qk.jobsAll(ws), ['ws', ws, 'job'], qk.extensions(ws), qk.access(ws), qk.groups(ws)]) {
    qc.invalidateQueries({ queryKey: key })
  }
}
