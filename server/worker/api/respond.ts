import type { User } from '../../shared/types'
import { SESSION_TTL } from '../auth/sessions'
import type { JobViewRow } from '../db/rows'
import { sessionCookie } from '../http/cookies'
import { ApiError } from '../http/errors'
import type { Http } from '../http/router'
import type { SignIn } from '../services/accounts'

/** Sets the session cookie and returns `{ user }`, the shape every sign-in endpoint answers with. */
export function withSession(h: Http, signIn: SignIn): { user: User } {
  h.cookies.push(sessionCookie(signIn.sessionToken, SESSION_TTL))
  return { user: signIn.user }
}

export const redirect = (location: string): Response => new Response(null, { status: 302, headers: { Location: location } })

export function requireUpgrade(h: Http): void {
  if (h.req.headers.get('Upgrade')?.toLowerCase() !== 'websocket') throw new ApiError(426, 'upgrade_required', 'Expected a WebSocket upgrade')
}

function contentDisposition(fileName: string): string {
  const ascii = fileName.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_')
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(fileName)}`
}

/** User-supplied documents are served inert: sandboxed, never sniffed, and as downloads (named `download`) for browsers. */
export function documentResponse(job: JobViewRow, object: R2ObjectBody, download: string | null): Response {
  const headers = new Headers({
    'Content-Type': job.content_type,
    'Content-Length': String(object.size),
    'X-PB-SHA256': job.sha256 ?? '',
    'Cache-Control': 'private, no-store',
    'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': 'sandbox',
  })
  if (download !== null) headers.set('Content-Disposition', contentDisposition(download))
  return new Response(object.body, { headers })
}
