#!/usr/bin/env node
// Opt-in public npm drill. Never reads deployment env files or reuses existing state.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, openSync, closeSync, readFileSync, rmSync, writeFileSync, chmodSync } from 'node:fs';
import { createServer, connect } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { parseEnv } from 'node:util';
import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

const root = resolve(import.meta.dirname, '..');
const registry = 'https://registry.npmjs.org';
const stores = [
  ['qdrant', 'qdrant/qdrant:v1.18.1', 6333],
  ['redis', 'redis:7.4.7-alpine', 6379],
];
const switches = ['HIVE_AUTO_UPGRADE', 'HIVE_UPDATE_CHECK', 'HIVE_UI_UPGRADE', 'HIVE_COMPOSE_UPGRADE_SUPERVISOR'];
const providerNames = [
  'HIVE_E2E_PROVIDER_URL', 'HIVE_E2E_MODEL', 'HIVE_E2E_PROVIDER_KIND',
  'HIVE_E2E_PROVIDER_AUTH_MODE', 'HIVE_E2E_PROVIDER_TOKEN', 'HIVE_E2E_PROVIDER_AUTH_HEADER',
  'HIVE_E2E_TIMEOUT_MS', 'HIVE_E2E_MAX_TOKENS',
];
const help = `Usage: npm run test:e2e:fresh -- [--env-file FILE]

Installs the exact HIVE_FRESH_VERSION release (default: repository version) from
public npm, including Skills, with temporary TLS, Redis and Qdrant. Tests real
model streaming, SDK memory recall and Skills distribution, then removes it all.
Required: HIVE_E2E_PROVIDER_URL, HIVE_E2E_MODEL. Provider settings use HIVE_E2E_*.
Requires supported Node, npm, Docker, openssl and installed repository test dependencies.
See docs/fresh-npm-e2e.md. No existing installation or deployment credentials are used.`;

export async function readFreshConfig(env) {
  const version = env.HIVE_FRESH_VERSION ?? JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version;
  if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version)) {
    throw new Error('HIVE_FRESH_VERSION must be an exact stable X.Y.Z version');
  }
  // Reuse the existing provider validation without accepting existing service URLs or logins.
  const { readModelE2eConfig } = await import('./model-e2e.ts');
  const provider = Object.fromEntries(providerNames.filter((key) => env[key] !== undefined).map((key) => [key, env[key]]));
  readModelE2eConfig({ ...provider,
    HIVE_E2E_ADMIN_URL: 'https://localhost', HIVE_E2E_API_URL: 'https://localhost',
    HIVE_E2E_MEMORY_URL: 'https://localhost', HIVE_E2E_USERNAME: 'admin',
    HIVE_E2E_PASSWORD: 'dummy-validation-only', HIVE_E2E_MEMORY_TOKEN: 'dummy-validation-only',
  });
  return { version, provider, reportPath: resolve(env.HIVE_FRESH_REPORT_PATH ?? join(root, 'output/fresh-npm-e2e', `${randomUUID()}.json`)),
    extraCa: env.NODE_EXTRA_CA_CERTS ? readFileSync(env.NODE_EXTRA_CA_CERTS) : Buffer.alloc(0) };
}

export function isolatedEnvironment(source, work) {
  // No inherited NODE_OPTIONS, HIVE_*, npm settings, credentials or source overrides.
  return { PATH: source.PATH, HOME: work, HIVE_HOME: join(work, 'home'),
    npm_config_registry: registry, npm_config_cache: join(work, 'npm-cache'),
    npm_config_userconfig: join(work, 'npmrc'), npm_config_globalconfig: join(work, 'global-npmrc'),
    npm_config_update_notifier: 'false',
    ...(source.DOCKER_HOST ? { DOCKER_HOST: source.DOCKER_HOST } : {}),
    ...(source.DOCKER_CONTEXT ? { DOCKER_CONTEXT: source.DOCKER_CONTEXT } : {}),
    ...(source.DOCKER_CONFIG ? { DOCKER_CONFIG: source.DOCKER_CONFIG } : {}),
  };
}

// All owned resources get a cleanup attempt, even if an earlier one fails.
export async function cleanResources(resources) {
  const results = [];
  for (const { name, remove } of [...resources].reverse()) {
    try { await remove(); results.push({ name, passed: true }); }
    catch { results.push({ name, passed: false }); }
  }
  return results;
}

