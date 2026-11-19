import type { UiEvent } from '../../shared/protocol'
import type { Role } from '../../shared/types'
import { JOB_VIEW_HOOKS } from '../extensions/hooks'
import { loadJobViews } from '../extensions/job-view'
import { extensionActive } from '../extensions/state'
import { all } from '../lib/db'

/** A safety net for a missed invalidation; access and extension changes clear the cache at once. */
const TTL_MS = 60_000

/** Rewrites a job or approval event for one browser; other events pass unchanged. */
export type ShowEvent = (event: UiEvent, userId: string) => UiEvent

async function load(env: Env, workspaceId: string): Promise<ShowEvent | null> {
  const view = await loadJobViews(env, workspaceId, (id) => extensionActive(env, workspaceId, id))
  if (!view) return null
  const members = await all<{ user_id: string; role: Role }>(env.DB, 'SELECT user_id, role FROM members WHERE workspace_id = ?', workspaceId)
  const roles = new Map(members.map((m) => [m.user_id, m.role]))
  return (event, userId) => {
    if (event.type !== 'job' && event.type !== 'approval') return event
    const role = roles.get(userId)
    return { ...event, job: view(event.job, role ? { kind: 'member', userId, role } : { kind: 'report' }) }
  }
}

/** What each browser may see of jobs in events; null, without a lookup, while no extension changes job views. */
export class HubJobViews {
  private loaded: Promise<ShowEvent | null> | null = null
  private loadedAt = 0

  constructor(private readonly env: Env) {}

  get(workspaceId: string): Promise<ShowEvent | null> {
    if (JOB_VIEW_HOOKS.length === 0) return Promise.resolve(null)
    if (!this.loaded || Date.now() - this.loadedAt >= TTL_MS) {
      const loading = load(this.env, workspaceId)
      this.loaded = loading
      this.loadedAt = Date.now()
      loading.catch(() => {
        if (this.loaded === loading) this.loaded = null
      })
    }
    return this.loaded
  }

  clear(): void {
    this.loaded = null
  }
}
