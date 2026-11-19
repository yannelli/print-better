import { DurableObject } from 'cloudflare:workers'
import { PING, PONG, STALE_SOCKET_MS, type CommandName, type ResultMsg, type ServerMessage, type UiEvent } from '../../shared/protocol'
import type { Role } from '../../shared/types'
import { clientSettings, SOURCE_CLIENT_NAME, toClient, toJob, toWorkspace } from '../db/map'
import type { ClientRow, JobViewRow, WorkspaceRow } from '../db/rows'
import { newId } from '../lib/crypto'
import { all, first } from '../lib/db'
import type { HubCommandResult } from '../services/clients'
import { handleClientMessage, type Session } from './client-messages'
import { printerConfigs } from './inventory'
import { offerView, stuckOffers, toOffer, type OfferRow } from './jobs'
import { remoteSnapshots } from './remote-printers'
import { attachment, CLIENT_TAG, clientTag, HUB_HEADERS, isOpen, send, UI_TAG, userTag, type Attachment, type ClientAtt } from './sockets'
import { HubJobViews } from './job-views'
import { HubAccessCache, UiFanOut } from './ui-access'

const SWEEP_MS = 30_000
const COMMAND_TIMEOUT_MS = 20_000
const STUCK_MS = 60_000
/** UI events that can change what other devices see in their `remote_printers` snapshot. */
const REMOTE_TRIGGERS = new Set<UiEvent['type']>(['printer', 'printer_removed', 'client', 'client_removed', 'access'])

