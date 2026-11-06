#!/usr/bin/env node
// Developer rehearsal of hive.sh migrate-native on one restored native installation. It
// runs the real public native packages and the real controller against copies, on a local
// Docker target, with no outbound network. Never selects or contacts a production host.
// Usage: native-migration-rehearsal.mjs --config PRIVATE_JSON [--cleanup]
//
// Optional configuration:
//   controllerRoot  the controller to rehearse, such as an extracted release tag; default this tree
//   liveTraffic     {intervalMs, pendingJobs}: clients keep using the installation through the
//                   cutover, as on a busy host, and the native memory queue holds pending jobs
//                   at capture. The suite memory worker runs, as it does in production.
//   expectRollback  the cutover must fail verification and roll back (a negative control)
//   backupRehearsal run hive.sh backup on the migrated suite, measure its stop window, then
//                   rehearse a restore of the archive
//   signIn          false skips the sign-in fork, the reset rehearsal and the browser
//   refreshMemoryToken  renew the Router memory proxy token natively, then run refresh-memory-token
import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { createHash, randomBytes, scryptSync } from 'node:crypto';
import { chmodSync, cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseEnv } from 'node:util';
import { applySuiteCatalog, hiveRegistryComponent } from './suite-catalog.mjs';

const args = process.argv.slice(2);
assert(args[0] === '--config' && args[1], 'Usage: native-migration-rehearsal.mjs --config PRIVATE_JSON [--cleanup]');
const configStat = lstatSync(args[1]);
assert(configStat.isFile() && configStat.uid === process.getuid() && (configStat.mode & 0o077) === 0, 'The configuration must be owner-only');
const c = JSON.parse(readFileSync(args[1], 'utf8'));
const root = resolve(import.meta.dirname, '../..');
const controller = c.controllerRoot ? resolve(c.controllerRoot) : root;
const hiveScript = join(controller, 'hive.sh');
const out = c.output, prefix = 'hive-mn-' + c.host;
const run = (program, argv, options = {}) => execFileSync(program, argv, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], maxBuffer: 256 * 1024 * 1024, ...options });
const docker = (...argv) => run('docker', argv).trim();
const put = (name, value) => { writeFileSync(join(out, name), typeof value === 'string' ? value : JSON.stringify(value, null, 2) + '\n', { mode: 0o600 }); };
const sha = (value) => createHash('sha256').update(value).digest('hex');
const say = (text) => console.log(new Date().toISOString().slice(11, 19) + ' ' + text);
const native = join(out, 'native'), suite = join(out, 'suite'), fork = join(out, 'fork');
const nativeNames = ['router', 'iam', 'memory', 'skills', 'qdrant', 'redis', 'pause'].map((name) => prefix + '-native-' + name);
const unitContainer = { 'hive-router': 'router', 'hive-iam': 'iam', hivemem: 'memory', 'hive-skills': 'skills', qdrant: 'qdrant' };
const hasSkills = () => existsSync(join(c.restored, 'state/opt/hive-skills/shared/.env'));
const logName = (label) => { let name = 'hive-' + label + '.log'; for (let index = 2; existsSync(join(out, name)); index++) name = 'hive-' + label + '-' + index + '.log'; return name; };
const suiteCommand = (argv, label) => {
  const started = Date.now();
  const result = spawnSync(hiveScript, [...argv, '--config', join(out, 'installation.json'), '--manifest', join(out, 'release.json'), '--trust-key', join(out, 'publisher.pub'), '--non-interactive'], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
  writeFileSync(join(out, logName(label)), result.stdout + '\n--- stderr\n' + result.stderr, { mode: 0o600 });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr, seconds: (Date.now() - started) / 1000, startedAt: new Date(started).toISOString(), finishedAt: new Date().toISOString() };
};
const hive = (subcommand, ...extra) => suiteCommand(['migrate-native', subcommand, ...extra], subcommand);
const parseJSONLine = (text) => JSON.parse(text.split('\n').reverse().find((line) => line.startsWith('{')));

function cleanup() {
  const ids = spawnSync('docker', ['ps', '-aq', '--filter', 'label=hive.migration.rehearsal=' + c.host], { encoding: 'utf8' }).stdout.trim().split('\n').filter(Boolean);
  for (const project of [c.installation + '-control', 'dryrun-' + c.installation, c.installation + '-fork']) {
    for (const id of spawnSync('docker', ['ps', '-aq', '--filter', 'label=com.docker.compose.project=' + project], { encoding: 'utf8' }).stdout.trim().split('\n').filter(Boolean)) ids.push(id);
  }
  // Isolated restore rehearsals of a backup archive run as their own projects.
  for (const line of spawnSync('docker', ['ps', '-a', '--format', '{{.ID}} {{.Label "com.docker.compose.project"}}'], { encoding: 'utf8' }).stdout.trim().split('\n').filter(Boolean)) {
    const [id, project] = line.split(' ');
    if (project?.startsWith('rehearsal-' + c.installation + '-')) ids.push(id);
  }
  if (ids.length) spawnSync('docker', ['rm', '-f', '-v', ...ids], { stdio: 'ignore' });
  for (const name of spawnSync('docker', ['network', 'ls', '--format', '{{.Name}}'], { encoding: 'utf8' }).stdout.split('\n')) {
    if (name === prefix + '-native' || name.startsWith('rehearsal-' + c.installation + '-') || name.startsWith(c.installation + '-control_') || name.startsWith('dryrun-' + c.installation + '_') || name.startsWith(c.installation + '-fork_')) spawnSync('docker', ['network', 'rm', name], { stdio: 'ignore' });
  }
  spawnSync('docker', ['rm', '-f', prefix + '-images'], { stdio: 'ignore' });
}
if (args[2] === '--cleanup') { cleanup(); process.exit(0); }
assert(!existsSync(out), 'Choose a new output directory: earlier evidence is retained');
mkdirSync(out, { recursive: true, mode: 0o700 });

// ---- A signed release with exact images, in a private registry for this run. ----
function release() {
  const template = JSON.parse(readFileSync(c.template, 'utf8'));
  const names = ['oathweave', 'oathweave-redis', 'emberpath', 'hivemem', 'hivemem-qdrant', 'hiveskills', 'hivexui', 'ingress'];
  const manifest = { schema: 1, version: c.version ?? '0.1.0', networks: { 'identity-data': template.networks['identity-data'], 'memory-data': template.networks['memory-data'] }, components: Object.fromEntries(names.map((name) => [name, template.components[name]])), profiles: {} };
  const user = process.getuid() + ':' + process.getgid();
  const port = Number(docker('run', '-d', '--name', prefix + '-images', '--label', 'hive.migration.rehearsal=' + c.host, '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges:true', '--user', user, '--tmpfs', `/var/lib/registry:uid=${process.getuid()},gid=${process.getgid()},mode=700`, '-p', '127.0.0.1::5000', c.images.registry) && docker('inspect', prefix + '-images', '--format', '{{(index (index .NetworkSettings.Ports "5000/tcp") 0).HostPort}}'));
  const registry = '127.0.0.1:' + port;
  for (let attempt = 0; attempt < 30; attempt++) { if (spawnSync('curl', ['-fsS', '-o', '/dev/null', `http://${registry}/v2/`]).status === 0) break; execFileSync('sleep', ['1']); }
  manifest.components['hive-registry'] = hiveRegistryComponent('pending', user);
  const local = { oathweave: c.images.oathweave, emberpath: c.images.emberpath, hivemem: c.images.hivemem, hiveskills: c.images.hiveskills, hivexui: c.images.hivexui, ingress: c.images.ingress, 'hive-registry': c.images.registryProduct };
  const revisions = {};
  for (const [name, image] of Object.entries(local)) {
    const tag = `${registry}/migrate/${name}:candidate`;
    docker('tag', image, tag);
    // A pulled multi-platform release image holds only this platform's content, so the push
    // carries that platform's manifest, under its own digest.
    const pushed = /digest: (sha256:[a-f0-9]{64})/.exec(docker('push', tag))?.[1];
    manifest.components[name].image = pushed ? `${registry}/migrate/${name}@${pushed}` : JSON.parse(docker('image', 'inspect', tag, '--format', '{{json .RepoDigests}}')).find((value) => value.startsWith(`${registry}/migrate/${name}@sha256:`));
    revisions[name] = docker('image', 'inspect', tag, '--format', '{{index .Config.Labels "org.opencontainers.image.revision"}}');
    docker('rmi', tag);
  }
  manifest.components['hive-registry'].service.user = user;
  for (const component of Object.values(manifest.components)) if (component.service?.user !== '101:101') component.service.user = user;
  applySuiteCatalog(manifest);
  manifest.profiles = { core: Object.keys(manifest.components).sort(), full: Object.keys(manifest.components).sort() };
  put('release.json', manifest);
  run('openssl', ['genpkey', '-algorithm', 'ed25519', '-out', join(out, 'publisher.key')]);
  run('openssl', ['pkey', '-in', join(out, 'publisher.key'), '-pubout', '-out', join(out, 'publisher.pub')]);
  run('openssl', ['pkeyutl', '-sign', '-inkey', join(out, 'publisher.key'), '-rawin', '-in', join(out, 'release.json'), '-out', join(out, 'release.json.sig')]);
  put('image-revisions.json', revisions);
  return manifest;
}

