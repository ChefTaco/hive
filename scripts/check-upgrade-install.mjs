#!/usr/bin/env node
// Exercise a real public npm installation, a packed candidate, and native stores.
// All state is synthetic and isolated. This never reads repository .env files.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createServer } from 'node:net';
import { parseEnv } from 'node:util';
import { randomUUID, createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { request as httpsRequest } from 'node:https';
import { createServer as createHttpServer } from 'node:http';
import { randomBytes, scryptSync } from 'node:crypto';

const root = resolve(import.meta.dirname, '..'),
  work = mkdtempSync(join(tmpdir(), 'hive-upgrade-drill-')),
  home = join(work, 'home'),
  packs = join(work, 'packs'),
  project = `hive-upgrade-${randomUUID().slice(0, 8)}`;
const keep = process.env.HIVE_UPGRADE_DRILL_KEEP === 'true';
const env = {
  PATH: process.env.PATH,
  HOME: work,
  HIVE_HOME: home,
  NODE_EXTRA_CA_CERTS: join(home, 'tls/ca.crt'),
  ...(process.env.DOCKER_CONFIG ? { DOCKER_CONFIG: process.env.DOCKER_CONFIG } : {}),
};
let baseline;
let modelProvider;
const require = createRequire(import.meta.url);
async function run(cmd, args, options = {}) {
  return new Promise((yes, no) => {
    const child = spawn(cmd, args, {
      cwd: root,
      env: { ...process.env, ...options.env },
      stdio: ['ignore', 'pipe', 'pipe'],
      ...options,
    });
    let out = '',
      err = '';
    child.stdout.on('data', (c) => {
      out += c;
    });
    child.stderr.on('data', (c) => {
      err += c;
    });
    child.once('error', no);
    child.once('close', (code) =>
      code === 0
        ? yes(out)
        : no(new Error(`${cmd} ${args.join(' ')} failed (${code})\n${err}\n${out}`)),
    );
  });
}
async function port() {
  const s = createServer();
  await new Promise((r) => s.listen(0, '127.0.0.1', r));
  const p = s.address().port;
  await new Promise((r) => s.close(r));
  return p;
}
async function wait(cli) {
  for (let n = 0; n < 120; n++) {
    try {
      const status = JSON.parse(await run(process.execPath, [cli, 'status', '--json'], { env }));
      if (status.ok) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error('Synthetic stack did not become ready');
}
const digest = (file) => createHash('sha256').update(readFileSync(file)).digest('hex');
async function request(url, options = {}) {
  return new Promise((yes, no) => {
    const req = httpsRequest(
      url,
      {
        method: options.method || 'GET',
        ca: readFileSync(join(home, 'tls/ca.crt')),
        headers: Object.fromEntries(new Headers(options.headers).entries()),
        timeout: 10000,
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.once('end', () =>
          yes(
            new Response(res.statusCode === 204 ? null : Buffer.concat(chunks), {
              status: res.statusCode,
              headers: res.headers,
            }),
          ),
        );
      },
    );
    req.once('error', no);
    req.once('timeout', () => req.destroy(new Error('Synthetic API request timed out')));
    req.end(options.body);
  });
}
try {
  mkdirSync(packs);
  const qp = await port(),
    rp = await port();
  await run('docker', [
    'run',
    '-d',
    '--name',
    `${project}-qdrant`,
    '-p',
    `127.0.0.1:${qp}:6333`,
    'qdrant/qdrant:v1.18.1',
  ]);
  await run('docker', [
    'run',
    '-d',
    '--name',
    `${project}-redis`,
    '-p',
    `127.0.0.1:${rp}:6379`,
    'redis:7.4.7-alpine',
  ]);
  for (let n = 0; n < 60; n++) {
    try {
      if ((await fetch(`http://127.0.0.1:${qp}/readyz`)).ok) break;
    } catch {}
    await new Promise((r) => setTimeout(r, 500));
  }
  for (const path of [
    'packages/hive',
    'services/hive-router',
    'services/hive-iam/apps/iam-core',
    'services/hive-mem/ts-core',
    'services/hive-skills',
  ])
    await run('npm', ['pack', '--ignore-scripts', '--silent', '--pack-destination', packs], {
      cwd: join(root, path),
    });
  const baselineDir = join(work, 'baseline');
  mkdirSync(baselineDir);
  writeFileSync(join(baselineDir, 'package.json'), JSON.stringify({ private: true }));
  // Resolve once and record precisely what the registry supplied.
  const current = JSON.parse(
    await run('npm', [
      'view',
      '@hivemagnus/hive@latest',
      '--json',
      '--registry=https://registry.npmjs.org',
    ]),
  );
  const candidate = await (
    await import('./upgrade-candidate.mjs')
  ).candidateArtifacts(
    work,
    packs,
    JSON.parse(readFileSync(join(root, 'packages/hive/package.json'), 'utf8')),
    current.version,
    run,
  );
  await run('npm', [
    'install',
    '--prefix',
    baselineDir,
    '--no-fund',
    '--no-audit',
    `@hivemagnus/hive@${current.version}`,
  ]);
  const oldCli = join(baselineDir, 'node_modules/@hivemagnus/hive/dist/src/cli.js');
  // Release 1.2.0 compares registry JSON key order. Its documented bootstrap
  // workaround uses unmodified public tarballs; the old installed code stays intact.
  const baselineArgs = [];
  if (current.version === '1.2.0') {
    const published = join(work, 'public-baseline-packs');
    mkdirSync(published);
    for (const [name, version] of Object.entries(current.hiveRelease.components))
      await run('npm', [
        'pack',
        `${name}@${version}`,
        '--ignore-scripts',
        '--silent',
        '--pack-destination',
        published,
      ]);
    baselineArgs.push('--from', published);
  }
  await run(
    process.execPath,
    [
      oldCli,
      'init',
      '--services',
      'all',
      '--yes',
      ...baselineArgs,
      '--qdrant-url',
      `http://127.0.0.1:${qp}`,
      '--redis-url',
      `redis://127.0.0.1:${rp}`,
      ...(
        await Promise.all(
          ['memory', 'iam', 'router', 'router-admin', 'skills'].map(async (s) => [
            '--port',
            `${s}=${await port()}`,
          ]),
        )
      ).flat(),
    ],
    { env: { ...env, NODE_EXTRA_CA_CERTS: undefined } },
  );
  // Never copy the executing account into synthetic service configuration.
  for (const [service, variable] of [
    ['router', 'HIVE_ROUTER_ADMIN_USERS'],
    ['skills', 'HIVE_SKILLS_ADMIN_USERS'],
  ]) {
    const file = join(home, 'config', `${service}.env`);
    writeFileSync(
      file,
      readFileSync(file, 'utf8').replace(new RegExp(`^${variable}=.*$`, 'm'), `${variable}=admin`),
      { mode: 0o600 },
    );
  }
  const memoryConfig = join(home, 'config/memory.env');
  writeFileSync(
    memoryConfig,
    readFileSync(memoryConfig, 'utf8') +
      `\nHIVEMEM_RENEWAL_SECRET=${randomBytes(32).toString('hex')}\n`,
    { mode: 0o600 },
  );
  await run(
    process.execPath,
    [
      join(home, 'runtime/node_modules/@hivemagnus/hive-skills/dist/cli.js'),
      'seed',
      '--env-file',
      join(home, 'config/skills.env'),
    ],
    { env, cwd: home },
  );
  const log = await import('node:fs');
  const fd = log.openSync(join(work, 'baseline.log'), 'a', 0o600);
  baseline = spawn(process.execPath, [oldCli, 'start'], {
    env,
    cwd: home,
    stdio: ['ignore', fd, fd],
  });
  log.closeSync(fd);
  await wait(oldCli);
  const protectedFiles = [
    'config/iam.env',
    'config/router.env',
    'config/memory.env',
    'config/skills.env',
    'iam/keys/iam-private.pem',
    'iam/keys/iam-public.pem',
    'tls/ca.key',
    'tls/server.key',
  ];
  const protectedHashes = Object.fromEntries(protectedFiles.map((f) => [f, digest(join(home, f))]));
  const memoryEnv = parseEnv(readFileSync(join(home, 'config/memory.env'), 'utf8'));
  const iamEnv = parseEnv(readFileSync(join(home, 'config/iam.env'), 'utf8'));
  const routerEnv = parseEnv(readFileSync(join(home, 'config/router.env'), 'utf8'));
  const sdkDir = join(work, 'clients');
  await run('npm', [
    'install',
    '--prefix',
    sdkDir,
    '--no-fund',
    '--no-audit',
    '@hivemagnus/hivemem-sdk@1.0.3',
    '@hivemagnus/hive-iam-sdk@1.0.3',
  ]);
  const { HiveMem } = await import(
    join(sdkDir, 'node_modules/@hivemagnus/hivemem-sdk/dist/index.js')
  );
  const token = (
    await run(
      process.execPath,
      [
        join(home, 'runtime/node_modules/@hivemagnus/hivemem-server/dist/src/cli.js'),
        'issue-token',
        '--subject',
        'example-upgrade',
        '--role',
        'admin',
        '--env-file',
        join(home, 'config/memory.env'),
      ],
      { env, cwd: home },
    )
  ).trim();
  const memoryUrl = `https://localhost:${memoryEnv.HIVEMEM_WEB_PORT}`;
  const memory = new HiveMem({
    baseUrl: memoryUrl,
    token,
    workspaceId: 'example-upgrade',
    fetchImpl: request,
    maxRetries: 0,
  });
  const workspaceResponse = await request(`${memoryUrl}/v1/workspaces`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ workspace_id: 'example-upgrade', title: 'Synthetic upgrade fixture' }),
  });
  assert.equal(workspaceResponse.status, 201);
  const fact = await memory.createMemory({
    content: 'The synthetic upgrade fixture color is amber.',
    type: 'semantic',
    scope: 'private',
    source: 'observation',
  });
  const renewalResponse = await request(`${memoryUrl}/v1/auth/renewal-grants`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      agent_id: 'example-upgrade',
      scopes: ['memories:read'],
      workspace_ids: ['example-upgrade'],
    }),
  });
  assert.equal(renewalResponse.status, 201);
  const renewalGrant = (await renewalResponse.json()).grant;
  async function verifyRenewal() {
    const renewed = await request(`${memoryUrl}/v1/auth/renew`, {
      method: 'POST',
      headers: { authorization: `Bearer ${renewalGrant}` },
    });
    assert.equal(renewed.status, 200);
    const body = await renewed.json();
    const claims = JSON.parse(Buffer.from(body.token.split('.')[1], 'base64url').toString());
    assert.equal(claims.role, 'agent');
    assert.equal(claims.scope, 'memories:read');
    assert.deepEqual(claims.workspace_ids, ['example-upgrade']);
    assert.equal(
      (
        await request(`${memoryUrl}/v1/auth/me`, {
          headers: { authorization: `Bearer ${body.token}` },
        })
      ).status,
      200,
    );
  }
  await verifyRenewal();
  const credential = parseEnv(readFileSync(join(home, 'iam/initial-credentials.env'), 'utf8'));
  const iamUrl = `https://localhost:${iamEnv.PORT}`;
  const login = await request(`${iamUrl}/api/v1/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: credential.SEED_ADMIN_PASSWORD }),
  });
  assert.equal(login.status, 200);
  const issued = await login.json();
  const access = (issued.data || issued).accessToken;
  assert.equal(typeof access, 'string');
  const discoveryResponse = await request(
    `${iamUrl}/api/v1/oauth/.well-known/openid-configuration`,
  );
  assert.equal(discoveryResponse.status, 200);
  const discoveryBody = await discoveryResponse.json();
  const discovery = discoveryBody.data || discoveryBody;
  const jwksUrl = new URL(discovery.jwks_uri);
  jwksUrl.hostname = 'localhost';
  jwksUrl.port = iamEnv.PORT;
  const jwksBefore = await (await request(jwksUrl)).json();
  assert(jwksBefore.keys?.length > 0, 'real JWKS contains a signing key');
  const { IamVerifier, refreshAccessToken } = await import(
    join(sdkDir, 'node_modules/@hivemagnus/hive-iam-sdk/dist/index.js')
  );
  async function verifyConsumerToken() {
    const previousFetch = globalThis.fetch;
    globalThis.fetch = (input, init) =>
      request(typeof input === 'object' && 'url' in input ? input.url : input, init);
    try {
      return await new IamVerifier({
        publicKeyUrl: `${iamUrl}/api/v1/auth/public-key`,
        issuer: iamEnv.JWT_ISSUER || 'hive-iam',
        cacheTtlMs: 0,
      }).verify(access);
    } finally {
      globalThis.fetch = previousFetch;
    }
  }
  const principal = await verifyConsumerToken();
  assert.equal(principal.username, 'admin');
  let refreshToken = (issued.data || issued).refreshToken;
  async function verifyRefresh() {
    const previousFetch = globalThis.fetch;
    globalThis.fetch = (input, init) =>
      request(typeof input === 'object' && 'url' in input ? input.url : input, init);
    try {
      const refreshed = await refreshAccessToken(iamUrl, refreshToken);
      assert(
        refreshed?.accessToken && refreshed.refreshToken,
        'old SDK refresh helper accepts the preserved refresh grant',
      );
      refreshToken = refreshed.refreshToken;
      const claims = await new IamVerifier({
        publicKeyUrl: `${iamUrl}/api/v1/auth/public-key`,
        issuer: iamEnv.JWT_ISSUER || 'hive-iam',
        cacheTtlMs: 0,
      }).verify(refreshed.accessToken);
      assert.equal(claims.sub, principal.sub);
    } finally {
      globalThis.fetch = previousFetch;
    }
  }
  await verifyRefresh();
  const load = createRequire(
    join(home, 'runtime/node_modules/@hivemagnus/hive-router/package.json'),
  );
  const Database = load('better-sqlite3');
  const database = join(home, 'router/router.db');
  const db = new Database(database);
  modelProvider = createHttpServer(async (req, res) => {
    let text = '';
    for await (const chunk of req) text += chunk;
    const body = text ? JSON.parse(text) : {};
    if (req.url === '/v1/models') {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ data: [{ id: 'example-upgrade-model', object: 'model' }] }));
      return;
    }
    assert.equal(req.url, '/v1/chat/completions');
    const content = JSON.stringify(body.messages).includes(`[memory:${fact.id}]`)
      ? 'amber'
      : 'UNKNOWN';
    if (body.stream) {
      res.setHeader('content-type', 'text/event-stream');
      for (const piece of [content.slice(0, 2), content.slice(2)])
        res.write(
          `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: piece }, finish_reason: null }] })}\n\n`,
        );
      res.end(
        `data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`,
      );
    } else {
      res.setHeader('content-type', 'application/json');
      res.end(
        JSON.stringify({
          choices: [{ message: { role: 'assistant', content }, finish_reason: 'stop' }],
        }),
      );
    }
  });
  await new Promise((r) => modelProvider.listen(0, '127.0.0.1', r));
  const now = new Date().toISOString();
  db.prepare(
    'INSERT INTO Provider (id,slug,name,kind,baseUrl,authMode,createdAt,updatedAt) VALUES (?,?,?,?,?,?,?,?)',
  ).run(
    'example-provider',
    'example-upgrade',
    'Synthetic upgrade provider',
    'OPENAI',
    `http://127.0.0.1:${modelProvider.address().port}`,
    'NONE',
    now,
    now,
  );
  db.prepare(
    'INSERT INTO ProviderModel (id,providerId,model,createdAt,updatedAt) VALUES (?,?,?,?,?)',
  ).run('example-model', 'example-provider', 'example-upgrade-model', now, now);
  db.prepare(
    'INSERT INTO ModelAlias (id,alias,providerId,upstreamModel,createdAt,updatedAt) VALUES (?,?,?,?,?,?)',
  ).run('example-alias', 'example-upgrade', 'example-provider', 'example-upgrade-model', now, now);
  const inferenceKey = randomBytes(32).toString('hex'),
    salt = randomBytes(16).toString('hex');
  db.prepare(
    'INSERT INTO ClientApiKey (id,name,keyPrefix,keyHash,metadataJson,createdAt,updatedAt) VALUES (?,?,?,?,?,?,?)',
  ).run(
    'example-key',
    'Synthetic upgrade consumer',
    inferenceKey.slice(0, 8),
    `${salt}:${scryptSync(inferenceKey, salt, 64).toString('hex')}`,
    JSON.stringify({ scopes: ['inference:write', 'models:read'] }),
    now,
    now,
  );
  async function consumerSmoke() {
    const context = (
      await memory.context({
        search_query: 'synthetic upgrade fixture color',
        max_memories: 3,
        token_budget: 1000,
      })
    ).toOpenAI();
    assert(
      context.some((m) => m.content.includes(`[memory:${fact.id}]`) && m.content.includes('amber')),
      'old SDK retains fact citations',
    );
    for (const stream of [false, true]) {
      const response = await request(
        `https://localhost:${routerEnv.API_PORT}/v1/chat/completions`,
        {
          method: 'POST',
          headers: { authorization: `Bearer ${inferenceKey}`, 'content-type': 'application/json' },
          body: JSON.stringify({
            model: 'example-upgrade',
            messages: [...context, { role: 'user', content: 'Return the synthetic fixture color' }],
            stream,
          }),
        },
      );
      assert.equal(response.status, 200);
      if (stream) {
        assert(response.headers.get('content-type').includes('text/event-stream'));
        const frames = (await response.text())
          .split('\n')
          .filter((line) => line.startsWith('data: '))
          .map((line) => line.slice(6));
        assert.equal(frames.at(-1), '[DONE]');
        const chunks = frames
          .slice(0, -1)
          .map((f) => JSON.parse(f).choices?.[0]?.delta?.content)
          .filter(Boolean);
        assert(chunks.length >= 2);
        assert.equal(chunks.join(''), 'amber');
      } else assert.equal((await response.json()).choices[0].message.content, 'amber');
    }
  }
  db.prepare(
    'INSERT INTO RuntimeSetting (id,key,valueJson,createdAt,updatedAt) VALUES (?,?,?,?,?)',
  ).run(
    'example-upgrade-setting',
    'example.upgrade',
    '{"preserved":true}',
    new Date().toISOString(),
    new Date().toISOString(),
  );
  db.close();
  await consumerSmoke();
  baseline.kill('SIGTERM');
  await new Promise((r) => baseline.once('exit', r));
  baseline = undefined;
  const candidateDir = join(work, 'candidate');
  mkdirSync(candidateDir);
  writeFileSync(join(candidateDir, 'package.json'), '{"private":true}');
  await run('npm', [
    'install',
    '--prefix',
    candidateDir,
    '--no-fund',
    '--no-audit',
    join(packs, `hivemagnus-hive-${candidate.version}.tgz`),
  ]);
  const cli = join(candidateDir, 'node_modules/@hivemagnus/hive/dist/src/cli.js');
  await run(process.execPath, [cli, 'adopt', '--apply'], { env });
  const adoptedCli = join(home, 'current/node_modules/@hivemagnus/hive/dist/src/cli.js');
  const startLog = await import('node:fs');
  const startFd = startLog.openSync(join(work, 'adopted.log'), 'a', 0o600);
  baseline = spawn(process.execPath, [adoptedCli, 'start'], {
    env,
    cwd: home,
    stdio: ['ignore', startFd, startFd],
  });
  startLog.closeSync(startFd);
  await wait(cli);
  const before = digest(join(home, 'config/project.json'));
  const plan = JSON.parse(
    await run(process.execPath, [cli, 'upgrade', '--dry-run', '--from', packs], { env }),
  );
  assert.equal(plan.target.version, candidate.version);
  assert.equal(digest(join(home, 'config/project.json')), before);
  const transaction = JSON.parse(
    await run(process.execPath, [cli, 'upgrade', '--from', packs], { env }),
  );
  assert.equal(transaction.phase, 'completed');
  await wait(cli);
  for (const [f, sha] of Object.entries(protectedHashes))
    assert.equal(digest(join(home, f)), sha, `${f} preserved`);
  assert.equal((await memory.getMemory(fact.id)).content, fact.content);
  assert(
    (
      await memory.context({
        search_query: 'synthetic upgrade fixture color',
        max_memories: 3,
        token_budget: 1000,
      })
    )
      .toOpenAI()
      .some((m) => m.content.includes('amber')),
  );
  assert.deepEqual(await (await request(jwksUrl)).json(), jwksBefore);
  await consumerSmoke();
  assert.equal(
    (await verifyConsumerToken()).sub,
    principal.sub,
    'old SDK verifies the pre-upgrade token after upgrading',
  );
  await verifyRefresh();
  await verifyRenewal();
  const upgraded = new Database(database, { readonly: true });
  assert.equal(
    upgraded
      .prepare('SELECT valueJson FROM RuntimeSetting WHERE id=?')
      .get('example-upgrade-setting').valueJson,
    '{"preserved":true}',
  );
  upgraded.close();
  const runtime = await import(
    join(candidateDir, 'node_modules/@hivemagnus/hive/dist/src/release/runtime.js')
  );
  const projectState = runtime.readProject(home);
  const control = runtime.manager(home, projectState);
  if (process.env.HIVE_UPGRADE_DRILL_COMPOSE === 'true') {
    await (
      await import('./compose-upgrade-drill.mjs')
    ).composeDrill({
      root,
      work,
      home,
      packs,
      env,
      runtime,
      control,
      run,
      wait,
      cli,
      verifyState: async () => {
        await consumerSmoke();
        assert.equal((await memory.getMemory(fact.id)).content, fact.content);
        assert.deepEqual(await (await request(jwksUrl)).json(), jwksBefore);
        assert.equal((await verifyConsumerToken()).sub, principal.sub);
        for (const [file, sha] of Object.entries(protectedHashes))
          assert.equal(digest(join(home, file)), sha);
      },
    });
    process.exitCode = 0;
  } else {
    await control.stop();
    // A real restore of every owned store, using the exact verified receipt.
    const restore = join(work, 'restore-proof');
    const specs = runtime.inventory(home, projectState);
    await runtime.backupStores(specs, restore, projectState.id);
    await runtime.restoreStores(
      specs,
      restore,
      projectState.id,
      runtime.hash(readFileSync(join(restore, 'manifest.json'))),
    );
    await control.start();
    await control.health(runtime.activeDirectory(home));
    await run(process.execPath, [cli, 'rollback', '--transaction', transaction.id], { env });
    await wait(cli);
    assert.equal((await memory.getMemory(fact.id)).content, fact.content);
    await assert.rejects(
      runtime.upgrade(
        home,
        { from: packs },
        {
          ...control,
          health: async (directory) => {
            if (
              runtime.installedPackage(directory, '@hivemagnus/hive').version === candidate.version
            )
              throw new Error('synthetic health failure');
            await control.health(directory);
          },
        },
      ),
      /synthetic health failure/,
    );
    assert.equal(
      runtime.installedPackage(runtime.activeDirectory(home), '@hivemagnus/hive').version,
      current.version,
    );
    assert.equal((await memory.getMemory(fact.id)).content, fact.content);
    await control.stop();
    const fresh = await (
      await import('./check-managed-install.mjs')
    ).freshManagedInstall({
      work,
      packs,
      cli,
      env,
      runtime,
      run,
      port,
      version: candidate.version,
    });
    console.log(
      JSON.stringify({
        passed: true,
        baseline: current.version,
        candidate: candidate.version,
        datastores: [
          'iam-sqlite',
          'router-sqlite',
          'skills-sqlite-archives',
          'qdrant',
          'scoped-redis',
        ],
        backupRestore: true,
        rollback: true,
        protectedFiles: protectedFiles.length,
        ...fresh,
      }),
    );
  }
} catch (error) {
  console.error(error);
  console.error(`Private synthetic drill evidence: ${work}`);
  process.exitCode = 1;
} finally {
  if (baseline) baseline.kill('SIGTERM');
  if (modelProvider) modelProvider.close();
  if (existsSync(join(home, 'run/hive.pid'))) {
    try {
      process.kill(JSON.parse(readFileSync(join(home, 'run/hive.pid'), 'utf8')).pid, 'SIGTERM');
    } catch {}
  }
  for (const suffix of ['qdrant', 'redis'])
    spawnSync('docker', ['rm', '-fv', `${project}-${suffix}`], { stdio: 'ignore' });
  if (!keep && !process.exitCode) rmSync(work, { recursive: true, force: true });
}
