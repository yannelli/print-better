import { badRequest, tooLarge } from './errors'

export type Json = Record<string, unknown>

export const KB = 1024
export const MB = 1024 * KB

/** Reads at most `limit` bytes of a request or response body, failing fast on a declared or actual overflow. */
export async function readBytes(src: Request | Response, limit: number): Promise<Uint8Array> {
  const declared = Number(src.headers.get('Content-Length') ?? NaN)
  if (declared > limit) throw tooLarge(`Body exceeds ${limit} bytes`)
  if (!src.body) return new Uint8Array()
  const reader = src.body.getReader()
  const parts: Uint8Array[] = []
  let size = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    size += value.byteLength
    if (size > limit) {
      await reader.cancel()
      throw tooLarge(`Body exceeds ${limit} bytes`)
    }
    parts.push(value)
  }
  const out = new Uint8Array(size)
  let offset = 0
  for (const p of parts) {
    out.set(p, offset)
    offset += p.byteLength
  }
  return out
}

export async function readText(req: Request, limit = 64 * KB): Promise<string> {
  return new TextDecoder().decode(await readBytes(req, limit))
}

/** Parses a JSON object body; an empty body is treated as `{}`. */
export async function readJson(req: Request, limit = 64 * KB): Promise<Json> {
  const text = await readText(req, limit)
  if (text.trim() === '') return {}
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    throw badRequest('Body must be valid JSON')
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw badRequest('Body must be a JSON object')
  return value as Json
}
