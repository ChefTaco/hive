import { describe, expect, it } from 'vitest'

describe('client credentials permission mapping', () => {
  async function loadPermissionsMapper() {
    process.env['DATABASE_URL'] ??= 'file:/tmp/hive-iam-token-service-test.db'
    process.env['JWT_PRIVATE_KEY_PATH'] ??= '/tmp/hive-iam-test-private.pem'
    process.env['JWT_PUBLIC_KEY_PATH'] ??= '/tmp/hive-iam-test-public.pem'
    process.env['COOKIE_SECRET'] ??= 'cookie-secret-for-token-service-test'
    process.env['IAM_AGENT_SECRET'] ??= 'agent-secret-for-token-service-test'
    process.env['IAM_MACHINE_CLIENT_POLICIES'] ??= JSON.stringify({
      'disposable-consumer': {
        audience: 'disposable-api',
        permissions: ['disposable:read'],
        lifetimeSeconds: 300,
        rotationOwner: 'test-owner',
      },
    })
    const module = await import('./token-service.js')
    return module
  }

  it('maps only approved hive-router proxy scopes to permissions', async () => {
    const { permissionsForClientCredentials } = await loadPermissionsMapper()
    expect(permissionsForClientCredentials(
      'hive-router',
      'iam:users:read iam:roles:write openid iam:sa:delete iam:unknown',
    )).toEqual(['iam:users:read', 'iam:roles:write', 'iam:sa:delete'])
  })

  it('does not grant permissions to other clients', async () => {
    const { permissionsForClientCredentials } = await loadPermissionsMapper()
    expect(permissionsForClientCredentials('other-client', 'iam:users:read iam:roles:write')).toEqual([])
  })

  it('applies a disposable policy without widening requested permissions', async () => {
    const { audienceForClient, clientCredentialsTokenProfile, lifetimeForClientCredentials } = await loadPermissionsMapper()
    expect(clientCredentialsTokenProfile(
      'disposable-consumer',
      'Disposable consumer',
      'disposable:read disposable:write iam:users:read',
    )).toMatchObject({
      audience: 'disposable-api',
      claims: { permissions: ['disposable:read'] },
    })
    expect(audienceForClient('disposable-consumer')).toBe('disposable-api')
    expect(lifetimeForClientCredentials('disposable-consumer')).toBe(300)
  })

  it('limits the security exporter to read-only IAM audit events', async () => {
    const { permissionsForClientCredentials } = await loadPermissionsMapper()
    expect(permissionsForClientCredentials(
      'security-exporter',
      'iam:audit:read router:security-events:read iam:users:read iam:sessions:revoke',
    )).toEqual(['iam:audit:read', 'router:security-events:read'])
  })

  it('limits example portal client credentials to its read-only scope', async () => {
    const { permissionsForClientCredentials } = await loadPermissionsMapper()
    expect(permissionsForClientCredentials(
      'example-portal',
      'example-portal:read example-portal:write iam:users:read router:security-events:read',
    )).toEqual(['example-portal:read'])
  })

  it('binds example portal access tokens to the example portal audience', async () => {
    const { audienceForClient, clientCredentialsTokenProfile } = await loadPermissionsMapper()
    expect(audienceForClient('example-portal')).toBe('example-portal')
    expect(clientCredentialsTokenProfile('example-portal', 'example-portal', 'example-portal:read example-portal:write')).toEqual({
      audience: 'example-portal',
      claims: {
        actorType: 'SERVICE_ACCOUNT',
        clientId: 'example-portal',
        clientName: 'example-portal',
        token_type: 'access',
        scope: 'example-portal:read example-portal:write',
        roles: [],
        permissions: ['example-portal:read'],
      },
    })
  })

  it('binds security exporter access tokens to the Router audience and token type', async () => {
    const { clientCredentialsTokenProfile } = await loadPermissionsMapper()
    expect(clientCredentialsTokenProfile(
      'security-exporter',
      'security-exporter',
      'iam:audit:read router:security-events:read',
    )).toEqual({
      audience: 'hive-router',
      claims: {
        actorType: 'SERVICE_ACCOUNT',
        clientId: 'security-exporter',
        clientName: 'security-exporter',
        token_type: 'access',
        scope: 'iam:audit:read router:security-events:read',
        roles: [],
        permissions: ['iam:audit:read', 'router:security-events:read'],
      },
    })
  })
})
