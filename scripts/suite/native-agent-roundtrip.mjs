#!/usr/bin/env node
// Developer proof: packaged native agent, real Magnus API, isolated PostgreSQL
// and Redis. Never selects an existing host agent, fleet or production service.
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import {
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
  chmodSync,
  createReadStream,
} from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { randomBytes, createHash } from 'node:crypto';
import { createServer as createTlsServer, request as tlsRequest } from 'node:https';
import { createServer as createTcpServer } from 'node:net';
const args = process.argv.slice(2),
  options = {};
for (let index = 0; index < args.length; index += 2) {
  assert(['--artifact', '--server-image', '--output'].includes(args[index]) && args[index + 1]);
  options[args[index].slice(2)] = args[index + 1];
}
assert(
  options.artifact && options.output && /^sha256:[a-f0-9]{64}$/.test(options['server-image'] ?? ''),
  '--artifact PRODUCT_ARTIFACT_JSON --server-image LOCAL_IMAGE_ID --output NEW_PRIVATE_DIRECTORY are required',
);
const root = resolve(import.meta.dirname, '../..'),
  output = resolve(options.output);
assert(!existsSync(output));
assert(process.getuid() !== 0);
mkdirSync(output, { recursive: true, mode: 0o700 });
chmodSync(output, 0o700);
const put = (name, value, mode = 0o600) => {
  const path = join(output, name);
  writeFileSync(
    path,
    typeof value === 'string' || Buffer.isBuffer(value) ? value : JSON.stringify(value, null, 2),
  );
  chmodSync(path, mode);
  return path;
};
const run = (command, argv, extra = {}) =>
  execFileSync(command, argv, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 32 * 1024 * 1024,
    ...extra,
  }).trim();
const docker = (...argv) => run('docker', argv);
const metadata = JSON.parse(readFileSync(resolve(options.artifact), 'utf8')),
  archive = join(dirname(resolve(options.artifact)), metadata.archive);
assert.equal(metadata.product, '@hivemagnus/magnus-agent');
assert.equal(metadata.architecture, { x64: 'amd64', arm64: 'arm64' }[process.arch]);
assert.equal(createHash('sha256').update(readFileSync(archive)).digest('hex'), metadata.sha256);
const id = 'native-proof-' + randomBytes(5).toString('hex'),
  user = `${process.getuid()}:${process.getgid()}`;
const port = async () => {
  const server = createTcpServer().listen(0, '127.0.0.1');
  await new Promise((done) => server.once('listening', done));
  const value = server.address().port;
  await new Promise((done) => server.close(done));
  return value;
};
const apiPort = await port(),
  agentPort = await port(),
  apiOrigin = 'https://localhost:' + apiPort,
  profile = join(output, 'profile'),
  installation = join(output, 'installation'),
  config = join(output, 'api-config');
for (const path of [
  profile,
  installation,
  config,
  join(output, 'api-data'),
  join(output, 'redis-data'),
])
  mkdirSync(path, { mode: 0o700 });
const secrets = Object.fromEntries(
  [
    'API_SECRET',
    'JWT_SECRET',
    'NODE_MANAGER_SECRET',
    'AUDIT_HMAC_SECRET',
    'RESULT_SIGNING_SECRET',
    'LOG_INGEST_SIGNING_SECRET',
    'CREDENTIAL_ROTATION_KEY',
    'METRICS_TOKEN',
    'WEBHOOK_ENCRYPTION_KEY',
    'CONTROL_NODE_CREDENTIAL_KEY',
    'POSTGRES_PASSWORD',
    'REDIS_PASSWORD',
  ].map((name) => [name, randomBytes(32).toString('hex')]),
);
const protectedEnvironment = (path, values) => {
  writeFileSync(
    path,
    Object.entries(values)
      .map(([key, value]) => key + '=' + value)
      .join('\n') + '\n',
    { mode: 0o600 },
  );
  chmodSync(path, 0o600);
};
const authority = put('authority.pem', ''),
  authorityKey = join(output, 'authority.key');
