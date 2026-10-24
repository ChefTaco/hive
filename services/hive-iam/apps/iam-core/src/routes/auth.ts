import { Hono } from 'hono'
import { getCookie, setCookie, deleteCookie } from 'hono/cookie'
import { SignJWT, jwtVerify } from 'jose'
import { createHash, randomBytes } from 'node:crypto'
import { prisma } from '../db/client.js'
import { authMiddleware } from '../middleware/auth.js'
import { rateLimitMiddleware } from '../middleware/rate-limit.js'
import { verifyPassword, hashPassword } from '../services/password-service.js'
import { issueTokenPair, rotateRefreshToken, revokeRefreshToken, introspectToken } from '../services/token-service.js'
import { createSession, revokeSession } from '../services/session-service.js'
import { logAuditEvent } from '../services/audit-service.js'
import { generateTotpSecret, verifyTotpCode, generateBackupCodes, verifyBackupCode } from '../services/mfa-service.js'
import { getClientIp } from '../utils/ip.js'
import { getPrivateKey, getPublicKeyPem, getPublicKey } from '../utils/keys.js'
import { parseBody } from '../utils/validate.js'
import { LoginSchema, RefreshSchema, ChangePasswordSchema, MfaVerifySchema, MfaChallengeSchema, MfaDisableSchema, ForgotPasswordSchema, ResetPasswordSchema } from '../schemas/auth.js'
import { ApiError } from '../types/index.js'
import { env } from '../config/env.js'
import { checkIpAllowlist } from '../utils/ip-allowlist.js'
import { getDefaultPolicy, isPasswordExpired, validatePasswordPolicy, checkPasswordHistory, recordPasswordHistory } from '../services/password-policy-service.js'
import { eventBus } from '../services/event-bus.js'
import { checkBreachedPassword } from '../services/breach-check-service.js'

import { computeSessionRisk } from '../services/session-risk-service.js'
import { completeStepUp } from '../middleware/step-up.js'

export const authRouter = new Hono()

