import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, copyFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { createServer } from 'node:net';

/** Called only with a disposable synthetic installation from check-upgrade-install. */
export async function composeDrill({
  root,
  work,
  home,
  packs,
  env,
  runtime,
  control,
  run,
  wait,
  cli,
  verifyState,
}) {
  const project = runtime.readProject(home);
  const baseVersion = runtime.installedPackage(
    runtime.activeDirectory(home),
    '@hivemagnus/hive',
  ).version;
  const parts = baseVersion.split('.').map(Number);
  const goodVersion = `${parts[0]}.${parts[1]}.${parts[2] + 1}`;
  const badVersion = `${parts[0]}.${parts[1]}.${parts[2] + 2}`;
  const treeVersion = JSON.parse(
    readFileSync(join(root, 'packages/hive/package.json'), 'utf8'),
  ).version;
  await control.stop();
  project.manager = 'compose';
  runtime.writeJson(runtime.projectFile(home), project);
  runtime.configureCompose(home);
  runtime.atomic(
    join(home, 'config/upgrade.env'),
    'HIVE_UPDATE_CHECK=false\nHIVE_AUTO_UPGRADE=false\nHIVE_UI_UPGRADE=false\nHIVE_COMPOSE_UPGRADE_SUPERVISOR=true\n',
  );
  const server = createServer();
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  await new Promise((r) => server.close(r));
  const registry = `hive-test-registry-${project.id.slice(0, 8)}`;
  const base = `127.0.0.1:${port}`;
  let coordinator;
  const command = ['compose', '--project-directory', home, '-f', join(home, 'compose.yaml')];
  const future = join(work, 'future-packs');
  mkdirSync(future);
  const services = {
    iam: 'hive-iam-server',
    memory: 'hivemem-server',
    skills: 'hive-skills',
    router: 'hive-router',
  };
  const arch = (process.env.HIVE_IMAGE_TEST_PLATFORM || 'linux/amd64').split('/')[1];
  const fixtureTag = (name, version) =>
    `${name}:upgrade-${project.id.slice(0, 8)}-${version}-${arch}`;
  const logs = await import('node:fs');
  function startCoordinator() {
    const fd = logs.openSync(join(work, 'coordinator.log'), 'a', 0o600);
    coordinator = spawn(process.execPath, [cli, 'coordinator'], {
      cwd: home,
      env: { ...env, HIVE_INSTALL_FROM: future },
      stdio: ['ignore', fd, fd],
    });
    logs.closeSync(fd);
  }
  async function stopCoordinator() {
    if (!coordinator || coordinator.exitCode !== null) return;
    coordinator.kill('SIGTERM');
    await new Promise((r) => coordinator.once('exit', r));
    await assert.rejects(runtime.coordinatorRequest(home, 'status'), 'Coordinator must actually stop before the absence drill');
  }
  async function outcome(version, expected) {
    for (let n = 0; n < 600; n++) {
      try {
        const status = await runtime.coordinatorRequest(home, 'status');
        if (!status.busy && status.result?.version === version) {
          assert.equal(status.result.state, expected, JSON.stringify(status.result));
          return;
        }
      } catch (error) {
        if (error.code === 'ERR_ASSERTION') throw error;
      }
      await new Promise((r) => setTimeout(r, 500));
    }
    throw new Error(`Timed out waiting for ${version} ${expected}`);
  }
  async function publish(name, version) {
    const tag = `${base}/${name}:channel`;
    await run('docker', ['tag', fixtureTag(name, version), tag]);
    await run('docker', ['push', tag]);
    const exact = `${base}/${name}:${version}`;
    await run('docker', ['tag', fixtureTag(name, version), exact]);
    await run('docker', ['push', exact]);
  }
  async function candidate(version, bad = false) {
    const context = join(work, `images-${version}`);
    mkdirSync(context);
    for (const file of ['server.Dockerfile', 'entrypoint.mjs', 'health.mjs', '.dockerignore'])
      copyFileSync(join(root, 'docker', file), join(context, file));
    for (const file of readdirSync(packs).filter((f) => f.endsWith('.tgz'))) {
      const staging = join(context, file + '.unpacked');
      mkdirSync(staging);
      await run('tar', ['-xf', join(packs, file), '-C', staging]);
      const manifestFile = join(staging, 'package/package.json');
      const pkg = JSON.parse(readFileSync(manifestFile, 'utf8'));
      if (!pkg.hiveRelease) continue;
      pkg.version = version;
      pkg.hiveRelease.version = version;
      pkg.hiveRelease.notesUrl = `https://github.com/ChefTaco/hive/releases/tag/v${version}`;
      for (const name of Object.keys(pkg.hiveRelease.components))
        pkg.hiveRelease.components[name] = version;
      writeFileSync(manifestFile, JSON.stringify(pkg, null, 2));
      if (bad && pkg.name === '@hivemagnus/hive-router') {
        const file = join(staging, 'package/dist/src/server.js');
        writeFileSync(
          file,
          "throw new Error('Synthetic unhealthy upgrade fixture');\n" + readFileSync(file, 'utf8'),
        );
      }
      const archive = `${pkg.name.replace('@', '').replace('/', '-')}-${version}.tgz`;
      await run('tar', ['-czf', join(context, archive), '-C', staging, 'package']);
      copyFileSync(join(context, archive), join(future, archive));
    }
    for (const [service, name] of Object.entries(services)) {
      await run('docker', [
        'buildx',
        'build',
        '--load',
        '--platform',
        process.env.HIVE_IMAGE_TEST_PLATFORM || 'linux/amd64',
        '-f',
        join(context, 'server.Dockerfile'),
        '--build-arg',
        `HIVE_PACKAGE=@hivemagnus/${name}`,
        '--build-arg',
        `HIVE_VERSION=${version}`,
        '-t',
        fixtureTag(name, version),
        context,
      ]);
    }
  }
  try {
    await run('docker', [
      'run',
      '-d',
      '--name',
      registry,
      '-p',
      `127.0.0.1:${port}:5000`,
      'registry:2.8.3',
    ]);
    for (let n = 0; n < 60; n++) {
      try {
        if ((await fetch(`http://${base}/v2/`)).ok) break;
      } catch {}
      await new Promise((r) => setTimeout(r, 250));
    }
    if (baseVersion !== treeVersion) await candidate(baseVersion);
    const config = JSON.parse(readFileSync(join(home, 'compose.yaml'), 'utf8'));
    for (const [service, name] of Object.entries(services)) {
      if (baseVersion === treeVersion)
        await run('docker', ['tag', `${name}:local-${arch}`, fixtureTag(name, baseVersion)]);
      await publish(name, baseVersion);
      config.services[service].image = `${base}/${name}:channel`;
      config.services[service].platform = process.env.HIVE_IMAGE_TEST_PLATFORM || 'linux/amd64';
    }
    runtime.writeJson(join(home, 'compose.yaml'), config);
    startCoordinator();
    for (let n = 0; n < 60; n++) {
      try {
        await runtime.coordinatorRequest(home, 'status');
        break;
      } catch {}
      await new Promise((r) => setTimeout(r, 250));
    }
    await run('docker', [...command, 'pull']);
    await run('docker', [...command, 'up', '-d', '--wait', '--wait-timeout', '180']);
    await wait(cli);
    const approved = JSON.parse(readFileSync(join(home, 'run/compose-state.json'), 'utf8'));
    assert.equal(Object.keys(approved.images).length, 4);
    await candidate(goodVersion);
    // Pulling a partial channel must recover the original immutable image set.
    await publish(services.iam, goodVersion);
    await run('docker', [...command, 'pull']);
    await run('docker', [...command, 'up', '-d']).catch(() => {});
    await outcome(goodVersion, 'failed');
    assert.equal(
      runtime.installedPackage(runtime.activeDirectory(home), '@hivemagnus/hive').version,
      baseVersion,
    );
    await wait(cli);
    for (const name of Object.values(services)) await publish(name, goodVersion);
    await run('docker', [...command, 'pull']);
    await run('docker', [...command, 'up', '-d']);
    // A previous failure for this same version must not satisfy the new attempt.
    for (let n = 0; n < 600; n++) {
      const state = await runtime.coordinatorRequest(home, 'status');
      if (
        !state.busy &&
        state.result?.version === goodVersion &&
        state.result.state === 'completed'
      )
        break;
      if (n === 599)
        throw new Error(
          `Healthy Compose upgrade did not complete: ${JSON.stringify(state.result)}`,
        );
      await new Promise((r) => setTimeout(r, 500));
    }
    assert.equal(
      runtime.installedPackage(runtime.activeDirectory(home), '@hivemagnus/hive').version,
      goodVersion,
    );
    await wait(cli);
    await verifyState();
    await candidate(badVersion, true);
    for (const name of Object.values(services)) await publish(name, badVersion);
    // A stopped supervisor must leave every replacement before datastore initialization.
    await stopCoordinator();
    const stateBefore = runtime.activeDirectory(home);
    await run('docker', [...command, 'pull']);
    const bringingUp = run('docker', [...command, 'up', '-d']).catch(() => {});
    await new Promise((r) => setTimeout(r, 3000));
    assert.equal(runtime.activeDirectory(home), stateBefore);
    startCoordinator();
    await bringingUp;
    await outcome(badVersion, 'failed');
    assert.equal(
      runtime.installedPackage(runtime.activeDirectory(home), '@hivemagnus/hive').version,
      goodVersion,
    );
    await wait(cli);
    await verifyState();
    const cliVersion = `${parts[0]}.${parts[1]}.${parts[2] + 3}`;
    await candidate(cliVersion);
    for (const name of Object.values(services)) await publish(name, cliVersion);
    await run(process.execPath, [cli, 'upgrade', '--to', cliVersion, '--from', future], { env });
    assert.equal(
      runtime.installedPackage(runtime.activeDirectory(home), '@hivemagnus/hive').version,
      cliVersion,
    );
    await wait(cli);
    await run(process.execPath, [cli, 'rollback'], { env });
    assert.equal(
      runtime.installedPackage(runtime.activeDirectory(home), '@hivemagnus/hive').version,
      goodVersion,
    );
    await wait(cli);
    await verifyState();
    // Exercise the same native backup formats while all Compose writers are
    // stopped, then prove restored data through the real container endpoints.
    const recovery = new runtime.ComposeController(home).adapter();
    await recovery.stop();
    const specs = runtime.inventory(home, runtime.readProject(home));
    const redisSpec = specs.find((spec) => spec.redis).redis;
    const redis = new runtime.Redis(new URL(redisSpec.url));
    const key = `${redisSpec.prefix}:example-upgrade-ttl`;
    try {
      await redis.ready();
      await redis.command('SET', key, 'synthetic-restored-state', 'PX', '600000');
      await redis.command('SET', 'example-unrelated-namespace', 'preserved');
      const expiresBefore = Date.now() + (await redis.command('PTTL', key));
      const backup = join(work, 'compose-restore-proof');
      await runtime.backupStores(specs, backup, project.id);
      await runtime.restoreStores(
        specs,
        backup,
        project.id,
        runtime.hash(readFileSync(join(backup, 'manifest.json'))),
      );
      assert.equal((await redis.command('GET', key)).toString(), 'synthetic-restored-state');
      assert(Date.now() + (await redis.command('PTTL', key)) <= expiresBefore + 100);
      assert.equal(
        (await redis.command('GET', 'example-unrelated-namespace')).toString(),
        'preserved',
      );
    } finally {
      redis.close();
    }
    await recovery.start();
    await recovery.health(runtime.activeDirectory(home));
    await verifyState();
    console.log(
      JSON.stringify({
        composePassed: true,
        mixedBundleRecovery: true,
        rawPullUp: true,
        supervisorAbsence: true,
        unhealthyRevert: true,
        cliUpgradeAndRollback: true,
        backupRestore: true,
        consumerStatePreserved: true,
        platform: process.env.HIVE_IMAGE_TEST_PLATFORM || 'linux/amd64',
      }),
    );
  } finally {
    await run('docker', [...command, 'down', '--volumes', '--remove-orphans']).catch(() => {});
    await stopCoordinator();
    await run('docker', ['rm', '-fv', registry]).catch(() => {});
  }
}
