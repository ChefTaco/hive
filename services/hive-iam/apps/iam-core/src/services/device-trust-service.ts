import { prisma } from '../db/client.js'
import { createHash } from 'node:crypto'

/**
 * Compute a device fingerprint from user-agent and other characteristics.
 */
export function computeDeviceFingerprint(userAgent?: string, acceptLanguage?: string): string {
  const raw = [
    userAgent ?? 'unknown',
    acceptLanguage ?? '',
  ].join('|')
  return createHash('sha256').update(raw).digest('hex').slice(0, 32)
}

/**
 * Check if a device is trusted for a given user.
 */
export async function isDeviceTrusted(userId: string, fingerprint: string): Promise<boolean> {
  const device = await prisma.trustedDevice.findUnique({
    where: { userId_fingerprint: { userId, fingerprint } },
    select: { trusted: true },
  })
  return device?.trusted ?? false
}

/**
 * Register or update a trusted device.
 */
export async function registerTrustedDevice(
  userId: string,
  fingerprint: string,
  opts?: { name?: string; userAgent?: string; ipAddress?: string },
): Promise<{ id: string; isNew: boolean }> {
  const existing = await prisma.trustedDevice.findUnique({
    where: { userId_fingerprint: { userId, fingerprint } },
  })

  if (existing) {
    await prisma.trustedDevice.update({
      where: { id: existing.id },
      data: { lastSeenAt: new Date(), ipAddress: opts?.ipAddress },
    })
    return { id: existing.id, isNew: false }
  }

  const device = await prisma.trustedDevice.create({
    data: {
      userId,
      fingerprint,
      name: opts?.name,
      userAgent: opts?.userAgent,
      ipAddress: opts?.ipAddress,
    },
  })
  return { id: device.id, isNew: true }
}

/**
 * List trusted devices for a user.
 */
export async function listTrustedDevices(userId: string) {
  return prisma.trustedDevice.findMany({
    where: { userId },
    orderBy: { lastSeenAt: 'desc' },
  })
}

/**
 * Revoke a trusted device.
 */
export async function revokeTrustedDevice(userId: string, deviceId: string): Promise<boolean> {
  const device = await prisma.trustedDevice.findFirst({
    where: { id: deviceId, userId },
  })
  if (!device) return false

  await prisma.trustedDevice.update({
    where: { id: deviceId },
    data: { trusted: false },
  })
  return true
}

/**
 * Delete a trusted device.
 */
export async function deleteTrustedDevice(userId: string, deviceId: string): Promise<boolean> {
  const device = await prisma.trustedDevice.findFirst({
    where: { id: deviceId, userId },
  })
  if (!device) return false

  await prisma.trustedDevice.delete({ where: { id: deviceId } })
  return true
}

/**
 * Assess device posture based on session context.
 * Returns a posture score and assessment flags.
 */
export async function assessDevicePosture(
  userId: string,
  fingerprint: string,
  context: { ipAddress?: string; userAgent?: string },
): Promise<{
  score: number
  trusted: boolean
  flags: string[]
}> {
  const flags: string[] = []
  let score = 1.0 // Start fully trusted

  // Check if device is registered and trusted
  const device = await prisma.trustedDevice.findUnique({
    where: { userId_fingerprint: { userId, fingerprint } },
  })

  if (!device) {
    flags.push('unregistered_device')
    score -= 0.4
  } else if (!device.trusted) {
    flags.push('revoked_device')
    score -= 0.6
  } else {
    // Known device — check staleness
    const daysSinceLastSeen = (Date.now() - new Date(device.lastSeenAt).getTime()) / (1000 * 60 * 60 * 24)
    if (daysSinceLastSeen > 30) {
      flags.push('stale_device')
      score -= 0.2
    }
  }

  // Check for user-agent changes from registered device
  if (device && context.userAgent && device.userAgent && device.userAgent !== context.userAgent) {
    flags.push('user_agent_mismatch')
    score -= 0.2
  }

  return {
    score: Math.max(0, score),
    trusted: score >= 0.6,
    flags,
  }
}