// POST /login
authRouter.post(
  '/login',
  rateLimitMiddleware({ keyPrefix: 'rl:login' }),
  async (c) => {
    const { username, password } = await parseBody(c, LoginSchema)
    const ip = getClientIp(c)
    const userAgent = c.req.header('user-agent')

    const user = await prisma.user.findFirst({
      where: { OR: [{ username }, { email: username }] },
      include: { roles: { include: { role: true } }, webauthnCredentials: { select: { id: true } } },
    })

    if (!user) {
      await logAuditEvent({
        eventType: 'auth.login.failed',
        category: 'AUTHENTICATION',
        actorType: 'USER',
        ipAddress: ip,
        userAgent,
        action: 'login',
        outcome: 'FAILURE',
        detail: { reason: 'user_not_found', username },
        source: 'iam-api',
      })
      throw new ApiError(401, 'INVALID_CREDENTIALS', 'Invalid username or password')
    }

    // Check lockout
    if (user.lockedUntil && user.lockedUntil > new Date()) {
      throw new ApiError(401, 'INVALID_CREDENTIALS', 'Invalid username or password')
    }

    if (!user.active) {
      throw new ApiError(401, 'INVALID_CREDENTIALS', 'Invalid username or password')
    }

    const valid = await verifyPassword(user.passwordHash, password)
    if (!valid) {
      // Increment failure count
      const attempts = user.failedAttempts + 1
      const lockUpdate =
        attempts >= env.RATE_LIMIT_MAX_ATTEMPTS
          ? {
              failedAttempts: attempts,
              lockedUntil: new Date(Date.now() + env.RATE_LIMIT_WINDOW_MS),
            }
          : { failedAttempts: attempts }

      await prisma.user.update({ where: { id: user.id }, data: lockUpdate })

      // Emit lockout notification when account gets locked
      if (attempts >= env.RATE_LIMIT_MAX_ATTEMPTS) {
        eventBus.publish('auth.lockout', {
          userId: user.id,
          email: user.email,
          username: user.username,
          ipAddress: ip,
          userAgent,
          attempts,
          lockedUntil: new Date(Date.now() + env.RATE_LIMIT_WINDOW_MS).toISOString(),
        }).catch(() => {})
      }

      await logAuditEvent({
        eventType: 'auth.login.failed',
        category: 'AUTHENTICATION',
        actorId: user.id,
        actorType: 'USER',
        actorEmail: user.email,
        ipAddress: ip,
        userAgent,
        action: 'login',
        outcome: 'FAILURE',
        detail: { reason: 'invalid_password', attempts },
        source: 'iam-api',
      })
      throw new ApiError(401, 'INVALID_CREDENTIALS', 'Invalid username or password')
    }

    // Check per-user IP allowlist (after password verified to prevent enumeration)
    const userAllowedIps: string[] = JSON.parse((user.allowedIps as string) || '[]')
    if (!checkIpAllowlist(userAllowedIps, ip)) {
      await logAuditEvent({
        eventType: 'auth.ip_blocked',
        category: 'AUTHENTICATION',
        actorId: user.id,
        actorType: 'USER',
        actorEmail: user.email,
        ipAddress: ip,
        userAgent,
        action: 'login',
        outcome: 'DENIED',
        detail: { reason: 'ip_not_allowed', blockedIp: ip, allowedIps: userAllowedIps },
        source: 'iam-api',
      })
      // Return same error as invalid credentials to prevent IP enumeration
      throw new ApiError(401, 'INVALID_CREDENTIALS', 'Invalid username or password')
    }

    const roles = user.roles.map((r) => r.role.name)
    const permissions: string[] = [...new Set(user.roles.flatMap((r) => {
      const perms = r.role.permissions
      return (typeof perms === 'string' ? JSON.parse(perms) : perms) as string[]
    }))]

    // ── Password expiry check ──
    const policy = await getDefaultPolicy()
    if (isPasswordExpired(user.passwordChangedAt, policy.maxAgeDays)) {
      return c.json({
        passwordExpired: true,
        message: 'Your password has expired and must be changed',
        userId: user.id,
      }, 403)
    }

    // ── MFA check: if enabled, return mfaToken instead of access tokens ──
    if (user.mfaEnabled && (user.mfaSecret || user.webauthnCredentials.length > 0)) {
      const privateKey = await getPrivateKey()
      const mfaToken = await new SignJWT({
        purpose: 'mfa_challenge',
        email: user.email,
        username: user.username,
      })
        .setProtectedHeader({ alg: 'RS256' })
        .setSubject(user.id)
        .setIssuer(env.JWT_ISSUER)
        .setIssuedAt()
        .setExpirationTime('5m') // 5-minute window to complete MFA
        .sign(privateKey)

      await logAuditEvent({
        eventType: 'auth.mfa_required',
        category: 'AUTHENTICATION',
        actorId: user.id,
        actorType: 'USER',
        actorEmail: user.email,
        ipAddress: ip,
        userAgent,
        action: 'login',
        outcome: 'SUCCESS',
        detail: { step: 'mfa_challenge' },
        source: 'iam-api',
      })

      return c.json({
        requiresMfa: true,
        mfaToken,
        methods: [
          ...(user.mfaSecret ? ['totp'] : []),
          ...(user.webauthnCredentials.length > 0 ? ['webauthn'] : []),
        ],
      })
    }

    await prisma.user.update({
      where: { id: user.id },
      data: { failedAttempts: 0, lockedUntil: null, lastLoginAt: new Date(), lastLoginIp: ip },
    })
    const { sessionId, riskScore, riskFactors } = await createSession(user.id, ip, userAgent)
    const tokenPair = await issueTokenPair(user.id, user.email, user.username, roles, permissions, sessionId, ip, undefined, userAgent)

    // Set refresh token as httpOnly cookie
    setCookie(c, 'iam_refresh', tokenPair.refreshToken, {
      httpOnly: true,
      secure: true,
      sameSite: 'Lax',
      maxAge: env.JWT_REFRESH_TTL,
      path: '/api/v1/auth',
    })

    await logAuditEvent({
      eventType: 'auth.login',
      category: 'AUTHENTICATION',
      actorId: user.id,
      actorType: 'USER',
      actorEmail: user.email,
      ipAddress: ip,
      userAgent,
      action: 'login',
      outcome: 'SUCCESS',
      detail: riskScore > 0 ? { riskScore, riskFactors } : undefined,
      source: 'iam-api',
    })

    return c.json({
      accessToken: tokenPair.accessToken,
      refreshToken: tokenPair.refreshToken,
      expiresIn: tokenPair.expiresIn,
      sessionId,
      riskScore,
      riskFactors,
      user: {
        id: user.id,
        email: user.email,
        username: user.username,
        displayName: user.displayName,
        roles,
        permissions,
      },
    })
  },
)

