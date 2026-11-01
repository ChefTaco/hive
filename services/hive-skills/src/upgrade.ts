import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { packageRoot } from './paths.js';
import { initializeSchema } from './schema.js';
import {
  guardedMigration,
  hash,
  home,
  metadata,
  migrationFlags,
  migrationReview,
  ownRelease,
  schemaCommit,
  schemaPlan,
  storeSpec,
} from './release/runtime.js';

export async function skillsMigration(args: readonly string[], automatic = false): Promise<void> {
  const flags = migrationFlags(args);
  const data = resolve(process.env.HIVE_SKILLS_DATA_DIR || './data');
  const file = join(data, '.hive-skills-schema.json');
  const database = join(data, 'registry.sqlite');
  const release = ownRelease(packageRoot);
  const checksum = hash(
    JSON.stringify(
      release.migrations.filter((m) => m.component === 'skills').map((m) => [m.id, m.checksum]),
    ),
  );
  const plan = () => {
    const state = schemaPlan(file, checksum, metadata(packageRoot).version);
    if (existsSync(file) && !existsSync(database))
      throw new Error('Existing Skills database is missing; restore it before starting');
    if (!existsSync(database)) return { ...state, dataChanged: true };
    const db = new DatabaseSync(database, { readOnly: true });
    try {
      const columns = new Set(
        db
          .prepare('PRAGMA table_info(releases)')
          .all()
          .map((c) => c.name),
      );
      return {
        ...state,
        dataChanged:
          !columns.has('min_hermes_version') ||
          !columns.has('max_hermes_version') ||
          !db.prepare("SELECT id FROM registry_migrations WHERE id='release-channels'").get(),
      };
    } finally {
      db.close();
    }
  };
  if (flags.plan) {
    console.log(JSON.stringify({ ...plan(), ...migrationReview(release, 'skills') }));
    return;
  }
  await guardedMigration({
    service: 'skills',
    spec: storeSpec('skills', process.env, home()),
    lock: join(data, 'migration.lock'),
    pending: () => plan().pending.length > 0,
    automatic,
    release,
    ...(flags.backupDir ? { backupDir: flags.backupDir } : {}),
    ...(flags.confirmPlan ? { confirmPlan: flags.confirmPlan } : {}),
    apply: async () => {
      const db = new DatabaseSync(database);
      try {
        initializeSchema(db);
      } finally {
        db.close();
      }
      schemaCommit(file, checksum, release.version, release.dataCompatibility.skills!);
    },
  });
}