// ---- The source: real native packages on a restored copy, on an internal network. ----
function nativeEnv(files, defaults = {}) {
  const merged = { ...defaults };
  for (const file of files) {
    for (const line of readFileSync(file, 'utf8').split('\n')) {
      const match = /^\s*([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line);
      if (!match) continue;
      let value = match[2].trim();
      if ((value[0] === '"' && value.at(-1) === '"') || (value[0] === "'" && value.at(-1) === "'")) value = value.slice(1, -1);
      merged[match[1]] = value;
    }
  }
  return merged;
}
function installRuntime(base, directory) {
  const releases = join(native, 'state', base, 'releases');
  const id = readdirSync(releases).find((name) => existsSync(join(releases, name, 'runtime/package-lock.json')));
  assert(id, 'The backup has no native package lock');
  symlinkSync('releases/' + id, join(native, 'state', base, 'current'));
  const runtime = join(releases, id, 'runtime');
  if (!existsSync(join(runtime, 'node_modules'))) {
    run('docker', ['run', '--rm', '--user', process.getuid() + ':' + process.getgid(), '-e', 'HOME=/tmp', '-w', '/runtime', '--mount', `type=bind,source=${runtime},target=/runtime`, c.images.utility, 'sh', '-c', 'npm ci --omit=dev --ignore-scripts --registry=https://registry.npmjs.org >/dev/null 2>&1 && (npm rebuild better-sqlite3 argon2 >/dev/null 2>&1 || true)']);
  }
  return runtime;
}
function startNative() {
  say('native: copying the restored tree and installing the archived native packages');
  cpSync(c.restored, native, { recursive: true, verbatimSymlinks: true });
  if (c.liveTraffic) trafficKey = insertTrafficKey();
  installRuntime('opt/hive-npm');
  if (hasSkills()) {
    installRuntime('opt/hive-skills/npm');
    const packageDir = 'npm/current/runtime/node_modules/@hivemagnus/hive-skills';
    symlinkSync(packageDir, join(native, 'state/opt/hive-skills/current'));
  }
  mkdirSync(join(native, 'state/opt/hivemem/ts-core'), { recursive: true });
  mkdirSync(join(native, 'state/var/log/hivemem'), { recursive: true });
  docker('network', 'create', '--internal', '--subnet', c.subnets.native, prefix + '-native');
  const address = c.subnets.native.replace(/\.0\/24$/, '.10');
  const hosts = ['--add-host', c.fqdn + ':127.0.0.1', '--add-host', c.host + ':127.0.0.1'];
  const user = process.getuid() + ':' + process.getgid();
  const label = ['--label', 'hive.migration.rehearsal=' + c.host];
  docker('run', '-d', '--name', prefix + '-native-pause', ...label, '--network', prefix + '-native', '--ip', address, ...hosts, '--sysctl', 'net.ipv4.ip_unprivileged_port_start=0', '--entrypoint', 'sleep', c.images.utility, 'infinity');
  const netns = ['--network', 'container:' + prefix + '-native-pause'];
  docker('run', '-d', '--name', prefix + '-native-redis', ...label, ...netns, '--user', user, c.images.redis, 'redis-server', '--save', '', '--appendonly', 'no', '--bind', '0.0.0.0', '--protected-mode', 'no');
  const manifest = JSON.parse(readFileSync(join(native, 'recovery/manifest.json'), 'utf8'));
  mkdirSync(join(out, 'native-qdrant'), { mode: 0o700 });
  docker('run', '-d', '--name', prefix + '-native-qdrant', ...label, ...netns, '--user', user, '--workdir', '/data', '--mount', `type=bind,source=${join(out, 'native-qdrant')},target=/data`, '--mount', `type=bind,source=${join(native, 'recovery')},target=/snapshots,readonly`, '-e', 'QDRANT__STORAGE__STORAGE_PATH=/data/storage', '-e', 'QDRANT__STORAGE__SNAPSHOTS_PATH=/data/snapshots', '-e', 'QDRANT__TELEMETRY_DISABLED=true', '--entrypoint', '/qdrant/qdrant', c.images.qdrant, ...manifest.qdrant.flatMap((snapshot) => ['--snapshot', `/snapshots/${snapshot.file}:${snapshot.collection}`]));
  const dataTool = (request, ...extra) => run('docker', ['run', '--rm', '--network', prefix + '-native', '--user', user, '--read-only', '--tmpfs', '/tmp:mode=1777', ...extra, '--entrypoint', 'node', c.images.utility, '--no-warnings', '--input-type=module', '-e', readFileSync(join(root, 'scripts/suite/migrate-native-data.mjs'), 'utf8'), JSON.stringify(request)]).trim();
  for (let attempt = 0; attempt < 90; attempt++) {
    try { const inventory = JSON.parse(dataTool({ command: 'qdrant-inventory', url: `http://${address}:6333` })); if (inventory.totalCollections === manifest.qdrant.length) break; } catch { /* still restoring */ }
    execFileSync('sleep', ['2']);
    assert(attempt < 89, 'Native Qdrant did not restore');
  }
  // A native Qdrant restarts on its own storage, as it does on the source host.
  docker('stop', '--time', '30', prefix + '-native-qdrant');
  docker('rm', prefix + '-native-qdrant');
  docker('run', '-d', '--name', prefix + '-native-qdrant', ...label, ...netns, '--user', user, '--workdir', '/data', '--mount', `type=bind,source=${join(out, 'native-qdrant')},target=/data`, '-e', 'QDRANT__STORAGE__STORAGE_PATH=/data/storage', '-e', 'QDRANT__STORAGE__SNAPSHOTS_PATH=/data/snapshots', '-e', 'QDRANT__TELEMETRY_DISABLED=true', '--entrypoint', '/qdrant/qdrant', c.images.qdrant);
  for (let attempt = 0; attempt < 60; attempt++) {
    try { if (JSON.parse(dataTool({ command: 'qdrant-inventory', url: `http://${address}:6333` })).totalCollections === manifest.qdrant.length) break; } catch { /* starting */ }
    execFileSync('sleep', ['2']);
    assert(attempt < 59, 'Native Qdrant did not restart');
  }
  const redisFile = join(out, 'native-redis.json');
  const dump = JSON.parse(readFileSync(join(native, 'recovery/redis.json'), 'utf8'));
  writeFileSync(redisFile, JSON.stringify(dump), { mode: 0o600 });
  for (let attempt = 0; attempt < 15; attempt++) {
    try { dataTool({ command: 'redis-import', url: `redis://${address}:6379`, input: '/in/redis.json' }, '--mount', `type=bind,source=${redisFile},target=/in/redis.json,readonly`); break; } catch (error) { if (attempt === 14) throw error; execFileSync('sleep', ['1']); }
  }
  const mounts = [['state/opt', '/opt'], ['state/var/opt/hivemem', '/var/opt/hivemem'], ['state/var/lib/hive-iam-keyring', '/var/lib/hive-iam-keyring'], ['state/var/lib/hive-iam-pki', '/var/lib/hive-iam-pki'], ['state/var/log/hivemem', '/var/log/hivemem']].flatMap(([source, target]) => ['--mount', `type=bind,source=${join(native, source)},target=${target}`]);
  const off = { HIVE_AUTO_UPGRADE: 'false', HIVE_AUTO_MIGRATE: 'false', HIVE_UPDATE_CHECK: 'false', HIVE_UI_UPGRADE: 'false', HIVE_REHEARSAL: 'true', HIVEMEM_WORKER_ENABLED: 'false', HIVE_SKILLS_DEPLOYMENT_WORKER_ENABLED: 'false', OTEL_SDK_DISABLED: 'true' };
  const service = (name, workdir, entry, files, defaults = {}) => {
    const environment = { ...nativeEnv(files, defaults), ...off };
    const file = join(out, 'native-' + name + '.env');
    writeFileSync(file, Object.entries(environment).map(([key, value]) => `${key}=${value}`).join('\n') + '\n', { mode: 0o600 });
    docker('run', '-d', '--name', prefix + '-native-' + name, ...label, ...netns, '--user', user, '-w', workdir, ...mounts, '--env-file', file, '--entrypoint', 'node', c.images.utility, entry);
  };
  const state = (path) => join(native, 'state', path);
  service('memory', '/opt/hivemem/ts-core', '/opt/hive-npm/current/runtime/node_modules/@hivemagnus/hivemem-server/dist/src/cli.js', [state('opt/hivemem/.env')], { HIVEMEM_TS_CORE_HOST: '0.0.0.0', HIVEMEM_TS_PERSISTENCE: 'qdrant', HIVEMEM_STORAGE_PATH: '/var/opt/hivemem', HIVEMEM_TS_TLS_CERT_FILE: '/opt/hivemem/certs/server.crt', HIVEMEM_TS_TLS_KEY_FILE: '/opt/hivemem/certs/server.key' });
  service('iam', '/opt/hive-iam', '/opt/hive-npm/current/runtime/node_modules/@hivemagnus/hive-iam-server/dist/index.js', [state('opt/hive-iam/.env'), state('var/lib/hive-iam-keyring/current/keyring.env')]);
  service('router', '/opt/hive-router/current', '/opt/hive-npm/current/runtime/node_modules/@hivemagnus/hive-router/dist/src/index.js', [state('opt/hive-router/shared/.env')]);
  if (hasSkills()) service('skills', '/opt/hive-skills/current', '/opt/hive-skills/current/dist/server.js', [state('opt/hive-skills/shared/.env')]);
  const control = join(out, 'native-control.sh');
  writeFileSync(control, `#!/usr/bin/env bash\nset -euo pipefail\nverb=$1 unit=$2\ncase "$unit" in hive-router) c=router;; hive-iam) c=iam;; hivemem) c=memory;; hive-skills) c=skills;; qdrant) c=qdrant;; *) exit 1;; esac\nname=${prefix}-native-$c\ncase "$verb" in\n stop) docker stop --time 20 "$name" >/dev/null;;\n start) docker start "$name" >/dev/null;;\n is-active) [[ $(docker inspect -f '{{.State.Running}}' "$name") == true ]];;\n *) exit 1;;\nesac\n`, { mode: 0o700 });
  return { address, control, manifest };
}

// ---- Live traffic: a busy host keeps serving clients through the cutover. ----
let trafficKey = null;
// A client API key like the one a native client holds, so traffic can use the model port.
function insertTrafficKey() {
  const key = 'sk-' + randomBytes(36).toString('base64url');
  const salt = randomBytes(16).toString('hex');
  const now = new Date().toISOString().replace('Z', '+00:00');
  const id = 'rehearsal' + randomBytes(8).toString('hex');
  run('sqlite3', ['-cmd', '.timeout 15000', join(native, 'state/opt/hive-router/shared/data/router.db'), `INSERT INTO ClientApiKey (id,name,keyPrefix,keyHash,enabled,metadataJson,lastUsedAt,createdAt,updatedAt,expiresAt) VALUES ('${id}','rehearsal-traffic','${key.slice(0, 8)}','${salt}:${scryptSync(key, salt, 64).toString('hex')}',1,'{"consumer":"rehearsal-traffic"}',NULL,'${now}','${now}',NULL)`]);
  return { key, id };
}
// The rehearsal configuration turns the suite memory worker off. A production host runs it, so
// this run does too, and the deployment input receipt is pinned again for the edited file.
function productionWorker() {
  const file = join(suite, 'config/hivemem.env');
  writeFileSync(file, readFileSync(file, 'utf8').split('\n').filter((line) => !line.startsWith('HIVEMEM_WORKER_ENABLED=')).join('\n'));
  const candidate = readdirSync(suite).find((name) => /^candidate\.[a-f0-9]{64}\.json$/.test(name));
  assert(candidate, 'prepare staged no candidate');
  const digest = run('bash', ['-c', 'die() { exit 1; }; source "$1"; deployment_inputs_digest "$2"', '_', join(controller, 'scripts/suite/input-artifacts-host.sh'), join(suite, candidate)]).trim();
  assert.match(digest, /^[a-f0-9]{64}$/);
  writeFileSync(join(suite, 'deployment-inputs.' + candidate.slice(10, -5) + '.json'), JSON.stringify({ schema: 1, sha256: digest }), { mode: 0o600 });
  return { workerEnabled: true };
}
function memoryRequest(address, trust, method, path, body) {
  const header = join(out, 'memory-request.header');
  writeFileSync(header, 'Authorization: Bearer ' + nativeEnv([join(native, 'state/opt/hivemem/.env')]).HIVEMEM_ADMIN_TOKEN + '\n', { mode: 0o600 });
  const name = nameFor(memoryPort());
  try {
    const reply = spawnSync('curl', ['-sS', '-w', '\n%{http_code}', '--max-time', '20', '-X', method, '--resolve', `${name}:${memoryPort()}:${address}`, '--cacert', trust, '-H', '@' + header, ...(body ? ['-H', 'Content-Type: application/json', '--data-binary', '@-'] : []), `https://${name}:${memoryPort()}${path}`], { input: body ? JSON.stringify(body) : undefined, encoding: 'utf8' });
    const lines = reply.stdout.trim().split('\n');
    return { status: lines.pop(), body: lines.join('\n') };
  } finally { rmSync(header, { force: true }); }
}
const queueState = (address, trust) => { const reply = memoryRequest(address, trust, 'GET', '/v1/queue/status?limit=1'); try { const body = JSON.parse(reply.body); return { status: reply.status, pending: body.worker?.pending_jobs ?? body.pending_count ?? null, workerEnabled: body.worker?.enabled ?? null, total: body.total ?? null }; } catch { return { status: reply.status }; } };
// Shared memories written to the native service, whose worker is off, wait as queue jobs.
function pendingJobs(address, trust, count) {
  const statuses = [];
  for (let index = 0; index < count; index++) statuses.push(memoryRequest(address, trust, 'POST', '/v1/memories', { content: `Native memory ${index} written before the cutover; its queue job is still pending at capture.`, type: 'semantic', scope: 'shared', source: 'observation', tags: ['pending-at-capture'] }).status);
  assert(statuses.every((status) => status === '201'), 'Native memory writes: ' + statuses.join(','));
  const queue = queueState(address, trust);
  assert(queue.pending >= count, 'The native queue must hold pending jobs at capture: ' + JSON.stringify(queue));
  return { written: count, queue };
}
function startTraffic(trust) {
  const work = join(out, 'traffic');
  mkdirSync(work, { mode: 0o700 });
  const router = nativeEnv([join(native, 'state/opt/hive-router/shared/.env')]);
  const file = join(work, 'traffic.json');
  const log = join(out, 'traffic.jsonl');
  const stopFile = join(work, 'stop');
  writeFileSync(file, JSON.stringify({ work, log, stopFile, address: c.address, fqdn: c.fqdn, trust, apiKey: trafficKey.key, memoryToken: nativeEnv([join(native, 'state/opt/hivemem/.env')]).HIVEMEM_ADMIN_TOKEN, memoryName: nameFor(memoryPort()), memoryPort: memoryPort(), clientId: router.HIVE_ROUTER_IAM_CLIENT_ID, clientSecret: router.HIVE_ROUTER_IAM_CLIENT_SECRET, intervalMs: c.liveTraffic.intervalMs ?? 2000 }), { mode: 0o600 });
  const child = spawn(process.execPath, [join(root, 'scripts/suite/native-migration-traffic.mjs'), file], { stdio: 'ignore' });
  const exited = new Promise((done) => child.once('exit', done));
  return {
    log,
    stop: async () => { writeFileSync(stopFile, ''); await Promise.race([exited, new Promise((done) => setTimeout(done, 20000))]); child.kill(); rmSync(file, { force: true }); },
  };
}
const trafficEntries = (log) => (existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line)) : []);
function trafficSummary(log, from, to) {
  const summary = {};
  for (const entry of trafficEntries(log)) {
    if ((from && entry.at < from) || (to && entry.at > to)) continue;
    const item = (summary[entry.kind] ??= { ok: 0, failed: 0, statuses: {} });
    item[entry.ok ? 'ok' : 'failed']++;
    item.statuses[entry.status] = (item.statuses[entry.status] ?? 0) + 1;
  }
  return summary;
}
// The longest time no request of a kind succeeded, between two instants.
function outage(log, kind, from, to) {
  const entries = trafficEntries(log).filter((entry) => entry.kind === kind && entry.at >= from && entry.at <= to).sort((a, b) => a.at.localeCompare(b.at));
  let longest = 0, lastOk = from;
  for (const entry of entries) if (entry.ok) { longest = Math.max(longest, Date.parse(entry.at) - Date.parse(lastOk)); lastOk = entry.at; }
  return { seconds: longest / 1000, requests: entries.length, failed: entries.filter((entry) => !entry.ok).length };
}
function containerTimes() {
  const ids = run('docker', ['compose', '-f', join(suite, 'compose.json'), 'ps', '-aq']).trim().split('\n').filter(Boolean);
  return ids.map((id) => JSON.parse(docker('inspect', id, '--format', '{"name":{{json .Name}},"started":{{json .State.StartedAt}},"finished":{{json .State.FinishedAt}}}')));
}
async function backupRehearsal(trust, traffic) {
  const archive = 'rehearsal-backup-' + randomBytes(3).toString('hex');
  say('backup: hive.sh backup on the migrated suite' + (traffic ? ', with clients still connected' : ''));
  const backup = suiteCommand(['backup', '--archive', archive, '--yes'], 'backup');
  assert.equal(backup.status, 0, backup.stderr.slice(-3000));
  const times = containerTimes();
  const stopped = times.map((item) => Date.parse(item.finished)).filter((value) => value > Date.parse(backup.startedAt));
  const started = times.map((item) => Date.parse(item.started)).filter((value) => value > Date.parse(backup.startedAt));
  const ingress = times.find((item) => /ingress/.test(item.name));
  const receipt = JSON.parse(readFileSync(join(suite, 'backups', archive, 'receipt.json'), 'utf8'));
  const result = {
    archive, commandSeconds: backup.seconds, archiveBytes: statSync(join(suite, 'backups', archive, 'state.tar.gz')).size,
    receipt: { verified: receipt.verified, installation: receipt.installation, sha256: receipt.sha256, dataSHA256: receipt.dataSHA256, release: receipt.release?.version },
    stopWindow: { allContainersSeconds: (Math.max(...started) - Math.min(...stopped)) / 1000, ingressSeconds: (Date.parse(ingress.started) - Date.parse(ingress.finished)) / 1000, firstStop: new Date(Math.min(...stopped)).toISOString(), lastStart: new Date(Math.max(...started)).toISOString() },
  };
  if (traffic) result.clientOutage = Object.fromEntries(['api-key', 'memory-write', 'client-token'].map((kind) => [kind, outage(traffic.log, kind, backup.startedAt, new Date(Date.now() + 1).toISOString())]));
  result.probesAfterBackup = probes(c.address, trust);
  say('restore check: hive.sh rehearse restores the archive into an isolated copy');
  const restore = suiteCommand(['rehearse', '--archive', archive, '--yes'], 'rehearse');
  assert.equal(restore.status, 0, restore.stderr.slice(-3000));
  const restored = JSON.parse(readFileSync(join(suite, 'rehearsals', archive, 'result.json'), 'utf8'));
  assert.equal(restored.result, 'passed');
  assert.equal(restored.archiveSHA256, receipt.sha256);
  result.restoreCheck = { seconds: restore.seconds, result: restored.result, isolated: restored.isolated, portsPublished: restored.portsPublished, archiveSHA256Matches: true };
  return result;
}
// A renewal writes a new memory proxy token to the native Router file. A credential HiveMem accepts
// stands in for the renewed value; it is compared by digest and never printed.
function refreshMemoryToken() {
  const file = join(native, 'state/opt/hive-router/shared/.env');
  const renewed = nativeEnv([join(native, 'state/opt/hivemem/.env')]).HIVEMEM_ADMIN_TOKEN;
  const inside = () => sha(docker('compose', '-f', join(suite, 'compose.json'), 'exec', '-T', 'emberpath', 'node', '-e', 'process.stdout.write(process.env.HIVE_ROUTER_MEMORY_PROXY_TOKEN ?? "")'));
  assert.notEqual(inside(), sha(renewed), 'The stand-in must differ from the copied token');
  writeFileSync(file, readFileSync(file, 'utf8').split('\n').filter((line) => !line.startsWith('HIVE_ROUTER_MEMORY_PROXY_TOKEN=')).join('\n') + '\nHIVE_ROUTER_MEMORY_PROXY_TOKEN=' + renewed + '\n');
  const started = () => docker('inspect', run('docker', ['compose', '-f', join(suite, 'compose.json'), 'ps', '-q', 'emberpath']).trim(), '--format', '{{.State.StartedAt}}');
  const before = started();
  const first = hive('refresh-memory-token');
  assert.equal(first.status, 0, first.stderr.slice(-2000));
  assert(!(first.stdout + first.stderr).includes(renewed), 'The token must never be printed');
  assert.equal(inside(), sha(renewed), 'Emberpath runs with the renewed token');
  const second = hive('refresh-memory-token');
  assert.equal(second.status, 0);
  assert.match(second.stderr, /already has the current memory proxy token/);
  const mode = (statSync(join(suite, 'config/emberpath.env')).mode & 0o777).toString(8);
  assert.equal(mode, '600');
  return { seconds: first.seconds, emberpathRecreated: started() !== before, containerHasRenewedValue: true, repeatChangedNothing: true, fileMode: mode, valuePrinted: false };
}

