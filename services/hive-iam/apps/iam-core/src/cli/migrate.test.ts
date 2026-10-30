import { createHash } from 'node:crypto'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { afterEach, describe, expect, it } from 'vitest'
import { applyMigrations, needsBootstrap, planMigrations, readLocalMigrations } from './migrate.js'
import { MIGRATIONS_DIR } from './paths.js'

const temps: string[] = []
function temp(): string {
  const dir = mkdtempSync(join(tmpdir(), 'hive-iam-migrate-'))
  temps.push(dir)
  return dir
}
afterEach(() => {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function copyMigrations(count: number): string {
  const dir = join(temp(), 'migrations')
  mkdirSync(dir)
  for (const name of readLocalMigrations(MIGRATIONS_DIR).map((m) => m.name).slice(0, count)) {
    cpSync(join(MIGRATIONS_DIR, name), join(dir, name), { recursive: true })
  }
  return dir
}

function rows(path: string) {
  const db = new Database(path, { readonly: true })
  try {
    return db.prepare('SELECT * FROM "_prisma_migrations" ORDER BY migration_name').all() as Record<string, unknown>[]
  } finally {
    db.close()
  }
}

describe('bundled migrator', () => {
  const local = readLocalMigrations(MIGRATIONS_DIR)

  it('creates a fresh database with Prisma-compatible history', async () => {
    const path = join(temp(), 'iam.db')
    expect(planMigrations(path, MIGRATIONS_DIR)).toMatchObject({ databaseExists: false, pending: local.map((m) => m.name) })
    expect(existsSync(path)).toBe(false)

    const result = await applyMigrations(path, MIGRATIONS_DIR)
    expect(result.appliedNow).toEqual(local.map((m) => m.name))
    expect(result.backupPath).toBeNull()

    const history = rows(path)
    expect(history).toHaveLength(local.length)
    for (const [index, row] of history.entries()) {
      const migration = local[index]!
      expect(row['migration_name']).toBe(migration.name)
      expect(row['checksum']).toBe(createHash('sha256').update(migration.sql).digest('hex'))
      expect(typeof row['finished_at']).toBe('number')
      expect(typeof row['started_at']).toBe('number')
      expect(row['applied_steps_count']).toBe(1)
      expect(row['rolled_back_at']).toBeNull()
    }
    expect(needsBootstrap(path)).toBe(true)

    const again = await applyMigrations(path, MIGRATIONS_DIR)
    expect(again.appliedNow).toEqual([])
    expect(planMigrations(path, MIGRATIONS_DIR).pending).toEqual([])
  })

  it('upgrades an older database after taking a backup', async () => {
    const path = join(temp(), 'iam.db')
    await applyMigrations(path, copyMigrations(3))
    const result = await applyMigrations(path, MIGRATIONS_DIR)
    expect(result.appliedNow).toEqual(local.slice(3).map((m) => m.name))
    expect(result.backupPath).toMatch(/iam\.db\.pre-migrate-\d{8}T\d{6}Z\.bak$/)
    expect(statSync(result.backupPath!).mode & 0o777).toBe(0o600)
    expect(rows(result.backupPath!)).toHaveLength(3)
    expect(rows(path)).toHaveLength(local.length)
  })

  it('rolls back a failing migration and records nothing', async () => {
    const dir = copyMigrations(local.length)
    mkdirSync(join(dir, '99990101000000_broken'))
    writeFileSync(join(dir, '99990101000000_broken', 'migration.sql'), 'CREATE TABLE "partial" ("id" TEXT);\nALTER TABLE "missing" ADD COLUMN "x" TEXT;\n')
    const path = join(temp(), 'iam.db')
    await expect(applyMigrations(path, dir)).rejects.toThrow(/99990101000000_broken failed and was rolled back/)
    const db = new Database(path, { readonly: true })
    try {
      expect(db.prepare(`SELECT 1 FROM sqlite_master WHERE name = 'partial'`).get()).toBeUndefined()
    } finally {
      db.close()
    }
    expect(rows(path).map((row) => row['migration_name'])).toEqual(local.map((m) => m.name))
  })

  it('refuses databases it cannot reason about', async () => {
    const foreign = join(temp(), 'other.db')
    const db = new Database(foreign)
    db.exec('CREATE TABLE notes (id INTEGER PRIMARY KEY)')
    db.close()
    await expect(applyMigrations(foreign, MIGRATIONS_DIR)).rejects.toThrow(/no migration history/)

    const newer = join(temp(), 'iam.db')
    await applyMigrations(newer, MIGRATIONS_DIR)
    const writable = new Database(newer)
    writable.prepare(`INSERT INTO "_prisma_migrations" (id, checksum, finished_at, migration_name, started_at, applied_steps_count) VALUES ('x', 'y', 1, '99990101000000_future', 1, 1)`).run()
    writable.prepare(`INSERT INTO "_prisma_migrations" (id, checksum, finished_at, migration_name, started_at, applied_steps_count) VALUES ('z', 'y', NULL, '00000000000000_failed', 1, 0)`).run()
    writable.close()
    await expect(applyMigrations(newer, MIGRATIONS_DIR)).rejects.toThrow(/previously failed/)

    const fresh = new Database(newer)
    fresh.prepare(`DELETE FROM "_prisma_migrations" WHERE id = 'z'`).run()
    fresh.close()
    await expect(applyMigrations(newer, MIGRATIONS_DIR)).rejects.toThrow(/newer IAM release/)
    expect(readdirSync(join(newer, '..')).filter((name) => name.includes('pre-migrate'))).toEqual([])
  })

  it('warns when an applied migration was edited', async () => {
    const dir = copyMigrations(local.length)
    const path = join(temp(), 'iam.db')
    await applyMigrations(path, dir)
    const first = local[0]!.name
    writeFileSync(join(dir, first, 'migration.sql'), `${local[0]!.sql}\n-- edited\n`)
    expect(planMigrations(path, dir).warnings).toEqual([`Migration ${first} was modified after it was applied (checksum differs).`])
  })
})
