import { VERSION } from '../version'

export const MODERN = '2026-07-28'
/** Legacy (initialize handshake) versions, newest first. */
export const LEGACY = ['2025-11-25', '2025-06-18', '2025-03-26']
export const SUPPORTED = [MODERN, ...LEGACY]
export const META = 'io.modelcontextprotocol/'

export const CODE = {
  parse: -32700,
  invalidRequest: -32600,
  methodNotFound: -32601,
  invalidParams: -32602,
  internal: -32603,
  headerMismatch: -32020,
  unsupportedVersion: -32022,
} as const

export type RpcId = string | number | null

export const SERVER_INFO = { name: 'print-better', title: 'Print Better', version: VERSION }

export const INSTRUCTIONS =
  'Print Better sends documents to printers at home or in the office and manages the devices, printers, members and settings behind them. ' +
  'Call get_setup_status first: it reports what is set up and names the next tool to call. ' +
  'Tools take an optional workspaceId, needed only when the user belongs to several workspaces.'

const HEADERS = { 'Cache-Control': 'no-store' }

export const rpcResult = (id: RpcId, result: unknown, status = 200): Response =>
  Response.json({ jsonrpc: '2.0', id, result }, { status, headers: HEADERS })

export const rpcError = (id: RpcId, status: number, code: number, message: string, data?: unknown): Response =>
  Response.json({ jsonrpc: '2.0', id, error: { code, message, ...(data === undefined ? {} : { data }) } }, { status, headers: HEADERS })

/** `Mcp-Name` carries non-ASCII names as `=?base64?…?=`. */
export function decodeHeaderValue(value: string | null): string | null {
  const encoded = value && /^=\?base64\?(.*)\?=$/i.exec(value)
  if (!encoded) return value
  try {
    return new TextDecoder().decode(Uint8Array.from(atob(encoded[1]), (c) => c.charCodeAt(0)))
  } catch {
    return null
  }
}
