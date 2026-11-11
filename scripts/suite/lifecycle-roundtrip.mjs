#!/usr/bin/env node
// Disposable developer acceptance. Node is not a controller/host prerequisite.
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
  chmodSync,
  cpSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { fixtureCatalog, hiveRegistryComponent } from './suite-catalog.mjs';
import { startRegistryImage } from './registry-image-fixture.mjs';
const root = resolve(import.meta.dirname, '../..');
const temp = mkdtempSync(join(tmpdir(), 'hive-lifecycle-'));
const owned = join(temp, 'installation');
const id = 'test-' + randomBytes(5).toString('hex');
const environment = Object.fromEntries(
  ['PATH', 'LANG', 'LC_ALL', 'TZ'].filter((k) => process.env[k]).map((k) => [k, process.env[k]]),
);
const execute = (cmd, args, options = {}) =>
  execFileSync(cmd, args, {
    encoding: 'utf8',
    env: environment,
    stdio: ['ignore', 'pipe', 'pipe'],
    ...options,
  });
const put = (path, value) => {
  writeFileSync(path, typeof value === 'string' ? value : JSON.stringify(value, null, 2));
  chmodSync(path, 0o600);
};
const configPath = join(temp, 'installation.json');
const image =
  'node:24.22.3-slim@sha256:dc26ae92c9fb15cf6b1d63e20f0944b2efe0f115b20e00be48fb23fceb061c54';
