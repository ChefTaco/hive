import { describe, expect, it } from 'vitest'
import { planSeedClientSecret } from '../../prisma/seed-client-secret.js'

const base = {
  clientName: 'hive-router',
  envName: 'SEED_HIVE_ROUTER_CLIENT_SECRET',
}

describe('seed client-secret planning', () => {
  it('fails closed when first creation has no recoverable secret', () => {
    expect(() => planSeedClientSecret({
      ...base,
      clientExists: false,
      existingSecretHash: null,
      suppliedSecret: undefined,
    })).toThrow(/required when creating/u)
  })

  it('provisions a missing hash only when a protected secret is supplied', () => {
    expect(planSeedClientSecret({
      ...base,
      clientExists: true,
      existingSecretHash: null,
      suppliedSecret: 'x'.repeat(32),
    })).toBe('provision')
  })

  it('preserves an existing hash even when routine seed receives the same secret', () => {
    expect(planSeedClientSecret({
      ...base,
      clientExists: true,
      existingSecretHash: '$argon2id$existing',
      suppliedSecret: 'x'.repeat(32),
    })).toBe('preserve')
  })
})
