import { test } from 'node:test';
import assert from 'node:assert/strict';
import { addFullComponents, applyDatastoreProfile, coreRelease, CORE_PRODUCTS, FULL_PRODUCTS } from './release-contracts.mjs';
import { applySuiteCatalog } from './suite-catalog.mjs';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
const image = name => `example.com/${name}@sha256:${'a'.repeat(64)}`;
function release(withProduct) {
  const images = Object.fromEntries([...CORE_PRODUCTS, ...FULL_PRODUCTS, ...(withProduct ? ['embermend'] : [])].map(name => [name, image(name)]));
  return applySuiteCatalog(addFullComponents(coreRelease({ version: '2.4.0', images, user: '1000:1000' }), { images, user: '1000:1000' }));
}
test('Embermend is offered only with an explicit runtime image and changes no existing profile', () => {
  assert.equal(release(false).components.embermend, undefined);
  const manifest = release(true);
  assert(!manifest.profiles.core.some(name => name.startsWith('embermend')));
  assert(!manifest.profiles.full.some(name => name.startsWith('embermend')));
  assert.deepEqual(manifest.components.embermend.requiresLocal, ['magnus', 'oathweave', 'hivexui', 'embermend-postgres', 'embermend-worker']);
  assert.equal(manifest.components.embermend.image, manifest.components['embermend-worker'].image);
  assert.deepEqual(manifest.components['embermend-worker'].service.command, ['worker']);
  assert.deepEqual(manifest.components.embermend.initialization.verificationCommand, ['verify-initialization']);
  assert.equal(manifest.networks['embermend-data'].internal, true);
});
test('the product catalog keeps optional security, memory and messaging services optional', () => {
  const catalog = release(true).components.embermend.catalog;
  assert.equal(catalog.connection.browserPrefix, '/api/embermend');
  for (const name of ['cindertrace', 'chattermost', 'hivemem', 'hiveskills']) assert(!catalog.dependencies.includes(name));
  assert(catalog.dependencies.includes('magnus'));
});
test('Embermend uses the reviewed PostgreSQL runtime profile without changing other selections', () => {
  const manifest = release(true);
  applyDatastoreProfile(manifest, 'runtime-2026-11', Object.fromEntries(['redis', 'qdrant', 'postgres17', 'postgres18'].map(name => ['datastore:' + name, image(name)])));
  assert.equal(manifest.components['embermend-postgres'].image, image('postgres18'));
  assert.equal(manifest.components['embermend-postgres'].storageFormat, 'embermend-postgres-18-runtime2');
  assert.deepEqual(manifest.components['embermend-postgres'].migration, { from: 'embermend-postgres-18', command: ['hive-pg-reconcile'] });
});
test('candidate builds select the shared runtime and isolated scanner from a clean product checkout', async () => {
  const root = await mkdtemp(join(tmpdir(), 'embermend-candidates-'));
  try {
    await mkdir(join(root, 'bin')); await mkdir(join(root, 'Embermend'));
    await writeFile(join(root, 'bin/git'), '#!/bin/sh\ncase "$*" in *status*) exit 0;; *rev-parse*) echo aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa;; *) exit 1;; esac\n', { mode: 0o755 });
    await writeFile(join(root, 'bin/docker'), '#!/bin/sh\nprintf "%s\\n" "$*" >> "$CANDIDATE_CALLS"\n', { mode: 0o755 });
    const calls = join(root, 'calls');
    const result = spawnSync('bash', [resolve('scripts/suite/build-candidates.sh'), 'embermend', 'embermend-scanner'], { encoding: 'utf8', env: { ...process.env, PATH: join(root, 'bin') + ':' + process.env['PATH'], HIVE_PRODUCTS_ROOT: root, CANDIDATE_CALLS: calls } });
    assert.equal(result.status, 0, result.stderr);
    const builds = (await readFile(calls, 'utf8')).trim().split('\n'); assert.equal(builds.length, 2);
    assert.match(builds[0] ?? '', /-t embermend:candidate .*--target runtime/);
    assert.match(builds[1] ?? '', /-t embermend-scanner:candidate /);
    assert(!builds[1]?.includes('--target runtime'));
    assert(builds.every(call => call.endsWith(join(root, 'Embermend')) && call.includes('org.opencontainers.image.revision=' + 'a'.repeat(40))));
  } finally { await rm(root, { recursive: true, force: true }); }
});
