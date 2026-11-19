import type { Json } from './body'
import { badRequest } from './errors'

export interface StrOpts {
  min?: number
  max?: number
  pattern?: RegExp
  /** Message used when `pattern` does not match. */
  hint?: string
}

function checkStr(key: string, value: unknown, { min = 1, max = 200, pattern, hint }: StrOpts): string {
  if (typeof value !== 'string') throw badRequest(`${key} must be a string`)
  const s = value.trim()
  if (s.length < min) throw badRequest(min <= 1 ? `${key} is required` : `${key} must be at least ${min} characters`)
  if (s.length > max) throw badRequest(`${key} must be at most ${max} characters`)
  if (pattern && !pattern.test(s)) throw badRequest(hint ?? `${key} is not valid`)
  return s
}

export const str = (o: Json, key: string, opts: StrOpts = {}): string => checkStr(key, o[key], opts)

export const optStr = (o: Json, key: string, opts: StrOpts = {}): string | undefined =>
  o[key] === undefined ? undefined : checkStr(key, o[key], opts)

/** `undefined` = leave unchanged, `null` (or empty string) = clear. */
export function nullableStr(o: Json, key: string, opts: StrOpts = {}): string | null | undefined {
  const v = o[key]
  if (v === undefined) return undefined
  if (v === null || (typeof v === 'string' && v.trim() === '')) return null
  return checkStr(key, v, opts)
}

function checkInt(key: string, value: unknown, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isInteger(value)) throw badRequest(`${key} must be an integer`)
  if (value < min || value > max) throw badRequest(`${key} must be between ${min} and ${max}`)
  return value
}

export const int = (o: Json, key: string, min: number, max: number): number => checkInt(key, o[key], min, max)

export const optInt = (o: Json, key: string, min: number, max: number): number | undefined =>
  o[key] === undefined || o[key] === null ? undefined : checkInt(key, o[key], min, max)

export function optBool(o: Json, key: string): boolean | undefined {
  const v = o[key]
  if (v === undefined) return undefined
  if (typeof v !== 'boolean') throw badRequest(`${key} must be true or false`)
  return v
}

export function oneOf<T extends string>(o: Json, key: string, values: readonly T[]): T {
  const v = o[key]
  if (typeof v !== 'string' || !values.includes(v as T)) throw badRequest(`${key} must be one of: ${values.join(', ')}`)
  return v as T
}

export const optOneOf = <T extends string>(o: Json, key: string, values: readonly T[]): T | undefined =>
  o[key] === undefined ? undefined : oneOf(o, key, values)

export function isObj(v: unknown): v is Json {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

export function obj(o: Json, key: string): Json {
  const v = o[key]
  if (!isObj(v)) throw badRequest(`${key} must be an object`)
  return v
}

export const optObj = (o: Json, key: string): Json | undefined => (o[key] === undefined ? undefined : obj(o, key))

export function strArray(o: Json, key: string, maxItems: number, opts: StrOpts = {}): string[] {
  const v = o[key]
  if (!Array.isArray(v)) throw badRequest(`${key} must be an array`)
  if (v.length > maxItems) throw badRequest(`${key} may have at most ${maxItems} entries`)
  return v.map((item, i) => checkStr(`${key}[${i}]`, item, opts))
}

export const USERNAME = { min: 2, max: 32, pattern: /^[a-z0-9._-]+$/i, hint: 'username may use letters, digits, ".", "_" and "-"' }
export const EMAIL = { max: 254, pattern: /^[^\s@]+@[^\s@]+\.[^\s@]+$/, hint: 'email is not a valid address' }
export const NAME = { max: 100 }

/** Passwords are not trimmed: surrounding spaces are part of the secret. */
export function password(o: Json, key: string): string {
  const v = o[key]
  if (typeof v !== 'string') throw badRequest(`${key} must be a string`)
  if (v.length < 8) throw badRequest(`${key} must be at least 8 characters`)
  if (v.length > 256) throw badRequest(`${key} must be at most 256 characters`)
  return v
}

export const optPassword = (o: Json, key: string): string | undefined =>
  o[key] === undefined || o[key] === null || o[key] === '' ? undefined : password(o, key)
