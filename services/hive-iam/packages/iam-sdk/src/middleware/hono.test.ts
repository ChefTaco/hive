import { describe, it, expect, vi, beforeEach } from 'vitest'
import { Hono } from 'hono'
import { generateKeyPair, SignJWT } from 'jose'

// Mock the cache module so createIamMiddleware's internal IamVerifier works
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let mockPublicKey: any = null

vi.mock('../cache.js', () => ({
  PublicKeyCache: class {
    constructor(public url: string, public ttlMs?: number) {}
    async getKey() {
      if (!mockPublicKey) throw new Error('Mock key not set')
      return { key: mockPublicKey, pem: 'mock-pem' }
    }
    async refresh() {
      if (!mockPublicKey) throw new Error('Mock key not set')
      return { key: mockPublicKey, pem: 'mock-pem' }
    }
  },
}))

import { createIamMiddleware } from './hono.js'

describe('createIamMiddleware', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let privateKey: any
  let mw: ReturnType<typeof createIamMiddleware>

  beforeEach(async () => {
    const keyPair = await generateKeyPair('RS256')
    privateKey = keyPair.privateKey
    mockPublicKey = keyPair.publicKey

    mw = createIamMiddleware({
      publicKeyUrl: 'https://test/public-key',
      issuer: 'test-issuer',
    })
  })

  async function signToken(claims: Record<string, unknown> = {}): Promise<string> {
    return new SignJWT({
      actorType: 'USER',
      email: 'alice@test.com',
      username: 'alice',
      roles: ['ADMIN'],
      permissions: ['iam:users:read', 'iam:users:write'],
      sessionId: 'sess-1',
      ...claims,
    })
      .setProtectedHeader({ alg: 'RS256' })
      .setSubject('user-1')
      .setIssuer('test-issuer')
      .setIssuedAt()
      .setExpirationTime('1h')
      .setJti('jti-test')
      .sign(privateKey)
  }

  describe('verify()', () => {
    it('passes with valid Bearer token and sets iamPrincipal', async () => {
      const app = new Hono()
      app.use('*', mw.verify())
      app.get('/test', (c) => {
        const p = c.get('iamPrincipal')
        return c.json({ sub: p.sub, email: p.email })
      })

      const token = await signToken()
      const res = await app.request('/test', {
        headers: { Authorization: `Bearer ${token}` },
      })

      expect(res.status).toBe(200)
      const body = (await res.json()) as Record<string, unknown>
      expect(body.sub).toBe('user-1')
      expect(body.email).toBe('alice@test.com')
    })

    it('returns 401 without Authorization header', async () => {
      const app = new Hono()
      app.use('*', mw.verify())
      app.get('/test', (c) => c.json({ ok: true }))

      const res = await app.request('/test')
      expect(res.status).toBe(401)
      const body = (await res.json()) as Record<string, unknown>
      expect(body.error).toBe('UNAUTHORIZED')
    })

    it('returns 401 with invalid token', async () => {
      const app = new Hono()
      app.use('*', mw.verify())
      app.get('/test', (c) => c.json({ ok: true }))

      const res = await app.request('/test', {
        headers: { Authorization: 'Bearer invalid-garbage-token' },
      })
      expect(res.status).toBe(401)
    })

    it('uses custom onUnauthorized handler', async () => {
      const customMw = createIamMiddleware({
        publicKeyUrl: 'https://test/public-key',
        issuer: 'test-issuer',
        onUnauthorized: (reason) =>
          new Response(JSON.stringify({ custom: true, reason }), {
            status: 403,
            headers: { 'Content-Type': 'application/json' },
          }),
      })

      const app = new Hono()
      app.use('*', customMw.verify())
      app.get('/test', (c) => c.json({ ok: true }))

      const res = await app.request('/test')
      expect(res.status).toBe(403)
      const body = (await res.json()) as Record<string, unknown>
      expect(body.custom).toBe(true)
    })
  })

  describe('requirePermission()', () => {
    it('passes when principal has required permissions', async () => {
      const app = new Hono()
      app.use('*', mw.verify())
      app.get('/test', mw.requirePermission('iam:users:read'), (c) => c.json({ ok: true }))

      const token = await signToken()
      const res = await app.request('/test', {
        headers: { Authorization: `Bearer ${token}` },
      })
      expect(res.status).toBe(200)
    })

    it('returns 403 when permission is missing', async () => {
      const app = new Hono()
      app.use('*', mw.verify())
      app.get('/test', mw.requirePermission('iam:users:delete'), (c) => c.json({ ok: true }))

      const token = await signToken()
      const res = await app.request('/test', {
        headers: { Authorization: `Bearer ${token}` },
      })
      expect(res.status).toBe(403)
      const body = (await res.json()) as Record<string, unknown>
      expect(body.error).toBe('FORBIDDEN')
      expect(body.message).toContain('iam:users:delete')
    })

    it('returns 401 when iamPrincipal is not set', async () => {
      const app = new Hono()
      // Intentionally skip verify() middleware
      app.get('/test', mw.requirePermission('iam:users:read'), (c) => c.json({ ok: true }))

      const res = await app.request('/test')
      expect(res.status).toBe(401)
    })
  })

  describe('requireRole()', () => {
    it('passes when principal has a matching role', async () => {
      const app = new Hono()
      app.use('*', mw.verify())
      app.get('/test', mw.requireRole('ADMIN'), (c) => c.json({ ok: true }))

      const token = await signToken()
      const res = await app.request('/test', {
        headers: { Authorization: `Bearer ${token}` },
      })
      expect(res.status).toBe(200)
    })

    it('passes when principal has any of the listed roles', async () => {
      const app = new Hono()
      app.use('*', mw.verify())
      app.get('/test', mw.requireRole('SUPER_ADMIN', 'ADMIN'), (c) => c.json({ ok: true }))

      const token = await signToken()
      const res = await app.request('/test', {
        headers: { Authorization: `Bearer ${token}` },
      })
      expect(res.status).toBe(200)
    })

    it('returns 403 when no role matches', async () => {
      const app = new Hono()
      app.use('*', mw.verify())
      app.get('/test', mw.requireRole('SUPER_ADMIN'), (c) => c.json({ ok: true }))

      const token = await signToken()
      const res = await app.request('/test', {
        headers: { Authorization: `Bearer ${token}` },
      })
      expect(res.status).toBe(403)
      const body = (await res.json()) as Record<string, unknown>
      expect(body.error).toBe('FORBIDDEN')
    })

    it('returns 401 when iamPrincipal is not set', async () => {
      const app = new Hono()
      app.get('/test', mw.requireRole('ADMIN'), (c) => c.json({ ok: true }))

      const res = await app.request('/test')
      expect(res.status).toBe(401)
    })
  })
})
