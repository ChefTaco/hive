import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, rmSync, existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { cleanResources, command, isolatedEnvironment, portOpen, readFreshConfig, runFreshInstall, stopStack } from './fresh-npm-e2e.mjs';

const provider = { HIVE_FRESH_VERSION: '1.2.2', HIVE_E2E_PROVIDER_URL: 'http://127.0.0.1:18080', HIVE_E2E_MODEL: 'example-model' };

test('provider settings are explicit, validated, and never taken from a deployment file', async () => {
  await assert.rejects(readFreshConfig({}), /HIVE_E2E_PROVIDER_URL/);
  await assert.rejects(readFreshConfig({ ...provider, HIVE_FRESH_VERSION: 'latest' }), /exact stable/);
  await assert.rejects(readFreshConfig({ ...provider, HIVE_FRESH_VERSION: '1.2.2-beta.1' }), /exact stable/);
  await assert.rejects(readFreshConfig({ ...provider, HIVE_E2E_PROVIDER_URL: 'https://dummy-password@example.com/?key=dummy-secret' }), (error) => {
    assert.doesNotMatch(error.message, /dummy-password|dummy-secret|example.com/); return true;
  });
  await assert.rejects(readFreshConfig({ ...provider, HIVE_E2E_PROVIDER_AUTH_MODE: 'BEARER' }), /HIVE_E2E_PROVIDER_TOKEN/);
  const config = await readFreshConfig({ ...provider, HIVE_E2E_USERNAME: 'existing-admin', HIVE_E2E_MEMORY_TOKEN: 'dummy-existing-token', HIVE_INSTALL_FROM: '/opt/example' });
  assert.deepEqual(config.provider, { HIVE_E2E_PROVIDER_URL: provider.HIVE_E2E_PROVIDER_URL, HIVE_E2E_MODEL: 'example-model' });
  assert.equal(config.version, '1.2.2');
});

test('subprocess environment isolates installation, credentials and native npm policy', () => {
  const env = isolatedEnvironment({ PATH: '/bin', HOME: '/opt/existing', HIVE_HOME: '/opt/existing',
    HIVE_INSTALL_FROM: '/opt/source', NODE_OPTIONS: '--require dummy', HIVE_E2E_PASSWORD: 'dummy-existing-password',
    npm_config_ignore_scripts: 'true', npm_config_registry: 'https://example.com' }, '/tmp/example-fresh');
  assert.equal(env.HOME, '/tmp/example-fresh');
  assert.equal(env.HIVE_HOME, '/tmp/example-fresh/home');
  assert.equal(env.npm_config_registry, 'https://registry.npmjs.org');
  for (const key of ['HIVE_INSTALL_FROM', 'NODE_OPTIONS', 'HIVE_E2E_PASSWORD', 'npm_config_ignore_scripts']) assert.equal(env[key], undefined);
});

test('cleanup runs in reverse ownership order and continues after a failed removal', async () => {
  const calls = [];
  const result = await cleanResources([
    { name: 'directory', remove: async () => calls.push('directory') },
    { name: 'container', remove: async () => { calls.push('container'); throw Error('dummy secret must not escape'); } },
    { name: 'process', remove: async () => calls.push('process') },
  ]);
  assert.deepEqual(calls, ['process', 'container', 'directory']);
  assert.deepEqual(result, [{ name: 'process', passed: true }, { name: 'container', passed: false }, { name: 'directory', passed: true }]);
});

test('bounded command failures do not echo arguments, output, or child diagnostics', async () => {
  await assert.rejects(command(process.execPath, ['-e', 'console.log("dummy-private-output");console.error("dummy-private-error");process.exit(1)']), (error) => {
    assert.doesNotMatch(error.message, /dummy-private|console/); return true;
  });
  await assert.rejects(command(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { timeout: 50 }), /timed out/);
  const controller = new AbortController();
  const pending = command(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { signal: controller.signal });
  controller.abort();
  await assert.rejects(pending, /interrupted/);
});

