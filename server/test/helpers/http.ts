import { exports } from 'cloudflare:workers'

export const ORIGIN = 'https://print.test'

let ips = 0
/** A fresh client IP per actor, so per-IP throttles never couple unrelated tests. */
export const nextIp = (): string => {
  ips += 1
  return `203.0.${Math.floor(ips / 250) % 250}.${(ips % 250) + 1}`
}

/** Sends a request straight to the Worker under test (no network). */
export function call(path: string, init: RequestInit = {}): Promise<Response> {
  return exports.default.fetch(new Request(new URL(path, ORIGIN), { redirect: 'manual', ...init }))
}

// Test bodies are loosely typed on purpose: assertions check the shape.
export type Body = any

export interface Reply {
  status: number
  body: Body
  res: Response
}

export async function readReply(res: Response): Promise<Reply> {
  const text = await res.text()
  let body: Body = text
  if (text && res.headers.get('Content-Type')?.includes('json')) body = JSON.parse(text)
  return { status: res.status, body, res }
}

export interface AgentOptions {
  /** `Authorization: Bearer …`; when set, no cookies are sent. */
  token?: string
  /** Origin header for non-GET requests; null sends none. */
  origin?: string | null
  ip?: string
}

/** A browser (cookie jar + Origin) or an API client (bearer token) talking to the Worker. */
export class Agent {
  readonly cookies = new Map<string, string>()
  readonly ip: string
  token: string | undefined
  origin: string | null

  constructor(opts: AgentOptions = {}) {
    this.token = opts.token
    this.origin = opts.origin === undefined ? ORIGIN : opts.origin
    this.ip = opts.ip ?? nextIp()
  }

  async fetch(path: string, init: RequestInit = {}): Promise<Response> {
    const headers = new Headers(init.headers)
    headers.set('CF-Connecting-IP', this.ip)
    if (this.token) headers.set('Authorization', `Bearer ${this.token}`)
    else if (this.cookies.size > 0) headers.set('Cookie', [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; '))
    const method = (init.method ?? 'GET').toUpperCase()
    if (this.origin && method !== 'GET' && !headers.has('Origin')) headers.set('Origin', this.origin)
    const res = await call(path, { ...init, headers })
    for (const cookie of res.headers.getSetCookie()) this.store(cookie)
    return res
  }

  async json(method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<Reply> {
    const init: RequestInit = { method, headers }
    if (body !== undefined) {
      init.body = JSON.stringify(body)
      init.headers = { 'Content-Type': 'application/json', ...headers }
    }
    return readReply(await this.fetch(path, init))
  }

  get = (path: string): Promise<Reply> => this.json('GET', path)
  post = (path: string, body: unknown = {}): Promise<Reply> => this.json('POST', path, body)
  patch = (path: string, body: unknown): Promise<Reply> => this.json('PATCH', path, body)
  put = (path: string, body: unknown): Promise<Reply> => this.json('PUT', path, body)
  del = (path: string): Promise<Reply> => this.json('DELETE', path)

  private store(setCookie: string): void {
    const [pair, ...attrs] = setCookie.split(';')
    const i = pair.indexOf('=')
    const name = pair.slice(0, i).trim()
    const value = pair.slice(i + 1).trim()
    const expired = attrs.some((a) => a.trim().toLowerCase() === 'max-age=0')
    if (expired || value === '') this.cookies.delete(name)
    else this.cookies.set(name, value)
  }
}

/** Parses one Set-Cookie header into its value and lower-cased attributes. */
export function parseSetCookie(header: string): { name: string; value: string; attrs: Record<string, string | true> } {
  const [pair, ...rest] = header.split(';')
  const i = pair.indexOf('=')
  const attrs: Record<string, string | true> = {}
  for (const part of rest) {
    const [k, v] = part.trim().split('=')
    attrs[k.toLowerCase()] = v === undefined ? true : v
  }
  return { name: pair.slice(0, i).trim(), value: pair.slice(i + 1).trim(), attrs }
}
