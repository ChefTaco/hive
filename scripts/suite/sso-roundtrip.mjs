#!/usr/bin/env node
// Development acceptance only. The shell installation controller does not use Node.
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import {
  writeFileSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  openSync,
  closeSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { createServer } from 'node:net';
import https from 'node:https';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { randomBytes, createHash } from 'node:crypto';
import { identityBrowserReview } from './identity-browser-review.mjs';

const sources = resolve(
  process.env.HIVE_SUITE_SOURCES || fileURLToPath(new URL('../../..', import.meta.url)),
);
const identityRoot = join(sources, 'Oathweave/apps/iam-core');
const routerRoot = join(sources, 'Emberpath');
const reviewIndex = process.argv.indexOf('--browser-review');
const review =
  reviewIndex < 0
    ? null
    : {
        directory: resolve(process.argv[reviewIndex + 1]),
        port: 5299,
        origin: 'https://localhost:5299',
        seconds: 1800,
      };
if (review) {
  assert(process.argv.includes('--containers'), 'Browser review requires disposable containers');
  mkdirSync(review.directory, { mode: 0o700 });
}
const temporary = review?.directory ?? mkdtempSync(join(tmpdir(), 'hive-sso-acceptance-'));
const children = [];
const containerMode = process.argv.includes('--containers');
const network = 'hive-sso-test-' + randomBytes(5).toString('hex');
const testContainers = [];
const identityDataNetwork = network + '-identity-data';
const docker = (...args) =>
  execFileSync('docker', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const acceptanceEnvironment = Object.fromEntries(
  ['PATH', 'LANG', 'LC_ALL', 'TZ']
    .filter((name) => process.env[name])
    .map((name) => [name, process.env[name]]),
);
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function port() {
  const server = createServer().listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const result = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return result;
}
async function stop(child) {
  if (child.exitCode !== null) return;
  child.kill('SIGTERM');
  await Promise.race([new Promise((resolve) => child.once('exit', resolve)), delay(5000)]);
  if (child.exitCode === null) child.kill('SIGKILL');
}
function launch(command, args, env, name) {
  if (containerMode) {
    const identifier = network + '-' + name;
    testContainers.push(identifier);
    const user = name === 'redis' ? '999:999' : `${process.getuid()}:${process.getgid()}`;
    const options = [
      'create',
      '--init',
      '--name',
      identifier,
      '--network',
      name === 'redis' ? identityDataNetwork : network,
      '--network-alias',
      name,
      '--user',
      user,
      '--read-only',
      '--cap-drop',
      'ALL',
      '--security-opt',
      'no-new-privileges',
      '--tmpfs',
      '/tmp:mode=1777',
    ];
    if (name === 'redis') {
      command = 'docker';
      args = [
        ...options,
        '--tmpfs',
        '/data:uid=999,gid=999,mode=700',
        'redis:8.10.3-alpine@sha256:21090af93f8324db2f0f0f4f38a7c60369d47d917e000c3423d89d2ae2883537',
        'redis-server',
        ...args,
      ];
      args[args.indexOf('--bind') + 1] = '0.0.0.0';
    } else {
      const data = join(temporary, name === 'identity' ? 'identity' : 'router');
      options.push('-v', data + ':' + data);
      for (const file of new Set([env.TLS_CERT_PATH, env.TLS_KEY_PATH]))
        options.push('-v', file + ':' + file + ':ro');
      const ports = name === 'identity' ? [env.PORT] : [env.API_PORT, env.ADMIN_PORT];
      for (const port of ports) options.push('-p', `127.0.0.1:${port}:${port}`);
      const values = {
        ...env,
        HOST: '0.0.0.0',
        HIVE_HEALTH_URL: `https://localhost:${name === 'identity' ? env.PORT : env.API_PORT}${name === 'identity' ? '/api/v1/health/ready' : '/health/ready'}`,
      };
      if (name === 'router')
        for (const key of ['OATHWEAVE_JWKS_URL', 'OATHWEAVE_USERINFO_URL'])
          values[key] = values[key].replace('https://localhost:', 'https://identity:');
      const envFile = join(temporary, name + '.env');
      for (const value of Object.values(values))
        assert(!/[\r\n]/.test(value), 'Unexpected multiline environment value');
      writeFileSync(
        envFile,
        Object.entries(values)
          .filter(([key]) => !Object.hasOwn(acceptanceEnvironment, key))
          .map(([key, value]) => key + '=' + value)
          .join('\n') + '\n',
        { mode: 0o600 },
      );
      options.push('--env-file', envFile);
      command = 'docker';
      args = [
        ...options,
        name === 'identity' ? 'oathweave:candidate' : 'emberpath:candidate',
        'start',
      ];
    }
    docker(...args);
    if (name === 'identity') docker('network', 'connect', identityDataNetwork, identifier);
    args = ['start', '--attach', identifier];
    env = acceptanceEnvironment;
  }
  const fd = openSync(join(temporary, name + '.log'), 'a', 0o600);
  const child = spawn(command, args, { env, cwd: temporary, stdio: ['ignore', fd, fd] });
  closeSync(fd);
  children.push(child);
  return child;
}
try {
  if (containerMode) {
    assert(process.getuid() > 0, 'Container acceptance must run as an unprivileged operator');
    docker('network', 'create', network);
    docker('network', 'create', '--internal', identityDataNetwork);
  }
  const identityPort = await port(),
    redisPort = await port();
  const origin = `https://localhost:${identityPort}`;
  const cert = join(temporary, 'server.crt'),
    key = join(temporary, 'server.key');
  execFileSync(
    'openssl',
    [
      'req',
      '-x509',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-days',
      '1',
      '-subj',
      '/CN=localhost',
      '-addext',
      'subjectAltName=DNS:localhost,DNS:identity,IP:127.0.0.1',
      '-keyout',
      key,
      '-out',
      cert,
    ],
    { stdio: 'ignore' },
  );
  const ca = readFileSync(cert);
  const request = (input, init = {}) =>
    new Promise((resolve, reject) => {
      const req = https.request(
        new URL(String(input)),
        {
          method: init.method || 'GET',
          headers: Object.fromEntries(new Headers(init.headers)),
          ca,
          signal: init.signal,
          timeout: 5000,
        },
        (response) => {
          const parts = [];
          response.on('data', (chunk) => parts.push(chunk));
          response.on('end', () => {
            const headers = new Headers();
            for (const [name, value] of Object.entries(response.headers))
              if (value)
                for (const entry of Array.isArray(value) ? value : [value])
                  headers.append(name, entry);
            resolve(new Response(Buffer.concat(parts), { status: response.statusCode, headers }));
          });
        },
      );
      req.on('error', reject);
      req.on('timeout', () => req.destroy(new Error('Acceptance request timed out')));
      if (init.body) req.write(init.body);
      req.end();
    });
  launch(
    'redis-server',
    ['--bind', '127.0.0.1', '--port', String(redisPort), '--save', '', '--appendonly', 'no'],
    acceptanceEnvironment,
    'redis',
  );
  const password = randomBytes(24).toString('base64url');
  const env = {
    ...acceptanceEnvironment,
    NODE_ENV: 'production',
    HOST: '127.0.0.1',
    PORT: String(identityPort),
    HIVE_HOME: join(temporary, 'identity'),
    IAM_DATA_DIR: join(temporary, 'identity/iam'),
    REDIS_URL: `redis://${containerMode ? 'redis' : '127.0.0.1'}:${redisPort}`,
    JWT_ISSUER: 'legacy-native-issuer',
    IAM_BROWSER_ISSUER: origin,
    COOKIE_SECRET: randomBytes(32).toString('hex'),
    IAM_AGENT_SECRET: randomBytes(32).toString('hex'),
    ...(review ? { RATE_LIMIT_MAX_ATTEMPTS: '50' } : {}),
    SEED_ADMIN_USERNAME: 'admin',
    SEED_ADMIN_EMAIL: 'alice@example.com',
    SEED_ADMIN_PASSWORD: password,
    SEED_HIVE_ROUTER_CLIENT_SECRET: randomBytes(32).toString('hex'),
    SEED_HIVE_CLIENT_SECRET: randomBytes(32).toString('hex'),
    TLS_CERT_PATH: cert,
    TLS_KEY_PATH: key,
    CORS_ORIGIN: 'https://console.example.com' + (review ? ',' + review.origin : ''),
    ...(review
      ? {
          WEBAUTHN_RP_ID: 'localhost',
          WEBAUTHN_RP_ORIGIN: review.origin,
          IAM_RECOVERY_OUTBOX_DIRECTORY: join(temporary, 'identity', 'recovery-outbox'),
        }
      : {}),
    NODE_EXTRA_CA_CERTS: cert,
    HIVE_AUTO_MIGRATE: 'true',
    HIVE_AUTO_UPGRADE: 'false',
    HIVE_UPDATE_CHECK: 'false',
    HIVE_MANAGED_PROJECT: '',
    IAM_BROWSER_CLIENT_POLICIES: JSON.stringify({
      'hivexui-emberpath': { audience: 'emberpath', permissions: ['router:providers:read', 'router:testing:read'] },
      ...(review
        ? {
            'hivexui-browser-emberpath': {
              audience: 'emberpath',
              permissions: ['router:providers:read', 'router:testing:read'],
            },
            'hivexui-browser-oathweave': {
              audience: 'oathweave',
              permissions: [
                'iam:users:read',
                'iam:roles:read',
                'iam:clients:read',
                'iam:sessions:revoke',
                'iam:audit:read',
                'iam:policy:write',
              ],
            },
          }
        : {}),
    }),
  };
  // Do not inherit any operator database or signing-key overrides.
  for (const name of [
    'DATABASE_URL',
    'JWT_PRIVATE_KEY_PATH',
    'JWT_PUBLIC_KEY_PATH',
    'JWT_PREVIOUS_PUBLIC_KEY_PATHS',
    'HIVE_UPGRADE_TRANSACTION',
  ])
    delete env[name];
  mkdirSync(env.IAM_DATA_DIR, { recursive: true, mode: 0o700 });
  const server = launch(
    process.execPath,
    [join(identityRoot, 'dist/cli.js'), 'start'],
    env,
    'identity',
  );
  let ready = false;
  let readinessFailure;
  for (let attempt = 0; attempt < 100; attempt++) {
    if (server.exitCode !== null) break;
    try {
      if ((await request(origin + '/api/v1/health/ready')).ok) {
        ready = true;
        break;
      }
    } catch (error) {
      readinessFailure = error.code ?? error.message;
    }
    await delay(100);
  }
  assert(ready, 'Isolated identity service did not become ready: ' + readinessFailure);
  const require = createRequire(join(identityRoot, 'package.json'));
  const Database = require('better-sqlite3');
  const db = new Database(join(env.IAM_DATA_DIR, 'iam.db'));
  // Identity administrator roles do not implicitly confer product permissions.
  // Give this disposable account one explicit product permission for acceptance.
  db.prepare(
    'INSERT INTO roles (id,name,label,isSystem,permissions,createdAt,updatedAt) VALUES (?,?,?,0,?,?,?)',
  ).run(
    'fake-routing-reader',
    'FAKE_ROUTING_READER',
    'Synthetic routing reader',
    JSON.stringify(['router:providers:read', 'router:testing:read']),
    Date.now(),
    Date.now(),
  );
  const user = db.prepare('SELECT id FROM users WHERE username=?').get('admin');
  db.prepare('INSERT INTO user_role_assignments (userId,roleId,grantedAt) VALUES (?,?,?)').run(
    user.id,
    'fake-routing-reader',
    Date.now(),
  );
  db.close();
  const headers = {
    'Content-Type': 'application/json',
    Origin: 'https://console.example.com',
    'X-Oathweave-Browser': 'true',
  };
  const login = await request(origin + '/api/v1/auth/login', {
    method: 'POST',
    headers,
    body: JSON.stringify({ username: 'admin', password }),
  });
  assert.equal(login.status, 200, 'Browser login failed');
  const loginBody = await login.json();
  assert(!('refreshToken' in loginBody), 'Browser received a refresh token');
  assert(!('accessToken' in loginBody), 'Browser received an unscoped native access token');
  const nativeLogin = await request(origin + '/api/v1/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password }),
  });
  assert.equal(nativeLogin.status, 200);
  const nativeIdentity = await nativeLogin.json();
  assert.equal(typeof nativeIdentity.accessToken, 'string');
  const registered = await request(origin + '/api/v1/clients', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: 'Bearer ' + nativeIdentity.accessToken,
    },
    body: JSON.stringify({
      name: 'hivexui-emberpath',
      clientType: 'public',
      firstParty: true,
      redirectUris: ['https://console.example.com/auth/callback'],
      grantTypes: ['authorization_code'],
    }),
  });
  assert.equal(registered.status, 201, 'Authorized public client registration failed');
  assert.equal(
    (await registered.json()).client.id,
    'hivexui-emberpath',
    'Registered browser policy identifier changed',
  );

  const cookie = login.headers.get('set-cookie').split(';')[0];
  assert(cookie.startsWith('__Host-oathweave_sso='));
  const verifier = randomBytes(32).toString('base64url'),
    state = randomBytes(32).toString('base64url'),
    nonce = randomBytes(32).toString('base64url');
  const authorize = await request(origin + '/api/v1/oauth/authorize', {
    method: 'POST',
    headers: { ...headers, Cookie: cookie },
    body: JSON.stringify({
      clientId: 'hivexui-emberpath',
      redirectUri: 'https://console.example.com/auth/callback',
      responseType: 'code',
      codeChallenge: createHash('sha256').update(verifier).digest('base64url'),
      codeChallengeMethod: 'S256',
      scope: 'openid profile',
      state,
      nonce,
    }),
  });
  assert.equal(authorize.status, 200, 'Authorization request failed');
  const authorization = await authorize.json();
  assert.equal(authorization.state, state);
  assert.equal(authorization.iss, origin);
  const exchange = () =>
    request(origin + '/api/v1/oauth/token', {
      method: 'POST',
      headers,
      body: JSON.stringify({
        grant_type: 'authorization_code',
        client_id: 'hivexui-emberpath',
        redirect_uri: 'https://console.example.com/auth/callback',
        code: authorization.code,
        code_verifier: verifier,
      }),
    });
  const tokenResponse = await exchange();
  assert.equal(tokenResponse.status, 200, 'PKCE exchange failed');
  const token = await tokenResponse.json();
  assert(!('refresh_token' in token));
  assert.equal((await exchange()).status, 400, 'Authorization code was replayable');
  const { createOathweaveVerifier } = await import(
    pathToFileURL(join(routerRoot, 'dist/src/security/oathweave.js'))
  );
  const verify = createOathweaveVerifier(
    {
      issuer: origin,
      jwksUrl: origin + '/api/v1/oauth/jwks',
      userinfoUrl: origin + '/api/v1/oauth/userinfo',
      audience: 'emberpath',
    },
    { fetch: request },
  );
  const principal = await verify(token.access_token);
  assert.deepEqual(principal.permissions, ['router:providers:read', 'router:testing:read']);
  // Run the actual receiving API against its own fresh datastore. The reviewed
  // issuer/subject binding must retain this product ID without role promotion.
  const apiPort = await port(),
    adminPort = await port();
  const adminOrigin = `https://localhost:${adminPort}`;
  const localUserId = 'fake-existing-product-id';
  const routerData = join(temporary, 'router');
  mkdirSync(routerData, { mode: 0o700 });
  const routerEnv = {
    ...acceptanceEnvironment,
    NODE_ENV: 'production',
    HOST: '127.0.0.1',
    API_PORT: String(apiPort),
    ADMIN_PORT: String(adminPort),
    PUBLIC_API_URL: `https://localhost:${apiPort}`,
    PUBLIC_ADMIN_URL: adminOrigin,
    DATABASE_URL: 'file:' + join(routerData, 'router.db'),
    HIVE_HOME: join(routerData, 'home'),
    HIVE_ROUTER_SECRET: randomBytes(32).toString('hex'),
    HIVE_ROUTER_AUTH_MODE: 'os',
    HIVE_ROUTER_ADMIN_USERS: '',
    TLS_CERT_PATH: cert,
    TLS_KEY_PATH: key,
    NODE_EXTRA_CA_CERTS: cert,
    HIVE_AUTO_MIGRATE: 'true',
    HIVE_AUTO_UPGRADE: 'false',
    HIVE_UPDATE_CHECK: 'false',
    HIVE_MANAGED_PROJECT: '',
    OATHWEAVE_ISSUER: origin,
    OATHWEAVE_JWKS_URL: origin + '/api/v1/oauth/jwks',
    OATHWEAVE_USERINFO_URL: origin + '/api/v1/oauth/userinfo',
    EMBERPATH_OATHWEAVE_IDENTITIES_JSON: JSON.stringify([
      { issuer: origin, subject: user.id, localId: localUserId },
    ]),
  };
  const router = launch(
    process.execPath,
    [join(routerRoot, 'dist/src/index.js'), 'start'],
    routerEnv,
    'router',
  );
  ready = false;
  for (let attempt = 0; attempt < 100; attempt++) {
    if (router.exitCode !== null) break;
    try {
      if ((await request(adminOrigin + '/health/ready')).ok) {
        ready = true;
        break;
      }
    } catch {}
    await delay(100);
  }
  assert(ready, 'Isolated model administration API did not become ready');
  const routerDb = new Database(join(routerData, 'router.db'));
  routerDb
    .prepare(
      'INSERT INTO AdminUser (id,username,displayName,passwordHash,createdAt,updatedAt) VALUES (?,?,?,?,?,?)',
    )
    .run(
      localUserId,
      'synthetic-existing-operator',
      'Synthetic existing operator',
      '!externally-managed',
      Date.now(),
      Date.now(),
    );
  routerDb.close();
  const resourceHeaders = {
    Authorization: `Bearer ${token.access_token}`,
    'Content-Type': 'application/json',
  };
  const session = await request(adminOrigin + '/api/auth/me', { headers: resourceHeaders });
  assert.equal(session.status, 200);
  const resourceUser = (await session.json()).user;
  assert.equal(resourceUser.id, localUserId);
  assert.deepEqual(resourceUser.permissions, ['router:providers:read', 'router:testing:read']);
  assert.equal(
    (await request(adminOrigin + '/api/providers', { headers: resourceHeaders })).status,
    200,
  );
  assert.equal(
    (
      await request(adminOrigin + '/api/providers', {
        method: 'POST',
        headers: resourceHeaders,
        body: '{}',
      })
    ).status,
    403,
    'Reader mutated the resource API',
  );
  for (const path of ['/api/testing/run', '/api/testing/run/']) {
    const result = await request(adminOrigin + path, { method: 'POST', headers: resourceHeaders, body: '{}' });
    assert.equal(result.status, 403, 'Testing reader executed inference');
  }
  const preview = await request(adminOrigin + '/api/testing/preview', { method: 'POST', headers: resourceHeaders, body: '{}' });
  assert.equal(preview.status, 400, 'Testing reader must reach preview validation without write permission');
  assert.equal(
    (
      await request(adminOrigin + '/api/providers', {
        headers: { Authorization: `Bearer ${nativeIdentity.accessToken}` },
      })
    ).status,
    401,
    'A native identity token reached a product API',
  );
  assert.equal(
    (
      await request(origin + '/api/v1/browser/logout', {
        method: 'POST',
        headers: { ...headers, Cookie: cookie },
        body: '{}',
      })
    ).status,
    200,
  );
  await assert.rejects(
    verify(token.access_token),
    undefined,
    'A revoked browser session remained usable',
  );
  assert.equal(
    (await request(adminOrigin + '/api/providers', { headers: resourceHeaders })).status,
    401,
    'Resource API accepted a revoked SSO session',
  );
  console.log(
    (containerMode ? 'Containers: ' : 'Native: ') +
      'PASS: isolated Oathweave login, SSO cookie, PKCE, one-use code, resource HTTP authorization, preserved local ID, mutation denial and online revocation (verified TLS).',
  );
  if (review)
    await identityBrowserReview({
      review,
      temporary,
      origin,
      identityPort,
      adminPort,
      network,
      docker,
      containers: testContainers,
      request,
      nativeToken: nativeIdentity.accessToken,
      password,
      cert,
      key,
    });
} catch (error) {
  if (containerMode)
    for (const identifier of testContainers) {
      try {
        writeFileSync(join(temporary, identifier + '.json'), docker('inspect', identifier), {
          mode: 0o600,
        });
      } catch {}
    }
  console.error('SSO acceptance failed:', error.message);
  console.error('Private disposable evidence directory retained:', temporary);
  process.exitCode = 1;
} finally {
  for (const child of children.reverse()) await stop(child);
  for (const identifier of testContainers.reverse()) {
    try {
      docker('rm', '-f', identifier);
    } catch {}
  }
  if (containerMode) {
    try {
      docker('network', 'rm', network, identityDataNetwork);
    } catch {}
  }
  if (!process.exitCode && !review) rmSync(temporary, { recursive: true, force: true });
}
