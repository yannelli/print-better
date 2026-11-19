import { KB, readBytes } from '../http/body'
import { first, parseJson, run } from '../lib/db'
import { DAY, HOUR, MINUTE } from '../lib/time'
import { VERSION } from '../version'
import { OAuthError, validRedirectUri } from './common'

export interface OAuthClient {
  id: string
  name: string
  /** Shown on the consent page: the verified metadata host for CIMD clients, else the self-declared client_uri. */
  uri: string | null
  logoUri: string | null
  redirectUris: string[]
}

export interface ClientMeta {
  type: 'dcr' | 'cimd'
  clientUri?: string | null
  logoUri?: string | null
  applicationType?: 'web' | 'native'
  fetchedAt?: number
  maxAgeMs?: number
}

interface OAuthClientRow {
  id: string
  name: string
  redirect_uris: string
  metadata: string
  created_at: number
}

const MAX_DOCUMENT = 16 * KB
const FETCH_TIMEOUT_MS = 5000
const MIN_CACHE = 5 * MINUTE
const MAX_CACHE = DAY

export const httpsOrNull = (v: unknown): string | null => (typeof v === 'string' && /^https:\/\/\S+$/i.test(v) && v.length <= 500 ? v : null)

function toClient(row: OAuthClientRow): OAuthClient {
  const meta = parseJson<ClientMeta>(row.metadata, { type: 'dcr' })
  const uri = meta.type === 'cimd' ? new URL(row.id).origin : (meta.clientUri ?? null)
  return { id: row.id, name: row.name, uri, logoUri: meta.logoUri ?? null, redirectUris: parseJson<string[]>(row.redirect_uris, []) }
}

/** Client ID Metadata Document ids are HTTPS URLs; registered (DCR) ids are random strings. */
const isMetadataUrl = (clientId: string): boolean => clientId.startsWith('https://')

/** SSRF guard: a public DNS name on the default HTTPS port, in canonical form, with a path. */
function metadataUrl(clientId: string): URL | null {
  let url: URL
  try {
    url = new URL(clientId)
  } catch {
    return null
  }
  const host = url.hostname
  const internal = !host.includes('.') || /^[\d.]+$/.test(host) || host.startsWith('[') || /\.(localhost|local|internal|home\.arpa)$/.test(host)
  if (url.href !== clientId || url.port !== '' || url.username || url.password || url.hash || url.pathname === '/' || internal) return null
  return url
}

function cacheMs(cacheControl: string | null): number {
  if (cacheControl && /no-store|no-cache/i.test(cacheControl)) return 0
  const maxAge = /max-age=(\d+)/i.exec(cacheControl ?? '')
  return maxAge ? Math.min(MAX_CACHE, Math.max(MIN_CACHE, Number(maxAge[1]) * 1000)) : HOUR
}

async function fetchMetadata(url: URL): Promise<{ doc: Record<string, unknown>; maxAgeMs: number }> {
  const failed = (why: string) => new OAuthError(400, 'invalid_client', `Could not load the client metadata from ${url.host}: ${why}`)
  let res: Response
  try {
    res = await fetch(url, {
      redirect: 'manual',
      headers: { Accept: 'application/json', 'User-Agent': `PrintBetter/${VERSION}` },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    })
  } catch {
    throw failed('unreachable')
  }
  if (res.status !== 200) throw failed(`HTTP ${res.status}`)
  try {
    const doc: unknown = JSON.parse(new TextDecoder().decode(await readBytes(res, MAX_DOCUMENT)))
    if (typeof doc !== 'object' || doc === null || Array.isArray(doc)) throw new Error('not an object')
    return { doc: doc as Record<string, unknown>, maxAgeMs: cacheMs(res.headers.get('Cache-Control')) }
  } catch {
    throw failed('not a JSON object under 16 KB')
  }
}

async function metadataClient(env: Env, clientId: string): Promise<OAuthClient | null> {
  const url = metadataUrl(clientId)
  if (!url) return null
  const cached = await first<OAuthClientRow>(env.DB, 'SELECT * FROM oauth_clients WHERE id = ?', clientId)
  const meta = cached ? parseJson<ClientMeta>(cached.metadata, { type: 'cimd' }) : null
  if (cached && (meta?.fetchedAt ?? 0) + (meta?.maxAgeMs ?? 0) > Date.now()) return toClient(cached)

  const { doc, maxAgeMs } = await fetchMetadata(url)
  if (doc.client_id !== clientId) throw new OAuthError(400, 'invalid_client', 'The client metadata document names a different client_id')
  const redirects = Array.isArray(doc.redirect_uris) ? doc.redirect_uris.filter((u): u is string => typeof u === 'string' && validRedirectUri(u)) : []
  if (redirects.length === 0) throw new OAuthError(400, 'invalid_client', 'The client metadata document has no usable redirect_uris')
  const name = typeof doc.client_name === 'string' && doc.client_name.trim() ? doc.client_name.trim().slice(0, 100) : url.host
  const stored: ClientMeta = { type: 'cimd', clientUri: httpsOrNull(doc.client_uri), logoUri: httpsOrNull(doc.logo_uri), fetchedAt: Date.now(), maxAgeMs }
  await run(
    env.DB,
    `INSERT INTO oauth_clients (id, name, redirect_uris, metadata, created_at) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET name = excluded.name, redirect_uris = excluded.redirect_uris, metadata = excluded.metadata`,
    clientId,
    name,
    JSON.stringify(redirects),
    JSON.stringify(stored),
    Date.now(),
  )
  return { id: clientId, name, uri: url.origin, logoUri: stored.logoUri ?? null, redirectUris: redirects }
}

/** Resolves a CIMD URL (fetched, validated, cached in oauth_clients) or a DCR registration; null when unknown. */
export async function findClient(env: Env, clientId: string): Promise<OAuthClient | null> {
  if (isMetadataUrl(clientId)) return metadataClient(env, clientId)
  const row = await first<OAuthClientRow>(env.DB, 'SELECT * FROM oauth_clients WHERE id = ?', clientId)
  return row ? toClient(row) : null
}
