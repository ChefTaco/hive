/**
 * oauth.ts — OAuth2 Authorization Code Flow + PKCE routes.
 *
 * Implements:
 *   GET  /oauth/authorize       — Authorization request (returns client info for consent)
 *   POST /oauth/authorize       — Authorization approval (generates code, redirects)
 *   POST /oauth/token           — Token exchange (code → tokens)
 *   GET  /oauth/userinfo        — OIDC UserInfo
 *   GET  /oauth/.well-known/openid-configuration — OIDC Discovery
 *   GET  /oauth/jwks            — JSON Web Key Set
 */

import { Hono } from 'hono'
import { prisma } from '../db/client.js'
import { authMiddleware } from '../middleware/auth.js'
import { clientAuthMiddleware } from '../middleware/client-auth.js'
import { parseBody } from '../utils/validate.js'
import { getClientIp } from '../utils/ip.js'
import { ApiError } from '../types/index.js'
import { AuthorizeQuerySchema, AuthorizeConsentSchema, TokenExchangeSchema } from '../schemas/oauth.js'
import {
  validateAuthorizeRequest,
  createAuthorizationCode,
  exchangeAuthorizationCode,
  exchangeClientCredentials,
  getOpenIdConfiguration,
  getJwks,
} from '../services/oauth-service.js'
import { rotateRefreshToken, issueIdToken } from '../services/token-service.js'
import { logAuditEvent } from '../services/audit-service.js'
import { env } from '../config/env.js'
import argon2 from 'argon2'

export const oauthRouter = new Hono()

// ── GET /authorize — Validate request and return client info for consent screen ──
oauthRouter.get('/authorize', authMiddleware, async (c) => {
  const query = c.req.query()

  const parsed = AuthorizeQuerySchema.safeParse(query)
  if (!parsed.success) {
    const messages = parsed.error.issues
      .map((i) => `${i.path.join('.')}: ${i.message}`)
      .join('; ')
    throw new ApiError(400, 'INVALID_REQUEST', messages)
  }

  const params = parsed.data

  const result = await validateAuthorizeRequest({
    clientId: params.client_id,
    redirectUri: params.redirect_uri,
    responseType: params.response_type,
    codeChallenge: params.code_challenge,
    codeChallengeMethod: params.code_challenge_method,
    scope: params.scope,
    state: params.state,
  })

  // If first-party client, auto-approve and redirect immediately
  if (result.skipConsent) {
    const principal = c.get('principal')
    const codeResult = await createAuthorizationCode(
      principal.sub,
      {
        clientId: params.client_id,
        redirectUri: params.redirect_uri,
        responseType: params.response_type,
        codeChallenge: params.code_challenge,
        codeChallengeMethod: params.code_challenge_method,
        scope: params.scope,
        state: params.state,
      },
      getClientIp(c),
    )

    const redirectUrl = new URL(codeResult.redirectUri)
    redirectUrl.searchParams.set('code', codeResult.code)
    if (codeResult.state) redirectUrl.searchParams.set('state', codeResult.state)

    return c.redirect(redirectUrl.toString(), 302)
  }

  // Return client info for consent screen
  return c.json({
    clientName: result.clientName,
    clientDescription: result.clientDescription,
    scope: result.scope,
    // Echo back the params so the consent form can re-submit them
    authParams: {
      clientId: params.client_id,
      redirectUri: params.redirect_uri,
      responseType: params.response_type,
      codeChallenge: params.code_challenge,
      codeChallengeMethod: params.code_challenge_method,
      scope: params.scope,
      state: params.state,
    },
  })
})

