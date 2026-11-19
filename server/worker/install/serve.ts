import installPs1 from './install.ps1?raw'
import installSh from './install.sh?raw'
import { badRequest, notFound } from '../http/errors'

/** Scripts are templated with this origin and never cached: the pairing token is always a runtime argument. */
export function installScript(url: URL): Response {
  const script = url.pathname === '/install.ps1' ? installPs1 : installSh
  return new Response(script.replaceAll('__PB_ORIGIN__', url.origin), {
    headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' },
  })
}

const CONTENT_TYPES: Record<string, string> = {
  json: 'application/json',
  zip: 'application/zip',
  gz: 'application/gzip',
  pkg: 'application/octet-stream',
  exe: 'application/vnd.microsoft.portable-executable',
}

/** `/dl/latest.json` and `/dl/<version>/<file>` from R2 `downloads/`. */
export async function serveDownload(env: Env, req: Request, url: URL): Promise<Response> {
  const path = url.pathname.slice('/dl/'.length)
  if (!/^(?:[A-Za-z0-9._-]+\/)?[A-Za-z0-9._-]+$/.test(path) || path.split('/').some((part) => part === '..' || part === '.')) {
    return new Response('Not found', { status: 404 })
  }
  const key = `downloads/${path}`
  const object = req.method === 'HEAD' ? await env.FILES.head(key) : await env.FILES.get(key)
  if (!object) return new Response('Not found', { status: 404 })
  const headers = new Headers()
  object.writeHttpMetadata(headers)
  headers.set('ETag', object.httpEtag)
  headers.set('Content-Length', String(object.size))
  if (!headers.has('Content-Type')) headers.set('Content-Type', CONTENT_TYPES[path.split('.').pop() ?? ''] ?? 'application/octet-stream')
  headers.set('Cache-Control', path.includes('/') ? 'public, max-age=31536000, immutable' : 'no-cache')
  const body = 'body' in object ? (object as R2ObjectBody).body : null
  return new Response(body, { headers })
}

interface Manifest {
  version: string
  files: Record<string, { name: string; sha256: string; size: number }>
}

export interface LatestBuild {
  version: string
  url: string
  sha256: string
  size: number
}

const ARCH: Record<string, string> = {
  x86_64: 'x86_64',
  amd64: 'x86_64',
  x64: 'x86_64',
  aarch64: 'aarch64',
  arm64: 'aarch64',
  armv7: 'armv7',
  armv7l: 'armv7',
  arm: 'armv7',
  armv6: 'armv6',
  armv6l: 'armv6',
}

/** `kind` picks the macOS artifact: `pkg` for the root LaunchDaemon install, else the app zip. */
function platformKey(os: string, arch: string, kind: string | null): string | null {
  if (os === 'macos') return kind === 'pkg' ? 'macos-pkg' : 'macos-universal'
  const a = ARCH[arch.toLowerCase()]
  if (!a) return null
  if (os === 'linux') return `linux-${a}`
  if (os === 'windows' && (a === 'x86_64' || a === 'aarch64')) return `windows-${a}`
  return null
}

/** `GET /api/client/latest?os=&arch=&kind=` for self-update checks (kind: `app` or `pkg`, macOS only). */
export async function latestBuild(env: Env, url: URL): Promise<LatestBuild> {
  const os = url.searchParams.get('os')
  const arch = url.searchParams.get('arch')
  const kind = url.searchParams.get('kind')
  if (!os || !arch) throw badRequest('os and arch are required')
  if (kind !== null && kind !== 'app' && kind !== 'pkg') throw badRequest('kind must be app or pkg')
  const key = platformKey(os.toLowerCase(), arch, kind)
  const manifest = (await (await env.FILES.get('downloads/latest.json'))?.json<Manifest>()) ?? null
  const entry = key && manifest?.files?.[key]
  if (!manifest || !entry) throw notFound('No build is published for this platform', 'no_build')
  return { version: manifest.version, url: `${url.origin}/dl/${manifest.version}/${entry.name}`, sha256: entry.sha256, size: entry.size }
}
