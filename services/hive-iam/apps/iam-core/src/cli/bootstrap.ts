import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { parseEnv } from 'node:util'
import { PACKAGE_ROOT, SEED_SCRIPT } from './paths.js'

type Source = Record<string, string | undefined>

/**
 * First-start inputs the seed needs. Any that are unset are generated and
 * handed to the operator through an owner-only file next to the database;
 * they are never printed.
 */
export const BOOTSTRAP_SECRETS = [
  { name: 'SEED_ADMIN_PASSWORD', minLength: 16 },
  { name: 'SEED_HIVE_CLIENT_SECRET', minLength: 32 },
  { name: 'SEED_HIVE_ROUTER_CLIENT_SECRET', minLength: 32 },
] as const

export interface BootstrapResult {
  adminUsername: string
  adminEmail: string
  generated: string[]
  credentialsFile: string | null
}

function generateSecret(): string {
  return randomBytes(32).toString('base64url')
}

export function credentialsFilePath(databasePath: string): string {
  return join(dirname(databasePath), 'initial-credentials.env')
}

/**
 * Fill missing first-start secrets. Values from an earlier, interrupted
 * attempt (`previous`) are reused so a retry never orphans credentials that
 * may already have been seeded.
 */
export function prepareBootstrapEnv(source: Source, previous: Source = {}): { env: Source; generated: string[] } {
  const env: Source = { ...source }
  const generated: string[] = []
  for (const { name, minLength } of BOOTSTRAP_SECRETS) {
    const value = env[name]
    if (value === undefined || value === '') {
      env[name] = previous[name] || generateSecret()
      generated.push(name)
    } else if (value.length < minLength) {
      throw new Error(`Configuration error: ${name} must contain at least ${minLength} characters. Fix: set a longer value, or unset it to have one generated on first start.`)
    }
  }
  return { env, generated }
}

function writeCredentialsFile(path: string, env: Source, generated: string[]): void {
  const lines = [
    '# Hive IAM initial credentials, generated on first start.',
    '# Store these somewhere safe, change the admin password after the first login,',
    '# then delete this file.',
    `SEED_ADMIN_USERNAME=${env['SEED_ADMIN_USERNAME'] ?? 'admin'}`,
    `SEED_ADMIN_EMAIL=${env['SEED_ADMIN_EMAIL'] ?? 'admin@iam.local'}`,
    ...generated.map((name) => `${name}=${env[name] ?? ''}`),
    '',
  ]
  writeFileSync(path, lines.join('\n'), { mode: 0o600 })
}

function runSeed(env: Source): Promise<void> {
  if (!existsSync(SEED_SCRIPT)) {
    return Promise.reject(new Error(`The compiled seed is missing at ${SEED_SCRIPT}; reinstall the package.`))
  }
  return new Promise((resolvePromise, reject) => {
    // cwd is the package root so the seed's dotenv import cannot pick up an
    // unrelated .env from the operator's working directory.
    const child = spawn(process.execPath, [SEED_SCRIPT], {
      cwd: PACKAGE_ROOT,
      env: { ...env, DOTENV_CONFIG_QUIET: 'true' },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stderr = ''
    child.stdout.on('data', (chunk: Buffer) => {
      for (const line of chunk.toString('utf8').split('\n')) {
        if (line.trim()) console.log(`  ${line.trim()}`)
      }
    })
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8') })
    child.on('error', reject)
    child.on('close', (code) => {
      if (code === 0) return resolvePromise()
      const firstLine = stderr.split('\n').map((line) => line.trim()).find((line) => line.length > 0) ?? `exit code ${code}`
      reject(new Error(firstLine.replace(/^Error:\s*/, '')))
    })
  })
}

/**
 * Seed roles, the initial SUPER_ADMIN account and the built-in Hive clients.
 * Runs the same seed the production deploy uses (prisma/seed.ts, compiled).
 */
export async function bootstrapDatabase(databasePath: string, source: Source = process.env): Promise<BootstrapResult> {
  const credentialsFile = credentialsFilePath(databasePath)
  const previous: Source = existsSync(credentialsFile) ? parseEnv(readFileSync(credentialsFile, 'utf8')) : {}
  const { env, generated } = prepareBootstrapEnv(source, previous)
  // Persist generated values before seeding so they survive a failed attempt.
  if (generated.length > 0) writeCredentialsFile(credentialsFile, env, generated)
  await runSeed(env)
  return {
    adminUsername: env['SEED_ADMIN_USERNAME'] ?? 'admin',
    adminEmail: env['SEED_ADMIN_EMAIL'] ?? 'admin@iam.local',
    generated,
    credentialsFile: generated.length > 0 ? credentialsFile : null,
  }
}