// Native clients trust exactly these files, so probes use nothing else.
function trustFile() {
  const state = (path) => join(native, 'state', path);
  const files = [state('opt/hive-router/shared/certs/server.crt'), state('opt/hive-iam/certs/ca.crt'), state('opt/hivemem/certs/server.crt')];
  const file = join(out, 'native-trust.pem');
  writeFileSync(file, files.map((path) => readFileSync(path, 'utf8')).join('\n'), { mode: 0o600 });
  return file;
}
function probeList(iam) {
  const memoryPort = nativeEnv([join(native, 'state/opt/hivemem/.env')]).HIVEMEM_WEB_PORT ?? '18790';
  return [[443, '/health/ready'], [443, '/v1/health/ready'], [443, '/dashboard'], [4020, '/health/ready'], [4020, '/v1/models'], [4200, '/api/v1/health/ready'], [4200, '/api/v1/oauth/jwks'], [Number(memoryPort), '/v1/health/ready'], ...(hasSkills() ? [[4030, '/healthz']] : [])];
}
const memoryPort = () => Number(nativeEnv([join(native, 'state/opt/hivemem/.env')]).HIVEMEM_WEB_PORT ?? 18790);
// Each native certificate has its own names; a client uses a name its certificate carries.
const nameFor = (port) => (port === memoryPort() && !/does match/.test(run('openssl', ['x509', '-in', join(native, 'state/opt/hivemem/certs/server.crt'), '-noout', '-checkhost', c.fqdn])) ? c.host : c.fqdn);
function probes(address, trust) {
  const result = {};
  for (const [port, path] of probeList()) {
    const name = nameFor(port);
    const reply = spawnSync('curl', ['-sS', '-o', '/dev/null', '-w', '%{http_code}', '--max-time', '15', '--resolve', `${name}:${port}:${address}`, '--cacert', trust, `https://${name}:${port}${path}`], { encoding: 'utf8' });
    result[port + path] = reply.stdout.trim() + (reply.status ? ' (curl ' + reply.status + ')' : '');
  }
  return result;
}
function certificates(address) {
  const ports = [...new Set(probeList().map(([port]) => port))], result = {};
  for (const port of ports) for (const [label, name] of [['fqdn', c.fqdn], ['shortName', c.host], ['noSNI', null]]) {
    const script = `openssl s_client -connect ${address}:${port} ${name ? '-servername ' + name : '-noservername'} </dev/null 2>/dev/null | openssl x509 -noout -fingerprint -sha256 2>/dev/null | cut -d= -f2`;
    (result[port] ??= {})[label] = spawnSync('bash', ['-c', script], { encoding: 'utf8' }).stdout.trim() || 'no certificate';
  }
  return result;
}
function waitNative(address, trust) {
  for (let attempt = 0; attempt < 60; attempt++) {
    const state = probes(address, trust);
    if (Object.entries(state).every(([key, value]) => !value.startsWith('000'))) return state;
    execFileSync('sleep', ['2']);
  }
  for (const name of ['router', 'iam', 'memory']) put('native-' + name + '.log', spawnSync('docker', ['logs', '--tail', '60', prefix + '-native-' + name], { encoding: 'utf8' }).stderr);
  throw Error('The native replica did not answer on every port');
}
const dbRows = (file, sql) => run('sqlite3', ['-readonly', '-json', '-cmd', '.timeout 15000', `file:${file}?mode=ro`, sql]);
const nativeDb = () => join(native, 'state/opt/hive-iam/prisma/iam.db');
const hashesOf = (file) => JSON.parse(dbRows(file, 'select id,username,passwordHash from users order by id'));
const tableCounts = (file) => Object.fromEntries(run('sqlite3', ['-readonly', `file:${file}?mode=ro`, "select name from sqlite_master where type='table' and name not like 'sqlite_%'"]).trim().split('\n').filter(Boolean).map((table) => [table, Number(run('sqlite3', ['-readonly', `file:${file}?mode=ro`, `select count(*) from "${table}"`]).trim())]));

