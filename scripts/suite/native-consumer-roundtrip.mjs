#!/usr/bin/env node
// Fresh, developer-owned services and an explicitly synthetic model protocol only.
import assert from 'node:assert/strict';
import { execFile, execFileSync, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import {
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
  chmodSync,
  openSync,
  closeSync,
  readdirSync,
  lstatSync,
} from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash, randomBytes, createHmac } from 'node:crypto';
import { createServer, request as tlsRequest } from 'node:https';
import { createServer as tcpServer } from 'node:net';
import { rehearseHermesSkills } from './native-hermes-consumer.mjs';
import { validateConsumerArtifact, consumerModelReply } from './native-consumer-contract.mjs';
const execute = promisify(execFile),
  options = {};
for (let index = 2; index < process.argv.length; index += 2) {
  const key = process.argv[index];
  assert(
    ['--ardent-artifact', '--skills-root', '--chat-root', '--output', '--hermes-artifact'].includes(
      key,
    ) && process.argv[index + 1],
  );
  assert(!options[key]);
  options[key] = resolve(process.argv[index + 1]);
}
assert(
  ['--ardent-artifact', '--skills-root', '--chat-root', '--output'].every((key) => options[key]),
  'Required: --ardent-artifact DESCRIPTOR --skills-root BUILT_SOURCE --chat-root BUILT_SOURCE --output NEW_PRIVATE_DIRECTORY',
);
assert.notEqual(process.getuid?.(), 0, 'Run the disposable native proof as an ordinary user');
const output = options['--output'];
assert(!existsSync(output), 'Evidence directory must be new');
mkdirSync(output, { mode: 0o700, recursive: true });
chmodSync(output, 0o700);
const put = (name, value) => {
  const path = join(output, name);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(
    path,
    typeof value === 'string' || Buffer.isBuffer(value) ? value : JSON.stringify(value, null, 2),
    { mode: 0o600 },
  );
  chmodSync(path, 0o600);
  return path;
};
const digest = (value) => createHash('sha256').update(value).digest('hex');
const treeDigest = (directory) => {
  const hash = createHash('sha256');
  const visit = (current, prefix = '') => {
    for (const entry of readdirSync(current).sort()) {
      const path = join(current, entry),
        name = prefix + entry,
        stat = lstatSync(path);
      assert(!stat.isSymbolicLink(), 'Built product trees must not contain symlinks');
      if (stat.isDirectory()) visit(path, name + '/');
      else {
        assert(stat.isFile());
        hash.update(name + '\0' + digest(readFileSync(path)) + '\n');
      }
    }
  };
  visit(directory);
  return hash.digest('hex');
};
const run = (command, args, extra = {}) =>
  execFileSync(command, args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 32 * 1024 * 1024,
    ...extra,
  }).trim();
const descriptor = validateConsumerArtifact(
  JSON.parse(readFileSync(options['--ardent-artifact'], 'utf8')),
  { x64: 'amd64', arm64: 'arm64' }[process.arch],
);
const archive = join(dirname(options['--ardent-artifact']), descriptor.archive);
assert.equal(digest(readFileSync(archive)), descriptor.sha256);
const listing = run('tar', ['-tzf', archive]).split('\n');
assert(
  listing.every(
    (name) =>
      !name.startsWith('/') &&
      !name.includes('\\') &&
      !name.split('/').includes('..') &&
      !/\.(gguf|ggml|safetensors)$/i.test(name),
  ),
);
assert(
  run('tar', ['-tvzf', archive])
    .split('\n')
    .every((line) => ['-', 'd'].includes(line[0])),
  'No links, devices or special files',
);
const unpack = join(output, 'artifact');
mkdirSync(unpack, { mode: 0o700 });
run('tar', ['-xzf', archive, '-C', unpack, '--no-same-owner', '--no-same-permissions']);
const cli = join(unpack, descriptor.executable),
  nativeNode = join(unpack, 'runtime/node');
