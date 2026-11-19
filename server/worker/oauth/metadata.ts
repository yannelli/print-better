import { mcpResource, SCOPES } from './common'

const CACHE = { 'Cache-Control': 'public, max-age=300' }

/** RFC 9728, served at both the root and the `/mcp` path-suffixed location. */
export const protectedResourceMetadata = (origin: string): Response =>
  Response.json(
    { resource: mcpResource(origin), authorization_servers: [origin], bearer_methods_supported: ['header'], scopes_supported: [...SCOPES] },
    { headers: CACHE },
  )

/** RFC 8414 with a path-less issuer; CIMD plus "none" auth is what makes Claude prefer CIMD over DCR. */
export const authorizationServerMetadata = (origin: string): Response =>
  Response.json(
    {
      issuer: origin,
      authorization_endpoint: `${origin}/oauth/authorize`,
      token_endpoint: `${origin}/oauth/token`,
      registration_endpoint: `${origin}/oauth/register`,
      revocation_endpoint: `${origin}/oauth/revoke`,
      response_types_supported: ['code'],
      response_modes_supported: ['query'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
      code_challenge_methods_supported: ['S256'],
      token_endpoint_auth_methods_supported: ['none'],
      revocation_endpoint_auth_methods_supported: ['none'],
      client_id_metadata_document_supported: true,
      authorization_response_iss_parameter_supported: true,
      scopes_supported: [...SCOPES, 'offline_access'],
    },
    { headers: CACHE },
  )
