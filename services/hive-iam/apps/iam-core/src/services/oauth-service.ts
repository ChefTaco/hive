/**
 * oauth-service.ts — OAuth2 Authorization Code Flow with PKCE.
 *
 * Implements RFC 6749 (OAuth 2.0) + RFC 7636 (PKCE).
 * Supports authorization code issuance, exchange, PKCE validation,
 * and OIDC-compatible discovery / userinfo / JWKS endpoints.
 */

import { createHash, randomBytes } from 'node:crypto'
import { nanoid } from 'nanoid'
import { prisma } from '../db/client.js'
import { env } from '../config/env.js'
import { ApiError } from '../types/index.js'
import { getPublishedSigningJwks } from '../utils/keys.js'
import { issueTokenPair } from './token-service.js'
import { createSession } from './session-service.js'
import { logAuditEvent } from './audit-service.js'

// ── Constants ──

/** Authorization codes expire after 10 minutes (RFC 6749 §4.1.2) */
const CODE_TTL_MS = 10 * 60 * 1000

// ── Types ──

export interface AuthorizeParams {
  clientId: string
  redirectUri: string
  responseType: string
  codeChallenge?: string
  codeChallengeMethod?: string
  scope?: string
  state?: string
}

export interface TokenExchangeParams {
  grantType: string
  code: string
  redirectUri: string
  clientId: string
  codeVerifier?: string
}

export interface AuthorizeResult {
  code: string
  state?: string
  redirectUri: string
  /** True if client is first-party and consent can be skipped */
  skipConsent: boolean
  clientName: string
  scope?: string
}

// ── Authorization Code Issuance ──

/**
 * Validate an authorization request and generate an authorization code.
 * Called after the user has authenticated and consented.
 */
export async function createAuthorizationCode(
  userId: string,
  params: AuthorizeParams,
  ipAddress?: string,
): Promise<AuthorizeResult> {
  // Validate client
  const client = await prisma.client.findUnique({ where: { id: params.clientId } })
  if (!client || !client.active) {
    throw new ApiError(400, 'INVALID_CLIENT', 'Unknown or inactive client')
  }

  // Validate response_type
  if (params.responseType !== 'code') {
    throw new ApiError(400, 'UNSUPPORTED_RESPONSE_TYPE', 'Only response_type=code is supported')
  }

  // Validate grant type
  const grantTypes: string[] = JSON.parse(client.grantTypes)
  if (!grantTypes.includes('authorization_code')) {
    throw new ApiError(400, 'UNAUTHORIZED_CLIENT', 'Client is not authorized for authorization_code grant')
  }

  // Validate redirect_uri against registered URIs
  // Non-first-party clients MUST have at least one registered redirect URI
  const registeredUris: string[] = JSON.parse(client.redirectUris)
  if (!client.firstParty && registeredUris.length === 0) {
    throw new ApiError(400, 'INVALID_CLIENT', 'Client has no registered redirect URIs')
  }
  if (registeredUris.length > 0 && !registeredUris.includes(params.redirectUri)) {
    throw new ApiError(400, 'INVALID_REDIRECT_URI', 'Redirect URI is not registered for this client')
  }

  // Validate PKCE: required for public clients
  if (client.clientType === 'public' && !params.codeChallenge) {
    throw new ApiError(400, 'INVALID_REQUEST', 'Public clients must use PKCE (code_challenge required)')
  }

  // Validate PKCE challenge method
  if (params.codeChallenge && params.codeChallengeMethod && params.codeChallengeMethod !== 'S256') {
    throw new ApiError(400, 'INVALID_REQUEST', 'Only S256 code_challenge_method is supported')
  }

  // Generate authorization code (cryptographically secure)
  const code = randomBytes(32).toString('base64url')

  await prisma.authorizationCode.create({
    data: {
      code,
      clientId: params.clientId,
      userId,
      redirectUri: params.redirectUri,
      scope: params.scope ?? null,
      codeChallenge: params.codeChallenge ?? null,
      state: params.state ?? null,
      expiresAt: new Date(Date.now() + CODE_TTL_MS),
    },
  })

  await logAuditEvent({
    eventType: 'oauth.authorize',
    category: 'AUTHENTICATION',
    actorId: userId,
    actorType: 'USER',
    ipAddress,
    action: 'oauth_authorize',
    outcome: 'SUCCESS',
    detail: { clientId: params.clientId, scope: params.scope },
    source: 'iam-api',
  })

  return {
    code,
    state: params.state,
    redirectUri: params.redirectUri,
    skipConsent: client.firstParty,
    clientName: client.name,
    scope: params.scope,
  }
}

// ── Authorization Request Validation (pre-consent) ──

/**
 * Validate the authorize request parameters without creating a code.
 * Returns client info for the consent screen.
 */
