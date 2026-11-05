// Fresh native Codex profile against the actual suite gateway. No existing
// profiles, provider credentials, inference runtimes or model assets are used.
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createServer } from 'node:https';
import { createReadStream, readFileSync, writeFileSync, mkdirSync, chmodSync } from 'node:fs';
import { dirname, join } from 'node:path';

const execute = (program, args, options) => new Promise((done, reject) => {
  const child = execFile(program, args, { encoding: 'utf8', timeout: 90_000, maxBuffer: 1024 * 1024, ...options }, (error, stdout) => error ? reject(error) : done(stdout.trim()));
  child.stdin.on('error', () => undefined); child.stdin.end();
});

export async function rehearseCodex({ root, output, origin, artifactFile, tokens, request, certificate, privateKey, environment }) {
  const directory = join(output, 'codex-proof'); mkdirSync(directory, { mode: 0o700 });
  const put = (name, value) => {
    const path = join(directory, name); mkdirSync(dirname(path), { mode: 0o700, recursive: true });
    writeFileSync(path, typeof value === 'string' ? value : JSON.stringify(value, null, 2), { mode: 0o600 }); chmodSync(path, 0o600); return path;
  };
  const descriptor = JSON.parse(readFileSync(artifactFile, 'utf8'));
  assert.equal(descriptor.product, '@openai/codex'); assert.equal(descriptor.published, false);
  assert(/^[A-Za-z0-9._-]+\.tar\.gz$/.test(descriptor.archive));
  const archive = join(dirname(artifactFile), descriptor.archive);
  assert.equal(createHash('sha256').update(readFileSync(archive)).digest('hex'), descriptor.sha256);
  const baseEnv = Object.fromEntries(['PATH', 'LANG', 'LC_ALL', 'TZ'].filter(name => environment[name]).map(name => [name, environment[name]]));
  const profile = join(directory, 'profile'), home = join(directory, 'home');
  mkdirSync(profile, { mode: 0o700 }); mkdirSync(home, { mode: 0o700 }); baseEnv.HOME = home;
  const modelKey = await request('/api/emberpath/client-keys', {
    name: 'Synthetic Codex fixture', metadata: { owner: 'synthetic-codex', scopes: ['models:read', 'inference:write'], environment: 'test', expiresAt: new Date(Date.now() + 3600_000).toISOString(), quota: { dailyRequests: 10 } },
  }, { Authorization: 'Bearer ' + tokens.emberpath });
  assert.equal(modelKey.status, 201);
  const key = modelKey.body.data.apiKey;
  const envFile = put('profile/native.env', `EMBERPATH_API_KEY=${key}\nCODEX_CA_CERTIFICATE=${certificate}\nRETAINED_PROFILE_CREDENTIAL=obviously-fake-retained\n`);
  const config = `model = "synthetic-external-alias"\nmodel_provider = "emberpath"\napproval_policy = "never"\nsandbox_mode = "read-only"\nweb_search = "disabled"\ncheck_for_update_on_startup = false\n[model_providers.emberpath]\nname = "Emberpath fixture"\nbase_url = "${origin}/v1"\nenv_key = "EMBERPATH_API_KEY"\nwire_api = "responses"\nrequires_openai_auth = false\nsupports_websockets = false\nrequest_max_retries = 0\nstream_max_retries = 0\nstream_idle_timeout_ms = 5000\n[analytics]\nenabled = false\n[feedback]\nenabled = false\n`;
  put('profile/config.toml', config); const original = readFileSync(envFile);
  const assets = createServer({ key: readFileSync(privateKey), cert: readFileSync(certificate) }, (req, res) => {
    if (req.url !== '/codex.tar.gz') { res.writeHead(404).end(); return; } createReadStream(archive).pipe(res);
  }).listen(0, '127.0.0.1');
  await new Promise(done => assets.once('listening', done));
  const installation = join(directory, 'installation'), plan = 'e'.repeat(64), digest = 'f'.repeat(64);
  const input = { directory: installation, installation: 'synthetic-codex-proof', host: 'control', plan, digest, version: '0.1.0', operation: 'install', inference: [], agents: [{
    id: 'native-codex', runtime: 'codex', version: descriptor.version, host: 'control', profileDirectory: profile, environmentFile: envFile, service: 'none', authorized: true,
  }] };
  put('installation/installation.json', { installation: input.installation, host: input.host });
  put('installation/transaction.json', { plan, operation: 'install', phase: 'ready' }); put('installation/receipt.json', { plan, digest });
  put('installation/manifest.' + plan + '.json', { agentArtifacts: { codex: { [descriptor.version]: { [descriptor.architecture]: {
    url: 'https://localhost:' + assets.address().port + '/codex.tar.gz', sha256: descriptor.sha256, executable: descriptor.executable, arguments: descriptor.arguments, preflight: descriptor.preflight, acceptanceArguments: [...descriptor.acceptanceArguments, '--expected-answer', 'OK'],
  } } } } });
  const code = ['native-initialization-host.sh', 'adapters-host.sh', 'inference-registration.sh', 'host-runtime.sh'].map(name => readFileSync(join(root, 'scripts/suite', name), 'utf8')).join('\n');
  const adapterEnv = { ...baseEnv, CURL_CA_BUNDLE: certificate, UNRELATED_INFRA_SECRET: 'obviously-fake-must-not-inherit' };
  const action = async action => {
    const child = spawn('bash', ['-c', code], { env: adapterEnv, stdio: ['pipe', 'pipe', 'pipe'] });
    let log = ''; child.stdout.on('data', bytes => log += bytes); child.stderr.on('data', bytes => log += bytes);
    const completed = new Promise((done, reject) => { child.once('error', reject); child.once('close', done); }); child.stdin.end(JSON.stringify({ ...input, action }) + '\n');
    assert.equal(await completed, 0, 'Native Codex adapter failed; inspect protected evidence'); put(action + '.log', log);
  };
  try {
    await action('adapters-stage'); await action('adapters-stage');
    await action('agents-accept');
    assert.equal(JSON.parse(readFileSync(join(installation, 'agents/native-codex/receipt.json'), 'utf8')).accepted, true);
    const executable = join(installation, 'agents/native-codex/artifacts', descriptor.sha256, descriptor.executable);
    const args = ['--env-file', envFile, '--profile-path', profile];
    const result = await execute(executable, [...args, 'exec', '--json', '--ephemeral', '--skip-git-repo-check', '--cd', directory,
      '--disable', 'shell_tool', '--disable', 'unified_exec', '--disable', 'apps', '--disable', 'multi_agent', 'Reply with OK. Do not call tools.'], { env: baseEnv });
    const events = result.split('\n').map(line => JSON.parse(line));
    assert(events.some(event => event.type === 'item.completed' && event.item?.type === 'agent_message' && event.item.text === 'OK'));
    assert.equal(events.filter(event => event.type === 'turn.completed').length, 1);
    assert.equal((await request('/api/emberpath/providers', null, { Authorization: 'Bearer ' + key })).status, 401);
    assert.equal((await request('/api/hivemem/agents', null, { Authorization: 'Bearer ' + key })).status, 401);
    assert.deepEqual(readFileSync(envFile), original); assert.equal(readFileSync(join(profile, 'config.toml'), 'utf8'), config);
    const run = readFileSync(join(installation, 'agents/native-codex/run.' + plan), 'utf8');
    assert(run.includes('env -i') && !run.includes('UNRELATED_INFRA_SECRET'));
    put('result.json', { schema: 1, result: 'passed', productionCutover: false, artifactSHA256: descriptor.sha256, version: descriptor.version,
      checks: ['actual Bash adapter staging, unchanged retry and strict product-owned native acceptance receipt', 'pinned native Codex compressed Responses request through Emberpath', 'verified HTTPS, scoped key, alias selection and streamed assistant answer', 'administration and cross-product credential rejection', 'original private profile and credential bytes retained'],
      limitations: ['one physical Linux AMD64 host', 'disposable external protocol fixture; no inference runtime or model asset installed', 'existing provider authorization and long-running app-server supervision remain operator-owned'] });
  } finally { assets.closeAllConnections(); await new Promise(done => assets.close(done)); }
}