function writeInstallation(nativeState) {
  const directory = suite;
  mkdirSync(directory, { mode: 0o700 });
  const placed = (name, withEnv = true) => ({ host: 'control', ...(withEnv ? { envFile: `${directory}/config/${name}.env` } : {}), configDirectory: `${directory}/config/${name}` });
  const components = { 'hive-registry': placed('hive-registry'), oathweave: placed('oathweave'), 'oathweave-redis': placed('oathweave-redis', false), emberpath: placed('emberpath'), hivemem: placed('hivemem'), 'hivemem-qdrant': placed('hivemem-qdrant', false), hivexui: { host: 'control' }, ingress: placed('ingress') };
  if (hasSkills()) components.hiveskills = placed('hiveskills');
  const memoryPort = Number(nativeEnv([join(native, 'state/opt/hivemem/.env')]).HIVEMEM_WEB_PORT ?? 18790);
  const adminToken = join(out, 'admin-reset-token');
  const links = { schema: 1, installation: c.installation, note: 'Rehearsal copy only. Not an approval for production.', links: c.reviewedLinks, grants: c.reviewedGrants };
  put('reviewed-links.json', links);
  const config = {
    schema: 1, installation: c.installation, release: c.version ?? '0.1.0', profile: 'custom', origin: 'https://' + c.fqdn,
    hosts: { control: { target: 'local', directory, minimumFreeMiB: 2048 } },
    components, agents: [], inference: [],
    console: { host: 'control', bindAddress: c.address, httpsPort: 443, runtimeFile: `${directory}/config/runtime.json`, nativeListeners: [{ port: 4020, component: 'emberpath' }, { port: 4200, component: 'oathweave' }, { port: memoryPort, component: 'hivemem' }, ...(hasSkills() ? [{ port: 4030, component: 'hiveskills' }] : [])], networkSubnet: c.subnets.default, edgeSubnet: c.subnets.edge },
    nativeMigration: {
      schema: 1, rehearsal: true, expectedHost: c.host, machineIdSHA256: sha(nativeState.manifest.machineId),
      source: { root: join(native, 'state'), serviceManager: 'command', controlCommand: nativeState.control, qdrantUrl: `http://${nativeState.address}:6333`, redisUrl: `redis://${nativeState.address}:6379`, dataNetwork: prefix + '-native', archive: c.archive },
      browserIssuer: `https://${c.fqdn}/api/oathweave`, verifyAddress: c.address, reviewedLinksFile: join(out, 'reviewed-links.json'),
      dataAliases: hasSkills() ? { hiveskills: '/opt/hive-skills/shared/data' } : {},
      adminAccount: { subject: c.adminAccount.subject, username: c.adminAccount.username, tokenFile: adminToken, tokenTtlSeconds: 86400 },
      networkSubnets: { 'identity-data': c.subnets.identity, 'memory-data': c.subnets.memory },
      dryRunSubnets: { default: c.subnets.dryDefault, 'identity-data': c.subnets.dryIdentity, 'memory-data': c.subnets.dryMemory },
    },
  };
  put('installation.json', config);
  return config;
}

