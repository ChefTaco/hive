#!/usr/bin/env node
// Verify an installed tarball outside the source tree. --registry tests the exact public version.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import https from 'node:https';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const source = join(repo, 'services/hive-skills');
const manifest = JSON.parse(readFileSync(join(source, 'package.json'), 'utf8'));
if (process.argv.slice(2).some((arg) => arg !== '--registry')) throw new Error('Usage: npm run check:skills-install -- [--registry]');
const work = mkdtempSync(join(tmpdir(), 'hive-skills-package-')); chmodSync(work, 0o700);
let server;
let logs = '';
function run(command, args, options = {}) {
  const result = spawnSync(command, args, { cwd: work, encoding: 'utf8', timeout: 180_000, ...options });
  assert.equal(result.status, 0, `${command} failed: ${result.stderr || result.error?.message || result.stdout}`);
  return result.stdout;
}
async function stop() {
  if (!server || server.exitCode !== null || server.signalCode !== null) return;
  const exited = once(server, 'exit');
  server.kill('SIGTERM');
  const timer = setTimeout(() => server.kill('SIGKILL'), 5000);
  try { await exited; } finally { clearTimeout(timer); }
}
try {
  const packed = JSON.parse(run('npm', ['pack', '--json', '--ignore-scripts', '--pack-destination', work,
    ...(process.argv.includes('--registry') ? [`${manifest.name}@${manifest.version}`, '--registry=https://registry.npmjs.org'] : [])],
  { cwd: process.argv.includes('--registry') ? work : source }))[0];
  for (const file of packed.files) {
    assert.doesNotMatch(file.path, /(^|\/)(?:\.env[^/]*|\.npmrc|[^/]*\.local\.md|src|node_modules|data|certs|backups)\/|\.(?:test\.js|ts|db|sqlite|pem|key|crt)$/);
  }
  const runtime = join(work, 'runtime'); mkdirSync(runtime);
  run('npm', ['install', '--prefix', runtime, '--omit=dev', '--ignore-scripts', '--no-fund', '--no-audit', '--registry=https://registry.npmjs.org', join(work, packed.filename)]);
  const installed = join(runtime, 'node_modules/@hivemagnus/hive-skills');
  const cli = join(runtime, 'node_modules/.bin/hive-skills');
  assert.equal(run(cli, ['--version']).trim(), manifest.version);
  run(cli, ['--help']);
  for (const path of ['LICENSE', 'scripts/archive-utils.mjs', 'scripts/hermes-sync.mjs', 'scripts/deploy-hermes-agent.sh', 'registry-sources/hivemem/SKILL.md']) assert.ok(existsSync(join(installed, path)), path);
  const key = join(work, 'server.key'), cert = join(work, 'server.crt');
  run('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=localhost', '-addext', 'subjectAltName=DNS:localhost,IP:127.0.0.1', '-keyout', key, '-out', cert]);
  const portServer = createServer(); portServer.listen(0, '127.0.0.1'); await once(portServer, 'listening');
  const port = portServer.address().port; await new Promise((done) => portServer.close(done));
  const base = `https://127.0.0.1:${port}`;
  const envFile = join(work, 'registry.env');
  const settings = { NODE_ENV: 'production', HIVE_SKILLS_HOST: '127.0.0.1', HIVE_SKILLS_PORT: String(port), HIVE_SKILLS_PUBLIC_URL: base,
    HIVE_SKILLS_DATA_DIR: join(work, 'state'), HIVE_SKILLS_SESSION_SECRET: 'fixture-only-session-secret-01234567890123456789',
    HIVE_SKILLS_ADMIN_USERS: 'admin', HIVE_SKILLS_TLS_KEY_FILE: key, HIVE_SKILLS_TLS_CERT_FILE: cert };
  writeFileSync(envFile, Object.entries(settings).map(([k, v]) => `${k}=${JSON.stringify(v)}`).join('\n'), { mode: 0o600 });
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('HIVE_SKILLS_')));
  env.NODE_EXTRA_CA_CERTS = cert;
  run(cli, ['env-schema'], { env });
  assert.equal(existsSync(settings.HIVE_SKILLS_DATA_DIR), false);
  run(cli, ['check', '--env-file', envFile], { env });
  assert.equal(existsSync(settings.HIVE_SKILLS_DATA_DIR), false, 'check must not create storage');
  run(cli, ['seed', '--env-file', envFile], { env });
  run(cli, ['check', '--env-file', envFile], { env });
  const helper = run(process.execPath, ['--env-file', envFile, '--input-type=module', '-e',
    `const {config}=await import(${JSON.stringify(pathToFileURL(join(installed, 'dist/config.js')).href)});console.log(config.deployScript)`], { env }).trim();
  assert.equal(helper, join(installed, 'scripts/deploy-hermes-agent.sh'));
  const ca = readFileSync(cert);
  function get(path) {
    return new Promise((resolveResponse, reject) => {
      const request = https.get(base + path, { ca, timeout: 5000 }, (response) => {
        const chunks = []; response.on('data', (chunk) => chunks.push(chunk)); response.on('error', reject);
        response.on('end', () => resolveResponse({ status: response.statusCode, headers: response.headers, body: Buffer.concat(chunks) }));
      });
      request.on('error', reject); request.on('timeout', () => request.destroy(new Error('Request timeout')));
    });
  }
  async function start() {
    logs = '';
    server = spawn(process.execPath, [cli, '--env-file', envFile], { cwd: work, env, stdio: ['ignore', 'pipe', 'pipe'] });
    server.stdout.on('data', (chunk) => { logs = (logs + chunk).slice(-16000); });
    server.stderr.on('data', (chunk) => { logs = (logs + chunk).slice(-16000); });
    for (let attempt = 0; attempt < 100; attempt++) {
      assert.equal(server.exitCode, null, logs);
      try { if ((await get('/healthz')).status === 200) return; } catch { /* listener starting */ }
      await new Promise((done) => setTimeout(done, 50));
    }
    throw new Error(`Registry did not start: ${logs}`);
  }
  await start();
  assert.equal((await get('/')).status, 200);
  assert.equal((await get('/admin/skills')).status, 401);
  assert.equal((await get('/v1/agent/manifest?target=unregistered-agent')).status, 401);
  const catalog = JSON.parse((await get('/v1/skills')).body); assert.equal(catalog.length, 1);
  const registry = JSON.parse((await get('/v1/agent/manifest')).body); assert.equal(registry.skills.length, 1);
  const item = registry.skills[0]; assert.equal(item.slug, 'hivemem'); assert.equal(item.version, '1.0.0');
  const archive = await get(new URL(item.archiveUrl).pathname); assert.equal(archive.status, 200);
  assert.equal(createHash('sha256').update(archive.body).digest('hex'), item.sha256);
  assert.equal(archive.headers['x-content-sha256'], item.sha256);
  const bridgeCheck = `import assert from 'node:assert/strict';import{readFileSync}from'node:fs';
    const{syncSkills}=await import(${JSON.stringify(pathToFileURL(join(installed, 'scripts/hermes-sync.mjs')).href)});
    let restarts=0;const options={registry:${JSON.stringify(base)},hermesHome:${JSON.stringify(join(work, 'hermes'))},restart:()=>{restarts++},hermesVersion:'3.0.0'};
    await syncSkills(options);await syncSkills(options);assert.equal(restarts,1);
    assert.match(readFileSync(${JSON.stringify(join(work, 'hermes/skills/registry/hivemem/SKILL.md'))},'utf8'),/HiveMem/);
    console.log('Packaged bridge installed the digest-verified archive; second pull did not restart');`;
  run(process.execPath, ['--input-type=module', '-e', bridgeCheck], { env });
  await stop(); await start();
  assert.deepEqual(JSON.parse((await get('/v1/skills')).body), catalog);
  assert.deepEqual(JSON.parse((await get('/v1/agent/manifest')).body).skills, registry.skills);
  console.log(`PASS ${manifest.name}@${manifest.version}: clean install, CLI, package-relative helpers/seed, HTTPS, catalog, manifest, archive digest, auth boundaries, bridge replay and restart persistence`);
} finally { await stop(); rmSync(work, { recursive: true, force: true }); }
