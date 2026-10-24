import type { Context } from 'hono'
import type { ZodSchema, z } from 'zod'
import { ApiError } from '../types/index.js'

export async function parseBody<S extends ZodSchema>(
  c: Context,
  schema: S,
): Promise<z.infer<S>> {
  let raw: unknown
  try {
    raw = await c.req.json()
  } catch {
    throw new ApiError(400, 'INVALID_JSON', 'Request body is not valid JSON')
  }

  const result = schema.safeParse(raw)
  if (!result.success) {
    const messages = result.error.issues
      .map((i) => `${i.path.join('.')}: ${i.message}`)
      .join('; ')
    throw new ApiError(400, 'VALIDATION_ERROR', messages)
  }

  return result.data as z.infer<S>
}
