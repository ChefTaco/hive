/**
 * WebAuthn/FIDO2 MFA routes.
 *
 * Registration: GET /options → POST /register
 * Authentication: GET /authenticate-options → POST /authenticate
 *
 * All routes require a valid Bearer JWT (except /authenticate which
 * accepts an mfaToken for the login-time challenge flow).
 */

import { Hono } from 'hono';
import { z } from 'zod';
import { nanoid } from 'nanoid';
import { jwtVerify } from 'jose';
import { setCookie } from 'hono/cookie';
import { ApiError, type Principal } from '../types/index.js';
import { prisma } from '../db/client.js';
import { authMiddleware } from '../middleware/auth.js';
import { rateLimitMiddleware } from '../middleware/rate-limit.js';
import { env } from '../config/env.js';
import { getPublicKey } from '../utils/keys.js';
import { getClientIp } from '../utils/ip.js';
import { createSession } from '../services/session-service.js';
import { issueTokenPair } from '../services/token-service.js';
import { logAuditEvent } from '../services/audit-service.js';
import {
  getRegistrationOptions,
  verifyRegistration,
  getAuthenticationOptions,
  verifyAuthentication,
} from '../services/webauthn-service.js';

export const webauthnRouter = new Hono();

const RegisterBodySchema = z.object({
  response: z.record(z.string(), z.unknown()),
  friendlyName: z.string().max(100).default(''),
});

const AuthenticationBodySchema = z.object({
  mfaToken: z.string().min(1).max(8192),
  response: z.record(z.string(), z.unknown()),
});

async function userIdFromMfaToken(token: string): Promise<string> {
  try {
    const publicKey = await getPublicKey();
    const { payload } = await jwtVerify(token, publicKey, { issuer: env.JWT_ISSUER });
    if (payload.purpose !== 'mfa_challenge' || typeof payload.sub !== 'string' || !payload.sub) throw new Error('Invalid MFA challenge');
    return payload.sub;
  } catch {
    throw new ApiError(401, 'INVALID_MFA_TOKEN', 'MFA token is invalid or expired');
  }
}

// ── Registration ──

/** Get registration options (challenge). */
webauthnRouter.get('/options', authMiddleware, async (c) => {
  const principal = c.get('principal') as unknown as Principal | undefined;
  if (!principal) throw new ApiError(401, 'UNAUTHORIZED', 'Authentication required');


  const user = await prisma.user.findUnique({
    where: { id: principal.sub },
    select: { id: true, email: true, username: true },
  });
  if (!user) throw new ApiError(404, 'NOT_FOUND', 'User not found');

  const existing = await prisma.webAuthnCredential.findMany({
    where: { userId: user.id },
    select: { credentialId: true, publicKey: true, counter: true, transports: true },
  });

  const creds = existing.map((c) => ({
    credentialId: c.credentialId,
    publicKey: c.publicKey,
    counter: c.counter,
    transports: JSON.parse(c.transports) as string[],
  }));

  const options = await getRegistrationOptions(user.id, user.email, user.username, creds, principal.sessionId ?? principal.sub);
  return c.json({ success: true, data: options });
});

/** Complete registration (verify attestation). */
webauthnRouter.post('/register', authMiddleware, async (c) => {
  const principal = c.get('principal') as unknown as Principal | undefined;
  if (!principal) throw new ApiError(401, 'UNAUTHORIZED', 'Authentication required');

  const body = RegisterBodySchema.parse(await c.req.json());

  const verification = await verifyRegistration(principal.sub, body.response, principal.sessionId ?? principal.sub);
  if (!verification.verified || !verification.registrationInfo) {
    throw new ApiError(400, 'VALIDATION_ERROR', 'WebAuthn registration verification failed');
  }

  const { credential, credentialDeviceType, credentialBackedUp } = verification.registrationInfo;


  await prisma.webAuthnCredential.create({
    data: {
      id: nanoid(),
      userId: principal.sub,
      credentialId: Buffer.from(credential.id).toString('base64url'),
      publicKey: Buffer.from(credential.publicKey).toString('base64url'),
      counter: credential.counter,
      deviceType: credentialDeviceType,
      backedUp: credentialBackedUp,
      transports: JSON.stringify(credential.transports ?? []),
      friendlyName: body.friendlyName,
    },
  });

  // Enable MFA on the user if not already
  await prisma.user.update({
    where: { id: principal.sub },
    data: { mfaEnabled: true },
  });

  return c.json({ success: true, message: 'WebAuthn credential registered' });
});

// ── Authentication ──

/** Get authentication options (challenge). */
webauthnRouter.get('/authenticate-options', rateLimitMiddleware({ keyPrefix: 'rl:webauthn-options', max: 10, windowMs: 300_000 }), async (c) => {
  const mfaToken = c.req.query('mfaToken');
  if (!mfaToken) throw new ApiError(400, 'VALIDATION_ERROR', 'mfaToken query parameter required');
  const userId = await userIdFromMfaToken(mfaToken);


  const existing = await prisma.webAuthnCredential.findMany({
    where: { userId },
    select: { credentialId: true, publicKey: true, counter: true, transports: true },
  });

  if (existing.length === 0) {
    throw new ApiError(404, 'NOT_FOUND', 'No WebAuthn credentials found for this user');
  }

  const creds = existing.map((c) => ({
    credentialId: c.credentialId,
    publicKey: c.publicKey,
    counter: c.counter,
    transports: JSON.parse(c.transports) as string[],
  }));

  const options = await getAuthenticationOptions(userId, creds, mfaToken);
  return c.json({ success: true, data: options });
});

