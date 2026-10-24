import { nanoid } from 'nanoid'
import { prisma } from '../db/client.js'
import { env } from '../config/env.js'
import { computeSessionRisk, deriveDeviceFingerprint } from './session-risk-service.js'

export async function createSession(
  userId: string,
  ipAddress?: string,
  userAgent?: string,
): Promise<{ sessionId: string; riskScore: number; riskFactors: string[] }> {
  // Revoke older sessions from the same user + IP + userAgent to prevent
  // duplicate accumulation (e.g. repeated logins from the same browser).
  if (ipAddress && userAgent) {
    const stale = await prisma.session.findMany({
      where: {
        userId,
        ipAddress,
        userAgent,
        revokedAt: null,
      },
      select: { id: true },
    })
    if (stale.length > 0) {
      await prisma.session.updateMany({
        where: { id: { in: stale.map((s) => s.id) } },
        data: { revokedAt: new Date() },
      })
      // Revoke refresh tokens tied to those sessions
      await prisma.refreshToken.updateMany({
        where: { sessionId: { in: stale.map((s) => s.id) }, revokedAt: null },
        data: { revokedAt: new Date() },
      })
    }
  }

  const { score, factors } = await computeSessionRisk({ userId, ipAddress, userAgent })
  const fingerprint = deriveDeviceFingerprint(userAgent, ipAddress)

  const sessionId = nanoid()
  await prisma.session.create({
    data: {
      id: sessionId,
      userId,
      ipAddress,
      userAgent,
      riskScore: score,
      riskFactors: factors.length > 0 ? JSON.stringify(factors) : null,
      deviceFingerprint: fingerprint,
      expiresAt: new Date(Date.now() + env.JWT_REFRESH_TTL * 1000),
    },
  })
  return { sessionId, riskScore: score, riskFactors: factors }
}

export async function revokeSession(sessionId: string, revokedBy?: string): Promise<void> {
  await prisma.session.update({
    where: { id: sessionId },
    data: { revokedAt: new Date(), revokedBy },
  })
  // Also revoke all refresh tokens tied to this session
  await prisma.refreshToken.updateMany({
    where: { sessionId, revokedAt: null },
    data: { revokedAt: new Date() },
  })
}

export async function revokeAllUserSessions(userId: string, revokedBy?: string): Promise<void> {
  const sessions = await prisma.session.findMany({
    where: { userId, revokedAt: null },
    select: { id: true },
  })
  for (const s of sessions) {
    await revokeSession(s.id, revokedBy)
  }
}

export async function listActiveSessions(userId?: string) {
  return prisma.session.findMany({
    where: {
      ...(userId ? { userId } : {}),
      revokedAt: null,
      expiresAt: { gt: new Date() },
    },
    include: { user: { select: { email: true, username: true, displayName: true } } },
    orderBy: { createdAt: 'desc' },
  })
}

/**
 * Revoke duplicate active sessions for the same user + IP + userAgent,
 * keeping only the most recent one per combination.
 */
export async function deduplicateSessions(): Promise<number> {
  const active = await prisma.session.findMany({
    where: { revokedAt: null, expiresAt: { gt: new Date() } },
    orderBy: { createdAt: 'desc' },
  })

  const seen = new Map<string, string>()          // compositeKey → kept sessionId
  const toRevoke: string[] = []

  for (const s of active) {
    const key = `${s.userId}|${s.ipAddress ?? ''}|${s.userAgent ?? ''}`
    if (!seen.has(key)) {
      seen.set(key, s.id)                          // keep newest
    } else {
      toRevoke.push(s.id)                          // duplicate — revoke
    }
  }

  if (toRevoke.length > 0) {
    await prisma.session.updateMany({
      where: { id: { in: toRevoke } },
      data: { revokedAt: new Date() },
    })
    await prisma.refreshToken.updateMany({
      where: { sessionId: { in: toRevoke }, revokedAt: null },
      data: { revokedAt: new Date() },
    })
  }

  return toRevoke.length
}
