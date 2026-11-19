import type { Client, Os } from '@shared/types'
import type { DownloadManifest } from '@/lib/api/types'

const SEMVER = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/
/** Devices that install updates themselves; Windows still updates through install.ps1. */
const SELF_UPDATING: Partial<Record<Os, string>> = { macos: 'macos-', linux: 'linux-' }

/** Semantic version order (-1, 0, 1); null when either side is not a version. */
export function compareVersions(a: string, b: string): number | null {
  const x = SEMVER.exec(a.trim())
  const y = SEMVER.exec(b.trim())
  if (!x || !y) return null
  for (let i = 1; i <= 3; i++) {
    const diff = Number(x[i]) - Number(y[i])
    if (diff) return Math.sign(diff)
  }
  return comparePrerelease(x[4], y[4])
}

function comparePrerelease(a: string | undefined, b: string | undefined): number {
  if (a === b) return 0
  if (a === undefined) return 1
  if (b === undefined) return -1
  const pa = a.split('.')
  const pb = b.split('.')
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const [x, y] = [pa[i], pb[i]]
    if (x === undefined) return -1
    if (y === undefined) return 1
    if (x === y) continue
    const [nx, ny] = [/^\d+$/.test(x), /^\d+$/.test(y)]
    if (nx && ny) return Math.sign(Number(x) - Number(y))
    if (nx !== ny) return nx ? -1 : 1
    return x < y ? -1 : 1
  }
  return 0
}

/** The published version a device is behind, when it can install it itself. */
export function availableUpdate(client: Pick<Client, 'os' | 'version'>, manifest: DownloadManifest | null | undefined): string | null {
  const prefix = client.os ? SELF_UPDATING[client.os] : undefined
  if (!manifest || !prefix || !client.version) return null
  if (!Object.keys(manifest.files).some((key) => key.startsWith(prefix))) return null
  return (compareVersions(manifest.version, client.version) ?? 0) > 0 ? manifest.version : null
}
