import { badRequest } from './errors'

export type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'

export interface Http {
  req: Request
  url: URL
  env: Env
  exec: ExecutionContext
  params: Record<string, string>
  /** `Set-Cookie` values appended to whatever response the handler produces. */
  cookies: string[]
}

/** A handler returns a Response, a JSON-serializable value (200), or nothing (204). */
export type Handler = (h: Http) => unknown

interface Route {
  method: Method
  pattern: RegExp
  keys: string[]
  handler: Handler
}

export type Match = { handler: Handler; params: Record<string, string> }

export class Router {
  private routes: Route[] = []

  on(method: Method, path: string, handler: Handler): this {
    const keys: string[] = []
    const source = path.replace(/:(\w+)/g, (_, key: string) => {
      keys.push(key)
      return '([^/]+)'
    })
    this.routes.push({ method, pattern: new RegExp(`^${source}/?$`), keys, handler })
    return this
  }

  get = (path: string, handler: Handler) => this.on('GET', path, handler)
  post = (path: string, handler: Handler) => this.on('POST', path, handler)
  put = (path: string, handler: Handler) => this.on('PUT', path, handler)
  patch = (path: string, handler: Handler) => this.on('PATCH', path, handler)
  delete = (path: string, handler: Handler) => this.on('DELETE', path, handler)

  /** `'method'` means the path exists but not for this method. */
  match(method: string, pathname: string): Match | 'method' | null {
    let pathExists = false
    for (const route of this.routes) {
      const m = route.pattern.exec(pathname)
      if (!m) continue
      pathExists = true
      if (route.method !== method && !(method === 'HEAD' && route.method === 'GET')) continue
      const params: Record<string, string> = {}
      route.keys.forEach((key, i) => {
        try {
          params[key] = decodeURIComponent(m[i + 1])
        } catch {
          throw badRequest(`Malformed path parameter ${key}`)
        }
      })
      return { handler: route.handler, params }
    }
    return pathExists ? 'method' : null
  }
}

export function toResponse(result: unknown, cookies: string[]): Response {
  const res =
    result instanceof Response
      ? result
      : result === undefined || result === null
        ? new Response(null, { status: 204 })
        : Response.json(result)
  if (cookies.length === 0 || res.webSocket) return res
  // Responses from fetch/R2 can have immutable headers, so rebuild before appending cookies.
  const out = new Response(res.body, res)
  for (const c of cookies) out.headers.append('Set-Cookie', c)
  return out
}