const modules = join(unpack, 'app/node_modules/@hivemagnus/ardent/dist');
assert.equal(run(cli, ['--version']), descriptor.version);
const minimalEnv = Object.fromEntries(
  ['PATH', 'HOME', 'LANG', 'LC_ALL', 'TZ']
    .filter((name) => process.env[name])
    .map((name) => [name, process.env[name]]),
);
mkdirSync(join(output, 'home'), { mode: 0o700 });
minimalEnv.HOME = join(output, 'home');
const child = (name, command, args, env) => {
  const log = openSync(put(name + '.log', ''), 'a');
  const process = spawn(command, args, {
    cwd: output,
    env: { ...minimalEnv, ...env },
    stdio: ['ignore', log, log],
  });
  closeSync(log);
  process.once('error', (error) => put(name + '-spawn-error.txt', error.message));
  return process;
};
const port = async () => {
  const server = tcpServer().listen(0, '127.0.0.1');
  await new Promise((done) => server.once('listening', done));
  const value = server.address().port;
  await new Promise((done) => server.close(done));
  return value;
};
const wait = async (predicate) => {
  for (let attempt = 0; attempt < 150; attempt++) {
    if (await predicate()) return;
    await new Promise((done) => setTimeout(done, 200));
  }
  throw Error('Disposable consumer gate timed out; inspect private evidence');
};
const certificate = join(output, 'fixture.pem'),
  privateKey = join(output, 'fixture.key');
run('openssl', [
  'req',
  '-x509',
  '-newkey',
  'rsa:2048',
  '-nodes',
  '-keyout',
  privateKey,
  '-out',
  certificate,
  '-subj',
  '/CN=localhost',
  '-addext',
  'subjectAltName=DNS:localhost,IP:127.0.0.1',
  '-days',
  '1',
]);
chmodSync(certificate, 0o600);
chmodSync(privateKey, 0o600);
const request = (origin, path, { method = 'GET', body, headers = {} } = {}) =>
  new Promise((done, reject) => {
    const req = tlsRequest(
      new URL(path, origin),
      {
        ca: readFileSync(certificate),
        timeout: 10000,
        method,
        headers: { 'content-type': 'application/json', ...headers },
      },
      (res) => {
        let text = '';
        res.on('data', (bytes) => {
          text += bytes;
          if (text.length > 2 * 1024 * 1024) req.destroy(Error('Response too large'));
        });
        res.on('end', () => {
          try {
            done({
              status: res.statusCode,
              body: text ? JSON.parse(text) : null,
              headers: res.headers,
            });
          } catch {
            reject(Error('Malformed fixture response'));
          }
        });
      },
    );
    req.once('error', reject);
    req.once('timeout', () => req.destroy(Error('Fixture timeout')));
    req.end(body === undefined ? undefined : JSON.stringify(body));
  });
const profile = join(output, 'profile'),
  skillsRoot = options['--skills-root'],
  chatRoot = options['--chat-root'];
for (const [source, entry] of [
  [skillsRoot, 'dist/server.js'],
  [chatRoot, 'dist/src/server/index.js'],
])
  assert(existsSync(join(source, entry)), 'Build the explicitly selected product first');
const modelToken = randomBytes(32).toString('hex'),
  botToken = randomBytes(32).toString('hex'),
  adminPassword = randomBytes(24).toString('hex');
const skillText = 'SYNTHETIC-IMMUTABLE-CONSUMER-SKILL';
let modelCalls = 0,
  summaries = 0,
  continuations = 0,
  fixtureFailure;
