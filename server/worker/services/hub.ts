import type { WorkspaceHub } from '../hub/hub'
import type { Ctx } from './context'

export type HubStub = DurableObjectStub<WorkspaceHub>

/** One hub per workspace: its clients' sockets, open browser tabs, and in-flight commands. */
export const hubFor = (env: Env, workspaceId: string): HubStub => env.HUB.getByName(workspaceId)

/** Fire-and-forget hub call after a mutation; D1 already holds the truth, so failures are only logged. */
export function notifyHub(ctx: Ctx, workspaceId: string, call: (hub: HubStub) => Promise<unknown>): void {
  ctx.waitUntil(call(hubFor(ctx.env, workspaceId)).catch((e: unknown) => console.error('hub call failed', e)))
}