run('openssl', [
  'req',
  '-x509',
  '-newkey',
  'rsa:2048',
  '-nodes',
  '-keyout',
  authorityKey,
  '-out',
  authority,
  '-subj',
  '/CN=Synthetic native acceptance CA',
  '-days',
  '2',
]);
chmodSync(authorityKey, 0o600);
chmodSync(authority, 0o600);
function certificate(prefix, identities) {
  const key = join(output, prefix + '.key'),
    csr = join(output, prefix + '.csr'),
    cert = join(output, prefix + '.pem'),
    extensions = put(
      prefix + '.extensions',
      'subjectAltName=' + identities.join(',') + '\nextendedKeyUsage=serverAuth\n',
    );
  run('openssl', [
    'req',
    '-new',
    '-newkey',
    'rsa:2048',
    '-nodes',
    '-keyout',
    key,
    '-out',
    csr,
    '-subj',
    '/CN=synthetic-native-fixture',
  ]);
  run('openssl', [
    'x509',
    '-req',
    '-in',
    csr,
    '-CA',
    authority,
    '-CAkey',
    authorityKey,
    '-set_serial',
    '0x' + randomBytes(16).toString('hex'),
    '-out',
    cert,
    '-days',
    '1',
    '-extfile',
    extensions,
  ]);
  for (const path of [key, csr, cert]) chmodSync(path, 0o600);
  return { key, cert };
}
const apiTls = certificate('api', ['DNS:localhost', 'IP:127.0.0.1']);
for (const [name, source] of Object.entries({
  'server.key': apiTls.key,
  'server.pem': apiTls.cert,
  'ca.pem': authority,
}))
  put('api-config/' + name, readFileSync(source));
const apiEnv = {
  ...secrets,
  NODE_ENV: 'production',
  LOG_LEVEL: 'error',
  MAGNUS_HOME: '/data',
  DATABASE_URL: `postgresql://synthetic:${secrets.POSTGRES_PASSWORD}@postgres:5432/magnus_ideas_native`,
  REDIS_URL: `redis://:${secrets.REDIS_PASSWORD}@redis:6379`,
  REDIS_PREFIX: id + ':',
  CONTROL_API_PORT: '4000',
  CONTROL_API_BIND_HOST: '0.0.0.0',
  CONTROL_API_URL: apiOrigin,
  TLS_CERT_PATH: '/config/server.pem',
  TLS_KEY_PATH: '/config/server.key',
  NODE_EXTRA_CA_CERTS: '/config/ca.pem',
  MAGNUS_AUTO_MIGRATE: 'true',
  MAGNUS_AUTO_MIGRATE_BACKUP: 'false',
  MAGNUS_UPDATE_CHECK: 'false',
  MAGNUS_AUTO_UPGRADE: 'false',
  ENABLE_AGENT_DISCOVERY: 'false',
};
delete apiEnv.POSTGRES_PASSWORD;
delete apiEnv.REDIS_PASSWORD;
protectedEnvironment(join(output, 'api.env'), apiEnv);
protectedEnvironment(join(output, 'postgres.env'), {
  POSTGRES_USER: 'synthetic',
  POSTGRES_DB: 'magnus_ideas_native',
  POSTGRES_PASSWORD: secrets.POSTGRES_PASSWORD,
});
put(
  'redis.conf',
  `bind 0.0.0.0\nprotected-mode yes\nrequirepass ${secrets.REDIS_PASSWORD}\nappendonly yes\ndir /data\n`,
);
const pgImage = JSON.parse(
    docker('image', 'inspect', 'postgres:17-alpine', '--format', '{{json .RepoDigests}}'),
  )[0],
  redisImage = 'redis@sha256:5fa2edb1e408fa8235e6db8fab01d1afaaae96c9403ba67b70feceb8661e8621';
