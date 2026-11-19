import { badRequest } from '../http/errors'
import { b64url, fromB64url, fromUtf8, utf8 } from './encoding'

export interface Page<T> {
  items: T[]
  nextCursor: string | null
}

export function pageLimit(raw: string | null | undefined, fallback = 50, max = 200): number {
  if (raw === null || raw === undefined || raw === '') return fallback
  const n = Number(raw)
  if (!Number.isInteger(n) || n < 1) throw badRequest('limit must be a positive integer')
  return Math.min(n, max)
}

/** Keyset cursor over (created_at DESC, id DESC). */
export interface Cursor {
  createdAt: number
  id: string
}

export const encodeCursor = (c: Cursor): string => b64url(utf8(`${c.createdAt}:${c.id}`))

export function decodeCursor(raw: string | null | undefined): Cursor | null {
  if (!raw) return null
  try {
    const text = fromUtf8(fromB64url(raw))
    const i = text.indexOf(':')
    const createdAt = Number(text.slice(0, i))
    if (i < 1 || !Number.isFinite(createdAt)) throw new Error('bad cursor')
    return { createdAt, id: text.slice(i + 1) }
  } catch {
    throw badRequest('cursor is not valid')
  }
}

/** Fetch `limit + 1` rows, then call this to trim and compute the next cursor. */
export function toPage<R, T>(rows: R[], limit: number, cursorOf: (row: R) => Cursor, map: (row: R) => T): Page<T> {
  const more = rows.length > limit
  const kept = more ? rows.slice(0, limit) : rows
  return { items: kept.map(map), nextCursor: more ? encodeCursor(cursorOf(kept[kept.length - 1])) : null }
}
