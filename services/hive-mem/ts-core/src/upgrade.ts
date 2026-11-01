import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { acquireWriterLock } from './writer-lock.js';
import { mkdirSync } from 'node:fs';
import {
  findPackageRoot,
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

export const memoryPackageRoot = findPackageRoot(import.meta.url, '@hivemagnus/hivemem-server');
export async function memoryMigration(args: readonly string[], automatic = false): Promise<void> {
  const flags = migrationFlags(args);
  const data = resolve(process.env.HIVEMEM_STORAGE_PATH || join(home(), 'memory'));
  const state = join(data, '.hive-memory-schema.json');
  const release = ownRelease(memoryPackageRoot);
  const checksum = hash(
    JSON.stringify(
      release.migrations.filter((m) => m.component === 'memory').map((m) => [m.id, m.checksum]),
    ),
  );
  const plan = () => ({
    ...schemaPlan(state, checksum, metadata(memoryPackageRoot).version),
    dataChanged: false,
  });
  if (flags.plan) {
    console.log(JSON.stringify({ ...plan(), ...migrationReview(release, 'memory') }));
    return;
  }
  mkdirSync(data, { recursive: true, mode: 0o700 });
  const releaseWriter = automatic ? () => {} : await acquireWriterLock(join(data, 'writer.lock'));
  try {
    await guardedMigration({
      service: 'memory',
      spec: storeSpec('memory', process.env, home()),
      lock: join(data, 'migration.lock'),
      pending: () => plan().pending.length > 0,
      automatic,
      release,
      ...(flags.backupDir ? { backupDir: flags.backupDir } : {}),
      ...(flags.confirmPlan ? { confirmPlan: flags.confirmPlan } : {}),
      apply: async () => {
        schemaCommit(state, checksum, release.version, release.dataCompatibility.memory!);
      },
    });
  } finally {
    releaseWriter();
  }
}
