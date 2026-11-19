import { describe, expect, it } from 'vitest'
import { PRINTER_PERMISSIONS, type AccessSubject, type PrinterPermission } from '../shared/access'
import type { AccessPrincipal } from '../worker/extensions/hooks'
import { evaluator, explain, type PolicyData, type PolicyGrant } from '../worker/extensions/printer-access/policy'

const ALICE: AccessPrincipal = { kind: 'member', userId: 'alice', role: 'member' }
const BOB: AccessPrincipal = { kind: 'member', userId: 'bob', role: 'member' }
const MAC: AccessPrincipal = { kind: 'device', clientId: 'mac' }
const PI: AccessPrincipal = { kind: 'device', clientId: 'pi' }
const EVERYONE: AccessPrincipal = { kind: 'everyone' }
const FRONT_DESK: AccessPrincipal = { kind: 'group', groupId: 'front' }
const PRINTS_OWN = ['view', 'print'] as PrinterPermission[]

let ids = 0
const grant = (printerId: string | null, subject: AccessSubject, role: string): PolicyGrant => ({ id: `g${++ids}`, printerId, subject, role })

function data(over: Partial<PolicyData> = {}): PolicyData {
  return {
    defaultRole: 'user',
    roles: new Map([['own-only', PRINTS_OWN], ['jobs-desk', ['jobs.manage']], ['tuner', ['settings']]]),
    everyone: new Map(),
    grants: [],
    groups: new Map([
      ['user:alice', new Set(['front'])],
      ['client:mac', new Set(['front'])],
    ]),
    ...over,
  }
}

/** Both entry points must agree: the explanation is what the evaluator returns. */
function perms(d: PolicyData, who: AccessPrincipal, printerId = 'laser'): readonly PrinterPermission[] {
  const fast = evaluator(d, who)(printerId)
  expect(explain(d, who, printerId).permissions).toEqual(fast)
  return fast
}

describe('workspace roles', () => {
  it('give owners and admins every permission on every printer, whatever the grants say', () => {
    const d = data({ defaultRole: 'none', everyone: new Map([['laser', 'none']]) })
    for (const role of ['owner', 'admin'] as const) {
      const who: AccessPrincipal = { kind: 'member', userId: 'boss', role }
      expect(perms(d, who)).toEqual(PRINTER_PERMISSIONS)
      expect(explain(d, who, 'laser').sources).toEqual([{ kind: 'workspace-role', role }])
    }
  })
})

describe('Everyone', () => {
  it('starts as the User role on every printer: exactly today’s member access', () => {
    for (const who of [ALICE, MAC, EVERYONE, FRONT_DESK]) expect(perms(data(), who)).toEqual(['view', 'print', 'jobs.read'])
    expect(explain(data(), ALICE, 'laser').sources).toEqual([{ kind: 'everyone', role: 'user' }])
  })

  it('follows the workspace default until a printer sets its own role', () => {
    const d = data({ defaultRole: 'viewer', everyone: new Map([['inkjet', 'manager']]) })
    expect(perms(d, ALICE, 'laser')).toEqual(['view'])
    expect(perms(d, ALICE, 'inkjet')).toEqual(PRINTER_PERMISSIONS)
  })

  it('restricts a printer with none, hiding it from everyone without a grant', () => {
    const d = data({ everyone: new Map([['laser', 'none']]) })
    for (const who of [ALICE, BOB, MAC, PI, EVERYONE, FRONT_DESK]) expect(perms(d, who)).toEqual([])
    expect(explain(d, ALICE, 'laser').sources).toEqual([])
    expect(perms(d, ALICE, 'inkjet')).toEqual(['view', 'print', 'jobs.read'])
  })

  it('can restrict every printer through the default, which a printer may open again', () => {
    const d = data({ defaultRole: 'none', everyone: new Map([['inkjet', 'user']]) })
    expect(perms(d, BOB, 'laser')).toEqual([])
    expect(perms(d, BOB, 'inkjet')).toEqual(['view', 'print', 'jobs.read'])
  })
})

