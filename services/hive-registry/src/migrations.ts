import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';

// Immutable: an applied migration's checksum is verified on every open. Never edit an
// entry; append a new one. A pinned checksum test fails if an entry changes.
export const migrations: ReadonlyArray<{ id: string; sql: string }> = [
  {
    id: '0001_initial',
    sql: `
CREATE TABLE installation (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  id TEXT NOT NULL,
  origin TEXT NOT NULL,
  profile TEXT NOT NULL,
  release_version TEXT NOT NULL,
  manifest_digest TEXT NOT NULL,
  plan_digest TEXT NOT NULL,
  phase TEXT NOT NULL CHECK (phase IN ('activating', 'complete')),
  revision INTEGER NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;
CREATE TABLE catalog_products (
  id TEXT PRIMARY KEY,
  source TEXT NOT NULL CHECK (source IN ('release', 'external')),
  kind TEXT NOT NULL,
  display_name TEXT NOT NULL,
  description TEXT NOT NULL,
  repository_url TEXT,
  documentation_url TEXT,
  license_url TEXT,
  license_spdx TEXT,
  console_section TEXT,
  required INTEGER NOT NULL CHECK (required IN (0, 1)),
  dependencies_json TEXT NOT NULL,
  public INTEGER NOT NULL CHECK (public IN (0, 1)),
  offered INTEGER NOT NULL CHECK (offered IN (0, 1)),
  updated_at TEXT NOT NULL
) STRICT;
CREATE TABLE catalog_versions (
  product_id TEXT NOT NULL REFERENCES catalog_products(id) ON DELETE CASCADE,
  version TEXT NOT NULL,
  image TEXT NOT NULL,
  image_digest TEXT NOT NULL,
  storage_format TEXT,
  release_version TEXT NOT NULL,
  recorded_at TEXT NOT NULL,
  PRIMARY KEY (product_id, version, image_digest)
) STRICT;
CREATE TABLE installed_products (
  product_id TEXT PRIMARY KEY REFERENCES catalog_products(id) ON DELETE CASCADE,
  inventory_host TEXT,
  version TEXT,
  image TEXT,
  image_digest TEXT,
  status TEXT NOT NULL CHECK (status IN ('activating', 'installed', 'external')),
  installed_at TEXT,
  updated_at TEXT NOT NULL,
  release_version TEXT,
  connection_json TEXT NOT NULL
) STRICT;
CREATE TABLE history (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  recorded_at TEXT NOT NULL,
  actor TEXT NOT NULL,
  operation TEXT NOT NULL,
  subject TEXT NOT NULL,
  change_json TEXT NOT NULL
) STRICT;
CREATE TRIGGER history_append_only_update BEFORE UPDATE ON history BEGIN SELECT RAISE(ABORT, 'history is append-only'); END;
CREATE TRIGGER history_append_only_delete BEFORE DELETE ON history BEGIN SELECT RAISE(ABORT, 'history is append-only'); END;
`,
  },
];

export const checksum = (sql: string): string => createHash('sha256').update(sql).digest('hex');

export class PendingMigrations extends Error {
  constructor(public readonly pending: string[]) {
    super(`Hive Registry schema has pending migrations: ${pending.join(', ')}`);
  }
}

function applied(db: DatabaseSync): Map<string, string> {
  db.exec('CREATE TABLE IF NOT EXISTS schema_migrations (id TEXT PRIMARY KEY, sha256 TEXT NOT NULL, applied_at TEXT NOT NULL) STRICT');
  const rows = db.prepare('SELECT id, sha256 FROM schema_migrations').all() as Array<{ id: string; sha256: string }>;
  return new Map(rows.map((row) => [row.id, row.sha256]));
}

/**
 * Verifies recorded migrations and applies pending ones. An empty database always gets
 * its baseline: a release that adds the registry to an existing installation starts it
 * with automatic migrations disabled. Existing data changes only when explicitly allowed.
 */
export function migrate(db: DatabaseSync, allowExisting: boolean, now = (): string => new Date().toISOString()): string[] {
  const recorded = applied(db);
  const known = new Map(migrations.map((entry) => [entry.id, checksum(entry.sql)]));
  for (const [id, sha] of recorded) {
    const expected = known.get(id);
    if (!expected) throw new Error(`Hive Registry data has an unknown migration ${id}; this image is older than the data`);
    if (expected !== sha) throw new Error(`Hive Registry migration ${id} changed after it was applied`);
  }
  const pending = migrations.filter((entry) => !recorded.has(entry.id));
  if (pending.length && recorded.size && !allowExisting) throw new PendingMigrations(pending.map((entry) => entry.id));
  for (const entry of pending) {
    db.exec('BEGIN IMMEDIATE');
    try {
      db.exec(entry.sql);
      db.prepare('INSERT INTO schema_migrations VALUES (?, ?, ?)').run(entry.id, checksum(entry.sql), now());
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }
  return pending.map((entry) => entry.id);
}
