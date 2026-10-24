import { jwtVerify } from 'jose'
import { PublicKeyCache } from './cache.js'
import type { IamToken, Principal, IamMiddlewareOptions } from './types.js'

/** Simple TTL cache for permission check results */
class PermissionCache {
  private readonly cache = new Map<string, { result: boolean; expiresAt: number }>()
  private readonly ttlMs: number

  constructor(ttlMs = 300_000) {
    this.ttlMs = ttlMs
  }

  get(key: string): boolean | undefined {
    const entry = this.cache.get(key)
    if (!entry) return undefined
    if (Date.now() > entry.expiresAt) {
      this.cache.delete(key)
      return undefined
    }
    return entry.result
  }

  set(key: string, result: boolean): void {
    this.cache.set(key, { result, expiresAt: Date.now() + this.ttlMs })
    // Evict stale entries periodically (every 100 sets)
    if (this.cache.size > 500) this.evict()
  }

  clear(): void {
    this.cache.clear()
  }

  private evict(): void {
    const now = Date.now()
    for (const [k, v] of this.cache) {
      if (now > v.expiresAt) this.cache.delete(k)
    }
  }
}

/**
 * Check if a single granted permission matches a required permission.
 * Supports wildcard matching with `*` at segment boundaries (split by `:`).
 *
 * Examples:
 *   `"iam:*"` matches `"iam:users:read"`, `"iam:roles:write"`
 *   `"*"` matches everything
 *   `"iam:users:*"` matches `"iam:users:read"` but not `"iam:roles:read"`
 */
function permissionMatches(granted: string, required: string): boolean {
  if (granted === '*' || granted === required) return true

  const grantedParts = granted.split(':')
  const requiredParts = required.split(':')

  for (let i = 0; i < grantedParts.length; i++) {
    if (grantedParts[i] === '*') return true // wildcard matches remaining
    if (grantedParts[i] !== requiredParts[i]) return false
  }

  // Granted is a prefix only if all segments matched
  return grantedParts.length === requiredParts.length
}

export class IamVerifier {
  private readonly cache: PublicKeyCache
  private readonly issuer: string
  private readonly audience: string | string[] | undefined
  private readonly permCache: PermissionCache

  constructor(opts: IamMiddlewareOptions) {
    this.cache = new PublicKeyCache(opts.publicKeyUrl, opts.cacheTtlMs)
    this.issuer = opts.issuer ?? 'iam-core'
    this.audience = opts.audience
    this.permCache = new PermissionCache()
  }

  async verify(token: string): Promise<Principal> {
    const { key } = await this.cache.getKey()
    const options = { issuer: this.issuer, ...(this.audience ? { audience: this.audience } : {}) }

    try {
      const { payload } = await jwtVerify(token, key, options)
      const t = payload as unknown as IamToken

      return {
        sub: t.sub,
        actorType: t.actorType as Principal['actorType'],
        email: t.email,
        username: t.username,
        roles: t.roles ?? [],
        permissions: t.permissions ?? [],
        sessionId: t.sessionId,
        clientId: t.clientId,
      }
    } catch (err) {
      // Retry once with a fresh public key in case it was rotated
      const { key: freshKey } = await this.cache.refresh()
      try {
        const { payload } = await jwtVerify(token, freshKey, options)
        const t = payload as unknown as IamToken
        return {
          sub: t.sub,
          actorType: t.actorType as Principal['actorType'],
          email: t.email,
          username: t.username,
          roles: t.roles ?? [],
          permissions: t.permissions ?? [],
          sessionId: t.sessionId,
          clientId: t.clientId,
        }
      } catch (retryErr) {
        throw new Error(
          `IAM token verification failed: ${retryErr instanceof Error ? retryErr.message : String(retryErr)}`,
        )
      }
    }
  }

  hasPermission(principal: Principal, ...required: string[]): boolean {
    return required.every((req) => {
      const cacheKey = `${principal.sub}:${req}`
      const cached = this.permCache.get(cacheKey)
      if (cached !== undefined) return cached

      const result = principal.permissions.some((granted) => permissionMatches(granted, req))
      this.permCache.set(cacheKey, result)
      return result
    })
  }

  hasRole(principal: Principal, ...required: string[]): boolean {
    return required.some((r) => principal.roles.includes(r))
  }
}
