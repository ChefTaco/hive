import { describe, it, expect } from 'vitest'
import { Hono } from 'hono'
import { requirePermission, requireRole } from './rbac.js'
import type { Principal } from '../types/index.js'

function createApp(principal: Principal | null) {
  const app = new Hono()

  // Simulate auth middleware setting principal
  app.use('*', async (c, next) => {
    if (principal) {
      c.set('principal', principal)
    }
    return next()
  })

  return app
}

function makePrincipal(
  overrides: Partial<Principal> = {},
): Principal {
  return {
    sub: 'user-1',
    actorType: 'USER',
    email: 'test@example.com',
    username: 'testuser',
    roles: ['VIEWER'],
    permissions: ['iam:users:read'],
    sessionId: 'sess-1',
    clientId: undefined,
    ...overrides,
  }
}

describe('requirePermission', () => {
  it('passes when principal has required permission', async () => {
    const app = createApp(makePrincipal({ permissions: ['iam:users:read'] }))
    app.get('/test', requirePermission('iam:users:read'), (c) => c.json({ ok: true }))

    const res = await app.request('/test')
    expect(res.status).toBe(200)
    const body = (await res.json()) as Record<string, unknown>
    expect(body.ok).toBe(true)
  })

  it('returns 403 when permission missing', async () => {
    const app = createApp(makePrincipal({ permissions: ['iam:users:read'] }))
    app.get('/test', requirePermission('iam:users:delete'), (c) => c.json({ ok: true }))

    const res = await app.request('/test')
    expect(res.status).toBe(403)
    const body = (await res.json()) as Record<string, unknown>
    expect(body.error).toBe('FORBIDDEN')
    expect(body.message).toContain('iam:users:delete')
  })

  it('returns 401 when principal is not set', async () => {
    const app = createApp(null)
    app.get('/test', requirePermission('iam:users:read'), (c) => c.json({ ok: true }))

    const res = await app.request('/test')
    expect(res.status).toBe(401)
  })

  it('requires all listed permissions', async () => {
    const app = createApp(makePrincipal({ permissions: ['iam:users:read'] }))
    app.get(
      '/test',
      requirePermission('iam:users:read', 'iam:users:write'),
      (c) => c.json({ ok: true }),
    )

    const res = await app.request('/test')
    expect(res.status).toBe(403)
    expect(((await res.json()) as Record<string, unknown>).message).toContain('iam:users:write')
  })
})

describe('requireRole', () => {
  it('passes when principal has required role', async () => {
    const app = createApp(makePrincipal({ roles: ['SUPER_ADMIN'] }))
    app.get('/test', requireRole('SUPER_ADMIN'), (c) => c.json({ ok: true }))

    const res = await app.request('/test')
    expect(res.status).toBe(200)
  })

  it('passes when principal has any of the listed roles', async () => {
    const app = createApp(makePrincipal({ roles: ['VIEWER'] }))
    app.get('/test', requireRole('ADMIN', 'VIEWER'), (c) => c.json({ ok: true }))

    const res = await app.request('/test')
    expect(res.status).toBe(200)
  })

  it('returns 403 when role missing', async () => {
    const app = createApp(makePrincipal({ roles: ['VIEWER'] }))
    app.get('/test', requireRole('SUPER_ADMIN'), (c) => c.json({ ok: true }))

    const res = await app.request('/test')
    expect(res.status).toBe(403)
    const body = (await res.json()) as Record<string, unknown>
    expect(body.error).toBe('FORBIDDEN')
  })

  it('returns 401 when principal is not set', async () => {
    const app = createApp(null)
    app.get('/test', requireRole('ADMIN'), (c) => c.json({ ok: true }))

    const res = await app.request('/test')
    expect(res.status).toBe(401)
  })
})
