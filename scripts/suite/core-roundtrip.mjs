#!/usr/bin/env node
// Disposable developer proof of the real shell installer and product images.
// The registry is loopback-only and ephemeral; no public artifacts are published.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
  chmodSync,
  readdirSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { randomBytes, createHash } from 'node:crypto';
import { createServer } from 'node:net';
import { parseEnv } from 'node:util';
import https from 'node:https';
const root = resolve(import.meta.dirname, '../..');
const outputIndex = process.argv.indexOf('--output');
assert(
  outputIndex >= 0 && process.argv[outputIndex + 1],
  '--output NEW_PRIVATE_DIRECTORY is required',
);
const output = resolve(process.argv[outputIndex + 1]);
assert(!existsSync(output), 'Preserve existing evidence; select a new output directory');
mkdirSync(output, { mode: 0o700, recursive: true });
chmodSync(output, 0o700);
const put = (path, value) => {
  writeFileSync(path, typeof value === 'string' ? value : JSON.stringify(value, null, 2));
  chmodSync(path, 0o600);
};
const execute = (program, args, options = {}) =>
  execFileSync(program, args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    ...options,
  }).trim();
const docker = (...args) => execute('docker', args);
async function port() {
  const listener = createServer().listen(0, '127.0.0.1');
  await new Promise((done) => listener.once('listening', done));
  const value = listener.address().port;
  await new Promise((done) => listener.close(done));
  return value;
}
const id = 'core-proof-' + randomBytes(5).toString('hex'),
  owned = join(output, 'installation');
const registryName = id + '-registry',
  registryPort = await port(),
  consolePort = await port();
const registry = '127.0.0.1:' + registryPort;
const tags = [];
let passed = false;
const configFile = join(output, 'installation.json'),
  manifestFile = join(output, 'release.json');
