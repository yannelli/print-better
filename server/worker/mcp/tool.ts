import type { Json } from '../http/body'
import { badRequest } from '../http/errors'
import { optStr } from '../http/validate'
import type { Scope } from '../oauth/common'
import { requireUser } from '../services/access'
import type { Ctx } from '../services/context'
import { userWorkspaces } from '../services/workspaces'

export type Schema = Record<string, unknown>

// A type alias (not an interface) so nested object schemas still fit `Schema`'s index signature.
export type ObjectSchema = {
  type: 'object'
  description?: string
  properties: Record<string, Schema>
  required?: string[]
  additionalProperties: false
}

export interface Annotations {
  readOnlyHint: boolean
  destructiveHint: boolean
  idempotentHint: boolean
  openWorldHint: false
}

export interface ToolOutput {
  summary: string
  data: Record<string, unknown>
}

export interface Tool {
  name: string
  title: string
  description: string
  scope: Scope
  annotations: Annotations
  inputSchema: ObjectSchema
  run(ctx: Ctx, args: Json): Promise<ToolOutput>
}

export const READ: Annotations = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
/** Creates something or triggers an action each time it is called. */
export const ACTION: Annotations = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false }
export const UPDATE: Annotations = { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false }
export const REMOVE: Annotations = { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false }

export const text = (description: string, extra: Schema = {}): Schema => ({ type: 'string', description, ...extra })
export const nullableText = (description: string): Schema => ({ type: ['string', 'null'], description })
export const integer = (description: string, minimum: number, maximum: number): Schema => ({ type: 'integer', description, minimum, maximum })
export const bool = (description: string): Schema => ({ type: 'boolean', description })
export const choice = (description: string, values: readonly string[]): Schema => ({ type: 'string', enum: [...values], description })

export function object(properties: Record<string, Schema>, required: string[] = [], description?: string): ObjectSchema {
  return { type: 'object', ...(description ? { description } : {}), properties, ...(required.length ? { required } : {}), additionalProperties: false }
}

const WORKSPACE_ID = text('Workspace id. Optional when the token is limited to one workspace or you belong to exactly one.')

/** Object schema for tools that act inside a workspace. */
export const inWorkspace = (properties: Record<string, Schema> = {}, required: string[] = []): ObjectSchema =>
  object({ workspaceId: WORKSPACE_ID, ...properties }, required)

export const output = (summary: string, data: Record<string, unknown>): ToolOutput => ({ summary, data })

/** Unknown or missing top-level arguments; the services validate the values themselves. */
export function argumentProblem(schema: ObjectSchema, args: Json): string | null {
  const allowed = Object.keys(schema.properties)
  const unknown = Object.keys(args).filter((k) => !allowed.includes(k))
  if (unknown.length > 0) return `Unknown argument ${unknown.join(', ')}. Allowed: ${allowed.join(', ') || 'none'}.`
  const missing = (schema.required ?? []).filter((k) => args[k] === undefined || args[k] === null)
  return missing.length > 0 ? `Missing required argument ${missing.join(', ')}.` : null
}

/** The token's pinned workspace, else `workspaceId`, else the user's only workspace. */
export async function workspaceOf(ctx: Ctx, args: Json): Promise<string> {
  const pinned = ctx.actor.type === 'token' ? ctx.actor.workspaceId : null
  const given = optStr(args, 'workspaceId', { max: 64 }) ?? null
  if (pinned) {
    if (given && given !== pinned) throw badRequest(`This connection is limited to workspace ${pinned}; omit workspaceId.`, 'workspace_pinned')
    return pinned
  }
  if (given) return given
  const workspaces = await userWorkspaces(ctx.env, requireUser(ctx).id)
  if (workspaces.length === 1) return workspaces[0].id
  if (workspaces.length === 0) throw badRequest('You are not in a workspace yet. Call create_workspace first.', 'no_workspace')
  const choices = workspaces.map((w) => `${w.name} (${w.id})`).join(', ')
  throw badRequest(`You belong to several workspaces; pass workspaceId. Choices: ${choices}.`, 'workspace_required')
}

/** Copies the listed arguments into a service request body, dropping the ones not given. */
export function pick(args: Json, keys: string[]): Json {
  return Object.fromEntries(keys.filter((k) => args[k] !== undefined).map((k) => [k, args[k]]))
}
