#!/usr/bin/env node
import { browserSettings, browserRehearsal } from './browser-rehearsal.mjs';
// Developer acceptance against independently restored native backups. This is
// never invoked by the Bash installer and never selects production implicitly.
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  cpSync,
  existsSync,
  lstatSync,
  readlinkSync,
  unlinkSync,
  symlinkSync,
  realpathSync,
  readdirSync,
} from 'node:fs';
import { join, resolve, relative, dirname } from 'node:path';
import { createHash, randomBytes } from 'node:crypto';

const args = process.argv.slice(2);
assert(
  args.length === 2 && args[0] === '--config',
  'Usage: native-rehearsal.mjs --config PRIVATE_JSON',
);
const configStat = lstatSync(args[1]);
assert(
  configStat.isFile() && configStat.uid === process.getuid() && (configStat.mode & 0o077) === 0,
  'Rehearsal configuration must be an operator-owned regular file with mode 0600',
);
const config = JSON.parse(readFileSync(args[1], 'utf8'));
const cleanEnv = Object.fromEntries(
  ['PATH', 'LANG', 'LC_ALL', 'TZ']
    .filter((key) => process.env[key])
    .map((key) => [key, process.env[key]]),
);
const run = (program, argv, extra = {}) =>
  execFileSync(program, argv, {
    encoding: 'utf8',
    env: cleanEnv,
    stdio: ['pipe', 'pipe', 'pipe'],
    maxBuffer: 64 * 1024 * 1024,
    ...extra,
  });
const docker = (...argv) => run('docker', argv);
const put = (file, value) =>
  writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value, null, 2), {
    mode: 0o600,
  });
const sha = (data) => createHash('sha256').update(data).digest('hex');
const parseEnv = (file) =>
  Object.fromEntries(
    readFileSync(file, 'utf8')
      .split(/\r?\n/)
      .filter((line) => /^[A-Za-z_][A-Za-z0-9_]*=/.test(line))
      .map((line) => {
        const index = line.indexOf('=');
        let value = line.slice(index + 1).trim();
        if (
          (value[0] === '"' && value.at(-1) === '"') ||
          (value[0] === "'" && value.at(-1) === "'")
        )
          value = value.slice(1, -1);
        return [line.slice(0, index), value];
      }),
  );
const containers = [],
  networks = [];
let currentOutput;
let stateSnapshots = [];
const images = {};
for (const [product, image] of Object.entries(config.images))
  images[product] = docker('image', 'inspect', image, '--format', '{{.Id}}').trim();
