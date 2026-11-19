import { afterEach, describe, expect, it, vi } from 'vitest'
import { ApiError, errorMessage, http, items, qs, request, uploadWithProgress } from './http'

afterEach(() => vi.unstubAllGlobals())

function respond(status: number, body?: unknown) {
  const fetch = vi.fn(async () =>
    body === undefined ? new Response(null, { status }) : new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } }),
  )
  vi.stubGlobal('fetch', fetch)
  return fetch
}

async function failure(promise: Promise<unknown>): Promise<ApiError> {
  const error = await promise.then(() => null, (e: unknown) => e)
  expect(error).toBeInstanceOf(ApiError)
  return error as ApiError
}

describe('request', () => {
  it('prefixes /api, sends JSON and returns the body', async () => {
    const fetch = respond(200, { ok: 1 })
    await expect(http.post('/auth/login', { login: 'a', password: 'b' })).resolves.toEqual({ ok: 1 })
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('/api/auth/login')
    expect(init).toMatchObject({ method: 'POST', credentials: 'same-origin', body: '{"login":"a","password":"b"}' })
    expect(init.headers).toMatchObject({ 'Content-Type': 'application/json' })
  })

  it('sends no body or content type on GET and DELETE', async () => {
    const fetch = respond(204)
    await expect(http.del('/me/tokens/t1')).resolves.toBeUndefined()
    const init = (fetch.mock.calls[0] as unknown as [string, RequestInit])[1]
    expect(init.body).toBeUndefined()
    expect(init.headers).not.toHaveProperty('Content-Type')
  })

  it('maps the server error body to a typed ApiError', async () => {
    respond(403, { error: { code: 'bad_setup_token', message: 'That setup code is not right.' } })
    const error = await failure(request('POST', '/auth/setup', {}))
    expect(error).toMatchObject({ status: 403, code: 'bad_setup_token', message: 'That setup code is not right.' })
    expect(error.isForbidden).toBe(true)
  })

  it('falls back to a plain message when the body is missing or not JSON', async () => {
    respond(404)
    expect(await failure(http.get('/nope'))).toMatchObject({ status: 404, code: 'http_404', isNotFound: true })
    vi.stubGlobal('fetch', vi.fn(async () => new Response('<html>', { status: 502 })))
    const error = await failure(http.get('/boom'))
    expect(error.code).toBe('http_502')
    expect(error.message).toMatch(/server had a problem/)
  })

  it('reports a network failure as status 0', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Promise.reject(new TypeError('Failed to fetch'))))
    const error = await failure(http.get('/instance'))
    expect(error).toMatchObject({ status: 0, code: 'network', isNetwork: true })
    expect(error.message).toMatch(/internet connection/)
  })

  it('flags 401 so the app can sign out', async () => {
    respond(401, { error: { code: 'unauthorized', message: 'Sign in again' } })
    expect((await failure(http.get('/me'))).isUnauthorized).toBe(true)
  })
})

describe('helpers', () => {
  it('builds query strings without empty values', () => {
    expect(qs({ a: 'x y', b: undefined, c: null, d: '', e: 0, f: false })).toBe('?a=x+y&e=0&f=false')
    expect(qs({})).toBe('')
  })

  it('accepts lists as arrays or envelopes', () => {
    expect(items([1, 2])).toEqual([1, 2])
    expect(items({ items: [3] })).toEqual([3])
  })

  it('turns anything thrown into a sentence', () => {
    expect(errorMessage(new Error('Nope'))).toBe('Nope')
    expect(errorMessage('weird')).toBe('Something went wrong.')
  })
})

class FakeXhr {
  static last: FakeXhr
  upload: { onprogress?: (e: { lengthComputable: boolean; loaded: number; total: number }) => void } = {}
  headers: Record<string, string> = {}
  status = 0
  response: unknown = null
  responseType = ''
  method = ''
  url = ''
  body: unknown
  onload?: () => void
  onerror?: () => void
  onabort?: () => void
  constructor() {
    FakeXhr.last = this
  }
  open(method: string, url: string) {
    this.method = method
    this.url = url
  }
  setRequestHeader(k: string, v: string) {
    this.headers[k] = v
  }
  send(body: unknown) {
    this.body = body
  }
  abort() {
    this.onabort?.()
  }
  finish(status: number, response: unknown) {
    this.status = status
    this.response = response
    this.onload?.()
  }
}

describe('uploadWithProgress', () => {
  it('PUTs the file with its type, reports progress and resolves with the job', async () => {
    vi.stubGlobal('XMLHttpRequest', FakeXhr)
    const progress: number[] = []
    const file = new Blob(['%PDF'], { type: 'application/pdf' })
    const done = uploadWithProgress('https://x/api/workspaces/w/jobs/j/file', file, (f) => progress.push(f))
    const xhr = FakeXhr.last
    expect([xhr.method, xhr.url, xhr.headers['Content-Type'], xhr.body]).toEqual(['PUT', 'https://x/api/workspaces/w/jobs/j/file', 'application/pdf', file])
    xhr.upload.onprogress?.({ lengthComputable: true, loaded: 2, total: 4 })
    xhr.finish(200, { job: { id: 'j' } })
    await expect(done).resolves.toEqual({ job: { id: 'j' } })
    expect(progress).toEqual([0.5])
  })

  it('rejects with ApiError on a server error or a cancel', async () => {
    vi.stubGlobal('XMLHttpRequest', FakeXhr)
    const failed = uploadWithProgress('/u', new Blob(['x']), () => undefined)
    FakeXhr.last.finish(413, { error: { code: 'too_large', message: 'That file is over 50 MB.' } })
    expect(await failure(failed)).toMatchObject({ status: 413, code: 'too_large', message: 'That file is over 50 MB.' })
    expect(FakeXhr.last.headers['Content-Type']).toBe('application/octet-stream')

    const controller = new AbortController()
    const canceled = uploadWithProgress('/u', new Blob(['x']), () => undefined, controller.signal)
    controller.abort()
    expect(await failure(canceled)).toMatchObject({ status: 0, code: 'aborted' })
  })
})