test('process-group cleanup stops descendants and closes their listeners', async () => {
  const child = spawn(process.execPath, ['--input-type=module', '-e',
    'import {spawn} from "node:child_process";const c=spawn(process.execPath,["-e",\'require("node:net").createServer().listen(0,"127.0.0.1",function(){console.log(this.address().port)})\'],{stdio:["ignore","pipe","inherit"]});c.stdout.pipe(process.stdout);setInterval(()=>{},1000)'],
  { detached: true, stdio: ['ignore', 'pipe', 'ignore'] });
  try {
    const [chunk] = await once(child.stdout, 'data', { signal: AbortSignal.timeout(5000) });
    const port = Number(chunk.toString().trim());
    assert.equal(await portOpen(port), true);
    await stopStack(child);
    for (let n = 0; n < 20 && await portOpen(port); n++) await delay(25);
    assert.equal(await portOpen(port), false);
  } finally { await stopStack(child); }
});

test('failed preflight produces a private receipt and removes its temporary installation', async () => {
  const work = mkdtempSync(join(tmpdir(), 'hive-fresh-failure-test-'));
  try {
    const config = await readFreshConfig({ ...provider, HIVE_FRESH_REPORT_PATH: join(work, 'report.json') });
    const result = await runFreshInstall(config, { PATH: join(work, 'missing-bin') });
    assert.equal(result.success, false);
    assert.equal(result.failure, 'failed');
    assert.ok(result.cleanup.every((item) => item.passed));
    assert.equal(existsSync(result.ownedResources.installation), false);
    assert.equal(statSync(config.reportPath).mode & 0o777, 0o600);
    assert.equal(JSON.parse(readFileSync(config.reportPath)).success, false);
    await assert.rejects(runFreshInstall(config, {}));
  } finally { rmSync(work, { recursive: true, force: true }); }
});

test('an interrupted workflow still removes owned state and records the interruption', async () => {
  const work = mkdtempSync(join(tmpdir(), 'hive-fresh-interrupt-test-'));
  try {
    const config = await readFreshConfig({ ...provider, HIVE_FRESH_REPORT_PATH: join(work, 'report.json') });
    const controller = new AbortController(); controller.abort();
    const result = await runFreshInstall(config, { PATH: process.env.PATH }, controller.signal);
    assert.equal(result.failure, 'interrupted');
    assert.equal(result.success, false);
    assert.ok(result.cleanup.every((item) => item.passed));
    assert.equal(existsSync(result.ownedResources.installation), false);
  } finally { rmSync(work, { recursive: true, force: true }); }
});

test('help and invalid input have no install/network side effects', () => {
  const cli = join(import.meta.dirname, 'fresh-npm-e2e.mjs');
  const help = spawnSync(process.execPath, ['--', cli, '--help'], { env: { PATH: process.env.PATH }, encoding: 'utf8' });
  assert.equal(help.status, 0);
  assert.match(help.stdout, /HIVE_E2E_PROVIDER_URL/);
  const invalid = spawnSync(process.execPath, ['--', cli], { env: { PATH: process.env.PATH }, encoding: 'utf8' });
  assert.equal(invalid.status, 2);
  assert.match(invalid.stderr, /HIVE_E2E_PROVIDER_URL/);
});

test('explicit env files support exported overrides and reject unreadable files privately', () => {
  const work = mkdtempSync(join(tmpdir(), 'hive-fresh-env-test-'));
  const cli = join(import.meta.dirname, 'fresh-npm-e2e.mjs');
  try {
    const file = join(work, 'settings');
    writeFileSync(file, 'HIVE_FRESH_VERSION=invalid\nHIVE_E2E_PROVIDER_URL=http://127.0.0.1:18080\nHIVE_E2E_MODEL=example-model\n', { mode: 0o600 });
    const script = JSON.parse(readFileSync(join(import.meta.dirname, '../package.json'))).scripts['test:e2e:fresh'];
    assert.match(script, /^node -- /, 'Node must not load the harness env file before validation');
    const overridden = spawnSync(process.execPath, ['--', cli, '--env-file', file], {
      env: { PATH: process.env.PATH, HIVE_FRESH_VERSION: '1.2.2', HIVE_E2E_MODEL: '' }, encoding: 'utf8',
    });
    assert.equal(overridden.status, 2);
    assert.match(overridden.stderr, /HIVE_E2E_MODEL/);
    assert.doesNotMatch(overridden.stderr, /HIVE_FRESH_VERSION/);
    const missing = spawnSync(process.execPath, ['--', cli, '--env-file', join(work, 'dummy-private-filename')], {
      env: { PATH: process.env.PATH }, encoding: 'utf8',
    });
    assert.equal(missing.status, 2);
    assert.doesNotMatch(missing.stderr, /dummy-private-filename/);
  } finally { rmSync(work, { recursive: true, force: true }); }
});
