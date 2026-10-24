import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { logger } from 'hono/logger'
import { bodyLimit } from 'hono/body-limit'
import { env } from './config/env.js'
import { errorHandler } from './middleware/error-handler.js'
import { requestLoggerMiddleware } from './middleware/request-logger.js'
import { securityHeaders } from './middleware/security-headers.js'
import { healthRouter } from './routes/health.js'
import { authRouter } from './routes/auth.js'
import { usersRouter } from './routes/users.js'
import { rolesRouter } from './routes/roles.js'
import { serviceAccountsRouter } from './routes/service-accounts.js'
import { clientsRouter } from './routes/clients.js'
import { tokensRouter } from './routes/tokens.js'
import { sessionsRouter } from './routes/sessions.js'
import { systemUsersRouter } from './routes/system-users.js'
import { auditRouter } from './routes/audit.js'
import { passwordPolicyRouter } from './routes/password-policy.js'
import { groupsRouter } from './routes/groups.js'
import { docsRouter } from './routes/docs.js'
import { oauthRouter } from './routes/oauth.js'
import { webauthnRouter } from './routes/webauthn.js'
import { devicesRouter } from './routes/devices.js'

export function createApp(): Hono {
  const app = new Hono()

  app.use('*', bodyLimit({
    maxSize: env.MAX_REQUEST_BODY_BYTES,
    onError: (c) => c.json({ error: 'PAYLOAD_TOO_LARGE', message: 'Request body too large' }, 413),
  }))

  // ── CORS ──────────────────────────────────────────────────────────
  app.use(
    '*',
    cors({
      origin: env.CORS_ORIGIN.split(',').map((o) => o.trim()),
      allowHeaders: [
        'Authorization',
        'Content-Type',
        'x-client-id',
        'x-client-secret',
        'x-agent-token',
        'x-request-id',
        'x-hive-request-id',
      ],
      allowMethods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
      credentials: true,
    }),
  )

  // ── Request logger ────────────────────────────────────────────────
  app.use(logger())
  app.use('*', securityHeaders)
  app.use('/api/v1/*', requestLoggerMiddleware)

  // ── Routes ────────────────────────────────────────────────────────
  app.route('/api/v1/health', healthRouter)
  app.route('/api/v1/auth', authRouter)
  app.route('/api/v1/users', usersRouter)
  app.route('/api/v1/roles', rolesRouter)
  app.route('/api/v1/service-accounts', serviceAccountsRouter)
  app.route('/api/v1/clients', clientsRouter)
  app.route('/api/v1/tokens', tokensRouter)
  app.route('/api/v1/sessions', sessionsRouter)
  app.route('/api/v1/system-users', systemUsersRouter)
  app.route('/api/v1/audit', auditRouter)
  app.route('/api/v1/password-policy', passwordPolicyRouter)
  app.route('/api/v1/groups', groupsRouter)
  app.route('/api/v1/oauth', oauthRouter)
  app.route('/api/v1/mfa/webauthn', webauthnRouter)
  app.route('/api/v1/devices', devicesRouter)
  app.route('/api/docs', docsRouter)

  // ── 404 ──────────────────────────────────────────────────────────
  app.notFound((c) => c.json({ error: 'NOT_FOUND', message: 'Route not found' }, 404))

  // ── Error handler ─────────────────────────────────────────────────
  app.onError(errorHandler)

  return app
}
