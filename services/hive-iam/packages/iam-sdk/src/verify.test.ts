import { describe, it, expect, vi, beforeEach } from 'vitest'
import { generateKeyPair, SignJWT, exportSPKI } from 'jose'
import type { Principal } from './types.js'

// We need to mock the PublicKeyCache because it fetches from a network URL
// Instead, we'll create a real RSA key pair and test IamVerifier with it
vi.mock('./cache.js', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let mockKey: any = null
  let refreshCount = 0

  return {
    PublicKeyCache: class {
      constructor(public url: string, public ttlMs?: number) {}

      async getKey() {
        if (!mockKey) throw new Error('Mock key not set')
        return { key: mockKey, pem: 'mock-pem' }
      }

      async refresh() {
        refreshCount++
        if (!mockKey) throw new Error('Mock key not set')
        return { key: mockKey, pem: 'mock-pem' }
      }

      // Helpers for testing
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      static setKey(key: any) {
        mockKey = key
      }

      static getRefreshCount() {
        return refreshCount
      }

      static reset() {
        refreshCount = 0
      }
    },
  }
})

// Import after mock
import { IamVerifier } from './verify.js'
import { PublicKeyCache } from './cache.js'

describe('IamVerifier', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let privateKey: any
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let publicKey: any
  let verifier: IamVerifier

  beforeEach(async () => {
    const keyPair = await generateKeyPair('RS256')
    privateKey = keyPair.privateKey
    publicKey = keyPair.publicKey
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(PublicKeyCache as unknown as { setKey: (k: any) => void }).setKey(publicKey)
    ;(PublicKeyCache as unknown as { reset: () => void }).reset()

    verifier = new IamVerifier({
      publicKeyUrl: 'https://test/public-key',
      issuer: 'test-issuer',
    })
  })

  async function signToken(claims: Record<string, unknown> = {}): Promise<string> {
    return new SignJWT({
      actorType: 'USER',
      email: 'alice@example.com',
      username: 'alice',
      roles: ['ADMIN'],
      permissions: ['iam:users:read', 'iam:audit:read'],
      sessionId: 'sess-1',
      ...claims,
    })
      .setProtectedHeader({ alg: 'RS256' })
      .setSubject('user-1')
      .setIssuer('test-issuer')
      .setIssuedAt()
      .setExpirationTime('1h')
      .setJti('jti-1')
      .sign(privateKey)
  }

  describe('verify', () => {
    it('returns principal for a valid token', async () => {
      const token = await signToken()
      const principal = await verifier.verify(token)

      expect(principal.sub).toBe('user-1')
      expect(principal.actorType).toBe('USER')
      expect(principal.email).toBe('alice@example.com')
      expect(principal.username).toBe('alice')
      expect(principal.roles).toEqual(['ADMIN'])
      expect(principal.permissions).toContain('iam:users:read')
      expect(principal.sessionId).toBe('sess-1')
    })

    it('rejects expired tokens after retry', async () => {
      const token = await new SignJWT({
        actorType: 'USER',
        roles: [],
        permissions: [],
      })
        .setProtectedHeader({ alg: 'RS256' })
        .setSubject('user-1')
        .setIssuer('test-issuer')
        .setIssuedAt(Math.floor(Date.now() / 1000) - 7200)
        .setExpirationTime(Math.floor(Date.now() / 1000) - 3600)
        .setJti('exp-1')
        .sign(privateKey)

      await expect(verifier.verify(token)).rejects.toThrow('IAM token verification failed')
    })

    it('rejects tokens with wrong issuer', async () => {
      const token = await new SignJWT({
        actorType: 'USER',
        roles: [],
        permissions: [],
      })
        .setProtectedHeader({ alg: 'RS256' })
        .setSubject('user-1')
        .setIssuer('wrong-issuer')
        .setIssuedAt()
        .setExpirationTime('1h')
        .setJti('wrong-iss-1')
        .sign(privateKey)

      await expect(verifier.verify(token)).rejects.toThrow('IAM token verification failed')
    })

    it('enforces the configured audience for a disposable machine consumer', async () => {
      const token = await signToken({
        actorType: 'SERVICE_ACCOUNT',
        clientId: 'disposable-consumer',
        roles: [],
        permissions: ['disposable:read'],
        aud: 'disposable-api',
      })
      const consumer = new IamVerifier({
        publicKeyUrl: 'https://test/public-key',
        issuer: 'test-issuer',
        audience: 'disposable-api',
      })
      await expect(consumer.verify(token)).resolves.toMatchObject({
        actorType: 'SERVICE_ACCOUNT',
        clientId: 'disposable-consumer',
        permissions: ['disposable:read'],
      })
      const wrongConsumer = new IamVerifier({
        publicKeyUrl: 'https://test/public-key',
        issuer: 'test-issuer',
        audience: 'different-api',
      })
      await expect(wrongConsumer.verify(token)).rejects.toThrow('IAM token verification failed')
    })

    it('defaults roles and permissions to empty arrays when missing', async () => {
      const token = await new SignJWT({
        actorType: 'SERVICE_ACCOUNT',
      })
        .setProtectedHeader({ alg: 'RS256' })
        .setSubject('sa-1')
        .setIssuer('test-issuer')
        .setIssuedAt()
        .setExpirationTime('1h')
        .setJti('no-roles')
        .sign(privateKey)

      const principal = await verifier.verify(token)
      expect(principal.roles).toEqual([])
      expect(principal.permissions).toEqual([])
    })
  })

  describe('hasPermission', () => {
    const base: Principal = {
      sub: 'u1',
      actorType: 'USER',
      email: 'a@b.com',
      username: 'a',
      roles: [],
      permissions: ['iam:users:read', 'iam:users:write'],
      sessionId: undefined,
      clientId: undefined,
    }

    it('returns true when all permissions present', () => {
      expect(verifier.hasPermission(base, 'iam:users:read')).toBe(true)
      expect(verifier.hasPermission(base, 'iam:users:read', 'iam:users:write')).toBe(true)
    })

    it('returns false when any permission missing', () => {
      expect(verifier.hasPermission(base, 'iam:users:delete')).toBe(false)
      expect(verifier.hasPermission(base, 'iam:users:read', 'iam:users:delete')).toBe(false)
    })

    it('returns true with no required permissions', () => {
      expect(verifier.hasPermission(base)).toBe(true)
    })
  })

  describe('hasRole', () => {
    const base: Principal = {
      sub: 'u1',
      actorType: 'USER',
      email: undefined,
      username: undefined,
      roles: ['ADMIN', 'VIEWER'],
      permissions: [],
      sessionId: undefined,
      clientId: undefined,
    }

    it('returns true when any role matches', () => {
      expect(verifier.hasRole(base, 'ADMIN')).toBe(true)
      expect(verifier.hasRole(base, 'SUPER', 'ADMIN')).toBe(true)
    })

    it('returns false when no role matches', () => {
      expect(verifier.hasRole(base, 'SUPER_ADMIN')).toBe(false)
    })

    it('returns false with no required roles', () => {
      expect(verifier.hasRole(base)).toBe(false)
    })
  })
})
