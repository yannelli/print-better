export const SESSION_COOKIE = 'pb_session'

export function readCookie(req: Request, name: string): string | null {
  const header = req.headers.get('Cookie')
  if (!header) return null
  for (const part of header.split(';')) {
    const i = part.indexOf('=')
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim()
  }
  return null
}

export const sessionCookie = (token: string, maxAgeMs: number): string =>
  `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${Math.floor(maxAgeMs / 1000)}`

export const clearSessionCookie = (): string => `${SESSION_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`

export const SSO_COOKIE = 'pb_sso'

/** Holds the SSO `state` so the callback only completes in the browser that started it (login CSRF). */
export const ssoCookie = (state: string, maxAgeMs: number): string =>
  `${SSO_COOKIE}=${state}; Path=/api/auth/sso/; HttpOnly; Secure; SameSite=Lax; Max-Age=${Math.floor(maxAgeMs / 1000)}`
