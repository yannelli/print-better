import { beforeAll, describe, expect, it } from 'vitest'
import { call } from './helpers/http'
import { callTool, legacy, mcpRaw, META, MODERN, modern } from './helpers/mcp'
import { insertToken } from './helpers/tokens'
import { createPat, setupOwner, type Owner } from './helpers/world'

const PRM = 'https://print.test/.well-known/oauth-protected-resource/mcp'
let owner: Owner
let token: string

beforeAll(async () => {
  owner = await setupOwner()
  token = await createPat(owner)
})

describe('transport and auth', () => {
  it('accepts POST only', async () => {
    for (const method of ['GET', 'DELETE', 'PUT']) {
      const res = await call('/mcp', { method, headers: { Authorization: `Bearer ${token}` } })
      expect(res.status).toBe(405)
      expect(res.headers.get('Allow')).toBe('POST')
    }
  })

  it('challenges a request without a token, pointing at the protected resource metadata', async () => {
    const r = await legacy(null, 'tools/list')
    expect(r.status).toBe(401)
    expect(r.headers.get('WWW-Authenticate')).toBe(`Bearer resource_metadata="${PRM}", scope="read write print"`)
    expect(r.body.error).toBe('invalid_token')
  })

  it('flags invalid tokens and ignores cookies and foreign audiences', async () => {
    const wrongAudience = await insertToken(owner.user.id, { kind: 'oauth-access', resource: 'https://other.test/mcp' })
    for (const t of ['pbt_unknown', 'pbs_cookie', wrongAudience]) {
      const r = await legacy(t, 'tools/list')
      expect(r.status).toBe(401)
      expect(r.headers.get('WWW-Authenticate')).toMatch(/^Bearer error="invalid_token", error_description="[^"]+", resource_metadata=/)
    }
    const cookieOnly = await mcpRaw(null, { jsonrpc: '2.0', id: 1, method: 'ping' }, { Cookie: `pb_session=${owner.agent.cookies.get('pb_session')}` })
    expect(cookieOnly.status).toBe(401)
    const ours = await insertToken(owner.user.id, { kind: 'oauth-access', resource: 'https://print.test/mcp' })
    expect((await legacy(ours, 'ping')).status).toBe(200)
  })

  it('serves /mcp/ the same way', async () => {
    const r = await mcpRaw(token, { jsonrpc: '2.0', id: 7, method: 'ping' }, {}, '/mcp/')
    expect(r.body).toEqual({ jsonrpc: '2.0', id: 7, result: {} })
  })

  it('reports malformed JSON-RPC precisely', async () => {
    const cases: [unknown, number, number][] = [
      ['{nope', 400, -32700],
      [[{ jsonrpc: '2.0', id: 1, method: 'ping' }], 400, -32600],
      [{ jsonrpc: '1.0', id: 1, method: 'ping' }, 400, -32600],
      [{ jsonrpc: '2.0', id: { x: 1 }, method: 'ping' }, 400, -32600],
      [{ jsonrpc: '2.0', id: 1, method: 'ping', params: [1] }, 400, -32602],
    ]
    for (const [body, status, code] of cases) {
      const r = await mcpRaw(token, body)
      expect(r.status, JSON.stringify(body)).toBe(status)
      expect(r.body.error.code).toBe(code)
    }
  })

  it('accepts notifications with 202 and no body', async () => {
    const r = await mcpRaw(token, { jsonrpc: '2.0', method: 'notifications/initialized' })
    expect(r.status).toBe(202)
    expect(r.body).toBeNull()
  })

  it('refuses bodies over 16 MB', async () => {
    const r = await mcpRaw(token, `{"jsonrpc":"2.0","id":1,"method":"ping","pad":"${'x'.repeat(16 * 1024 * 1024)}"}`)
    expect(r.status).toBe(413)
    expect(r.body.error.code).toBe(-32600)
  })
})

