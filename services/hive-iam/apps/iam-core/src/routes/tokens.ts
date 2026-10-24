import { Hono } from 'hono'
import { clientAuthMiddleware } from '../middleware/client-auth.js'
import { authMiddleware } from '../middleware/auth.js'
import { introspectToken, revokeRefreshToken, verifyAccessToken } from '../services/token-service.js'
import { revokeSession } from '../services/session-service.js'
import { logAuditEvent } from '../services/audit-service.js'
import { getClientIp } from '../utils/ip.js'
import { parseBody } from '../utils/validate.js'
import type { ActorType } from '../types/index.js'
import { z } from 'zod'

export const tokensRouter = new Hono()

const IntrospectSchema = z.object({ token: z.string().min(1) })
const RevokeSchema = z.object({ token: z.string().min(1) })
const OAuthRevokeSchema = z.object({
  token: z.string().min(1),
  token_type_hint: z.enum(['access_token', 'refresh_token']).optional(),
})

// POST /tokens/introspect — callable by registered clients (RFC 7662 compliant)
tokensRouter.post('/introspect', clientAuthMiddleware, async (c) => {
  const { token } = await parseBody(c, IntrospectSchema)
  const clientId = c.get('clientId')
  const result = await introspectToken(token)

  if (result.valid) {
    await logAuditEvent({
      eventType: 'token.introspect',
      category: 'TOKEN',
      actorId: result.principal.sub,
      actorType: result.principal.actorType,
      clientId,
      ipAddress: getClientIp(c),
      action: 'introspect',
      outcome: 'SUCCESS',
      source: 'iam-api',
    })

    // RFC 7662 compliant response
    return c.json({
      active: true,
      sub: result.principal.sub,
      token_type: 'Bearer',
      scope: result.principal.permissions?.join(' ') ?? '',
      client_id: result.principal.clientId ?? clientId,
      email: result.principal.email,
      username: result.principal.username,
      roles: result.principal.roles,
      permissions: result.principal.permissions,
      session_id: result.principal.sessionId,
      actor_type: result.principal.actorType,
    })
  }

  // RFC 7662: inactive token
  return c.json({ active: false })
})

// POST /tokens/revoke — RFC 7009 token revocation (client-authenticated)
tokensRouter.post('/revoke', clientAuthMiddleware, async (c) => {
  const { token, token_type_hint } = await parseBody(c, OAuthRevokeSchema)
  const clientId = c.get('clientId')

  // Try access token first if hinted, otherwise try both
  if (token_type_hint === 'access_token' || !token_type_hint) {
    try {
      const payload = await verifyAccessToken(token)
      if (payload.sessionId) {
        await revokeSession(payload.sessionId, payload.sub)
      }

      await logAuditEvent({
        eventType: 'token.revoked',
        category: 'TOKEN',
        actorId: payload.sub ?? '',
        actorType: (payload.actorType as ActorType) ?? 'USER',
        clientId,
        ipAddress: getClientIp(c),
        action: 'revoke',
        outcome: 'SUCCESS',
        detail: { tokenType: 'access_token' },
        source: 'iam-api',
      })

      // RFC 7009: always return 200
      return c.json({ success: true })
    } catch {
      // Not a valid access token, continue
    }
  }

  // Try refresh token
  try {
    await revokeRefreshToken(token)

    await logAuditEvent({
      eventType: 'token.revoked',
      category: 'TOKEN',
      actorId: clientId ?? 'unknown',
      actorType: 'SERVICE_ACCOUNT',
      clientId,
      ipAddress: getClientIp(c),
      action: 'revoke',
      outcome: 'SUCCESS',
      detail: { tokenType: 'refresh_token' },
      source: 'iam-api',
    })
  } catch {
    // RFC 7009: silently ignore invalid tokens
  }

  // RFC 7009: always return 200
  return c.json({ success: true })
})

// POST /tokens/revoke-own — authenticated user can revoke their own token
tokensRouter.post('/revoke-own', authMiddleware, async (c) => {
  const principal = c.get('principal')
  const { token } = await parseBody(c, RevokeSchema)

  // Verify the token belongs to the calling user before revoking
  try {
    const payload = await verifyAccessToken(token)
    if (payload.sub !== principal.sub) {
      return c.json({ error: 'FORBIDDEN', message: 'Cannot revoke another user\'s token' }, 403)
    }
    // Revoke the associated session
    if (payload.sessionId) {
      await revokeSession(payload.sessionId, principal.sub)
    }
  } catch {
    // If the token is invalid / expired, treat as a refresh token
    await revokeRefreshToken(token)
    return c.json({ success: true })
  }

  await logAuditEvent({
    eventType: 'token.revoked',
    category: 'TOKEN',
    actorId: principal.sub,
    actorType: principal.actorType,
    actorEmail: principal.email,
    ipAddress: getClientIp(c),
    action: 'revoke',
    outcome: 'SUCCESS',
    source: 'iam-api',
  })

  return c.json({ success: true })
})