// ── POST /authorize — User approves consent, generate code and redirect ──
oauthRouter.post('/authorize', authMiddleware, async (c) => {
  const body = await parseBody(c, AuthorizeConsentSchema)
  const principal = c.get('principal')
  const ip = getClientIp(c)

  const codeResult = await createAuthorizationCode(
    principal.sub,
    {
      clientId: body.clientId,
      redirectUri: body.redirectUri,
      responseType: body.responseType,
      codeChallenge: body.codeChallenge,
      codeChallengeMethod: body.codeChallengeMethod,
      scope: body.scope,
      state: body.state,
    },
    ip,
  )

  const redirectUrl = new URL(codeResult.redirectUri)
  redirectUrl.searchParams.set('code', codeResult.code)
  if (codeResult.state) redirectUrl.searchParams.set('state', codeResult.state)

  return c.json({
    redirectUri: redirectUrl.toString(),
    code: codeResult.code,
    state: codeResult.state,
  })
})

// ── POST /token — Exchange code for tokens (or refresh) ──
oauthRouter.post('/token', async (c) => {
  // Parse as form-urlencoded (OAuth2 spec) or JSON
  let body: Record<string, string>
  const contentType = c.req.header('content-type') ?? ''

  if (contentType.includes('application/x-www-form-urlencoded')) {
    const formData = await c.req.parseBody()
    body = Object.fromEntries(
      Object.entries(formData).map(([k, v]) => [k, String(v)]),
    )
  } else {
    body = (await c.req.json()) as Record<string, string>
  }

  const parsed = TokenExchangeSchema.safeParse(body)
  if (!parsed.success) {
    const messages = parsed.error.issues
      .map((i) => `${i.path.join('.')}: ${i.message}`)
      .join('; ')
    return c.json({ error: 'invalid_request', error_description: messages }, 400)
  }

  const params = parsed.data
  const ip = getClientIp(c)

  // ── Handle refresh_token grant ──
  if (params.grant_type === 'refresh_token') {
    if (!params.refresh_token) {
      return c.json({ error: 'invalid_request', error_description: 'refresh_token required' }, 400)
    }

    try {
      const tokenPair = await rotateRefreshToken(params.refresh_token, ip, params.client_id, c.req.header('user-agent'))
      return c.json({
        access_token: tokenPair.accessToken,
        refresh_token: tokenPair.refreshToken,
        expires_in: tokenPair.expiresIn,
        token_type: 'Bearer',
      })
    } catch (err) {
      return c.json({
        error: 'invalid_grant',
        error_description: err instanceof Error ? err.message : 'Invalid refresh token',
      }, 400)
    }
  }

  // ── Handle client_credentials grant ──
  if (params.grant_type === 'client_credentials') {
    if (!params.client_id) {
      return c.json({ error: 'invalid_request', error_description: 'client_id is required' }, 400)
    }

    // Authenticate the client (required for client_credentials)
    const clientSecret = params.client_secret ?? extractBasicAuthSecret(c)
    if (!clientSecret) {
      return c.json({ error: 'invalid_client', error_description: 'Client authentication required' }, 401)
    }

    const client = await prisma.client.findUnique({ where: { id: params.client_id } })
    if (!client || !client.active || !client.secretHash) {
      return c.json({ error: 'invalid_client', error_description: 'Unknown or inactive client' }, 401)
    }
    const validSecret = await argon2.verify(client.secretHash, clientSecret)
    if (!validSecret) {
      return c.json({ error: 'invalid_client', error_description: 'Invalid client secret' }, 401)
    }

    try {
      const result = await exchangeClientCredentials(params.client_id, params.scope, ip)
      return c.json({
        access_token: result.accessToken,
        expires_in: result.expiresIn,
        token_type: result.tokenType,
        scope: result.scope,
      })
    } catch (err) {
      if (err instanceof ApiError) {
        return c.json({ error: err.code.toLowerCase(), error_description: err.message }, err.status as 400)
      }
      return c.json({ error: 'server_error', error_description: 'An unexpected error occurred' }, 500)
    }
  }

  // ── Handle authorization_code grant ──
  if (!params.code || !params.redirect_uri || !params.client_id) {
    return c.json({
      error: 'invalid_request',
      error_description: 'code, redirect_uri, and client_id are required',
    }, 400)
  }

  // Authenticate the client (client_secret in body or Basic auth)
  const clientSecret = params.client_secret ?? extractBasicAuthSecret(c)
  if (clientSecret) {
    const client = await prisma.client.findUnique({ where: { id: params.client_id } })
    if (!client || !client.active) {
      return c.json({ error: 'invalid_client', error_description: 'Unknown or inactive client' }, 401)
    }
    if (!client.secretHash) {
      return c.json({ error: 'invalid_client', error_description: 'Public clients cannot authenticate with a secret' }, 401)
    }
    const validSecret = await argon2.verify(client.secretHash, clientSecret)
    if (!validSecret) {
      return c.json({ error: 'invalid_client', error_description: 'Invalid client secret' }, 401)
    }
  }
  // Note: Public clients (PKCE-only, no secret) are allowed — PKCE provides the proof

  try {
    const result = await exchangeAuthorizationCode(
      {
        grantType: params.grant_type,
        code: params.code,
        redirectUri: params.redirect_uri,
        clientId: params.client_id,
        codeVerifier: params.code_verifier,
      },
      ip,
    )

    const response: Record<string, unknown> = {
      access_token: result.accessToken,
      refresh_token: result.refreshToken,
      expires_in: result.expiresIn,
      token_type: result.tokenType,
      scope: result.scope,
    }

    // Issue id_token when openid scope is requested (OIDC compliance)
    if (result.scope?.includes('openid') && result.userId) {
      const idToken = await issueIdToken(
        result.userId,
        result.email ?? '',
        result.username ?? '',
        result.displayName ?? '',
        params.client_id,
        params.nonce,
        result.accessToken,
      )
      response['id_token'] = idToken
    }

    return c.json(response)
  } catch (err) {
    if (err instanceof ApiError) {
      return c.json({
        error: err.code.toLowerCase(),
        error_description: err.message,
      }, err.status as 400)
    }
    return c.json({
      error: 'server_error',
      error_description: 'An unexpected error occurred',
    }, 500)
  }
})