// POST /logout
authRouter.post('/logout', authMiddleware, async (c) => {
  const principal = c.get('principal')
  const refreshToken = getCookie(c, 'iam_refresh')

  if (principal.sessionId) {
    await revokeSession(principal.sessionId, principal.sub)
  }
  if (refreshToken) {
    await revokeRefreshToken(refreshToken)
  }
  deleteCookie(c, 'iam_refresh', { path: '/api/v1/auth' })

  await logAuditEvent({
    eventType: 'auth.logout',
    category: 'AUTHENTICATION',
    actorId: principal.sub,
    actorType: principal.actorType,
    actorEmail: principal.email,
    ipAddress: getClientIp(c),
    action: 'logout',
    outcome: 'SUCCESS',
    source: 'iam-api',
  })

  return c.json({ success: true })
})

// POST /refresh
authRouter.post('/refresh', async (c) => {
  const cookie = getCookie(c, 'iam_refresh')
  let rawToken: string | undefined

  if (cookie) {
    rawToken = cookie
  } else {
    try {
      const body = await parseBody(c, RefreshSchema)
      rawToken = body.refreshToken
    } catch {
      throw new ApiError(400, 'MISSING_REFRESH_TOKEN', 'Refresh token required')
    }
  }

  if (!rawToken) throw new ApiError(400, 'MISSING_REFRESH_TOKEN', 'Refresh token required')

  const ip = getClientIp(c)
  const userAgent = c.req.header('user-agent')
  const tokenPair = await rotateRefreshToken(rawToken, ip, undefined, userAgent)

  setCookie(c, 'iam_refresh', tokenPair.refreshToken, {
    httpOnly: true,
    secure: true,
    sameSite: 'Lax',
    maxAge: env.JWT_REFRESH_TTL,
    path: '/api/v1/auth',
  })

  return c.json({
    accessToken: tokenPair.accessToken,
    refreshToken: tokenPair.refreshToken,
    expiresIn: tokenPair.expiresIn,
    sessionId: tokenPair.sessionId,
  })
})

// GET /me
authRouter.get('/me', authMiddleware, async (c) => {
  const principal = c.get('principal')
  const user = await prisma.user.findUnique({
    where: { id: principal.sub },
    select: {
      id: true,
      email: true,
      username: true,
      displayName: true,
      active: true,
      lastLoginAt: true,
      roles: { include: { role: { select: { name: true, label: true, permissions: true } } } },
    },
  })
  if (!user) throw new ApiError(404, 'NOT_FOUND', 'User not found')
  return c.json({ user })
})

