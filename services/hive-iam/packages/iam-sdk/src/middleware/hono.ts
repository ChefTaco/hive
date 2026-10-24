import type { MiddlewareHandler } from 'hono'
import { IamVerifier } from '../verify.js'
import type { IamHonoOptions, Principal } from '../types.js'

declare module 'hono' {
  interface ContextVariableMap {
    iamPrincipal: Principal
  }
}

export interface IamHonoMiddleware {
  /** Verifies the Bearer token and sets c.var.iamPrincipal */
  verify(): MiddlewareHandler
  /** Requires all of the listed permissions (must come after verify()) */
  requirePermission(...permissions: string[]): MiddlewareHandler
  /** Requires any of the listed roles (must come after verify()) */
  requireRole(...roles: string[]): MiddlewareHandler
}

export function createIamMiddleware(opts: IamHonoOptions): IamHonoMiddleware {
  const verifier = new IamVerifier(opts)

  const unauthorizedResponse = (reason: string): Response =>
    opts.onUnauthorized
      ? opts.onUnauthorized(reason)
      : new Response(JSON.stringify({ error: 'UNAUTHORIZED', message: reason }), {
          status: 401,
          headers: { 'Content-Type': 'application/json' },
        })

  return {
    verify(): MiddlewareHandler {
      return async (c, next) => {
        const authorization = c.req.header('authorization')
        if (!authorization?.startsWith('Bearer ')) {
          return unauthorizedResponse('Bearer token required')
        }

        const token = authorization.slice(7)
        try {
          const principal = await verifier.verify(token)
          c.set('iamPrincipal', principal)
        } catch (err) {
          return unauthorizedResponse(err instanceof Error ? err.message : 'Invalid token')
        }

        await next()
        return
      }
    },

    requirePermission(...permissions: string[]): MiddlewareHandler {
      return async (c, next) => {
        const principal = c.get('iamPrincipal')
        if (!principal) {
          return new Response(
            JSON.stringify({ error: 'UNAUTHORIZED', message: 'Authentication required' }),
            { status: 401, headers: { 'Content-Type': 'application/json' } },
          )
        }

        const missing = permissions.filter((p) => !principal.permissions.includes(p))
        if (missing.length > 0) {
          return new Response(
            JSON.stringify({
              error: 'FORBIDDEN',
              message: `Missing permissions: ${missing.join(', ')}`,
            }),
            { status: 403, headers: { 'Content-Type': 'application/json' } },
          )
        }

        await next()
        return
      }
    },

    requireRole(...roles: string[]): MiddlewareHandler {
      return async (c, next) => {
        const principal = c.get('iamPrincipal')
        if (!principal) {
          return new Response(
            JSON.stringify({ error: 'UNAUTHORIZED', message: 'Authentication required' }),
            { status: 401, headers: { 'Content-Type': 'application/json' } },
          )
        }

        const hasRole = roles.some((r) => principal.roles.includes(r))
        if (!hasRole) {
          return new Response(
            JSON.stringify({
              error: 'FORBIDDEN',
              message: `Required role: ${roles.join(' or ')}`,
            }),
            { status: 403, headers: { 'Content-Type': 'application/json' } },
          )
        }

        await next()
        return
      }
    },
  }
}
