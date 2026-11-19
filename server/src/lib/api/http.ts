import type { ApiErrorBody } from '@shared/types'

export class ApiError extends Error {
  readonly status: number
  readonly code: string

  constructor(status: number, code: string, message: string) {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.code = code
  }

  get isUnauthorized() {
    return this.status === 401
  }
  get isForbidden() {
    return this.status === 403
  }
  get isNotFound() {
    return this.status === 404
  }
  get isNetwork() {
    return this.status === 0
  }
}

const FALLBACK: Record<number, string> = {
  400: 'Something in the form needs another look.',
  401: 'Please sign in again.',
  403: "You don't have permission to do that.",
  404: "That couldn't be found. It may have been removed.",
  409: 'That conflicts with something that changed. Refresh and try again.',
  413: 'That file is too large.',
  429: 'Too many tries. Wait a moment and try again.',
}

function fallbackMessage(status: number) {
  return FALLBACK[status] ?? 'The server had a problem. Try again in a moment.'
}

export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  return 'Something went wrong.'
}

type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'

export async function request<T>(method: Method, path: string, body?: unknown): Promise<T> {
  let res: Response
  try {
    res = await fetch(`/api${path}`, {
      method,
      credentials: 'same-origin',
      headers: body === undefined ? { Accept: 'application/json' } : { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
  } catch {
    throw new ApiError(0, 'network', "Can't reach the server. Check your internet connection.")
  }
  if (res.status === 204) return undefined as T
  const data: unknown = await res.json().catch(() => null)
  if (!res.ok) {
    const err = (data as ApiErrorBody | null)?.error
    throw new ApiError(res.status, err?.code ?? `http_${res.status}`, err?.message ?? fallbackMessage(res.status))
  }
  return data as T
}

export const http = {
  get: <T>(path: string) => request<T>('GET', path),
  post: <T>(path: string, body: unknown = {}) => request<T>('POST', path, body),
  put: <T>(path: string, body: unknown) => request<T>('PUT', path, body),
  patch: <T>(path: string, body: unknown) => request<T>('PATCH', path, body),
  del: <T = void>(path: string) => request<T>('DELETE', path),
}

export function qs(params: Record<string, string | number | boolean | null | undefined>): string {
  const search = new URLSearchParams()
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== '') search.set(key, String(value))
  }
  const text = search.toString()
  return text ? `?${text}` : ''
}

export const enc = encodeURIComponent

/** Accepts either a bare array or a `{ items }` envelope, since only paginated lists are specified. */
export function items<T>(data: T[] | { items: T[] }): T[] {
  return Array.isArray(data) ? data : data.items
}

/** PUT with upload progress; fetch() still has no portable upload progress. */
export function uploadWithProgress<T>(
  url: string,
  file: Blob,
  onProgress: (fraction: number) => void,
  signal?: AbortSignal,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest()
    xhr.open('PUT', url)
    xhr.setRequestHeader('Content-Type', file.type || 'application/octet-stream')
    xhr.responseType = 'json'
    xhr.upload.onprogress = (e) => e.lengthComputable && onProgress(e.loaded / e.total)
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) return resolve(xhr.response as T)
      const err = (xhr.response as ApiErrorBody | null)?.error
      reject(new ApiError(xhr.status, err?.code ?? `http_${xhr.status}`, err?.message ?? fallbackMessage(xhr.status)))
    }
    xhr.onerror = () => reject(new ApiError(0, 'network', 'The upload stopped. Check your connection and try again.'))
    xhr.onabort = () => reject(new ApiError(0, 'aborted', 'Upload canceled.'))
    signal?.addEventListener('abort', () => xhr.abort())
    xhr.send(file)
  })
}
