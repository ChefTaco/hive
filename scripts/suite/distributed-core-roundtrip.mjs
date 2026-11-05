#!/usr/bin/env node
// Real product and pinned SSH proof with two host inventories on one developer
// machine. Certificates, registry, inventories and data are disposable and private.
import assert from 'node:assert/strict';
import { execFileSync, execFile, spawn, spawnSync } from 'node:child_process';
import { promisify, parseEnv } from 'node:util';
import { mkdirSync, writeFileSync, readFileSync, existsSync, chmodSync, openSync, closeSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { userInfo } from 'node:os';
import { randomBytes, createHash } from 'node:crypto';
import { createServer } from 'node:net';
import https from 'node:https';
import { extendFullFixture } from './full-release-fixture.mjs';
const execute = promisify(execFile), root = resolve(import.meta.dirname, '../..');
function argument(name) { const index = process.argv.indexOf(name); assert(index >= 0 && process.argv[index + 1], name + ' is required'); return resolve(process.argv[index + 1]); }
const output = argument('--output'), template = argument('--template-release');
assert(!existsSync(output), 'Select a new protected evidence directory');
assert(/^\/[A-Za-z0-9_./-]+$/.test(output));
assert.notEqual(process.getuid(), 0, 'Use an unprivileged operator with Docker access');
mkdirSync(output, { recursive: true, mode: 0o700 }); chmodSync(output, 0o700);
const put = (path, value, mode = 0o600) => { writeFileSync(path, typeof value === 'string' || Buffer.isBuffer(value) ? value : JSON.stringify(value, null, 2)); chmodSync(path, mode); };
const run = (program, args, options = {}) => execFileSync(program, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...options }).trim();
const docker = (...args) => run('docker', args);
const environment = Object.fromEntries(['PATH', 'LANG', 'LC_ALL', 'TZ'].filter(key => process.env[key]).map(key => [key, process.env[key]]));
async function port() { const socket = createServer().listen(0, '0.0.0.0'); await new Promise(done => socket.once('listening', done)); const value = socket.address().port; await new Promise(done => socket.close(done)); return value; }
const id = 'distributed-' + randomBytes(5).toString('hex'), registryName = id + '-registry', username = userInfo().username;
const addresses = { identity: join(output, 'identity'), console: join(output, 'console') };
const configFile = join(output, 'installation.json'), manifestFile = join(output, 'release.json'), sshConfig = join(output, 'ssh.conf');
const full = process.argv.includes('--full'), browserReview = process.argv.includes('--browser-review');
const tags = [], registryPort = await port(), consolePort = await port(), sshPort = await port(), registry = '127.0.0.1:' + registryPort;
let daemon, passed = false;
async function hive(command, ...args) {
  try { return (await execute(join(root, 'hive.sh'), [command, '--config', configFile, '--manifest', manifestFile, '--trust-key', join(output, 'publisher.pub'), '--non-interactive', '--yes', ...args], { env: environment, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 })).stdout.trim(); }
  catch (error) { put(join(output, command + '-failure.log'), String(error.stdout || '') + '\n' + String(error.stderr || '')); throw Error('Distributed ' + command + ' failed; protected evidence retained'); }
}
try {
  const gateway = JSON.parse(docker('network', 'inspect', 'bridge'))[0].IPAM.Config[0].Gateway;
  assert(/^\d+\.\d+\.\d+\.\d+$/.test(gateway));
  const manifest = JSON.parse(readFileSync(template, 'utf8'));
  const expected = ['emberpath', 'hivemem', 'hivemem-qdrant', 'hiveskills', 'hivexui', 'ingress', 'oathweave', 'oathweave-redis'];
  assert.deepEqual(Object.keys(manifest.components).sort(), expected, 'Template must contain the reviewed eight-component core fixture contract only');
  manifest.version = '0.1.0'; manifest.profiles = { core: expected, full: expected };
  docker('run', '-d', '--name', registryName, '--user', `${process.getuid()}:${process.getgid()}`, '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges:true', '--tmpfs', '/var/lib/registry:uid=' + process.getuid() + ',gid=' + process.getgid() + ',mode=700', '-p', '127.0.0.1:' + registryPort + ':5000', 'registry@sha256:a3d8aaa63ed8681a604f1dea0aa03f100d5895b6a58ace528858a7b332415373');
  for (const product of ['oathweave', 'emberpath', 'hivemem', 'hiveskills', 'hivexui', 'ingress']) {
    const tag = registry + '/' + id + '/' + product + ':candidate'; tags.push(tag);
    docker('tag', product === 'ingress' ? 'hive-ingress:candidate' : product + ':candidate', tag); docker('push', tag);
    manifest.components[product].image = JSON.parse(docker('image', 'inspect', tag, '--format', '{{json .RepoDigests}}')).find(value => value.startsWith(registry + '/' + id + '/' + product + '@sha256:'));
    assert(manifest.components[product].image);
  }
  if (full) extendFullFixture({ manifest, registry, id, tags, docker, user: `${process.getuid()}:${process.getgid()}` });
  for (const name of ['host', 'client', 'wrong-host']) run('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', join(output, name)]);
  put(join(output, 'authorized_keys'), readFileSync(join(output, 'client.pub')));
  const known = '[127.0.0.1]:' + sshPort + ' ' + readFileSync(join(output, 'host.pub'), 'utf8'); put(join(output, 'known_hosts'), known);
  mkdirSync(join(output, 'bin'), { mode: 0o700 });
  const actualDocker = run('sh', ['-c', 'command -v docker']);
  const migrationInterruption = full ? `if [[ "\${1:-}" == compose && "\${2:-}" == -f && "\${3:-}" == '${addresses.console}/bootstrap.'*.chattermost.compose.json && "\${!#}" == migrate ]]; then
 printf 'apply\\n' >> '${output}/chat-migration-calls'
 '${actualDocker}' "$@"; status=$?
 if [[ "$status" == 0 && ! -e '${output}/migration-interrupted' ]]; then touch '${output}/migration-interrupted'; exit 23; fi
 exit "$status"
fi
` : '';
  put(join(output, 'bin/docker'), `#!/usr/bin/env bash\n${migrationInterruption}if [[ "\${1:-}" == compose && "\${2:-}" == -f && "\${3:-}" == '${addresses.identity}/candidate.'*.json && " $* " == *' up '* && ! -e '${output}/activation-interrupted' ]]; then touch '${output}/activation-interrupted'; exit 23; fi\nexec '${actualDocker}' "$@"\n`, 0o700);
  put(join(output, 'sshd.conf'), `Port ${sshPort}\nListenAddress 127.0.0.1\nHostKey ${output}/host\nPidFile ${output}/sshd.pid\nAuthorizedKeysFile ${output}/authorized_keys\nAllowUsers ${username}\nPasswordAuthentication no\nKbdInteractiveAuthentication no\nAuthenticationMethods publickey\nUsePAM no\nPermitRootLogin no\nAllowTcpForwarding no\nX11Forwarding no\nPermitTTY no\nSetEnv PATH=${join(output, 'bin')}:${process.env.PATH}\nSubsystem sftp internal-sftp\n`);
  put(sshConfig, `Host identity.example.com console.example.com\n HostName 127.0.0.1\n Port ${sshPort}\n UserKnownHostsFile ${output}/known_hosts\n IdentityFile ${output}/client\n IdentityAgent none\n IdentitiesOnly yes\n StrictHostKeyChecking yes\n BatchMode yes\n ConnectTimeout 5\n LogLevel ERROR\n`);
  const descriptor = openSync(join(output, 'sshd.log'), 'wx', 0o600); daemon = spawn('/usr/sbin/sshd', ['-D', '-e', '-f', join(output, 'sshd.conf')], { stdio: ['ignore', descriptor, descriptor] }); closeSync(descriptor);
  await new Promise(done => setTimeout(done, 300));
  assert.equal(run('ssh', ['-F', sshConfig, username + '@identity.example.com', 'command -v docker']), join(output, 'bin/docker'));
  const config = JSON.parse(readFileSync(join(root, 'examples/installation.json'), 'utf8'));
  config.installation = id; if (full) { config.profile = 'full'; for (const name of Object.keys(manifest.components)) if (!config.components[name]) config.components[name] = { host: 'console', configDirectory: '/config/' + name, ...(/-(postgres|redis)$/.test(name) ? {} : { envFile: '/config/' + name + '.env' }) }; } config.origin = 'https://localhost:' + consolePort;
  config.hosts = Object.fromEntries(Object.entries(addresses).map(([host, directory]) => [host, { target: username + '@' + host + '.example.com', directory, sshConfig }]));
  config.console = { host: 'console', bindAddress: '127.0.0.1', httpsPort: consolePort, runtimeFile: join(addresses.console, 'config/runtime.json') };
  for (const [name, placement] of Object.entries(config.components)) {
    placement.host = ['oathweave', 'oathweave-redis', 'hiveskills'].includes(name) ? 'identity' : 'console';
    if (placement.envFile) placement.envFile = join(addresses[placement.host], 'config', name + '.env');
    if (placement.configDirectory) placement.configDirectory = join(addresses[placement.host], 'config', name);
  }
  config.bootstrap = { adminUsername: 'admin', adminEmail: 'alice@example.com', certificateFile: join(output, 'server.crt'), privateKeyFile: join(output, 'server.key'), trustBundleFile: join(output, 'server.crt'), productEndpoints: {} };
  for (const product of ['oathweave', 'emberpath', 'hivemem', 'hiveskills', ...(full ? ['magnus', 'cindertrace', 'chattermost'] : [])]) config.bootstrap.productEndpoints[product] = { origin: 'https://' + gateway + ':' + await port(), bindAddress: gateway, certificateFile: join(output, 'server.crt'), privateKeyFile: join(output, 'server.key'), ...(product === 'emberpath' ? { inferenceOrigin: 'https://' + gateway + ':' + await port() } : {}) };
  run('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', config.bootstrap.privateKeyFile, '-out', config.bootstrap.certificateFile, '-subj', '/CN=localhost', '-addext', 'subjectAltName=DNS:localhost,IP:' + gateway, '-days', '2']); chmodSync(config.bootstrap.privateKeyFile, 0o600);
  run('openssl', ['genpkey', '-algorithm', 'ED25519', '-out', join(output, 'publisher.key')]); run('openssl', ['pkey', '-in', join(output, 'publisher.key'), '-pubout', '-out', join(output, 'publisher.pub')]);
  put(configFile, config); put(manifestFile, manifest); run('openssl', ['pkeyutl', '-sign', '-inkey', join(output, 'publisher.key'), '-rawin', '-in', manifestFile, '-out', manifestFile + '.sig']);
  put(join(output, 'plan.log'), await hive('plan'));
  put(join(output, 'known_hosts'), '[127.0.0.1]:' + sshPort + ' ' + readFileSync(join(output, 'wrong-host.pub'), 'utf8'));
  await assert.rejects(hive('init'));
  for (const directory of Object.values(addresses)) assert(!existsSync(directory), 'Unknown host trust wrote initialization state');
  put(join(output, 'known_hosts'), known);
  await assert.rejects(hive('install'));
  if (full) {
    assert(existsSync(join(output, 'migration-interrupted')), 'Expected interruption after the real chat migrator committed');
    put(join(output, 'migration-interruption.log'), readFileSync(join(output, 'install-failure.log')));
    for (const host of Object.keys(addresses)) assert.equal(docker('ps', '-q', '--filter', 'label=com.docker.compose.project=' + id + '-' + host), '', 'Migration uncertainty left a writer running');
    await assert.rejects(hive('install'));
    assert.equal(readFileSync(join(output, 'chat-migration-calls'), 'utf8').trim().split('\n').length, 1, 'Claimed migration was replayed instead of verified');
  }
  assert(existsSync(join(output, 'activation-interrupted')), 'Expected second-host activation interruption');
  for (const host of Object.keys(addresses)) assert.equal(docker('ps', '-q', '--filter', 'label=com.docker.compose.project=' + id + '-' + host), '', 'An interrupted host writer remained active');
  const credentialPath = join(addresses.identity, 'config/initial-credentials.env'), originalCredentials = readFileSync(credentialPath);
  const identities = Object.fromEntries(['identity-id', 'model-id', 'memory-id'].map(name => [name, readFileSync(join(addresses.identity, 'config/.initializer/secrets', name), 'utf8').trim()]));
  put(join(output, 'resume.log'), await hive('install')); put(join(output, 'repeat.log'), await hive('install'));
  assert.deepEqual(readFileSync(credentialPath), originalCredentials);
  for (const [name, value] of Object.entries(identities)) for (const directory of Object.values(addresses)) assert.equal(readFileSync(join(directory, 'config/.initializer/secrets', name), 'utf8').trim(), value);
  assert(!existsSync(join(addresses.console, 'config/oathweave.env'))); assert(!existsSync(join(addresses.identity, 'config/emberpath.env')));
  assert(!existsSync(join(addresses.console, 'config/initial-credentials.env')));
  for (const host of Object.keys(addresses)) {
    const definition = JSON.parse(readFileSync(join(addresses[host], 'compose.json'), 'utf8'));
    for (const [name, service] of Object.entries(definition.services)) {
      assert.notEqual(service.user.split(':')[0], '0'); assert.equal(service.read_only, true); assert.deepEqual(service.cap_drop, ['ALL']);
      if (name.endsWith('-redis') || name.endsWith('-qdrant') || name.endsWith('-postgres')) assert(!service.ports, 'Private datastore exposed a host listener');
    }
  }
  const credentials = parseEnv(originalCredentials.toString()), ca = readFileSync(config.bootstrap.certificateFile);
  function request(path, body, headers = {}) { return new Promise((resolveResponse, reject) => {
    const req = https.request({ hostname: 'localhost', port: consolePort, path, method: body ? 'POST' : 'GET', ca, headers: { 'Content-Type': 'application/json', ...headers }, timeout: 8000 }, response => {
      let raw = ''; response.on('data', chunk => raw += chunk); response.on('end', () => { try { resolveResponse({ status: response.statusCode, headers: response.headers, body: raw ? JSON.parse(raw) : null }); } catch { reject(Error('Unexpected browser API response')); } });
    }); req.on('error', reject); req.on('timeout', () => req.destroy(Error('API timeout'))); if (body) req.write(Buffer.isBuffer(body) ? body : JSON.stringify(body)); req.end();
  }); }
  const browserHeaders = { Origin: config.origin, 'X-Oathweave-Browser': 'true' };
  const login = await request('/api/oathweave/auth/login', { username: credentials.SEED_ADMIN_USERNAME, password: credentials.SEED_ADMIN_PASSWORD }, browserHeaders); assert.equal(login.status, 200);
  const cookie = login.headers['set-cookie'].find(value => value.startsWith('__Host-oathweave_sso=')).split(';')[0], headers = { ...browserHeaders, Cookie: cookie }, tokens = {};
  async function mintTokens() {
  for (const product of ['oathweave', 'emberpath', 'hivemem', 'hiveskills', ...(full ? ['cindertrace', 'chattermost'] : [])]) {
    const verifier = randomBytes(32).toString('base64url'), state = randomBytes(32).toString('base64url'), nonce = randomBytes(32).toString('base64url');
    const code = await request('/api/oathweave/oauth/authorize', { clientId: 'hivexui-' + product, redirectUri: config.origin + '/auth/callback', responseType: 'code', codeChallenge: createHash('sha256').update(verifier).digest('base64url'), codeChallengeMethod: 'S256', scope: 'openid profile', state, nonce }, headers); assert.equal(code.status, 200); assert.equal(code.body.state, state);
    const token = await request('/api/oathweave/oauth/token', { grant_type: 'authorization_code', client_id: 'hivexui-' + product, code: code.body.code, code_verifier: verifier, redirect_uri: config.origin + '/auth/callback' }, headers); assert.equal(token.status, 200); tokens[product] = token.body.access_token;
    const payload = JSON.parse(Buffer.from(tokens[product].split('.')[1], 'base64url')); assert.equal(payload.aud, product); assert.equal(payload.sub, identities['identity-id']);
  }
  }
  await mintTokens();
  let boundChatCookie;
  if (full) {
    const contextRequest={schema_version:1,namespace:'example:admin:rehearsal',instructions:'Retain the synthetic pending action.',current:[{id:'current',role:'user',content:'Continue.'}],history:[],exchanges:[],protected:[],budget:{context_tokens:16000,output_reserve_tokens:4000},policy:{profile:'general'},dry_run:true};
    assert.equal((await request('/api/emberfold/v1/prepare',contextRequest)).status,401,'Context API accepted a missing product credential');
    const contextToken=parseEnv(readFileSync(join(addresses.console,'config/emberfold.env'),'utf8')).EMBERFOLD_API_TOKEN;
    const prepared=await request('/api/emberfold/v1/prepare',contextRequest,{Authorization:'Bearer '+contextToken}); assert.equal(prepared.status,200,'Context API standalone dry-run failed'); assert.equal(prepared.body.fits,true);
    assert.equal((await request('/api/emberfold/v1/prepare',contextRequest,{Authorization:'Bearer '+contextToken,Origin:config.origin})).status,403,'Context API accepted a browser origin');
    assert.equal((await request('/api/cindertrace/security-fusion/overview', null, { Authorization: 'Bearer ' + tokens.cindertrace })).status, 200);
    assert.equal((await request('/api/cindertrace/security-fusion/overview', null, { Authorization: 'Bearer ' + tokens.oathweave })).status, 401);
    const nativeSecurity = await request('/api/cindertrace/auth/local/login', JSON.parse(readFileSync(join(addresses.console, 'config/cindertrace/initial-browser-account.json'), 'utf8')), {Origin:config.origin}); assert.equal(nativeSecurity.status,200,'Product-owned security browser password hash failed');
    const exchange = await request('/api/chattermost/api/v4/auth/oathweave/session', {}, { Authorization: 'Bearer ' + tokens.chattermost, Origin: config.origin }); assert.equal(exchange.status, 200); boundChatCookie = exchange.headers['set-cookie'].find(value => value.startsWith('MMSID=')).split(';')[0];
    assert.equal(exchange.body.user.id, readFileSync(join(addresses.identity, 'config/.initializer/secrets/chat-id'), 'utf8').trim());
    const nativeLogin = await request('/api/v4/users/login', { login_id: 'admin', password: parseEnv(readFileSync(join(addresses.console, 'config/chattermost.env'), 'utf8')).ADMIN_PASSWORD }, { Origin: config.origin }); assert.equal(nativeLogin.status, 200);
    const chatHeaders = { Authorization: 'Bearer ' + nativeLogin.headers.token, Origin: config.origin };
    const teams = await request('/api/v4/users/me/teams', null, chatHeaders); assert.equal(teams.status, 200); const channels = await request('/api/v4/users/me/teams/' + teams.body[0].id + '/channels', null, chatHeaders); assert.equal(channels.status, 200);
    const post = await request('/api/v4/posts', {channel_id:channels.body[0].id,message:'Synthetic full-suite retained content'}, chatHeaders); assert.equal(post.status, 201); put(join(output,'full-chat-proof.json'), {postId:post.body.id, accountId:exchange.body.user.id});
    assert.equal((await request('/api/chattermost/api/v4/auth/oathweave/session', {}, {Authorization:'Bearer '+tokens.oathweave,Origin:config.origin})).status,401);
  }
  const routes = { oathweave: '/api/oathweave/auth/me', emberpath: '/api/emberpath/auth/me', hivemem: '/api/hivemem/agents', hiveskills: '/api/hiveskills/admin/skills' };
  for (const [product, path] of Object.entries(routes)) assert.equal((await request(path, null, { Authorization: 'Bearer ' + tokens[product] })).status, 200, 'Distributed authorized product failed: ' + product);
  assert.equal((await request(routes.emberpath, null, { Authorization: 'Bearer ' + tokens.oathweave })).status, 401);
  if (browserReview) {
    put(join(output, 'browser-credentials.json'), { origin: config.origin, username: credentials.SEED_ADMIN_USERNAME, password: credentials.SEED_ADMIN_PASSWORD, disposable: true });
    console.log('Disposable authenticated browser review ready; protected credentials retained in the selected evidence directory.');
    const completion = join(output, 'browser-completion.json'), deadline = Date.now() + 45 * 60 * 1000;
    while (!existsSync(completion)) { assert(Date.now() < deadline, 'Browser review did not complete within the protected review window'); await new Promise(done => setTimeout(done, 1000)); }
    const result = JSON.parse(readFileSync(completion, 'utf8')); assert.equal(result.result, 'passed', 'Authenticated browser review must pass before lifecycle rehearsal');
    // Long human reviews must not turn token expiry into false revocation proof.
    await mintTokens();
    if (full) { const renewed=await request('/api/chattermost/api/v4/auth/oathweave/session',{}, {Authorization:'Bearer '+tokens.chattermost,Origin:config.origin}); assert.equal(renewed.status,200); boundChatCookie=renewed.headers['set-cookie'].find(value=>value.startsWith('MMSID=')).split(';')[0]; }
  }
  for (const [product,path] of Object.entries(routes)) assert.equal((await request(path,null,{Authorization:'Bearer '+tokens[product]})).status,200,'Resource token must still be valid immediately before revocation: '+product);
  if (full) {
    assert.equal((await request('/api/cindertrace/security-fusion/overview',null,{Authorization:'Bearer '+tokens.cindertrace})).status,200);
    assert.equal((await request('/api/v4/users/me',null,{Cookie:boundChatCookie,Origin:config.origin})).status,200);
  }
  assert.equal((await request('/api/oathweave/browser/logout', {}, headers)).status, 200);
  for (const product of ['emberpath', 'hivemem', 'hiveskills']) assert.equal((await request(routes[product], null, { Authorization: 'Bearer ' + tokens[product] })).status, 401, 'Cross-host revoked session accepted: ' + product);
  if (full) {
    assert.equal((await request('/api/cindertrace/security-fusion/overview', null, { Authorization:'Bearer '+tokens.cindertrace })).status, 401, 'Revoked security resource token accepted');
    assert.equal((await request('/api/v4/users/me', null, { Cookie:boundChatCookie, Origin:config.origin })).status, 401, 'Chat suite cookie ignored identity session revocation');
  }
  put(join(output, 'backup.log'), await hive('backup', '--archive', 'distributed'));
  put(join(output, 'rehearse.log'), await hive('rehearse', '--archive', 'distributed'));
  const restoreResults = Object.fromEntries(Object.entries(addresses).map(([host, directory]) => [host, JSON.parse(readFileSync(join(directory, 'rehearsals/distributed/result.json'), 'utf8'))]));
  assert(restoreResults.identity.installationUUID !== restoreResults.console.installationUUID);
  for (const result of Object.values(restoreResults)) assert.equal(result.result, 'passed');
  if (full) {
    const restored = join(addresses.console,'rehearsals/distributed/isolated.json');
    docker('compose','-f',restored,'up','-d','--wait','--wait-timeout','60','chattermost-postgres');
    try {
      const snapshot = JSON.parse(docker('compose','-f',restored,'exec','-T','chattermost-postgres','psql','-U','chattermost_app','-d','chattermost','-At','-c','SELECT value FROM "RuntimeState";'));
      const proof=JSON.parse(readFileSync(join(output,'full-chat-proof.json'),'utf8'));
      assert(snapshot.posts.some(post=>post.id===proof.postId && post.message==='Synthetic full-suite retained content'),'Restored chat post content differs');
      assert(snapshot.users.some(user=>user.id===proof.accountId),'Restored chat product account ID differs');
    } finally { docker('compose','-f',restored,'stop','--timeout','45','chattermost-postgres'); }
  }
  put(join(output, 'result.json'), { schema: 1, result: 'passed', productionCutover: false, profile: full ? 'full' : 'core', physicalHosts: 1, sshInventories: 2, checks: ['fresh protected per-host product configuration', 'strict real SSH/SFTP trust', 'distinct Compose bridge projects with explicit verified HTTPS endpoints', 'private datastores stay local and unpublished', 'interrupted second-host activation holds every writer', 'repeat install preserves coordinated accounts and independent product secrets', 'one browser sign-in authorizes four products across host inventories', 'wrong-audience and revoked resource tokens rejected', 'separate host-bound backup and isolated restore rehearsals', ...(full ? ['explicit product migrator images and exact completion verification', 'real committed chat migration interruption reconciles by verification without replay', 'six resource-specific product identities', 'native chat sign-in and retained post', 'offline PostgreSQL checksums on restored private datastores'] : [])], productImages: Object.fromEntries(Object.entries(manifest.components).map(([name, value]) => [name, value.image])) });
  passed = true; console.log('PASS: fresh distributed ' + (full ? 'full suite' : 'core') + ', real SSH, verified cross-host HTTPS, interrupted resume, resource authorization, stable credentials and separate isolated restores (one physical host).');
} finally {
  if (!passed) for (const host of Object.keys(addresses)) for (const container of docker('ps', '-aq', '--filter', 'label=com.docker.compose.project=' + id + '-' + host).split(/\s+/).filter(Boolean)) {
    const logs = spawnSync('docker', ['logs', '--tail', '400', container], {encoding:'utf8'}); put(join(output, 'container-' + container.slice(0, 12) + '.log'), String(logs.stdout || '') + '\n' + String(logs.stderr || ''));
  }
  for (const directory of Object.values(addresses)) for (const file of [join(directory, 'rehearsals/distributed/isolated.json'), join(directory, 'compose.json'), ...(existsSync(directory) ? readdirSync(directory).filter(name=>/^bootstrap\.[a-f0-9]+\.compose\.json$/.test(name)).map(name=>join(directory,name)) : [])]) if (existsSync(file)) try { docker('compose', '-f', file, 'down', '--remove-orphans'); } catch {}
  for (const host of Object.keys(addresses)) for (const container of docker('ps', '-aq', '--filter', 'label=com.docker.compose.project=' + id + '-' + host).split(/\s+/).filter(Boolean)) try { docker('rm', '-f', container); } catch {}
  for (const host of Object.keys(addresses)) for (const network of docker('network','ls','-q','--filter','label=com.docker.compose.project='+id+'-'+host).split(/\s+/).filter(Boolean)) {
    const definition=JSON.parse(docker('network','inspect',network))[0];
    if (definition.Labels['com.docker.compose.project']===id+'-'+host && Object.keys(definition.Containers || {}).length===0) try { docker('network','rm',network); } catch {}
  }
  try { docker('rm', '-f', registryName); } catch {}
  for (const tag of tags) try { docker('image', 'rm', tag); } catch {}
  if (daemon) { daemon.kill('SIGTERM'); await new Promise(done => { if (daemon.exitCode !== null) done(); else daemon.once('close', done); }); }
  if (!passed) console.error('Private distributed proof retained at ' + output + '; no existing deployment was selected.');
}
