import { machineClientPolicies } from './client-policies.js';
import { createLocalJWKSet, SignJWT, jwtVerify, type JWTPayload } from 'jose'
import { nanoid } from 'nanoid'
import { createHash } from 'node:crypto'
import { prisma } from '../db/client.js'
import { env } from '../config/env.js'
import {
  getPrivateKey,
  getPublishedSigningJwks,
  getSigningKeyId,
} from '../utils/keys.js'
import { createSession } from '../services/session-service.js'
import { ApiError } from '../types/index.js'
import type { Principal, TokenPair } from '../types/index.js'

export interface AccessTokenPayload extends JWTPayload {
  sub: string
  actorType: string
  email?: string
  username?: string
  roles: string[]
  permissions: string[]
  sessionId?: string
  clientId?: string
  jti: string
}

const HIVE_ROUTER_PROXY_CLIENT_ID = 'hive-router'
const SECURITY_EXPORTER_CLIENT_ID = 'security-exporter'
const EXAMPLE_PORTAL_CLIENT_ID = 'example-portal'
const HIVE_ROUTER_AUDIENCE = 'hive-router'
const EXAMPLE_PORTAL_AUDIENCE = 'example-portal'
const EXAMPLE_PORTAL_CLIENT_PERMISSIONS = new Set(['example-portal:read'])
const HIVE_ROUTER_PROXY_PERMISSIONS = new Set([
  'iam:policy:write',
  'iam:users:read',
  'iam:users:write',
  'iam:users:delete',
  'iam:roles:read',
  'iam:roles:write',
  'iam:sa:read',
  'iam:sa:write',
  'iam:sa:delete',
  'iam:clients:read',
  'iam:clients:write',
  'iam:audit:read',
  'iam:sessions:revoke',
  'iam:system:login',
  'iam:tokens:introspect',
])

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

/** Every permission a client_credentials token for this client could ever carry. */
export function clientCredentialsPermissionCeiling(clientId: string): string[] {
  if (clientId === SECURITY_EXPORTER_CLIENT_ID) return ['iam:audit:read', 'router:security-events:read']
  if (clientId === EXAMPLE_PORTAL_CLIENT_ID) return [...EXAMPLE_PORTAL_CLIENT_PERMISSIONS]
  if (clientId === HIVE_ROUTER_PROXY_CLIENT_ID) return [...HIVE_ROUTER_PROXY_PERMISSIONS]
  return [...(machineClientPolicies[clientId]?.permissions ?? [])]
}

export function permissionsForClientCredentials(clientId: string, scope?: string): string[] {
  if (!scope) return []
  const requested = scope.split(/\s+/).map((entry) => entry.trim()).filter(Boolean)
  if (clientId === SECURITY_EXPORTER_CLIENT_ID) {
    return requested.filter((permission) => ['iam:audit:read', 'router:security-events:read'].includes(permission))
  }
  if (clientId === EXAMPLE_PORTAL_CLIENT_ID) {
    return requested.filter((permission) => EXAMPLE_PORTAL_CLIENT_PERMISSIONS.has(permission))
  }
  if (clientId !== HIVE_ROUTER_PROXY_CLIENT_ID) return requested.filter((permission) => machineClientPolicies[clientId]?.permissions.includes(permission))
  return requested.filter((permission) => HIVE_ROUTER_PROXY_PERMISSIONS.has(permission))
}

export function audienceForClient(clientId?: string): string | undefined {
  if (clientId === SECURITY_EXPORTER_CLIENT_ID) return HIVE_ROUTER_AUDIENCE
  if (clientId === EXAMPLE_PORTAL_CLIENT_ID) return EXAMPLE_PORTAL_AUDIENCE
  return clientId ? machineClientPolicies[clientId]?.audience : undefined
}

export function lifetimeForClientCredentials(clientId: string): number {
  return Math.min(env.JWT_ACCESS_TTL, machineClientPolicies[clientId]?.lifetimeSeconds ?? env.JWT_ACCESS_TTL)
}

export function clientCredentialsTokenProfile(
  clientId: string,
  clientName: string,
  scope?: string,
): {
  claims: Record<string, unknown>
  audience?: string
} {
  return {
    claims: {
      actorType: 'SERVICE_ACCOUNT',
      clientId,
      clientName,
      token_type: 'access',
      scope,
      roles: [],
      permissions: permissionsForClientCredentials(clientId, scope),
    },
    audience: audienceForClient(clientId),
  }
}