// ── GET /userinfo — OIDC UserInfo endpoint ──
oauthRouter.get('/userinfo', authMiddleware, async (c) => {
  const principal = c.get('principal')

  const user = await prisma.user.findUnique({
    where: { id: principal.sub },
    select: {
      id: true,
      email: true,
      username: true,
      displayName: true,
      roles: { include: { role: { select: { name: true } } } },
    },
  })

  if (!user) {
    throw new ApiError(404, 'NOT_FOUND', 'User not found')
  }

  return c.json({
    sub: user.id,
    email: user.email,
    preferred_username: user.username,
    name: user.displayName,
    roles: user.roles.map((r) => r.role.name),
  })
})

// ── GET /.well-known/openid-configuration — OIDC Discovery ──
oauthRouter.get('/.well-known/openid-configuration', (c) => {
  const proto = c.req.header('x-forwarded-proto') ?? 'https'
  const host = c.req.header('x-forwarded-host') ?? c.req.header('host') ?? 'localhost:4200'
  const issuerUrl = `${proto}://${host}`

  c.header('Cache-Control', 'public, max-age=86400')
  return c.json(getOpenIdConfiguration(issuerUrl))
})

// ── GET /jwks — JSON Web Key Set ──
oauthRouter.get('/jwks', async (c) => {
  c.header('Cache-Control', 'public, max-age=3600')
  const jwks = await getJwks()
  return c.json(jwks)
})

// ── Helper: extract client secret from Basic auth header ──
function extractBasicAuthSecret(c: { req: { header: (name: string) => string | undefined } }): string | undefined {
  const authorization = c.req.header('authorization')
  if (!authorization?.startsWith('Basic ')) return undefined

  try {
    const decoded = Buffer.from(authorization.slice(6), 'base64').toString('utf-8')
    const colonIndex = decoded.indexOf(':')
    if (colonIndex === -1) return undefined
    return decoded.slice(colonIndex + 1)
  } catch {
    return undefined
  }
}
