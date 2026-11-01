import { DatabaseSync } from 'node:sqlite';

export function initializeSchema(db: DatabaseSync): void {
  db.exec(`
  PRAGMA journal_mode = WAL;
  CREATE TABLE IF NOT EXISTS skills (
    slug TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT NOT NULL, homepage TEXT,
    enabled INTEGER NOT NULL DEFAULT 1 CHECK(enabled IN (0, 1)), created_at TEXT NOT NULL, updated_at TEXT NOT NULL
  ) STRICT;
  CREATE TABLE IF NOT EXISTS releases (
    skill_slug TEXT NOT NULL REFERENCES skills(slug) ON DELETE CASCADE, version TEXT NOT NULL,
    sha256 TEXT NOT NULL, archive_path TEXT NOT NULL, notes TEXT, created_at TEXT NOT NULL,
    min_hermes_version TEXT, max_hermes_version TEXT,
    PRIMARY KEY(skill_slug, version)
  ) STRICT;
  CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY, username TEXT NOT NULL, expires_at TEXT NOT NULL, created_at TEXT NOT NULL
  ) STRICT;
  CREATE TABLE IF NOT EXISTS deployment_targets (
    name TEXT PRIMARY KEY, host TEXT NOT NULL, username TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1 CHECK(enabled IN (0, 1))
  ) STRICT;
  CREATE TABLE IF NOT EXISTS channel_releases (
    channel TEXT NOT NULL CHECK(channel IN ('stable','canary')), skill_slug TEXT NOT NULL REFERENCES skills(slug) ON DELETE CASCADE,
    version TEXT NOT NULL, PRIMARY KEY(channel,skill_slug), FOREIGN KEY(skill_slug,version) REFERENCES releases(skill_slug,version)
  ) STRICT;
  CREATE TABLE IF NOT EXISTS target_policies (
    target TEXT PRIMARY KEY REFERENCES deployment_targets(name), channel TEXT NOT NULL CHECK(channel IN ('stable','canary')),
    token_hash TEXT NOT NULL, skills_json TEXT, receipt_json TEXT, updated_at TEXT NOT NULL
  ) STRICT;
  CREATE TABLE IF NOT EXISTS registry_migrations (id TEXT PRIMARY KEY) STRICT;
  CREATE TABLE IF NOT EXISTS deployment_jobs (
    id TEXT PRIMARY KEY, target TEXT NOT NULL, actor TEXT NOT NULL, status TEXT NOT NULL,
    result TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
  ) STRICT;
  CREATE TABLE IF NOT EXISTS audit_log (
    id INTEGER PRIMARY KEY, actor TEXT NOT NULL, action TEXT NOT NULL, subject TEXT NOT NULL, details TEXT NOT NULL, created_at TEXT NOT NULL
  ) STRICT;
`);

  const releaseColumns = new Set(
    (db.prepare('PRAGMA table_info(releases)').all() as Array<{ name: string }>).map(
      (column) => column.name,
    ),
  );
  if (!releaseColumns.has('min_hermes_version'))
    db.exec('ALTER TABLE releases ADD COLUMN min_hermes_version TEXT');
  if (!releaseColumns.has('max_hermes_version'))
    db.exec('ALTER TABLE releases ADD COLUMN max_hermes_version TEXT');

  // Preserve the currently published version during the first channel migration.
  if (!db.prepare("SELECT id FROM registry_migrations WHERE id='release-channels'").get()) {
    db.exec('BEGIN IMMEDIATE');
    try {
      db.exec(
        "INSERT OR IGNORE INTO channel_releases SELECT 'stable', skill_slug, version FROM releases r WHERE created_at=(SELECT MAX(created_at) FROM releases WHERE skill_slug=r.skill_slug)",
      );
      db.exec("INSERT INTO registry_migrations VALUES ('release-channels'); COMMIT");
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }
}
