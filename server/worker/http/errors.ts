import type { ApiErrorBody } from '../../shared/types'

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message)
  }
}

export const badRequest = (message: string, code = 'invalid_request') => new ApiError(400, code, message)
export const unauthorized = (message = 'Sign in required', code = 'unauthorized') => new ApiError(401, code, message)
export const forbidden = (message = 'You do not have permission to do that', code = 'forbidden') =>
  new ApiError(403, code, message)
export const notFound = (message = 'Not found', code = 'not_found') => new ApiError(404, code, message)
export const conflict = (message: string, code = 'conflict') => new ApiError(409, code, message)
export const tooLarge = (message: string) => new ApiError(413, 'too_large', message)
export const tooMany = (message = 'Too many attempts, try again later') => new ApiError(429, 'rate_limited', message)

export function errorBody(code: string, message: string): ApiErrorBody {
  return { error: { code, message } }
}

export function errorResponse(e: unknown): Response {
  if (e instanceof ApiError) return Response.json(errorBody(e.code, e.message), { status: e.status })
  console.error('unhandled error', e)
  return Response.json(errorBody('internal', 'Something went wrong'), { status: 500 })
}
