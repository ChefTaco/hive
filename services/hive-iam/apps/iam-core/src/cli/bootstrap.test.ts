import { describe, expect, it } from 'vitest'
import { credentialsFilePath, prepareBootstrapEnv } from './bootstrap.js'

describe('first-start bootstrap inputs', () => {
  it('keeps supplied secrets and generates only the missing ones', () => {
    const admin = 'a-strong-admin-password'
    const { env, generated } = prepareBootstrapEnv({ SEED_ADMIN_PASSWORD: admin, SEED_HIVE_CLIENT_SECRET: '' })
    expect(env['SEED_ADMIN_PASSWORD']).toBe(admin)
    expect(generated).toEqual(['SEED_HIVE_CLIENT_SECRET', 'SEED_HIVE_ROUTER_CLIENT_SECRET'])
    for (const name of generated) expect(env[name]).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(env['SEED_HIVE_CLIENT_SECRET']).not.toBe(env['SEED_HIVE_ROUTER_CLIENT_SECRET'])
  })

  it('reuses values from an interrupted attempt', () => {
    const previous = { SEED_ADMIN_PASSWORD: 'p'.repeat(20), SEED_HIVE_CLIENT_SECRET: 'h'.repeat(40) }
    const { env } = prepareBootstrapEnv({}, previous)
    expect(env['SEED_ADMIN_PASSWORD']).toBe(previous.SEED_ADMIN_PASSWORD)
    expect(env['SEED_HIVE_CLIENT_SECRET']).toBe(previous.SEED_HIVE_CLIENT_SECRET)
  })

  it('rejects supplied secrets that the seed would refuse', () => {
    expect(() => prepareBootstrapEnv({ SEED_ADMIN_PASSWORD: 'short' })).toThrow(/SEED_ADMIN_PASSWORD must contain at least 16 characters/)
    expect(() => prepareBootstrapEnv({ SEED_HIVE_ROUTER_CLIENT_SECRET: 'x'.repeat(31) })).toThrow(/at least 32/)
  })

  it('keeps the credentials file next to the database', () => {
    expect(credentialsFilePath('/srv/hive/iam/iam.db')).toBe('/srv/hive/iam/initial-credentials.env')
  })
})
