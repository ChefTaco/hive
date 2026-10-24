import { describe, it, expect } from 'vitest'
import { LoginSchema, RefreshSchema, ChangePasswordSchema } from './auth.js'

describe('LoginSchema', () => {
  it('accepts valid username and password', () => {
    const result = LoginSchema.safeParse({ username: 'admin', password: 'password123' })
    expect(result.success).toBe(true)
  })

  it('rejects empty username', () => {
    const result = LoginSchema.safeParse({ username: '', password: 'password' })
    expect(result.success).toBe(false)
  })

  it('rejects empty password', () => {
    const result = LoginSchema.safeParse({ username: 'admin', password: '' })
    expect(result.success).toBe(false)
  })

  it('rejects missing fields', () => {
    expect(LoginSchema.safeParse({}).success).toBe(false)
    expect(LoginSchema.safeParse({ username: 'admin' }).success).toBe(false)
    expect(LoginSchema.safeParse({ password: 'pass' }).success).toBe(false)
  })
})

describe('RefreshSchema', () => {
  it('accepts valid refresh token', () => {
    const result = RefreshSchema.safeParse({ refreshToken: 'abc123token' })
    expect(result.success).toBe(true)
  })

  it('rejects empty refresh token', () => {
    const result = RefreshSchema.safeParse({ refreshToken: '' })
    expect(result.success).toBe(false)
  })
})

describe('ChangePasswordSchema', () => {
  it('accepts valid password change', () => {
    const result = ChangePasswordSchema.safeParse({
      currentPassword: 'oldPass',
      newPassword: 'newStrongPassword123',
    })
    expect(result.success).toBe(true)
  })

  it('rejects new password under 8 characters', () => {
    const result = ChangePasswordSchema.safeParse({
      currentPassword: 'old',
      newPassword: 'short',
    })
    expect(result.success).toBe(false)
  })

  it('allows any length for current password', () => {
    // Current password just needs to be non-empty — length constraint is on the new one
    const result = ChangePasswordSchema.safeParse({
      currentPassword: 'a',
      newPassword: 'longenough12',
    })
    expect(result.success).toBe(true)
  })
})
