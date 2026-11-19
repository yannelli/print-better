import { availableTools, needsExtensions } from '../extensions/tools'
import { MB, readText } from '../http/body'
import { ApiError } from '../http/errors'
import { HOUR } from '../lib/time'
import type { Ctx } from '../services/context'
import { hasScope } from '../services/access'
import { insufficientScope, mcpContext } from './auth'
import { CODE, decodeHeaderValue, INSTRUCTIONS, LEGACY, META, MODERN, rpcError, rpcResult, SERVER_INFO, SUPPORTED, type RpcId } from './protocol'
import { argumentProblem, type Tool } from './tool'
import { TOOL_BY_NAME, TOOLS } from './tools'

// Base64 documents ride inside tools/call, so this bounds them (about 12 MB decoded).
const BODY_LIMIT = 16 * MB

type Params = Record<string, unknown>
type Finish = (result: Params) => Response

const isObject = (v: unknown): v is Params => typeof v === 'object' && v !== null && !Array.isArray(v)
const isId = (v: unknown): v is string | number => typeof v === 'string' || (typeof v === 'number' && Number.isFinite(v))

const listed = ({ name, title, description, inputSchema, annotations }: Tool) => ({ name, title, description, inputSchema, annotations: { title, ...annotations } })

/** The core tools, then those of extensions a server admin made available. */
const toolList = async (env: Env) => (await availableTools(env, TOOLS)).map(listed)

async function findTool(env: Env, name: unknown): Promise<Tool | undefined> {
  if (typeof name !== 'string') return undefined
  if (!needsExtensions(name, TOOL_BY_NAME)) return TOOL_BY_NAME.get(name)
  return (await availableTools(env, TOOLS)).find((t) => t.name === name)
}

const toolError = (message: string): Params => ({ content: [{ type: 'text', text: message }], isError: true })

/** Service errors become `isError` results the model can read and correct; HTTP-level errors are reserved for auth. */
async function callTool(ctx: Ctx, id: RpcId, params: Params, finish: Finish): Promise<Response> {
  const tool = await findTool(ctx.env, params.name)
  if (!tool) return rpcError(id, 200, CODE.invalidParams, `Unknown tool: ${String(params.name)}`)
  if (!hasScope(ctx, tool.scope)) return insufficientScope(ctx.origin, tool.scope)
  const args = params.arguments ?? {}
  if (!isObject(args)) return rpcError(id, 200, CODE.invalidParams, 'arguments must be an object')
  const problem = argumentProblem(tool.inputSchema, args)
  if (problem) return finish(toolError(problem))
  try {
    const { summary, data } = await tool.run(ctx, args)
    return finish({ content: [{ type: 'text', text: summary }, { type: 'text', text: JSON.stringify(data) }], structuredContent: data })
  } catch (e) {
    if (e instanceof ApiError && e.code === 'insufficient_scope') return insufficientScope(ctx.origin, tool.scope)
    if (e instanceof ApiError) return finish(toolError(e.message))
    console.error('mcp tool failed', tool.name, e)
    return finish(toolError('Something went wrong on the Print Better server. Try again in a moment.'))
  }
}