export async function issueTokenPair(
  userId: string,
  email: string,
  username: string,
  roles: string[],
  permissions: string[],
  sessionId: string,
  ipAddress?: string,
  clientId?: string,
  userAgent?: string,
): Promise<TokenPair> {
  const privateKey = await getPrivateKey()
  const signingKeyId = await getSigningKeyId()
  const now = Math.floor(Date.now() / 1000)

  const token = new SignJWT({
    actorType: 'USER',
    email,
    username,
    roles,
    permissions,
    sessionId,
    ...(clientId ? { clientId } : {}),
  })
    .setProtectedHeader({ alg: 'RS256', kid: signingKeyId })
    .setSubject(userId)
    .setIssuer(env.JWT_ISSUER)
    .setIssuedAt(now)
    .setExpirationTime(now + env.JWT_ACCESS_TTL)
    .setJti(nanoid())
  const audience = audienceForClient(clientId)
  if (audience) token.setAudience(audience)
  const accessToken = await token.sign(privateKey)

  const rawRefreshToken = nanoid(64)
  const refreshTokenHash = hashToken(rawRefreshToken)

  await prisma.refreshToken.create({
    data: {
      userId,
      sessionId,
      tokenHash: refreshTokenHash,
      ipAddress,
      clientId,
      userAgent,
      expiresAt: new Date(Date.now() + env.JWT_REFRESH_TTL * 1000),
    },
  })

  return {
    accessToken,
    refreshToken: rawRefreshToken,
    sessionId,
    expiresIn: env.JWT_ACCESS_TTL,
  }
}

export async function issueServiceAccountToken(
  saId: string,
  clientId: string,
  roles: string[],
  permissions: string[],
): Promise<string> {
  const privateKey = await getPrivateKey()
  const signingKeyId = await getSigningKeyId()
  const now = Math.floor(Date.now() / 1000)

  return new SignJWT({
    actorType: 'SERVICE_ACCOUNT',
    clientId,
    roles,
    permissions,
  })
    .setProtectedHeader({ alg: 'RS256', kid: signingKeyId })
    .setSubject(saId)
    .setIssuer(env.JWT_ISSUER)
    .setIssuedAt(now)
    .setExpirationTime(now + env.JWT_ACCESS_TTL)
    .setJti(nanoid())
    .sign(privateKey)
}

/**
 * Issue a client_credentials access token (no user context).
 */
export async function issueClientCredentialsToken(
  clientId: string,
  clientName: string,
  scope?: string,
): Promise<string> {
  const privateKey = await getPrivateKey()
  const signingKeyId = await getSigningKeyId()
  const now = Math.floor(Date.now() / 1000)
  const profile = clientCredentialsTokenProfile(clientId, clientName, scope)

  const token = new SignJWT(profile.claims)
    .setProtectedHeader({ alg: 'RS256', kid: signingKeyId })
    .setSubject(clientId)
    .setIssuer(env.JWT_ISSUER)
    .setIssuedAt(now)
    .setExpirationTime(now + lifetimeForClientCredentials(clientId))
    .setJti(nanoid())
  if (profile.audience) {
    token.setAudience(profile.audience)
  }
  return token.sign(privateKey)
}

/**
 * Issue an OIDC id_token.
 * Includes standard claims: sub, email, name, nonce, at_hash, aud.
 */
export async function issueIdToken(
  userId: string,
  email: string,
  username: string,
  displayName: string,
  clientId: string,
  nonce?: string,
  accessToken?: string,
): Promise<string> {
  const privateKey = await getPrivateKey()
  const signingKeyId = await getSigningKeyId()
  const now = Math.floor(Date.now() / 1000)

  const claims: Record<string, unknown> = {
    email,
    preferred_username: username,
    name: displayName,
  }

  if (nonce) claims['nonce'] = nonce

  // at_hash: left half of SHA-256 of the access token (RFC 3.1.3.6)
  if (accessToken) {
    const hash = createHash('sha256').update(accessToken).digest()
    claims['at_hash'] = hash.subarray(0, hash.length / 2).toString('base64url')
  }

  return new SignJWT(claims)
    .setProtectedHeader({ alg: 'RS256', kid: signingKeyId })
    .setSubject(userId)
    .setAudience(clientId)
    .setIssuer(env.JWT_ISSUER)
    .setIssuedAt(now)
    .setExpirationTime(now + env.JWT_ACCESS_TTL)
    .setJti(nanoid())
    .sign(privateKey)
}