/** One per workspace: device and browser sockets (hibernatable), job delivery, command relay, UI fan-out. */
export class WorkspaceHub extends DurableObject<Env> {
  private pending = new Map<string, (result: ResultMsg | null) => void>()
  private remoteRun: Promise<void> | null = null
  private remoteDirty = false
  private access = new HubAccessCache(this.env)
  private jobViews = new HubJobViews(this.env)
  private ui = new UiFanOut(this.ctx, this.access, this.jobViews)

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env)
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair(PING, PONG))
  }

  async fetch(req: Request): Promise<Response> {
    if (req.headers.get('Upgrade')?.toLowerCase() !== 'websocket') return new Response('Expected a WebSocket upgrade', { status: 426 })
    const h = (name: string) => req.headers.get(name) ?? ''
    const pair = new WebSocketPair()
    const [client, server] = [pair[0], pair[1]]
    const now = Date.now()
    if (h(HUB_HEADERS.kind) === 'client') {
      const clientId = h(HUB_HEADERS.client)
      for (const old of this.ctx.getWebSockets(clientTag(clientId))) old.close(4409, 'Replaced by a newer connection')
      this.ctx.acceptWebSocket(server, [CLIENT_TAG, clientTag(clientId)])
      const att: ClientAtt = { kind: 'client', workspaceId: h(HUB_HEADERS.workspace), clientId, origin: h(HUB_HEADERS.origin), ready: false, seenAt: now }
      server.serializeAttachment(att)
    } else {
      this.ctx.acceptWebSocket(server, [UI_TAG, userTag(h(HUB_HEADERS.user))])
      server.serializeAttachment({ kind: 'ui', workspaceId: h(HUB_HEADERS.workspace), userId: h(HUB_HEADERS.user), seenAt: now } satisfies Attachment)
    }
    if ((await this.ctx.storage.getAlarm()) === null) await this.ctx.storage.setAlarm(now + SWEEP_MS)
    return new Response(null, { status: 101, webSocket: client })
  }

  async webSocketMessage(ws: WebSocket, raw: string | ArrayBuffer): Promise<void> {
    const att = attachment(ws)
    if (!att) return ws.close(4500, 'Lost connection state')
    att.seenAt = Date.now()
    ws.serializeAttachment(att)
    if (att.kind === 'ui') return
    let msg: unknown
    try {
      msg = JSON.parse(typeof raw === 'string' ? raw : new TextDecoder().decode(raw))
    } catch {
      return ws.close(4400, 'Invalid JSON')
    }
    if (typeof msg !== 'object' || msg === null || Array.isArray(msg)) return ws.close(4400, 'Malformed message')
    try {
      await handleClientMessage(this.session(ws, att), msg as Record<string, unknown>)
    } catch (e) {
      // Closing makes the device reconnect and replay its state, which is how a failed write gets retried.
      console.error('hub message failed', e)
      ws.close(4500, 'Server error')
    }
  }

  async webSocketClose(ws: WebSocket): Promise<void> {
    await this.socketGone(ws)
  }

  async webSocketError(ws: WebSocket): Promise<void> {
    await this.socketGone(ws)
  }

  async alarm(): Promise<void> {
    const now = Date.now()
    for (const ws of this.ctx.getWebSockets()) {
      const att = attachment(ws)
      const last = Math.max(att?.seenAt ?? 0, this.ctx.getWebSocketAutoResponseTimestamp(ws)?.getTime() ?? 0)
      if (now - last <= STALE_SOCKET_MS) continue
      try {
        ws.close(1001, 'Idle timeout')
      } catch {
        // Already closed.
      }
      await this.socketGone(ws)
    }
    await this.reofferStuck(now)
    if (this.ctx.getWebSockets().length > 0) await this.ctx.storage.setAlarm(now + SWEEP_MS)
  }

  // ---- RPC called by the Worker after mutations ----

  /** Broadcasts the job and offers it to its device when connected; otherwise it waits for the next `hello`. `title` replaces a hidden name. */
  async dispatch(workspaceId: string, jobId: string, title?: string): Promise<void> {
    const job = await first<JobViewRow & { printer_key: string; client_id: string }>(
      this.env.DB,
      `SELECT j.*, p.name AS printer_name, ${SOURCE_CLIENT_NAME}, p.key AS printer_key, p.client_id FROM jobs j JOIN printers p ON p.id = j.printer_id WHERE j.id = ? AND j.workspace_id = ?`,
      jobId,
      workspaceId,
    )
    if (!job) return
    this.fanOut([{ type: 'job', job: toJob(job) }])
    if (job.status === 'queued' && job.file_key) this.toClient(job.client_id, { type: 'job', job: { ...toOffer(job), title: title ?? job.title } })
  }

  /** True when the owning device was connected and got the `cancel`. */
  async cancelJob(workspaceId: string, jobId: string): Promise<boolean> {
    const row = await first<{ client_id: string }>(this.env.DB, 'SELECT p.client_id FROM jobs j JOIN printers p ON p.id = j.printer_id WHERE j.id = ? AND j.workspace_id = ?', jobId, workspaceId)
    return row ? this.toClient(row.client_id, { type: 'cancel', jobId }) : false
  }

  async pushSettings(workspaceId: string, clientId: string): Promise<void> {
    const row = await first<ClientRow>(this.env.DB, 'SELECT * FROM clients WHERE id = ? AND workspace_id = ?', clientId, workspaceId)
    if (!row) return
    this.toClient(clientId, { type: 'settings', settings: clientSettings(row.settings), updatedAt: row.settings_updated_at })
    this.fanOut([{ type: 'client', client: toClient(row) }])
  }

  async pushPrinterConfig(_workspaceId: string, clientId: string): Promise<void> {
    if (this.readySocket(clientId)) this.toClient(clientId, { type: 'printer_config', printers: await printerConfigs(this.env, clientId) })
  }

  /** Null when the device is offline; a timeout after 20 s is reported as `{ ok: false, error: 'timeout' }`. */
  async command(_workspaceId: string, clientId: string, name: CommandName, args: Record<string, unknown>): Promise<HubCommandResult | null> {
    const ws = this.readySocket(clientId)
    if (!ws) return null
    const id = newId()
    const result = await new Promise<ResultMsg | null>((resolve) => {
      const timer = setTimeout(() => this.settle(id, null), COMMAND_TIMEOUT_MS)
      this.pending.set(id, (r) => {
        clearTimeout(timer)
        resolve(r)
      })
      if (!send(ws, { type: 'command', id, name, args })) this.settle(id, null)
    })
    if (!result) return { ok: false, error: 'timeout' }
    return {
      ok: result.ok === true,
      json: result.data === undefined ? undefined : JSON.stringify(result.data),
      error: typeof result.error === 'string' ? result.error : undefined,
    }
  }

  async broadcast(events: UiEvent[]): Promise<void> {
    this.fanOut(events)
  }

  /** Printer access or an extension switch changed: pages refetch, devices get snapshots under the new rules. */
  async accessChanged(): Promise<void> {
    this.access.clear()
    this.jobViews.clear()
    this.fanOut([{ type: 'access' }])
  }

  /** `Workspace` carries the viewer's role, so each browser gets its own copy. */
  async broadcastWorkspace(workspaceId: string): Promise<void> {
    this.access.clear()
    const row = await first<WorkspaceRow>(this.env.DB, 'SELECT * FROM workspaces WHERE id = ?', workspaceId)
    if (!row) return
    const roles = new Map((await all<{ user_id: string; role: Role }>(this.env.DB, 'SELECT user_id, role FROM members WHERE workspace_id = ?', workspaceId)).map((m) => [m.user_id, m.role]))
    for (const ws of this.ctx.getWebSockets(UI_TAG)) {
      const att = attachment(ws)
      const role = att?.kind === 'ui' ? roles.get(att.userId) : undefined
      if (role) send(ws, { type: 'workspace', workspace: toWorkspace(row, role) })
    }
  }

  async disconnect(target: { all?: boolean; clientId?: string; userId?: string; unpair?: boolean }, code: number, reason: string): Promise<void> {
    const sockets = target.all
      ? this.ctx.getWebSockets()
      : target.clientId
        ? this.ctx.getWebSockets(clientTag(target.clientId))
        : target.userId
          ? this.ctx.getWebSockets(userTag(target.userId))
          : []
    for (const ws of sockets) {
      if (target.unpair && attachment(ws)?.kind === 'client') send(ws, { type: 'command', id: newId(), name: 'unpair' })
      try {
        ws.close(code, reason)
      } catch {
        // Already closed.
      }
    }
  }

  /** Devices with a completed handshake on an open socket (used by the cron online sweep). */
  async liveClientIds(): Promise<string[]> {
    return this.ctx
      .getWebSockets(CLIENT_TAG)
      .filter(isOpen)
      .map(attachment)
      .flatMap((att) => (att?.kind === 'client' && att.ready ? [att.clientId] : []))
  }

  // ---- internals ----

  private session(ws: WebSocket, att: ClientAtt): Session {
    return {
      env: this.env,
      ws,
      att,
      save: () => ws.serializeAttachment(att),
      send: (msg) => send(ws, msg),
      broadcast: (events) => this.fanOut(events),
      resolveCommand: (msg) => this.settle(msg.id, msg),
      syncRemotePrinters: () => this.syncRemotePrinters(),
      waitUntil: (p) => this.ctx.waitUntil(p),
    }
  }

  private settle(id: string, result: ResultMsg | null): void {
    const resolve = this.pending.get(id)
    this.pending.delete(id)
    resolve?.(result)
  }

  private readySocket(clientId: string): WebSocket | null {
    return this.ctx.getWebSockets(clientTag(clientId)).find((ws) => isOpen(ws) && (attachment(ws) as ClientAtt | null)?.ready) ?? null
  }

  private toClient(clientId: string, msg: ServerMessage): boolean {
    const ws = this.readySocket(clientId)
    return ws ? send(ws, msg) : false
  }

  /** Every printer and device change reaches browsers through here, so desktops' remote printers are refreshed here too. */
  private fanOut(events: UiEvent[]): void {
    this.ui.send(events)
    if (events.some((e) => REMOTE_TRIGGERS.has(e.type))) void this.syncRemotePrinters()
  }

  /** One pass at a time, so an older snapshot never lands after a newer one; calls during a pass fold into one more pass. */
  private syncRemotePrinters(): Promise<void> {
    this.remoteDirty = true
    this.remoteRun ??= this.drainRemotePrinters()
    return this.remoteRun
  }

  private async drainRemotePrinters(): Promise<void> {
    try {
      while (this.remoteDirty) {
        this.remoteDirty = false
        await this.sendRemotePrinters()
      }
    } catch (e) {
      console.error('remote printers sync failed', e)
    } finally {
      this.remoteRun = null
    }
  }

  /** Sends each ready device its snapshot unless it matches the fingerprint of the last one that socket got. */
  private async sendRemotePrinters(): Promise<void> {
    const ready = this.ctx.getWebSockets(CLIENT_TAG).map(attachment).filter((a): a is ClientAtt => a?.kind === 'client' && a.ready)
    if (ready.length === 0) return
    const view = await this.access.get(ready[0].workspaceId)
    const canPrint = view && ((clientId: string, printerId: string) => view.device(clientId).can(printerId, 'print'))
    const snapshots = await remoteSnapshots(this.env, ready[0].workspaceId, ready.map((a) => a.clientId), canPrint)
    for (const ws of this.ctx.getWebSockets(CLIENT_TAG).filter(isOpen)) {
      const att = attachment(ws)
      if (att?.kind !== 'client' || !att.ready) continue
      const snapshot = snapshots.get(att.clientId)
      if (!snapshot || att.remotePrinters === snapshot.fingerprint) continue
      const msg = { type: 'remote_printers' as const, printers: snapshot.printers, ...(snapshot.direct.length > 0 && { direct: snapshot.direct }) }
      if (send(ws, msg)) ws.serializeAttachment({ ...att, remotePrinters: snapshot.fingerprint })
    }
  }

  /** Marks a device offline once its last socket is gone. */
  private async socketGone(ws: WebSocket): Promise<void> {
    const att = attachment(ws)
    if (att?.kind !== 'client') return
    if (this.ctx.getWebSockets(clientTag(att.clientId)).some((other) => other !== ws && isOpen(other))) return
    const row = await first<ClientRow>(this.env.DB, 'UPDATE clients SET online = 0, last_seen_at = ? WHERE id = ? AND online = 1 RETURNING *', Date.now(), att.clientId)
    if (row) this.fanOut([{ type: 'client', client: toClient(row) }])
  }

  /** At-least-once delivery: re-offer queued jobs a connected device has not acknowledged within a minute. */
  private async reofferStuck(now: number): Promise<void> {
    const ready = this.ctx.getWebSockets(CLIENT_TAG).map(attachment).filter((a): a is ClientAtt => a?.kind === 'client' && a.ready)
    if (ready.length === 0) return
    const live = new Set(ready.map((a) => a.clientId))
    const rows: OfferRow[] = await stuckOffers(this.env, ready[0].workspaceId, now - STUCK_MS)
    const offer = rows.length ? await offerView(this.env, ready[0].workspaceId) : null
    for (const row of rows) if (offer && live.has(row.client_id)) this.toClient(row.client_id, { type: 'job', job: offer(row) })
  }
}

