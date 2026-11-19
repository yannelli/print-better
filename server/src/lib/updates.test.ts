import { describe, expect, it } from 'vitest'
import type { DownloadManifest } from '@/lib/api/types'
import { availableUpdate, compareVersions } from './updates'

const file = { name: 'x', sha256: 'a'.repeat(64), size: 1 }
const manifest: DownloadManifest = {
  version: '0.3.0',
  files: { 'macos-universal': file, 'macos-pkg': file, 'linux-x86_64': file, 'windows-x86_64': file },
}

describe('compareVersions', () => {
  it('orders by major, minor, patch numerically', () => {
    expect(compareVersions('0.10.0', '0.9.9')).toBe(1)
    expect(compareVersions('1.2.3', '1.2.3')).toBe(0)
    expect(compareVersions('1.2.3', '1.3.0')).toBe(-1)
    expect(compareVersions('v2.0.0', '1.99.99')).toBe(1)
  })

  it('puts pre-releases before the release and orders their identifiers', () => {
    expect(compareVersions('1.0.0-rc.1', '1.0.0')).toBe(-1)
    expect(compareVersions('1.0.0-alpha', '1.0.0-alpha.1')).toBe(-1)
    expect(compareVersions('1.0.0-alpha.2', '1.0.0-alpha.10')).toBe(-1)
    expect(compareVersions('1.0.0-1', '1.0.0-alpha')).toBe(-1)
    expect(compareVersions('1.0.0-beta', '1.0.0-alpha')).toBe(1)
    expect(compareVersions('1.0.0+build.7', '1.0.0')).toBe(0)
  })

  it('returns null for anything that is not a version', () => {
    expect(compareVersions('dev', '1.0.0')).toBeNull()
    expect(compareVersions('1.0', '1.0.0')).toBeNull()
  })
})

describe('availableUpdate', () => {
  it('reports a newer published version for macOS and Linux devices', () => {
    expect(availableUpdate({ os: 'macos', version: '0.2.0' }, manifest)).toBe('0.3.0')
    expect(availableUpdate({ os: 'linux', version: '0.2.9' }, manifest)).toBe('0.3.0')
  })

  it('stays quiet when current, ahead, unknown, on Windows, or unpublished for the platform', () => {
    expect(availableUpdate({ os: 'linux', version: '0.3.0' }, manifest)).toBeNull()
    expect(availableUpdate({ os: 'linux', version: '0.4.0-dev' }, manifest)).toBeNull()
    expect(availableUpdate({ os: 'linux', version: null }, manifest)).toBeNull()
    expect(availableUpdate({ os: 'windows', version: '0.1.0' }, manifest)).toBeNull()
    expect(availableUpdate({ os: 'linux', version: '0.1.0' }, { version: '0.3.0', files: { 'macos-pkg': file } })).toBeNull()
    expect(availableUpdate({ os: 'macos', version: '0.1.0' }, null)).toBeNull()
  })
})