// POST /password
authRouter.post('/password', authMiddleware, async (c) => {
  const principal = c.get('principal')
  const { currentPassword, newPassword } = await parseBody(c, ChangePasswordSchema)

  const user = await prisma.user.findUnique({ where: { id: principal.sub } })
  if (!user) throw new ApiError(404, 'NOT_FOUND', 'User not found')

  const valid = await verifyPassword(user.passwordHash, currentPassword)
  if (!valid) throw new ApiError(401, 'INVALID_CREDENTIALS', 'Current password is incorrect')

  // Validate against password policy
  const policy = await getDefaultPolicy()
  const policyErrors = validatePasswordPolicy(newPassword, policy)
  if (policyErrors.length > 0) {
    throw new ApiError(400, 'PASSWORD_POLICY_VIOLATION', policyErrors.join('; '))
  }

  // Check against known breached passwords (non-blocking on network failure)
  const breachCount = await checkBreachedPassword(newPassword)
  if (breachCount > 0) {
    throw new ApiError(400, 'PASSWORD_BREACHED', `This password has appeared in ${breachCount} known data breach(es). Please choose a different password.`)
  }

  // Check password history (prevent reuse)
  const wasUsed = await checkPasswordHistory(user.id, newPassword, policy.historyCount)
  if (wasUsed) {
    throw new ApiError(400, 'PASSWORD_REUSED', `Cannot reuse any of your last ${policy.historyCount} passwords`)
  }

  const newHash = await hashPassword(newPassword)

  // Record in password history before updating
  await recordPasswordHistory(user.id, newHash)

  await prisma.user.update({
    where: { id: user.id },
    data: { passwordHash: newHash, encryptedPassword: null, passwordChangedAt: new Date() },
  })

  // Revoke all other sessions after password change
  if (principal.sessionId) {
    const otherSessions = await prisma.session.findMany({
      where: { userId: user.id, revokedAt: null, id: { not: principal.sessionId } },
      select: { id: true },
    })
    for (const s of otherSessions) {
      await revokeSession(s.id, principal.sub)
    }
  }

  await logAuditEvent({
    eventType: 'auth.password_changed',
    category: 'AUTHENTICATION',
    actorId: principal.sub,
    actorType: principal.actorType,
    actorEmail: principal.email,
    ipAddress: getClientIp(c),
    action: 'password_change',
    outcome: 'SUCCESS',
    source: 'iam-api',
  })

  return c.json({ success: true })
})

// GET /public-key — public RS256 key for JWT verification
authRouter.get('/public-key', async (c) => {
  const pem = await getPublicKeyPem()
  c.header('Content-Type', 'application/x-pem-file')
  c.header('Cache-Control', 'public, max-age=3600')
  return c.text(pem)
})

// ── MFA Setup: generate TOTP secret + QR code ──
authRouter.post('/mfa/setup', authMiddleware, async (c) => {
  const principal = c.get('principal')
  const user = await prisma.user.findUnique({ where: { id: principal.sub } })
  if (!user) throw new ApiError(404, 'NOT_FOUND', 'User not found')

  if (user.mfaEnabled) {
    throw new ApiError(409, 'MFA_ALREADY_ENABLED', 'MFA is already enabled. Disable it first to re-setup.')
  }

  const result = await generateTotpSecret(user.email)

  // Store the secret (not yet enabled — user must verify first)
  await prisma.user.update({
    where: { id: user.id },
    data: { mfaSecret: result.secret },
  })

  await logAuditEvent({
    eventType: 'auth.mfa_setup',
    category: 'AUTHENTICATION',
    actorId: principal.sub,
    actorType: 'USER',
    actorEmail: user.email,
    ipAddress: getClientIp(c),
    action: 'mfa_setup',
    outcome: 'SUCCESS',
    source: 'iam-api',
  })

  return c.json({
    secret: result.secret,
    qrUri: result.uri,
    qrDataUrl: result.qrDataUrl,
  })
})

