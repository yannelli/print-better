import { afterEach, describe, expect, it, vi } from 'vitest'
import { ACCOUNT_ROUTE, WORKSPACE_FREE_PATHS, WORKSPACE_FREE_ROUTE, workspaceScreenHref } from './app-links'

afterEach(() => vi.unstubAllGlobals())

function stubBrowser(path: string, lastWorkspace: string | null) {
  vi.stubGlobal('location', { pathname: path, search: '' })
  vi.stubGlobal('localStorage', { getItem: () => lastWorkspace, setItem: () => undefined })
}

describe('workspace-free app links', () => {
  it('match the six screens, with or without a trailing slash', () => {
    expect(WORKSPACE_FREE_PATHS).toEqual(['/printers', '/jobs', '/devices', '/devices/add', '/members', '/settings'])
    for (const path of WORKSPACE_FREE_PATHS) {
      expect(WORKSPACE_FREE_ROUTE.test(path)).toBe(true)
      expect(WORKSPACE_FREE_ROUTE.test(`${path}/`)).toBe(true)
    }
    for (const path of ['/', '/printers/abc', '/devicesx', '/devices/add/more', '/w/abc/printers', '/docs/printers/add']) {
      expect(WORKSPACE_FREE_ROUTE.test(path)).toBe(false)
    }
  })

  it('leave account screens and their tabs to the account route', () => {
    for (const path of ['/account', '/account/security', '/admin', '/admin/email', '/connect']) expect(ACCOUNT_ROUTE.test(path)).toBe(true)
    for (const path of ['/accounts', '/administrator', '/printers']) expect(ACCOUNT_ROUTE.test(path)).toBe(false)
  })

  it('open the same screen in a workspace, keeping the query and hash', () => {
    expect(workspaceScreenHref('/printers', 'ws1')).toBe('/w/ws1/printers')
    expect(workspaceScreenHref('/devices/add/', 'ws1')).toBe('/w/ws1/devices/add')
    expect(workspaceScreenHref('/settings', 'ws1', '?x=1#extensions')).toBe('/w/ws1/settings?x=1#extensions')
    expect(workspaceScreenHref('/jobs', undefined)).toBe('/welcome')
  })

  it('pick the last-used workspace, the same way the root redirect does', async () => {
    const { preferredWorkspace } = await import('@/hooks/workspace')
    const workspaces = [
      { id: 'home', name: 'Home', role: 'owner' as const },
      { id: 'office', name: 'Office', role: 'member' as const },
    ]
    stubBrowser('/printers', 'office')
    expect(workspaceScreenHref(location.pathname, preferredWorkspace(workspaces)?.id)).toBe('/w/office/printers')
    stubBrowser('/printers', 'gone')
    expect(workspaceScreenHref(location.pathname, preferredWorkspace(workspaces)?.id)).toBe('/w/home/printers')
  })

  it('send signed-out readers to sign-in and back', async () => {
    const { loginHref, safeNext } = await import('@/hooks/auth')
    stubBrowser('/devices/add', null)
    const href = loginHref()
    expect(href).toBe('/login?next=%2Fdevices%2Fadd')
    expect(safeNext(new URLSearchParams(href.split('?')[1]).get('next'))).toBe('/devices/add')
  })
})