// ---- Native client credentials against the suite, read from the native files. ----
function nativeClients(address, trust) {
  const iam = nativeEnv([join(native, 'state/opt/hive-iam/.env')]);
  const router = nativeEnv([join(native, 'state/opt/hive-router/shared/.env')]);
  const memory = nativeEnv([join(native, 'state/opt/hivemem/.env')]);
  const token = (client, secret, scope) => {
    if (!secret) return { client, status: 'no saved credential' };
    const body = JSON.stringify({ grant_type: 'client_credentials', client_id: client, client_secret: secret, ...(scope ? { scope } : {}) });
    const reply = spawnSync('curl', ['-sS', '--max-time', '20', '--resolve', `${c.fqdn}:4200:${address}`, '--cacert', trust, '-H', 'Content-Type: application/json', '--data-binary', '@-', `https://${c.fqdn}:4200/api/v1/oauth/token`], { input: body, encoding: 'utf8' });
    const parsed = JSON.parse(reply.stdout || '{}'), access = parsed.access_token ?? parsed.accessToken;
    if (!access) return { client, status: 'refused', error: parsed.error ?? parsed.message };
    const claims = JSON.parse(Buffer.from(access.split('.')[1], 'base64url'));
    return { client, status: 'issued', issuer: claims.iss, audience: claims.aud, permissions: claims.permissions, access };
  };
  const status = (port, path, bearer) => { const name = nameFor(port); return spawnSync('curl', ['-sS', '-o', '/dev/null', '-w', '%{http_code}', '--max-time', '20', '--resolve', `${name}:${port}:${address}`, '--cacert', trust, '-H', 'Authorization: Bearer ' + bearer, `https://${name}:${port}${path}`], { encoding: 'utf8' }).stdout.trim(); };
  // The configuration names other kept machine clients and the env name of each saved secret.
  const results = [token(router.HIVE_ROUTER_IAM_CLIENT_ID, router.HIVE_ROUTER_IAM_CLIENT_SECRET), ...(c.machineClients ?? []).map(([client, name, scope]) => token(client, iam[name], scope))];
  const exporterToken = results.find((result) => result.client === c.exporterClient)?.access;
  const exporter = exporterToken ? status(443, '/api/security/events?limit=1', exporterToken) : 'no client on this installation';
  const memoryToken = memory.HIVEMEM_ADMIN_TOKEN;
  const proxy = router.HIVE_ROUTER_MEMORY_PROXY_TOKEN;
  return {
    machineClients: results.map(({ access, ...rest }) => rest),
    securityExporterOnConsolePort: exporter,
    memoryAdminToken: { direct: status(Number(memory.HIVEMEM_WEB_PORT ?? 18790), '/v1/stats', memoryToken), consolePort: status(443, '/v1/stats', memoryToken) },
    routerMemoryProxyToken: status(Number(memory.HIVEMEM_WEB_PORT ?? 18790), '/v1/stats', proxy),
  };
}

// ---- Sign-in rehearsal on a fork with its own signing authority. ----
function forkSuite(config) {
  say('fork: new signing authority and issuer for the sign-in rehearsal');
  cpSync(suite, fork, { recursive: true, verbatimSymlinks: true });
  const issuer = `https://${c.fqdn}/api/oathweave/rehearsal`;
  const keys = join(fork, 'data/oathweave/keyring-rehearsal');
  mkdirSync(keys, { mode: 0o700 });
  run('openssl', ['genpkey', '-algorithm', 'RSA', '-pkeyopt', 'rsa_keygen_bits:3072', '-out', join(keys, 'private.pem')]);
  run('openssl', ['pkey', '-in', join(keys, 'private.pem'), '-pubout', '-out', join(keys, 'public.pem')]);
  const edit = (file, change) => {
    const text = readFileSync(file, 'utf8').split('\n').filter(Boolean);
    const entries = text.map((line) => { const at = line.indexOf('='); return [line.slice(0, at), line.slice(at + 1).replace(/^'|'$/g, '')]; });
    const next = change(Object.fromEntries(entries));
    writeFileSync(file, Object.entries(next).map(([key, value]) => `${key}='${value}'`).join('\n') + '\n', { mode: 0o600 });
  };
  const operatorId = 'rehearsal' + randomBytes(10).toString('hex');
  const operatorPassword = randomBytes(24).toString('base64url') + 'aA1!';
  const adminPassword = randomBytes(24).toString('base64url') + 'bB2!';
  const secrets = join(out, 'throwaway-secrets.json');
  writeFileSync(secrets, JSON.stringify({ operatorPassword, adminPassword }), { mode: 0o600 });
  edit(join(fork, 'config/oathweave.env'), (env) => ({ ...env, JWT_ISSUER: 'urn:hive:rehearsal:' + c.installation, JWT_PRIVATE_KEY_PATH: '/data/keyring-rehearsal/private.pem', JWT_PUBLIC_KEY_PATH: '/data/keyring-rehearsal/public.pem', JWT_PREVIOUS_PUBLIC_KEY_PATHS: '', COOKIE_SECRET: randomBytes(48).toString('hex'), IAM_AGENT_SECRET: randomBytes(32).toString('hex'), IAM_BROWSER_ISSUER: issuer }));
  const compose = JSON.parse(readFileSync(join(suite, 'compose.json'), 'utf8').replaceAll(suite, fork));
  compose.name = c.installation + '-fork';
  compose.networks.default.ipam = { config: [{ subnet: c.subnets.forkDefault }] };
  compose.networks.edge.ipam = { config: [{ subnet: c.subnets.forkEdge }] };
  compose.networks['identity-data'].ipam = { config: [{ subnet: c.subnets.forkIdentity }] };
  compose.networks['memory-data'].ipam = { config: [{ subnet: c.subnets.forkMemory }] };
  writeFileSync(join(fork, 'compose.json'), JSON.stringify(compose, null, 2), { mode: 0o600 });
  const composeFile = join(fork, 'compose.json');
  const dc = (...argv) => run('docker', ['compose', '-f', composeFile, ...argv]);
  dc('up', '-d', '--wait', '--wait-timeout', '120', 'oathweave-redis', 'hivemem-qdrant');
  // A clearly named temporary operator exists only in this fork, with its own product accounts.
  const operatorCode = `import {prisma} from '/app/apps/iam-core/dist/db/client.js';import argon2 from 'argon2';const p=JSON.parse(process.argv[1]);const role=await prisma.role.findUnique({where:{name:'SUITE_ADMIN'}});await prisma.user.create({data:{id:p.id,username:'rehearsal-operator',email:'rehearsal-operator@example.invalid',displayName:'Temporary rehearsal operator',passwordHash:await argon2.hash(p.password,{type:argon2.argon2id}),passwordChangedAt:new Date(),active:true,roles:{create:{roleId:role.id}}}});console.log(JSON.stringify({created:true}));await prisma.$disconnect();process.exit(0);`;
  dc('run', '--no-deps', '--rm', '-T', '--entrypoint', 'node', 'oathweave', '--input-type=module', '-e', operatorCode, JSON.stringify({ id: operatorId, password: operatorPassword }));
  const modelCode = `import {prisma} from '/app/dist/src/storage/client.js';import {EXTERNALLY_MANAGED_PASSWORD_HASH as hash} from '/app/dist/src/security/os-auth.js';const u=await prisma.adminUser.create({data:{username:'rehearsal-operator',displayName:'Temporary rehearsal operator',passwordHash:hash}});console.log(JSON.stringify({localId:u.id}));await prisma.$disconnect();process.exit(0);`;
  const operatorLocal = parseJSONLine(dc('run', '--no-deps', '--rm', '-T', '--entrypoint', 'node', 'emberpath', '--input-type=module', '-e', modelCode)).localId;
  const withLinks = (env, key, extra) => ({ ...env, OATHWEAVE_ISSUER: issuer, [key]: JSON.stringify([...JSON.parse(env[key] ?? '[]').map((link) => ({ ...link, issuer })), ...extra]) });
  edit(join(fork, 'config/emberpath.env'), (env) => withLinks(env, 'EMBERPATH_OATHWEAVE_IDENTITIES_JSON', [{ issuer, subject: operatorId, localId: operatorLocal }]));
  edit(join(fork, 'config/hivemem.env'), (env) => withLinks(env, 'HIVEMEM_OATHWEAVE_IDENTITIES_JSON', [{ issuer, subject: operatorId, localId: 'rehearsal-operator', credentialGeneration: 0 }]));
  if (hasSkills()) edit(join(fork, 'config/hiveskills.env'), (env) => withLinks(env, 'HIVESKILLS_OATHWEAVE_IDENTITIES_JSON', [{ issuer, subject: operatorId, localId: 'rehearsal-operator' }]));
  const runtime = JSON.parse(readFileSync(join(fork, 'config/runtime.json'), 'utf8'));
  runtime.identity.issuer = issuer;
  writeFileSync(join(fork, 'config/runtime.json'), JSON.stringify(runtime), { mode: 0o644 });
  dc('up', '-d', '--wait', '--wait-timeout', '240');
  const memoryAdmin = nativeEnv([join(native, 'state/opt/hivemem/.env')]).HIVEMEM_ADMIN_TOKEN;
  const registered = spawnSync('curl', ['-sS', '-o', '/dev/null', '-w', '%{http_code}', '--max-time', '30', '--resolve', `${nameFor(memoryPort())}:${memoryPort()}:${c.address}`, '--cacert', join(out, 'native-trust.pem'), '-H', 'Authorization: Bearer ' + memoryAdmin, '-H', 'Content-Type: application/json', '-d', JSON.stringify({ agent_id: 'rehearsal-operator', display_name: 'Temporary rehearsal operator' }), `https://${nameFor(memoryPort())}:${memoryPort()}/v1/agents/register`], { encoding: 'utf8' });
  say('fork: temporary memory account: HTTP ' + registered.stdout.trim());
  // The reset script reads its target from the fork's own tree.
  return { dc, composeFile, secrets, operatorId, operatorPassword, adminPassword, issuer, operatorLocal };
}

