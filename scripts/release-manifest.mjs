#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { resolve, join } from 'node:path';
import {
  ENGINE_PROTOCOL,
  NODE_RANGE,
  releaseSchema,
  satisfies,
} from '../packages/hive-release/src/manifest.ts';
const root = resolve(import.meta.dirname, '..');
const targets = [
  'packages/hive',
  'services/hive-router',
  'services/hive-iam/apps/iam-core',
  'services/hive-mem/ts-core',
  'services/hive-skills',
];
const read = (p) => JSON.parse(readFileSync(join(root, p, 'package.json'), 'utf8'));
const version = read('packages/hive').version;
const policy = JSON.parse(readFileSync(join(root, 'release', `${version}.json`), 'utf8'));
const components = Object.fromEntries(targets.map((p) => [read(p).name, read(p).version]));
if (Object.values(components).some((v) => v !== version))
  throw new Error('Launcher and servers must have lockstep versions');
const sha = (data) => createHash('sha256').update(data).digest('hex');
const migrationsDir = join(root, 'services/hive-iam/apps/iam-core/prisma/migrations');
if (
  readFileSync(
    join(root, 'services/hive-router/src/storage/generated-sqlite-schema.ts'),
    'utf8',
  ) !==
  readFileSync(
    join(root, 'services/hive-router/src/storage/migrations/managed-format-1.ts'),
    'utf8',
  )
)
  throw new Error(
    'Router schema drift requires a new immutable migration and an updated migration runner',
  );
const migrations = readdirSync(migrationsDir)
  .filter((n) => n !== 'migration_lock.toml')
  .map((id) => ({
    component: 'iam',
    id,
    checksum: sha(readFileSync(join(migrationsDir, id, 'migration.sql'))),
    impact: 'fast',
    readableBy: version,
    note: 'Historical IAM migration; older binaries reject unknown migration history.',
  }));
for (const [component, file] of [
  ['router', 'services/hive-router/src/storage/migrations/managed-format-1.ts'],
  ['memory', 'services/hive-mem/ts-core/src/migrations/managed-format-1.ts'],
  ['skills', 'services/hive-skills/src/migrations/managed-format-1.ts'],
])
  migrations.push({
    component,
    id: 'managed-format-1',
    checksum: sha(readFileSync(join(root, file))),
    impact: 'fast',
    readableBy: version,
    note: 'Adopt existing compatible state and record its format; no destructive conversion.',
  });
for (const migration of migrations) {
  const annotation = policy.migrationPolicy[`${migration.component}:${migration.id}`];
  if (!annotation)
    throw new Error(`Migration impact must be reviewed: ${migration.component}:${migration.id}`);
  if (annotation.checksum !== migration.checksum)
    throw new Error(
      `Immutable migration changed: ${migration.component}:${migration.id}; add a new migration ID instead`,
    );
  Object.assign(migration, annotation);
}
const base = {
  schema: 1,
  version,
  engineProtocol: ENGINE_PROTOCOL,
  engines: { node: NODE_RANGE },
  components,
  optionalComponents: ['skills'],
  testedSdks: Object.fromEntries(
    ['services/hive-iam/packages/iam-sdk', 'services/hive-mem/sdks/typescript'].map((p) => [
      read(p).name,
      read(p).version,
    ]),
  ),
  minUpgradeFrom: {
    '@hivemagnus/hive': '1.1.0',
    '@hivemagnus/hive-router': '1.0.3',
    '@hivemagnus/hive-iam-server': '1.0.3',
    '@hivemagnus/hivemem-server': '1.0.3',
    '@hivemagnus/hive-skills': '1.1.0',
  },
  requiredIntermediates: policy.requiredIntermediates || [],
  newRequiredEnv: policy.newRequiredEnv || [],
  newOptionalEnv: (policy.newOptionalEnv ?? [
    'HIVE_AUTO_MIGRATE',
    'HIVE_UPDATE_CHECK',
    'HIVE_AUTO_UPGRADE',
    'HIVE_AUTO_UPGRADE_POLICY',
    'HIVE_AUTO_UPGRADE_WINDOW',
    'HIVE_AUTO_UPGRADE_TIMEZONE',
    'HIVE_UI_UPGRADE',
    'HIVE_COMPOSE_UPGRADE_SUPERVISOR',
    'HIVE_BACKUP_DIR',
    'HIVE_UPDATE_REGISTRY',
    'HIVE_MANAGED_PROJECT',
    'HIVE_COORDINATOR_SOCKET',
  ]).map((name) => ({
    name,
    component:
      name.startsWith('HIVE_AUTO_UPGRADE') ||
      name === 'HIVE_UI_UPGRADE' ||
      name === 'HIVE_COMPOSE_UPGRADE_SUPERVISOR' ||
      name === 'HIVE_NPM_DEPLOY_TARGETS'
        ? 'launcher'
        : 'router',
    secret: false,
    description: name === 'HIVE_NPM_DEPLOY_TARGETS'
      ? 'Optional repository deploy:npm target inventory; real values belong in a private operator env file.'
      : 'See UPGRADING.md. Automation defaults off outside explicitly configured managed installations.',
  })),
  removedEnv: policy.removedEnv || [],
  migrations,
  wireCompatibility: Object.fromEntries(
    ['iam', 'router', 'memory', 'skills'].map((s) => [s, '^1.0.0']),
  ),
  dataCompatibility: { iam: '^1.0.3', router: '^1.0.3', memory: '^1.0.3', skills: '^1.1.0' },
  summary: policy.summary,
  notesUrl: `https://github.com/ChefTaco/hive/releases/tag/v${version}`,
  breaking: policy.breaking === true,
};
releaseSchema.parse(base);
for (const range of [
  ...Object.values(base.wireCompatibility),
  ...Object.values(base.dataCompatibility),
])
  satisfies(version, range);
const changelog = readFileSync(join(root, 'CHANGELOG.md'), 'utf8');
for (const entry of [...base.newRequiredEnv, ...base.newOptionalEnv, ...base.removedEnv])
  if (!changelog.includes(`\`${entry.name}\``))
    throw new Error(`Document environment change in CHANGELOG.md: ${entry.name}`);
for (const p of targets) {
  const pkg = read(p);
  const expected = `${JSON.stringify({ ...pkg, hiveRelease: base }, null, 2)}\n`;
  const file = join(root, p, 'package.json');
  if (process.argv.includes('--check')) {
    if (readFileSync(file, 'utf8') !== expected) throw new Error(`Stale release manifest: ${p}`);
  } else writeFileSync(file, expected);
}
console.log(
  `Release ${version}: manifests ${process.argv.includes('--check') ? 'verified' : 'generated'}`,
);