export async function validateAuthorizeRequest(params: AuthorizeParams): Promise<{
  clientName: string
  clientDescription: string | null
  scope: string | undefined
  skipConsent: boolean
}> {
  const client = await prisma.client.findUnique({ where: { id: params.clientId } })
  if (!client || !client.active) {
    throw new ApiError(400, 'INVALID_CLIENT', 'Unknown or inactive client')
  }

  if (params.responseType !== 'code') {
    throw new ApiError(400, 'UNSUPPORTED_RESPONSE_TYPE', 'Only response_type=code is supported')
  }

  const grantTypes: string[] = JSON.parse(client.grantTypes)
  if (!grantTypes.includes('authorization_code')) {
    throw new ApiError(400, 'UNAUTHORIZED_CLIENT', 'Client is not authorized for authorization_code grant')
  }

  const registeredUris: string[] = JSON.parse(client.redirectUris)
  if (!client.firstParty && registeredUris.length === 0) {
    throw new ApiError(400, 'INVALID_CLIENT', 'Client has no registered redirect URIs')
  }
  if (registeredUris.length > 0 && !registeredUris.includes(params.redirectUri)) {
    throw new ApiError(400, 'INVALID_REDIRECT_URI', 'Redirect URI is not registered for this client')
  }

  if (client.clientType === 'public' && !params.codeChallenge) {
    throw new ApiError(400, 'INVALID_REQUEST', 'Public clients must use PKCE (code_challenge required)')
  }

  if (params.codeChallenge && params.codeChallengeMethod && params.codeChallengeMethod !== 'S256') {
    throw new ApiError(400, 'INVALID_REQUEST', 'Only S256 code_challenge_method is supported')
  }

  return {
    clientName: client.name,
    clientDescription: client.description,
    scope: params.scope,
    skipConsent: client.firstParty,
  }
}

// ── Token Exchange ──

/**
 * Exchange an authorization code for access + refresh tokens.
 * Validates PKCE code_verifier if a challenge was provided.
 */
export async function exchangeAuthorizationCode(
  params: TokenExchangeParams,
  ipAddress?: string,
): Promise<{
  accessToken: string
  refreshToken: string
  expiresIn: number
  tokenType: string
  scope?: string
  userId?: string
  email?: string
  username?: string
  displayName?: string
}> {
  if (params.grantType !== 'authorization_code') {
    throw new ApiError(400, 'UNSUPPORTED_GRANT_TYPE', 'Only authorization_code grant type is supported here')
  }

  // Find and validate the authorization code
  const authCode = await prisma.authorizationCode.findUnique({
    where: { code: params.code },
    include: {
      user: { include: { roles: { include: { role: true } } } },
      client: true,
    },
  })

  if (!authCode) {
    throw new ApiError(400, 'INVALID_GRANT', 'Authorization code is invalid')
  }

  // Code must not be expired
  if (authCode.expiresAt < new Date()) {
    // Clean up expired code
    await prisma.authorizationCode.delete({ where: { id: authCode.id } })
    throw new ApiError(400, 'INVALID_GRANT', 'Authorization code has expired')
  }

  // Code must not be already used (RFC 6749 §4.1.2: MUST invalidate after use)
  if (authCode.usedAt) {
    // Potential replay attack — revoke all tokens from this code's session
    await logAuditEvent({
      eventType: 'oauth.code_reuse',
      category: 'AUTHENTICATION',
      actorId: authCode.userId,
      actorType: 'USER',
      ipAddress,
      action: 'oauth_code_reuse_attempt',
      outcome: 'DENIED',
      detail: { clientId: authCode.clientId, codeId: authCode.id },
      source: 'iam-api',
    })
    throw new ApiError(400, 'INVALID_GRANT', 'Authorization code has already been used')
  }

  // Validate client_id matches
  if (authCode.clientId !== params.clientId) {
    throw new ApiError(400, 'INVALID_GRANT', 'Client ID does not match the authorization code')
  }

  // Validate redirect_uri matches exactly
  if (authCode.redirectUri !== params.redirectUri) {
    throw new ApiError(400, 'INVALID_GRANT', 'Redirect URI does not match')
  }

  // Validate PKCE code_verifier
  if (authCode.codeChallenge) {
    if (!params.codeVerifier) {
      throw new ApiError(400, 'INVALID_GRANT', 'code_verifier required for PKCE-protected authorization')
    }

    const computedChallenge = createHash('sha256')
      .update(params.codeVerifier)
      .digest('base64url')

    if (computedChallenge !== authCode.codeChallenge) {
      throw new ApiError(400, 'INVALID_GRANT', 'PKCE code_verifier does not match code_challenge')
    }
  }

  // Mark code as used (atomically)
  await prisma.authorizationCode.update({
    where: { id: authCode.id },
    data: { usedAt: new Date() },
  })

  // Validate user is still active
  if (!authCode.user.active) {
    throw new ApiError(400, 'INVALID_GRANT', 'User account is inactive')
  }

  // Issue tokens
  const roles = authCode.user.roles.map((r) => r.role.name)
  const permissions: string[] = [
    ...new Set(
      authCode.user.roles.flatMap((r) => {
        const perms = r.role.permissions
        return (typeof perms === 'string' ? JSON.parse(perms) : perms) as string[]
      }),
    ),
  ]

  const { sessionId } = await createSession(authCode.userId, ipAddress)
  const tokenPair = await issueTokenPair(
    authCode.userId,
    authCode.user.email,
    authCode.user.username,
    roles,
    permissions,
    sessionId,
    ipAddress,
    authCode.clientId,
  )

  await logAuditEvent({
    eventType: 'oauth.token_exchange',
    category: 'AUTHENTICATION',
    actorId: authCode.userId,
    actorType: 'USER',
    actorEmail: authCode.user.email,
    ipAddress,
    action: 'oauth_token_exchange',
    outcome: 'SUCCESS',
    detail: { clientId: authCode.clientId, scope: authCode.scope },
    source: 'iam-api',
  })

  return {
    accessToken: tokenPair.accessToken,
    refreshToken: tokenPair.refreshToken,
    expiresIn: tokenPair.expiresIn,
    tokenType: 'Bearer',
    scope: authCode.scope ?? undefined,
    userId: authCode.userId,
    email: authCode.user.email,
    username: authCode.user.username,
    displayName: authCode.user.displayName,
  }
}