assert(
  config.installations.length > 0 && process.getuid() > 0,
  'Require explicit installations and an unprivileged operator',
);
function fileInside(root, path) {
  assert(path.startsWith('/'), 'Backup paths must be absolute');
  const file = realpathSync(join(root, 'state', path));
  assert(
    relative(root, file) && !relative(root, file).startsWith('..'),
    'Backup file escapes recovery root',
  );
  return file;
}
function exportApplicationState(installation) {
  const archive = realpathSync(installation.archive);
  assert(
    /^[a-f0-9]{64}$/.test(installation.archiveSHA256) &&
      sha(readFileSync(archive)) === installation.archiveSHA256,
    'Original archive checksum differs',
  );
  const ownership = JSON.parse(run('tar', ['-xOzf', archive, 'recovery/manifest.json']));
  assert(
    ownership.schemaVersion === 2 && ownership.host === installation.expectedHost,
    'Archive belongs to another independent installation',
  );
  const names = run('tar', ['-tzf', archive]).split('\n').filter(Boolean);
  assert(names.length === new Set(names).size, 'Duplicate archive member');
  for (const name of names)
    assert(
      /^(state|recovery)(\/|$)/.test(name) &&
        /^[A-Za-z0-9_./@+:,=-]+$/.test(name) &&
        !name.split('/').includes('..'),
      'Unsafe native archive member',
    );
  const types = run('tar', ['-tvzf', archive]).split('\n').filter(Boolean);
  assert(
    types.every((line) => ['d', '-', 'l'].includes(line[0])),
    'Unsupported native archive member type',
  );
  const excluded = installation.externalPaths || [];
  const isExcluded = (name) =>
    excluded.some((path) => name === path || name.startsWith(path + '/'));
  for (const name of names) {
    assert(
      !name.startsWith('state/var/lib/hive-iam-keyring/current/'),
      'Archive traverses the keyring symlink',
    );
    if (/\.(gguf|ggml|safetensors|pt|pth)$/i.test(name))
      assert(
        isExcluded(name),
        'Model assets are external: provide an explicit reviewed externalPaths exclusion before exporting application state',
      );
  }
  const root = resolve(config.output, installation.id + '-application-export');
  assert(!existsSync(root), 'Preserve prior application exports; select a new output');
  mkdirSync(root, { recursive: true, mode: 0o700 });
  run('tar', [
    '-xzf',
    archive,
    '-C',
    root,
    '--no-same-owner',
    '--no-same-permissions',
    '--keep-old-files',
    ...excluded.flatMap((path) => ['--exclude', path]),
  ]);
  const keyring = join(root, 'state/var/lib/hive-iam-keyring/current');
  for (const name of names) {
    if (isExcluded(name)) continue;
    const file = join(root, name);
    if (lstatSync(file).isSymbolicLink()) {
      assert(file === keyring, 'Unexpected native state symlink');
      const link = readlinkSync(file),
        original = resolve('/var/lib/hive-iam-keyring', link);
      assert(
        original.startsWith('/var/lib/hive-iam-keyring/'),
        'Keyring link escapes native signing keys',
      );
      unlinkSync(file);
      symlinkSync(relative(dirname(file), join(root, 'state', original)), file);
    }
  }
  put(join(root, 'application-export.json'), {
    schema: 1,
    archiveSHA256: installation.archiveSHA256,
    externalPaths: excluded,
    modelAssetsExported: false,
    productionCutover: false,
  });
  return root;
}
function checkNoModels(root, excluded) {
  for (const item of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, item.name);
    if (excluded.some((base) => path === base || path.startsWith(base + '/'))) continue;
    if (item.isDirectory()) checkNoModels(path, excluded);
    else
      assert(
        !/\.(gguf|ggml|safetensors|pt|pth)$/i.test(item.name),
        'Model resources are external: preserve the original backup and prepare a reviewed suite-only recovery export',
      );
  }
}
function start(name, network, image, env, mounts, command, options = []) {
  const envFile = join(currentOutput, name + '.env');
  for (const value of Object.values(env))
    assert(!/[\r\n]/.test(value), 'Unexpected multiline environment setting');
  put(
    envFile,
    Object.entries(env)
      .map(([key, value]) => `${key}=${value}`)
      .join('\n') + '\n',
  );
  const argv = [
    'create',
    '--name',
    name,
    '--init',
    '--network',
    network,
    '--network-alias',
    name.split('-').at(-1),
    '--user',
    `${process.getuid()}:${process.getgid()}`,
    '--read-only',
    '--cap-drop',
    'ALL',
    '--security-opt',
    'no-new-privileges:true',
    '--tmpfs',
    '/tmp:mode=1777',
    '--env-file',
    envFile,
  ];
  for (const [source, target, readOnly] of mounts)
    argv.push(
      '--mount',
      `type=bind,source=${source},target=${target}${readOnly ? ',readonly' : ''}`,
    );
  argv.push(...options, image, ...command);
  if (command[0] === 'start') {
    const product = name.split('-').at(-1),
      file = {
        identity: 'identity/state/prisma/iam.db',
        models: 'models/data/router.db',
        skills: 'skills/state/registry.sqlite',
      }[product];
    if (file) stateSnapshots.push({ file, before: sqliteSnapshot(network, file), network });

    const index = argv.indexOf(image),
      migrationArgs = argv.slice(0, index);
    migrationArgs[0] = 'run';
    migrationArgs[migrationArgs.indexOf('--name') + 1] = name + '-migration';
    migrationArgs.push('--rm', image, 'migrate');
    const raw = docker(...migrationArgs, '--plan', '--json');
    put(join(currentOutput, name + '-migration-plan.log'), raw);
    const plan = JSON.parse(raw.split('\n').findLast((line) => line.startsWith('{')));
    assert(Array.isArray(plan.pending), 'Candidate returned an unsupported migration plan');
    if (plan.pending.length) {
      assert(config.allowMigrations === true, 'Explicit clone-only migration approval is missing');
      const flags = ['--backup-dir', '/data/rehearsal-migration-backups'];
      if (plan.approval) flags.push('--confirm-plan', plan.approval);
      put(join(currentOutput, name + '-migration.log'), docker(...migrationArgs, ...flags));
    }
  }
  docker(...argv);
  containers.push(name);
  docker('start', name);
}
function helper(network, code, input = {}) {
  return JSON.parse(
    docker(
      'run',
      '--rm',
      '--network',
      network,
      '--read-only',
      '--cap-drop',
      'ALL',
      '--security-opt',
      'no-new-privileges:true',
      '--user',
      `${process.getuid()}:${process.getgid()}`,
      '--mount',
      `type=bind,source=${currentOutput},target=/rehearsal,readonly`,
      '--entrypoint',
      'node',
      images.utility,
      '--input-type=module',
      '-e',
      code,
      JSON.stringify(input),
    ).trim(),
  );
}
async function wait(network, name, port, path, tls = true) {
  for (let attempt = 0; attempt < 50; attempt++) {
    assert.equal(
      docker('inspect', name, '--format', '{{.State.Running}}').trim(),
      'true',
      'Candidate exited before readiness: ' + name.split('-').at(-1),
    );
    try {
      const result = helper(
        network,
        `import https from 'node:https';import http from 'node:http';import fs from 'node:fs';const p=JSON.parse(process.argv[1]);const result=await new Promise((resolve,reject)=>{const r=(p.tls?https:http).get({hostname:p.name,port:p.port,path:p.path,...(p.tls?{ca:fs.readFileSync('/rehearsal/transport.crt')}:{}),timeout:2000},r=>{let text='';r.on('data',c=>text+=c);r.on('end',()=>resolve({status:r.statusCode,body:JSON.parse(text)}));});r.on('error',reject);r.on('timeout',()=>r.destroy(Error('timeout')));});console.log(JSON.stringify(result));`,
        { name, port, path, tls },
      );
      put(join(currentOutput, name + '-readiness.json'), result);
      if (result.status === 200) return result;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw Error('Candidate readiness did not pass: ' + name.split('-').at(-1));
}
function sqliteSnapshot(network, file, columns) {
  return helper(
    network,
    `import {DatabaseSync} from 'node:sqlite';import {createHash} from 'node:crypto';const p=JSON.parse(process.argv[1]),db=new DatabaseSync('/rehearsal/'+p.file,{readOnly:true});if(db.prepare('PRAGMA integrity_check').all().some(row=>Object.values(row)[0]!=='ok')||db.prepare('PRAGMA foreign_key_check').all().length)throw Error('Restored candidate SQLite integrity failure');const quote=name=> '\"'+name.replaceAll('\"','\"\"')+'\"';const tables=p.columns||Object.fromEntries(db.prepare(\"SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'\").all().map(({name})=>[name,db.prepare('PRAGMA table_info('+quote(name)+')').all().map(row=>row.name)]));const result={};for(const [name,columns] of Object.entries(tables)){const rows=db.prepare('SELECT '+columns.map(quote).join(',')+' FROM '+quote(name)+(p.file==='models/data/router.db'&&name==='RuntimeSetting'?\" WHERE key!='openapi.document'\":'')).all();result[name]={columns,hashes:rows.map(row=>createHash('sha256').update(JSON.stringify(row,(_,value)=>typeof value==='bigint'?value.toString():value)).digest('hex')).sort()};}db.close();console.log(JSON.stringify(result));`,
    { file, columns },
  );
}
function assertRowsPreserved(before, after) {
  for (const [table, state] of Object.entries(before)) {
    const available = new Map();
    for (const hash of after[table].hashes) available.set(hash, (available.get(hash) || 0) + 1);
    for (const hash of state.hashes) {
      assert((available.get(hash) || 0) > 0, 'Candidate changed an existing ' + table + ' row');
      available.set(hash, available.get(hash) - 1);
    }
  }
}
const results = [];
try {
  for (const installation of config.installations) {
    assert(
      (installation.externalPaths || []).every(
        (path) =>
          typeof path === 'string' &&
          /^state\/[A-Za-z0-9_./@+:,=-]+$/.test(path) &&
          !path.split('/').includes('..'),
      ),
      'Invalid external recovery exclusion',
    );
    assert(/^[a-z][a-z0-9-]{0,30}$/.test(installation.id));
    const source = installation.archive
        ? exportApplicationState(installation)
        : realpathSync(installation.restoredRoot),
      manifest = JSON.parse(readFileSync(join(source, 'recovery/manifest.json')));
    assert(
      manifest.host === installation.expectedHost && manifest.schemaVersion === 2,
      'Independent installation ownership mismatch',
    );
    const excluded = (installation.externalPaths || []).map((path) => {
      assert(
        !path.startsWith('/') && !path.split('/').includes('..') && path.startsWith('state/'),
        'External exclusions must be reviewed recovery-relative paths',
      );
      return join(source, path);
    });
    checkNoModels(join(source, 'state'), excluded);
    const copyState = (from, to) =>
      cpSync(from, to, {
        recursive: true,
        filter: (path) => !excluded.some((base) => path === base || path.startsWith(base + '/')),
      });
    let transientSqliteIndexes = 0;
    for (const [name, digest] of Object.entries(manifest.files)) {
      if (
        excluded.some(
          (path) => join(source, name) === path || join(source, name).startsWith(path + '/'),
        )
      )
        continue;
      if (
        name.endsWith('-shm') &&
        readFileSync(join(source, name.slice(0, -4)))
          .subarray(0, 16)
          .toString() === 'SQLite format 3\0'
      ) {
        transientSqliteIndexes++;
        continue;
      }
      assert.equal(
        sha(readFileSync(join(source, name))),
        digest,
        'Restored durable backup bytes changed',
      );
    }
    for (const snapshot of manifest.qdrant)
      assert.equal(
        sha(readFileSync(join(source, 'recovery', snapshot.file))),
        snapshot.sha256,
        'Snapshot checksum mismatch',
      );
    currentOutput = resolve(config.output, installation.id);
    assert(
      relative(source, currentOutput).startsWith('../'),
      'Candidate output must be separate from the retained recovery root',
    );
    assert(!existsSync(currentOutput), 'Preserve existing rehearsal evidence; choose a new output');
    mkdirSync(currentOutput, { recursive: true, mode: 0o700 });
    stateSnapshots = [];
    const prefix = 'hive-rehearsal-' + randomBytes(5).toString('hex'),
      network = prefix + '-isolated';
    docker('network', 'create', '--internal', network);
    networks.push(network);
    const names = Object.fromEntries(
      ['redis', 'qdrant', 'identity', 'models', 'memory', 'skills', 'ui', 'ingress'].map((p) => [
        p,
        prefix + '-' + p,
      ]),
    );
    run('openssl', [
      'req',
      '-x509',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-days',
      '1',
      '-subj',
      '/CN=rehearsal',
      '-addext',
      'subjectAltName=' +
        Object.values(names)
          .map((name) => 'DNS:' + name)
          .join(',') +
        ',DNS:localhost',
      '-keyout',
      join(currentOutput, 'transport.key'),
      '-out',
      join(currentOutput, 'transport.crt'),
    ]);
    const browser = installation.browser ? browserSettings(installation.browser, names) : null;
    const common = {
      NODE_ENV: 'production',
      HIVE_AUTO_MIGRATE: 'false',
      HIVE_AUTO_UPGRADE: 'false',
      HIVE_UPDATE_CHECK: 'false',
      HIVE_HOME: '/data/home',
      HIVE_MANAGED_PROJECT: '',
      HIVE_REHEARSAL: 'true',
      NODE_EXTRA_CA_CERTS: '/config/transport.crt',
    };
    const tls = { TLS_CERT_PATH: '/config/transport.crt', TLS_KEY_PATH: '/config/transport.key' };
    const mountConfig = [
      [join(currentOutput, 'transport.crt'), '/config/transport.crt', true],
      [join(currentOutput, 'transport.key'), '/config/transport.key', true],
    ];
    for (const product of [
      'redis',
      'qdrant',
      'identity',
      'models',
      'memory',
      'skills',
      'ui',
      'ingress',
    ])
      mkdirSync(join(currentOutput, product), { mode: 0o700 });
    start(
      names.redis,
      network,
      images.redis,
      {},
      [[join(currentOutput, 'redis'), '/data', false]],
      ['redis-server', '--save', '', '--appendonly', 'no', '--bind', '0.0.0.0'],
    );
    const snapshots = manifest.qdrant.flatMap((s) => [
      '--snapshot',
      '/snapshots/' + s.file + ':' + s.collection,
    ]);
    start(
      names.qdrant,
      network,
      images.qdrant,
      {
        QDRANT__TELEMETRY_DISABLED: 'true',
        QDRANT__STORAGE__STORAGE_PATH: '/data/storage',
        QDRANT__STORAGE__SNAPSHOTS_PATH: '/data/snapshots',
      },
      [
        [join(currentOutput, 'qdrant'), '/data', false],
        [join(source, 'recovery'), '/snapshots', true],
      ],
      ['./qdrant', '--disable-telemetry', ...snapshots],
    );
    await wait(network, names.qdrant, 6333, '/collections', false);
    // Restore only unexpired sessions; absolute expiry is never extended.
    const redisDump = JSON.parse(readFileSync(join(source, 'recovery/redis.json')));
    put(join(currentOutput, 'redis-restore.json'), redisDump);
    const redisResult = helper(
      network,
      `import net from 'node:net';import fs from 'node:fs';const p=JSON.parse(process.argv[1]),data=JSON.parse(fs.readFileSync('/rehearsal/redis-restore.json'));let restored=0,expired=0;for(const record of data.records){if(record.expiresAt!==null && record.expiresAt<=Date.now()){expired++;continue;}const key=Buffer.from(record.key,'base64'),dump=Buffer.from(record.dump,'base64'),parts=[Buffer.from('RESTORE'),key,Buffer.from(record.expiresAt===null?'0':String(record.expiresAt)),dump,...(record.expiresAt===null?[]:[Buffer.from('ABSTTL')])];await new Promise((resolve,reject)=>{const socket=net.createConnection(6379,p.host,()=>socket.write(Buffer.concat([Buffer.from('*'+parts.length+'\\r\\n'),...parts.flatMap(b=>[Buffer.from('$'+b.length+'\\r\\n'),b,Buffer.from('\\r\\n')])])));socket.on('data',reply=>{socket.end();reply.toString().startsWith('+OK')?resolve():reject(Error('Redis restore rejected'));});socket.on('error',reject);});restored++;}console.log(JSON.stringify({restored,expired}));`,
      { host: names.redis },
    );
    const inventories = () =>
      helper(
        network,
        `import {createHash} from 'node:crypto';const p=JSON.parse(process.argv[1]);const canonical=value=>Array.isArray(value)?value.map(canonical):value&&typeof value==='object'?Object.fromEntries(Object.keys(value).sort().map(key=>[key,canonical(value[key])])):value;const collections=(await (await fetch('http://'+p.host+':6333/collections')).json()).result.collections;const result={};for(const {name} of collections){const url='http://'+p.host+':6333/collections/'+encodeURIComponent(name),data=(await (await fetch(url)).json()).result,hashes=[];let offset;do{const page=(await (await fetch(url+'/points/scroll',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({limit:256,with_vector:true,with_payload:true,...(offset?{offset}:{})})})).json()).result;if(!page)throw Error('Snapshot scroll failed');for(const point of page.points)hashes.push(createHash('sha256').update(JSON.stringify(canonical(point))).digest('hex'));offset=page.next_page_offset;}while(offset);result[name]={points:data.points_count,contentSHA256:createHash('sha256').update(hashes.sort().join('\\n')).digest('hex')};if(hashes.length!==data.points_count)throw Error('Restored collection count differs from scroll');}console.log(JSON.stringify(result));`,
        { host: names.qdrant },
      );
    const before = inventories();
    assert.equal(Object.keys(before).length, manifest.qdrant.length);
    const originalIam = parseEnv(join(source, 'state/opt/hive-iam/.env'));
    const identityData = join(currentOutput, 'identity');
    cpSync(join(source, 'state/opt/hive-iam'), join(identityData, 'state'), { recursive: true });
    mkdirSync(join(identityData, 'keys'), { mode: 0o700 });
    for (const [key, name] of [
      ['JWT_PRIVATE_KEY_PATH', 'private.pem'],
      ['JWT_PUBLIC_KEY_PATH', 'public.pem'],
    ])
      cpSync(fileInside(source, originalIam[key]), join(identityData, 'keys', name));
    const iam = Object.fromEntries(
      Object.entries(originalIam).filter(([key]) =>
        /^(JWT_|COOKIE_SECRET$|IAM_AGENT_SECRET$|REDIS_PREFIX$|AUDIT_|RATE_LIMIT_|MAX_REQUEST_BODY_BYTES$|IAM_MACHINE_CLIENT_POLICIES$)/.test(
          key,
        ),
      ),
    );
    Object.assign(iam, common, tls, {
      HOST: '0.0.0.0',
      PORT: '4200',
      DATABASE_URL: 'file:/data/state/prisma/iam.db',
      IAM_DATA_DIR: '/data/state',
      REDIS_URL: 'redis://' + names.redis + ':6379',
      JWT_PRIVATE_KEY_PATH: '/data/keys/private.pem',
      JWT_PUBLIC_KEY_PATH: '/data/keys/public.pem',
      AUDIT_LOG_DIR: '/data/state/audit-logs',
    });
    if (browser) Object.assign(iam, browser.identity);
    const previousKeys = (originalIam.JWT_PREVIOUS_PUBLIC_KEY_PATHS || '')
      .split(',')
      .map((value) => value.trim())
      .filter(Boolean);
    iam.JWT_PREVIOUS_PUBLIC_KEY_PATHS = previousKeys
      .map((path, index) => {
        cpSync(fileInside(source, path), join(identityData, 'keys', 'previous-' + index + '.pem'));
        return '/data/keys/previous-' + index + '.pem';
      })
      .join(',');
    const originalAudit = originalIam.AUDIT_LOG_DIR || '/opt/hive-iam/audit-logs';
    if (existsSync(join(source, 'state', originalAudit)))
      cpSync(fileInside(source, originalAudit), join(identityData, 'state/audit-logs'), {
        recursive: true,
      });
    start(
      names.identity,
      network,
      images.oathweave,
      iam,
      [[identityData, '/data', false], ...mountConfig],
      ['start'],
    );
    await wait(network, names.identity, 4200, '/api/v1/health/ready');
    const originalRouter = parseEnv(join(source, 'state/opt/hive-router/shared/.env'));
    cpSync(
      join(source, 'state/opt/hive-router/shared/data'),
      join(currentOutput, 'models', 'data'),
      { recursive: true },
    );
    const router = Object.fromEntries(
      Object.entries(originalRouter).filter(
        ([key]) =>
          /^(HIVE_ROUTER_|MAX_|CAPTURE_|PUBLIC_API_URL$|PUBLIC_ADMIN_URL$|HIVE_UI_PUBLIC_URL$|DEFAULT_TRACE_RETENTION_DAYS$)/.test(
            key,
          ) && !key.endsWith('_OS_AUTH_COMMAND'),
      ),
    );
    Object.assign(router, common, tls, {
      API_HOST: '0.0.0.0',
      ADMIN_HOST: '0.0.0.0',
      API_PORT: '9443',
      ADMIN_PORT: '4020',
      DATA_DIR: '/data/data',
      DATABASE_URL: 'file:/data/data/router.db',
      TRACE_DIR: '/data/traces',
      HIVE_IAM_INTERNAL_URL: 'https://' + names.identity + ':4200',
      HIVEMEM_INTERNAL_URL: 'https://' + names.memory + ':18790',
      HIVE_ROUTER_IAM_CA_CERT_PATH: '/config/transport.crt',
      HIVEMEM_CA_CERT_PATH: '/config/transport.crt',
      OTEL_SDK_DISABLED: 'true',
      HIVE_ROUTER_DECISION_MODE: 'off',
    });
    if (browser) Object.assign(router, browser.models);
    start(
      names.models,
      network,
      images.emberpath,
      router,
      [[join(currentOutput, 'models'), '/data', false], ...mountConfig],
      ['start'],
    );
    await wait(network, names.models, 4020, '/health/ready');
    const originalMemory = parseEnv(join(source, 'state/opt/hivemem/.env'));
    copyState(
      fileInside(source, originalMemory.HIVEMEM_STORAGE_PATH || '/var/opt/hivemem'),
      join(currentOutput, 'memory', 'state'),
    );
    const memory = Object.fromEntries(
      Object.entries(originalMemory).filter(([key]) =>
        /^(HIVEMEM_(JWT_|RENEWAL_|ADMIN_TOKEN$|METRICS_|CORS_|VECTOR_DIM$))/.test(key),
      ),
    );
    Object.assign(memory, common, {
      HIVEMEM_TS_CORE_HOST: '0.0.0.0',
      HIVEMEM_WEB_PORT: '18790',
      HIVEMEM_STORAGE_PATH: '/data/state',
      HIVEMEM_QDRANT_URL: 'http://' + names.qdrant + ':6333',
      HIVEMEM_TS_PERSISTENCE: 'qdrant',
      HIVEMEM_WORKER_ENABLED: 'false',
      HIVEMEM_TLS_CERT_FILE: '/config/transport.crt',
      HIVEMEM_TLS_KEY_FILE: '/config/transport.key',
    });
    start(
      names.memory,
      network,
      images.hivemem,
      memory,
      [[join(currentOutput, 'memory'), '/data', false], ...mountConfig],
      ['start'],
    );
    await wait(network, names.memory, 18790, '/v1/health/ready');
    let skills = 'not-installed';
    let archiveIntegrity = { archives: 0, status: 'not-installed' };
    const skillsEnv = join(source, 'state/opt/hive-skills/shared/.env');
    if (existsSync(skillsEnv)) {
      const original = parseEnv(skillsEnv);
      cpSync(
        fileInside(source, original.HIVE_SKILLS_DATA_DIR),
        join(currentOutput, 'skills', 'state'),
        { recursive: true },
      );
      const env = {
        ...common,
        HIVE_SKILLS_HOST: '0.0.0.0',
        HIVE_SKILLS_PORT: '4030',
        HIVE_SKILLS_DATA_DIR: original.HIVE_SKILLS_DATA_DIR,
        HIVE_SKILLS_SESSION_SECRET: original.HIVE_SKILLS_SESSION_SECRET,
        HIVE_SKILLS_ADMIN_USERS: original.HIVE_SKILLS_ADMIN_USERS || '',
        HIVE_SKILLS_TLS_CERT_FILE: '/config/transport.crt',
        HIVE_SKILLS_TLS_KEY_FILE: '/config/transport.key',
        HIVE_SKILLS_DEPLOY_SCRIPT: '/disabled-in-rehearsal',
        HIVE_SKILLS_DEPLOYMENT_WORKER_ENABLED: 'false',
      };
      start(
        names.skills,
        network,
        images.hiveskills,
        env,
        [
          [join(currentOutput, 'skills'), '/data', false],
          [join(currentOutput, 'skills', 'state'), original.HIVE_SKILLS_DATA_DIR, false],
          ...mountConfig,
        ],
        ['start'],
      );
      await wait(network, names.skills, 4030, '/healthz');
      archiveIntegrity = helper(
        network,
        `import {DatabaseSync} from 'node:sqlite';import fs from 'node:fs';import path from 'node:path';import {createHash} from 'node:crypto';const p=JSON.parse(process.argv[1]),db=new DatabaseSync('/rehearsal/skills/state/registry.sqlite',{readOnly:true}),releases=db.prepare('SELECT archive_path,sha256 FROM releases').all();for(const row of releases){const relative=path.relative(p.originalData,row.archive_path);if(relative.startsWith('..')||path.isAbsolute(relative))throw Error('Release archive escapes reviewed product storage');if(createHash('sha256').update(fs.readFileSync(path.join('/rehearsal/skills/state',relative))).digest('hex')!==row.sha256)throw Error('Immutable skill archive digest differs');}db.close();console.log(JSON.stringify({archives:releases.length,status:'verified'}));`,
        { originalData: original.HIVE_SKILLS_DATA_DIR },
      );
      skills = 'ready';
    }
    for (const state of stateSnapshots) {
      const columns = Object.fromEntries(
        Object.entries(state.before).map(([name, value]) => [name, value.columns]),
      );
      assertRowsPreserved(state.before, sqliteSnapshot(network, state.file, columns));
    }
    const after = inventories();
    assert.deepEqual(after, before, 'Candidate startup changed restored collection counts/status');
    for (const [key, name] of [
      ['JWT_PRIVATE_KEY_PATH', 'private.pem'],
      ['JWT_PUBLIC_KEY_PATH', 'public.pem'],
    ])
      assert.equal(
        sha(readFileSync(join(identityData, 'keys', name))),
        sha(readFileSync(fileInside(source, originalIam[key]))),
        'Candidate rotated an existing signing key',
      );
    const browserProof = browser
      ? await browserRehearsal({
          browser: installation.browser,
          settings: browser,
          names,
          output: currentOutput,
          network,
          images,
          start,
          helper,
          docker,
          put,
          networks,
          username: originalIam.SEED_ADMIN_USERNAME,
        })
      : null;
    let nativeCredentials = { status: 'not-requested' };
    if (config.verifyExistingCredentials === true) {
      put(join(currentOutput, 'rehearsal-credentials.json'), {
        username: originalIam.SEED_ADMIN_USERNAME,
        password: originalIam.SEED_ADMIN_PASSWORD,
        issuer: originalIam.JWT_ISSUER,
        memoryToken:
          originalMemory.HIVEMEM_ADMIN_TOKEN || originalRouter.HIVE_ROUTER_MEMORY_PROXY_TOKEN,
        modelToken: originalRouter.SEED_CLIENT_API_KEY,
      });
      nativeCredentials = helper(
        network,
        `import https from 'node:https';import fs from 'node:fs';const p=JSON.parse(process.argv[1]),c=JSON.parse(fs.readFileSync('/rehearsal/rehearsal-credentials.json'));async function request(name,port,path,body,token){return new Promise((resolve,reject)=>{const r=https.request({hostname:name,port,path,method:body?'POST':'GET',ca:fs.readFileSync('/rehearsal/transport.crt'),headers:{'Content-Type':'application/json',...(token?{Authorization:'Bearer '+token}:{})},timeout:5000},r=>{let text='';r.on('data',b=>text+=b);r.on('end',()=>resolve({status:r.statusCode,body:JSON.parse(text)}));});r.on('error',reject);r.on('timeout',()=>r.destroy(Error('Credential probe timeout')));if(body)r.write(JSON.stringify(body));r.end();});}const result={status:'completed',passwordReset:false};if(c.username&&c.password){const login=await request(p.identity,4200,'/api/v1/auth/login',{username:c.username,password:c.password});result.identity=login.status===200&&login.body.accessToken?'authenticated':login.body.mfaRequired?'mfa-required':'saved-credential-not-accepted';if(login.body.accessToken){const claims=JSON.parse(Buffer.from(login.body.accessToken.split('.')[1],'base64url'));if(claims.iss!==c.issuer)throw Error('Native issuer changed');result.nativeIssuerPreserved=true;}}else result.identity='no-saved-credential';if(c.modelToken)result.models=(await request(p.models,9443,'/v1/models',null,c.modelToken)).status===200?'authenticated':'saved-credential-not-accepted';else result.models='no-saved-credential';if(c.memoryToken)result.memory=(await request(p.memory,18790,'/v1/stats',null,c.memoryToken)).status===200?'authenticated':'saved-credential-not-accepted';else result.memory='no-saved-credential';console.log(JSON.stringify(result));`,
        names,
      );
    }
    const result = {
      schema: 1,
      installation: installation.id,
      snapshotAt: manifest.createdAt,
      images,
      networkInternal: true,
      durableSqliteRowsPreserved: true,
      signingKeysPreserved: true,
      previousVerificationKeys: previousKeys.length,
      skillArchiveIntegrity: archiveIntegrity,
      nativeCredentialChecks: nativeCredentials,
      browserRehearsal: browserProof,
      regeneratedMetadata: ['emberpath.openapi.document'],
      transientSqliteIndexes,
      services: { oathweave: 'ready', emberpath: 'ready', hivemem: 'ready', hiveskills: skills },
      qdrant: {
        collections: Object.keys(before).length,
        points: Object.values(before).reduce((sum, v) => sum + v.points, 0),
        countsPreserved: true,
        contentPreserved: true,
      },
      redis: redisResult,
      inference: {
        external: true,
        servicesStarted: 0,
        modelFilesRestored: 0,
        externalProbesPerformed: false,
      },
      authenticatedBrowserAcceptance: false,
      productionCutover: false,
    };
    put(join(currentOutput, 'result.json'), result);
    results.push(result);
    console.log(
      JSON.stringify({
        installation: installation.id,
        services: result.services,
        qdrant: result.qdrant,
        redis: redisResult,
        productionCutover: false,
      }),
    );
  }
  put(resolve(config.output, 'results.json'), results);
} catch (error) {
  if (currentOutput)
    put(join(currentOutput, 'failure.json'), { message: String(error), productionCutover: false });
  console.error(
    'Rehearsal held; private logs and restored copies retained. ' + String(error.message),
  );
  process.exitCode = 1;
} finally {
  for (const name of containers.reverse()) {
    try {
      if (currentOutput) {
        const log = spawnSync('docker', ['logs', name], { encoding: 'utf8', env: cleanEnv });
        put(join(dirname(currentOutput), name + '.log'), log.stdout + '\n' + log.stderr);
      }
    } catch {}
    try {
      docker('rm', '-f', name);
    } catch {}
  }
  for (const name of networks.reverse())
    try {
      docker('network', 'rm', name);
    } catch {}
}
