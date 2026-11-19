import { call, nextIp, type Body } from './http'

export const MODERN = '2026-07-28'
export const META = 'io.modelcontextprotocol/'

export interface RpcReply {
  status: number
  headers: Headers
  body: Body
}

let ids = 0

/** POST /mcp with an arbitrary body and headers (bearer `token` when given). */
export async function mcpRaw(token: string | null, body: unknown, headers: Record<string, string> = {}, path = '/mcp'): Promise<RpcReply> {
  const auth: Record<string, string> = token ? { Authorization: `Bearer ${token}` } : {}
  const res = await call(path, {
    method: 'POST',
    body: typeof body === 'string' ? body : JSON.stringify(body),
    headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', 'CF-Connecting-IP': nextIp(), ...auth, ...headers },
  })
  const text = await res.text()
  return { status: res.status, headers: res.headers, body: text ? JSON.parse(text) : null }
}

/** A 2026-07-28 request: `_meta` plus the mirrored MCP-Protocol-Version, Mcp-Method and Mcp-Name headers. */
export function modern(token: string | null, method: string, params: Record<string, unknown> = {}, headers: Record<string, string> = {}): Promise<RpcReply> {
  const meta = { [`${META}protocolVersion`]: MODERN, [`${META}clientCapabilities`]: {}, ...((params._meta as object) ?? {}) }
  const mirrored: Record<string, string> = { 'MCP-Protocol-Version': MODERN, 'Mcp-Method': method }
  if (method === 'tools/call') mirrored['Mcp-Name'] = String(params.name)
  ids += 1
  return mcpRaw(token, { jsonrpc: '2.0', id: ids, method, params: { ...params, _meta: meta } }, { ...mirrored, ...headers })
}

/** A 2025-era request (no `_meta`, no mirrored headers). */
export function legacy(token: string | null, method: string, params: Record<string, unknown> = {}, headers: Record<string, string> = {}): Promise<RpcReply> {
  ids += 1
  return mcpRaw(token, { jsonrpc: '2.0', id: ids, method, params }, headers)
}

export interface ToolResult {
  reply: RpcReply
  isError: boolean
  summary: string
  data: Body
}

/** Calls a tool over the modern era and splits the result into its summary and structured data. */
export async function callTool(token: string, name: string, args: Record<string, unknown> = {}): Promise<ToolResult> {
  const reply = await modern(token, 'tools/call', { name, arguments: args })
  const result = reply.body?.result
  return { reply, isError: result?.isError === true, summary: result?.content?.[0]?.text ?? '', data: result?.structuredContent }
}
