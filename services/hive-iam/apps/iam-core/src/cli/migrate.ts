import { createHash, randomUUID } from 'node:crypto'
import { chmodSync, existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import Database from 'better-sqlite3'

/**
 * Applies the bundled Prisma migrations without the Prisma CLI, so npm and
 * Docker installs need no devDependencies. Applied migrations are recorded in
 * Prisma's own `_prisma_migrations` table with the same checksum (SHA-256 of
 * migration.sql) and millisecond timestamps, so `prisma migrate deploy` and
 * `prisma migrate status` see the same history.
 *
 * Each migration runs in its own IMMEDIATE transaction with foreign-key
 * enforcement disabled around it (the table-redefinition pattern Prisma emits
 * for SQLite drops and recreates referenced tables), followed by a
 * `foreign_key_check`. A failure rolls the whole migration back and records
 * nothing. An existing database is copied to a timestamped backup before the
 * first pending migration is applied.
 */

export interface LocalMigration {
  name: string
  sql: string
  checksum: string
}

export interface MigrationPlan {
  databasePath: string
  databaseExists: boolean
  applied: string[]
  pending: string[]
  warnings: string[]
}

export interface MigrationResult extends MigrationPlan {
  appliedNow: string[]
  backupPath: string | null
}

export class MigrationError extends Error {}

const MIGRATIONS_TABLE_DDL = `CREATE TABLE "_prisma_migrations" (
    "id"                    TEXT PRIMARY KEY NOT NULL,
    "checksum"              TEXT NOT NULL,
    "finished_at"           DATETIME,
    "migration_name"        TEXT NOT NULL,
    "logs"                  TEXT,
    "rolled_back_at"        DATETIME,
    "started_at"            DATETIME NOT NULL DEFAULT current_timestamp,
    "applied_steps_count"   INTEGER UNSIGNED NOT NULL DEFAULT 0
)`

interface AppliedRow {
  migration_name: string
  checksum: string
  finished_at: number | string | null
}

export function readLocalMigrations(migrationsDir: string): LocalMigration[] {
  if (!existsSync(migrationsDir)) {
    throw new MigrationError(`Bundled migrations are missing at ${migrationsDir}; reinstall the package.`)
  }
  return readdirSync(migrationsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && existsSync(join(migrationsDir, entry.name, 'migration.sql')))
    .map((entry) => entry.name)
    .sort()
    .map((name) => {
      const sql = readFileSync(join(migrationsDir, name, 'migration.sql'), 'utf8')
      return { name, sql, checksum: createHash('sha256').update(sql).digest('hex') }
    })
}

function hasMigrationsTable(db: Database.Database): boolean {
  return db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = '_prisma_migrations'`).get() !== undefined
}

function userTables(db: Database.Database): string[] {
  return (db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name <> '_prisma_migrations'`).all() as { name: string }[])
    .map((row) => row.name)
}

function appliedRows(db: Database.Database): AppliedRow[] {
  if (!hasMigrationsTable(db)) return []
  return db.prepare(`SELECT migration_name, checksum, finished_at FROM "_prisma_migrations" WHERE rolled_back_at IS NULL ORDER BY started_at, migration_name`).all() as AppliedRow[]
}

function analyse(db: Database.Database, local: LocalMigration[]): { applied: string[]; pending: LocalMigration[]; warnings: string[] } {
  const warnings: string[] = []
  if (!hasMigrationsTable(db)) {
    const tables = userTables(db)
    if (tables.length > 0) {
      throw new MigrationError(`The database already has tables (${tables.slice(0, 3).join(', ')}${tables.length > 3 ? ', ...' : ''}) but no migration history; refusing to migrate it. Point DATABASE_URL at an IAM database or an empty location.`)
    }
    return { applied: [], pending: local, warnings }
  }

  const rows = appliedRows(db)
  const byName = new Map(local.map((migration) => [migration.name, migration]))
  for (const row of rows) {
    if (row.finished_at === null) {
      throw new MigrationError(`Migration ${row.migration_name} previously failed and is marked unfinished. Restore the database from its backup, or resolve it with \`prisma migrate resolve\`, before starting.`)
    }
    const migration = byName.get(row.migration_name)
    if (!migration) {
      throw new MigrationError(`The database was migrated by a newer IAM release (unknown migration ${row.migration_name}). Upgrade @hivemagnus/hive-iam-server before starting.`)
    }
    if (migration.checksum !== row.checksum) {
      warnings.push(`Migration ${row.migration_name} was modified after it was applied (checksum differs).`)
    }
  }
  const appliedNames = new Set(rows.map((row) => row.migration_name))
  return {
    applied: [...appliedNames],
    pending: local.filter((migration) => !appliedNames.has(migration.name)),
    warnings,
  }
}