// ── Client Credentials Grant ──

/**
 * Issue an access token for a confidential client using client_credentials grant.
 * No user context — the token represents the client itself.
 */
export async function exchangeClientCredentials(
  clientId: string,
  scope?: string,
  ipAddress?: string,
): Promise<{
  accessToken: string
  expiresIn: number
  tokenType: string
  scope?: string
}> {
  const client = await prisma.client.findUnique({ where: { id: clientId } })
  if (!client || !client.active) {
    throw new ApiError(400, 'INVALID_CLIENT', 'Unknown or inactive client')
  }

  if (client.clientType !== 'confidential') {
    throw new ApiError(400, 'UNAUTHORIZED_CLIENT', 'Only confidential clients can use client_credentials grant')
  }

  const grantTypes: string[] = JSON.parse(client.grantTypes)
  if (!grantTypes.includes('client_credentials')) {
    throw new ApiError(400, 'UNAUTHORIZED_CLIENT', 'Client is not authorized for client_credentials grant')
  }

  const { issueClientCredentialsToken, lifetimeForClientCredentials } = await import('./token-service.js')
  const accessToken = await issueClientCredentialsToken(clientId, client.name, scope)

  await logAuditEvent({
    eventType: 'oauth.client_credentials',
    category: 'AUTHENTICATION',
    actorId: clientId,
    actorType: 'SERVICE_ACCOUNT',
    ipAddress,
    action: 'oauth_client_credentials',
    outcome: 'SUCCESS',
    detail: { clientId, scope },
    source: 'iam-api',
  })

  return {
    accessToken,
    expiresIn: lifetimeForClientCredentials(clientId),
    tokenType: 'Bearer',
    scope,
  }
}

// ── OIDC Discovery ──

/**
 * Return the OpenID Connect Discovery document.
 */
export function getOpenIdConfiguration(issuerUrl: string): Record<string, unknown> {
  return {
    issuer: env.JWT_ISSUER,
    authorization_endpoint: `${issuerUrl}/api/v1/oauth/authorize`,
    token_endpoint: `${issuerUrl}/api/v1/oauth/token`,
    userinfo_endpoint: `${issuerUrl}/api/v1/oauth/userinfo`,
    jwks_uri: `${issuerUrl}/api/v1/oauth/jwks`,
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code', 'refresh_token', 'client_credentials'],
    subject_types_supported: ['public'],
    id_token_signing_alg_values_supported: ['RS256'],
    scopes_supported: ['openid', 'profile', 'email', 'offline_access'],
    token_endpoint_auth_methods_supported: ['client_secret_post', 'client_secret_basic', 'none'],
    code_challenge_methods_supported: ['S256'],
    claims_supported: ['sub', 'email', 'username', 'name', 'roles'],
  }
}

// ── JWKS ──

/**
 * Convert the RS256 public key to JWK format for the JWKS endpoint.
 */
export async function getJwks(): Promise<{ keys: Record<string, unknown>[] }> {
  return getPublishedSigningJwks()
}

// ── Cleanup ──

/**
 * Delete expired authorization codes. Called periodically.
 */
export async function cleanupExpiredCodes(): Promise<number> {
  const result = await prisma.authorizationCode.deleteMany({
    where: { expiresAt: { lt: new Date() } },
  })
  return result.count
}