assert(pgImage?.includes('@sha256:'));
const pgUser = docker(
  'run',
  '--rm',
  '--entrypoint',
  'sh',
  pgImage,
  '-c',
  'printf "%s:%s" "$(id -u postgres)" "$(id -g postgres)"',
);
const compose = {
  name: id,
  services: {
    postgres: {
      image: pgImage,
      user: pgUser,
      read_only: true,
      cap_drop: ['ALL'],
      security_opt: ['no-new-privileges:true'],
      env_file: [join(output, 'postgres.env')],
      volumes: ['postgres:/var/lib/postgresql/data'],
      tmpfs: [
        '/tmp:mode=1777',
        `/var/run/postgresql:uid=${pgUser.split(':')[0]},gid=${pgUser.split(':')[1]},mode=700`,
      ],
      healthcheck: {
        test: ['CMD', 'pg_isready', '-U', 'synthetic', '-d', 'magnus_ideas_native'],
        interval: '2s',
        retries: 30,
      },
    },
    redis: {
      image: redisImage,
      user,
      read_only: true,
      cap_drop: ['ALL'],
      security_opt: ['no-new-privileges:true'],
      command: ['redis-server', '/config/redis.conf'],
      volumes: [
        {
          type: 'bind',
          source: join(output, 'redis.conf'),
          target: '/config/redis.conf',
          read_only: true,
        },
        { type: 'bind', source: join(output, 'redis-data'), target: '/data' },
      ],
      tmpfs: ['/tmp:mode=1777'],
      healthcheck: {
        test: [
          'CMD',
          'sh',
          '-c',
          'export REDISCLI_AUTH=$(sed -n "s/^requirepass //p" /config/redis.conf); redis-cli --no-auth-warning ping | grep -q PONG',
        ],
        interval: '2s',
        retries: 30,
      },
    },
    api: {
      image: options['server-image'],
      user,
      read_only: true,
      cap_drop: ['ALL'],
      security_opt: ['no-new-privileges:true'],
      env_file: [join(output, 'api.env')],
      volumes: [
        { type: 'bind', source: config, target: '/config', read_only: true },
        { type: 'bind', source: join(output, 'api-data'), target: '/data' },
      ],
      tmpfs: ['/tmp:mode=1777'],
      ports: [`127.0.0.1:${apiPort}:4000`],
      depends_on: {
        postgres: { condition: 'service_healthy' },
        redis: { condition: 'service_healthy' },
      },
      healthcheck: {
        test: [
          'CMD',
          'node',
          '-e',
          "fetch('https://localhost:4000/api/v1/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))",
        ],
        interval: '2s',
        timeout: '5s',
        start_period: '30s',
        retries: 90,
      },
    },
  },
  volumes: { postgres: {} },
};
const composeFile = put('compose.json', compose),
  dc = (...argv) => docker('compose', '-f', composeFile, ...argv);
