import { type InfiniteData, QueryClient } from '@tanstack/react-query'
import { describe, expect, it } from 'vitest'
import { DEFAULT_CLIENT_SETTINGS, DEFAULT_WORKSPACE_SETTINGS, type Client, type Job, type JobStatus, type Printer } from '@shared/types'
import type { Page, SessionState } from './api/types'
import { qk } from './query'
import { applyEvent } from './realtime'

const WS = 'ws1'
const job = (id: string, status: JobStatus = 'queued', printerId = 'p1') => ({ id, status, printerId }) as Job
const printer = (id: string, clientId = 'c1') => ({ id, clientId, clientName: 'Mac', clientOnline: true, added: true }) as Printer
const client = (id: string, online: boolean) =>
  ({ id, name: online ? 'Mac' : 'Mac (asleep)', online, settings: DEFAULT_CLIENT_SETTINGS }) as Client
const pages = (...lists: Job[][]): InfiniteData<Page<Job>> => ({
  pages: lists.map((items, i) => ({ items, nextCursor: i < lists.length - 1 ? `c${i}` : null })),
  pageParams: lists.map((_, i) => (i === 0 ? undefined : `c${i - 1}`)),
})
const ids = (data: InfiniteData<Page<Job>> | undefined) => data?.pages.map((p) => p.items.map((j) => `${j.id}:${j.status}`))

function seeded() {
  const qc = new QueryClient()
  qc.setQueryData(qk.jobs(WS), pages([job('j2'), job('j1')], [job('j0', 'completed')]))
  qc.setQueryData(qk.jobs(WS, { status: 'queued' }), pages([job('j2'), job('j1')]))
  qc.setQueryData(qk.jobs(WS, { printerId: 'p2' }), pages([]))
  qc.setQueryData(qk.printers(WS), [printer('p1'), printer('p2', 'c2')])
  qc.setQueryData(qk.clients(WS), [client('c1', true), client('c2', true)])
  qc.setQueryData<SessionState>(qk.session, { user: null, workspaces: [{ id: WS, name: 'Home', role: 'member' }] })
  return qc
}

describe('job events', () => {
  it('updates a job in place and drops it from lists whose filter no longer matches', () => {
    const qc = seeded()
    applyEvent(qc, WS, { type: 'job', job: job('j1', 'printing') })
    expect(ids(qc.getQueryData(qk.jobs(WS)))).toEqual([['j2:queued', 'j1:printing'], ['j0:completed']])
    expect(ids(qc.getQueryData(qk.jobs(WS, { status: 'queued' })))).toEqual([['j2:queued']])
    expect(qc.getQueryData<Job>(qk.job(WS, 'j1'))?.status).toBe('printing')
  })

  it('puts new jobs at the top of every list they belong to', () => {
    const qc = seeded()
    applyEvent(qc, WS, { type: 'job', job: job('j3', 'queued', 'p2') })
    expect(ids(qc.getQueryData(qk.jobs(WS)))?.[0][0]).toBe('j3:queued')
    expect(ids(qc.getQueryData(qk.jobs(WS, { status: 'queued' })))?.[0][0]).toBe('j3:queued')
    expect(ids(qc.getQueryData(qk.jobs(WS, { printerId: 'p2' })))).toEqual([['j3:queued']])
  })

  it('leaves other workspaces alone', () => {
    const qc = seeded()
    applyEvent(qc, 'other', { type: 'job', job: job('j9') })
    expect(ids(qc.getQueryData(qk.jobs(WS)))?.[0]).toHaveLength(2)
  })
})

describe('printer and device events', () => {
  it('upserts and removes printers', () => {
    const qc = seeded()
    applyEvent(qc, WS, { type: 'printer', printer: { ...printer('p1'), name: 'Renamed' } })
    applyEvent(qc, WS, { type: 'printer', printer: printer('p3') })
    expect(qc.getQueryData<Printer[]>(qk.printers(WS))?.map((p) => p.id)).toEqual(['p1', 'p2', 'p3'])
    expect(qc.getQueryData<Printer>(qk.printer(WS, 'p1'))?.name).toBe('Renamed')
    applyEvent(qc, WS, { type: 'printer_removed', id: 'p2' })
    expect(qc.getQueryData<Printer[]>(qk.printers(WS))?.map((p) => p.id)).toEqual(['p1', 'p3'])
  })

  it('marks a device’s printers offline with it, and drops them when it is removed', () => {
    const qc = seeded()
    applyEvent(qc, WS, { type: 'client', client: client('c2', false) })
    const list = qc.getQueryData<Printer[]>(qk.printers(WS))!
    expect(list.find((p) => p.id === 'p2')).toMatchObject({ clientOnline: false, clientName: 'Mac (asleep)' })
    expect(list.find((p) => p.id === 'p1')?.clientOnline).toBe(true)
    applyEvent(qc, WS, { type: 'client_removed', id: 'c2' })
    expect(qc.getQueryData<Client[]>(qk.clients(WS))?.map((c) => c.id)).toEqual(['c1'])
    expect(qc.getQueryData<Printer[]>(qk.printers(WS))?.map((p) => p.id)).toEqual(['p1'])
  })

  it('does not invent lists that were never loaded', () => {
    const qc = new QueryClient()
    applyEvent(qc, WS, { type: 'printer', printer: printer('p1') })
    expect(qc.getQueryData(qk.printers(WS))).toBeUndefined()
    expect(qc.getQueryData(qk.printer(WS, 'p1'))).toBeDefined()
  })
})

it('workspace events update the name and my role in the session', () => {
  const qc = seeded()
  const workspace = { id: WS, name: 'Grandma’s house', role: 'admin' as const, settings: DEFAULT_WORKSPACE_SETTINGS, createdAt: 0 }
  applyEvent(qc, WS, { type: 'workspace', workspace })
  expect(qc.getQueryData<SessionState>(qk.session)?.workspaces).toEqual([{ id: WS, name: 'Grandma’s house', role: 'admin' }])
  expect(qc.getQueryData(qk.workspace(WS))).toEqual(workspace)
})
