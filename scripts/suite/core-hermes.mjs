// Fresh native Hermes profile against the actual suite gateway. No existing
// profiles, provider credentials, inference runtimes or model assets are used.
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createServer } from 'node:https';
import { createReadStream, readFileSync, writeFileSync, mkdirSync, chmodSync, cpSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';

const execute = (program, args, options) => new Promise((done, reject) => {
  const child = execFile(program, args, { encoding: 'utf8', timeout: 90_000, maxBuffer: 32 * 1024 * 1024, ...options }, (error, stdout) => error ? reject(error) : done(stdout.trim()));
  child.stdin.on('error', () => undefined); child.stdin.end();
});

export async function rehearseHermes({ root, output, origin, artifactFile, pluginArtifactFile, tokens, request, certificate, privateKey, environment }) {
  const directory = join(output, 'hermes-proof'); mkdirSync(directory, { mode: 0o700 });
  const put = (name, value) => {
    const path = join(directory, name); mkdirSync(dirname(path), { mode: 0o700, recursive: true });
    writeFileSync(path, typeof value === 'string' ? value : JSON.stringify(value, null, 2), { mode: 0o600 }); chmodSync(path, 0o600); return path;
  };
  const descriptor = JSON.parse(readFileSync(artifactFile, 'utf8'));
  assert.equal(descriptor.product, 'hermes-agent'); assert.equal(descriptor.published, false);
  assert(/^[A-Za-z0-9._-]+\.tar\.gz$/.test(descriptor.archive));
  const archive = join(dirname(artifactFile), descriptor.archive);
  assert.equal(createHash('sha256').update(readFileSync(archive)).digest('hex'), descriptor.sha256);
  const baseEnv = Object.fromEntries(['PATH', 'LANG', 'LC_ALL', 'TZ'].filter(name => environment[name]).map(name => [name, environment[name]]));
  const profile = join(directory, 'profile'), home = join(directory, 'home');
  mkdirSync(profile, { mode: 0o700 }); mkdirSync(home, { mode: 0o700 }); baseEnv.HOME = home;
  const modelKey = await request('/api/emberpath/client-keys', {
    name: 'Synthetic Hermes fixture', metadata: { owner: 'synthetic-hermes', scopes: ['models:read', 'inference:write'], environment: 'test', expiresAt: new Date(Date.now() + 3600_000).toISOString(), quota: { dailyRequests: 10 } },
  }, { Authorization: 'Bearer ' + tokens.emberpath });
  assert.equal(modelKey.status, 201);
  const key = modelKey.body.data.apiKey;
  let memoryBindings = '', memoryToken, memoryArtifact;
  if (pluginArtifactFile) {
    memoryArtifact = JSON.parse(readFileSync(pluginArtifactFile, 'utf8'));
    assert.equal(memoryArtifact.product, 'hivemem-hermes-plugin'); assert.equal(memoryArtifact.published, false);
    assert(/^[A-Za-z0-9._-]+\.tar\.gz$/.test(memoryArtifact.archive));
    const pluginArchive = join(dirname(pluginArtifactFile), memoryArtifact.archive);
    assert.equal(createHash('sha256').update(readFileSync(pluginArchive)).digest('hex'), memoryArtifact.sha256);
    const listing = (await execute('tar', ['-tzf', pluginArchive])).split('\n').sort();
    assert.deepEqual(listing, ['./', './LICENSE', './NOTICE', './provenance.json', './hivemem/', './hivemem/__init__.py', './hivemem/cli.py', './hivemem/plugin.yaml'].sort());
    assert((await execute('tar', ['-tvzf', pluginArchive])).split('\n').every(line => ['-', 'd'].includes(line[0])));
    const staging = join(directory, 'memory-plugin'); mkdirSync(staging, { mode: 0o700 });
    await execute('tar', ['-xzf', pluginArchive, '-C', staging, '--no-same-owner', '--no-same-permissions']);
    assert.deepEqual(memoryArtifact.files.map(file => file.path).sort(), ['hivemem/__init__.py', 'hivemem/cli.py', 'hivemem/plugin.yaml'].sort());
    for (const file of memoryArtifact.files) assert.equal(createHash('sha256').update(readFileSync(join(staging, file.path))).digest('hex'), file.sha256);
    mkdirSync(join(profile, 'plugins'), { mode: 0o700 });
    cpSync(join(staging, 'hivemem'), join(profile, 'plugins/hivemem'), { recursive: true, errorOnExist: true, force: false });
    const agent = 'synthetic-native-hermes', workspace = 'synthetic-hermes-workspace';
    assert.equal((await request('/api/hivemem/workspaces', { workspace_id: workspace, title: 'Synthetic Hermes workspace', members: [{ agent_id: agent, role: 'member' }] }, { Authorization: 'Bearer ' + tokens.hivemem })).status, 201);
    const enrolled = await request('/api/hivemem/agents/register', { agent_id: agent, display_name: 'Synthetic native Hermes', token_scopes: ['memories:read', 'memories:write'], workspace_ids: [workspace], expires_hours: 1 }, { Authorization: 'Bearer ' + tokens.hivemem });
    assert.equal(enrolled.status, 201); memoryToken = enrolled.body.token;
    const claims = JSON.parse(Buffer.from(memoryToken.split('.')[1], 'base64url'));
    assert.equal(claims.role, 'agent'); assert.deepEqual(claims.workspace_ids, [workspace]); assert(!claims.scope.includes('admin:') && !claims.scope.includes('*'));
    memoryBindings = `HERMES_HIVEMEM_API_URL=${origin}/memory\nHERMES_HIVEMEM_TOKEN=${memoryToken}\nHERMES_HIVEMEM_CA_FILE=${certificate}\nHERMES_HIVEMEM_WORKSPACE_ID=${workspace}\n`;
    put('profile/hivemem.json', { enabled: true, workspace_id: workspace, capture_turns: false, recall_mode: 'tools' });
  }
  const envFile = put('profile/native.env', `EMBERPATH_API_KEY=${key}\nHERMES_CA_BUNDLE=${certificate}\nRETAINED_PROFILE_CREDENTIAL=obviously-fake-retained\n${memoryBindings}`);
  const config = `model:\n  default: synthetic-external-alias\n  provider: emberpath\nproviders:\n  emberpath:\n    base_url: ${origin}/v1\n    key_env: EMBERPATH_API_KEY\n    api_mode: chat_completions\n    ssl_ca_cert: ${certificate}\ndisplay:\n  streaming: true\nagent:\n  max_turns: 1\n  learning_mode: false\ncompression:\n  enabled: false\nmemory:\n  provider: ${memoryArtifact ? 'hivemem' : 'builtin'}\n  memory_enabled: false\n  user_profile_enabled: false\nskills:\n  auto_load: false\ntelemetry:\n  enabled: false\n`;
  put('profile/config.yaml', config); const original = readFileSync(envFile);
  const assets = createServer({ key: readFileSync(privateKey), cert: readFileSync(certificate) }, (req, res) => {
    if (req.url !== '/hermes.tar.gz') { res.writeHead(404).end(); return; } createReadStream(archive).pipe(res);
  }).listen(0, '127.0.0.1');
  await new Promise(done => assets.once('listening', done));
  const installation = join(directory, 'installation'), plan = 'e'.repeat(64), digest = 'f'.repeat(64);
  const input = { directory: installation, installation: 'synthetic-hermes-proof', host: 'control', plan, digest, version: '0.1.0', operation: 'install', inference: [], agents: [{
    id: 'native-hermes', runtime: 'hermes', version: descriptor.version, host: 'control', profileDirectory: profile, environmentFile: envFile, service: 'none', authorized: true,
  }] };
  put('installation/installation.json', { installation: input.installation, host: input.host });
  put('installation/transaction.json', { plan, operation: 'install', phase: 'ready' }); put('installation/receipt.json', { plan, digest });
  put('installation/manifest.' + plan + '.json', { agentArtifacts: { hermes: { [descriptor.version]: { [descriptor.architecture]: {
    url: 'https://localhost:' + assets.address().port + '/hermes.tar.gz', sha256: descriptor.sha256, executable: descriptor.executable, arguments: descriptor.arguments, preflight: descriptor.preflight,
    initializationArguments: descriptor.initializationArguments, verificationArguments: descriptor.verificationArguments,
  } } } } });
  const code = ['native-initialization-host.sh', 'adapters-host.sh', 'inference-registration.sh', 'host-runtime.sh'].map(name => readFileSync(join(root, 'scripts/suite', name), 'utf8')).join('\n');
  const adapterEnv = { ...baseEnv, CURL_CA_BUNDLE: certificate, UNRELATED_INFRA_SECRET: 'obviously-fake-must-not-inherit' };
  const action = async action => {
    const child = spawn('bash', ['-c', code], { env: adapterEnv, stdio: ['pipe', 'pipe', 'pipe'] });
    let log = ''; child.stdout.on('data', bytes => log += bytes); child.stderr.on('data', bytes => log += bytes);
    const completed = new Promise((done, reject) => { child.once('error', reject); child.once('close', done); }); child.stdin.end(JSON.stringify({ ...input, action }) + '\n');
    const status = await completed; put(action + '.log', log);
    assert.equal(status, 0, 'Native Hermes adapter failed; inspect protected evidence');
  };
  try {
    for (const name of ['cron', 'sessions', 'logs', 'memories']) assert(!existsSync(join(profile, name)));
    await action('adapters-stage'); await action('adapters-stage');
    const executable = join(installation, 'agents/native-hermes/artifacts', descriptor.sha256, descriptor.executable);
    const args = ['--env-file', envFile, '--profile-path', profile];
    for (const name of ['cron', 'sessions', 'logs', 'memories']) assert(existsSync(join(profile, name)));
    assert.equal(JSON.parse(readFileSync(join(installation, 'agents/native-hermes/initialization.' + descriptor.sha256 + '.json'), 'utf8')).phase, 'verified');
    const verified = JSON.parse(await execute(executable, [...args, '--native-verify-profile'], { env: baseEnv }));
    assert.equal(verified.readOnly, true);
    const result = JSON.parse(await execute(executable, [...args, '--native-acceptance', '--expected-answer', 'OK'], { env: baseEnv }));
    assert.equal(result.ok, true); assert.equal(result.generation, true); assert.equal(result.version, descriptor.version); assert.equal(result.streaming, true);
    if (memoryArtifact) {
      const memoryProof = await execute(executable, [...args, 'hivemem', 'test', '--write-check'], { env: baseEnv });
      assert(memoryProof.includes('disposable write/search/delete check... OK')); put('memory-cli.log', memoryProof);
      assert.equal((await request('/api/hivemem/agents/register', { agent_id: 'forbidden-hermes', display_name: 'Forbidden' }, { Authorization: 'Bearer ' + memoryToken })).status, 403);
      assert.equal((await request('/api/hivemem/memories', { content: 'Forbidden workspace', type: 'semantic', scope: 'private', workspace_id: 'default' }, { Authorization: 'Bearer ' + memoryToken })).status, 403);
      assert.equal((await request('/api/emberpath/providers', null, { Authorization: 'Bearer ' + memoryToken })).status, 401);
    }
    assert.equal((await request('/api/emberpath/providers', null, { Authorization: 'Bearer ' + key })).status, 401);
    assert.equal((await request('/api/hivemem/agents', null, { Authorization: 'Bearer ' + key })).status, 401);
    assert.deepEqual(readFileSync(envFile), original); assert.equal(readFileSync(join(profile, 'config.yaml'), 'utf8'), config);
    const run = readFileSync(join(installation, 'agents/native-hermes/run.' + plan), 'utf8');
    assert(run.includes('env -i') && !run.includes('UNRELATED_INFRA_SECRET'));
    put('result.json', { schema: 1, result: 'passed', productionCutover: false, artifactSHA256: descriptor.sha256, version: descriptor.version, ...(memoryArtifact ? { memoryPluginVersion: memoryArtifact.version, memoryPluginSHA256: memoryArtifact.sha256 } : {}),
      checks: ['actual Bash adapter staging and unchanged retry', 'pinned native Hermes ChatCompletions request through Emberpath', 'verified HTTPS, scoped key, alias selection and streamed assistant answer', 'administration and cross-product credential rejection', 'original private profile and credential bytes retained', ...(memoryArtifact ? ['pinned product-owned memory plugin, native CLI write/search/delete, workspace-scoped identity and denied escalation'] : [])],
      limitations: ['one physical Linux AMD64 host', 'disposable external protocol fixture; no inference runtime or model asset installed', 'existing provider authorization and long-running gateway supervision remain operator-owned'] });
  } finally { assets.closeAllConnections(); await new Promise(done => assets.close(done)); }
}
