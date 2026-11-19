import { describe, expect, it } from 'vitest'
import type { ExtensionId } from '@shared/extensions'
import type { Client } from '@shared/types'
import { printerRights } from '@/lib/access'
import { activeUi, type ExtensionUi, slotEntries, visibleEntries, visiblePages } from './registry'

const Nothing = () => null
const registry: ExtensionUi[] = [
  {
    id: 'printer-access',
    slots: {
      membersTab: [{ id: 'groups', label: 'Groups', Component: Nothing }],
      deviceSection: [{ id: 'device', Component: Nothing, visible: (_p, ctx) => ctx.canManage }],
    },
  },
]
const on = new Set<ExtensionId>(['printer-access'])
const off = new Set<ExtensionId>()

describe('extension slots', () => {
  it('render nothing while the extension is inactive', () => {
    expect(slotEntries(registry, off, 'membersTab')).toEqual([])
    expect(slotEntries(registry, off, 'deviceSection')).toEqual([])
  })

  it('offer the entries of active extensions, and nothing for slots they skip', () => {
    expect(slotEntries(registry, on, 'membersTab').map((e) => e.id)).toEqual(['groups'])
    expect(slotEntries(registry, on, 'printerTab')).toEqual([])
  })

  it('apply each entry’s own visibility rule', () => {
    const entries = slotEntries(registry, on, 'deviceSection')
    const props = { ws: 'w', client: { id: 'c' } as Client }
    const member = { rights: printerRights(undefined, 'member'), canManage: false }
    const admin = { rights: printerRights(undefined, 'admin'), canManage: true }
    expect(visibleEntries(entries, props, member)).toEqual([])
    expect(visibleEntries(entries, props, admin).map((e) => e.id)).toEqual(['device'])
  })
})

describe('the shared usage UI', () => {
  const usage: ExtensionUi = {
    id: 'usage',
    slots: { jobMeta: [{ id: 'usage', Component: Nothing }] },
    pages: [{ path: '/usage/:tab?', Component: Nothing, visible: ({ active, canManage }) => canManage || active.has('print-policies') }],
  }
  const member = { rights: printerRights(undefined, 'member'), canManage: false }

  it('is active while either usage extension is, and never with only printer access', () => {
    expect(activeUi(new Set<ExtensionId>(['print-policies'])).has('usage')).toBe(true)
    expect(activeUi(new Set<ExtensionId>(['enterprise'])).has('usage')).toBe(true)
    expect(activeUi(on).has('usage')).toBe(false)
    expect(slotEntries([usage], activeUi(on), 'jobMeta')).toEqual([])
    expect(slotEntries([usage], activeUi(new Set<ExtensionId>(['print-policies'])), 'jobMeta').map((e) => e.id)).toEqual(['usage'])
  })

  it('shows its pages by their own rule, and none while it is inactive', () => {
    expect(visiblePages([usage], { ...member, active: activeUi(off) })).toEqual([])
    expect(visiblePages([usage], { ...member, active: activeUi(new Set<ExtensionId>(['enterprise'])) })).toEqual([])
    expect(visiblePages([usage], { ...member, active: activeUi(new Set<ExtensionId>(['print-policies'])) })).toHaveLength(1)
  })
})
