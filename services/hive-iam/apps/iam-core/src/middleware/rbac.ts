import type { MiddlewareHandler } from 'hono'

/**
 * Returns a middleware that checks if the authenticated principal
 * has ALL of the specified permissions. Must be used after authMiddleware.
 */
export function requirePermission(...permissions: string[]): MiddlewareHandler {
  return async (c, next) => {
    const principal = c.get('principal')
    if (!principal) {
      return c.json({ error: 'UNAUTHORIZED', message: 'Authentication required' }, 401)
    }

    const missing = permissions.filter((p) => !principal.permissions.includes(p))
    if (missing.length > 0) {
      return c.json(
        {
          error: 'FORBIDDEN',
          message: `Missing permissions: ${missing.join(', ')}`,
        },
        403,
      )
    }

    return next()
  }
}

/**
 * Returns a middleware that checks if the principal has ANY of the specified roles.
 */
export function requireRole(...roles: string[]): MiddlewareHandler {
  return async (c, next) => {
    const principal = c.get('principal')
    if (!principal) {
      return c.json({ error: 'UNAUTHORIZED', message: 'Authentication required' }, 401)
    }

    const hasRole = roles.some((r) => principal.roles.includes(r))
    if (!hasRole) {
      return c.json(
        {
          error: 'FORBIDDEN',
          message: `Required role: ${roles.join(' or ')}`,
        },
        403,
      )
    }

    return next()
  }
}