describe('grants', () => {
  const restricted = (grants: PolicyGrant[]) => data({ everyone: new Map([['laser', 'none']]), grants })

  it('to a member apply to that member on that printer only', () => {
    const d = restricted([grant('laser', { type: 'user', id: 'alice' }, 'user')])
    expect(perms(d, ALICE)).toEqual(['view', 'print', 'jobs.read'])
    expect(perms(d, BOB)).toEqual([])
    expect(perms(d, { kind: 'device', clientId: 'alice' })).toEqual([])
    expect(perms(data({ defaultRole: 'none', grants: d.grants }), ALICE, 'inkjet')).toEqual([])
  })

  it('to a group apply to its members and devices, and to the group itself', () => {
    const d = restricted([grant('laser', { type: 'group', id: 'front' }, 'viewer')])
    for (const who of [ALICE, MAC, FRONT_DESK]) expect(perms(d, who)).toEqual(['view'])
    for (const who of [BOB, PI, EVERYONE, { kind: 'group', groupId: 'back' } as AccessPrincipal]) expect(perms(d, who)).toEqual([])
    expect(explain(d, MAC, 'laser').sources).toEqual([{ kind: 'grant', role: 'viewer', grantId: d.grants[0].id, via: { type: 'group', id: 'front' } }])
  })

  it('to a device apply to that device only, never to a member with the same id', () => {
    const d = restricted([grant('laser', { type: 'client', id: 'pi' }, 'user')])
    expect(perms(d, PI)).toEqual(['view', 'print', 'jobs.read'])
    expect(perms(d, MAC)).toEqual([])
    expect(perms(d, { kind: 'member', userId: 'pi', role: 'member' })).toEqual([])
  })

  it('on every printer reach restricted printers too', () => {
    const d = data({ defaultRole: 'none', everyone: new Map([['laser', 'none']]), grants: [grant(null, { type: 'group', id: 'front' }, 'manager')] })
    expect(perms(d, ALICE, 'laser')).toEqual(PRINTER_PERMISSIONS)
    expect(perms(d, MAC, 'anything')).toEqual(PRINTER_PERMISSIONS)
    expect(perms(d, BOB, 'laser')).toEqual([])
  })

  it('to Everyone on every printer reach anyone who gets what Everyone gets', () => {
    const d = data({ defaultRole: 'none', grants: [grant(null, { type: 'everyone' }, 'viewer')] })
    for (const who of [ALICE, BOB, MAC, EVERYONE, FRONT_DESK]) expect(perms(d, who)).toEqual(['view'])
  })

  it('add up with Everyone and each other; there are no deny rules', () => {
    const d = data({
      defaultRole: 'viewer',
      grants: [grant('laser', { type: 'user', id: 'alice' }, 'own-only'), grant(null, { type: 'group', id: 'front' }, 'jobs-desk'), grant('laser', { type: 'everyone' }, 'none')],
    })
    expect(perms(d, ALICE)).toEqual(['view', 'print', 'jobs.read', 'jobs.manage'])
    expect(explain(d, ALICE, 'laser').sources.map((s) => `${s.kind}:${s.role}`)).toEqual(['everyone:viewer', 'grant:own-only', 'grant:jobs-desk', 'grant:none'])
    expect(perms(d, BOB)).toEqual(['view'])
  })
})

describe('roles and implied permissions', () => {
  it('maps the built-in roles to their permissions', () => {
    const on = (role: string) => perms(data({ defaultRole: role }), BOB)
    expect(on('viewer')).toEqual(['view'])
    expect(on('user')).toEqual(['view', 'print', 'jobs.read'])
    expect(on('manager')).toEqual(PRINTER_PERMISSIONS)
    expect(on('none')).toEqual([])
  })

  it('reads custom roles, adding view to everything and jobs.read to jobs.manage', () => {
    expect(perms(data({ defaultRole: 'own-only' }), BOB)).toEqual(['view', 'print'])
    expect(perms(data({ defaultRole: 'jobs-desk' }), BOB)).toEqual(['view', 'jobs.read', 'jobs.manage'])
    expect(perms(data({ defaultRole: 'tuner' }), BOB)).toEqual(['view', 'settings'])
  })

  it('treats an unknown role as no access', () => {
    expect(perms(data({ defaultRole: 'deleted-role' }), BOB)).toEqual([])
    expect(perms(data({ defaultRole: 'none', grants: [grant('laser', { type: 'user', id: 'bob' }, 'gone')] }), BOB)).toEqual([])
  })

  it('changes everyone holding a custom role when the role changes', () => {
    const roles = new Map([['own-only', ['settings'] as PrinterPermission[]]])
    expect(perms(data({ defaultRole: 'own-only', roles }), BOB)).toEqual(['view', 'settings'])
  })
})
