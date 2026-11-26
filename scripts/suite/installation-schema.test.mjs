// examples/installation.schema.json and the controller's hive_validate accept the same keys.
// Guided-setup output is checked against the schema by interactive.test.py; this covers the
// hand-written shapes (native migration, sudo password files) and refusals on both sides.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { validateInstallation } from './installation-schema.mjs';

const root = resolve(import.meta.dirname, '../..');
const example = JSON.parse(readFileSync(join(root, 'examples/installation.json'), 'utf8'));

function controllerAccepts(config) {
  const directory = mkdtempSync(join(tmpdir(), 'hive-schema-'));
  try {
    const file = join(directory, 'installation.json');
    writeFileSync(file, JSON.stringify(config));
    const script = `set -Eeuo pipefail; HIVE_ROOT=$1; source "$HIVE_ROOT/scripts/suite/controller.sh"; source "$HIVE_ROOT/scripts/suite/initialize.sh"; source "$HIVE_ROOT/scripts/suite/migrate-native.sh"; HIVE_CONFIG=$2 HIVE_VERSION=0.1.0; hive_validate`;
    return spawnSync('bash', ['-c', script, 'validate', root, file], { encoding: 'utf8' }).status === 0;
  } finally { rmSync(directory, { recursive: true, force: true }); }
}

const native = {
  schema: 1, installation: 'primary', release: '0.1.0', profile: 'custom', origin: 'https://hive.example.com',
  hosts: { control: { target: 'deploy@hive.example.com', directory: '/opt/hive-suite', sudoPasswordFile: '/secure/primary-sudo-password' } },
  components: { 'hive-registry': { host: 'control' }, hivexui: { host: 'control' },
    ingress: { host: 'control', envFile: '/opt/hive-suite/config/ingress.env', configDirectory: '/opt/hive-suite/config/ingress' } },
  agents: [], inference: [],
  console: { host: 'control', bindAddress: '0.0.0.0', httpsPort: 443, runtimeFile: '/opt/hive-suite/config/runtime.json',
    nativeListeners: [{ port: 4020, component: 'emberpath' }, { port: 4200, component: 'oathweave' }],
    networkSubnet: '10.200.0.0/24', edgeSubnet: '10.201.0.0/24' },
  nativeMigration: { schema: 1, expectedHost: 'hive', machineIdSHA256: 'a'.repeat(64),
    source: { root: '/', serviceManager: 'systemd', qdrantContainer: 'qdrant' },
    browserIssuer: 'https://hive.example.com/api/oathweave', reviewedLinksFile: '/secure/primary-links.json',
    adminAccount: { subject: 'user-1', username: 'admin', tokenFile: '/secure/primary-reset-token' },
    dataAliases: { hiveskills: '/opt/hive-skills/shared/data' },
    imageRegistry: { server: 'ghcr.io', username: 'deploy', passwordFile: '/root/registry-token' } },
};

test('the published example matches the schema and the controller', () => {
  assert.deepEqual(validateInstallation(example), []);
  assert.ok(controllerAccepts(example));
});

test('native migration, sudo password files and edge subnets are in the schema', () => {
  assert.deepEqual(validateInstallation(native), []);
  assert.ok(controllerAccepts(native), 'the controller refused the native-migration sample');
});

test('container limits are in the schema', () => {
  const config = { ...structuredClone(example), containerLimits: { '*': { pids: 2048 }, [Object.keys(example.components)[0]]: { memory: '512m', cpus: 1.5 } } };
  assert.deepEqual(validateInstallation(config), []);
  assert.ok(controllerAccepts(config));
  config.containerLimits['*'].swap = '1g';
  assert.notDeepEqual(validateInstallation(config), []);
  assert.equal(controllerAccepts(config), false);
});

test('unknown keys are refused by both', () => {
  for (const mutate of [
    (c) => { c.unknown = true; },
    (c) => { c.hosts.control.password = 'x'; },
    (c) => { c.console.listeners = []; },
    (c) => { c.nativeMigration.sourceRoot = '/'; },
  ]) {
    const config = structuredClone(native); mutate(config);
    assert.notDeepEqual(validateInstallation(config), [], JSON.stringify(config));
    assert.equal(controllerAccepts(config), false, JSON.stringify(config));
  }
});

test('the schema validator refuses keywords it does not implement', () => {
  const directory = mkdtempSync(join(tmpdir(), 'hive-schema-'));
  try {
    const schema = join(directory, 'schema.json');
    writeFileSync(schema, JSON.stringify({ type: 'object', oneOf: [] }));
    assert.throws(() => validateInstallation({}, schema), /Unsupported JSON Schema keyword oneOf/);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('the CLI accepts the example and fails on an invalid file', () => {
  const cli = join(root, 'scripts/suite/installation-schema.mjs');
  execFileSync('node', [cli, join(root, 'examples/installation.json')]);
  const directory = mkdtempSync(join(tmpdir(), 'hive-schema-'));
  try {
    const invalid = join(directory, 'invalid.json');
    writeFileSync(invalid, JSON.stringify({ ...example, profile: 'everything' }));
    assert.equal(spawnSync('node', [cli, invalid], { encoding: 'utf8' }).status, 1);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
