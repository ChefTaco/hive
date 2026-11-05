#!/usr/bin/env node
// Developer acceptance that an existing installation gains the mandatory Hive Registry.
// A controller from before the registry installs a real disposable core; this controller
// then upgrades, rolls back to the old release, upgrades again and adopts.
//   --output NEW_PRIVATE_DIRECTORY --template-release REVIEWED_CORE_FIXTURE_MANIFEST
//   --legacy-revision GIT_REVISION_BEFORE_THE_REGISTRY
import assert from 'node:assert/strict';
import { execFileSync, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdirSync, writeFileSync, readFileSync, existsSync, chmodSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import { createServer } from 'node:net';
import { applySuiteCatalog, hiveRegistryComponent } from './suite-catalog.mjs';
import { assertRecordedState, hostStatuses, registryCall } from './registry-proof.mjs';

const root = resolve(import.meta.dirname, '../..'), runAsync = promisify(execFile);
const argument = (name) => { const index = process.argv.indexOf(name); assert(index >= 0 && process.argv[index + 1], name + ' is required'); return process.argv[index + 1]; };
const output = resolve(argument('--output')), template = resolve(argument('--template-release')), legacyRevision = argument('--legacy-revision');
assert(!existsSync(output), 'Preserve existing evidence; select a new output directory');
assert.notEqual(process.getuid(), 0, 'Use an unprivileged operator with Docker access');
mkdirSync(output, { recursive: true, mode: 0o700 }); chmodSync(output, 0o700);
const put = (path, value, mode = 0o600) => { writeFileSync(path, typeof value === 'string' ? value : JSON.stringify(value, null, 2)); chmodSync(path, mode); };
const run = (program, args, options = {}) => execFileSync(program, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...options }).trim();
const docker = (...args) => run('docker', args);
const port = async () => { const socket = createServer().listen(0, '127.0.0.1'); await new Promise((done) => socket.once('listening', done)); const value = socket.address().port; await new Promise((done) => socket.close(done)); return value; };
const environment = Object.fromEntries(['PATH', 'LANG', 'LC_ALL', 'TZ'].filter((key) => process.env[key]).map((key) => [key, process.env[key]]));
const id = 'registry-upgrade-' + randomBytes(4).toString('hex'), registryName = id + '-registry', owned = join(output, 'installation');
const registry = '127.0.0.1:' + await port(), consolePort = await port(), tags = [];
const configFile = join(output, 'installation.json'), legacyConfigFile = join(output, 'legacy-installation.json');
const user = `${process.getuid()}:${process.getgid()}`;
let passed = false, step = 'setup';

const legacyRoot = join(output, 'legacy-controller');
mkdirSync(legacyRoot);
execFileSync('sh', ['-c', 'git -C "$1" archive "$2" hive.sh LICENSE deployment scripts/suite | tar -x -C "$3"', 'archive', root, legacyRevision, legacyRoot]);
assert(!readFileSync(join(legacyRoot, 'scripts/suite/lifecycle.sh'), 'utf8').includes('hive_registry'), 'The legacy revision must predate the Hive Registry');

