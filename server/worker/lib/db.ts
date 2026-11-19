export type SqlValue = string | number | boolean | null | undefined | ArrayBuffer

const norm = (args: SqlValue[]) => args.map((a) => (a === undefined ? null : typeof a === 'boolean' ? (a ? 1 : 0) : a))

export const stmt = (db: D1Database, sql: string, ...args: SqlValue[]): D1PreparedStatement =>
  db.prepare(sql).bind(...norm(args))

export const first = <T>(db: D1Database, sql: string, ...args: SqlValue[]): Promise<T | null> =>
  stmt(db, sql, ...args).first<T>()

export async function all<T>(db: D1Database, sql: string, ...args: SqlValue[]): Promise<T[]> {
  return (await stmt(db, sql, ...args).all<T>()).results
}

/** Runs a write and returns the number of changed rows. */
export async function run(db: D1Database, sql: string, ...args: SqlValue[]): Promise<number> {
  return (await stmt(db, sql, ...args).run()).meta.changes
}

export function parseJson<T>(text: string | null | undefined, fallback: T): T {
  if (!text) return fallback
  try {
    return JSON.parse(text) as T
  } catch {
    return fallback
  }
}

/** `?, ?, ?` for an IN list. D1 caps bound parameters at 100 per statement. */
export const placeholders = (n: number): string => Array.from({ length: n }, () => '?').join(', ')

export function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = []
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size))
  return out
}
