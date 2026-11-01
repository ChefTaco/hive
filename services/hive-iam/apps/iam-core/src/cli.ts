#!/usr/bin/env node
// hive-iam-server: npm/Docker entry point. Server modules read the
// configuration when they are imported, so they are loaded only after the
// env files, defaults and preflight checks below have run.
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { validateEnv } from './config/env-schema.js'
import { IAM_VERSION } from './config/version.js'
import { parseArgs, USAGE, UsageError, type CliOptions } from './cli/args.js'
import { bootstrapDatabase } from './cli/bootstrap.js'
import { applyCliDefaults, dropEmptyValues, ensurePrivateDirs, ensureSigningKeys, writableDirs, type CliDefaults } from './cli/defaults.js'
import { buildEnvSchemaDocument } from './cli/env-doc.js'
import { applyMigrations, needsBootstrap, planMigrations } from './cli/migrate.js'
import { MIGRATIONS_DIR, PACKAGE_ROOT, RESET_ADMIN_SCRIPT, sqlitePathFromUrl } from './cli/paths.js'
import { checkSigningKeys, checkTls, pingRedis, redisFailureLine, runChecks } from './cli/preflight.js'
import { captureCheck, delegate, extraArguments, guardedMigration, home, migrationFlags, migrationReview, ownRelease, storeSpec } from './release/runtime.js'
import { dirname, join } from 'node:path'

class FatalError extends Error {}

function fatal(...lines: string[]): never {
  throw new FatalError(lines.join('\n'))
}

function loadEnvFiles(paths: readonly string[]): void {
  for (const path of paths) {
    const absolute = resolve(path)
    if (!existsSync(absolute)) fatal(`Configuration error: env file ${absolute} (--env-file) does not exist. Fix: create it or pass the correct path.`)
    try {
      process.loadEnvFile(absolute)
    } catch (error) {
      fatal(`Configuration error: cannot read env file ${absolute} (--env-file): ${error instanceof Error ? error.message : String(error)}`)
    }
  }
}

function prepareConfig(options: CliOptions, writes = true): CliDefaults {
  // Database, keys, backups and audit logs are owner-only, matching the
  // UMask=0077 of the systemd unit.
  if (writes) process.umask(0o077)
  loadEnvFiles(options.envFiles)
  dropEmptyValues(process.env)
  return applyCliDefaults(process.env)
}

function requireValidConfig(): void {
  const validation = validateEnv(process.env)
  if (!validation.ok) fatal(...validation.errors)
}

function databasePath(): string {
  return sqlitePathFromUrl(process.env['DATABASE_URL']!)
}

async function requireRedis(): Promise<void> {
  const url = process.env['REDIS_URL'] || 'redis://localhost:6379'
  try {
    await pingRedis(url)
  } catch (error) {
    fatal(redisFailureLine(url, error))
  }
}

/** Shared by `start` and `migrate`: directories, keys, migrations, first-start seed. */
async function prepareData(defaults: CliDefaults, migrate: boolean): Promise<void> {
  if (migrate && process.env.HIVE_AUTO_MIGRATE !== 'true' && planMigrations(databasePath(), MIGRATIONS_DIR).pending.length)
    fatal('Pending migrations; run hive-iam-server migrate before starting (HIVE_AUTO_MIGRATE=false)')
  ensurePrivateDirs(writableDirs(process.env))
  const existing = existsSync(databasePath())
  if (existsSync(join(defaults.dataDir, '.initialized')) && !existing) fatal('Existing IAM database is missing; restore it instead of initializing a replacement')
  if (defaults.managedSigningKeys) {
    try {
      if (existing && (!existsSync(process.env['JWT_PRIVATE_KEY_PATH']!) || !existsSync(process.env['JWT_PUBLIC_KEY_PATH']!))) fatal('Existing IAM signing keys are missing; restore them from backup')
      const state = ensureSigningKeys(process.env['JWT_PRIVATE_KEY_PATH']!, process.env['JWT_PUBLIC_KEY_PATH']!)
      if (state === 'generated') console.log(`  ✓ Generated RS256 signing key pair in ${resolve(process.env['JWT_PRIVATE_KEY_PATH']!, '..')}`)
    } catch (error) {
      fatal(`Startup error: ${error instanceof Error ? error.message : String(error)}`)
    }
  } else {
    const failed = checkSigningKeys(process.env, false).filter((result) => result.status === 'fail')
    if (failed.length > 0) fatal(...failed.map((result) => `Configuration error: ${result.message}`))
  }

  const dbPath = databasePath()
  if (migrate) {
    const result = await guardedMigration({ service: 'iam', spec: storeSpec('iam', process.env, home()), lock: `${dbPath}.migration.lock`, pending: () => planMigrations(dbPath, MIGRATIONS_DIR).pending.length > 0, automatic: true, release: ownRelease(PACKAGE_ROOT), apply: () => applyMigrations(dbPath, MIGRATIONS_DIR) }).catch((error: unknown) => fatal(`Database error: ${error instanceof Error ? error.message : String(error)}`))
    if (result) {
    for (const warning of result.warnings) console.warn(`  ! ${warning}`)
    if (result.backupPath) console.log(`  ✓ Backed up the database to ${result.backupPath}`)
    if (result.appliedNow.length > 0) console.log(`  ✓ Applied ${result.appliedNow.length} migration(s) to ${dbPath}`)
    else console.log(`  ✓ Database schema up to date (${dbPath})`)
    }
  } else {
    const plan = (() => {
      try {
        return planMigrations(dbPath, MIGRATIONS_DIR)
      } catch (error) {
        return fatal(`Database error: ${error instanceof Error ? error.message : String(error)}`)
      }
    })()
    if (plan.pending.length > 0) fatal(`Database error: ${plan.pending.length} migration(s) pending and --no-migrate was given. Fix: run \`hive-iam-server migrate\` first.`)
  }

  if (needsBootstrap(dbPath)) {
    if (existing || process.env['HIVE_UPGRADE_TRANSACTION']) fatal('IAM has no users; upgrades never reseed an existing database')
    console.log('  … Empty database: creating roles, the initial admin account and the built-in clients')
    const result = await bootstrapDatabase(dbPath, process.env).catch((error: unknown) => fatal(`Bootstrap error: ${error instanceof Error ? error.message : String(error)}`))
    console.log(`  ✓ Initial admin account: ${result.adminUsername} (${result.adminEmail})`)
    if (result.credentialsFile) {
      console.log(`  ✓ Generated ${result.generated.join(', ')}; stored in ${result.credentialsFile} (mode 0600).`)
      console.log('    Copy them somewhere safe, change the admin password after the first login, then delete that file.')
    }
  }
  const { writeJson } = await import('./release/runtime.js')
  writeJson(join(defaults.dataDir, '.initialized'), { initialized: true })
}

