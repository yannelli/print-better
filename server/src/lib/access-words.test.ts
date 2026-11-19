import { describe, expect, it } from 'vitest'
import type { AccessSubject } from '@shared/access'
import {
  accessReason,
  canPhrase,
  devicePrintWords,
  extensionUsage,
  groupSize,
  joinAnd,
  permissionSummary,
  type ReasonNames,
  roleName,
} from './words'

describe('permission wording', () => {
  it('joins lists the way people write them', () => {
    expect(joinAnd(['print'])).toBe('print')
    expect(joinAnd(['see it', 'print'])).toBe('see it and print')
    expect(joinAnd(['a', 'b', 'c'])).toBe('a, b, and c')
  })

  it('summarizes permissions, adding what they include', () => {
    expect(permissionSummary([])).toBe('No access')
    expect(permissionSummary(['view'])).toBe('Can see it')
    expect(permissionSummary(['print'])).toBe('Can see it and print')
    expect(permissionSummary(['view', 'print', 'jobs.read'])).toBe('Can see it, print, and see everyone’s jobs')
    expect(permissionSummary(['jobs.manage'])).toBe('Can see it and manage everyone’s jobs')
    expect(permissionSummary(['view', 'print', 'jobs.read', 'jobs.manage', 'settings', 'access'])).toBe('Can do everything')
  })

  it('reads as part of a sentence', () => {
    expect(`Alex ${canPhrase(['view', 'print'])}`).toBe('Alex can see it and print')
    expect(`Alex ${canPhrase([])}`).toBe('Alex can’t use this printer')
  })
})

describe('roleName', () => {
  const roles = [{ id: 'r_custom', name: 'Front desk' }]
  it('names built-in, custom, missing roles and No access', () => {
    expect(roleName('user')).toBe('User')
    expect(roleName('manager', roles)).toBe('Manager')
    expect(roleName('r_custom', roles)).toBe('Front desk')
    expect(roleName('none')).toBe('No access')
    expect(roleName('r_gone', roles)).toBe('A removed role')
  })
})

describe('counts', () => {
  it('describes who is in a group', () => {
    expect(groupSize([])).toBe('No one yet')
    expect(groupSize([{ type: 'user' }])).toBe('1 person')
    expect(groupSize([{ type: 'user' }, { type: 'user' }, { type: 'client' }])).toBe('2 people and 1 device')
    expect(groupSize([{ type: 'client' }, { type: 'client' }])).toBe('2 devices')
  })

  it('says how many workspaces use an extension', () => {
    expect(extensionUsage(0)).toBe('No workspace has turned it on yet')
    expect(extensionUsage(1)).toBe('Turned on in 1 workspace')
    expect(extensionUsage(3)).toBe('Turned on in 3 workspaces')
  })
})

describe('accessReason', () => {
  const names: ReasonNames = {
    role: (id) => roleName(id, [{ id: 'r1', name: 'Front desk' }]),
    subject: (s: AccessSubject) => (s.type === 'group' ? 'Office' : 'Someone'),
    everyPrinter: (grantId) => grantId === 'g_wide',
  }

  it('explains each source in plain words, without ids', () => {
    expect(accessReason({ kind: 'workspace-role', role: 'owner' }, names)).toBe('Workspace owner, which allows everything on every printer')
    expect(accessReason({ kind: 'workspace-role', role: 'admin' }, names)).toMatch(/^Workspace admin/)
    expect(accessReason({ kind: 'everyone', role: 'user' }, names)).toBe('Everyone has the User role on this printer')
    expect(accessReason({ kind: 'grant', role: 'r1', grantId: 'g_wide', via: { type: 'group', id: 'grp' } }, names)).toBe(
      'In the Office group, which has the Front desk role on every printer',
    )
    expect(accessReason({ kind: 'grant', role: 'manager', grantId: 'g1', via: { type: 'user', id: 'u' } }, names)).toBe(
      'Given the Manager role on this printer',
    )
    expect(accessReason({ kind: 'grant', role: 'viewer', grantId: 'g1', via: { type: 'client', id: 'c' } }, names)).toBe(
      'This device has the Viewer role on this printer',
    )
    expect(accessReason({ kind: 'grant', role: 'user', grantId: 'g_wide', via: { type: 'everyone' } }, names)).toBe(
      'Everyone has the User role on every printer',
    )
  })

  it('says whether a device can print', () => {
    expect(devicePrintWords(true, 'this Mac')).toEqual({ label: 'Can print', tone: 'ok' })
    expect(devicePrintWords(false, 'this computer')).toEqual({ label: 'Not allowed on this computer', tone: 'neutral' })
  })
})
