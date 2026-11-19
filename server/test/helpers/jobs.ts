import { env } from 'cloudflare:workers'
import type { UiEvent } from '../../shared/protocol'
import { ORIGIN, readReply, type Agent, type Body } from './http'
import type { Owner } from './world'

export const PDF = new TextEncoder().encode('%PDF-1.4\n1 0 obj << /Type /Catalog >> endobj\ntrailer << /Root 1 0 R >>\n%%EOF\n')

export async function sha256Hex(data: Uint8Array | string): Promise<string> {
  const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map((b) => b.toString(16).padStart(2, '0')).join('')
}

export const jobsPath = (ws: string): string => `/api/workspaces/${ws}/jobs`

/** setupOwner works once per file, so tests that need a clean hub get their own workspace. */
export async function freshWorkspace(owner: Owner, name = 'Office'): Promise<string> {
  const r = await owner.agent.post('/api/workspaces', { name })
  if (r.status !== 200) throw new Error(`create workspace failed: ${r.status} ${JSON.stringify(r.body)}`)
  return r.body.id
}

/** Opens the upload slot and PUTs the bytes; returns the queued job. */
export async function uploadJob(agent: Agent, ws: string, printerId: string, bytes = PDF, fileName = 'report.pdf', contentType = 'application/pdf'): Promise<Body> {
  const slot = await agent.post(jobsPath(ws), { printerId, upload: { fileName, contentType, size: bytes.byteLength } })
  if (slot.status !== 200) throw new Error(`upload slot failed: ${slot.status} ${JSON.stringify(slot.body)}`)
  const put = await readReply(await agent.fetch(new URL(slot.body.uploadUrl).pathname, { method: 'PUT', body: bytes, headers: { 'Content-Type': contentType } }))
  if (put.status !== 200) throw new Error(`upload failed: ${put.status} ${JSON.stringify(put.body)}`)
  return put.body.job
}

export async function textJob(agent: Agent, ws: string, printerId?: string, text = 'Hello from the test suite'): Promise<Body> {
  const r = await agent.post(jobsPath(ws), { printerId, text })
  if (r.status !== 200) throw new Error(`text job failed: ${r.status} ${JSON.stringify(r.body)}`)
  return r.body.job
}

export interface JobRowShape {
  id: string
  status: string
  status_message: string | null
  attempts: number
  file_key: string | null
  printer_id: string | null
  sha256: string | null
  pages: number | null
  source: string
  title: string
  created_at: number
  updated_at: number
}

export const jobRow = (id: string): Promise<JobRowShape | null> => env.DB.prepare('SELECT * FROM jobs WHERE id = ?').bind(id).first<JobRowShape>()

/** Writes job columns directly, e.g. to age a job or simulate a purge. */
export async function setJob(id: string, fields: Partial<Record<keyof JobRowShape, string | number | null>>): Promise<void> {
  const keys = Object.keys(fields)
  await env.DB.prepare(`UPDATE jobs SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`)
    .bind(...keys.map((k) => fields[k as keyof JobRowShape] ?? null), id)
    .run()
}

/** Asserts `check` keeps passing for `ms`: hub messages are async, so "nothing changed" needs a settle window. */
export async function consistently(check: () => Promise<unknown>, ms = 150): Promise<void> {
  const until = Date.now() + ms
  do {
    await check()
    await new Promise((r) => setTimeout(r, 25))
  } while (Date.now() < until)
}

type Ui<T extends UiEvent['type']> = Extract<UiEvent, { type: T }>

/** A browser tab's live-events socket (GET /api/workspaces/:ws/events). */
export class EventSocket {
  private inbox: UiEvent[] = []
  private wakers = new Set<() => void>()

  private constructor(readonly ws: WebSocket) {
    ws.addEventListener('message', (e) => {
      if (typeof e.data !== 'string' || e.data === 'pong') return
      this.inbox.push(JSON.parse(e.data) as UiEvent)
      for (const wake of [...this.wakers]) wake()
    })
    ws.accept()
  }

  static async open(agent: Agent, ws: string, headers: Record<string, string> = { Origin: ORIGIN }): Promise<EventSocket> {
    const res = await agent.fetch(`/api/workspaces/${ws}/events`, { headers: { Upgrade: 'websocket', ...headers } })
    if (!res.webSocket) throw new Error(`events upgrade failed: ${res.status} ${await res.text()}`)
    return new EventSocket(res.webSocket)
  }

  /** The oldest unread event of `type` matching `where`, waiting up to `timeoutMs`. */
  next<T extends UiEvent['type']>(type: T, where: (e: Ui<T>) => boolean = () => true, timeoutMs = 3000): Promise<Ui<T>> {
    return new Promise((resolve, reject) => {
      const check = () => {
        const i = this.inbox.findIndex((e) => e.type === type && where(e as Ui<T>))
        if (i < 0) return
        clearTimeout(timer)
        this.wakers.delete(check)
        resolve(this.inbox.splice(i, 1)[0] as Ui<T>)
      }
      const timer = setTimeout(() => {
        this.wakers.delete(check)
        reject(new Error(`no "${type}" event within ${timeoutMs} ms`))
      }, timeoutMs)
      this.wakers.add(check)
      check()
    })
  }

  close(): void {
    try {
      this.ws.close(1000, 'test done')
    } catch {
      // Already closed.
    }
  }
}
