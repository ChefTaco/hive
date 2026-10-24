/**
 * breach-check-service.ts — Check passwords against the HaveIBeenPwned Pwned Passwords API.
 *
 * Uses the k-anonymity model: only the first 5 characters of the SHA-1 hash
 * are sent to the API. The full hash never leaves the server.
 */

import { createHash } from 'node:crypto'

const HIBP_API = 'https://api.pwnedpasswords.com/range'
const TIMEOUT_MS = 3000

/**
 * Check if a password has appeared in known data breaches.
 * Returns the number of times the password was found, or 0 if not found.
 * Returns -1 if the check could not be completed (network error, timeout).
 */
export async function checkBreachedPassword(password: string): Promise<number> {
  const sha1 = createHash('sha1').update(password).digest('hex').toUpperCase()
  const prefix = sha1.slice(0, 5)
  const suffix = sha1.slice(5)

  try {
    const response = await fetch(`${HIBP_API}/${prefix}`, {
      headers: { 'User-Agent': 'Hive-IAM/1.0' },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })

    if (!response.ok) return -1

    const body = await response.text()
    for (const line of body.split('\n')) {
      const [hash, count] = line.trim().split(':')
      if (hash === suffix) {
        return parseInt(count ?? '0', 10)
      }
    }

    return 0
  } catch {
    return -1
  }
}