export async function command(cmd, args, { cwd, env, signal, timeout = 300_000 } = {}) {
  signal?.throwIfAborted();
  return new Promise((yes, no) => {
    const child = spawn(cmd, args, { cwd, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '', failed = false;
    const kill = () => { failed = true; try { process.kill(-child.pid, 'SIGKILL'); } catch {} };
    const timer = setTimeout(kill, timeout);
    const abort = () => kill();
    signal?.addEventListener('abort', abort, { once: true });
    child.stdout.on('data', (chunk) => { output = (output + chunk).slice(-2_000_000); });
    // Child diagnostics may include provider responses or generated bootstrap secrets.
    child.stderr.resume();
    const finish = () => { clearTimeout(timer); signal?.removeEventListener('abort', abort); };
    child.once('error', () => { finish(); no(new Error('Required command could not start')); });
    child.once('close', (code) => {
      finish();
      if (!failed && code === 0) yes(output);
      else no(new Error(signal?.aborted ? 'Fresh test interrupted' : `Command failed or timed out (exit ${code})`));
    });
  });
}

async function freePort(used) {
  for (;;) {
    const server = createServer();
    await new Promise((yes, no) => { server.once('error', no); server.listen(0, '127.0.0.1', yes); });
    const port = server.address().port;
    await new Promise((done) => server.close(done));
    if (!used.includes(port)) { used.push(port); return port; }
  }
}

export async function portOpen(port) {
  return new Promise((done) => {
    const socket = connect({ host: '127.0.0.1', port });
    socket.setTimeout(1000);
    socket.once('connect', () => { socket.destroy(); done(true); });
    socket.once('error', () => done(false));
    socket.once('timeout', () => { socket.destroy(); done(true); });
  });
}

export async function stopStack(child) {
  if (!child?.pid) return;
  const kill = (signal) => { try { process.kill(-child.pid, signal); } catch (error) { if (error.code !== 'ESRCH') throw error; } };
  const exited = child.exitCode !== null || child.signalCode !== null
    ? Promise.resolve() : new Promise((done) => child.once('exit', done));
  kill('SIGTERM');
  const timer = setTimeout(() => kill('SIGKILL'), 15_000);
  try { await exited; } finally { clearTimeout(timer); kill('SIGKILL'); }
}

export async function runFreshInstall(config, source = process.env, signal) {
  if (process.platform === 'win32') throw new Error('The fresh-install drill requires a POSIX host');
  const { satisfies, NODE_RANGE } = await import('../packages/hive-release/src/manifest.ts');
  if (!satisfies(process.versions.node, NODE_RANGE)) throw new Error(`Node ${NODE_RANGE} is required`);
  mkdirSync(dirname(config.reportPath), { recursive: true, mode: 0o700 });
  closeSync(openSync(config.reportPath, 'wx', 0o600));
  const report = { version: config.version, success: false, stages: [], cleanup: [] };
  const save = () => writeFileSync(config.reportPath, JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
  const stage = (name) => { report.stage = name; report.stages.push(name); save(); console.log(name); };
  const work = mkdtempSync(join(tmpdir(), 'hive-fresh-npm-'));
  chmodSync(work, 0o700);
  const home = join(work, 'home'), launcher = join(work, 'launcher'), clients = join(work, 'clients');
  const env = isolatedEnvironment(source, work), ports = [], resources = [];
  const project = `hive-fresh-${randomUUID()}`;
  report.ownedResources = { installation: work, containers: [], processGroups: [], ports };
  let stack;
  const run = (cmd, args, opts = {}) => command(cmd, args, { cwd: work, env, signal, ...opts });
  // Registered first so directories are removed after processes, stores and port verification.
  resources.push({ name: 'temporary installation and client profile', remove: async () => {
    rmSync(work, { recursive: true, force: true }); assert.equal(existsSync(work), false);
  } });
  resources.push({ name: 'temporary listeners closed', remove: async () => {
    for (let n = 0; n < 30; n++) {
      if ((await Promise.all(ports.map(portOpen))).every((open) => !open)) return;
      await delay(100);
    }
    throw new Error('A temporary listener is still open');
  } });
  try {
    stage('Checking prerequisites and installing the exact public npm launcher');
    for (const [cmd, args] of [['docker', ['info', '--format', '{{.ServerVersion}}']], ['openssl', ['version']], ['npm', ['--version']]]) await run(cmd, args, { timeout: 30_000 });
    mkdirSync(launcher);
    writeFileSync(join(launcher, 'package.json'), JSON.stringify({ private: true }));
    await run('npm', ['install', '--prefix', launcher, '--save-exact', '--no-audit', '--no-fund', '--registry', registry, `@hivemagnus/hive@${config.version}`]);
    const cli = join(launcher, 'node_modules/@hivemagnus/hive/dist/src/cli.js');
    const manifest = JSON.parse(readFileSync(join(launcher, 'node_modules/@hivemagnus/hive/package.json'))).hiveRelease;
    assert.equal(manifest.version, config.version);
    for (const [name, image, inside] of stores) {
      const port = await freePort(ports), container = `${project}-${name}`;
      report.ownedResources.containers.push(container);
      save();
      // Register before creation, including interrupted/lost docker-run responses.
      resources.push({ name: `${name} container and volumes`, remove: async () => {
        const names = await run('docker', ['ps', '-a', '--filter', `name=^/${container}$`, '--format', '{{.Names}}'], { signal: undefined, timeout: 30_000 });
        if (names.trim()) await run('docker', ['rm', '-fv', container], { signal: undefined, timeout: 30_000 });
        const remaining = await run('docker', ['ps', '-a', '--filter', `name=^/${container}$`, '--format', '{{.Names}}'], { signal: undefined, timeout: 30_000 });
        assert.equal(remaining.trim(), '');
      } });
      await run('docker', ['run', '-d', '--name', container, '-p', `127.0.0.1:${port}:${inside}`, image]);
      if (name === 'qdrant') report.qdrantPort = port;
      else report.redisPort = port;
    }
    for (let attempt = 0; ; attempt++) {
      signal?.throwIfAborted();
      try { if ((await fetch(`http://127.0.0.1:${report.qdrantPort}/readyz`, { signal: AbortSignal.timeout(2000) })).ok) break; } catch {}
      assert.ok(attempt < 60, 'Qdrant readiness timed out'); await delay(500, undefined, { signal });
    }
    const servicePorts = {};
    for (const name of ['memory', 'iam', 'router', 'router-admin', 'skills']) servicePorts[name] = await freePort(ports);
    stage('Initializing IAM, Memory, Router and Skills from public npm');
    await run(process.execPath, [cli, 'init', '--services', 'all', '--yes', '--qdrant-url', `http://127.0.0.1:${report.qdrantPort}`,
      '--redis-url', `redis://127.0.0.1:${report.redisPort}`, ...Object.entries(servicePorts).flatMap(([s, p]) => ['--port', `${s}=${p}`])]);
    const runtime = join(home, 'runtime/node_modules/@hivemagnus');
    report.packages = {};
    for (const name of ['hive', 'hive-router', 'hive-iam-server', 'hivemem-server', 'hive-skills']) {
      const version = JSON.parse(readFileSync(join(runtime, name, 'package.json'))).version;
      assert.equal(version, manifest.components[`@hivemagnus/${name}`]);
      report.packages[name] = version;
    }
    for (const name of ['iam', 'memory', 'router', 'skills', 'upgrade']) {
      const file = join(home, 'config', `${name}.env`);
      let text = readFileSync(file, 'utf8');
      for (const key of switches) text = text.replace(new RegExp(`^${key}=.*$`, 'mg'), '') + `\n${key}=false\n`;
      // Use synthetic admin identifiers, independent of the executing OS account.
      if (name === 'skills') text = text.replace(/^HIVE_SKILLS_ADMIN_USERS=.*$/m, 'HIVE_SKILLS_ADMIN_USERS=admin');
      writeFileSync(file, text, { mode: 0o600 });
    }
    const caFile = join(work, 'trust.pem');
    writeFileSync(caFile, Buffer.concat([readFileSync(join(home, 'tls/ca.crt')), Buffer.from('\n'), config.extraCa]), { mode: 0o600 });
    env.NODE_EXTRA_CA_CERTS = caFile;
    await run(process.execPath, [join(runtime, 'hive-skills/dist/cli.js'), 'seed', '--env-file', join(home, 'config/skills.env')]);
    resources.push({ name: 'launcher and service processes', remove: async () => stopStack(stack) });
    const start = async () => {
      const fd = openSync(join(work, 'stack.log'), 'a', 0o600);
      try { stack = spawn(process.execPath, [cli, 'start'], { cwd: home, env, detached: true, stdio: ['ignore', fd, fd] }); }
      finally { closeSync(fd); }
      if (stack.pid) report.ownedResources.processGroups.push(stack.pid);
      save();
      stack.on('error', () => {});
      for (let attempt = 0; attempt < 160; attempt++) {
        signal?.throwIfAborted(); assert.equal(stack.exitCode, null, 'Fresh launcher exited before readiness');
        try {
          const status = JSON.parse(await run(process.execPath, [cli, 'status', '--json'], { timeout: 15_000 }));
          if (status.ok) {
            assert.deepEqual(status.services.map((service) => service.service).sort(), ['iam', 'memory', 'router', 'skills']);
            for (const service of status.services) for (const listener of service.listeners) assert.equal(listener.version, report.packages[service.service === 'memory' ? 'hivemem-server' : service.service === 'iam' ? 'hive-iam-server' : `hive-${service.service}`]);
            return;
          }
        } catch {}
        await delay(500, undefined, { signal });
      }
      throw new Error('Fresh stack readiness/version verification timed out');
    };
    stage('Starting all four services and verifying running package versions');
    await start();
    const credentials = parseEnv(readFileSync(join(home, 'iam/initial-credentials.env'), 'utf8'));
    const token = (await run(process.execPath, [join(runtime, 'hivemem-server/dist/src/cli.js'), 'issue-token', '--subject', 'fresh-install-test', '--role', 'admin', '--ttl', '1h', '--env-file', join(home, 'config/memory.env')])).trim();
    const sdkVersion = manifest.testedSdks?.['@hivemagnus/hivemem-sdk'];
    assert.match(sdkVersion, /^\d+\.\d+\.\d+$/);
    await run('npm', ['install', '--prefix', clients, '--save-exact', '--no-audit', '--no-fund', '--registry', registry, `@hivemagnus/hivemem-sdk@${sdkVersion}`]);
    const contextFile = join(work, 'context.json'), modelReport = join(work, 'model.json'), skillsReport = join(work, 'skills.json');
    writeFileSync(contextFile, JSON.stringify({ runtime, clients, modelReport, skillsReport, baseUrl: `https://localhost:${servicePorts.skills}`, hermesHome: join(work, 'hermes') }), { mode: 0o600 });
    const probeEnv = { ...env, HIVE_FRESH_CONTEXT: contextFile, ...config.provider,
      HIVE_E2E_ADMIN_URL: `https://localhost:${servicePorts['router-admin']}`, HIVE_E2E_API_URL: `https://localhost:${servicePorts.router}`,
      HIVE_E2E_MEMORY_URL: `https://localhost:${servicePorts.memory}`, HIVE_E2E_USERNAME: 'admin',
      HIVE_E2E_PASSWORD: credentials.SEED_ADMIN_PASSWORD, HIVE_E2E_MEMORY_TOKEN: token };
    stage('Checking real provider streaming and private memory recall with the published SDK');
    try {
      console.log(await run(process.execPath, [join(root, 'scripts/fresh-npm-probes.mjs'), 'model'], { env: probeEnv, timeout: 1_800_000 }));
    } finally {
      if (existsSync(modelReport)) { report.model = JSON.parse(readFileSync(modelReport)); save(); }
    }
    assert.equal(report.model.success, true);
    stage('Checking Skills discovery, archive digest, authorization boundaries and bridge replay');
    await run(process.execPath, [join(root, 'scripts/fresh-npm-probes.mjs'), 'skills'], { env: { ...env, HIVE_FRESH_CONTEXT: contextFile } });
    report.skills = JSON.parse(readFileSync(skillsReport));
    stage('Restarting the stack and checking Skills persistence');
    await stopStack(stack); await start();
    await run(process.execPath, [join(root, 'scripts/fresh-npm-probes.mjs'), 'skills'], { env: { ...env, HIVE_FRESH_CONTEXT: contextFile } });
    assert.deepEqual(JSON.parse(readFileSync(skillsReport)), report.skills);
    report.restartPersistence = true;
    report.success = true;
  } catch {
    report.failure = signal?.aborted ? 'interrupted' : 'failed';
    console.error(`Fresh npm test ${report.failure} during: ${report.stage}.`);
  } finally {
    report.cleanup = await cleanResources(resources);
    if (report.cleanup.some((entry) => !entry.passed)) report.success = false;
    // Retain only a private, credential-free receipt, never the installation or its logs.
    save();
  }
  console.log(`${report.success ? 'PASS' : 'FAIL'} fresh npm full stack; private report: ${config.reportPath}`);
  return report;
}

export async function main(args = process.argv.slice(2), inherited = process.env) {
  if (args.length === 1 && ['--help', '-h'].includes(args[0])) { console.log(help); return 0; }
  let env = inherited, config;
  try {
    if (args.length) {
      if (args.length !== 2 || args[0] !== '--env-file') throw new Error('Use --help for supported arguments');
      env = { ...parseEnv(readFileSync(args[1], 'utf8')), ...inherited };
    }
    config = await readFreshConfig(env);
  } catch (error) { console.error(error.code ? 'Unable to read configuration; use --help.' : error.message); return 2; }
  const controller = new AbortController();
  let interrupted;
  const interrupt = () => { interrupted = 130; controller.abort(); };
  const terminate = () => { interrupted = 143; controller.abort(); };
  process.on('SIGINT', interrupt); process.on('SIGTERM', terminate);
  try { const report = await runFreshInstall(config, inherited, controller.signal); return interrupted ?? (report.success ? 0 : 1); }
  catch { console.error('Unable to start fresh test; check Node, platform and unused report path.'); return 2; }
  finally { process.off('SIGINT', interrupt); process.off('SIGTERM', terminate); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) process.exitCode = await main();
