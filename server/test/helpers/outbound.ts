import { vi } from 'vitest'

export type FetchHandler = (req: Request) => Response | Promise<Response>

/** The Worker shares the test isolate, so stubbing the global fetch intercepts its outbound calls. */
export function stubFetch(handler: FetchHandler) {
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => handler(new Request(input, init)))
}

/** Routes by exact URL (without query) and records every request seen; anything else gets a 599. */
export function routeFetch(routes: Record<string, FetchHandler>) {
  const seen: Request[] = []
  const spy = stubFetch(async (req) => {
    seen.push(req.clone())
    const url = new URL(req.url)
    const handler = routes[`${url.origin}${url.pathname}`]
    return handler ? handler(req) : new Response(`No stub for ${req.method} ${req.url}`, { status: 599 })
  })
  return { spy, seen }
}
