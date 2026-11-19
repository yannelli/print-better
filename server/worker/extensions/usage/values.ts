import type { PriceList } from '../../../shared/usage'
import type { Json } from '../../http/body'
import { badRequest } from '../../http/errors'
import { isObj } from '../../http/validate'

/** Unknown keys are refused, like job options, so a typo never silently changes nothing. */
export function onlyKeys(o: Json, allowed: readonly string[], where: string): void {
  const unknown = Object.keys(o).filter((k) => !allowed.includes(k))
  if (unknown.length > 0) throw badRequest(`Unknown ${where}: ${unknown.join(', ')}. Allowed: ${allowed.join(', ')}`)
}

/** An object with only the `allowed` keys. */
export function objectOf(value: unknown, path: string, allowed: readonly string[]): Json {
  if (!isObj(value)) throw badRequest(`${path} must be an object`)
  onlyKeys(value, allowed, `key in ${path}`)
  return value
}

/** A whole number from `min` to `max`. */
export function wholeNumber(value: unknown, path: string, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) {
    throw badRequest(`${path} must be a whole number from ${min} to ${max}`)
  }
  return value
}

/** A million in the workspace currency per page. */
export const MAX_MICROS = 1_000_000_000_000

const PRICE_KEYS = ['bwPageMicros', 'colorPageMicros', 'duplexSheetDiscountMicros'] as const

export function priceList(value: unknown, path: string): PriceList {
  const o = objectOf(value, path, PRICE_KEYS)
  const [bwPageMicros, colorPageMicros, duplexSheetDiscountMicros] = PRICE_KEYS.map((k) => wholeNumber(o[k], `${path}.${k}`, 0, MAX_MICROS))
  return { bwPageMicros, colorPageMicros, duplexSheetDiscountMicros }
}
