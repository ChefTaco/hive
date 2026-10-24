import { prisma } from '../db/client.js'
import { createHash } from 'node:crypto'

interface RiskInput {
  userId: string
  ipAddress?: string
  userAgent?: string
  deviceFingerprint?: string
}

interface RiskResult {
  score: number       // 0.0 (safe) – 1.0 (critical)
  factors: string[]   // Human-readable risk reasons
}

/**
 * Compute a session risk score based on login context.
 *
 * Factors:
 *  - New IP address (not seen in recent sessions)
 *  - Unusual time-of-day (login outside 06:00-22:00 local)
 *  - New user-agent (not seen before)
 *  - Multiple active sessions from different IPs
 *  - Rapid IP change (different IP within last 10 min)
 */
export async function computeSessionRisk(input: RiskInput): Promise<RiskResult> {
  const factors: string[] = []
  let score = 0

  const since = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000) // 90 days
  const recentSessions = await prisma.session.findMany({
    where: { userId: input.userId, createdAt: { gte: since } },
    select: { ipAddress: true, userAgent: true, createdAt: true },
    orderBy: { createdAt: 'desc' },
    take: 50,
  })

  // ── Factor 1: New IP address ──
  if (input.ipAddress) {
    const knownIps = new Set(recentSessions.map((s) => s.ipAddress).filter(Boolean))
    if (knownIps.size > 0 && !knownIps.has(input.ipAddress)) {
      factors.push('new_ip_address')
      score += 0.3
    }
  }

  // ── Factor 2: Unusual time of day (outside 06:00–22:00 UTC) ──
  const hour = new Date().getUTCHours()
  if (hour < 6 || hour >= 22) {
    factors.push('unusual_time_of_day')
    score += 0.1
  }

  // ── Factor 3: New user-agent ──
  if (input.userAgent) {
    const knownAgents = new Set(recentSessions.map((s) => s.userAgent).filter(Boolean))
    if (knownAgents.size > 0 && !knownAgents.has(input.userAgent)) {
      factors.push('new_user_agent')
      score += 0.2
    }
  }

  // ── Factor 4: Concurrent sessions from different IPs ──
  const activeSessions = await prisma.session.findMany({
    where: { userId: input.userId, revokedAt: null, expiresAt: { gt: new Date() } },
    select: { ipAddress: true },
  })
  const activeIps = new Set(activeSessions.map((s) => s.ipAddress).filter(Boolean))
  if (input.ipAddress) activeIps.add(input.ipAddress)
  if (activeIps.size > 2) {
    factors.push('multiple_active_ips')
    score += 0.2
  }

  // ── Factor 5: Rapid IP change (different IP within last 10 min) ──
  if (input.ipAddress && recentSessions.length > 0) {
    const tenMinAgo = new Date(Date.now() - 10 * 60 * 1000)
    const recentLogin = recentSessions.find(
      (s) => s.createdAt > tenMinAgo && s.ipAddress && s.ipAddress !== input.ipAddress,
    )
    if (recentLogin) {
      factors.push('rapid_ip_change')
      score += 0.3
    }
  }

  return { score: Math.min(score, 1.0), factors }
}

/**
 * Derive a simple device fingerprint from user-agent + IP class.
 * Not cryptographically strong, but useful for basic device tracking.
 */
export function deriveDeviceFingerprint(userAgent?: string, ipAddress?: string): string | undefined {
  if (!userAgent) return undefined
  const raw = `${userAgent}|${ipAddress?.split('.').slice(0, 2).join('.') ?? 'unknown'}`
  return createHash('sha256').update(raw).digest('hex').slice(0, 16)
}
