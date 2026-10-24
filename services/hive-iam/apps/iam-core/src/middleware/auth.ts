import type { MiddlewareHandler } from 'hono'
import { verifyAccessToken } from '../services/token-service.js'
import { ApiError } from '../types/index.js'
import type { Principal } from '../types/index.js'

// Augment Hono context variable map
declare module 'hono' {
  interface ContextVariableMap {
    principal: Principal
  }
}

export const authMiddleware: MiddlewareHandler = async (c, next) => {
  const authorization = c.req.header('authorization')
  if (!authorization?.startsWith('Bearer ')) {
    return c.json({ error: 'UNAUTHORIZED', message: 'Bearer token required' }, 401)
  }

  const token = authorization.slice(7)
  try {
    const payload = await verifyAccessToken(token)
    c.set('principal', {
      sub: payload.sub ?? '',
      actorType: payload.actorType as Principal['actorType'],
      email: payload.email,
      username: payload.username,
      roles: payload.roles,
      permissions: payload.permissions,
      sessionId: payload.sessionId,
      clientId: payload.clientId,
    })
  } catch (err) {
    if (err instanceof ApiError) {
      return c.json({ error: err.code, message: err.message }, 401)
    }
    return c.json({ error: 'UNAUTHORIZED', message: 'Invalid token' }, 401)
  }

  return next()
}