const projects = new Set();
let passed = false, registryImage;
try {
  registryImage = await startRegistryImage(id);
  mkdirSync(join(owned, 'config', 'probe'), { recursive: true, mode: 0o700 });
  put(join(owned, 'config', 'probe.env'), 'SYNTHETIC_TEST=fixture\n');
  put(
    join(owned, 'config', 'probe', 'service.mjs'),
    `import {DatabaseSync} from 'node:sqlite';
import http from 'node:http';
const db=new DatabaseSync('/data/state.sqlite');
db.exec('CREATE TABLE IF NOT EXISTS accounts(id TEXT PRIMARY KEY, name TEXT); CREATE TABLE IF NOT EXISTS counters(name TEXT PRIMARY KEY,value INTEGER);');
if(process.argv[2]==='migrate'||process.argv[2]==='uncertain'){
 db.exec("ALTER TABLE accounts ADD COLUMN label TEXT; INSERT INTO counters VALUES('migration',1);");
 if(process.argv[2]==='uncertain' && process.env.HIVE_REHEARSAL!=='true'){db.close();process.exit(23);}
 db.close();process.exit(0);
}
db.exec("INSERT OR IGNORE INTO accounts VALUES('synthetic-id','Synthetic operator'); INSERT OR IGNORE INTO counters VALUES('enrollment',1);");
const server=http.createServer((req,res)=>{res.setHeader('Content-Type','application/json');res.end(JSON.stringify(db.prepare('SELECT id,name FROM accounts').all()));}).listen(8080,'0.0.0.0');
process.on('SIGTERM',()=>server.close(()=>{db.close();process.exit(0);}));
`,
  );
  // A migration adds a column; explicit column names keep the fixture's startup idempotent.
  const script = join(owned, 'config', 'probe', 'service.mjs');
  put(
    script,
    readFileSync(script, 'utf8').replace(
      'INSERT OR IGNORE INTO accounts VALUES',
      'INSERT OR IGNORE INTO accounts(id,name) VALUES',
    ),
  );
  execute('openssl', ['genpkey', '-algorithm', 'ED25519', '-out', join(temp, 'publisher.key')]);
  execute('openssl', [
    'pkey',
    '-in',
    join(temp, 'publisher.key'),
    '-pubout',
    '-out',
    join(temp, 'publisher.pub'),
  ]);
  const releases = new Map();
  for (const [version, format, from, mode] of [
    ['0.1.0', 'one'],
    ['0.2.0', 'two', 'one', 'migrate'],
    ['0.3.0', 'three', 'one', 'uncertain'],
  ]) {
    const manifest = {
      schema: 1,
      version,
      profiles: { core: ['probe', 'hive-registry'], full: ['probe', 'hive-registry'] },
      components: {
        'hive-registry': hiveRegistryComponent(registryImage.image, `${process.getuid()}:${process.getgid()}`),
        probe: {
          image,
          catalog: fixtureCatalog('probe'),
          storageFormat: format,
          readableFormats: [format],
          ...(from ? { migration: { from, command: ['node', '/config/service.mjs', mode] } } : {}),
          service: {
            user: `${process.getuid()}:${process.getgid()}`,
            command: ['node', '/config/service.mjs'],
            healthcheck: {
              test: [
                'CMD',
                'node',
                '-e',
                "fetch('http://127.0.0.1:8080/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))",
              ],
              interval: '1s',
              timeout: '3s',
              retries: 10,
            },
          },
        },
      },
    };
    // The controller forbids UID zero. Tests run as the normal operator.
    assert.notEqual(
      process.getuid(),
      0,
      'Run acceptance as an unprivileged operator with Docker access',
    );
    const file = join(temp, version + '.json');
    put(file, manifest);
    execute('openssl', [
      'pkeyutl',
      '-sign',
      '-inkey',
      join(temp, 'publisher.key'),
      '-rawin',
      '-in',
      file,
      '-out',
      file + '.sig',
    ]);
    releases.set(version, file);
  }
  put(configPath, {
    schema: 1,
    installation: id,
    release: '0.1.0',
    profile: 'custom',
    origin: 'https://console.example.com',
    hosts: { control: { target: 'local', directory: owned } },
    components: {
      'hive-registry': { host: 'control', envFile: join(owned, 'config', 'hive-registry.env'), configDirectory: join(owned, 'config', 'hive-registry') },
      probe: {
        host: 'control',
        envFile: join(owned, 'config', 'probe.env'),
        configDirectory: join(owned, 'config', 'probe'),
      },
    },
    agents: [],
    inference: [],
  });
  const cli = (command, version = '0.1.0', extra = [], ok = true) => {
    const file = releases.get(version);
    const result = spawnSync(
      join(root, 'hive.sh'),
      [
        command,
        '--config',
        configPath,
        '--release',
        version,
        '--manifest',
        file,
        '--signature',
        file + '.sig',
        '--trust-key',
        join(temp, 'publisher.pub'),
        '--non-interactive',
        '--yes',
        ...extra,
      ],
      { env: environment, encoding: 'utf8' },
    );
    put(join(temp, command + '-' + version + '.log'), result.stdout + '\n' + result.stderr);
    assert.equal(
      result.status === 0,
      ok,
      command + ' ' + version + ': ' + result.stderr.slice(-1200),
    );
    return result;
  };
  const compose = join(owned, 'compose.json');
  projects.add(compose);
  const sql = (query) =>
    execute('docker', [
      'compose',
      '-f',
      compose,
      'exec',
      '-T',
      'probe',
      'node',
      '--input-type=module',
      '-e',
      `import {DatabaseSync} from 'node:sqlite'; const db=new DatabaseSync('/data/state.sqlite',{readOnly:true});console.log(JSON.stringify(db.prepare(${JSON.stringify(query)}).all()));db.close();`,
    ]);
  cli('install');
  const identity = readFileSync(join(owned, 'installation.json'), 'utf8');
  cli('install');
  assert.equal(readFileSync(join(owned, 'installation.json'), 'utf8'), identity);
  assert.equal(JSON.parse(sql("SELECT value FROM counters WHERE name='enrollment'"))[0].value, 1);
  cli('backup', '0.1.0', ['--archive', 'baseline']);
  // A legacy combined archive must never launch or restore its inference service.
  const obsolete = join(owned, 'backups', 'obsolete'),
    exported = join(temp, 'obsolete-export');
  cpSync(join(owned, 'backups', 'baseline'), obsolete, { recursive: true });
  mkdirSync(exported, { mode: 0o700 });
  execute('tar', ['-xzf', join(obsolete, 'state.tar.gz'), '-C', exported]);
  const oldCompose = JSON.parse(readFileSync(join(exported, 'compose.json')));
  oldCompose.services['inference-retained'] = { ...oldCompose.services.probe };
  put(join(exported, 'compose.json'), oldCompose);
  execute('tar', [
    '-czf',
    join(obsolete, 'state.tar.gz'),
    '-C',
    exported,
    'data',
    'config',
    'releases',
    'compose.json',
    'receipt.json',
    'installation.json',
    'data-formats.json',
  ]);
  const oldReceipt = JSON.parse(readFileSync(join(obsolete, 'receipt.json')));
  oldReceipt.sha256 = createHash('sha256')
    .update(readFileSync(join(obsolete, 'state.tar.gz')))
    .digest('hex');
  put(join(obsolete, 'receipt.json'), oldReceipt);
  const refusal = cli('rehearse', '0.1.0', ['--archive', 'obsolete'], false);
  assert.match(refusal.stderr, /Obsolete managed-inference archive/);
  assert.equal(JSON.parse(sql("SELECT value FROM counters WHERE name='enrollment'"))[0].value, 1);
  // Weights hidden in an otherwise ordinary service are external too.
  const weightsArchive = join(owned, 'backups', 'obsolete-weights');
  cpSync(join(owned, 'backups', 'baseline'), weightsArchive, { recursive: true });
  delete oldCompose.services['inference-retained'];
  put(join(exported, 'compose.json'), oldCompose);
  put(join(exported, 'data', 'probe', 'retained.GGUF'), 'synthetic-model-fixture');
  execute('tar', [
    '-czf',
    join(weightsArchive, 'state.tar.gz'),
    '-C',
    exported,
    'data',
    'config',
    'releases',
    'compose.json',
    'receipt.json',
    'installation.json',
    'data-formats.json',
  ]);
  const weightsReceipt = JSON.parse(readFileSync(join(weightsArchive, 'receipt.json')));
  weightsReceipt.sha256 = createHash('sha256')
    .update(readFileSync(join(weightsArchive, 'state.tar.gz')))
    .digest('hex');
  put(join(weightsArchive, 'receipt.json'), weightsReceipt);
  const weightRefusal = cli('rehearse', '0.1.0', ['--archive', 'obsolete-weights'], false);
  assert.match(weightRefusal.stderr, /Obsolete managed-inference archive/);
  assert.equal(
    readFileSync(join(exported, 'data', 'probe', 'retained.GGUF'), 'utf8'),
    'synthetic-model-fixture',
  );
  assert.equal(JSON.parse(sql("SELECT value FROM counters WHERE name='enrollment'"))[0].value, 1);
  cli('rehearse', '0.1.0', ['--archive', 'baseline']);
  const rehearsal = join(owned, 'rehearsals', 'baseline', 'isolated.json');
  projects.add(rehearsal);
  assert.equal(JSON.parse(readFileSync(rehearsal)).networks.default.internal, true);
  assert.equal(JSON.parse(readFileSync(rehearsal)).services.probe.ports, undefined);
  cli('upgrade', '0.2.0', ['--archive', 'before-two'], false); // Missing migration approval fails before stopping writers.
  assert.equal(JSON.parse(sql("SELECT value FROM counters WHERE name='enrollment'"))[0].value, 1);
  cli('upgrade', '0.2.0', ['--archive', 'before-two', '--allow-migrations']);
  projects.add(join(owned, 'rehearsals', 'before-two', 'isolated.json'));
  assert.equal(JSON.parse(sql("SELECT value FROM counters WHERE name='migration'"))[0].value, 1);
  cli('rollback', '0.1.0', [], false); // The older binary cannot read format two.
  // The rejected rollback leaves a prepared read-only transaction. Explicit recovery
  // is required; do not silently erase it to make the rest of acceptance pass.
  const pending = JSON.parse(readFileSync(join(owned, 'transaction.json')));
  assert.equal(pending.operation, 'rollback');
  // Measured stopped: SQLite's WAL sidecars change when a store closes cleanly.
  execute('docker', ['compose', '-f', compose, 'stop', '--timeout', '30']);
  const current = execute('bash', [
    '-c',
    'cd "$1/data"; find . -type f -print0 | sort -z | xargs -0 -r sha256sum --zero | sha256sum | cut -d " " -f1',
    'bash',
    owned,
  ]).trim();
  const archive = JSON.parse(readFileSync(join(owned, 'backups', 'baseline', 'receipt.json')));
  const reconcile = join(temp, 'reconciliation.json');
  put(reconcile, {
    hosts: {
      control: {
        installationUUID: JSON.parse(identity).uuid,
        archiveSHA256: archive.sha256,
        currentDataSHA256: current,
        subsequentWritesReconciled: true,
      },
    },
  });
  cli('restore', '0.1.0', ['--archive', 'baseline', '--reconciliation', reconcile]);
  assert.equal(JSON.parse(sql('SELECT id,name FROM accounts'))[0].id, 'synthetic-id');
  // The restored registry describes the restored installation.
  assert.match(cli('doctor').stdout, /Hive Registry: in sync/);
  assert.equal(
    JSON.parse(sql("SELECT count(*) AS total FROM counters WHERE name='migration'"))[0].total,
    0,
  );
  cli('upgrade', '0.3.0', ['--archive', 'before-uncertain', '--allow-migrations'], false);
  projects.add(join(owned, 'rehearsals', 'before-uncertain', 'isolated.json'));
  assert.equal(
    JSON.parse(readFileSync(join(owned, 'transaction.json'))).phase,
    'migration-started',
  );
  cli('upgrade', '0.3.0', ['--archive', 'before-uncertain', '--allow-migrations'], false);
  assert.equal(
    JSON.parse(readFileSync(join(owned, 'transaction.json'))).phase,
    'migration-started',
  );
  passed = true;
  console.log(
    'PASS: real container lifecycle, repeat install, verified backup, isolated restore rehearsal, exact migration, incompatible rollback refusal, reconciled restore and unknown-outcome hold.',
  );
} finally {
  for (const file of projects)
    try {
      execute('docker', ['compose', '-f', file, 'down', '--timeout', '10']);
    } catch {}
  registryImage?.stop();
  if (passed) rmSync(temp, { recursive: true, force: true });
  else console.error('Private lifecycle evidence retained at ' + temp);
}
