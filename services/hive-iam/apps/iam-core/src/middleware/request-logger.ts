import type { MiddlewareHandler } from 'hono'
import { logAuditEvent } from '../services/audit-service.js'
import { getClientIp } from '../utils/ip.js'

const SKIP_PATHS = ['/api/v1/health', '/api/v1/auth/public-key']

/** Query strings can carry OAuth codes, state, and credentials. Log only the path. */
export const accessLoggerMiddleware: MiddlewareHandler = async (c, next) => {
  const start = Date.now()
  await next()
  console.log(JSON.stringify({ method: c.req.method, path: c.req.path, status: c.res.status, duration: Date.now() - start }))
}

export const requestLoggerMiddleware: MiddlewareHandler = async (c, next) => {
  const start = Date.now()
  await next()

  const path = c.req.path
  if (SKIP_PATHS.some((p) => path.startsWith(p))) return

  const status = c.res.status
  const duration = Date.now() - start
  const principal = c.get('principal')
  const requestId = c.req.header('x-hive-request-id') ?? c.req.header('x-request-id')

  await logAuditEvent({
    eventType: 'api.request',
    category: 'ADMIN',
    actorId: principal?.sub,
    actorType: principal?.actorType ?? 'SYSTEM',
    actorEmail: principal?.email,
    ipAddress: getClientIp(c),
    userAgent: c.req.header('user-agent'),
    action: `${c.req.method} ${path}`,
    outcome: status >= 400 ? (status === 403 ? 'DENIED' : 'FAILURE') : 'SUCCESS',
    detail: { status, duration, method: c.req.method, path, ...(requestId ? { requestId } : {}) },
    source: 'iam-api',
  })
}
