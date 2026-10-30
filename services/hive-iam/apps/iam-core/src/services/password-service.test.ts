import { describe, it, expect } from 'vitest'
import { hashPassword, verifyPassword } from './password-service.js'

describe('password-service', () => {
  it('hashes and verifies a password', async () => {
    const password = 'SuperSecure123!'
    const hash = await hashPassword(password)

    expect(hash).toBeDefined()
    expect(hash).not.toBe(password)
    expect(hash.startsWith('$argon2id$')).toBe(true)

    const valid = await verifyPassword(hash, password)
    expect(valid).toBe(true)
  })

  it('rejects incorrect password', async () => {
    const hash = await hashPassword('correct-horse-battery')
    const valid = await verifyPassword(hash, 'wrong-password')
    expect(valid).toBe(false)
  })

  it('produces different hashes for same password (salt)', async () => {
    const password = 'samePW'
    const hash1 = await hashPassword(password)
    const hash2 = await hashPassword(password)
    expect(hash1).not.toBe(hash2)
    // Both should verify
    expect(await verifyPassword(hash1, password)).toBe(true)
    expect(await verifyPassword(hash2, password)).toBe(true)
  })

  it('returns false for malformed hash instead of throwing', async () => {
    const valid = await verifyPassword('not-a-real-hash', 'password')
    expect(valid).toBe(false)
  })

  it('handles empty password string', async () => {
    const hash = await hashPassword('')
    expect(await verifyPassword(hash, '')).toBe(true)
    expect(await verifyPassword(hash, 'not-empty')).toBe(false)
  })
})
