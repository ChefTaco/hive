import argon2 from 'argon2'
import { prisma } from '../db/client.js'
import { ApiError } from '../types/index.js'

const ARGON2_OPTIONS: argon2.Options = {
  type: argon2.argon2id,
  memoryCost: 65536,
  timeCost: 3,
  parallelism: 4,
}

interface PasswordPolicySettings {
  minLength: number
  maxLength: number
  requireUppercase: boolean
  requireLowercase: boolean
  requireNumbers: boolean
  requireSpecial: boolean
  maxAgeDays: number
  historyCount: number
  lockoutAttempts: number
  lockoutDurationMin: number
}

/**
 * Get the default (or only) password policy. Creates one if none exists.
 */
export async function getDefaultPolicy(): Promise<PasswordPolicySettings & { id: string; name: string }> {
  let policy = await prisma.passwordPolicy.findFirst({
    where: { isDefault: true },
    orderBy: { createdAt: 'desc' },
  })

  if (!policy) {
    // Auto-create a default policy
    policy = await prisma.passwordPolicy.create({
      data: { name: 'Default Policy', isDefault: true },
    })
  }

  return policy
}

/**
 * Validate a plaintext password against the active policy.
 * Throws ApiError with details if validation fails.
 */
export function validatePasswordPolicy(password: string, policy: PasswordPolicySettings): string[] {
  const errors: string[] = []

  if (password.length < policy.minLength) {
    errors.push(`Password must be at least ${policy.minLength} characters`)
  }
  if (password.length > policy.maxLength) {
    errors.push(`Password must be at most ${policy.maxLength} characters`)
  }
  if (policy.requireUppercase && !/[A-Z]/.test(password)) {
    errors.push('Password must contain at least one uppercase letter')
  }
  if (policy.requireLowercase && !/[a-z]/.test(password)) {
    errors.push('Password must contain at least one lowercase letter')
  }
  if (policy.requireNumbers && !/\d/.test(password)) {
    errors.push('Password must contain at least one number')
  }
  if (policy.requireSpecial && !/[!@#$%^&*()_+\-=[\]{};':"\\|,.<>/?`~]/.test(password)) {
    errors.push('Password must contain at least one special character')
  }

  return errors
}

/**
 * Check if a user's password has expired based on policy `maxAgeDays`.
 * Returns false if maxAgeDays is 0 (no expiry) or passwordChangedAt is not set.
 */
export function isPasswordExpired(
  passwordChangedAt: Date | null | undefined,
  maxAgeDays: number,
): boolean {
  if (maxAgeDays <= 0) return false
  if (!passwordChangedAt) return false // Never set → don't force on legacy accounts

  const expiryDate = new Date(passwordChangedAt.getTime() + maxAgeDays * 24 * 60 * 60 * 1000)
  return new Date() > expiryDate
}

/**
 * Check if the new password matches any of the last N passwords.
 * Returns true if the password was used before.
 */
export async function checkPasswordHistory(
  userId: string,
  newPassword: string,
  historyCount: number,
): Promise<boolean> {
  if (historyCount <= 0) return false

  const history = await prisma.passwordHistory.findMany({
    where: { userId },
    orderBy: { createdAt: 'desc' },
    take: historyCount,
  })

  for (const entry of history) {
    try {
      const match = await argon2.verify(entry.hash, newPassword, ARGON2_OPTIONS)
      if (match) return true
    } catch {
      // Invalid hash format — skip
    }
  }
  return false
}

/**
 * Record a password change in the history table.
 */
export async function recordPasswordHistory(
  userId: string,
  passwordHash: string,
): Promise<void> {
  await prisma.passwordHistory.create({
    data: { userId, hash: passwordHash },
  })

  // Clean up old entries beyond policy limit
  const policy = await getDefaultPolicy()
  if (policy.historyCount > 0) {
    const entries = await prisma.passwordHistory.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
      skip: policy.historyCount,
    })
    if (entries.length > 0) {
      await prisma.passwordHistory.deleteMany({
        where: { id: { in: entries.map((e) => e.id) } },
      })
    }
  }
}

/**
 * Calculate password strength score (0-100).
 */
export function calculatePasswordStrength(password: string): number {
  let score = 0

  // Length scoring
  if (password.length >= 8) score += 20
  if (password.length >= 12) score += 10
  if (password.length >= 16) score += 10

  // Character variety
  if (/[a-z]/.test(password)) score += 10
  if (/[A-Z]/.test(password)) score += 10
  if (/\d/.test(password)) score += 10
  if (/[^a-zA-Z\d]/.test(password)) score += 15

  // Bonus for mixed character types
  const types = [/[a-z]/, /[A-Z]/, /\d/, /[^a-zA-Z\d]/].filter((r) => r.test(password)).length
  if (types >= 3) score += 10
  if (types >= 4) score += 5

  return Math.min(score, 100)
}
