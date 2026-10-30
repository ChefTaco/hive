import { generateKeyPairSync } from 'node:crypto'
import { existsSync, mkdirSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { envSchema } from '../config/env-schema.js'
import { iamDataDir, sqlitePathFromUrl } from './paths.js'

type Source = Record<string, string | undefined>

export interface CliDefaults {
  /** Data directory used for every defaulted path. */
  dataDir: string
  /** Names of the variables this call filled in. */
  applied: string[]
  /** True when the signing key paths were defaulted, so the CLI may create the pair. */
  managedSigningKeys: boolean
}

function unset(source: Source, name: string): boolean {
  const value = source[name]
  return value === undefined || value.trim() === ''
}

const OWN_PREFIXES = ['SEED_', 'IAM_', 'WEBAUTHN_', 'HIVE_']

/**
 * Treat `NAME=` as unset for IAM's own variables, so env files and compose
 * files can list optional settings without values. Returns the removed names.
 */
export function dropEmptyValues(source: Source = process.env): string[] {
  const own = new Set(Object.keys(envSchema.shape))
  const removed: string[] = []
  for (const [name, value] of Object.entries(source)) {
    if (value !== '' || !(own.has(name) || OWN_PREFIXES.some((prefix) => name.startsWith(prefix)))) continue
    delete source[name]
    removed.push(name)
  }
  return removed
}

/**
 * Fill in the npm-install defaults for variables the operator left unset.
 * Explicit values always win; nothing is written to disk here. These defaults
 * apply to the `hive-iam-server` CLI only. The systemd entry point
 * (`dist/index.js`) keeps the schema defaults in config/env-schema.ts.
 */
export function applyCliDefaults(source: Source = process.env): CliDefaults {
  const dataDir = iamDataDir(source)
  const applied: string[] = []
  const set = (name: string, value: string) => {
    if (unset(source, name)) {
      source[name] = value
      applied.push(name)
    }
  }

  set('NODE_ENV', 'production')
  set('HOST', '127.0.0.1')
  set('PORT', '4200')
  set('JWT_ISSUER', 'hive-iam')
  set('DATABASE_URL', `file:${join(dataDir, 'iam.db')}`)
  set('AUDIT_LOG_DIR', join(dataDir, 'audit-logs'))

  const managedSigningKeys = unset(source, 'JWT_PRIVATE_KEY_PATH') && unset(source, 'JWT_PUBLIC_KEY_PATH')
  if (managedSigningKeys) {
    set('JWT_PRIVATE_KEY_PATH', join(dataDir, 'keys', 'iam-private.pem'))
    set('JWT_PUBLIC_KEY_PATH', join(dataDir, 'keys', 'iam-public.pem'))
  }

  return { dataDir, applied, managedSigningKeys }
}

/** Directories the server writes to, derived from the effective configuration. */
export function writableDirs(source: Source = process.env): string[] {
  const dirs = new Set<string>()
  const databaseUrl = source['DATABASE_URL']
  if (databaseUrl) dirs.add(dirname(sqlitePathFromUrl(databaseUrl)))
  const auditDir = source['AUDIT_LOG_DIR']
  if (auditDir) dirs.add(resolve(auditDir))
  return [...dirs]
}

/** Create missing directories owner-only (0700). Existing directories are left as they are. */
export function ensurePrivateDirs(dirs: readonly string[]): void {
  for (const dir of dirs) {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 })
  }
}

export type SigningKeyState = 'present' | 'generated'

/**
 * Create an RS256 key pair (RSA 4096, PKCS#8/SPKI PEM) when neither file
 * exists. A half-present pair is never overwritten.
 */
export function ensureSigningKeys(privatePath: string, publicPath: string): SigningKeyState {
  const privateExists = existsSync(privatePath)
  const publicExists = existsSync(publicPath)
  if (privateExists && publicExists) return 'present'
  if (privateExists !== publicExists) {
    const missing = privateExists ? publicPath : privatePath
    throw new Error(`JWT signing key pair is incomplete: ${missing} is missing. Restore it from backup, or remove the remaining key to generate a new pair.`)
  }

  ensurePrivateDirs([dirname(privatePath), dirname(publicPath)])
  const { privateKey, publicKey } = generateKeyPairSync('rsa', {
    modulusLength: 4096,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  })
  const privateTmp = `${privatePath}.tmp-${process.pid}`
  const publicTmp = `${publicPath}.tmp-${process.pid}`
  writeFileSync(privateTmp, privateKey, { mode: 0o600, flag: 'wx' })
  writeFileSync(publicTmp, publicKey, { mode: 0o644, flag: 'wx' })
  renameSync(publicTmp, publicPath)
  renameSync(privateTmp, privatePath)
  return 'generated'
}