export async function verifyAccessToken(token: string): Promise<AccessTokenPayload> {
  const verificationKeys = createLocalJWKSet(await getPublishedSigningJwks())
  try {
    const { payload } = await jwtVerify(token, verificationKeys, {
      issuer: env.JWT_ISSUER,
    })
    const access = payload as AccessTokenPayload
    if (!access.sub || !access.actorType || !Array.isArray(access.roles) || !Array.isArray(access.permissions)) {
      throw new Error('Required access-token claims are missing')
    }
    if (access.sessionId) {
      const session = await prisma.session.findFirst({
        where: {
          id: access.sessionId,
          userId: access.sub,
          revokedAt: null,
          expiresAt: { gt: new Date() },
          user: { active: true },
        },
        select: { id: true },
      })
      if (!session) throw new Error('Access-token session is inactive or revoked')
    }
    return access
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Invalid token'
    throw new ApiError(401, 'INVALID_TOKEN', msg)
  }
}

export async function rotateRefreshToken(
  rawToken: string,
  ipAddress?: string,
  clientId?: string,
  userAgent?: string,
): Promise<TokenPair> {
  const hash = hashToken(rawToken)

  // Atomic revocation: only revoke if still valid (prevents TOCTOU race)
  const revoked = await prisma.refreshToken.updateMany({
    where: { tokenHash: hash, revokedAt: null, expiresAt: { gt: new Date() } },
    data: { revokedAt: new Date() },
  })

  if (revoked.count === 0) {
    throw new ApiError(401, 'INVALID_REFRESH_TOKEN', 'Refresh token is invalid or expired')
  }

  // Fetch the revoked token to get userId/sessionId
  const existing = await prisma.refreshToken.findUnique({ where: { tokenHash: hash } })
  if (!existing) {
    throw new ApiError(401, 'INVALID_REFRESH_TOKEN', 'Refresh token not found')
  }

  // Validate token binding: clientId must match if the original token was bound
  if (existing.clientId && existing.clientId !== clientId) {
    throw new ApiError(401, 'TOKEN_BINDING_MISMATCH', 'Refresh token was issued to a different client')
  }

  // Fetch user + roles
  const user = await prisma.user.findUnique({
    where: { id: existing.userId },
    include: { roles: { include: { role: true } } },
  })

  if (!user || !user.active) {
    throw new ApiError(401, 'USER_INACTIVE', 'User account is disabled')
  }

  const roles = user.roles.map((r) => r.role.name)
  const permissions: string[] = [
    ...new Set(user.roles.flatMap((r) => {
      const perms = r.role.permissions
      return (typeof perms === 'string' ? JSON.parse(perms) : perms) as string[]
    })),
  ]

  // Ensure we have a valid session — create one if orphaned
  let sessionId = existing.sessionId
  if (!sessionId) {
    const result = await createSession(user.id, ipAddress)
    sessionId = result.sessionId
  }

  return issueTokenPair(
    user.id,
    user.email,
    user.username,
    roles,
    permissions,
    sessionId,
    ipAddress,
    clientId ?? existing.clientId ?? undefined,
    userAgent,
  )
}

export async function revokeRefreshToken(rawToken: string): Promise<void> {
  const hash = hashToken(rawToken)
  await prisma.refreshToken.updateMany({
    where: { tokenHash: hash, revokedAt: null },
    data: { revokedAt: new Date() },
  })
}

export async function introspectToken(
  token: string,
): Promise<{ valid: true; principal: Principal } | { valid: false; reason: string }> {
  try {
    const payload = await verifyAccessToken(token)
    return {
      valid: true,
      principal: {
        sub: payload.sub ?? '',
        actorType: payload.actorType as Principal['actorType'],
        email: payload.email,
        username: payload.username,
        roles: payload.roles,
        permissions: payload.permissions,
        sessionId: payload.sessionId,
        clientId: payload.clientId,
      },
    }
  } catch (err) {
    return { valid: false, reason: err instanceof Error ? err.message : 'Unknown' }
  }
}