/** Read-only status. Never creates the database file. */
export function planMigrations(databasePath: string, migrationsDir: string): MigrationPlan {
  const local = readLocalMigrations(migrationsDir)
  const databaseExists = existsSync(databasePath) && statSync(databasePath).size > 0
  if (!databaseExists) {
    return { databasePath, databaseExists, applied: [], pending: local.map((m) => m.name), warnings: [] }
  }
  const db = new Database(databasePath, { readonly: true, fileMustExist: true })
  try {
    const { applied, pending, warnings } = analyse(db, local)
    return { databasePath, databaseExists, applied, pending: pending.map((m) => m.name), warnings }
  } finally {
    db.close()
  }
}

function backupStamp(): string {
  return new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z')
}

export async function applyMigrations(databasePath: string, migrationsDir: string): Promise<MigrationResult> {
  const local = readLocalMigrations(migrationsDir)
  const databaseExists = existsSync(databasePath) && statSync(databasePath).size > 0
  const db = new Database(databasePath)
  try {
    db.pragma('busy_timeout = 10000')
    const { applied, pending, warnings } = analyse(db, local)
    if (pending.length === 0) {
      return { databasePath, databaseExists, applied, pending: [], warnings, appliedNow: [], backupPath: null }
    }

    let backupPath: string | null = null
    if (databaseExists) {
      backupPath = `${databasePath}.pre-migrate-${backupStamp()}.bak`
      await db.backup(backupPath)
      chmodSync(backupPath, 0o600)
    }

    if (!hasMigrationsTable(db)) db.exec(MIGRATIONS_TABLE_DDL)

    const alreadyApplied = db.prepare(`SELECT 1 FROM "_prisma_migrations" WHERE migration_name = ? AND rolled_back_at IS NULL`)
    const insert = db.prepare(`INSERT INTO "_prisma_migrations" (id, checksum, finished_at, migration_name, logs, rolled_back_at, started_at, applied_steps_count) VALUES (?, ?, ?, ?, NULL, NULL, ?, 1)`)
    const appliedNow: string[] = []

    db.pragma('foreign_keys = OFF')
    try {
      for (const migration of pending) {
        const startedAt = Date.now()
        db.exec('BEGIN IMMEDIATE')
        try {
          // Another process may have applied it while we waited for the lock.
          if (alreadyApplied.get(migration.name) !== undefined) {
            db.exec('ROLLBACK')
            continue
          }
          db.exec(migration.sql)
          const violations = db.pragma('foreign_key_check') as unknown[]
          if (violations.length > 0) {
            throw new MigrationError(`foreign key check failed after ${migration.name} (${violations.length} violation(s))`)
          }
          insert.run(randomUUID(), migration.checksum, Date.now(), migration.name, startedAt)
          db.exec('COMMIT')
          appliedNow.push(migration.name)
        } catch (error) {
          if (db.inTransaction) db.exec('ROLLBACK')
          const detail = error instanceof Error ? error.message : String(error)
          throw new MigrationError(`Migration ${migration.name} failed and was rolled back: ${detail}${backupPath ? ` (pre-migration backup: ${backupPath})` : ''}`)
        }
      }
    } finally {
      db.pragma('foreign_keys = ON')
    }

    return {
      databasePath,
      databaseExists,
      applied: [...applied, ...appliedNow],
      pending: [],
      warnings,
      appliedNow,
      backupPath,
    }
  } finally {
    db.close()
  }
}

/** True when the IAM schema exists but no user account has been created yet. */
export function needsBootstrap(databasePath: string): boolean {
  const db = new Database(databasePath, { readonly: true, fileMustExist: true })
  try {
    const row = db.prepare('SELECT COUNT(*) AS n FROM "users"').get() as { n: number }
    return row.n === 0
  } finally {
    db.close()
  }
}
