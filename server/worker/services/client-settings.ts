import type { ClientSettings } from '../../shared/types'
import type { Json } from '../http/body'
import { isObj, nullableStr, optBool, optObj, optOneOf, strArray } from '../http/validate'

/** Deep-merges a partial ClientSettings patch, validating each field it touches. */
export function mergeClientSettings(current: ClientSettings, patch: Json): ClientSettings {
  const next = structuredClone(current)
  next.tray = optBool(patch, 'tray') ?? next.tray
  next.lanSharing = optBool(patch, 'lanSharing') ?? next.lanSharing
  next.autoAdd = optOneOf(patch, 'autoAdd', ['smart', 'all', 'none', 'inherit'] as const) ?? next.autoAdd
  next.paused = optBool(patch, 'paused') ?? next.paused
  next.logLevel = optOneOf(patch, 'logLevel', ['info', 'debug'] as const) ?? next.logLevel
  next.remotePrinters = optBool(patch, 'remotePrinters') ?? next.remotePrinters
  next.autoUpdate = optBool(patch, 'autoUpdate') ?? next.autoUpdate
  if (patch.remotePrintersHidden !== undefined) next.remotePrintersHidden = [...new Set(strArray(patch, 'remotePrintersHidden', 500, { max: 64 }))]
  const defaultPrinter = nullableStr(patch, 'defaultPrinter', { max: 64 })
  if (defaultPrinter !== undefined) next.defaultPrinter = defaultPrinter
  const discovery = optObj(patch, 'discovery')
  if (discovery) {
    for (const key of ['mdns', 'snmp', 'usb', 'os'] as const) next.discovery[key] = optBool(discovery, key) ?? next.discovery[key]
  }
  return next
}

/** Settings reported by a device; invalid input yields null instead of an error. */
export function deviceSettings(current: ClientSettings, reported: unknown): ClientSettings | null {
  if (!isObj(reported)) return null
  try {
    return mergeClientSettings(current, reported)
  } catch {
    return null
  }
}