async function commandStart(options: CliOptions): Promise<void> {
  const defaults = prepareConfig(options)
  requireValidConfig()
  const tls = checkTls(process.env)
  if (tls.status === 'fail') fatal(`Configuration error: ${tls.message}`)
  console.log(`Hive IAM ${IAM_VERSION}: data in ${defaults.dataDir}`)
  await requireRedis()
  await prepareData(defaults, options.migrate && process.env['HIVE_AUTO_MIGRATE'] === 'true')
  const { startServer } = await import('./main.js')
  await startServer()
}

async function commandMigrate(options: CliOptions): Promise<void> {
  const defaults = prepareConfig(options)
  requireValidConfig()
  await prepareData(defaults, true)
}

async function commandCheck(options: CliOptions): Promise<number> {
  const defaults = prepareConfig(options, false)
  const results = await runChecks(process.env, defaults.managedSigningKeys)
  const symbol = { pass: '✓', warn: '!', fail: '✗' } as const
  console.log(`Hive IAM ${IAM_VERSION} configuration check`)
  for (const result of results) console.log(`  ${symbol[result.status]} ${result.name.padEnd(13)} ${result.message}`)
  const failures = results.filter((result) => result.status === 'fail').length
  console.log(failures === 0 ? 'Result: OK' : `Result: ${failures} problem(s) found`)
  await (await import('./release/runtime.js')).printUpdateNotice(IAM_VERSION)
  return failures === 0 ? 0 : 1
}

async function commandResetAdmin(options: CliOptions): Promise<number> {
  prepareConfig(options)
  if (!existsSync(databasePath())) fatal(`Database error: ${databasePath()} does not exist. Fix: start the server once (or run \`hive-iam-server migrate\`) first.`)
  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, [RESET_ADMIN_SCRIPT], {
      cwd: PACKAGE_ROOT,
      env: { ...process.env, DOTENV_CONFIG_QUIET: 'true' },
      stdio: 'inherit',
    })
    child.on('error', reject)
    child.on('close', (code) => resolvePromise(code ?? 1))
  })
}

async function run(argv: readonly string[]): Promise<number> {
  const extra = extraArguments(argv)
  if (extra) {
    loadEnvFiles(extra.envFiles)
    if (extra.command !== 'migrate') return delegate([extra.command, ...extra.rest])
    applyCliDefaults(process.env)
    const flags = migrationFlags(extra.rest)
    if (flags.plan) { console.log(JSON.stringify({ ...planMigrations(databasePath(), MIGRATIONS_DIR), ...migrationReview(ownRelease(PACKAGE_ROOT), 'iam') })); return 0 }
    const dbPath = databasePath(); ensurePrivateDirs([dirname(dbPath)])
    await guardedMigration({ service: 'iam', spec: storeSpec('iam', process.env, home()), lock: `${dbPath}.migration.lock`, pending: () => planMigrations(dbPath, MIGRATIONS_DIR).pending.length > 0, release: ownRelease(PACKAGE_ROOT), ...(flags.backupDir ? { backupDir: flags.backupDir } : {}), ...(flags.confirmPlan ? { confirmPlan: flags.confirmPlan } : {}), apply: () => applyMigrations(dbPath, MIGRATIONS_DIR) })
    return 0
  }
  const jsonCheck = argv.includes('check') && argv.includes('--json')
  if (jsonCheck) argv = argv.filter(arg => arg !== '--json')
  const options = parseArgs(argv)
  switch (options.command) {
    case 'help':
      process.stdout.write(USAGE)
      return 0
    case 'version':
      console.log(IAM_VERSION)
      return 0
    case 'env-schema':
      console.log(JSON.stringify(buildEnvSchemaDocument(), null, 2))
      return 0
    case 'check':
      return jsonCheck ? captureCheck(() => commandCheck(options)) : commandCheck(options)
    case 'migrate':
      await commandMigrate(options)
      return 0
    case 'reset-admin':
      return commandResetAdmin(options)
    case 'start':
      await commandStart(options)
      return -1 // keep running
  }
}

run(process.argv.slice(2)).then(
  (code) => {
    if (code >= 0) process.exit(code)
  },
  (error: unknown) => {
    if (error instanceof UsageError) {
      console.error(`hive-iam-server: ${error.message}. Run \`hive-iam-server --help\` for usage.`)
      process.exit(2)
    }
    if (error instanceof FatalError) {
      console.error(error.message)
      process.exit(1)
    }
    if (process.env['HIVE_DEBUG']) console.error(error)
    else console.error(`Startup error: ${error instanceof Error ? error.message : String(error)} (set HIVE_DEBUG=1 for details)`)
    process.exit(1)
  },
)
