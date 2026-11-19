import { QueryClient } from '@tanstack/react-query'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { MyPrinterAccess } from '@shared/access'
import type { Job, JobStatus, Role } from '@shared/types'
import { mayApprove, printerRights } from './access'
import type { SessionState } from './api/types'
import { qk } from './query'
import { applyEvent } from './realtime'

const toast = vi.hoisted(() => vi.fn())
vi.mock('sonner', () => ({ toast }))

const WS = 'ws1'
const ME = 'u-me'
const held = (id: string, userId = 'u-other', status: JobStatus = 'held') =>
  ({ id, status, printerId: 'p1', userId, title: 'Flyer', held: { kind: 'approval', until: 0, reasons: ['Color needs approval'] } }) as Job

function signedIn(role: Role, access?: MyPrinterAccess) {
  const qc = new QueryClient()
  qc.setQueryData<SessionState>(qk.session, { user: { id: ME } as SessionState['user'], workspaces: [{ id: WS, name: 'Office', role }] })
  if (access) qc.setQueryData(qk.myAccess(WS), access)
  qc.setQueryData([...qk.holds(WS), 'approvals'], [held('j1')])
  qc.setQueryData([...qk.enterprise(WS), 'cost-centers'], { costCenters: [], myDefault: null })
  return qc
}

const stale = (qc: QueryClient, key: readonly unknown[]) => qc.getQueryState(key)?.isInvalidated

beforeEach(() => toast.mockClear())

describe('approval events', () => {
  it('put the job, refresh the held lists, and tell an admin', () => {
    const qc = signedIn('admin')
    applyEvent(qc, WS, { type: 'approval', job: held('j2') })
    expect(qc.getQueryData<Job>(qk.job(WS, 'j2'))?.status).toBe('held')
    expect(stale(qc, [...qk.holds(WS), 'approvals'])).toBe(true)
    expect(stale(qc, [...qk.enterprise(WS), 'cost-centers'])).toBe(false)
    expect(toast).toHaveBeenCalledWith('“Flyer” needs approval', expect.objectContaining({ description: 'Color needs approval' }))
  })

  it('tell printer managers about other people’s jobs only', () => {
    const managed = { managed: true, all: false, printers: { p1: ['view', 'jobs.read', 'jobs.manage'] } } satisfies MyPrinterAccess
    const qc = signedIn('member', managed)
    applyEvent(qc, WS, { type: 'approval', job: held('j2', ME) })
    expect(toast).not.toHaveBeenCalled()
    applyEvent(qc, WS, { type: 'approval', job: held('j3') })
    expect(toast).toHaveBeenCalledTimes(1)
  })

  it('never tell members who can’t approve', () => {
    applyEvent(signedIn('member'), WS, { type: 'approval', job: held('j2') })
    applyEvent(signedIn('member', { managed: true, all: false, printers: { p1: ['view', 'print'] } }), WS, { type: 'approval', job: held('j3') })
    expect(toast).not.toHaveBeenCalled()
  })
})

describe('job events and held lists', () => {
  it('refresh the held lists when a listed job moves on', () => {
    const qc = signedIn('admin')
    applyEvent(qc, WS, { type: 'job', job: held('j1', 'u-other', 'queued') })
    expect(stale(qc, [...qk.holds(WS), 'approvals'])).toBe(true)
  })

  it('leave them alone for jobs that were never held', () => {
    const qc = signedIn('admin')
    applyEvent(qc, WS, { type: 'job', job: held('j9', 'u-other', 'printing') })
    expect(stale(qc, [...qk.holds(WS), 'approvals'])).toBe(false)
  })
})

describe('printer rights for approvals', () => {
  it('canAny looks across printers, and mayApprove follows it', () => {
    const rights = printerRights({ managed: true, all: false, printers: { p1: ['view'], p2: ['view', 'jobs.read', 'jobs.manage'] } }, 'member')
    expect(rights.canAny('jobs.manage')).toBe(true)
    expect(rights.canAny('settings')).toBe(false)
    expect(mayApprove({ userId: 'u-other', printerId: 'p2' }, ME, rights)).toBe(true)
    expect(mayApprove({ userId: 'u-other', printerId: 'p1' }, ME, rights)).toBe(false)
    expect(mayApprove({ userId: ME, printerId: 'p2' }, ME, rights)).toBe(false)
    expect(mayApprove({ userId: null, printerId: 'p2' }, ME, rights)).toBe(false)
    expect(mayApprove({ userId: ME, printerId: 'p1' }, ME, printerRights(undefined, 'owner'))).toBe(true)
  })
})
