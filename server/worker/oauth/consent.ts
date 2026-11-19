import type { WorkspaceSummary } from '../../shared/types'
import { ctxOf } from '../http/authenticate'
import { readJson, type Json } from '../http/body'
import { notFound } from '../http/errors'
import type { Router } from '../http/router'
import { str } from '../http/validate'
import { peekChallenge, putChallenge, takeChallenge } from '../lib/challenges'
import { randomBytes, sha256Hex } from '../lib/crypto'
import { b64url } from '../lib/encoding'
import { requireMember, requireSessionUser } from '../services/access'
import { audit } from '../services/audit'
import type { Ctx } from '../services/context'
import { listWorkspaces } from '../services/workspaces'
import type { OAuthRequest } from './authorize'
import { CODE_TTL, withParams, type Scope } from './common'
import type { CodeGrant } from './token'

export interface ConsentRequest {
  client: { name: string; uri: string | null; logoUri: string | null }
  redirectHost: string
  scopes: Scope[]
  workspaces: WorkspaceSummary[]
}

const expired = () => notFound('This connection request expired. Start again from the app you were connecting.', 'oauth_request_expired')

function redirectHost(uri: string): string {
  const url = new URL(uri)
  return url.host || url.protocol.replace(/:$/, '')
}

/** `GET /api/oauth/requests/:id`: what the consent page shows; the request stays pending. */
export async function describeRequest(ctx: Ctx, id: string): Promise<ConsentRequest> {
  requireSessionUser(ctx)
  const found = await peekChallenge<OAuthRequest>(ctx.env, 'oauth-request', id)
  if (!found) throw expired()
  const r = found.data
  return {
    client: { name: r.clientName, uri: r.clientUri, logoUri: r.logoUri },
    redirectHost: redirectHost(r.redirectUri),
    scopes: r.scopes,
    workspaces: await listWorkspaces(ctx),
  }
}

/** Issues a single-use authorization code bound to the user, client, PKCE challenge and optional workspace pin. */
export async function approveRequest(ctx: Ctx, id: string, body: Json): Promise<{ redirectTo: string }> {
  const { user } = requireSessionUser(ctx)
  const workspaceId = body.workspaceId === null || body.workspaceId === undefined ? null : str(body, 'workspaceId', { max: 64 })
  if (workspaceId) await requireMember(ctx, workspaceId)
  const found = await takeChallenge<OAuthRequest>(ctx.env, 'oauth-request', id)
  if (!found) throw expired()
  const code = b64url(randomBytes(32))
  const grant: CodeGrant = { ...found.data, workspaceId }
  await putChallenge(ctx.env, await sha256Hex(code), 'oauth-code', user.id, grant, CODE_TTL)
  await audit(ctx, workspaceId, 'app.approve', grant.clientId, { name: grant.clientName, scopes: grant.scopes })
  return { redirectTo: withParams(grant.redirectUri, { code, state: grant.state, iss: ctx.origin }) }
}

export async function denyRequest(ctx: Ctx, id: string): Promise<{ redirectTo: string }> {
  requireSessionUser(ctx)
  const found = await takeChallenge<OAuthRequest>(ctx.env, 'oauth-request', id)
  if (!found) throw expired()
  const r = found.data
  return { redirectTo: withParams(r.redirectUri, { error: 'access_denied', error_description: 'The user declined access', state: r.state, iss: ctx.origin }) }
}

export function consentRoutes(r: Router): void {
  r.get('/api/oauth/requests/:id', async (h) => describeRequest(await ctxOf(h), h.params.id))
  r.post('/api/oauth/requests/:id/approve', async (h) => approveRequest(await ctxOf(h), h.params.id, await readJson(h.req)))
  r.post('/api/oauth/requests/:id/deny', async (h) => denyRequest(await ctxOf(h), h.params.id))
}