// ── MFA Verify: confirm TOTP code to enable MFA ──
authRouter.post('/mfa/verify', authMiddleware, async (c) => {
  const principal = c.get('principal')
  const { code } = await parseBody(c, MfaVerifySchema)

  const user = await prisma.user.findUnique({ where: { id: principal.sub } })
  if (!user) throw new ApiError(404, 'NOT_FOUND', 'User not found')

  if (!user.mfaSecret) {
    throw new ApiError(400, 'MFA_NOT_SETUP', 'Call POST /auth/mfa/setup first')
  }

  if (user.mfaEnabled) {
    throw new ApiError(409, 'MFA_ALREADY_ENABLED', 'MFA is already enabled')
  }

  if (!verifyTotpCode(user.mfaSecret, code)) {
    throw new ApiError(401, 'INVALID_MFA_CODE', 'Invalid TOTP code')
  }

  // Generate backup codes
  const { plaintextCodes, hashedCodes } = await generateBackupCodes()

  await prisma.user.update({
    where: { id: user.id },
    data: {
      mfaEnabled: true,
      mfaVerifiedAt: new Date(),
      mfaBackupCodes: JSON.stringify(hashedCodes),
    },
  })

  await logAuditEvent({
    eventType: 'auth.mfa_enabled',
    category: 'AUTHENTICATION',
    actorId: principal.sub,
    actorType: 'USER',
    actorEmail: user.email,
    ipAddress: getClientIp(c),
    action: 'mfa_enable',
    outcome: 'SUCCESS',
    source: 'iam-api',
  })

  return c.json({
    success: true,
    backupCodes: plaintextCodes,
    message: 'MFA enabled successfully. Save your backup codes in a safe place — they will not be shown again.',
  })
})

// ── MFA Disable: require password + TOTP code ──
authRouter.post('/mfa/disable', authMiddleware, async (c) => {
  const principal = c.get('principal')
  const { password, code } = await parseBody(c, MfaDisableSchema)

  const user = await prisma.user.findUnique({ where: { id: principal.sub } })
  if (!user) throw new ApiError(404, 'NOT_FOUND', 'User not found')

  if (!user.mfaEnabled) {
    throw new ApiError(400, 'MFA_NOT_ENABLED', 'MFA is not enabled')
  }

  const validPassword = await verifyPassword(user.passwordHash, password)
  if (!validPassword) {
    throw new ApiError(401, 'INVALID_CREDENTIALS', 'Invalid password')
  }

  if (!user.mfaSecret || !verifyTotpCode(user.mfaSecret, code)) {
    throw new ApiError(401, 'INVALID_MFA_CODE', 'Invalid TOTP code')
  }

  await prisma.user.update({
    where: { id: user.id },
    data: {
      mfaEnabled: false,
      mfaSecret: null,
      mfaBackupCodes: null,
      mfaVerifiedAt: null,
    },
  })

  await logAuditEvent({
    eventType: 'auth.mfa_disabled',
    category: 'AUTHENTICATION',
    actorId: principal.sub,
    actorType: 'USER',
    actorEmail: user.email,
    ipAddress: getClientIp(c),
    action: 'mfa_disable',
    outcome: 'SUCCESS',
    source: 'iam-api',
  })

  return c.json({ success: true, message: 'MFA has been disabled' })
})

