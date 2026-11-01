import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync, openSync, closeSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/** Fresh packed launcher installation, using separate stores and no adopted state. */
export async function freshManagedInstall({ work, packs, cli, env, runtime, run, port, version }) {
  const home = join(work, 'fresh-home');
  const project = `hive-fresh-${runtime.hash(home).slice(0, 8)}`;
  const isolated = { ...env, HIVE_HOME: home, NODE_EXTRA_CA_CERTS: join(home, 'tls/ca.crt') };
  const qp = await port(),
    rp = await port();
  let child;
  try {
    await run('docker', [
      'run',
      '-d',
      '--name',
      `${project}-qdrant`,
      '-p',
      `127.0.0.1:${qp}:6333`,
      'qdrant/qdrant:v1.18.1',
    ]);
    await run('docker', [
      'run',
      '-d',
      '--name',
      `${project}-redis`,
      '-p',
      `127.0.0.1:${rp}:6379`,
      'redis:7.4.7-alpine',
    ]);
    for (let n = 0; n < 60; n++) {
      try {
        if ((await fetch(`http://127.0.0.1:${qp}/readyz`)).ok) break;
      } catch {}
      await new Promise((r) => setTimeout(r, 500));
    }
    const ports = (
      await Promise.all(
        ['memory', 'iam', 'router', 'router-admin', 'skills'].map(async (s) => [
          '--port',
          `${s}=${await port()}`,
        ]),
      )
    ).flat();
    await run(
      process.execPath,
      [
        cli,
        'init',
        '--services',
        'all',
        '--yes',
        '--from',
        packs,
        '--qdrant-url',
        `http://127.0.0.1:${qp}`,
        '--redis-url',
        `redis://127.0.0.1:${rp}`,
        ...ports,
      ],
      { env: { ...isolated, NODE_EXTRA_CA_CERTS: undefined } },
    );
    const projectState = runtime.readProject(home);
    assert.deepEqual(projectState.services, ['iam', 'memory', 'skills', 'router']);
    const dir = runtime.activeDirectory(home);
    for (const name of [
      '@hivemagnus/hive',
      ...projectState.services.map((s) => runtime.PACKAGES[s]),
    ])
      assert.equal(runtime.installedPackage(dir, name).version, version);
    const manifest = JSON.parse(readFileSync(join(dir, 'package.json')));
    assert(
      Object.values(manifest.dependencies).every((v) => !v.startsWith('^') && !v.startsWith('~')),
    );
    assert.deepEqual(manifest.allowScripts, runtime.NATIVE_POLICY);
    runtime.atomic(
      join(home, 'config/upgrade.env'),
      'HIVE_UPDATE_CHECK=false\nHIVE_AUTO_UPGRADE=false\nHIVE_UI_UPGRADE=false\n',
    );
    const managedCli = join(dir, 'node_modules/@hivemagnus/hive/dist/src/cli.js');
    const log = openSync(join(work, 'fresh.log'), 'a', 0o600);
    child = spawn(process.execPath, [managedCli, 'start'], {
      cwd: home,
      env: isolated,
      stdio: ['ignore', log, log],
    });
    closeSync(log);
    const control = runtime.manager(home, projectState);
    await control.health(dir);
    assert.equal(
      runtime.installedPackage(runtime.activeDirectory(home), '@hivemagnus/hive').version,
      version,
    );
    await control.stop();
    await new Promise((r) => (child.exitCode !== null ? r() : child.once('exit', r)));
    child = undefined;
    return { freshManagedInstall: true, version, services: projectState.services };
  } finally {
    if (child?.exitCode === null) {
      child.kill('SIGTERM');
      await new Promise((r) => child.once('exit', r));
    }
    for (const store of ['qdrant', 'redis'])
      await run('docker', ['rm', '-fv', `${project}-${store}`]).catch(() => {});
  }
}
