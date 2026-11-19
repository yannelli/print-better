import { env, exports } from 'cloudflare:workers'
import { beforeAll, describe, expect, it } from 'vitest'
import { Agent, call, ORIGIN } from './helpers/http'
import { enrollDevice, setupOwner } from './helpers/world'

const TARBALL = new Uint8Array([0x1f, 0x8b, 8, 0, 1, 2, 3, 4, 5, 6])
const MANIFEST = {
  version: '0.2.0',
  files: {
    'linux-aarch64': { name: 'printbetter-0.2.0-linux-aarch64.tar.gz', sha256: 'a'.repeat(64), size: 10 },
    'linux-x86_64': { name: 'printbetter-0.2.0-linux-x86_64.tar.gz', sha256: 'b'.repeat(64), size: 10 },
    'macos-universal': { name: 'PrintBetter-0.2.0.pkg', sha256: 'c'.repeat(64), size: 10 },
    'windows-x86_64': { name: 'printbetter-0.2.0-windows-x86_64.zip', sha256: 'd'.repeat(64), size: 10 },
  },
}

describe('install scripts', () => {
  it('templates install.sh with the request origin and never caches it', async () => {
    const res = await call('/install.sh?token=pbe_should_not_appear')
    expect(res.status).toBe(200)
    expect(res.headers.get('Content-Type')).toBe('text/plain; charset=utf-8')
    expect(res.headers.get('Cache-Control')).toBe('no-store')
    expect(res.headers.get('X-Content-Type-Options')).toBe('nosniff')
    const script = await res.text()
    expect(script.startsWith('#!')).toBe(true)
    expect(script).toContain(`PB_ORIGIN='${ORIGIN}'`)
    expect(script).not.toContain('__PB_ORIGIN__')
    expect(script).not.toContain('pbe_should_not_appear')
  })

  it('templates install.ps1 the same way', async () => {
    const script = await (await call('/install.ps1')).text()
    expect(script).toContain(`$origin = '${ORIGIN}'`)
    expect(script).not.toContain('__PB_ORIGIN__')
  })

  it('follows whatever origin the request came in on', async () => {
    const res = await exports.default.fetch('https://print.other.example/install.sh')
    expect(await res.text()).toContain("PB_ORIGIN='https://print.other.example'")
  })
})

describe('/dl downloads from R2', () => {
  beforeAll(async () => {
    await env.FILES.put('downloads/latest.json', JSON.stringify(MANIFEST))
    await env.FILES.put('downloads/0.2.0/printbetter-0.2.0-linux-aarch64.tar.gz', TARBALL)
    await env.FILES.put('downloads/0.2.0/PrintBetter-0.2.0.pkg', 'xar!', { httpMetadata: { contentType: 'application/vnd.apple.installer+xml' } })
    await env.FILES.put('jobs/ws1/secret-document', 'private')
  })

  it('serves the manifest uncached and versioned files as immutable', async () => {
    const manifest = await call('/dl/latest.json')
    expect(manifest.status).toBe(200)
    expect(manifest.headers.get('Cache-Control')).toBe('no-cache')
    expect(manifest.headers.get('Content-Type')).toBe('application/json')
    expect(manifest.headers.get('ETag')).toBeTruthy()
    expect(await manifest.json()).toEqual(MANIFEST)
    const file = await call('/dl/0.2.0/printbetter-0.2.0-linux-aarch64.tar.gz')
    expect(file.headers.get('Cache-Control')).toBe('public, max-age=31536000, immutable')
    expect(file.headers.get('Content-Type')).toBe('application/gzip')
    expect(file.headers.get('Content-Length')).toBe(String(TARBALL.byteLength))
    expect(new Uint8Array(await file.arrayBuffer())).toEqual(TARBALL)
  })

  it('prefers the stored content type over the extension', async () => {
    const res = await call('/dl/0.2.0/PrintBetter-0.2.0.pkg')
    expect(res.headers.get('Content-Type')).toBe('application/vnd.apple.installer+xml')
  })

  it('answers HEAD with headers only', async () => {
    const res = await call('/dl/0.2.0/printbetter-0.2.0-linux-aarch64.tar.gz', { method: 'HEAD' })
    expect(res.status).toBe(200)
    expect(res.headers.get('Content-Length')).toBe(String(TARBALL.byteLength))
    expect(await res.text()).toBe('')
  })

  it('404s missing files and anything that is not a plain one-level path', async () => {
    const paths = ['/dl/0.2.0/missing.tar.gz', '/dl/', '/dl/0.2.0/', '/dl/a/b/c', '/dl/..%2Fjobs%2Fws1%2Fsecret-document', '/dl/%2e%2e%2fjobs', '/dl/0.2.0/..', '/dl/latest.json%00']
    for (const path of paths) {
      const res = await call(path)
      expect(res.status, path).toBe(404)
      expect(await res.text(), path).not.toContain('private')
    }
  })
})

describe('GET /api/client/latest', () => {
  let device: Agent

  beforeAll(async () => {
    await env.FILES.delete('downloads/latest.json')
    const owner = await setupOwner()
    device = new Agent({ token: (await enrollDevice(owner)).token })
  })

  it('requires a device token', async () => {
    const anonymous = await new Agent().get('/api/client/latest?os=linux&arch=aarch64')
    expect(anonymous.status).toBe(401)
    const user = await new Agent({ token: 'pbt_not_a_device_token' }).get('/api/client/latest?os=linux&arch=aarch64')
    expect(user.body.error.code).toBe('invalid_token')
  })

  it('needs os and arch, and 404s no_build before anything is published', async () => {
    expect((await device.get('/api/client/latest?os=linux')).status).toBe(400)
    const none = await device.get('/api/client/latest?os=linux&arch=aarch64')
    expect(none.status).toBe(404)
    expect(none.body.error.code).toBe('no_build')
  })

  it('maps os and arch aliases to the published build', async () => {
    await env.FILES.put('downloads/latest.json', JSON.stringify(MANIFEST))
    const cases: [string, string, string][] = [
      ['linux', 'arm64', 'linux-aarch64'],
      ['Linux', 'aarch64', 'linux-aarch64'],
      ['linux', 'amd64', 'linux-x86_64'],
      ['macos', 'arm64', 'macos-universal'],
      ['macos', 'x86_64', 'macos-universal'],
      ['windows', 'x64', 'windows-x86_64'],
    ]
    for (const [os, arch, key] of cases) {
      const entry = MANIFEST.files[key as keyof typeof MANIFEST.files]
      const reply = await device.get(`/api/client/latest?os=${os}&arch=${arch}`)
      expect(reply.body, `${os}/${arch}`).toEqual({ version: '0.2.0', url: `${ORIGIN}/dl/0.2.0/${entry.name}`, sha256: entry.sha256, size: entry.size })
    }
  })

  it('404s no_build for platforms without a published file', async () => {
    for (const [os, arch] of [['windows', 'armv7'], ['linux', 'armv6l'], ['freebsd', 'x86_64'], ['linux', 'mips']]) {
      const reply = await device.get(`/api/client/latest?os=${os}&arch=${arch}`)
      expect(reply.status, `${os}/${arch}`).toBe(404)
      expect(reply.body.error.code).toBe('no_build')
    }
  })
})
