import type { UiEvent } from '../../shared/protocol'
import type { Role } from '../../shared/types'
import { printerPolicy, type PrinterPolicy } from '../extensions/hooks'
import { extensionActive } from '../extensions/state'
import { all } from '../lib/db'
import { canSeeJob } from '../services/job-access'
import { accessFrom, type Access } from '../services/permissions'
import type { HubJobViews } from './job-views'
import { attachment, isOpen, send, UI_TAG } from './sockets'

/** A safety net for a missed invalidation; access changes clear the cache at once. */
const TTL_MS = 60_000

/** One workspace's printer access, as the hub needs it while an extension decides. */
export class HubAccess {
  constructor(
    private readonly policy: PrinterPolicy,
    private readonly roles: ReadonlyMap<string, Role>,
  ) {}

  knows(userId: string): boolean {
    return this.roles.has(userId)
  }

  device(clientId: string): Access {
    return accessFrom(this.policy, { kind: 'device', clientId })
  }

  /** Printer, job and approval events reach only people who may see them; every other event reaches everyone. */
  allows(userId: string, event: UiEvent): boolean {
    if (event.type !== 'printer' && event.type !== 'job' && event.type !== 'approval') return true
    const role = this.roles.get(userId)
    if (!role) return false
    const access = accessFrom(this.policy, { kind: 'member', userId, role })
    return event.type === 'printer' ? access.can(event.printer.id, 'view') : canSeeJob(access, userId, event.job.userId, event.job.printerId)
  }
}

async function load(env: Env, workspaceId: string): Promise<HubAccess | null> {
  const policy = await printerPolicy(env, workspaceId, (id) => extensionActive(env, workspaceId, id))
  if (!policy) return null
  const members = await all<{ user_id: string; role: Role }>(env.DB, 'SELECT user_id, role FROM members WHERE workspace_id = ?', workspaceId)
  return new HubAccess(policy, new Map(members.map((m) => [m.user_id, m.role])))
}

/** Loaded on demand and kept until access changes; null while no extension decides (nothing is filtered). */
export class HubAccessCache {
  private view: Promise<HubAccess | null> | null = null
  private loadedAt = 0

  constructor(private readonly env: Env) {}

  /** Reloads when one of `users` is unknown, which is how people who just joined start getting events. */
  async get(workspaceId: string, users: string[] = []): Promise<HubAccess | null> {
    if (this.view && Date.now() - this.loadedAt < TTL_MS) {
      const view = await this.view
      if (!view || users.every((u) => view.knows(u))) return view
    }
    const loading = load(this.env, workspaceId)
    this.view = loading
    this.loadedAt = Date.now()
    loading.catch(() => {
      if (this.view === loading) this.view = null
    })
    return loading
  }

  clear(): void {
    this.view = null
  }
}

/** Browser events, delivered in call order even when a delivery has to load access first. */
export class UiFanOut {
  private queue: Promise<void> = Promise.resolve()

  constructor(
    private readonly state: DurableObjectState,
    private readonly access: HubAccessCache,
    private readonly jobViews: HubJobViews,
  ) {}

  send(events: UiEvent[]): void {
    this.queue = this.queue.then(() => this.deliver(events)).catch((e: unknown) => console.error('ui fan-out failed', e))
  }

  private async deliver(events: UiEvent[]): Promise<void> {
    const sockets = this.state.getWebSockets(UI_TAG).filter(isOpen)
    const users = sockets.map((ws) => attachment(ws)).flatMap((att) => (att?.kind === 'ui' ? [att] : []))
    const scoped = users.length > 0 && events.some((e) => e.type === 'printer' || e.type === 'job' || e.type === 'approval')
    const view = scoped ? await this.access.get(users[0].workspaceId, users.map((u) => u.userId)) : null
    const show = scoped ? await this.jobViews.get(users[0].workspaceId) : null
    for (const event of events) {
      for (const ws of sockets) {
        const att = attachment(ws)
        if (view && !(att?.kind === 'ui' && view.allows(att.userId, event))) continue
        send(ws, show && att?.kind === 'ui' ? show(event, att.userId) : event)
      }
    }
  }
}