const model = createServer(
  { cert: readFileSync(certificate), key: readFileSync(privateKey) },
  async (req, res) => {
    try {
      if (req.headers.authorization !== 'Bearer ' + modelToken) {
        res.writeHead(401).end('{}');
        return;
      }
      let raw = '';
      for await (const bytes of req) {
        raw += bytes;
        assert(raw.length < 256 * 1024);
      }
      const body = raw ? JSON.parse(raw) : null;
      const json = (value) => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(value));
      };
      if (req.url === '/v1/models')
        return json({ data: [{ id: 'synthetic-consumer-model', meta: { n_ctx: 32768 } }] });
      if (req.url === '/props')
        return json({ chat_template_caps: { supports_tools: true, supports_tool_calls: true } });
      if (req.url === '/v1/chat/completions/input_tokens') return json({ input_tokens: 100 });
      if (req.url === '/fixture/summary') {
        const input = JSON.parse(body.prompt);
        summaries++;
        return json({
          items: [
            {
              kind: 'correction',
              text: 'Ω-42 is monthly. Source verification is pending; delivery remains unknown.',
              source_message_ids: [input.exchanges[0].user.id],
              historical_status: 'historical_unverified',
            },
          ],
        });
      }
      if (req.url === '/fixture/continue') {
        assert(JSON.stringify(body.messages).includes('monthly'));
        continuations++;
        return json({
          reference: 'Ω-42',
          schedule: 'monthly',
          verification: 'pending',
          delivery: 'unknown',
        });
      }
      if (req.url === '/v1/chat/completions') {
        const reply = consumerModelReply(body, skillText);
        modelCalls++;
        assert(body.stream, 'Actual native completion must stream');
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        const delta = reply.tool_calls.length
          ? { tool_calls: reply.tool_calls.map((call, index) => ({ index, ...call })) }
          : { content: reply.content };
        res.end('data: ' + JSON.stringify({ choices: [{ delta }] }) + '\n\ndata: [DONE]\n\n');
        return;
      }
      res.writeHead(404).end('{}');
    } catch (error) {
      fixtureFailure = error;
      put('model-error.txt', error.stack);
      res.writeHead(500).end('{}');
    }
  },
).listen(0, '127.0.0.1');
await new Promise((done) => model.once('listening', done));
const modelOrigin = 'https://localhost:' + model.address().port;
const skillsPort = await port(),
  chatPort = await port(),
  skillsOrigin = 'https://localhost:' + skillsPort,
  chatOrigin = 'https://localhost:' + chatPort;
