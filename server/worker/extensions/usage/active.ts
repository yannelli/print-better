import { EXTENSIONS } from '../../../shared/extensions'
import type { JobHold } from '../../../shared/printing'
import { USAGE_EXTENSIONS } from '../../../shared/usage'
import { notFound } from '../../http/errors'
import { isObj } from '../../http/validate'
import { memo, type Ctx } from '../../services/context'
import { activeExtensions, extensionConfig, isActive } from '../state'

/** The job check, page counts, usage and prices work while either usage extension is active. */
export async function usageActive(ctx: Ctx, workspaceId: string): Promise<boolean> {
  const active = await activeExtensions(ctx, workspaceId)
  return USAGE_EXTENSIONS.some((id) => active.has(id))
}

/** Entry check for the shared usage routes and tools. */
export async function requireUsage(ctx: Ctx, workspaceId: string): Promise<void> {
  if (await usageActive(ctx, workspaceId)) return
  const names = EXTENSIONS.filter((e) => USAGE_EXTENSIONS.includes(e.id)).map((e) => e.name)
  const one = names.length === 1
  throw notFound(
    `${names.join(' and ')} ${one ? 'is' : 'are'} turned off for this workspace. A server admin makes ${one ? 'it' : 'one'} available under Server admin > Extensions, then a workspace owner turns it on under Workspace settings > Extensions.`,
    'extension_inactive',
  )
}

/** Enterprise controls with its approvals or secure release part on: only then can a job wait as `held`. */
export async function holdAvailable(ctx: Ctx, workspaceId: string, kind: JobHold['kind']): Promise<boolean> {
  if (!(await isActive(ctx, workspaceId, 'enterprise'))) return false
  const config = await memo(ctx, `enterprise-config:${workspaceId}`, () => extensionConfig(ctx.env, workspaceId, 'enterprise'))
  const part = kind === 'approval' ? config.approvals : config.release
  return isObj(part) && part.enabled === true
}
