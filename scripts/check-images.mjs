#!/usr/bin/env node
import { spawn, execFileSync } from 'node:child_process';
import {
  mkdtempSync,
  mkdirSync,
  copyFileSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
  chmodSync,
} from 'node:fs';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
const root = resolve(import.meta.dirname, '..');
const work = mkdtempSync(join(tmpdir(), 'hive-images-'));
const entries = {
  iam: 'services/hive-iam/apps/iam-core',
  router: 'services/hive-router',
  memory: 'services/hive-mem/ts-core',
  skills: 'services/hive-skills',
};
async function run(command, args, options = {}) {
  await new Promise((yes, no) => {
    const p = spawn(command, args, { cwd: root, stdio: 'inherit', ...options });
    p.once('error', no);
    p.once('exit', (code) => (code === 0 ? yes() : no(new Error(`${command} failed (${code})`))));
  });
}
const selected = process.argv.includes('--component')
  ? [process.argv[process.argv.indexOf('--component') + 1]]
  : Object.keys(entries);
const platform = process.env.HIVE_IMAGE_TEST_PLATFORM || 'linux/amd64';
async function checkGatedShutdown(tag, service) {
  const state = mkdtempSync(join(tmpdir(), 'hive-image-gate-'));
  chmodSync(state, 0o755);
  mkdirSync(join(state, 'config'));
  mkdirSync(join(state, 'run'));
  writeFileSync(
    join(state, 'config/project.json'),
    JSON.stringify({
      schema: 1,
      id: randomUUID(),
      manager: 'compose',
      services: [service],
      launcher: '@hivemagnus/hive',
      createdAt: new Date().toISOString(),
    }),
  );
  let received;
  const admission = new Promise((r) => {
    received = r;
  });
  const server = createServer((request, response) => {
    request.resume();
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ admitted: false }));
    received();
  });
  const socket = join(state, 'run/coordinator.sock');
  await new Promise((r) => server.listen(socket, r));
  chmodSync(socket, 0o666);
  const name = `hive-gate-${randomUUID()}`;
  let timer;
  try {
    await run('docker', [
      'run',
      '-d',
      '--name',
      name,
      '--platform',
      platform,
      '-e',
      'HIVE_COMPOSE_UPGRADE_SUPERVISOR=true',
      '-v',
      `${state}:/data:ro`,
      tag,
    ]);
    await Promise.race([
      admission,
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new Error('Image did not reach the admission gate')),
          30000,
        );
      }),
    ]);
    await run('docker', ['stop', '--time', '2', name]);
    const inspection = JSON.parse(execFileSync('docker', ['inspect', name], { encoding: 'utf8' }));
    assert.equal(inspection[0].State.ExitCode, 0, 'Gated process stops without SIGKILL');
    assert.deepEqual(
      readdirSync(state).sort(),
      ['config', 'run'],
      'No datastore is opened before admission',
    );
  } finally {
    clearTimeout(timer);
    await run('docker', ['rm', '-fv', name]).catch(() => {});
    await new Promise((r) => server.close(r));
    rmSync(state, { recursive: true, force: true });
  }
}
try {
  for (const file of ['server.Dockerfile', 'entrypoint.mjs', 'health.mjs', '.dockerignore'])
    copyFileSync(join(root, 'docker', file), join(work, file));
  for (const path of ['packages/hive', ...Object.values(entries)])
    await run('npm', ['pack', '--ignore-scripts', '--silent', '--pack-destination', work], {
      cwd: join(root, path),
    });
  for (const service of selected) {
    if (!entries[service]) throw new Error('Unknown image component');
    const pkg = JSON.parse(readFileSync(join(root, entries[service], 'package.json'), 'utf8'));
    const name = pkg.name.split('/')[1];
    const tag = `${name}:local-${platform.split('/')[1]}`;
    await run('docker', [
      'buildx',
      'build',
      '--load',
      '--platform',
      platform,
      '-f',
      join(work, 'server.Dockerfile'),
      '--build-arg',
      `HIVE_PACKAGE=${pkg.name}`,
      '--build-arg',
      `HIVE_VERSION=${pkg.version}`,
      '-t',
      tag,
      work,
    ]);
    await run('docker', ['run', '--rm', '--platform', platform, tag, '--version']);
    await run('docker', ['run', '--rm', '--platform', platform, tag, 'env-schema']);
    await checkGatedShutdown(tag, service);
  }
} finally {
  rmSync(work, { recursive: true, force: true });
}
