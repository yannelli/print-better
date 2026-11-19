import { describe, expect, it } from 'vitest'
import { BUILT_IN_ROLES, type Group, type PrinterRole, type WorkspaceAccess } from '@shared/access'
import type { Client, Member } from '@shared/types'
import { reasonNames, roleChoices, WORKSPACE_DEFAULT } from './roles'
import { subjectGroups, subjectName, type SubjectSources } from './subjects'

const member = (userId: string, name: string) => ({ userId, name, username: name.toLowerCase(), email: null, role: 'member', createdAt: 0 }) as Member
const group = (id: string, name: string, members: Group['members'] = []): Group => ({ id, name, description: null, members, createdAt: 0, updatedAt: 0 })
const client = (id: string, name: string) => ({ id, name }) as Client

const sources: SubjectSources = {
  members: [member('u2', 'Robin'), member('u1', 'Alex')],
  groups: [group('g1', 'Office', [{ type: 'user', id: 'u1', name: 'Alex' }])],
  clients: [client('c1', 'Front desk Mac')],
}

describe('subjectGroups', () => {
  it('lists the kinds asked for, sorted, with plain details', () => {
    const groups = subjectGroups(sources, ['user', 'group', 'client'])
    expect(groups.map((g) => g.value)).toEqual(['People', 'Groups', 'Devices'])
    expect(groups[0].items.map((o) => [o.label, o.detail, o.key])).toEqual([
      ['Alex', '@alex', 'user:u1'],
      ['Robin', '@robin', 'user:u2'],
    ])
    expect(groups[1].items[0]).toMatchObject({ label: 'Office', detail: '1 person', subject: { type: 'group', id: 'g1' } })
  })

  it('offers Everyone only when asked, and leaves out subjects already chosen', () => {
    expect(subjectGroups(sources, ['everyone', 'user'])[0].items[0].key).toBe('everyone')
    const groups = subjectGroups(sources, ['user', 'client'], new Set(['user:u1', 'client:c1']))
    expect(groups.map((g) => [g.value, g.items.map((o) => o.label)])).toEqual([['People', ['Robin']]])
  })
})

describe('subjectName', () => {
  it('names subjects, never by id', () => {
    expect(subjectName({ type: 'everyone' }, sources)).toBe('Everyone')
    expect(subjectName({ type: 'user', id: 'u2' }, sources)).toBe('Robin')
    expect(subjectName({ type: 'group', id: 'gone' }, sources)).toBe('A deleted group')
    expect(subjectName({ type: 'client', id: 'gone' }, sources)).toBe('A removed device')
  })
})

describe('role choices', () => {
  const builtIn = (Object.keys(BUILT_IN_ROLES) as (keyof typeof BUILT_IN_ROLES)[]).map(
    (id): PrinterRole => ({ id, ...BUILT_IN_ROLES[id], permissions: [...BUILT_IN_ROLES[id].permissions], builtIn: true }),
  )
  const custom: PrinterRole = { id: 'r1', name: 'Prints only', description: null, permissions: ['view', 'print'], builtIn: false }
  const access: WorkspaceAccess = { defaultRole: 'viewer', roles: [...builtIn, custom], grants: [] }

  it('leads with the workspace default by name and ends with No access when asked', () => {
    const choices = roleChoices(access, { workspaceDefault: true, none: 'Restricted' })
    expect(choices[0]).toMatchObject({ value: WORKSPACE_DEFAULT, label: 'Workspace default (Viewer)' })
    expect(choices.map((c) => c.label).slice(1)).toEqual(['Viewer', 'User', 'Manager', 'Prints only', 'No access'])
    expect(choices.find((c) => c.value === 'r1')?.description).toBe('Can see it and print')
  })

  it('only lists roles by default', () => {
    expect(roleChoices(access).map((c) => c.value)).toEqual(['viewer', 'user', 'manager', 'r1'])
  })

  it('knows which grants cover every printer', () => {
    const names = reasonNames({ ...access, grants: [{ id: 'gw', printerId: null, subject: { type: 'everyone' }, subjectName: 'Everyone', role: 'user', createdAt: 0 }] }, sources)
    expect([names.everyPrinter('gw'), names.everyPrinter('other'), names.everyPrinter(undefined)]).toEqual([true, false, false])
    expect(names.role('r1')).toBe('Prints only')
    expect(names.subject({ type: 'group', id: 'g1' })).toBe('Office')
  })
})