const signed = (name, document) => { const file = join(output, name); put(file, document); run('openssl', ['pkeyutl', '-sign', '-inkey', join(output, 'publisher.key'), '-rawin', '-in', file, '-out', file + '.sig']); return file; };
async function hive(command, { controller = root, config = configFile, manifest, args = [] } = {}) {
  step = command;
  try {
    const result = await runAsync(join(controller, 'hive.sh'), [command, '--config', config, '--manifest', manifest, '--trust-key', join(output, 'publisher.pub'), '--non-interactive', '--yes', ...args], { env: environment, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
    return result.stdout.trim();
  } catch (error) {
    put(join(output, command + '-failure.log'), String(error.stdout || '') + '\n' + String(error.stderr || ''));
    throw Error('Controller ' + command + ' failed; protected log retained');
  }
}
const lookup = (...args) => run(join(root, 'hive.sh'), ['registry', '--config', configFile, ...args], { env: environment });
const compose = join(owned, 'compose.json');
const composeDown = (file) => { if (existsSync(file)) try { docker('compose', '-f', file, 'down', '--remove-orphans'); } catch {} };
const rehearsalDown = (archive) => composeDown(join(owned, 'rehearsals', archive, 'isolated.json'));
const running = () => docker('compose', '-f', compose, 'ps', '--status', 'running', '--services').split('\n').filter(Boolean).sort();

try {
  docker('run', '-d', '--name', registryName, '--user', user, '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges:true', '--tmpfs', `/var/lib/registry:uid=${process.getuid()},gid=${process.getgid()},mode=700`, '-p', registry + ':5000', 'registry@sha256:a3d8aaa63ed8681a604f1dea0aa03f100d5895b6a58ace528858a7b332415373');
  const legacy = JSON.parse(readFileSync(template, 'utf8'));
  const names = ['emberpath', 'hivemem', 'hivemem-qdrant', 'hiveskills', 'hivexui', 'ingress', 'oathweave', 'oathweave-redis'];
  assert.deepEqual(Object.keys(legacy.components).sort(), names, 'Template must contain the reviewed eight-component core fixture only');
  const pushed = (product, local) => { const tag = `${registry}/${id}/${product}:candidate`; tags.push(tag); docker('tag', local, tag); docker('push', tag); const image = JSON.parse(docker('image', 'inspect', tag, '--format', '{{json .RepoDigests}}')).find((value) => value.startsWith(`${registry}/${id}/${product}@sha256:`)); assert(image); return image; };
  for (const product of ['oathweave', 'emberpath', 'hivemem', 'hiveskills', 'hivexui', 'ingress']) legacy.components[product].image = pushed(product, product === 'ingress' ? 'hive-ingress:candidate' : product + ':candidate');
  legacy.version = '0.1.0'; legacy.profiles = { core: names, full: names };

  run('openssl', ['genpkey', '-algorithm', 'ED25519', '-out', join(output, 'publisher.key')]);
  run('openssl', ['pkey', '-in', join(output, 'publisher.key'), '-pubout', '-out', join(output, 'publisher.pub')]);
  const certificate = join(output, 'console.crt'), privateKey = join(output, 'console.key');
  run('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', privateKey, '-out', certificate, '-subj', '/CN=localhost', '-addext', 'subjectAltName=DNS:localhost', '-addext', 'basicConstraints=critical,CA:TRUE', '-days', '2']);
  chmodSync(privateKey, 0o600);
  const config = JSON.parse(readFileSync(join(root, 'examples/installation.json'), 'utf8'));
  config.installation = id; config.origin = 'https://localhost:' + consolePort; config.hosts.control.directory = owned;
  config.console.httpsPort = consolePort; config.console.runtimeFile = join(owned, 'config/runtime.json');
  for (const [name, placement] of Object.entries(config.components)) {
    if (placement.envFile) placement.envFile = join(owned, 'config', name + '.env');
    if (placement.configDirectory) placement.configDirectory = join(owned, 'config', name);
  }
  config.bootstrap = { adminUsername: 'admin', adminEmail: 'alice@example.com', certificateFile: certificate, privateKeyFile: privateKey };
  const withoutRegistry = structuredClone(config); delete withoutRegistry.components['hive-registry'];
  put(legacyConfigFile, withoutRegistry); put(configFile, withoutRegistry);

  const current = structuredClone(legacy);
  current.version = '0.1.1';
  current.components['hive-registry'] = hiveRegistryComponent(pushed('hive-registry', 'hive-registry:candidate'), user);
  current.profiles = { core: [...names, 'hive-registry'], full: [...names, 'hive-registry'] };
  applySuiteCatalog(current);
  const legacyManifest = signed('legacy-release.json', legacy), currentManifest = signed('current-release.json', current);

  // A real installation made by a controller from before the registry.
  put(join(output, 'legacy-install.log'), await hive('install', { controller: legacyRoot, manifest: legacyManifest }));
  assert(!running().includes('hive-registry'));
  const credentialFile = join(owned, 'config/initial-credentials.env'), originalCredentials = readFileSync(credentialFile);
  const ca = readFileSync(certificate), call = registryCall({ port: consolePort, ca });
  assert.equal((await call('GET', '/api/registry/v1/installation')).status, 404, 'A legacy ingress must not know the route');

  // This controller refuses a fresh install of that configuration, but upgrade adds it.
  await assert.rejects(hive('install', { manifest: currentManifest }));
  assert.match(readFileSync(join(output, 'install-failure.log'), 'utf8'), /The Hive Registry is mandatory/);
  const configBefore = readFileSync(configFile, 'utf8');
  put(join(output, 'upgrade.log'), await hive('upgrade', { manifest: currentManifest, args: ['--release', '0.1.1', '--archive', 'pre-registry'] }));
  rehearsalDown('pre-registry');
  assert.equal(readFileSync(configFile, 'utf8'), configBefore, 'Upgrade rewrote the operator configuration');
  assert.deepEqual(running(), [...names, 'hive-registry'].sort());
  assert.deepEqual(readFileSync(credentialFile), originalCredentials, 'Upgrade changed product credentials');
  assert.equal(JSON.parse(readFileSync(join(owned, 'data-formats.json'), 'utf8'))['hive-registry'], 'hive-registry-v1');
  assert.match(readFileSync(join(owned, 'config/ingress/Caddyfile'), 'utf8'), /hive-registry:8095/);
  assert(existsSync(join(owned, 'config/ingress/Caddyfile.pre-registry')));
  const effective = structuredClone(config);
  const check = (manifest) => assertRecordedState({ list: JSON.parse(lookup('list')), summary: JSON.parse(lookup('summary')), addresses: { control: owned }, config: effective, manifest, docker });
  check(current);
  const summary = await call('GET', '/api/registry/v1/installation');
  assert.equal(summary.status, 200, 'The upgraded ingress did not serve the registry');
  assert.equal(summary.json().id, id);
  put(join(output, 'status-upgraded.json'), run(join(root, 'hive.sh'), ['status', '--config', configFile], { env: environment }));
  assert.equal(hostStatuses(readFileSync(join(output, 'status-upgraded.json'), 'utf8'))[0].registry.state, 'in-sync');
  assert.match(run(join(root, 'hive.sh'), ['doctor', '--config', configFile], { env: environment }), /in sync/);
  // The pre-change backup rehearsed the registry on its empty store, read-only.
  const rehearsal = JSON.parse(readFileSync(join(owned, 'rehearsals/pre-registry/isolated.json'), 'utf8'));
  assert.equal(rehearsal.services['hive-registry'].volumes.find((mount) => mount.target === '/data').read_only, true);

  // Retrying the same upgrade changes nothing in the registry and keeps its credentials.
  const tokens = () => ['read-token', 'write-token'].map((name) => readFileSync(join(owned, 'config/hive-registry', name), 'utf8'));
  const firstTokens = tokens(), history = JSON.parse(lookup('history')).entries.length;
  put(join(output, 'upgrade-repeat.log'), await hive('upgrade', { manifest: currentManifest, args: ['--release', '0.1.1', '--archive', 'pre-registry-repeat'] }));
  rehearsalDown('pre-registry-repeat');
  assert.deepEqual(tokens(), firstTokens, 'Retry changed registry credentials');
  assert.equal(JSON.parse(lookup('history')).entries.length, history, 'Retry added registry history');

  // Rolling back to a release from before the registry retires it and keeps its data.
  put(join(output, 'rollback.log'), await hive('rollback', { manifest: legacyManifest, args: ['--release', '0.1.0', '--archive', 'pre-rollback'] }));
  rehearsalDown('pre-rollback');
  assert.deepEqual(running(), names.toSorted(), 'A rollback to a release without the registry left it running');
  assert(existsSync(join(owned, 'data/hive-registry/registry.sqlite')), 'Rollback removed registry data');
  assert.deepEqual(readFileSync(credentialFile), originalCredentials);

  // Upgrading again resumes the same store: history continues, nothing is duplicated.
  put(join(output, 'upgrade-again.log'), await hive('upgrade', { manifest: currentManifest, args: ['--release', '0.1.1', '--archive', 'pre-registry-again'] }));
  rehearsalDown('pre-registry-again');
  check(current);
  assert(JSON.parse(lookup('history')).entries.length >= history, 'Registry history was lost across a rollback');
  assert.deepEqual(tokens(), firstTokens);

  // Adoption: an existing project with no Hive receipt gains a populated registry, and
  // its running products are not restarted.
  const adoptManifest = signed('adopt-release.json', { ...current, version: '0.1.2' });
  put(join(output, 'rollback-for-adoption.log'), await hive('rollback', { manifest: legacyManifest, args: ['--release', '0.1.0', '--archive', 'pre-adoption'] }));
  rehearsalDown('pre-adoption');
  for (const file of ['receipt.json', 'transaction.json', 'data-formats.json']) rmSync(join(owned, file));
  rmSync(join(owned, 'config/hive-registry'), { recursive: true }); rmSync(join(owned, 'config/hive-registry.env')); rmSync(join(owned, 'data/hive-registry'), { recursive: true });
  const before = Object.fromEntries(names.map((name) => [name, JSON.parse(docker('inspect', docker('compose', '-f', compose, 'ps', '-q', name)))[0].State.StartedAt]));
  put(join(output, 'adopt.log'), await hive('adopt', { manifest: adoptManifest, args: ['--release', '0.1.2'] }));
  assert.deepEqual(Object.fromEntries(names.map((name) => [name, JSON.parse(docker('inspect', docker('compose', '-f', compose, 'ps', '-q', name)))[0].State.StartedAt])), before, 'Adoption restarted a product');
  check({ ...current, version: '0.1.2' });
  docker('compose', '-f', compose, 'restart', 'ingress');
  await new Promise((done) => setTimeout(done, 2000));
  assert.equal((await call('GET', '/api/registry/v1/installation')).status, 200, 'The route did not start after the ingress restarted');
  assert.match(run(join(root, 'hive.sh'), ['doctor', '--config', configFile], { env: environment }), /in sync/);

  put(join(output, 'result.json'), { schema: 1, result: 'passed', productionCutover: false, legacyRevision, checks: ['fresh install on a controller from before the registry', 'upgrade adds the registry without rewriting configuration or credentials', 'recorded state equals running containers and the signed release', 'pre-change rehearsal keeps the store read-only', 'repeated upgrade adds no history and keeps credentials', 'rollback to a release without the registry retires it and keeps its data', 'second upgrade resumes the same store', 'adoption populates the registry without restarting products'] });
  passed = true;
  console.log('PASS: an existing installation gains the Hive Registry by upgrade and adoption, and rolls back cleanly.');
} catch (error) {
  console.error('Failed at ' + step + '. Private proof retained at ' + output);
  if (existsSync(compose)) try { put(join(output, 'containers.log'), docker('compose', '-f', compose, 'logs', '--no-color', '--tail', '200')); } catch {}
  throw error;
} finally {
  for (const archive of ['pre-registry', 'pre-registry-repeat', 'pre-rollback', 'pre-registry-again', 'pre-adoption']) rehearsalDown(archive);
  composeDown(compose);
  try { docker('rm', '-f', registryName); } catch {}
  for (const tag of tags) try { docker('image', 'rm', tag); } catch {}
}
