import { createPrivateKey, createPublicKey } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { applyCliDefaults, dropEmptyValues, ensurePrivateDirs, ensureSigningKeys, writableDirs } from './defaults.js'
import { hiveHome, iamDataDir, sqlitePathFromUrl } from './paths.js'

const temps: string[] = []
function temp(): string {
  const dir = mkdtempSync(join(tmpdir(), 'hive-iam-cli-'))
  temps.push(dir)
  return dir
}
afterEach(() => {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('npm install defaults', () => {
  it('puts all data under ${HIVE_HOME:-~/.hive}/iam', () => {
    expect(hiveHome({})).toBe(join(homedir(), '.hive'))
    expect(iamDataDir({ HIVE_HOME: '/srv/hive' })).toBe('/srv/hive/iam')
    expect(iamDataDir({ HIVE_HOME: '/srv/hive', IAM_DATA_DIR: '/data/iam' })).toBe('/data/iam')

    const env: Record<string, string | undefined> = { HIVE_HOME: '/srv/hive' }
    const result = applyCliDefaults(env)
    expect(result.dataDir).toBe('/srv/hive/iam')
    expect(result.managedSigningKeys).toBe(true)
    expect(env).toMatchObject({
      NODE_ENV: 'production',
      HOST: '127.0.0.1',
      PORT: '4200',
      JWT_ISSUER: 'hive-iam',
      DATABASE_URL: 'file:/srv/hive/iam/iam.db',
      AUDIT_LOG_DIR: '/srv/hive/iam/audit-logs',
      JWT_PRIVATE_KEY_PATH: '/srv/hive/iam/keys/iam-private.pem',
      JWT_PUBLIC_KEY_PATH: '/srv/hive/iam/keys/iam-public.pem',
    })
    expect(writableDirs(env)).toEqual(['/srv/hive/iam', '/srv/hive/iam/audit-logs'])
  })

  it('never overrides explicit settings and treats empty values as unset', () => {
    const env: Record<string, string | undefined> = {
      HOST: '0.0.0.0',
      PORT: '4200',
      DATABASE_URL: 'file:./prisma/iam.db',
      JWT_PRIVATE_KEY_PATH: 'keys/iam-private.pem',
      AUDIT_LOG_DIR: '',
    }
    const result = applyCliDefaults(env)
    expect(env['HOST']).toBe('0.0.0.0')
    expect(env['DATABASE_URL']).toBe('file:./prisma/iam.db')
    expect(env['JWT_PUBLIC_KEY_PATH']).toBeUndefined()
    expect(result.managedSigningKeys).toBe(false)
    expect(result.applied).toContain('AUDIT_LOG_DIR')
    expect(result.applied).not.toContain('HOST')
  })

  it('treats empty IAM variables as unset and leaves others alone', () => {
    const env: Record<string, string | undefined> = { SEED_HIVE_PUBLIC_URL: '', CORS_ORIGIN: '', TLS_CERT_PATH: '/x', UNRELATED: '' }
    expect(dropEmptyValues(env).sort()).toEqual(['CORS_ORIGIN', 'SEED_HIVE_PUBLIC_URL'])
    expect(env).toEqual({ TLS_CERT_PATH: '/x', UNRELATED: '' })
  })

  it('resolves SQLite URLs the way the Prisma adapter does', () => {
    expect(sqlitePathFromUrl('file:/var/lib/iam.db')).toBe('/var/lib/iam.db')
    expect(sqlitePathFromUrl('file:./prisma/iam.db')).toBe(join(process.cwd(), 'prisma/iam.db'))
  })
})

describe('data directory and signing keys', () => {
  it('creates missing directories owner-only', () => {
    const dir = join(temp(), 'a', 'b')
    ensurePrivateDirs([dir])
    expect(statSync(dir).mode & 0o777).toBe(0o700)
  })

  it('generates a matching RS256 pair once and keeps it', () => {
    const root = temp()
    const privatePath = join(root, 'keys', 'iam-private.pem')
    const publicPath = join(root, 'keys', 'iam-public.pem')
    expect(ensureSigningKeys(privatePath, publicPath)).toBe('generated')
    expect(statSync(privatePath).mode & 0o777).toBe(0o600)
    expect(statSync(join(root, 'keys')).mode & 0o777).toBe(0o700)
    const privateKey = createPrivateKey(readFileSync(privatePath))
    expect(privateKey.asymmetricKeyType).toBe('rsa')
    expect(privateKey.asymmetricKeyDetails?.modulusLength).toBe(4096)
    expect(readFileSync(privatePath, 'utf8')).toContain('BEGIN PRIVATE KEY')
    expect(createPublicKey(privateKey).export({ type: 'spki', format: 'pem' })).toBe(readFileSync(publicPath, 'utf8'))

    const before = readFileSync(privatePath, 'utf8')
    expect(ensureSigningKeys(privatePath, publicPath)).toBe('present')
    expect(readFileSync(privatePath, 'utf8')).toBe(before)
  })

  it('refuses to replace half of a key pair', () => {
    const root = temp()
    const privatePath = join(root, 'iam-private.pem')
    writeFileSync(privatePath, 'existing')
    expect(() => ensureSigningKeys(privatePath, join(root, 'iam-public.pem'))).toThrow(/incomplete/)
    expect(readFileSync(privatePath, 'utf8')).toBe('existing')
    expect(existsSync(join(root, 'iam-public.pem'))).toBe(false)
  })
})
