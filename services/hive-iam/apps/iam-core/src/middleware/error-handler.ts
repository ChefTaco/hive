import type { ErrorHandler } from 'hono'
import { ApiError } from '../types/index.js'
import { ZodError } from 'zod'

export const errorHandler: ErrorHandler = (err, c) => {
  if (err instanceof ApiError) {
    return c.json({ error: err.code, message: err.message }, err.status as 400 | 401 | 403 | 404 | 409 | 422 | 500)
  }

  if (err instanceof ZodError) {
    return c.json({ error: 'VALIDATION_ERROR', message: 'Request validation failed', issues: err.issues }, 400)
  }

  console.error('[error-handler]', err)
  return c.json({ error: 'INTERNAL_ERROR', message: 'An unexpected error occurred' }, 500)
}
