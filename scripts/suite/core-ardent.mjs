// Disposable native Ardent acceptance against an explicitly fresh core fixture.
// No existing profiles, services or provider credentials are selected or altered.
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { createServer } from 'node:https';
import { createReadStream, readFileSync, writeFileSync, mkdirSync, chmodSync, openSync, closeSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createServer as tcpServer } from 'node:net';

const execute = promisify(execFile);
export async function rehearseArdent({ root, output, origin, artifactFile, tokens, request, certificate, privateKey, environment }) {
  const directory = join(output, 'ardent-proof');
  mkdirSync(directory, { mode: 0o700 });
  const put = (name, value) => {
    const path = join(directory, name);
    mkdirSync(dirname(path), { mode: 0o700, recursive: true });
    writeFileSync(path, typeof value === 'string' ? value : JSON.stringify(value, null, 2), { mode: 0o600 });
    chmodSync(path, 0o600);
    return path;
  };
  const descriptor = JSON.parse(readFileSync(artifactFile, 'utf8'));
  assert.equal(descriptor.product, '@hivemagnus/ardent');
  assert.equal(descriptor.published, false, 'This driver selects reviewed local developer artifacts only');
  assert(/^[A-Za-z0-9._-]+\.tar\.gz$/.test(descriptor.archive));
  const archive = join(dirname(artifactFile), descriptor.archive);
  assert.equal(createHash('sha256').update(readFileSync(archive)).digest('hex'), descriptor.sha256);
  // Repeat the adapter boundary before using the archive's profile initializer.
  const listing = (await execute('tar', ['-tzf', archive])).stdout.trim().split('\n');
  assert(listing.every(name => !name.startsWith('/') && !name.includes('..') && !name.includes('\\') && !/\.(gguf|ggml|safetensors)$/i.test(name)), 'Unsafe native artifact path or external inference asset');
  const types = (await execute('tar', ['-tvzf', archive])).stdout.trim().split('\n');
  assert(types.every(line => ['d', '-'].includes(line[0])), 'Native artifact contains links or special files');
  const unpack = join(directory, 'initializer');
  mkdirSync(unpack, { mode: 0o700 });
  await execute('tar', ['-xzf', archive, '-C', unpack, '--no-same-owner', '--no-same-permissions']);
  const initialCLI = join(unpack, descriptor.executable), profile = join(directory, 'profile');
  const listener = tcpServer().listen(0, '127.0.0.1');
  await new Promise(done => listener.once('listening', done));
  const port = listener.address().port;
  await new Promise(done => listener.close(done));
  const baseEnv = Object.fromEntries(['PATH', 'HOME', 'LANG', 'LC_ALL', 'TZ'].filter(name => environment[name] ?? process.env[name]).map(name => [name, environment[name] ?? process.env[name]]));
  const command = async (program, args, env = baseEnv) => (await execute(program, args, { env, timeout: 90_000, maxBuffer: 2 * 1024 * 1024 })).stdout.trim();
  await command(initialCLI, ['--profile-path', profile, 'init', '--non-interactive', '--api-port', String(port)]);
  const retainedProfileEnvironment = readFileSync(join(profile, '.env'));
  const agentId = 'synthetic-ardent', workspace = 'default';
  const memory = await request('/api/hivemem/agents/register', {
    agent_id: agentId, display_name: 'Synthetic native Ardent', token_scopes: ['memories:read', 'memories:write', 'sessions:read', 'sessions:write'], workspace_ids: [workspace], expires_hours: 1,
  }, { Authorization: 'Bearer ' + tokens.hivemem });
  assert.equal(memory.status, 201, 'Scoped native memory enrollment failed');
  const memoryToken = memory.body.token;
  const claims = JSON.parse(Buffer.from(memoryToken.split('.')[1], 'base64url'));
  assert.equal(claims.role, 'agent');
  assert.equal(claims.sub, agentId);
  assert.deepEqual(claims.workspace_ids, [workspace]);
  assert(!claims.scope.includes('*') && !claims.scope.includes('admin:'));
  const key = await request('/api/emberpath/client-keys', {
    name: 'Synthetic Ardent fixture', metadata: { owner: agentId, scopes: ['models:read', 'inference:write'], environment: 'test', expiresAt: new Date(Date.now() + 3600_000).toISOString(), quota: { dailyRequests: 20 } },
  }, { Authorization: 'Bearer ' + tokens.emberpath });
  assert.equal(key.status, 201, 'Scoped model credential enrollment failed');
  const modelKey = key.body.data.apiKey;
  const originalConfig = readFileSync(join(profile, 'config.yaml'), 'utf8');
  put('profile/config.yaml', originalConfig.replace('memory:\n  provider: none', `memory:\n  provider: hivemem\n  base_url: \${HIVEMEM_API_URL}\n  token_env: HIVEMEM_TOKEN\n  agent_id: ${agentId}\n  workspace_id: default\n  default_scope: private`));
  const envFile = put('profile/native.env', Object.entries({
    ARDENT_LLAMA_BASE_URL: origin, ARDENT_LLAMA_MODEL: 'synthetic-external-alias', ARDENT_LLAMA_API_KEY: modelKey,
    HIVEMEM_API_URL: origin + '/memory/', HIVEMEM_TOKEN: memoryToken,
    ARDENT_API_TOKEN: 'synthetic-local-management-token', NODE_EXTRA_CA_CERTS: certificate,
    RETAINED_PROFILE_CREDENTIAL: 'obviously-fake-profile-retained',
  }).map(([name, value]) => `${name}=${value}`).join('\n') + '\n');
  const originalEnv = readFileSync(envFile);
  const assets = createServer({ key: readFileSync(privateKey), cert: readFileSync(certificate) }, (req, res) => {
    if (req.url !== '/ardent.tar.gz') { res.writeHead(404).end(); return; }
    createReadStream(archive).pipe(res);
  }).listen(0, '127.0.0.1');
  await new Promise(done => assets.once('listening', done));
  let gateway;
  const plan = 'c'.repeat(64), digest = 'd'.repeat(64), install = join(directory, 'installation');
  const selected = { id: 'native-ardent', runtime: 'ardent', version: descriptor.version, host: 'control', profileDirectory: profile, environmentFile: envFile, service: 'none', authorized: true };
  const input = { directory: install, installation: 'synthetic-ardent-proof', host: 'control', plan, digest, version: '0.1.0', operation: 'install', agents: [selected], inference: [] };
  put('installation/installation.json', { installation: input.installation, host: input.host });
  put('installation/transaction.json', { plan, operation: 'install', phase: 'ready' });
  put('installation/receipt.json', { plan, digest });
  put('installation/manifest.' + plan + '.json', { agentArtifacts: { ardent: { [descriptor.version]: { [descriptor.architecture]: {
    url: 'https://localhost:' + assets.address().port + '/ardent.tar.gz', sha256: descriptor.sha256,
    executable: descriptor.executable, arguments: descriptor.arguments, preflight: descriptor.preflight, acceptanceArguments: descriptor.acceptanceArguments,
  } } } } });
  const code = ['native-initialization-host.sh', 'adapters-host.sh', 'inference-registration.sh', 'host-runtime.sh'].map(name => readFileSync(join(root, 'scripts/suite', name), 'utf8')).join('\n');
  const adapterEnv = { ...baseEnv, CURL_CA_BUNDLE: certificate, UNRELATED_INFRA_SECRET: 'obviously-fake-must-not-inherit' };
  const action = async action => {
    const child = spawn('bash', ['-c', code], { env: adapterEnv, stdio: ['pipe', 'pipe', 'pipe'] });
    let log = '';
    child.stdout.on('data', bytes => log += bytes);
    child.stderr.on('data', bytes => log += bytes);
    const completed = new Promise((done, reject) => { child.once('error', reject); child.once('close', done); });
    child.stdin.end(JSON.stringify({ ...input, action }) + '\n');
    const status = await completed;
    put(action + '.log', log);
    assert.equal(status, 0, 'Native Ardent adapter failed; inspect protected evidence');
  };
  try {
    await action('adapters-stage');
    await action('adapters-stage');
    const log = openSync(put('gateway.log', ''), 'a');
    gateway = spawn('bash', [join(install, 'agents/native-ardent/run.' + plan)], { env: adapterEnv, stdio: ['ignore', log, log] });
    closeSync(log);
    const executable = join(install, 'agents/native-ardent/artifacts', descriptor.sha256, descriptor.executable);
    const args = ['--env-file', envFile, '--profile-path', profile];
    let ready = false;
    for (let i = 0; i < 60; i++) {
      try { const result = JSON.parse(await command(executable, [...args, 'acceptance'])); if (result.ok) { ready = true; break; } } catch {}
      await new Promise(done => setTimeout(done, 500));
    }
    assert(ready, 'Native Ardent gateway did not become ready');
    await action('agents-accept');
    assert.equal(JSON.parse(readFileSync(join(install, 'agents/native-ardent/receipt.json'), 'utf8')).accepted, true);
    const provider = JSON.parse(await command(executable, [...args, 'providers', 'test']));
    assert.equal(provider.answer, 'OK');
    const enrollment = await request('/api/hivemem/memories', { content: 'Synthetic native Ardent scoped memory acceptance', type: 'semantic', scope: 'private', workspace_id: workspace }, { Authorization: 'Bearer ' + memoryToken });
    assert.equal(enrollment.status, 201);
    const search = JSON.parse(await command(executable, [...args, 'memory', 'search', 'Synthetic native Ardent scoped memory acceptance']));
    assert(Array.isArray(search) && search.some(item => item.id === enrollment.body.id && item.agent_id === agentId));
    assert.equal((await request('/api/hivemem/agents/register', { agent_id: 'forbidden-agent', display_name: 'Forbidden' }, { Authorization: 'Bearer ' + memoryToken })).status, 403);
    assert.equal((await request('/api/emberpath/providers', null, { Authorization: 'Bearer ' + modelKey })).status, 401);
    assert.equal((await request('/api/emberpath/providers', null, { Authorization: 'Bearer ' + memoryToken })).status, 401);
    assert.deepEqual(readFileSync(envFile), originalEnv);
    assert.deepEqual(readFileSync(join(profile, '.env')), retainedProfileEnvironment);
    const processEnvironment = readFileSync(`/proc/${gateway.pid}/environ`, 'utf8');
    assert(!processEnvironment.includes('UNRELATED_INFRA_SECRET'));
    put('result.json', { schema: 1, result: 'passed', productionCutover: false, artifactSHA256: descriptor.sha256,
      checks: ['native Bash adapter staging and unchanged retries', 'private environment and original profile credential preservation', 'authenticated gateway version/profile/readiness', 'scoped native model generation through Emberpath', 'separate scoped memory identity, storage and native client search', 'agent administration and cross-product credential rejection'],
      limitations: ['one physical Linux host', 'developer external protocol fixture, no model runtime installed', 'Skills/Emberfold/chat bindings require separate acceptance'] });
  } finally {
    if (gateway && gateway.exitCode === null) {
      gateway.kill('SIGTERM');
      await Promise.race([new Promise(done => gateway.once('close', done)), new Promise(done => setTimeout(done, 5000))]);
      if (gateway.exitCode === null) gateway.kill('SIGKILL');
    }
    assets.closeAllConnections();
    await new Promise(done => assets.close(done));
  }
}
