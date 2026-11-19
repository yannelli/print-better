import { describe, expect, it } from 'vitest'
import type { MyPrinterAccess } from '@shared/access'
import { jobRights, printerRights } from './access'

const me = (extra: Partial<MyPrinterAccess>): MyPrinterAccess => ({ managed: true, all: false, printers: {}, ...extra })
const job = (userId: string | null, printerId: string | null = 'p1') => ({ userId, printerId })

describe('printerRights', () => {
  it('uses today’s role rules before /access/me answers', () => {
    const member = printerRights(undefined, 'member')
    expect([member.managed, member.all]).toEqual([false, false])
    expect(member.can('p1', 'print')).toBe(true)
    expect(member.can('p1', 'jobs.read')).toBe(true)
    expect(member.can('p1', 'settings')).toBe(false)
    expect(printerRights(undefined, 'admin').can('p1', 'access')).toBe(true)
    expect(printerRights(undefined, 'owner').can(null, 'settings')).toBe(true)
  })

  it('keeps today’s rules while printer access is off, whatever the map says', () => {
    const rights = printerRights(me({ managed: false, printers: {} }), 'member')
    expect(rights.can('unlisted', 'print')).toBe(true)
    expect(rights.can('unlisted', 'jobs.manage')).toBe(false)
  })

  it('follows the per-printer permissions while it is on', () => {
    const rights = printerRights(me({ printers: { p1: ['view'], p2: ['view', 'print', 'jobs.read'] } }), 'member')
    expect(rights.can('p1', 'view')).toBe(true)
    expect(rights.can('p1', 'print')).toBe(false)
    expect(rights.can('p2', 'print')).toBe(true)
    expect(rights.can('p3', 'view')).toBe(false)
    expect(rights.can(null, 'view')).toBe(false)
  })

  it('gives owners and admins everything, managed or not', () => {
    const rights = printerRights(me({ all: true }), 'member')
    expect(rights.can('any', 'access')).toBe(true)
    expect(rights.can(null, 'jobs.manage')).toBe(true)
  })
})

describe('jobRights', () => {
  it('matches today for members and admins while printer access is off', () => {
    const member = printerRights(undefined, 'member')
    expect(jobRights(job('u1'), 'u1', member)).toEqual({ cancel: true, retry: true, remove: false })
    expect(jobRights(job('u2'), 'u1', member)).toEqual({ cancel: false, retry: false, remove: false })
    const admin = printerRights(undefined, 'admin')
    expect(jobRights(job('u2'), 'u1', admin)).toEqual({ cancel: true, retry: true, remove: true })
  })

  it('lets you cancel your own job, but retry only where you can still print', () => {
    const viewer = printerRights(me({ printers: { p1: ['view'] } }), 'member')
    expect(jobRights(job('u1'), 'u1', viewer)).toEqual({ cancel: true, retry: false, remove: false })
  })

  it('lets jobs.manage handle anyone’s jobs on that printer only', () => {
    const rights = printerRights(me({ printers: { p1: ['view', 'print', 'jobs.read', 'jobs.manage'], p2: ['view', 'print'] } }), 'member')
    expect(jobRights(job('u2', 'p1'), 'u1', rights)).toEqual({ cancel: true, retry: true, remove: true })
    expect(jobRights(job('u2', 'p2'), 'u1', rights)).toEqual({ cancel: false, retry: false, remove: false })
    expect(jobRights(job('u1', 'p2'), 'u1', rights).remove).toBe(false)
  })

  it('treats a job from a removed printer as yours only', () => {
    const rights = printerRights(me({ printers: {} }), 'member')
    expect(jobRights(job('u1', null), 'u1', rights)).toEqual({ cancel: true, retry: false, remove: false })
    expect(jobRights(job('u1', null), null, rights).cancel).toBe(false)
  })
})
