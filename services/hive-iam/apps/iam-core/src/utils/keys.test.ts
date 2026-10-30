import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  decodeProtectedHeader,
  exportPKCS8,
  exportSPKI,
  generateKeyPair,
  SignJWT,
} from 'jose'
import { describe, expect, it, vi } from 'vitest'

describe('JWT signing keyring', () => {
  it('derives stable key IDs, signs with the active ID, and publishes overlap keys', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'hive-iam-keyring-'))
    const active = await generateKeyPair('RS256', { extractable: true })
    const previous = await generateKeyPair('RS256', { extractable: true })
    const activePrivatePem = await exportPKCS8(active.privateKey)
    const activePublicPem = await exportSPKI(active.publicKey)
    const previousPublicPem = await exportSPKI(previous.publicKey)
    const activePrivatePath = join(directory, 'active-private.pem')
    const activePublicPath = join(directory, 'active-public.pem')
    const previousPublicPath = join(directory, 'previous-public.pem')
    await Promise.all([
      writeFile(activePrivatePath, activePrivatePem),
      writeFile(activePublicPath, activePublicPem),
      writeFile(previousPublicPath, previousPublicPem),
    ])

    process.env['DATABASE_URL'] = `file:${join(directory, 'iam.db')}`
    process.env['JWT_PRIVATE_KEY_PATH'] = activePrivatePath
    process.env['JWT_PUBLIC_KEY_PATH'] = activePublicPath
    process.env['JWT_PREVIOUS_PUBLIC_KEY_PATHS'] = previousPublicPath
    process.env['COOKIE_SECRET'] = 'cookie-secret-for-keyring-test-000000'
    process.env['IAM_AGENT_SECRET'] = 'agent-secret-for-keyring-test'
    vi.resetModules()

    const keys = await import('./keys.js')
    const tokenService = await import('../services/token-service.js')
    const activeKid = await keys.getSigningKeyId()
    expect(await keys.keyIdForPem(activePrivatePem)).toBe(activeKid)
    expect(await keys.keyIdForPem(activePublicPem)).toBe(activeKid)
    expect(await keys.keyIdForPem(previousPublicPem)).not.toBe(activeKid)

    const jwks = await keys.getPublishedSigningJwks()
    expect(jwks.keys).toHaveLength(2)
    expect(jwks.keys[0]?.['kid']).toBe(activeKid)
    expect(new Set(jwks.keys.map((key) => key['kid'])).size).toBe(2)

    const token = await tokenService.issueClientCredentialsToken(
      'security-exporter',
      'Security Exporter',
      'router:security-events:read',
    )
    expect(decodeProtectedHeader(token)).toMatchObject({ alg: 'RS256', kid: activeKid })

    const previousKid = await keys.keyIdForPem(previousPublicPem)
    const now = Math.floor(Date.now() / 1_000)
    const oldToken = await new SignJWT({
      actorType: 'SERVICE_ACCOUNT',
      roles: [],
      permissions: ['iam:audit:read'],
    })
      .setProtectedHeader({ alg: 'RS256', kid: previousKid })
      .setSubject('previous-key-client')
      .setIssuer('https://hive:4200')
      .setIssuedAt(now)
      .setExpirationTime(now + 300)
      .setJti('previous-key-token')
      .sign(previous.privateKey)
    await expect(tokenService.verifyAccessToken(oldToken)).resolves.toMatchObject({
      sub: 'previous-key-client',
    })
  })
})