const skillsSecret = randomBytes(32).toString('hex');
const environment = {
  ARDENT_LLAMA_BASE_URL: modelOrigin,
  ARDENT_LLAMA_MODEL: 'synthetic-consumer-model',
  ARDENT_LLAMA_API_KEY: modelToken,
  MATTERMOST_URL: chatOrigin,
  MATTERMOST_TOKEN: botToken,
  NODE_EXTRA_CA_CERTS: certificate,
};
const environmentPath = put('native-environment.json', environment);
const processes = [];
try {
  processes.push(
    child('skills', process.execPath, [join(skillsRoot, 'dist/server.js')], {
      NODE_ENV: 'production',
      HIVE_SKILLS_HOST: '127.0.0.1',
      HIVE_SKILLS_PORT: String(skillsPort),
      HIVE_SKILLS_PUBLIC_URL: skillsOrigin,
      HIVE_SKILLS_DATA_DIR: join(output, 'skills-data'),
      HIVE_SKILLS_SESSION_SECRET: skillsSecret,
      HIVE_SKILLS_ADMIN_USERS: 'admin',
      HIVE_SKILLS_TLS_KEY_FILE: privateKey,
      HIVE_SKILLS_TLS_CERT_FILE: certificate,
      HIVE_SKILLS_TARGETS:
        'consumer-fixture=deploy@client.example.com,hermes-consumer-fixture=deploy@client.example.com',
      HIVE_AUTO_MIGRATE: 'true',
      HIVE_SKILLS_DEPLOYMENT_WORKER_ENABLED: 'false',
      HIVE_UPDATE_CHECK: 'false',
    }),
  );
  const chatEnv = put(
    'chat.env',
    Object.entries({
      DATABASE_URL: 'postgresql://synthetic:unused@localhost:5432/unused',
      SERVER_URL: chatOrigin,
      PORT: String(chatPort),
      BIND_HOST: '127.0.0.1',
      TLS_CERT_PATH: certificate,
      TLS_KEY_PATH: privateKey,
      COOKIE_SECRET: randomBytes(32).toString('hex'),
      TOKEN_HASH_SECRET: randomBytes(32).toString('hex'),
      ADMIN_USERNAME: 'admin',
      ADMIN_PASSWORD: adminPassword,
      ADMIN_EMAIL: 'admin@example.com',
      HERMES_BOT_USERNAME: 'consumer-bot',
      HERMES_BOT_DISPLAY_NAME: 'Synthetic native consumer',
      HERMES_BOT_TOKEN: botToken,
      STORE_BACKEND: 'json',
      STORE_PATH: join(output, 'chat-data/store.json'),
      FILE_STORAGE_PATH: join(output, 'chat-data/files'),
      PROFILE_IMAGE_STORAGE_PATH: join(output, 'chat-data/profiles'),
      NODE_ENV: 'production',
      ENABLE_DEV_DEFAULTS: 'false',
      ENABLE_TELEMETRY: 'false',
      ENABLE_DIAGNOSTICS: 'false',
      ENABLE_SECURITY_ALERT_CHECKS: 'false',
    })
      .map(([key, value]) => key + '=' + value)
      .join('\n') + '\n',
  );
  processes.push(
    child('chat', process.execPath, [join(chatRoot, 'dist/src/server/index.js')], {
      CHATTERMOST_ENV_FILE: chatEnv,
    }),
  );
  await wait(async () => {
    try {
      return (
        (await request(skillsOrigin, '/healthz')).status === 200 &&
        (await request(chatOrigin, '/api/v4/system/ping')).status === 200
      );
    } catch {
      return false;
    }
  });
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(join(output, 'skills-data/registry.sqlite')),
    session = randomBytes(32).toString('hex');
  db.prepare('INSERT INTO sessions VALUES (?,?,?,?)').run(
    session,
    'admin',
    new Date(Date.now() + 3600000).toISOString(),
    new Date().toISOString(),
  );
  db.close();
  // Explicit fixture-only operator session; no existing credentials are read.
  const cookie =
    'hive_skills_session=' +
    session +
    '.' +
    createHmac('sha256', skillsSecret).update(session).digest('base64url');
  const admin = (path, body, method = 'POST') =>
    request(skillsOrigin, path, { method, body, headers: { cookie } });
  const enroll = await admin('/admin/targets/consumer-fixture/enroll', {
    channel: 'stable',
    skills: ['consumer-fixture'],
  });
  assert.equal(enroll.status, 201);
  put(
    'skill-source/SKILL.md',
    '---\nname: consumer-fixture\ndescription: Synthetic immutable consumer integration\n---\n' +
      skillText +
      '\n',
  );
  const skillArchive = join(output, 'skill.tgz');
  run('tar', ['-czf', skillArchive, '-C', join(output, 'skill-source'), '.']);
  chmodSync(skillArchive, 0o600);
  assert.equal(
    (
      await admin('/admin/skills', {
        slug: 'consumer-fixture',
        name: 'Consumer fixture',
        description: 'Disposable native consumer',
        homepage: null,
        enabled: true,
      })
    ).status,
    201,
  );
  assert.equal(
    (
      await admin('/admin/skills/consumer-fixture/releases', {
        version: '1.0.0',
        archiveBase64: readFileSync(skillArchive).toString('base64'),
      })
    ).status,
    201,
  );
  assert.equal(
    (await admin('/admin/channels/stable/consumer-fixture', { version: '1.0.0' }, 'PUT')).status,
    200,
  );
  assert.equal(
    (
      await request(skillsOrigin, '/admin/skills', {
        headers: { authorization: 'Bearer ' + enroll.body.token },
      })
    ).status,
    401,
    'Target token cannot administer the registry',
  );
  const chatLogin = await request(chatOrigin, '/api/v4/users/login', {
    method: 'POST',
    body: { login_id: 'admin', password: adminPassword },
  });
  assert.equal(chatLogin.status, 200);
  const headers = { authorization: 'Bearer ' + chatLogin.headers.token };
  const bot = await request(chatOrigin, '/api/v4/users/me', {
    headers: { authorization: 'Bearer ' + botToken },
  });
  assert.equal(bot.status, 200);
  assert.equal(bot.body.is_bot, true);
  assert.equal(
    (
      await request(chatOrigin, '/admin/users', {
        headers: { authorization: 'Bearer ' + botToken },
      })
    ).status,
    403,
  );
  const forbiddenPassword = randomBytes(24).toString('hex');
  const forbidden = await request(chatOrigin, '/admin/users', {
    method: 'POST',
    headers,
    body: {
      username: 'forbidden-fixture',
      email: 'forbidden@example.com',
      password: forbiddenPassword,
      role: 'system_user',
    },
  });
  assert.equal(forbidden.status, 201);
  const forbiddenLogin = await request(chatOrigin, '/api/v4/users/login', {
    method: 'POST',
    body: { login_id: 'forbidden-fixture', password: forbiddenPassword },
  });
  assert.equal(forbiddenLogin.status, 200);
  const dm = await request(chatOrigin, '/api/v4/channels/direct', {
    method: 'POST',
    headers,
    body: [chatLogin.body.id, bot.body.id],
  });
  assert.equal(dm.status, 200);
  const forbiddenDM = await request(chatOrigin, '/api/v4/channels/direct', {
    method: 'POST',
    headers,
    body: [forbidden.body.id, bot.body.id],
  });
  assert.equal(forbiddenDM.status, 200);
  await execute(
    cli,
    ['--profile-path', profile, 'init', '--non-interactive', '--api-port', String(await port())],
    { env: minimalEnv },
  );
  const originalProfileEnv = readFileSync(join(profile, '.env'));
  // The native sync client writes only the fresh profile, before its gateway starts.
  const syncRunner = put(
    'sync.mjs',
    `import {syncSkills} from ${JSON.stringify(pathToFileURL(join(skillsRoot, 'scripts/hermes-sync.mjs')).href)};\nimport{readFileSync}from'node:fs';\nconst input=JSON.parse(readFileSync(process.argv[2]));await syncSkills({...input,restart:()=>{}});\n`,
  );
  const syncInput = put('sync-input.json', {
    registry: skillsOrigin,
    hermesHome: profile,
    target: 'consumer-fixture',
    token: enroll.body.token,
    hermesVersion: null,
  });
  const syncEnv = { ...minimalEnv, NODE_EXTRA_CA_CERTS: certificate };
  await execute(nativeNode, [syncRunner, syncInput], { env: syncEnv, timeout: 30000 });
  const skillPath = join(profile, 'skills/registry/consumer-fixture/SKILL.md'),
    skillDigest = digest(readFileSync(skillPath));
  await execute(nativeNode, [syncRunner, syncInput], { env: syncEnv, timeout: 30000 });
  assert.equal(digest(readFileSync(skillPath)), skillDigest);
  // JSON is valid YAML and is parsed by the product-owned strict loader.
  const prepare = put(
    'prepare-profile.mjs',
    `import{loadConfig}from ${JSON.stringify(pathToFileURL(join(modules, 'config.js')).href)};import{writeFileSync}from'node:fs';const{config}=await loadConfig(process.argv[2]);config.skills={directories:['skills/registry'],enabled:['consumer-fixture']};config.channels.mattermost={enabled:true,base_url:'\${MATTERMOST_URL}',token_env:'MATTERMOST_TOKEN',allowed_user_ids:[process.argv[3]],allowed_channel_ids:[],require_mention:true,reply_mode:'thread'};writeFileSync(process.argv[2]+'/config.yaml',JSON.stringify(config),{mode:0o600});`,
  );
  await execute(nativeNode, [prepare, profile, chatLogin.body.id], { env: minimalEnv });
  const stop = put('stop', ''),
    ready = join(output, 'ready');
  const workerInput = put('worker-input.json', {
    modules,
    profile,
    environment: environmentPath,
    botId: bot.body.id,
    channelId: dm.body.id,
    ready,
    stop,
    events: join(output, 'events.json'),
    result: join(output, 'native-result.json'),
    contextDatabase: join(output, 'context.sqlite'),
    policy: join(output, 'context-policy.json'),
    modelOrigin,
    contextResult: join(output, 'context-result.json'),
  });
  const worker = child(
    'native',
    nativeNode,
    [join(import.meta.dirname, 'native-consumer-worker.mjs'), workerInput],
    { NODE_EXTRA_CA_CERTS: certificate },
  );
  processes.push(worker);
  await wait(async () => {
    assert(worker.exitCode === null, 'Native worker exited before ready');
    return existsSync(ready);
  });
  assert.equal(
    (
      await request(chatOrigin, '/api/v4/posts', {
        method: 'POST',
        headers: { authorization: 'Bearer ' + forbiddenLogin.headers.token },
        body: { channel_id: forbiddenDM.body.id, message: 'FORBIDDEN-CONSUMER' },
      })
    ).status,
    201,
  );
  const sent = await request(chatOrigin, '/api/v4/posts', {
    method: 'POST',
    headers,
    body: {
      channel_id: dm.body.id,
      message: 'Read consumer-fixture with skill_view, then confirm the immutable fixture.',
    },
  });
  assert.equal(sent.status, 201);
  await wait(async () => {
    if (fixtureFailure) throw fixtureFailure;
    const listing = await request(chatOrigin, '/api/v4/channels/' + dm.body.id + '/posts', {
      headers,
    });
    return Object.values(listing.body.posts ?? {}).some(
      (post) => post.user_id === bot.body.id && post.message === 'CONSUMER-SKILL-VERIFIED',
    );
  });
  put('stop', 'stop');
  await wait(async () => {
    if (worker.exitCode !== null)
      assert.equal(worker.exitCode, 0, 'Native worker failed after transport proof');
    return existsSync(join(output, 'native-result.json'));
  });
  assert.equal(modelCalls, 2);
  assert.equal(summaries, 2);
  assert.equal(continuations, 1);
  assert.deepEqual(readFileSync(join(profile, '.env')), originalProfileEnv);
  assert.equal(digest(readFileSync(skillPath)), skillDigest);
  let hermes;
  if (options['--hermes-artifact']) {
    const enrollment = await admin('/admin/targets/hermes-consumer-fixture/enroll', {
      channel: 'stable',
      skills: ['consumer-fixture'],
    });
    assert.equal(enrollment.status, 201);
    const hermesGroup = await request(chatOrigin, '/api/v4/channels/group', {
      method: 'POST',
      headers,
      body: [chatLogin.body.id, forbidden.body.id, bot.body.id],
    });
    assert.equal(hermesGroup.status, 200);
    hermes = await rehearseHermesSkills({
      output,
      artifactFile: options['--hermes-artifact'],
      skillsOrigin,
      targetToken: enrollment.body.token,
      syncRunner,
      certificate,
      architecture: { x64: 'amd64', arm64: 'arm64' }[process.arch],
      chat: {
        origin: chatOrigin,
        token: botToken,
        botId: bot.body.id,
        allowedUser: chatLogin.body.id,
        forbiddenUser: forbidden.body.id,
        waitReady: (path, failure) =>
          wait(async () => {
            if (failure()) throw failure();
            return existsSync(path);
          }),
        sendEvents: async () => {
          assert.equal(
            (
              await request(chatOrigin, '/api/v4/posts', {
                method: 'POST',
                headers: { authorization: 'Bearer ' + forbiddenLogin.headers.token },
                body: {
                  channel_id: hermesGroup.body.id,
                  message: '@consumer-bot HERMES-FORBIDDEN-CONSUMER',
                },
              })
            ).status,
            201,
          );
          assert.equal(
            (
              await request(chatOrigin, '/api/v4/posts', {
                method: 'POST',
                headers,
                body: {
                  channel_id: hermesGroup.body.id,
                  message: '@consumer-bot HERMES-ALLOWED-CONSUMER',
                },
              })
            ).status,
            201,
          );
        },
      },
    });
    const delivered = await request(
      chatOrigin,
      '/api/v4/channels/' + hermesGroup.body.id + '/posts',
      { headers },
    );
    assert.equal(delivered.status, 200);
    assert.equal(
      Object.values(delivered.body.posts).filter(
        (post) => post.user_id === bot.body.id && post.message === 'HERMES-CONSUMER-SKILL-VERIFIED',
      ).length,
      1,
    );
  }
  put('result.json', {
    schema: 1,
    result: 'passed',
    productionCutover: false,
    hermes: hermes
      ? {
          accepted: true,
          version: hermes.version,
          artifactSHA256: hermes.artifactSHA256,
          skills: true,
          chat: hermes.mattermost.accepted,
        }
      : { accepted: false, selected: false },
    artifact: { sha256: descriptor.sha256, version: descriptor.version },
    runtimeDigests: {
      driver: digest(readFileSync(import.meta.filename)),
      worker: digest(readFileSync(join(import.meta.dirname, 'native-consumer-worker.mjs'))),
      ...(hermes
        ? Object.fromEntries(
            [
              'native-hermes-consumer.mjs',
              'native-hermes-consumer.py',
              'native-hermes-chat.py',
            ].map((name) => [name, digest(readFileSync(join(import.meta.dirname, name)))]),
          )
        : {}),
      skillsBuild: treeDigest(join(skillsRoot, 'dist')),
      chatBuild: treeDigest(join(chatRoot, 'dist')),
      skillsSync: digest(readFileSync(join(skillsRoot, 'scripts/hermes-sync.mjs'))),
      skillsArchiveReader: digest(readFileSync(join(skillsRoot, 'scripts/archive-utils.mjs'))),
    },
    sourceCommits: Object.fromEntries(
      [
        ['skills', skillsRoot],
        ['chat', chatRoot],
      ].map(([name, source]) => [name, run('git', ['-C', source, 'rev-parse', 'HEAD'])]),
    ),
    checks: [
      'actual target-scoped HTTPS immutable publication sync and exact retry',
      'packaged Ardent streamed skill_view tool uses exact synced skill',
      'real Chat native bot authentication, HTTPS REST delivery and authenticated WebSocket consumption',
      'bot administration denied and disallowed native actor ignored',
      'packaged Emberfold SDK source-preserving checkpoint publication, validation, continuation, corruption detection and source rebuild',
      'existing profile environment bytes preserved',
    ],
    limitations: [
      'fresh native-profile fixtures; no existing production profile or account migration',
      'external model protocol and summarizer are synthetic; no inference engine or assets installed',
      'Emberfold is the embedded released SDK, not its optional HTTP service; current-format reader only',
      'generic skill fixture declares no version bounds; native Hermes proof applies only to the selected reviewed artifact, not a persistent gateway rollout',
    ],
  });
  console.log(
    'PASS: packaged Ardent consumes immutable Skills and native Chat over verified TLS, with embedded Emberfold checkpoint integrity.',
  );
} finally {
  for (const process of processes.reverse()) {
    if (process.exitCode === null) {
      process.kill('SIGTERM');
      await new Promise((done) => {
        const timer = setTimeout(() => {
          process.kill('SIGKILL');
          done();
        }, 5000);
        process.once('exit', () => {
          clearTimeout(timer);
          done();
        });
      });
    }
  }
  await new Promise((done) => model.close(done));
  // Retained keys, journals, archives and product-created state stay owner-private.
  // Executable bits inside the pinned native artifact remain intact.
  const protect = (directory) => {
    chmodSync(directory, 0o700);
    for (const name of readdirSync(directory)) {
      if (name === 'artifact' && [output, join(output, 'hermes-proof')].includes(directory))
        continue;
      const path = join(directory, name),
        stat = lstatSync(path);
      if (stat.isSymbolicLink()) continue;
      if (stat.isDirectory()) protect(path);
      else if (stat.isFile()) chmodSync(path, 0o600);
    }
  };
  protect(output);
}
