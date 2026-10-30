import { TOTP, Secret } from 'otpauth'
import * as QRCode from 'qrcode'
import { nanoid } from 'nanoid'
import argon2 from 'argon2'

const ARGON2_OPTIONS: argon2.Options = {
  type: argon2.argon2id,
  memoryCost: 65536,
  timeCost: 3,
  parallelism: 4,
}

const ISSUER = 'Hive IAM'
const BACKUP_CODE_COUNT = 10
const BACKUP_CODE_LENGTH = 8

/**
 * Generate a TOTP secret for a user. Returns the base32 secret,
 * the otpauth:// URI, and a data-URL QR code image.
 */
export async function generateTotpSecret(
  email: string,
): Promise<{ secret: string; uri: string; qrDataUrl: string }> {
  const secret = new Secret({ size: 20 })

  const totp = new TOTP({
    issuer: ISSUER,
    label: email,
    algorithm: 'SHA1',
    digits: 6,
    period: 30,
    secret,
  })

  const uri = totp.toString()
  const qrDataUrl = await QRCode.toDataURL(uri)

  return {
    secret: secret.base32,
    uri,
    qrDataUrl,
  }
}

/**
 * Verify a 6-digit TOTP code against the stored base32 secret.
 * Allows ±1 time window tolerance for clock skew.
 */
export function verifyTotpCode(secret: string, code: string): boolean {
  const totp = new TOTP({
    issuer: ISSUER,
    algorithm: 'SHA1',
    digits: 6,
    period: 30,
    secret: Secret.fromBase32(secret),
  })

  // validate returns the time step difference, or null if invalid
  // window: 1 allows ±1 period (±30 seconds)
  const delta = totp.validate({ token: code, window: 1 })
  return delta !== null
}

/**
 * Generate single-use backup codes.
 * Returns both the plaintext codes (shown once to user) and their Argon2id hashes (stored in DB).
 */
export async function generateBackupCodes(): Promise<{
  plaintextCodes: string[]
  hashedCodes: string[]
}> {
  const plaintextCodes: string[] = []
  const hashedCodes: string[] = []

  for (let i = 0; i < BACKUP_CODE_COUNT; i++) {
    const code = nanoid(BACKUP_CODE_LENGTH)
    plaintextCodes.push(code)
    const hash = await argon2.hash(code, ARGON2_OPTIONS)
    hashedCodes.push(hash)
  }

  return { plaintextCodes, hashedCodes }
}

/**
 * Verify a backup code against stored hashes.
 * Returns the index of the matched code, or -1 if none match.
 */
export async function verifyBackupCode(
  code: string,
  hashedCodes: string[],
): Promise<number> {
  for (let i = 0; i < hashedCodes.length; i++) {
    const hash = hashedCodes[i]!
    if (hash === '') continue // Already used
    try {
      const match = await argon2.verify(hash, code, ARGON2_OPTIONS)
      if (match) return i
    } catch {
      // Invalid hash format — skip
    }
  }
  return -1
}
