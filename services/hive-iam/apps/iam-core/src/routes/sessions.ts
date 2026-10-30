import { Hono } from 'hono'
import { authMiddleware } from '../middleware/auth.js'
import { requirePermission } from '../middleware/rbac.js'
import { revokeSession, revokeAllUserSessions, listActiveSessions, deduplicateSessions } from '../services/session-service.js'
import { logAuditEvent } from '../services/audit-service.js'
import { getClientIp } from '../utils/ip.js'

export const sessionsRouter = new Hono()

sessionsRouter.use('*', authMiddleware)

sessionsRouter.get('/', requirePermission('iam:sessions:revoke'), async (c) => {
  const sessions = await listActiveSessions()
  return c.json({ sessions })
})

sessionsRouter.delete('/:id', requirePermission('iam:sessions:revoke'), async (c) => {
  const principal = c.get('principal')
  const sessionId = c.req.param('id')
  await revokeSession(sessionId, principal.sub)

  await logAuditEvent({
    eventType: 'session.revoked',
    category: 'AUTHENTICATION',
    actorId: principal.sub,
    actorType: principal.actorType,
    actorEmail: principal.email,
    ipAddress: getClientIp(c),
    resourceType: 'session',
    resourceId: sessionId,
    action: 'revoke',
    source: 'iam-api',
  })

  return c.json({ success: true })
})

sessionsRouter.delete('/user/:userId', requirePermission('iam:sessions:revoke'), async (c) => {
  const principal = c.get('principal')
  const userId = c.req.param('userId')
  await revokeAllUserSessions(userId, principal.sub)

  await logAuditEvent({
    eventType: 'session.revoke_all',
    category: 'AUTHENTICATION',
    actorId: principal.sub,
    actorType: principal.actorType,
    actorEmail: principal.email,
    ipAddress: getClientIp(c),
    resourceType: 'user',
    resourceId: userId,
    action: 'revoke_all_sessions',
    source: 'iam-api',
  })

  return c.json({ success: true })
})

sessionsRouter.post('/deduplicate', requirePermission('iam:sessions:revoke'), async (c) => {
  const revoked = await deduplicateSessions()
  return c.json({ success: true, revoked })
})