/** Verify authentication assertion. */
webauthnRouter.post('/authenticate', rateLimitMiddleware({ keyPrefix: 'rl:webauthn-auth', max: 5, windowMs: 300_000 }), async (c) => {
  const body = AuthenticationBodySchema.parse(await c.req.json());
  const userId = await userIdFromMfaToken(body.mfaToken);

  const challengeUser = await prisma.user.findUnique({
    where: { id: userId },
    select: { active: true, mfaEnabled: true, lockedUntil: true },
  });
  if (!challengeUser?.active || !challengeUser.mfaEnabled || (challengeUser.lockedUntil && challengeUser.lockedUntil > new Date())) {
    throw new ApiError(401, 'INVALID_CREDENTIALS', 'Invalid credentials');
  }


  const credentialIdFromResponse = (body.response as { id?: string }).id;
  if (!credentialIdFromResponse) {
    throw new ApiError(400, 'VALIDATION_ERROR', 'Missing credential ID in response');
  }

  const stored = await prisma.webAuthnCredential.findUnique({
    where: { credentialId: credentialIdFromResponse },
  });

  if (!stored || stored.userId !== userId) {
    throw new ApiError(400, 'VALIDATION_ERROR', 'Unknown credential');
  }

  const credential = {
    credentialId: stored.credentialId,
    publicKey: stored.publicKey,
    counter: stored.counter,
    transports: JSON.parse(stored.transports) as string[],
  };

  const verification = await verifyAuthentication(userId, body.response, credential, body.mfaToken);
  if (!verification.verified) {
    throw new ApiError(400, 'VALIDATION_ERROR', 'WebAuthn authentication failed');
  }

  // Update counter for clone detection
  await prisma.webAuthnCredential.update({
    where: { id: stored.id },
    data: {
      counter: verification.authenticationInfo.newCounter,
      lastUsedAt: new Date(),
    },
  });

  const user = await prisma.user.findUnique({
    where: { id: userId },
    include: { roles: { include: { role: true } } },
  });
  if (!user || !user.active || !user.mfaEnabled) throw new ApiError(401, 'INVALID_CREDENTIALS', 'Invalid credentials');
  const roles = user.roles.map((assignment) => assignment.role.name);
  const permissions = [...new Set(user.roles.flatMap((assignment) => {
    const value = assignment.role.permissions;
    return (typeof value === 'string' ? JSON.parse(value) : value) as string[];
  }))];
  const ip = getClientIp(c);
  const userAgent = c.req.header('user-agent');
  const { sessionId, riskScore, riskFactors } = await createSession(userId, ip, userAgent);
  const tokenPair = await issueTokenPair(userId, user.email, user.username, roles, permissions, sessionId, ip, undefined, userAgent);
  await prisma.user.update({ where: { id: userId }, data: { failedAttempts: 0, lockedUntil: null, lastLoginAt: new Date(), lastLoginIp: ip } });
  setCookie(c, 'iam_refresh', tokenPair.refreshToken, {
    httpOnly: true,
    secure: true,
    sameSite: 'Lax',
    maxAge: env.JWT_REFRESH_TTL,
    path: '/api/v1/auth',
  });
  await logAuditEvent({
    eventType: 'auth.webauthn_challenge',
    category: 'AUTHENTICATION',
    actorId: userId,
    actorType: 'USER',
    actorEmail: user.email,
    ipAddress: ip,
    userAgent,
    action: 'webauthn_challenge',
    outcome: 'SUCCESS',
    source: 'iam-api',
  });
  return c.json({
    success: true,
    verified: true,
    accessToken: tokenPair.accessToken,
    refreshToken: tokenPair.refreshToken,
    expiresIn: tokenPair.expiresIn,
    sessionId,
    riskScore,
    riskFactors,
    user: { id: user.id, email: user.email, username: user.username, displayName: user.displayName, roles, permissions },
  });
});

// ── Management ──

/** List user's registered WebAuthn credentials. */
webauthnRouter.get('/credentials', authMiddleware, async (c) => {
  const principal = c.get('principal') as unknown as Principal | undefined;
  if (!principal) throw new ApiError(401, 'UNAUTHORIZED', 'Authentication required');


  const credentials = await prisma.webAuthnCredential.findMany({
    where: { userId: principal.sub },
    select: {
      id: true,
      credentialId: true,
      deviceType: true,
      backedUp: true,
      friendlyName: true,
      lastUsedAt: true,
      createdAt: true,
    },
    orderBy: { createdAt: 'desc' },
  });

  return c.json({ success: true, data: credentials });
});

/** Delete a WebAuthn credential. */
webauthnRouter.delete('/credentials/:id', authMiddleware, async (c) => {
  const principal = c.get('principal') as unknown as Principal | undefined;
  if (!principal) throw new ApiError(401, 'UNAUTHORIZED', 'Authentication required');


  const credential = await prisma.webAuthnCredential.findUnique({
    where: { id: c.req.param('id') },
  });

  if (!credential || credential.userId !== principal.sub) {
    throw new ApiError(404, 'NOT_FOUND', 'Credential not found');
  }

  await prisma.webAuthnCredential.delete({ where: { id: credential.id } });

  // Check if user still has any MFA methods
  const remaining = await prisma.webAuthnCredential.count({ where: { userId: principal.sub } });
  const user = await prisma.user.findUnique({
    where: { id: principal.sub },
    select: { mfaSecret: true },
  });

  if (remaining === 0 && !user?.mfaSecret) {
    await prisma.user.update({
      where: { id: principal.sub },
      data: { mfaEnabled: false },
    });
  }

  return c.json({ success: true, message: 'Credential deleted' });
});