const resetScript = () => join(fork, 'bin/hive-set-admin-password');
function runReset(input, args = []) {
  const result = spawnSync('bash', [resetScript(), ...args], { input, encoding: 'utf8' });
  return { status: result.status, output: (result.stdout + result.stderr).trim() };
}
function resetRehearsal(f, trust) {
  say('reset: owner flow on the fork');
  const target = JSON.parse(readFileSync(join(fork, 'migration/reset-target.json'), 'utf8'));
  writeFileSync(join(fork, 'migration/reset-target.json'), JSON.stringify({ ...target, caFile: join(fork, 'migration/identity-ca.pem') }), { mode: 0o644 });
  const token = readFileSync(join(out, 'admin-reset-token'), 'utf8').trim();
  assert.match(token, new RegExp('^hive-reset\\.' + c.installation + '\\.[a-f0-9]{64}$'));
  const dbFile = join(fork, 'data/oathweave/iam/iam.db');
  const row = JSON.parse(dbRows(dbFile, `select tokenHash,userId,expiresAt,usedAt from password_reset_tokens where tokenHash='${sha(token)}'`));
  assert.equal(row.length, 1, 'Only the token digest is stored');
  assert.equal(row[0].userId, c.adminAccount.subject);
  assert(!readFileSync(dbFile).includes(Buffer.from(token)), 'The raw token is not stored');
  const before = hashesOf(dbFile);
  const out_ = {};
  const pw = f.adminPassword;
  out_.tokenFromOtherInstallation = runReset(`hive-reset.other-installation.${'a'.repeat(64)}\n${pw}\n${pw}\n`);
  assert.notEqual(out_.tokenFromOtherInstallation.status, 0); assert.match(out_.tokenFromOtherInstallation.output, /another installation/);
  out_.mismatchedPasswords = runReset(`${token}\n${pw}\nother\n`);
  assert.notEqual(out_.mismatchedPasswords.status, 0);
  out_.policyRejectedKeepsToken = runReset(`${token}\nshort\nshort\n`);
  assert.notEqual(out_.policyRejectedKeepsToken.status, 0);
  out_.success = runReset(`${token}\n${pw}\n${pw}\n`);
  assert.equal(out_.success.status, 0, out_.success.output);
  const after = hashesOf(dbFile);
  const changed = after.filter((account) => before.find((old) => old.id === account.id)?.passwordHash !== account.passwordHash).map((account) => account.id);
  assert.deepEqual(changed, [c.adminAccount.subject], 'Only the chosen account changed');
  out_.onlyChosenAccountChanged = { accountsChecked: after.length, changed };
  out_.reuseRefused = runReset(`${token}\n${pw}Z\n${pw}Z\n`);
  assert.notEqual(out_.reuseRefused.status, 0); assert.match(out_.reuseRefused.output, /Invalid or expired/);
  const short = `hive-reset.${c.installation}.${randomBytes(32).toString('hex')}`;
  f.dc('exec', '-T', 'oathweave', 'node', 'dist/cli.js', 'issue-reset-token', '--account', c.adminAccount.subject, '--username', c.adminAccount.username, '--token-sha256', sha(short), '--installation', c.installation, '--ttl-seconds', '1');
  execFileSync('sleep', ['3']);
  out_.expiredRefused = runReset(`${short}\n${pw}Y\n${pw}Y\n`);
  assert.notEqual(out_.expiredRefused.status, 0); assert.match(out_.expiredRefused.output, /Invalid or expired/);
  let throttledAfter = null;
  for (let attempt = 1; attempt <= 15; attempt++) {
    const reply = runReset(`hive-reset.${c.installation}.${randomBytes(32).toString('hex')}\n${pw}X\n${pw}X\n`);
    if (/Too many attempts/.test(reply.output)) { throttledAfter = attempt; break; }
  }
  assert(throttledAfter, 'Wrong tokens are throttled');
  out_.wrongTokenThrottledAfterFurtherAttempts = throttledAfter;
  const row2 = JSON.parse(dbRows(dbFile, `select usedAt from password_reset_tokens where tokenHash='${sha(token)}'`));
  assert(row2[0].usedAt, 'The token is marked used');
  out_.mfaUnchanged = JSON.parse(dbRows(dbFile, `select mfaEnabled from users where id='${c.adminAccount.subject}'`))[0];
  execFileSync('sleep', ['2']);
  out_.auditEvents = JSON.parse(dbRows(dbFile, "select eventType,actorId,outcome,source from audit_events where eventType like 'auth.password_reset%' order by timestamp"));
  assert(out_.auditEvents.some((event) => event.eventType === 'auth.password_reset_completed' && event.actorId === c.adminAccount.subject));
  assert(out_.auditEvents.some((event) => event.eventType === 'auth.password_reset_issued'));
  return { result: out_, token, short };
}

async function browserSignIn(f, username, password, sections) {
  const { chromium } = await import(c.playwrightModule);
  const browser = await chromium.launch({ headless: true, args: [`--host-resolver-rules=MAP ${c.fqdn} ${c.address}`] });
  const report = { username, sections: {} };
  const origin = 'https://' + c.fqdn;
  const consoleErrors = [];
  try {
    const context = await browser.newContext({ ignoreHTTPSErrors: false });
    const page = await context.newPage();
    const failed = [];
    page.on('response', (response) => { const url = new URL(response.url()); if (response.status() >= 400 && url.origin === origin) failed.push(response.status() + ' ' + url.pathname); });
    await page.goto(origin + '/', { waitUntil: 'domcontentloaded' });
    await page.getByRole('textbox', { name: 'Username', exact: true }).fill(username);
    await page.getByRole('textbox', { name: 'Password', exact: true }).fill(password);
    await page.getByRole('button', { name: /sign in/i }).first().click();
    for (let round = 0; round < 6; round++) {
      const consent = page.getByRole('dialog', { name: 'Review access', exact: true });
      await consent.waitFor({ timeout: 6000 }).then(async () => { await consent.getByRole('button', { name: /allow|approve|continue/i }).first().click(); }).catch(() => {});
      if (await page.getByRole('button', { name: 'Sign out', exact: true }).first().isVisible().catch(() => false)) break;
    }
    await page.getByRole('button', { name: 'Sign out', exact: true }).first().waitFor({ timeout: 30000 });
    report.signedIn = true;
    await page.screenshot({ path: join(out, 'browser-' + username + '-overview.png'), fullPage: true });
    const navigation = page.getByRole('navigation', { name: 'Products', exact: true });
    for (const [label, product, item, expected] of sections) {
      failed.length = 0;
      const head = navigation.getByRole('button', { name: new RegExp('^' + product) }).first();
      if ((await head.getAttribute('aria-expanded').catch(() => null)) === 'false') await head.click();
      const entry = navigation.getByRole('button', { name: item, exact: true }).or(navigation.getByRole('link', { name: item, exact: true })).first();
      await entry.click({ timeout: 8000 });
      for (let round = 0; round < 3; round++) {
        const consent = page.getByRole('dialog', { name: 'Review access', exact: true });
        const visible = await consent.waitFor({ timeout: 2500 }).then(() => true).catch(() => false);
        if (!visible) break;
        await consent.getByRole('button', { name: /allow|approve|continue/i }).first().click();
      }
      await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
      await page.waitForTimeout(1500);
      const text = (await page.locator('main').first().innerText().catch(() => '')).replace(/\s+/g, ' ');
      await page.screenshot({ path: join(out, 'browser-' + username + '-' + label + '.png'), fullPage: true });
      report.sections[label] = { failedRequests: [...new Set(failed)].slice(0, 12), expected, expectedVisible: expected ? new RegExp(expected, 'i').test(text) : null, characters: text.length };
    }
    report.bearerInBrowserStorage = await page.evaluate(() => [localStorage, sessionStorage].some((store) => Array.from({ length: store.length }, (_, index) => store.getItem(store.key(index)) ?? '').some((value) => /eyJ[A-Za-z0-9_-]+\./.test(value))));
  } catch (error) {
    report.signedIn = report.signedIn ?? false; report.error = String(error).slice(0, 300);
    for (const context of browser.contexts()) for (const page of context.pages()) await page.screenshot({ path: join(out, 'browser-' + username + '-failure.png'), fullPage: true }).catch(() => {});
  } finally { await browser.close(); }
  return report;
}

