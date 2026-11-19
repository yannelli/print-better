import { env } from 'cloudflare:workers'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { connectPrinter } from './helpers/device'
import { call } from './helpers/http'
import { stubFetch } from './helpers/outbound'
import { addMember, setupOwner } from './helpers/world'

afterEach(() => vi.restoreAllMocks())

describe('test harness', () => {
  it('uses test secrets, not .dev.vars', () => {
    expect(env.SETUP_TOKEN).toBe('test-setup-token')
    expect(env.AUTH_PEPPER).toBe('test-pepper-0123456789abcdef')
  })

  it('never reaches the network for unstubbed outbound fetches', async () => {
    const res = await fetch('https://example.com/')
    expect(res.status).toBe(599)
  })

  it('lets a test stub outbound fetches', async () => {
    stubFetch(() => new Response('stubbed'))
    expect(await (await fetch('https://example.com/')).text()).toBe('stubbed')
  })

  it('builds a world: owner, member, and a connected device with a printer', async () => {
    const owner = await setupOwner()
    const member = await addMember(owner)
    expect(member.user.username).toMatch(/^person\d+$/)
    const station = await connectPrinter(owner)
    const printers = await owner.agent.get(`/api/workspaces/${owner.workspaceId}/printers`)
    expect(printers.body.map((p: { id: string }) => p.id)).toContain(station.printerId)
    station.device.close()
    expect((await call('/api/instance')).status).toBe(200)
  })
})
