import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { runDoctor } from './hive-doctor.ts';
import { makeTempRoot } from './test-fixtures.ts';

const tmp = makeTempRoot('hive-doctor-test-');
const memoryJwtKey = ['HIVEMEM', 'JWT', 'SECRET'].join('_');

function makeFixture(name: string): string {
  const root = join(tmp, name);
  mkdirSync(join(root, 'docs'), { recursive: true });
  mkdirSync(join(root, 'services/hive-router/scripts'), { recursive: true });
  mkdirSync(join(root, 'services/hive-router'), { recursive: true });
  mkdirSync(join(root, 'services/hive-iam/scripts'), { recursive: true });
  mkdirSync(join(root, 'services/hive-iam/apps/iam-core'), { recursive: true });
  mkdirSync(join(root, 'services/hive-mem/scripts'), { recursive: true });
  mkdirSync(join(root, 'services/hive-mem'), { recursive: true });
  for (const file of ['package.json', 'README.md', 'docs/HIVE_ARCHITECTURE.md']) {
    writeFileSync(join(root, file), file === 'package.json' ? '{"scripts":{}}' : '# doc\n');
  }
  for (const file of [
    'services/hive-router/scripts/deploy-hive-router.sh',
    'services/hive-iam/scripts/deploy-iam-core.sh',
    'services/hive-mem/scripts/deploy_server.sh',
  ]) {
    writeFileSync(join(root, file), '#!/usr/bin/env bash\n', { mode: 0o755 });
  }
  for (const file of [
    'services/hive-router/.env.example',
    'services/hive-iam/apps/iam-core/.env.example',
    'services/hive-mem/.env.example',
    'services/hive-mem/.env',
  ]) {
    writeFileSync(join(root, file), file === 'services/hive-mem/.env' ? `${memoryJwtKey}=test-secret-with-at-least-32-randomish-bytes\n` : 'EXAMPLE=1\n');
  }
  writeFileSync(join(root, '.env'), [
    'DEPLOY_USERNAME=deploy',
    'DEPLOY_SSH_KEY=/tmp/nonexistent-hive-test-key',
    'HIVE_DEPLOY_HOST=hive',
    'HIVE_PUBLIC_FQDN=hive.example.com',
    'HIVE_ROUTER_AUTH_MODE=os',
    'HIVE_ROUTER_SECRET=redacted',
  ].join('\n'));
  return root;
}

describe('hive doctor', () => {
  it('renders a setup report without printing secret values', () => {
    const root = makeFixture('ok');
    const result = runDoctor(['--root', root]);

    assert.match(result.output, /Hive Doctor/);
    assert.match(result.output, /Deploy username is configured/);
    assert.doesNotMatch(result.output, /redacted/);
    assert.ok(result.checks.some((entry) => entry.message.includes('secret-like keys')));
  });

  it('reports missing required docs as failures', () => {
    const root = join(tmp, 'missing');
    mkdirSync(root, { recursive: true });
    const result = runDoctor(['--root', root, '--json']);

    assert.equal(result.hasFailures, true);
    assert.match(result.output, /package.json is missing/);
  });

  it('returns a failing process status when a required check fails', () => {
    const root = join(tmp, 'cli-missing');
    mkdirSync(root, { recursive: true });
    const result = spawnSync(process.execPath, [
      '--experimental-strip-types',
      join(import.meta.dirname, 'hive-doctor.ts'),
      '--root',
      root,
      '--json',
    ], { encoding: 'utf8' });

    assert.equal(result.status, 1);
    assert.match(result.stdout, /package.json is missing/);
  });

  it('fails when the static exporter credential fallback is enabled', () => {
    const root = makeFixture('fallback-enabled');
    writeFileSync(join(root, '.env'), [
      'HIVEMEM_ENV_FILE=services/hive-mem/.env',
      'HIVE_ROUTER_SECURITY_EXPORT_STATIC_FALLBACK_ENABLED=true',
    ].join('\n'));
    const result = runDoctor(['--root', root]);

    assert.equal(result.hasFailures, true);
    assert.ok(result.checks.some((entry) =>
      entry.status === 'fail' && entry.message.includes('fallback is enabled')));
  });

  it('fails when either production service TLS bypass is enabled', () => {
    for (const key of ['HIVE_STATUS_ALLOW_INSECURE_TLS', 'HIVE_ROUTER_IAM_ALLOW_INSECURE_TLS']) {
      const root = makeFixture(`tls-bypass-${key}`);
      writeFileSync(join(root, '.env'), [
        'HIVEMEM_ENV_FILE=services/hive-mem/.env',
        `${key}=true`,
      ].join('\n'));
      const result = runDoctor(['--root', root]);
      assert.equal(result.hasFailures, true);
      assert.ok(result.checks.some((entry) => entry.status === 'fail' && entry.message.includes(key)));
    }
  });
});