const environment = Object.fromEntries(
  ['PATH', 'LANG', 'LC_ALL', 'TZ']
    .filter((name) => process.env[name])
    .map((name) => [name, process.env[name]]),
);
let config;
function hive(command, ...extra) {
  try {
    return execute(
      join(root, 'hive.sh'),
      [
        command,
        '--config',
        configFile,
        '--manifest',
        manifestFile,
        '--trust-key',
        join(output, 'publisher.pub'),
        '--non-interactive',
        '--yes',
        ...extra,
      ],
      { env: environment, maxBuffer: 8 * 1024 * 1024 },
    );
  } catch (error) {
    put(
      join(output, command + '-failure.log'),
      String(error.stdout || '') + '\n' + String(error.stderr || ''),
    );
    throw Error('Core installer ' + command + ' failed; private log retained');
  }
}
try {
  assert.notEqual(
    process.getuid(),
    0,
    'Run acceptance as an unprivileged operator with Docker access',
  );
  const registryImage =
    'registry@sha256:a3d8aaa63ed8681a604f1dea0aa03f100d5895b6a58ace528858a7b332415373';
  docker(
    'run',
    '-d',
    '--name',
    registryName,
    '--user',
    `${process.getuid()}:${process.getgid()}`,
    '--read-only',
    '--cap-drop',
    'ALL',
    '--security-opt',
    'no-new-privileges:true',
    '--tmpfs',
    `/var/lib/registry:uid=${process.getuid()},gid=${process.getgid()},mode=700`,
    '--publish',
    `127.0.0.1:${registryPort}:5000`,
    registryImage,
  );
  const images = {};
  for (const product of ['oathweave', 'emberpath', 'hivemem', 'hiveskills', 'hivexui']) {
    const tag = registry + '/' + id + '/' + product + ':candidate';
    tags.push(tag);
    docker('tag', product + ':candidate', tag);
    docker('push', tag);
    images[product] = JSON.parse(
      docker('image', 'inspect', tag, '--format', '{{json .RepoDigests}}'),
    ).find((value) => value.startsWith(registry + '/' + id + '/' + product + '@sha256:'));
    assert(images[product], 'Pushed candidate digest is missing');
  }
  const ingressTag = registry + '/' + id + '/ingress:candidate';
  tags.push(ingressTag);
  docker('tag', 'hive-ingress:candidate', ingressTag);
  docker('push', ingressTag);
  images.ingress = JSON.parse(
    docker('image', 'inspect', ingressTag, '--format', '{{json .RepoDigests}}'),
  ).find((value) => value.startsWith(registry + '/' + id + '/ingress@sha256:'));
  images['oathweave-redis'] =
    'redis@sha256:5fa2edb1e408fa8235e6db8fab01d1afaaae96c9403ba67b70feceb8661e8621';
  images['hivemem-qdrant'] =
    'qdrant/qdrant@sha256:45f8e3ddc2570a4d029877e1b5ec1045c19b3852b4e22a55c7f43b05aea0ca89';
  const user = `${process.getuid()}:${process.getgid()}`;
  const health = {
    test: ['CMD', 'node', '/app/healthcheck.mjs'],
    interval: '2s',
    timeout: '4s',
    start_period: '2s',
    retries: 30,
  };
  const app = (name, dependencies = {}) => ({
    image: images[name],
    storageFormat: name + '-candidate-v1',
    kind: 'application',
    service: {
      user,
      healthcheck: health,
      networks: [
        'default',
        ...(name === 'oathweave' ? ['identity-data'] : name === 'hivemem' ? ['memory-data'] : []),
      ],
      ...(Object.keys(dependencies).length ? { depends_on: dependencies } : {}),
    },
  });
  const manifest = {
    schema: 1,
    version: '0.1.0',
    profiles: { core: Object.keys(images).sort(), full: Object.keys(images).sort() },
    networks: {
      'identity-data': { driver: 'bridge', internal: true },
      'memory-data': { driver: 'bridge', internal: true },
    },
    components: {
      oathweave: {
        ...app('oathweave', { 'oathweave-redis': { condition: 'service_healthy' } }),
        requiresLocal: ['oathweave-redis'],
      },
      emberpath: app('emberpath'),
      hivemem: {
        ...app('hivemem', { 'hivemem-qdrant': { condition: 'service_healthy' } }),
        requiresLocal: ['hivemem-qdrant'],
      },
      hiveskills: app('hiveskills'),
      hivexui: {
        image: images.hivexui,
        kind: 'static-ui',
        service: {
          user: '101:101',
          healthcheck: {
            test: ['CMD', 'wget', '-q', '-O', '/dev/null', 'http://127.0.0.1:8080/'],
            interval: '2s',
            timeout: '3s',
            retries: 20,
          },
        },
      },
      ingress: {
        image: images.ingress,
        kind: 'ingress',
        requiresLocal: ['hivexui'],
        service: {
          user,
          command: ['caddy', 'run', '--config', '/config/Caddyfile', '--adapter', 'caddyfile'],
          healthcheck: {
            test: ['CMD', 'wget', '-q', '-O', '/dev/null', 'http://127.0.0.1:8081/ready'],
            interval: '2s',
            timeout: '3s',
            retries: 20,
          },
          depends_on: { hivexui: { condition: 'service_healthy' } },
        },
      },
      'oathweave-redis': {
        image: images['oathweave-redis'],
        kind: 'datastore',
        storageFormat: 'redis-aof-v1',
        service: {
          user,
          command: ['redis-server', '/config/redis.conf'],
          networks: ['identity-data'],
          healthcheck: {
            test: [
              'CMD-SHELL',
              'REDISCLI_AUTH="$(sed -n "s/^requirepass //p" /config/redis.conf)" redis-cli --no-auth-warning ping | grep -q PONG',
            ],
            interval: '2s',
            timeout: '3s',
            retries: 20,
          },
        },
      },
      'hivemem-qdrant': {
        image: images['hivemem-qdrant'],
        kind: 'datastore',
        storageFormat: 'qdrant-v1.18.1',
        service: {
          user,
          working_dir: '/data',
          entrypoint: ['/qdrant/qdrant'],
          command: ['--config-path', '/config/qdrant.yaml'],
          networks: ['memory-data'],
          healthcheck: {
            test: [
              'CMD',
              'bash',
              '-ec',
              'exec 3<>/dev/tcp/127.0.0.1/6333; printf \"GET /readyz HTTP/1.1\\r\\nHost: localhost\\r\\nConnection: close\\r\\n\\r\\n\" >&3; IFS= read -r status <&3; [[ \"$$status\" == *\" 200 \"* ]]',
            ],
            interval: '2s',
            timeout: '3s',
            retries: 20,
          },
        },
      },
    },
  };
  config = JSON.parse(readFileSync(join(root, 'examples/installation.json'), 'utf8'));
  config.installation = id;
  config.origin = 'https://localhost:' + consolePort;
  config.hosts.control.directory = owned;
  config.console.httpsPort = consolePort;
  config.console.runtimeFile = join(owned, 'config/runtime.json');
  for (const [name, placement] of Object.entries(config.components)) {
    if (placement.envFile) placement.envFile = join(owned, 'config', name + '.env');
    if (placement.configDirectory) placement.configDirectory = join(owned, 'config', name);
  }
  config.bootstrap.certificateFile = join(output, 'console.crt');
  config.bootstrap.privateKeyFile = join(output, 'console.key');
  config.bootstrap.adminEmail = 'alice@example.com';
  execute('openssl', [
    'req',
    '-x509',
    '-newkey',
    'rsa:2048',
    '-nodes',
    '-keyout',
    config.bootstrap.privateKeyFile,
    '-out',
    config.bootstrap.certificateFile,
    '-subj',
    '/CN=localhost',
    '-addext',
    'subjectAltName=DNS:localhost',
    '-days',
    '2',
  ]);
  chmodSync(config.bootstrap.privateKeyFile, 0o600);
  execute('openssl', ['genpkey', '-algorithm', 'ED25519', '-out', join(output, 'publisher.key')]);
  execute('openssl', [
    'pkey',
    '-in',
    join(output, 'publisher.key'),
    '-pubout',
    '-out',
    join(output, 'publisher.pub'),
  ]);
  if (!process.argv.includes('--interactive')) put(configFile, config);
  put(manifestFile, manifest);
  execute('openssl', [
    'pkeyutl',
    '-sign',
    '-inkey',
    join(output, 'publisher.key'),
    '-rawin',
    '-in',
    manifestFile,
    '-out',
    manifestFile + '.sig',
  ]);
  if (process.argv.includes('--interactive')) {
    const questions = [
      ['Installation name', id],
      ['Installation directory on the selected host', owned],
      ['Host SSH target', 'local'],
      ['Host architecture', process.arch === 'arm64' ? 'arm64' : 'amd64'],
      ['Console HTTPS origin', config.origin],
      ['Product profile', 'core'],
      ['HTTPS bind address', '127.0.0.1'],
      ['HTTPS listener port', String(consolePort)],
      ['Configuration mode', 'fresh'],
      ['Initial operator username', 'admin'],
      ['Initial operator email', 'alice@example.com'],
      ['Existing console certificate file', config.bootstrap.certificateFile],
      ['Protected console private key file', config.bootstrap.privateKeyFile],
      ['Existing external inference HTTPS endpoint', ''],
      ['Opt-in native agent runtime', ''],
      ['Write protected installation configuration to', configFile],
      ['Apply this exact installation plan', 'y'],
    ];
    const review = join(output, 'interactive-input.json');
    put(review, {
      command: [
        join(root, 'hive.sh'),
        '--release',
        '0.1.0',
        '--manifest',
        manifestFile,
        '--trust-key',
        join(output, 'publisher.pub'),
      ],
      questions,
      transcriptFile: join(output, 'interactive-install.log'),
      timeoutSeconds: 600,
    });
    execute('python3', [join(root, 'scripts/suite/interactive-driver.py'), review], {
      env: environment,
    });
    config = JSON.parse(readFileSync(configFile, 'utf8'));
  } else {
    put(join(output, 'plan.log'), hive('plan'));
    put(join(output, 'install.log'), hive('install'));
  }
  const firstCredentials = readFileSync(join(owned, 'config/initial-credentials.env'));
  const identities = ['identity-id', 'model-id', 'memory-id'].map((name) =>
    readFileSync(join(owned, 'config/.initializer/secrets', name), 'utf8'),
  );
  put(join(output, 'repeat-install.log'), hive('install'));
  assert.deepEqual(readFileSync(join(owned, 'config/initial-credentials.env')), firstCredentials);
  assert.deepEqual(
    ['identity-id', 'model-id', 'memory-id'].map((name) =>
      readFileSync(join(owned, 'config/.initializer/secrets', name), 'utf8'),
    ),
    identities,
  );
  const ca = readFileSync(config.bootstrap.certificateFile);
  async function request(path, body, headers = {}) {
    return new Promise((resolve, reject) => {
      const req = https.request(
        {
          hostname: 'localhost',
          port: consolePort,
          path,
          method: body ? 'POST' : 'GET',
          ca,
          headers: { 'Content-Type': 'application/json', ...headers },
          timeout: 5000,
        },
        (res) => {
          let raw = '';
          res.on('data', (chunk) => (raw += chunk));
          res.on('end', () =>
            resolve({
              status: res.statusCode,
              headers: res.headers,
              body: raw ? JSON.parse(raw) : null,
            }),
          );
        },
      );
      req.on('error', reject);
      req.on('timeout', () => req.destroy(Error('Core API request timeout')));
      if (body) req.write(JSON.stringify(body));
      req.end();
    });
  }
  const credentials = parseEnv(firstCredentials.toString());
  const browserHeaders = { Origin: config.origin, 'X-Oathweave-Browser': 'true' };
  const login = await request(
    '/api/oathweave/auth/login',
    { username: credentials.SEED_ADMIN_USERNAME, password: credentials.SEED_ADMIN_PASSWORD },
    browserHeaders,
  );
  assert.equal(login.status, 200);
  assert(!login.body.accessToken && !login.body.refreshToken);
  const cookie = login.headers['set-cookie']
    .find((value) => value.startsWith('__Host-oathweave_sso='))
    .split(';')[0];
  const headers = { ...browserHeaders, Cookie: cookie };
  const tokens = {};
  for (const product of ['oathweave', 'emberpath', 'hivemem', 'hiveskills']) {
    const verifier = randomBytes(32).toString('base64url'),
      state = randomBytes(32).toString('base64url'),
      nonce = randomBytes(32).toString('base64url');
    const code = await request(
      '/api/oathweave/oauth/authorize',
      {
        clientId: 'hivexui-' + product,
        redirectUri: config.origin + '/auth/callback',
        responseType: 'code',
        codeChallenge: createHash('sha256').update(verifier).digest('base64url'),
        codeChallengeMethod: 'S256',
        scope: 'openid profile',
        state,
        nonce,
      },
      headers,
    );
    assert.equal(code.status, 200, 'Fresh public client authorization failed: ' + product);
    assert.equal(code.body.state, state);
    assert.equal(code.body.iss, config.origin + '/api/oathweave');
    const token = await request(
      '/api/oathweave/oauth/token',
      {
        grant_type: 'authorization_code',
        client_id: 'hivexui-' + product,
        code: code.body.code,
        code_verifier: verifier,
        redirect_uri: config.origin + '/auth/callback',
      },
      headers,
    );
    assert.equal(token.status, 200);
    tokens[product] = token.body.access_token;
    const payload = JSON.parse(Buffer.from(tokens[product].split('.')[1], 'base64url'));
    assert.equal(payload.aud, product);
    assert.equal(payload.sub, identities[0].trim());
  }
  const routes = {
    oathweave: '/api/oathweave/auth/me',
    emberpath: '/api/emberpath/auth/me',
    hivemem: '/api/hivemem/agents',
    hiveskills: '/api/hiveskills/admin/skills',
  };
  for (const [product, path] of Object.entries(routes)) {
    const result = await request(path, null, { Authorization: 'Bearer ' + tokens[product] });
    assert.equal(result.status, 200, 'Fresh receiving product authorization failed: ' + product);
    if (product === 'emberpath') assert.equal(result.body.user.id, identities[1].trim());
  }
  assert.equal(
    (await request(routes.emberpath, null, { Authorization: 'Bearer ' + tokens.oathweave })).status,
    401,
  );
  assert.equal((await request('/api/oathweave/browser/logout', {}, headers)).status, 200);
  for (const [product, path] of Object.entries(routes))
    assert.equal(
      (await request(path, null, { Authorization: 'Bearer ' + tokens[product] })).status,
      401,
      'Revoked session remained usable: ' + product,
    );
  put(join(output, 'backup.log'), hive('backup', '--archive', 'core-proof'));
  put(join(output, 'rehearse.log'), hive('rehearse', '--archive', 'core-proof'));
  const rehearsal = JSON.parse(
    readFileSync(join(owned, 'rehearsals/core-proof/result.json'), 'utf8'),
  );
  assert.equal(rehearsal.result, 'passed');
  const compose = JSON.parse(readFileSync(join(owned, 'compose.json'), 'utf8'));
  assert.deepEqual(
    Object.entries(compose.services)
      .filter(([, value]) => value.ports)
      .map(([name]) => name),
    ['ingress'],
  );
  for (const [name, service] of Object.entries(compose.services)) {
    assert.notEqual(service.user.split(':')[0], '0');
    assert.equal(service.read_only, true);
    assert.deepEqual(service.cap_drop, ['ALL']);
    if (['oathweave', 'emberpath', 'hivemem', 'hiveskills'].includes(name))
      assert.equal(parseEnv(readFileSync(service.env_file[0], 'utf8')).HIVE_AUTO_MIGRATE, 'false');
  }
  put(join(output, 'result.json'), {
    schema: 1,
    result: 'passed',
    productionCutover: false,
    checks: [
      process.argv.includes('--interactive')
        ? 'fresh interactive core install'
        : 'fresh unattended core install',
      'repeat install preserves credentials and identities',
      'one sign-in reaches four product APIs',
      'wrong-audience rejection',
      'online logout revocation at every receiving API',
      'only ingress publishes a port',
      'non-root read-only product services',
      'automatic migrations disabled after first initialization',
      'installation-bound backup',
      'isolated restore rehearsal',
    ],
    images,
  });
  passed = true;
  console.log(
    'PASS: fresh core shell installation, repeat execution, four-product SSO, wrong-audience/revocation denial, private datastores and isolated restore rehearsal.',
  );
} catch (error) {
  if (existsSync(join(owned, 'rehearsals/core-proof/isolated.json')))
    try {
      put(
        join(output, 'rehearsal.container.log'),
        docker(
          'compose',
          '-f',
          join(owned, 'rehearsals/core-proof/isolated.json'),
          'logs',
          '--no-color',
        ),
      );
    } catch {}
  if (existsSync(owned))
    for (const name of readdirSync(owned).filter(
      (name) => /^bootstrap\..*\.compose\.json$/.test(name) || name === 'compose.json',
    ))
      try {
        put(
          join(output, name + '.container.log'),
          docker('compose', '-f', join(owned, name), 'logs', '--no-color'),
        );
      } catch {}
  console.error('Private core proof retained at ' + output);
  throw error;
} finally {
  for (const file of [
    join(owned, 'rehearsals/core-proof/isolated.json'),
    ...(existsSync(owned)
      ? readdirSync(owned)
          .filter((name) => /^bootstrap\..*\.compose\.json$/.test(name))
          .map((name) => join(owned, name))
      : []),
  ])
    if (existsSync(file)) {
      try {
        docker('compose', '-f', file, 'down', '--remove-orphans');
      } catch {}
    }
  if (config && existsSync(join(owned, 'compose.json'))) {
    try {
      docker('compose', '-f', join(owned, 'compose.json'), 'down', '--remove-orphans');
    } catch {}
  }
  if (config && existsSync(owned)) {
    const containers = docker(
      'ps',
      '-aq',
      '--filter',
      'label=com.docker.compose.project=' + id + '-control',
    )
      .split(/\s+/)
      .filter(Boolean);
    for (const name of containers) {
      try {
        docker('rm', '-f', name);
      } catch {}
    }
  }
  try {
    docker('rm', '-f', registryName);
  } catch {}
  for (const tag of tags) {
    try {
      docker('image', 'rm', tag);
    } catch {}
  }
  if (!passed) console.error('Existing installation and model resources were not selected.');
}