const request = (path, body, headers = {}) =>
  new Promise((done, reject) => {
    const req = tlsRequest(
      new URL(path, apiOrigin),
      {
        method: body ? 'POST' : 'GET',
        ca: readFileSync(authority),
        headers: {
          'Content-Type': 'application/json',
          'x-api-secret': secrets.API_SECRET,
          ...headers,
        },
        timeout: 10000,
      },
      (res) => {
        let raw = '';
        res.on('data', (chunk) => (raw += chunk));
        res.on('end', () => {
          try {
            done({ status: res.statusCode, body: raw ? JSON.parse(raw) : null });
          } catch (error) {
            reject(error);
          }
        });
      },
    );
    req.on('error', reject);
    req.on('timeout', () => req.destroy(Error('Native fixture API timeout')));
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
let native,
  artifactServer,
  passed = false;
try {
  dc('up', '-d', '--wait', '--wait-timeout', '300');
  const apiContainer = dc('ps', '-q', 'api'),
    networks = JSON.parse(
      docker('inspect', apiContainer, '--format', '{{json .NetworkSettings.Networks}}'),
    ),
    gateway = Object.values(networks)[0].Gateway;
  const nativeTls = certificate('agent', [
    'DNS:localhost',
    'DNS:synthetic-agent.example.com',
    'IP:127.0.0.1',
    'IP:' + gateway,
  ]);
  for (const [name, path] of Object.entries({
    'server.key': nativeTls.key,
    'server.pem': nativeTls.cert,
    'ca.pem': authority,
  }))
    put('profile/' + name, readFileSync(path));
  const enrollment = await request('/api/v1/nodes/register', {
    name: 'Synthetic native agent',
    hostname: 'synthetic-agent.example.com',
    ipAddress: gateway,
    port: agentPort,
    os: 'linux',
    arch: metadata.architecture,
    agentVersion: metadata.version,
  });
  put('enrollment.json', enrollment);
  assert.equal(enrollment.status, 201);
  const envFile = join(profile, 'native.env');
  protectedEnvironment(envFile, {
    NODE_ENV: 'production',
    LOG_LEVEL: 'error',
    AGENT_INSTALL_DIR: profile,
    CONTROL_API_URL: apiOrigin,
    CONTROL_API_CA_PATH: join(profile, 'ca.pem'),
    NODE_MANAGER_SECRET: secrets.NODE_MANAGER_SECRET,
    RESULT_SIGNING_SECRET: secrets.RESULT_SIGNING_SECRET,
    HOST_FQDN: 'synthetic-agent.example.com',
    NODE_MANAGER_PORT: String(agentPort),
    NODE_MANAGER_BIND_HOST: gateway,
    TLS_CERT_PATH: join(profile, 'server.pem'),
    TLS_KEY_PATH: join(profile, 'server.key'),
    MAGNUS_AGENT_SELF_URL: 'https://' + gateway + ':' + agentPort,
    MAGNUS_AGENT_SELF_CA_PATH: join(profile, 'ca.pem'),
    MAGNUS_AGENT_PRIVILEGED: 'false',
    MAGNUS_AGENT_SELF_UPGRADE: 'false',
    ENABLE_AGENT_DISCOVERY: 'false',
    HERMES_HOME: join(profile, 'hermes'),
    RETAINED_PROVIDER_CREDENTIAL: 'obviously-fake-preserved-profile-credential',
  });
  const originalEnv = readFileSync(envFile),
    plan = 'a'.repeat(64),
    digest = 'b'.repeat(64);
  artifactServer = createTlsServer(
    { key: readFileSync(apiTls.key), cert: readFileSync(apiTls.cert) },
    (req, res) => {
      if (req.url !== '/agent.tar.gz') {
        res.statusCode = 404;
        res.end();
        return;
      }
      createReadStream(archive).pipe(res);
    },
  ).listen(0, '127.0.0.1');
  await new Promise((done) => artifactServer.once('listening', done));
  const selected = {
    id: 'native-magnus',
    host: 'control',
    runtime: 'magnus',
    version: metadata.version,
    profileDirectory: profile,
    environmentFile: envFile,
    service: 'none',
    authorized: true,
  };
  put('installation/installation.json', { installation: id, host: 'control', uuid: id });
  put('installation/transaction.json', { plan, operation: 'install', phase: 'ready' });
  put('installation/receipt.json', { plan, digest, version: '0.1.0' });
  put('installation/manifest.' + plan + '.json', {
    agentArtifacts: {
      magnus: {
        [metadata.version]: {
          [metadata.architecture]: {
            url: 'https://localhost:' + artifactServer.address().port + '/agent.tar.gz',
            sha256: metadata.sha256,
            executable: metadata.executable,
            arguments: metadata.arguments,
            preflight: metadata.preflight,
            acceptanceArguments: metadata.acceptanceArguments,
          },
        },
      },
    },
  });
  const payload = {
    directory: installation,
    installation: id,
    host: 'control',
    plan,
    digest,
    version: '0.1.0',
    operation: 'install',
    action: 'adapters-stage',
    agents: [selected],
    inference: [],
  };
  const code = ['adapters-host.sh', 'inference-registration.sh', 'host-runtime.sh']
    .map((file) => readFileSync(join(root, 'scripts/suite', file), 'utf8'))
    .join('\n');
  const environment = Object.fromEntries(
    ['PATH', 'HOME', 'LANG', 'LC_ALL', 'TZ']
      .filter((name) => process.env[name])
      .map((name) => [name, process.env[name]]),
  );
  environment.CURL_CA_BUNDLE = authority;
  environment.UNRELATED_INFRA_SECRET = 'obviously-fake-must-not-inherit';
  async function action(name) {
    const child = spawn('bash', ['-c', code], {
      env: environment,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let log = '';
    child.stdout.on('data', (chunk) => (log += chunk));
    child.stderr.on('data', (chunk) => (log += chunk));
    const finished = new Promise((done, reject) => {
      child.once('error', reject);
      child.once('close', done);
    });
    child.stdin.end(JSON.stringify({ ...payload, action: name }) + '\n');
    const status = await finished;
    put(name + '.log', log);
    assert.equal(status, 0, 'Native adapter failed; private log retained');
  }
  await action('adapters-stage');
  await action('adapters-stage');
  const log = put('native.log', ''),
    { openSync, closeSync } = await import('node:fs'),
    descriptor = openSync(log, 'a');
  native = spawn('bash', [join(installation, 'agents/native-magnus/run.' + plan)], {
    env: environment,
    stdio: ['ignore', descriptor, descriptor],
  });
  closeSync(descriptor);
  await action('agents-accept');
  const receipt = JSON.parse(
    readFileSync(join(installation, 'agents/native-magnus/receipt.json'), 'utf8'),
  );
  assert.equal(receipt.accepted, true);
  assert.equal(receipt.preflightPassed, true);
  assert.deepEqual(readFileSync(envFile), originalEnv);
  const processEnvironment = readFileSync('/proc/' + native.pid + '/environ', 'utf8').split('\0');
  assert(!processEnvironment.some((value) => value.startsWith('UNRELATED_INFRA_SECRET=')));
  assert(
    /Umask:\s+0077/.test(readFileSync('/proc/' + native.pid + '/status', 'utf8')),
    'Manual launcher must protect new profile state',
  );
  put('installation/compose.json', compose);
  const statusConfig = put('hive-installation.json', {
    schema: 1,
    installation: id,
    release: '0.1.0',
    profile: 'custom',
    origin: apiOrigin,
    hosts: {
      control: { target: 'local', directory: installation, architecture: metadata.architecture },
    },
    components: { api: { host: 'control' } },
    agents: [selected],
    inference: [],
  });
  const summary = run(join(root, 'hive.sh'), ['status', '--config', statusConfig], {
    env: environment,
  });
  put('status.json', summary);
  assert.equal(JSON.parse(summary).nativeAgents[0].accepted, true);
  for (const secret of Object.values(secrets)) assert(!summary.includes(secret));
  const nodes = await request('/api/v1/nodes');
  assert.equal(nodes.status, 200);
  const selectedNodes = nodes.body.data.filter(
    (node) => node.hostname === 'synthetic-agent.example.com',
  );
  assert.equal(selectedNodes.length, 1, 'Repeated startup must not enroll duplicate hosts');
  const node = selectedNodes[0];
  const dispatched = await request('/api/v1/commands', {
    nodeIds: [node.id],
    command: 'printf',
    args: ['synthetic-native-job-accepted'],
    workingDirectory: profile,
    timeoutSeconds: 15,
    riskLevel: 'low',
    idempotencyKey: id + '-read-only-job',
  });
  put('dispatch.json', dispatched);
  assert([200, 201, 202].includes(dispatched.status));
  const commandId = dispatched.body.data.commands[0].id,
    deadline = Date.now() + 60000;
  let completed;
  do {
    const result = await request('/api/v1/commands/' + encodeURIComponent(commandId));
    put('command-result.json', result);
    if (['COMPLETED', 'FAILED', 'UNKNOWN', 'CANCELLED'].includes(result.body.data?.status)) {
      completed = result;
      break;
    }
    await new Promise((done) => setTimeout(done, 500));
  } while (Date.now() < deadline);
  assert(completed, 'Native read-only command did not settle');
  assert.equal(completed.body.data.status, 'COMPLETED');
  assert(JSON.stringify(completed.body).includes('synthetic-native-job-accepted'));
  const duplicate = await request('/api/v1/commands', {
    nodeIds: [node.id],
    command: 'printf',
    args: ['synthetic-native-job-accepted'],
    workingDirectory: profile,
    timeoutSeconds: 15,
    riskLevel: 'low',
    idempotencyKey: id + '-read-only-job',
  });
  assert.equal(duplicate.status, 409);
  const retained = await request('/api/v1/commands?nodeId=' + encodeURIComponent(node.id));
  assert.equal(retained.body.data.length, 1, 'A repeated request must not create another dispatch');
  assert.deepEqual(readFileSync(envFile), originalEnv);
  put(
    'database.sql',
    dc('exec', '-T', 'postgres', 'pg_dump', '-U', 'synthetic', '-d', 'magnus_ideas_native'),
  );
  put('result.json', {
    schema: 1,
    result: 'passed',
    productionCutover: false,
    nativeAgentVersion: metadata.version,
    nodeVersion: metadata.nodeVersion,
    artifactSHA256: metadata.sha256,
    checks: [
      'packaged native runtime staged through the Bash adapter',
      'immutable artifact and protected environment preserved on retry',
      'authenticated agent health and recent accepted heartbeat',
      'one native enrollment',
      'real authenticated read-only command, durable result and duplicate dispatch refusal',
      'private launcher umask and no inherited installer credentials',
      'status exposes acceptance without infrastructure credentials',
      'existing profile credential bytes retained',
    ],
    limitations: [
      'single physical Linux AMD64 host',
      'native Magnus protocol; model-agent identities and provider logins are separate gates',
      'manual supervision selected for the disposable agent',
    ],
  });
  passed = true;
  console.log(
    'PASS: native packaged Magnus agent, verified TLS, real heartbeat and authenticated read-only command, stable profile credentials.',
  );
} catch (error) {
  try {
    put('containers.log', dc('logs', '--no-color'));
  } catch {}
  throw error;
} finally {
  if (native && native.exitCode === null) {
    native.kill('SIGTERM');
    await Promise.race([
      new Promise((done) => native.once('close', done)),
      new Promise((done) => setTimeout(done, 5000)),
    ]);
    if (native.exitCode === null) native.kill('SIGKILL');
  }
  if (artifactServer) {
    artifactServer.closeAllConnections();
    await new Promise((done) => artifactServer.close(done));
  }
  try {
    dc('down', '--remove-orphans');
  } catch {}
  if (!passed)
    console.error(
      'Private native proof retained at ' +
        output +
        '. Only generated fixture services and the disposable profile were selected.',
    );
}