// ── MFA Challenge: complete login with TOTP code after password ──
authRouter.post('/mfa/challenge', rateLimitMiddleware({ keyPrefix: 'rl:mfa', max: 5, windowMs: 300_000 }), async (c) => {
  const { mfaToken, code } = await parseBody(c, MfaChallengeSchema)
  const ip = getClientIp(c)
  const userAgent = c.req.header('user-agent')

  // Verify the short-lived MFA token
  let userId: string
  try {
    const publicKey = await getPublicKey()
    const { payload } = await jwtVerify(mfaToken, publicKey, { issuer: env.JWT_ISSUER })
    if ((payload as Record<string, unknown>).purpose !== 'mfa_challenge') {
      throw new Error('Not an MFA token')
    }
    if (typeof payload.sub !== 'string' || !payload.sub) throw new Error('Missing MFA subject')
    userId = payload.sub
  } catch {
    throw new ApiError(401, 'INVALID_MFA_TOKEN', 'MFA token is invalid or expired')
  }

  const user = await prisma.user.findUnique({
    where: { id: userId },
    include: { roles: { include: { role: true } } },
  })

  if (!user || !user.active || !user.mfaEnabled || !user.mfaSecret || (user.lockedUntil && user.lockedUntil > new Date())) {
    throw new ApiError(401, 'INVALID_CREDENTIALS', 'Invalid credentials')
  }

  // Try TOTP first, then backup codes
  let usedBackupCode = false
  if (code.length === 6 && verifyTotpCode(user.mfaSecret, code)) {
    // TOTP verified
  } else {
    // Try backup codes
    const backupCodes: string[] = JSON.parse(user.mfaBackupCodes || '[]')
    const matchIdx = await verifyBackupCode(code, backupCodes)
    if (matchIdx === -1) {
      const attempts = user.failedAttempts + 1
      await prisma.user.update({
        where: { id: userId },
        data: {
          failedAttempts: attempts,
          ...(attempts >= env.RATE_LIMIT_MAX_ATTEMPTS ? { lockedUntil: new Date(Date.now() + env.RATE_LIMIT_WINDOW_MS) } : {}),
        },
      })
      await logAuditEvent({
        eventType: 'auth.mfa_challenge.failed',
        category: 'AUTHENTICATION',
        actorId: userId,
        actorType: 'USER',
        actorEmail: user.email,
        ipAddress: ip,
        userAgent,
        action: 'mfa_challenge',
        outcome: 'FAILURE',
        detail: { reason: 'invalid_code' },
        source: 'iam-api',
      })
      throw new ApiError(401, 'INVALID_MFA_CODE', 'Invalid TOTP or backup code')
    }
    // Consume the backup code
    backupCodes[matchIdx] = '' // Mark as used
    await prisma.user.update({
      where: { id: userId },
      data: { mfaBackupCodes: JSON.stringify(backupCodes) },
    })
    usedBackupCode = true
  }

  const roles = user.roles.map((r) => r.role.name)
  const permissions: string[] = [...new Set(user.roles.flatMap((r) => {
    const perms = r.role.permissions
    return (typeof perms === 'string' ? JSON.parse(perms) : perms) as string[]
  }))]

  const { sessionId, riskScore, riskFactors } = await createSession(userId, ip, userAgent)
  await prisma.user.update({ where: { id: userId }, data: { failedAttempts: 0, lockedUntil: null, lastLoginAt: new Date(), lastLoginIp: ip } })
  const tokenPair = await issueTokenPair(userId, user.email, user.username, roles, permissions, sessionId, ip, undefined, userAgent)

  setCookie(c, 'iam_refresh', tokenPair.refreshToken, {
    httpOnly: true,
    secure: true,
    sameSite: 'Lax',
    maxAge: env.JWT_REFRESH_TTL,
    path: '/api/v1/auth',
  })

  await logAuditEvent({
    eventType: 'auth.mfa_challenge',
    category: 'AUTHENTICATION',
    actorId: userId,
    actorType: 'USER',
    actorEmail: user.email,
    ipAddress: ip,
    userAgent,
    action: 'mfa_challenge',
    outcome: 'SUCCESS',
    detail: { usedBackupCode, riskScore, riskFactors },
    source: 'iam-api',
  })

  return c.json({
    accessToken: tokenPair.accessToken,
    refreshToken: tokenPair.refreshToken,
    expiresIn: tokenPair.expiresIn,
    sessionId,
    riskScore,
    riskFactors,
    user: {
      id: user.id,
      email: user.email,
      username: user.username,
      displayName: user.displayName,
      roles,
      permissions,
    },
    ...(usedBackupCode ? { warning: 'You used a backup code. Consider generating new backup codes.' } : {}),
  })
})

