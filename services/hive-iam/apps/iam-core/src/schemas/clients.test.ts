import { describe, expect, it } from 'vitest'
import { RotateClientSecretSchema } from './clients.js'

describe('RotateClientSecretSchema', () => {
  it('requires a strong replacement secret', () => {
    expect(RotateClientSecretSchema.safeParse({ secret: 'short' }).success).toBe(false)
    expect(RotateClientSecretSchema.safeParse({ secret: 'x'.repeat(32) }).success).toBe(true)
  })

  it('rejects unknown rotation controls', () => {
    expect(RotateClientSecretSchema.strict().safeParse({
      secret: 'x'.repeat(32),
      clientId: 'another-client',
    }).success).toBe(false)
  })
})
