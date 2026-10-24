import type { MiddlewareHandler } from 'hono'
import argon2 from 'argon2'
import { prisma } from '../db/client.js'
import { getClientIp } from '../utils/ip.js'
import { checkIpAllowlist } from '../utils/ip-allowlist.js'

declare module 'hono' {
  interface ContextVariableMap {
    clientId: string
  }
}

/**
 * Validates x-client-id + x-client-secret headers.
 * Used for token introspection and other machine-to-machine routes.
 */
export const clientAuthMiddleware: MiddlewareHandler = async (c, next) => {
  const clientId = c.req.header('x-client-id')
  const clientSecret = c.req.header('x-client-secret')

  if (!clientId || !clientSecret) {
    return c.json(
      { error: 'UNAUTHORIZED', message: 'x-client-id and x-client-secret headers required' },
      401,
    )
  }

  const client = await prisma.client.findUnique({ where: { id: clientId } })
  if (!client || !client.active || !client.secretHash) {
    return c.json({ error: 'UNAUTHORIZED', message: 'Unknown or inactive client' }, 401)
  }

  const valid = await argon2.verify(client.secretHash, clientSecret)
  if (!valid) {
    return c.json({ error: 'UNAUTHORIZED', message: 'Invalid client secret' }, 401)
  }

  // Check IP allowlist if configured (supports exact, CIDR, wildcard)
  const allowedIps: string[] = typeof client.allowedIps === 'string'
    ? JSON.parse(client.allowedIps)
    : (client.allowedIps as string[] ?? [])
  if (allowedIps.length > 0) {
    const ip = getClientIp(c)
    if (!checkIpAllowlist(allowedIps, ip)) {
      return c.json({ error: 'FORBIDDEN', message: 'IP address not allowed for this client' }, 403)
    }
  }

  c.set('clientId', clientId)
  return next()
}
