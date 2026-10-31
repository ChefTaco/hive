import { createPrivateKey, createPublicKey, X509Certificate } from 'node:crypto'
import { accessSync, constants as fsConstants, existsSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { Redis } from 'ioredis'
import { validateEnv } from '../config/env-schema.js'
import { REDIS_DOCKER_COMMAND } from './constants.js'
import { writableDirs } from './defaults.js'
import { planMigrations } from './migrate.js'
import { MIGRATIONS_DIR, sqlitePathFromUrl } from './paths.js'

type Source = Record<string, string | undefined>


export interface CheckResult {
  name: string
  status: 'pass' | 'warn' | 'fail'
  message: string
}

const pass = (name: string, message: string): CheckResult => ({ name, status: 'pass', message })
const warn = (name: string, message: string): CheckResult => ({ name, status: 'warn', message })
const fail = (name: string, message: string): CheckResult => ({ name, status: 'fail', message })

function errorMessage(error: unknown): string {
  if (!(error instanceof Error)) return String(error)
  const code = (error as NodeJS.ErrnoException).code
  return (error.message || code || error.name).replace(/\.+$/, '')
}

/** Redact credentials from a Redis URL before printing it. */
export function redactUrl(url: string): string {
  try {
    const parsed = new URL(url)
    parsed.username = ''
    if (parsed.password) parsed.password = '***'
    parsed.search = ''
    parsed.hash = ''
    return parsed.toString()
  } catch {
    return '(unparseable URL)'
  }
}

export async function pingRedis(url: string, timeoutMs = 3000): Promise<void> {
  const client = new Redis(url, {
    lazyConnect: true,
    connectTimeout: timeoutMs,
    commandTimeout: timeoutMs,
    maxRetriesPerRequest: 0,
    enableOfflineQueue: false,
    retryStrategy: () => null,
  })
  // The socket error (ECONNREFUSED, ENOTFOUND, ...) explains more than the
  // generic "Connection is closed" the rejected command reports.
  let socketError: unknown
  client.on('error', (error) => { socketError ??= error })
  try {
    await client.connect()
    await client.ping()
  } catch (error) {
    throw socketError ?? error
  } finally {
    client.disconnect()
  }
}

export function redisFailureLine(url: string, error: unknown): string {
  return `Dependency error: cannot reach Redis at ${redactUrl(url)} (REDIS_URL): ${errorMessage(error)}. Fix: start Redis (for example \`${REDIS_DOCKER_COMMAND}\`) or set REDIS_URL.`
}

export function checkConfig(source: Source): CheckResult[] {
  const result = validateEnv(source)
  if (result.ok) return [pass('config', 'required settings are present and valid')]
  return result.errors.map((line) => fail('config', line.replace(/^Configuration error: /, '')))
}

function readable(path: string): boolean {
  try {
    accessSync(path, fsConstants.R_OK)
    return true
  } catch {
    return false
  }
}

export function checkTls(source: Source, now = new Date()): CheckResult {
  const certPath = source['TLS_CERT_PATH']?.trim()
  const keyPath = source['TLS_KEY_PATH']?.trim()
  if (!certPath && !keyPath) {
    return warn('tls', 'TLS is off; the server speaks plain HTTP. Keep it on loopback or behind a TLS reverse proxy, or set TLS_CERT_PATH and TLS_KEY_PATH.')
  }
  if (!certPath || !keyPath) {
    return fail('tls', `${certPath ? 'TLS_KEY_PATH' : 'TLS_CERT_PATH'} is not set. Fix: set both TLS_CERT_PATH and TLS_KEY_PATH, or neither.`)
  }
  for (const [name, path] of [['TLS_CERT_PATH', certPath], ['TLS_KEY_PATH', keyPath]] as const) {
    if (!existsSync(resolve(path))) return fail('tls', `${name} points to ${resolve(path)}, which does not exist.`)
    if (!readable(resolve(path))) return fail('tls', `${name} points to ${resolve(path)}, which is not readable by this user.`)
  }
  try {
    const cert = new X509Certificate(readFileSync(resolve(certPath)))
    const key = createPrivateKey(readFileSync(resolve(keyPath)))
    if (!cert.checkPrivateKey(key)) return fail('tls', 'TLS_KEY_PATH does not match the certificate in TLS_CERT_PATH.')
    const expires = new Date(cert.validTo)
    if (expires <= now) return fail('tls', `the TLS certificate expired on ${expires.toISOString()}. Fix: renew it.`)
    const days = Math.floor((expires.getTime() - now.getTime()) / 86_400_000)
    if (days < 14) return warn('tls', `the TLS certificate expires in ${days} day(s) (${expires.toISOString()}).`)
    return pass('tls', `certificate for ${cert.subject.replace(/\n/g, ', ')} valid until ${expires.toISOString()}`)
  } catch (error) {
    return fail('tls', `cannot load the TLS certificate or key: ${errorMessage(error)}`)
  }
}

function nearestExisting(path: string): string {
  let current = path
  while (!existsSync(current)) {
    const parent = dirname(current)
    if (parent === current) break
    current = parent
  }
  return current
}

export function checkDataDirs(source: Source): CheckResult[] {
  return writableDirs(source).map((dir) => {
    if (existsSync(dir)) {
      try {
        accessSync(dir, fsConstants.W_OK)
        return pass('data dir', `${dir} is writable`)
      } catch {
        return fail('data dir', `${dir} is not writable by this user. Fix: change its ownership or point DATABASE_URL / AUDIT_LOG_DIR / IAM_DATA_DIR elsewhere.`)
      }
    }
    const ancestor = nearestExisting(dir)
    try {
      accessSync(ancestor, fsConstants.W_OK)
      return pass('data dir', `${dir} will be created (mode 0700) on first start`)
    } catch {
      return fail('data dir', `${dir} does not exist and cannot be created (${ancestor} is not writable).`)
    }
  })
}

function publicSpki(pem: string): string {
  try {
    return createPublicKey(pem).export({ type: 'spki', format: 'pem' }).toString()
  } catch {
    return createPublicKey(createPrivateKey(pem)).export({ type: 'spki', format: 'pem' }).toString()
  }
}

export function checkSigningKeys(source: Source, managed: boolean): CheckResult[] {
  const privatePath = source['JWT_PRIVATE_KEY_PATH']
  const publicPath = source['JWT_PUBLIC_KEY_PATH']
  if (!privatePath || !publicPath) return [] // reported by the config check
  const privateFile = resolve(privatePath)
  const publicFile = resolve(publicPath)
  const results: CheckResult[] = []
  const privateExists = existsSync(privateFile)
  const publicExists = existsSync(publicFile)
  if (!privateExists && !publicExists && managed) {
    results.push(pass('signing keys', `an RS256 key pair will be generated in ${dirname(privateFile)} on first start`))
  } else if (!privateExists || !publicExists) {
    const missing = !privateExists ? ['JWT_PRIVATE_KEY_PATH', privateFile] : ['JWT_PUBLIC_KEY_PATH', publicFile]
    results.push(fail('signing keys', `${missing[0]} points to ${missing[1]}, which does not exist.`))
  } else {
    try {
      const privateKey = createPrivateKey(readFileSync(privateFile))
      if (privateKey.asymmetricKeyType !== 'rsa') {
        results.push(fail('signing keys', `JWT_PRIVATE_KEY_PATH is a ${privateKey.asymmetricKeyType ?? 'non-RSA'} key; RS256 needs RSA.`))
      } else if (publicSpki(readFileSync(privateFile, 'utf8')) !== publicSpki(readFileSync(publicFile, 'utf8'))) {
        results.push(fail('signing keys', 'JWT_PRIVATE_KEY_PATH and JWT_PUBLIC_KEY_PATH are not a matching key pair.'))
      } else {
        const bits = privateKey.asymmetricKeyDetails?.modulusLength
        results.push(pass('signing keys', `RS256 key pair loaded${bits ? ` (${bits}-bit)` : ''}`))
      }
    } catch (error) {
      results.push(fail('signing keys', `cannot load the JWT signing keys: ${errorMessage(error)}`))
    }
  }
  const previous = (source['JWT_PREVIOUS_PUBLIC_KEY_PATHS'] ?? '').split(',').map((entry) => entry.trim()).filter(Boolean)
  for (const path of previous) {
    try {
      publicSpki(readFileSync(resolve(path), 'utf8'))
    } catch (error) {
      results.push(fail('signing keys', `JWT_PREVIOUS_PUBLIC_KEY_PATHS entry ${resolve(path)} cannot be loaded: ${errorMessage(error)}`))
    }
  }
  return results
}

export function checkDatabase(source: Source): CheckResult {
  const url = source['DATABASE_URL']
  if (!url) return fail('database', 'DATABASE_URL is not set.')
  try {
    const path = sqlitePathFromUrl(url)
    const plan = planMigrations(path, MIGRATIONS_DIR)
    if (!plan.databaseExists) return pass('database', `${path} will be created and migrated on first start`)
    const suffix = plan.warnings.length > 0 ? `; ${plan.warnings.join(' ')}` : ''
    if (plan.pending.length > 0) {
      return warn('database', `${plan.applied.length} migration(s) applied, ${plan.pending.length} pending (applied by \`hive-iam-server start\` or \`migrate\`)${suffix}`)
    }
    return (plan.warnings.length > 0 ? warn : pass)('database', `schema up to date (${plan.applied.length} migrations)${suffix}`)
  } catch (error) {
    return fail('database', errorMessage(error))
  }
}

export async function checkRedis(source: Source): Promise<CheckResult> {
  const url = source['REDIS_URL'] || 'redis://localhost:6379'
  try {
    await pingRedis(url)
    return pass('redis', `${redactUrl(url)} answered PING`)
  } catch (error) {
    return fail('redis', redisFailureLine(url, error).replace(/^Dependency error: /, ''))
  }
}

export async function runChecks(source: Source, managedSigningKeys: boolean): Promise<CheckResult[]> {
  return [
    ...checkConfig(source),
    checkTls(source),
    ...checkDataDirs(source),
    ...checkSigningKeys(source, managedSigningKeys),
    checkDatabase(source),
    await checkRedis(source),
  ]
}