// ── POST /forgot-password ──
// Always returns 200 to prevent email enumeration
authRouter.post(
  '/forgot-password',
  rateLimitMiddleware({ keyPrefix: 'rl:forgot', max: 5, windowMs: 300_000 }),
  async (c) => {
    const { email } = await parseBody(c, ForgotPasswordSchema)
    const ip = getClientIp(c)

    const user = await prisma.user.findUnique({ where: { email } })

    if (user && user.active) {
      // Generate a secure random token
      const token = randomBytes(32).toString('hex')
      const tokenHash = createHash('sha256').update(token).digest('hex')
      const expiresAt = new Date(Date.now() + 60 * 60 * 1000) // 1 hour

      // Invalidate any existing unused tokens for this user
      await prisma.passwordResetToken.updateMany({
        where: { userId: user.id, usedAt: null },
        data: { usedAt: new Date() },
      })

      // Create new token
      await prisma.passwordResetToken.create({
        data: { userId: user.id, tokenHash, expiresAt },
      })

      // Deliver the raw token through an out-of-band notification provider.
      // Logs and audit events intentionally contain only the request identifier.

      await logAuditEvent({
        eventType: 'auth.password_reset_requested',
        category: 'AUTHENTICATION',
        actorId: user.id,
        actorType: 'USER',
        actorEmail: user.email,
        ipAddress: ip,
        action: 'password_reset_request',
        outcome: 'SUCCESS',
        source: 'iam-api',
      })
    }

    // Always return success to prevent enumeration
    return c.json({ message: 'If a matching account exists, a password reset link has been sent.' })
  },
)

// ── POST /reset-password ──
authRouter.post(
  '/reset-password',
  rateLimitMiddleware({ keyPrefix: 'rl:reset', max: 10, windowMs: 300_000 }),
  async (c) => {
    const { token, newPassword } = await parseBody(c, ResetPasswordSchema)
    const ip = getClientIp(c)

    const tokenHash = createHash('sha256').update(token).digest('hex')

    const resetToken = await prisma.passwordResetToken.findFirst({
      where: {
        tokenHash,
        usedAt: null,
        expiresAt: { gt: new Date() },
      },
      include: { user: true },
    })

    if (!resetToken) {
      throw new ApiError(400, 'VALIDATION_ERROR', 'Invalid or expired reset token')
    }

    // Validate password against policy
    const policy = await getDefaultPolicy()
    if (policy) {
      const violations = validatePasswordPolicy(newPassword, policy)
      if (violations.length > 0) {
        throw new ApiError(400, 'VALIDATION_ERROR', violations.join('; '))
      }

      // Check against known breached passwords
      const breachCount = await checkBreachedPassword(newPassword)
      if (breachCount > 0) {
        throw new ApiError(400, 'PASSWORD_BREACHED', `This password has appeared in ${breachCount} known data breach(es). Please choose a different password.`)
      }

      // Check password history
      const reused = await checkPasswordHistory(resetToken.userId, newPassword, policy.historyCount)
      if (reused) {
        throw new ApiError(400, 'VALIDATION_ERROR', `Cannot reuse one of your last ${policy.historyCount} passwords`)
      }
    }

    // Hash the new password
    const passwordHash = await hashPassword(newPassword)

    // Update user password, mark token as used, and revoke all sessions
    await prisma.$transaction([
      prisma.user.update({
        where: { id: resetToken.userId },
        data: {
          passwordHash,
          encryptedPassword: null,
          passwordChangedAt: new Date(),
          failedAttempts: 0,
          lockedUntil: null,
        },
      }),
      prisma.passwordResetToken.update({
        where: { id: resetToken.id },
        data: { usedAt: new Date() },
      }),
      // Revoke all active sessions (security: password was compromised or forgotten)
      prisma.session.updateMany({
        where: { userId: resetToken.userId, revokedAt: null },
        data: { revokedAt: new Date(), revokedBy: 'password_reset' },
      }),
    ])

    // Record in password history
    if (policy) {
      await recordPasswordHistory(resetToken.userId, passwordHash)
    }

    await logAuditEvent({
      eventType: 'auth.password_reset_completed',
      category: 'AUTHENTICATION',
      actorId: resetToken.userId,
      actorType: 'USER',
      actorEmail: resetToken.user.email,
      ipAddress: ip,
      action: 'password_reset_complete',
      outcome: 'SUCCESS',
      source: 'iam-api',
    })

    return c.json({ message: 'Password has been reset. Please log in with your new password.' })
  },
)