/** 2026-07-28: stateless; every request carries `_meta`, mirrored in the MCP-Protocol-Version, Mcp-Method and Mcp-Name headers. */
function modern(req: Request, ctx: Ctx, id: RpcId, method: string, params: Params): Promise<Response> | Response {
  const meta = isObject(params._meta) ? params._meta : {}
  const version = meta[`${META}protocolVersion`]
  if (typeof version !== 'string') return rpcError(id, 400, CODE.invalidParams, `params._meta["${META}protocolVersion"] is required`)
  if (req.headers.get('MCP-Protocol-Version') !== version) return rpcError(id, 400, CODE.headerMismatch, 'The MCP-Protocol-Version header must match _meta')
  if (version !== MODERN) return rpcError(id, 400, CODE.unsupportedVersion, 'Unsupported protocol version', { supported: SUPPORTED, requested: version })
  if (!isObject(meta[`${META}clientCapabilities`])) return rpcError(id, 400, CODE.invalidParams, `params._meta["${META}clientCapabilities"] is required`)
  if (req.headers.get('Mcp-Method') !== method) return rpcError(id, 400, CODE.headerMismatch, 'The Mcp-Method header must match the method')
  if (method === 'tools/call' && decodeHeaderValue(req.headers.get('Mcp-Name')) !== params.name) {
    return rpcError(id, 400, CODE.headerMismatch, 'The Mcp-Name header must match params.name')
  }
  const finish: Finish = (result) => rpcResult(id, { resultType: 'complete', ...result, _meta: { [`${META}serverInfo`]: SERVER_INFO } })
  switch (method) {
    case 'server/discover':
      return finish({ supportedVersions: SUPPORTED, capabilities: { tools: {} }, instructions: INSTRUCTIONS, ttlMs: HOUR, cacheScope: 'public' })
    case 'tools/list':
      return toolList(ctx.env).then((tools) => finish({ tools, ttlMs: HOUR, cacheScope: 'private' }))
    case 'tools/call':
      return callTool(ctx, id, params, finish)
    case 'subscriptions/listen':
      // Stateless: the tool list changes only when an admin switches an extension, and clients see it on their next tools/list.
      return finish({})
    default:
      return rpcError(id, 404, CODE.methodNotFound, `Unknown method: ${method}`)
  }
}

/** 2025-03-26 through 2025-11-25: an initialize handshake without sessions, then plain requests. */
function legacy(req: Request, ctx: Ctx, id: RpcId, method: string, params: Params): Promise<Response> | Response {
  const finish: Finish = (result) => rpcResult(id, result)
  if (method === 'initialize') {
    const requested = typeof params.protocolVersion === 'string' ? params.protocolVersion : ''
    const protocolVersion = LEGACY.includes(requested) ? requested : LEGACY[0]
    return finish({ protocolVersion, capabilities: { tools: { listChanged: false } }, serverInfo: SERVER_INFO, instructions: INSTRUCTIONS })
  }
  const header = req.headers.get('MCP-Protocol-Version')
  if (header !== null && !LEGACY.includes(header)) {
    return rpcError(id, 400, CODE.unsupportedVersion, 'Unsupported protocol version', { supported: SUPPORTED, requested: header })
  }
  switch (method) {
    case 'ping':
      return finish({})
    case 'tools/list':
      return toolList(ctx.env).then((tools) => finish({ tools }))
    case 'tools/call':
      return callTool(ctx, id, params, finish)
    default:
      return rpcError(id, 200, CODE.methodNotFound, `Unknown method: ${method}`)
  }
}

/** `POST /mcp`: one JSON-RPC message per request, JSON responses only, bearer auth on every call. */
export async function handleMcp(req: Request, env: Env, exec: ExecutionContext, url: URL): Promise<Response> {
  if (req.method !== 'POST') return new Response(null, { status: 405, headers: { Allow: 'POST' } })
  const ctx = await mcpContext(req, env, url, (p) => exec.waitUntil(p))
  if (ctx instanceof Response) return ctx

  let body: unknown
  try {
    body = JSON.parse(await readText(req, BODY_LIMIT))
  } catch (e) {
    if (e instanceof ApiError) return rpcError(null, e.status, CODE.invalidRequest, e.message)
    return rpcError(null, 400, CODE.parse, 'The body is not valid JSON')
  }
  if (Array.isArray(body)) return rpcError(null, 400, CODE.invalidRequest, 'Batches are not supported; send one message per request')
  if (!isObject(body) || body.jsonrpc !== '2.0' || typeof body.method !== 'string') {
    return rpcError(isObject(body) && isId(body.id) ? body.id : null, 400, CODE.invalidRequest, 'Expected a JSON-RPC 2.0 request')
  }
  if (!('id' in body)) return new Response(null, { status: 202 })
  if (!isId(body.id)) return rpcError(null, 400, CODE.invalidRequest, 'The request id must be a string or number')
  const params = body.params ?? {}
  if (!isObject(params)) return rpcError(body.id, 400, CODE.invalidParams, 'params must be an object')

  const isModern = isObject(params._meta) && `${META}protocolVersion` in params._meta
  const route = isModern || req.headers.get('MCP-Protocol-Version') === MODERN ? modern : legacy
  return route(req, ctx, body.id, body.method, params)
}
