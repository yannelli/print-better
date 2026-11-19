import { describe, expect, it } from 'vitest'
import type { MyPrinterAccess } from '@shared/access'
import type { Printer, Role } from '@shared/types'
import { printerRights } from '@/lib/access'
import { activeUi, type SlotContext, type SlotName, type SlotProps, slotEntries, visibleEntries } from '../registry'
import { enterpriseUi } from './index'

const active = activeUi(new Set(['enterprise']))
const printer = { id: 'p1' } as Printer

function ctx(role: Role, parts: string[], access?: MyPrinterAccess): SlotContext {
  return { rights: printerRights(access, role), canManage: role === 'owner' || role === 'admin', features: new Set(parts.map((p) => `enterprise.${p}`)) }
}

function shown<K extends SlotName>(name: K, props: SlotProps[K], c: SlotContext): string[] {
  return visibleEntries(slotEntries([enterpriseUi], active, name), props, c).map((e) => e.id)
}

const ALL = ['approvals', 'release', 'costCenters', 'reports', 'alerts', 'privacy']

describe('Enterprise controls in the web app', () => {
  it('shows only its settings tab while every part is off', () => {
    const admin = ctx('admin', [])
    expect(shown('jobsTab', { ws: 'w' }, admin)).toEqual([])
    expect(shown('usageTab', { ws: 'w' }, admin)).toEqual([])
    expect(shown('printerTab', { ws: 'w', printer }, admin)).toEqual([])
    expect(shown('printForm', { ws: 'w' } as SlotProps['printForm'], admin)).toEqual([])
    expect(shown('settingsTab', { ws: 'w' } as SlotProps['settingsTab'], admin)).toEqual(['enterprise'])
  })

  it('gives admins every tab once the parts are on', () => {
    const admin = ctx('admin', ALL)
    expect(shown('jobsTab', { ws: 'w' }, admin)).toEqual(['approvals', 'release'])
    expect(shown('usageTab', { ws: 'w' }, admin)).toEqual(['cost-centers', 'budgets', 'reports'])
    expect(shown('printerTab', { ws: 'w', printer }, admin)).toEqual(['controls'])
  })

  it('gives members release and the cost center picker, but no approvals or admin tabs', () => {
    const member = ctx('member', ALL)
    expect(shown('jobsTab', { ws: 'w' }, member)).toEqual(['release'])
    expect(shown('usageTab', { ws: 'w' }, member)).toEqual([])
    expect(shown('printerTab', { ws: 'w', printer }, member)).toEqual([])
    expect(shown('printForm', { ws: 'w' } as SlotProps['printForm'], member)).toEqual(['cost-center'])
  })

  it('shows Approvals to people who manage a printer’s jobs', () => {
    const manager = ctx('member', ['approvals'], { managed: true, all: false, printers: { p1: ['view', 'jobs.read', 'jobs.manage'] } })
    expect(shown('jobsTab', { ws: 'w' }, manager)).toEqual(['approvals'])
  })
})