// ── POST /step-up ──
// Re-authenticate to satisfy step-up requirements on high-risk sessions.
authRouter.post('/step-up', authMiddleware, async (c) => {
  const principal = c.get('principal')
  const body = await c.req.json() as { password?: string; totpCode?: string }
  const ip = getClientIp(c)

  if (!principal.sessionId) {
    throw new ApiError(403, 'FORBIDDEN', 'Session context required')
  }

  const user = await prisma.user.findUnique({
    where: { id: principal.sub },
    select: { id: true, email: true, passwordHash: true, mfaEnabled: true, mfaSecret: true },
  })

  if (!user) {
    throw new ApiError(403, 'FORBIDDEN', 'User not found')
  }

  // Verify password
  if (!body.password) {
    throw new ApiError(400, 'VALIDATION_ERROR', 'Password is required for step-up verification')
  }

  const passwordValid = await verifyPassword(user.passwordHash, body.password)
  if (!passwordValid) {
    await logAuditEvent({
      eventType: 'auth.step_up_failed',
      category: 'AUTHENTICATION',
      actorId: user.id,
      actorType: 'USER',
      actorEmail: user.email,
      ipAddress: ip,
      action: 'step_up_failed',
      outcome: 'FAILURE',
      source: 'iam-api',
      detail: { reason: 'Invalid password' },
    })
    throw new ApiError(401, 'INVALID_CREDENTIALS', 'Invalid credentials')
  }

  // If MFA is enabled, also verify TOTP
  if (user.mfaEnabled && user.mfaSecret) {
    if (!body.totpCode) {
      return c.json({ error: 'MFA_REQUIRED', message: 'TOTP code required for step-up' }, 403)
    }
    const mfaValid = verifyTotpCode(user.mfaSecret, body.totpCode)
    if (!mfaValid) {
      await logAuditEvent({
        eventType: 'auth.step_up_failed',
        category: 'AUTHENTICATION',
        actorId: user.id,
        actorType: 'USER',
        actorEmail: user.email,
        ipAddress: ip,
        action: 'step_up_failed',
        outcome: 'FAILURE',
        source: 'iam-api',
        detail: { reason: 'Invalid TOTP code' },
      })
      throw new ApiError(401, 'INVALID_CREDENTIALS', 'Invalid MFA code')
    }
  }

  // Mark session as step-up verified
  await completeStepUp(principal.sessionId)

  await logAuditEvent({
    eventType: 'auth.step_up_verified',
    category: 'AUTHENTICATION',
    actorId: user.id,
    actorType: 'USER',
    actorEmail: user.email,
    ipAddress: ip,
    action: 'step_up_verified',
    outcome: 'SUCCESS',
    source: 'iam-api',
  })

  return c.json({ success: true, message: 'Step-up authentication verified' })
})

// ── GET /session-risk ──
// Get current session risk score and factors.
authRouter.get('/session-risk', authMiddleware, async (c) => {
  const principal = c.get('principal')

  if (!principal.sessionId) {
    return c.json({ riskScore: 0, riskFactors: [], stepUpRequired: false })
  }

  const session = await prisma.session.findUnique({
    where: { id: principal.sessionId },
    select: { riskScore: true, riskFactors: true, stepUpVerifiedAt: true },
  })

  if (!session) {
    return c.json({ riskScore: 0, riskFactors: [], stepUpRequired: false })
  }

  const stepUpValidMs = 15 * 60 * 1000
  const stepUpExpired = !session.stepUpVerifiedAt ||
    (Date.now() - new Date(session.stepUpVerifiedAt).getTime()) > stepUpValidMs

  return c.json({
    riskScore: session.riskScore,
    riskFactors: session.riskFactors ? JSON.parse(session.riskFactors) : [],
    stepUpRequired: session.riskScore >= 0.5 && stepUpExpired,
    stepUpVerifiedAt: session.stepUpVerifiedAt,
  })
})
