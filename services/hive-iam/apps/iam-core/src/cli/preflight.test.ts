import { spawnSync } from 'node:child_process'
import { generateKeyPairSync } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { checkConfig, checkDataDirs, checkSigningKeys, checkTls, redactUrl, redisFailureLine } from './preflight.js'

const root = mkdtempSync(join(tmpdir(), 'hive-iam-preflight-'))
afterAll(() => rmSync(root, { recursive: true, force: true }))

function keyPair(name: string) {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  })
  const privatePath = join(root, `${name}-private.pem`)
  const publicPath = join(root, `${name}-public.pem`)
  writeFileSync(privatePath, privateKey)
  writeFileSync(publicPath, publicKey)
  return { privatePath, publicPath }
}

const hasOpenssl = spawnSync('openssl', ['version']).status === 0

describe('preflight checks', () => {
  it('reports configuration problems by variable', () => {
    const results = checkConfig({})
    expect(results.every((result) => result.status === 'fail')).toBe(true)
    expect(results.map((result) => result.message.split(' ')[0])).toEqual(
      expect.arrayContaining(['DATABASE_URL', 'COOKIE_SECRET', 'IAM_AGENT_SECRET', 'JWT_PRIVATE_KEY_PATH', 'JWT_PUBLIC_KEY_PATH']),
    )
  })

  it('treats TLS as optional but all-or-nothing', () => {
    expect(checkTls({}).status).toBe('warn')
    expect(checkTls({ TLS_CERT_PATH: '/x.crt' })).toMatchObject({ status: 'fail', message: expect.stringContaining('TLS_KEY_PATH is not set') })
    expect(checkTls({ TLS_CERT_PATH: join(root, 'none.crt'), TLS_KEY_PATH: join(root, 'none.key') })).toMatchObject({ status: 'fail', message: expect.stringContaining('does not exist') })
  })

  it.skipIf(!hasOpenssl)('validates a certificate against its key and expiry', () => {
    const cert = join(root, 'server.crt')
    const key = join(root, 'server.key')
    const made = spawnSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', cert, '-days', '30', '-subj', '/CN=localhost'])
    expect(made.status).toBe(0)
    expect(checkTls({ TLS_CERT_PATH: cert, TLS_KEY_PATH: key })).toMatchObject({ status: 'pass' })
    expect(checkTls({ TLS_CERT_PATH: cert, TLS_KEY_PATH: key }, new Date(Date.now() + 25 * 86_400_000)).status).toBe('warn')
    expect(checkTls({ TLS_CERT_PATH: cert, TLS_KEY_PATH: key }, new Date(Date.now() + 40 * 86_400_000)).status).toBe('fail')
    const other = keyPair('tls-other')
    expect(checkTls({ TLS_CERT_PATH: cert, TLS_KEY_PATH: other.privatePath })).toMatchObject({ status: 'fail', message: expect.stringContaining('does not match') })
  })

  it('verifies the signing key pair', () => {
    const a = keyPair('a')
    const b = keyPair('b')
    expect(checkSigningKeys({ JWT_PRIVATE_KEY_PATH: a.privatePath, JWT_PUBLIC_KEY_PATH: a.publicPath }, false)).toEqual([
      expect.objectContaining({ status: 'pass', message: 'RS256 key pair loaded (2048-bit)' }),
    ])
    expect(checkSigningKeys({ JWT_PRIVATE_KEY_PATH: a.privatePath, JWT_PUBLIC_KEY_PATH: b.publicPath }, false)[0]).toMatchObject({ status: 'fail', message: expect.stringContaining('not a matching key pair') })
    const missing = { JWT_PRIVATE_KEY_PATH: join(root, 'nope.pem'), JWT_PUBLIC_KEY_PATH: join(root, 'nope.pub') }
    expect(checkSigningKeys(missing, true)[0]!.status).toBe('pass')
    expect(checkSigningKeys(missing, false)[0]).toMatchObject({ status: 'fail', message: expect.stringContaining('JWT_PRIVATE_KEY_PATH') })
    expect(checkSigningKeys({ JWT_PRIVATE_KEY_PATH: a.privatePath, JWT_PUBLIC_KEY_PATH: a.publicPath, JWT_PREVIOUS_PUBLIC_KEY_PATHS: join(root, 'gone.pem') }, false)
      .some((result) => result.status === 'fail' && result.message.includes('JWT_PREVIOUS_PUBLIC_KEY_PATHS'))).toBe(true)
  })

  it('checks that data directories can be written or created', () => {
    expect(checkDataDirs({ DATABASE_URL: `file:${join(root, 'new', 'iam.db')}` })).toEqual([
      expect.objectContaining({ status: 'pass', message: expect.stringContaining('will be created') }),
    ])
    expect(checkDataDirs({ AUDIT_LOG_DIR: root })[0]!.status).toBe('pass')
  })

  it('never prints Redis credentials', () => {
    expect(redactUrl('redis://:hunter2hunter2@redis:6379/0')).toBe('redis://:***@redis:6379/0')
    const line = redisFailureLine('redis://user:hunter2hunter2@redis:6379', new Error('connect ECONNREFUSED'))
    expect(line).not.toContain('hunter2')
    expect(line).toMatch(/^Dependency error: cannot reach Redis .*REDIS_URL.*Fix: start Redis \(for example `docker run/)
  })
})
