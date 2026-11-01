import { env } from './config/env.js';
import { existsSync } from 'node:fs';
import { applyMigrations, planMigrations } from './cli/migrate.js';
import { MIGRATIONS_DIR, PACKAGE_ROOT, sqlitePathFromUrl } from './cli/paths.js';
import { guardedMigration, home, ownRelease, storeSpec } from './release/runtime.js';

/** Production entrypoint uses the existing effective configuration; it never provisions keys/users. */
export async function productionMigrations(): Promise<void> {
  const database = sqlitePathFromUrl(env.DATABASE_URL);
  if (!existsSync(database))
    throw new Error(
      'IAM database is missing; provision a new installation explicitly or restore the existing database',
    );
  await guardedMigration({
    service: 'iam',
    spec: storeSpec(
      'iam',
      { ...process.env, DATABASE_URL: env.DATABASE_URL, REDIS_URL: env.REDIS_URL },
      home(),
    ),
    lock: `${database}.migration.lock`,
    pending: () => planMigrations(database, MIGRATIONS_DIR).pending.length > 0,
    automatic: true,
    release: ownRelease(PACKAGE_ROOT),
    apply: () => applyMigrations(database, MIGRATIONS_DIR),
  });
}