describe('2025 era (initialize handshake)', () => {
  it('negotiates a supported version without minting a session', async () => {
    const r = await legacy(token, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } })
    expect(r.body.result).toMatchObject({ protocolVersion: '2025-06-18', capabilities: { tools: { listChanged: false } }, serverInfo: { name: 'print-better' } })
    expect(r.body.result.instructions).toContain('get_setup_status')
    expect(r.headers.get('Mcp-Session-Id')).toBeNull()
    const newer = await legacy(token, 'initialize', { protocolVersion: '2099-01-01' })
    expect(newer.body.result.protocolVersion).toBe('2025-11-25')
  })

  it('answers ping, lists tools, and reports unknown methods with 200', async () => {
    expect((await legacy(token, 'ping')).body.result).toEqual({})
    const list = await legacy(token, 'tools/list')
    expect(list.body.result.tools).toHaveLength(28)
    expect(list.body.result.resultType).toBeUndefined()
    const unknown = await legacy(token, 'resources/list')
    expect(unknown.status).toBe(200)
    expect(unknown.body.error.code).toBe(-32601)
  })

  it('rejects an unsupported MCP-Protocol-Version header after initialize', async () => {
    const r = await legacy(token, 'tools/list', {}, { 'MCP-Protocol-Version': '2024-11-05' })
    expect(r.status).toBe(400)
    expect(r.body.error).toMatchObject({ code: -32022, data: { requested: '2024-11-05', supported: [MODERN, '2025-11-25', '2025-06-18', '2025-03-26'] } })
    expect((await legacy(token, 'initialize', { protocolVersion: '2025-03-26' }, { 'MCP-Protocol-Version': '2024-11-05' })).status).toBe(200)
  })
})

describe('2026-07-28 era (stateless)', () => {
  const serverInfo = { [`${META}serverInfo`]: expect.objectContaining({ name: 'print-better' }) }

  it('describes itself through server/discover', async () => {
    const r = await modern(token, 'server/discover')
    expect(r.body.result).toMatchObject({ resultType: 'complete', supportedVersions: [MODERN, '2025-11-25', '2025-06-18', '2025-03-26'], ttlMs: 3_600_000, cacheScope: 'public', _meta: serverInfo })
    expect(r.body.result.capabilities).toEqual({ tools: {} })
  })

  it('lists tools privately cacheable and completes subscriptions at once', async () => {
    const list = await modern(token, 'tools/list')
    expect(list.body.result).toMatchObject({ resultType: 'complete', ttlMs: 3_600_000, cacheScope: 'private' })
    expect((await modern(token, 'subscriptions/listen')).body.result).toEqual({ resultType: 'complete', _meta: serverInfo })
    const unknown = await modern(token, 'resources/list')
    expect(unknown.status).toBe(404)
    expect(unknown.body.error.code).toBe(-32601)
  })

  it('requires _meta and matching headers', async () => {
    const noMeta = await mcpRaw(token, { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }, { 'MCP-Protocol-Version': MODERN, 'Mcp-Method': 'tools/list' })
    expect([noMeta.status, noMeta.body.error.code]).toEqual([400, -32602])
    const cases: [Record<string, unknown>, Record<string, string>, number][] = [
      [{}, { 'MCP-Protocol-Version': '2025-11-25' }, -32020],
      [{}, { 'Mcp-Method': 'tools/call' }, -32020],
      [{ _meta: { [`${META}protocolVersion`]: '2027-01-01' } }, { 'MCP-Protocol-Version': '2027-01-01' }, -32022],
      [{ _meta: { [`${META}clientCapabilities`]: null } }, {}, -32602],
    ]
    for (const [params, headers, code] of cases) {
      const r = await modern(token, 'tools/list', params, headers)
      expect(r.status, JSON.stringify(headers)).toBe(400)
      expect(r.body.error.code).toBe(code)
    }
  })

  it('matches Mcp-Name to the tool, including base64-encoded names', async () => {
    const mismatch = await modern(token, 'tools/call', { name: 'whoami', arguments: {} }, { 'Mcp-Name': 'list_jobs' })
    expect(mismatch.body.error.code).toBe(-32020)
    const encoded = await modern(token, 'tools/call', { name: 'whoami', arguments: {} }, { 'Mcp-Name': `=?base64?${btoa('whoami')}?=` })
    expect(encoded.body.result.isError).toBeUndefined()
  })
})

describe('scopes', () => {
  it('returns 403 insufficient_scope with a step-up challenge for every scope', async () => {
    const reader = await insertToken(owner.user.id, { scopes: ['read'] })
    expect((await callTool(reader, 'list_printers')).isError).toBe(false)
    const r = await callTool(reader, 'print', { text: 'hi' })
    expect(r.reply.status).toBe(403)
    expect(r.reply.headers.get('WWW-Authenticate')).toBe(`Bearer error="insufficient_scope", scope="read write print", resource_metadata="${PRM}"`)
    expect(r.reply.body).toEqual({ error: 'insufficient_scope', error_description: 'This tool needs the "print" permission' })
    expect((await callTool(reader, 'create_workspace', { name: 'X' })).reply.status).toBe(403)
    expect((await modern(reader, 'tools/list')).body.result.tools).toHaveLength(28)
  })
})