function secretsAbsent(secretsList) {
  const files = [];
  const walk = (directory) => { for (const entry of readdirSync(directory, { withFileTypes: true })) { const path = join(directory, entry.name); if (entry.isDirectory()) { if (!['native', 'suite', 'fork', 'native-qdrant'].includes(entry.name) || directory !== out) walk(path); } else if (entry.isFile() && !['throwaway-secrets.json', 'admin-reset-token', 'publisher.key'].includes(entry.name)) files.push(path); } };
  walk(out);
  const found = [];
  for (const file of files) { const content = readFileSync(file); for (const secret of secretsList) if (content.includes(Buffer.from(secret))) found.push(file.slice(out.length)); }
  const logs = spawnSync('docker', ['compose', '-f', join(fork, 'compose.json'), 'logs', '--no-color'], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
  const auditDirectory = join(fork, 'data/oathweave/iam/audit-logs');
  let auditHits = 0;
  for (const name of readdirSync(auditDirectory)) { const content = readFileSync(join(auditDirectory, name)); for (const secret of secretsList) if (content.includes(Buffer.from(secret))) auditHits++; }
  const logHits = secretsList.filter((secret) => (logs.stdout + logs.stderr).includes(secret)).length;
  return { evidenceFilesScanned: files.length, evidenceHits: found, containerLogHits: logHits, auditFileHits: auditHits };
}

async function main() {
  const startedAt = new Date().toISOString();
  const report = { schema: 1, host: c.host, installation: c.installation, startedAt, productionContacted: false };
  cleanup();
  try {
    release();
    const nativeState = startNative();
    const trust = trustFile();
    const config = writeInstallation(nativeState);
    say('native: baseline on every native port');
    report.nativeProbesBefore = waitNative(nativeState.address, trust);
    report.nativeCertificatesBefore = certificates(nativeState.address);
    report.nativeClientsBefore = nativeClients(nativeState.address, trust);
    put('native-baseline.json', { probes: report.nativeProbesBefore, certificates: report.nativeCertificatesBefore });

    say('refusals: another installation must be refused');
    {
      const wrong = JSON.parse(JSON.stringify(config)); wrong.nativeMigration.expectedHost = 'other-installation';
      const file = join(out, 'wrong-host.json'); writeFileSync(file, JSON.stringify(wrong), { mode: 0o600 });
      const reply = spawnSync(hiveScript, ['migrate-native', 'plan', '--config', file, '--manifest', join(out, 'release.json'), '--trust-key', join(out, 'publisher.pub'), '--non-interactive'], { encoding: 'utf8' });
      assert.notEqual(reply.status, 0); assert.match(reply.stderr, /independent installations are never mixed/);
      const wrongLinks = JSON.parse(JSON.stringify(config)); const linksFile = join(out, 'wrong-links.json');
      writeFileSync(linksFile, JSON.stringify({ schema: 1, installation: 'other-installation', links: [], grants: [] }), { mode: 0o600 });
      wrongLinks.nativeMigration.reviewedLinksFile = linksFile; writeFileSync(file, JSON.stringify(wrongLinks), { mode: 0o600 });
      const refused = spawnSync(hiveScript, ['migrate-native', 'plan', '--config', file, '--manifest', join(out, 'release.json'), '--trust-key', join(out, 'publisher.pub'), '--non-interactive'], { encoding: 'utf8' });
      assert.notEqual(refused.status, 0); assert.match(refused.stderr, /another installation/);
      report.refusals = { wrongHostConfig: 'refused', wrongLinksFile: 'refused', ...(c.otherArchive ? (() => { const other = JSON.parse(JSON.stringify(config)); other.nativeMigration.source.archive = c.otherArchive; writeFileSync(file, JSON.stringify(other), { mode: 0o600 }); const answer = spawnSync(hiveScript, ['migrate-native', 'plan', '--config', file, '--manifest', join(out, 'release.json'), '--trust-key', join(out, 'publisher.pub'), '--non-interactive'], { encoding: 'utf8' }); assert.notEqual(answer.status, 0); assert.match(answer.stderr, /another installation/); return { otherInstallationArchive: 'refused' }; })() : {}) };
    }

    say('plan');
    const planned = hive('plan');
    assert.equal(planned.status, 0, planned.stderr.slice(-2000));
    report.plan = JSON.parse(planned.stdout);
    put('plan.json', report.plan);

    say('prepare');
    const prepared = hive('prepare');
    assert.equal(prepared.status, 0, prepared.stderr.slice(-3000));
    report.prepareSeconds = prepared.seconds;
    report.nativeProbesAfterPrepare = probes(nativeState.address, trust);
    assert.deepEqual(report.nativeProbesAfterPrepare, report.nativeProbesBefore, 'Prepare must not disturb native services');
    assert(docker('inspect', prefix + '-native-iam', '--format', '{{.State.Running}}') === 'true');

    let traffic = null;
    if (c.liveTraffic) {
      say('live traffic: production memory worker, pending native queue jobs, clients through the cutover');
      report.suiteMemoryWorker = productionWorker();
      report.pendingAtCapture = pendingJobs(nativeState.address, trust, c.liveTraffic.pendingJobs ?? 5);
      traffic = startTraffic(trust);
    }

    say('cutover' + (traffic ? ' with live traffic' : ''));
    const nativeHashesBefore = hashesOf(nativeDb());
    const cut = hive('cutover', '--yes');
    report.cutoverSeconds = cut.seconds;
    report.controller = controller === root ? 'this tree' : c.controllerLabel ?? 'other';
    if (c.expectRollback) {
      // Negative control: this controller must fail verification under live traffic and roll back.
      const text = cut.stdout + '\n' + cut.stderr;
      const failed = text.split('\n').filter((line) => line.startsWith('{') && line.includes('"passed":false')).map((line) => JSON.parse(line));
      report.negativeControl = {
        exitStatus: cut.status, verificationFailures: failed.flatMap((item) => item.failures),
        clientApiKeyFailure: /ClientApiKey: \d+ existing rows changed or removed/.test(text),
        vectorFailure: /Vector counts or content differ from the native snapshots/.test(text),
        rolledBack: /Verification failed, so this installation was rolled back/.test(text),
        rollback: text.split('\n').filter((line) => line.startsWith('{"rolledBackAt"')).map((line) => JSON.parse(line))[0] ?? null,
      };
      if (traffic) { report.trafficDuringCutover = trafficSummary(traffic.log, cut.startedAt, cut.finishedAt); await traffic.stop(); }
      put('report.partial.json', report);
      assert.notEqual(cut.status, 0, 'The cutover was expected to fail verification');
      assert(report.negativeControl.clientApiKeyFailure, 'The ClientApiKey failure did not reproduce');
      assert(report.negativeControl.vectorFailure, 'The vector failure did not reproduce');
      assert(report.negativeControl.rolledBack, 'The cutover did not roll back');
      assert.equal(report.negativeControl.rollback?.nativeBytesUnchangedSinceStop, true);
      report.nativeProbesAfterRollback = waitNative(nativeState.address, trust);
      assert.deepEqual(report.nativeProbesAfterRollback, report.nativeProbesBefore, 'Native services answer as they did');
      assert.deepEqual(hashesOf(nativeDb()).map((a) => a.passwordHash), nativeHashesBefore.map((a) => a.passwordHash), 'Native password hashes are unchanged');
      report.result = 'passed';
      return;
    }
    assert.equal(cut.status, 0, cut.stderr.slice(-3000));
    const verification = JSON.parse(readFileSync(join(suite, 'migration/verification.json'), 'utf8'));
    assert(verification.passed);
    const preserved = JSON.parse(readFileSync(join(suite, 'migration/preserved.json'), 'utf8'));
    assert(preserved.passed);
    report.preserved = { checkedAt: preserved.checkedAt, servingWhenChecked: preserved.serving, runningServices: preserved.runningServices, failures: preserved.failures, accounts: preserved.accounts, keyring: preserved.keyring, issuer: preserved.issuer, vectors: preserved.vectors, redis: preserved.redis, recordChanges: Object.fromEntries(Object.entries(preserved.records).map(([name, value]) => [name, value.changed])) };
    report.verification = { failures: verification.failures, receipt: verification.receipt, probes: verification.probes.map((p) => `${p.port}${p.path} ${p.status}`), tls: verification.tls, nativeToken: verification.nativeToken, memoryCredential: verification.memoryCredential, credentials: verification.credentials, invariants: verification.invariants };
    if (traffic) {
      report.trafficDuringCutover = trafficSummary(traffic.log, cut.startedAt, cut.finishedAt);
      assert(Object.values(report.trafficDuringCutover).some((item) => item.ok > 0), 'Traffic must reach the suite during the cutover');
      say('verify: the standalone check against the live suite, with traffic still running');
      const live = hive('verify');
      assert.equal(live.status, 0, live.stdout.slice(-2000) + live.stderr.slice(-2000));
      report.liveVerify = parseJSONLine(live.stdout);
      report.trafficDuringLiveVerify = trafficSummary(traffic.log, live.startedAt, live.finishedAt);
      report.suiteQueue = queueState(c.address, trust);
    }
    if (c.backupRehearsal) {
      report.backupRehearsal = await backupRehearsal(trust, traffic);
      if (traffic) {
        const after = hive('verify');
        assert.equal(after.status, 0, after.stdout.slice(-2000) + after.stderr.slice(-2000));
        report.liveVerifyAfterBackup = parseJSONLine(after.stdout);
      }
    }
    if (c.refreshMemoryToken) {
      say('refresh-memory-token: a renewed native token reaches the suite Emberpath');
      report.refreshMemoryToken = refreshMemoryToken();
      const after = hive('verify');
      assert.equal(after.status, 0, after.stdout.slice(-2000) + after.stderr.slice(-2000));
      report.liveVerifyAfterRefresh = parseJSONLine(after.stdout);
    }
    if (traffic) { await traffic.stop(); report.trafficTotal = trafficSummary(traffic.log); }

    say('suite: independent checks on the native ports');
    report.suiteProbes = probes(c.address, trust);
    assert.deepEqual(Object.fromEntries(Object.entries(report.suiteProbes)), Object.fromEntries(Object.entries(report.nativeProbesBefore)), 'Every native port answers as it did');
    report.suiteCertificates = certificates(c.address);
    assert.deepEqual(report.suiteCertificates, report.nativeCertificatesBefore, 'Each port presents the same certificate for every name');
    report.nativeClients = nativeClients(c.address, trust);
    assert.deepEqual(report.nativeClients, report.nativeClientsBefore, 'Native client credentials behave exactly as they did');
    const agents = spawnSync('curl', ['-sS', '--max-time', '20', '--resolve', `${nameFor(memoryPort())}:${memoryPort()}:${c.address}`, '--cacert', trust, '-H', 'Authorization: Bearer ' + nativeEnv([join(native, 'state/opt/hivemem/.env')]).HIVEMEM_ADMIN_TOKEN, `https://${nameFor(memoryPort())}:${memoryPort()}/v1/agents`], { encoding: 'utf8' });
    report.memoryAccounts = (() => { try { const body = JSON.parse(agents.stdout); return (body.agents ?? body).map((agent) => agent.agent_id ?? agent.id); } catch { return 'unavailable'; } })();
    const suiteDb = join(suite, 'data/oathweave/iam/iam.db');
    const suiteHashes = hashesOf(suiteDb);
    assert.deepEqual(suiteHashes.map((a) => [a.id, a.username, a.passwordHash]), nativeHashesBefore.map((a) => [a.id, a.username, a.passwordHash]), 'Password hashes are byte-identical');
    report.passwordHashes = suiteHashes.map((a) => ({ username: a.username, id: a.id, byteIdentical: true, sha256: sha(a.passwordHash) }));
    report.signingKeys = ['active-private.pem', 'active-public.pem'].map((name) => { const a = sha(readFileSync(join(native, 'state/var/lib/hive-iam-keyring/current', name))), b = sha(readFileSync(join(suite, 'data/oathweave/keyring', name))); assert.equal(a, b); return { name, unchanged: true }; });
    const nativeCounts = { iam: tableCounts(nativeDb()), router: tableCounts(join(native, 'state/opt/hive-router/shared/data/router.db')) };
    const suiteCounts = { iam: tableCounts(suiteDb), router: tableCounts(join(suite, 'data/emberpath/router/router.db')) };
    report.rowCounts = { nativeIam: nativeCounts.iam, suiteIam: suiteCounts.iam, nativeRouter: nativeCounts.router, suiteRouter: suiteCounts.router };
    if (hasSkills()) { report.rowCounts.nativeSkills = tableCounts(join(native, 'state/opt/hive-skills/shared/data/registry.sqlite')); report.rowCounts.suiteSkills = tableCounts(join(suite, 'data/hiveskills/registry.sqlite')); }
    report.auditFiles = (() => { const directory = join(native, 'state/opt/hive-iam/audit-logs'), result = { files: 0, identical: 0, grown: 0, bytes: 0 }; for (const name of readdirSync(directory)) { result.files++; result.bytes += statSync(join(directory, name)).size; const a = readFileSync(join(directory, name)), b = readFileSync(join(suite, 'data/oathweave/iam/audit-logs', name)); if (a.equals(b)) result.identical++; else if (b.subarray(0, a.length).equals(a)) result.grown++; else throw Error('An audit file changed: ' + name); } return result; })();
    report.auditChain = 'Native Oathweave, Emberpath, HiveMem and HiveSkills keep no hash chain. Audit rows and files are compared by content instead.';
    const statusReply = spawnSync(hiveScript, ['status', '--config', join(out, 'installation.json'), '--manifest', join(out, 'release.json'), '--trust-key', join(out, 'publisher.pub'), '--non-interactive'], { encoding: 'utf8' });
    assert.equal(statusReply.status, 0, statusReply.stderr.slice(-1500));
    const status = JSON.parse(statusReply.stdout);
    report.status = { containers: status.containers.map((container) => `${container.Service}: ${container.State}/${container.Health || '-'}`), registry: { state: status.registry.state, products: status.registry.products, drift: status.registry.drift } };
    assert(status.containers.every((container) => container.State === 'running' && ['', 'healthy'].includes(container.Health)));
    assert.equal(status.registry.state, 'in-sync');
    put('report.partial.json', report);

    say('main suite: a client write that rollback must report');
    const memoryToken = nativeEnv([join(native, 'state/opt/hivemem/.env')]).HIVEMEM_ADMIN_TOKEN;
    const write = spawnSync('curl', ['-sS', '-w', '\n%{http_code}', '--max-time', '30', '--resolve', `${c.fqdn}:443:${c.address}`, '--cacert', trust, '-H', 'Authorization: Bearer ' + memoryToken, '-H', 'Content-Type: application/json', '-d', JSON.stringify({ content: 'A memory written to the suite during the rollback rehearsal.', type: 'semantic', scope: 'shared', source: 'observation', tags: ['rollback-rehearsal'] }), `https://${c.fqdn}:443/v1/memories`], { encoding: 'utf8' });
    report.postCutoverWriteStatus = write.stdout.trim().split('\n').pop();

    if (c.signIn !== false) {
    say('sign-in fork');
    docker('compose', '-f', join(suite, 'compose.json'), 'stop', '--timeout', '45');
    const f = forkSuite(config);
    const reset = resetRehearsal(f, trust);
    report.adminReset = reset.result;
    const identitySections = [['users', 'Oathweave', 'Users', 'rehearsal-operator'], ['audit', 'Oathweave', 'Audit', 'auth\\.|login|token'], ['routing', 'Emberpath', 'Routing', null]];
    report.adminBrowser = await browserSignIn(f, c.adminAccount.username, f.adminPassword, identitySections);
    report.operatorBrowser = await browserSignIn(f, 'rehearsal-operator', f.operatorPassword, [...identitySections, ['memories', 'HiveMem', 'Memories', null], ['workspaces', 'HiveMem', 'Workspaces', null], ...(hasSkills() ? [['skills', 'HiveSkills', 'HiveSkills', 'hivemem']] : [])]);
    report.secretLeakScan = secretsAbsent([f.adminPassword, f.operatorPassword, reset.token, reset.short]);
    assert.deepEqual(report.secretLeakScan.evidenceHits, []);
    assert.equal(report.secretLeakScan.containerLogHits, 0);
    assert.equal(report.secretLeakScan.auditFileHits, 0);
    run('docker', ['compose', '-f', f.composeFile, 'down', '--timeout', '45']);
    rmSync(f.secrets, { force: true });
    }

    say('rollback');
    docker('compose', '-f', join(suite, 'compose.json'), 'up', '-d', '--wait', '--wait-timeout', '180');
    const nativeHashesAtRollback = JSON.parse(readFileSync(join(suite, 'migration/native-stopped.json'), 'utf8'));
    const back = hive('rollback', '--yes');
    assert.equal(back.status, 0, back.stderr.slice(-3000));
    report.rollback = parseJSONLine(back.stdout);
    report.rollbackSeconds = back.seconds;
    report.nativeProbesAfterRollback = waitNative(nativeState.address, trust);
    assert.deepEqual(report.nativeProbesAfterRollback, report.nativeProbesBefore, 'Native services answer as they did');
    report.nativeCertificatesAfterRollback = certificates(nativeState.address);
    assert.deepEqual(report.nativeCertificatesAfterRollback, report.nativeCertificatesBefore);
    assert.deepEqual(hashesOf(nativeDb()).map((a) => a.passwordHash), nativeHashesBefore.map((a) => a.passwordHash), 'Native password hashes are unchanged');
    report.nativeStoreHashesAtStop = nativeHashesAtRollback;
    if (c.repeatAfterRollback) {
      say('repeat: a second attempt starts from the native stores, and a repeated cutover continues');
      assert(!existsSync(join(out, 'admin-reset-token')), 'Rollback must void the reset token');
      assert.equal(hive('prepare').status, 0);
      const second = hive('cutover', '--yes');
      assert.equal(second.status, 0, second.stderr.slice(-2000));
      const resumed = hive('cutover', '--yes');
      assert.equal(resumed.status, 0, resumed.stderr.slice(-2000));
      assert.deepEqual(probes(c.address, trust), report.nativeProbesBefore);
      const secondBack = hive('rollback', '--yes');
      assert.equal(secondBack.status, 0, secondBack.stderr.slice(-2000));
      assert.deepEqual(waitNative(nativeState.address, trust), report.nativeProbesBefore);
      report.repeat = { secondCutoverSeconds: second.seconds, repeatedCutoverSeconds: resumed.seconds, passed: true };
    }
    report.result = 'passed';
  } catch (error) {
    report.result = 'failed'; report.error = (String(error.message ?? error).slice(0, 300) + ' | ' + String(error.stderr ?? '').slice(-1500) + ' | ' + String(error.stack ?? '').split('\n').filter((line) => line.includes('rehearsal.mjs')).slice(0, 3).join(' ')).slice(0, 3000);
    process.exitCode = 1;
  } finally {
    for (const name of ['router', 'iam', 'memory', 'skills']) { const log = spawnSync('docker', ['logs', '--tail', '80', prefix + '-native-' + name], { encoding: 'utf8' }); if (log.status === 0) put('log-native-' + name + '.txt', log.stdout + log.stderr); }
    for (const [label, file] of [['suite', join(suite, 'compose.json')], ['fork', join(fork, 'compose.json')]]) { if (existsSync(file)) { const log = spawnSync('docker', ['compose', '-f', file, 'logs', '--no-color', '--tail', '80'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }); put('log-' + label + '.txt', log.stdout + log.stderr); } }
    report.finishedAt = new Date().toISOString();
    put('report.json', report);
    if (!c.keepRunningOnFailure || report.result === 'passed') cleanup();
    console.log(JSON.stringify({ result: report.result, error: report.error?.slice(0, 1500) }));
  }
}
await main();
