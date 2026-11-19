import type { ClientRow, UserRow } from '../db/rows'

export type Actor =
  | { type: 'anonymous' }
  | { type: 'user'; user: UserRow; sessionId: string }
  | { type: 'token'; user: UserRow; tokenId: string; workspaceId: string | null; scopes: string[] }
  | { type: 'client'; client: ClientRow }
  | { type: 'email'; sender: string }
  | { type: 'system' }

/** Everything a service needs: bindings, who is acting, and where the request came from. */
export interface Ctx {
  env: Env
  actor: Actor
  /** Public origin of this deployment, e.g. `https://print.example.com`. */
  origin: string
  ip: string | null
  userAgent: string | null
  /** Set by the MCP layer so jobs it creates record source `mcp`. */
  via?: 'mcp'
  /** Lookups shared by the services of one request (see `memo`). */
  memo?: Map<string, Promise<unknown>>
  waitUntil(promise: Promise<unknown>): void
}

/** Runs `load` once per request and key; later callers share its result. */
export function memo<T>(ctx: Ctx, key: string, load: () => Promise<T>): Promise<T> {
  ctx.memo ??= new Map()
  let hit = ctx.memo.get(key) as Promise<T> | undefined
  if (!hit) {
    hit = load()
    ctx.memo.set(key, hit)
  }
  return hit
}

export function systemCtx(env: Env, origin: string, waitUntil: Ctx['waitUntil'], actor: Actor = { type: 'system' }): Ctx {
  return { env, actor, origin, ip: null, userAgent: null, waitUntil }
}

/** Acting as a user that was just created or authenticated, before any session exists (for audit attribution). */
export const asUser = (ctx: Ctx, user: UserRow): Ctx => ({ ...ctx, actor: { type: 'user', user, sessionId: '' } })

/** The user behind a session or token actor. */
export function actingUser(ctx: Ctx): UserRow | null {
  return ctx.actor.type === 'user' || ctx.actor.type === 'token' ? ctx.actor.user : null
}

/** Actor identity as recorded in audit_log. */
export function actorRef(actor: Actor): { type: 'user' | 'token' | 'client' | 'email' | 'system'; id: string | null } {
  switch (actor.type) {
    case 'user':
      return { type: 'user', id: actor.user.id }
    case 'token':
      return { type: 'token', id: actor.user.id }
    case 'client':
      return { type: 'client', id: actor.client.id }
    case 'email':
      return { type: 'email', id: actor.sender }
    default:
      return { type: 'system', id: null }
  }
}
