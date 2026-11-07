#!/usr/bin/env node
// Disposable developer acceptance for the online backup, with real containers: hive.sh backup
// while writers keep writing to SQLite (WAL and rollback journal), append-only and replaced
// files, Redis, Qdrant and PostgreSQL. Node is not a controller/host prerequisite.
//
// Proves: no service stops or restarts; requests wait at most for the measured pause; every
// store in the archive holds the state of the pause instant, in the writer's own write order;
// the archive verifies, rehearses and restores; stopped archives, including ones written by
// an earlier controller (--old-controller DIR), still rehearse and restore; a failed backup
// leaves every service serving, keeps no archive, and removes no other archive.
// Every pause must stay within a budget (--pause-budget SECONDS, default 5) on a data set of a
// real installation's size (--seed-scale, default 1: about 500 MiB, with 80 Qdrant collections and
// 30,000 vectors, a large SQLite database that keeps being written and one that is not, and Redis
// keys), so a pause that grows with the data fails the acceptance.
// Usage: online-backup-roundtrip.mjs [--old-controller EXTRACTED_RELEASE] [--seed-scale N] [--pause-budget SECONDS] [--keep]
// Inside scripts/suite/sudo-host.sh the host side runs as root through sudo -S over SSH, as on a
// production host (npm run test:suite:online-backup:sudo).
import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fixtureCatalog, hiveRegistryComponent } from './suite-catalog.mjs';
import { startRegistryImage } from './registry-image-fixture.mjs';
import { serviceGid, serviceUid, serviceUser, startSudoTarget, sudoHost } from './sudo-target.mjs';

const root = resolve(import.meta.dirname, '../..');
const argument = (name) => { const index = process.argv.indexOf(name); return index > 0 ? process.argv[index + 1] : undefined; };
const oldController = argument('--old-controller') && resolve(argument('--old-controller'));
const keep = process.argv.includes('--keep');
const seedScale = Number(argument('--seed-scale') ?? 1);
const pauseBudget = Number(argument('--pause-budget') ?? 5);
assert(seedScale >= 0 && pauseBudget > 0, 'Usage: --seed-scale N --pause-budget SECONDS');
const temp = mkdtempSync(join(tmpdir(), 'hive-online-backup-'));
const owned = join(temp, 'installation');
const id = 'online-' + randomBytes(4).toString('hex');
const user = serviceUser;
const environment = Object.fromEntries(['PATH', 'LANG', 'LC_ALL', 'TZ'].filter((k) => process.env[k]).map((k) => [k, process.env[k]]));
const execute = (cmd, args, options = {}) => execFileSync(cmd, args, { encoding: 'utf8', env: environment, stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024, ...options });
const docker = (...args) => execute('docker', args).trim();
const put = (path, value, mode = 0o600) => { writeFileSync(path, typeof value === 'string' ? value : JSON.stringify(value, null, 2)); chmodSync(path, mode); };
const sha = (value) => createHash('sha256').update(value).digest('hex');
const say = (text) => console.log(new Date().toISOString().slice(11, 19) + ' ' + text);
assert(sudoHost || process.getuid() !== 0, 'Run acceptance as an unprivileged operator with Docker access');
// The host entry: local as the operator, or production-like through SSH and sudo.
const target = sudoHost ? await startSudoTarget(join(temp, 'sudo-target')) : null;
const hostEntry = target ? { target: target.target, sshConfig: target.sshConfig, sudoPasswordFile: target.sudoPasswordFile } : { target: 'local' };

const release = JSON.parse(readFileSync(join(root, 'releases/2.0.1.json'), 'utf8'));
const images = { node: 'node:24.22.1-slim@sha256:55fb5f5a527ea2c5c4a95f963e48ef90aa38c7b346054fdc8ee9957a2b55d205', redis: release.components['oathweave-redis'].image, qdrant: release.components['hivemem-qdrant'].image, postgres: release.components['magnus-postgres'].image };
const secrets = { redis: randomBytes(18).toString('hex'), qdrant: randomBytes(18).toString('hex'), postgres: randomBytes(18).toString('hex') };

// One tick writes every store of the probe in this order, so a restored copy taken at one
// instant can differ between stores by at most the single tick in flight, and only downwards
// along this order: wal >= journal >= log >= state >= redis >= qdrant >= wal - 1.
const probe = `import { DatabaseSync } from 'node:sqlite';
import { appendFileSync, existsSync, renameSync, writeFileSync } from 'node:fs';
import { createConnection } from 'node:net';
import { randomBytes } from 'node:crypto';
import http from 'node:http';
const wal = new DatabaseSync('/data/wal.db'); wal.exec('PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS ticks(n INTEGER PRIMARY KEY, at INTEGER)');
const journal = new DatabaseSync('/data/journal.db'); journal.exec('PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS ticks(n INTEGER PRIMARY KEY, at INTEGER)');
if (!existsSync('/data/blob.bin')) writeFileSync('/data/blob.bin', randomBytes(48 * 1024 * 1024));
let n = wal.prepare('SELECT coalesce(max(n),0) AS n FROM ticks').get().n;
const socket = createConnection(6379, 'probe-redis'); let buffer = '', waiting = [];
socket.on('data', (chunk) => { buffer += chunk; let end; while (waiting.length && (end = buffer.indexOf('\\r\\n')) >= 0) { const line = buffer.slice(0, end); buffer = buffer.slice(end + 2); waiting.shift()(line); } });
const redis = (...parts) => new Promise((done) => { waiting.push(done); socket.write('*' + parts.length + '\\r\\n' + parts.map((p) => '$' + Buffer.byteLength(String(p)) + '\\r\\n' + p + '\\r\\n').join('')); });
await redis('AUTH', process.env.REDIS_PASSWORD);
const qdrant = (path, method, body) => fetch('http://probe-qdrant:6333' + path, { method, headers: { 'api-key': process.env.QDRANT_KEY, 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then((r) => { if (!r.ok) throw Error('qdrant ' + r.status); return r.json(); });
await fetch('http://probe-qdrant:6333/collections/ticks', { method: 'PUT', headers: { 'api-key': process.env.QDRANT_KEY, 'Content-Type': 'application/json' }, body: JSON.stringify({ vectors: { size: 4, distance: 'Cosine' } }) });
const insertWal = wal.prepare('INSERT INTO ticks VALUES (?, ?)'), insertJournal = journal.prepare('INSERT INTO ticks VALUES (?, ?)');
// A data set of a real installation's size, written once before the probe serves: many Qdrant
// collections, mostly small, a few with thousands of vectors; a large rollback-journal database
// that the ticks keep writing; a large database nothing writes, such as a kept migration copy;
// and Redis keys.
const scale = Number(process.env.SEED_SCALE || 0), seeded = scale > 0;
const sizes = [11785, 8944, 2814, 1631, 1296, 900, 729, 189, 139, 134, 119, 113, 111, 88, 85, ...Array(22).fill(0), ...Array.from({ length: 43 }, (_, i) => (i * 37) % 80 + 1)].map((n) => Math.round(n * scale));
const seedName = (index) => 'seed-' + String(index).padStart(2, '0');
const seedVector = (index, value) => Array.from({ length: index % 3 ? 768 : 4 }, (_, k) => Math.sin(value * 31 + k));
if (seeded && !existsSync('/data/seeded')) {
  const pad = (database, mib) => { database.exec('CREATE TABLE IF NOT EXISTS pad(id INTEGER PRIMARY KEY, b BLOB)'); const insert = database.prepare('INSERT INTO pad(b) VALUES (?)'); database.exec('BEGIN'); for (let i = 0; i < mib * 16; i++) insert.run(randomBytes(65536)); database.exec('COMMIT'); };
  pad(journal, Math.round(96 * scale));
  const archive = new DatabaseSync('/data/archive.db'); pad(archive, Math.round(96 * scale)); archive.close();
  await Promise.all(Array.from({ length: Math.round(16384 * scale) }, (_, i) => redis('SET', 'pad:' + i, randomBytes(512).toString('hex'))));
  const words = 'memory agent vector backup pause store collection writer reader point payload consistent snapshot restore journal'.split(' ');
  const queue = sizes.map((count, index) => [index, count]);
  await Promise.all(Array.from({ length: 8 }, async () => {
    while (queue.length) {
      const [index, count] = queue.shift();
      await fetch('http://probe-qdrant:6333/collections/' + seedName(index), { method: 'PUT', headers: { 'api-key': process.env.QDRANT_KEY, 'Content-Type': 'application/json' }, body: JSON.stringify({ vectors: { size: index % 3 ? 768 : 4, distance: 'Cosine' } }) });
      for (let offset = 0; offset < count; offset += 128) {
        const points = [];
        for (let k = offset; k < Math.min(count, offset + 128); k++) points.push({ id: k + 1, vector: seedVector(index, k), payload: { id: seedName(index) + ':' + k, content: Array.from({ length: 200 }, (_, w) => words[(k * 7 + w * 13) % words.length]).join(' '), created_at: new Date(0).toISOString() } });
        await qdrant('/collections/' + seedName(index) + '/points?wait=true', 'PUT', { points });
      }
    }
  }));
  // As on a serving installation, the optimizer has finished with every collection.
  for (let index = 0; index < sizes.length; index++) {
    for (;;) { const info = await fetch('http://probe-qdrant:6333/collections/' + seedName(index), { headers: { 'api-key': process.env.QDRANT_KEY } }).then((r) => r.json()); if (info.result.status === 'green') break; await new Promise((done) => setTimeout(done, 200)); }
  }
  writeFileSync('/data/seeded', '');
}
http.createServer((req, res) => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ n })); }).listen(8080, '0.0.0.0');
const rehearsal = process.env.HIVE_REHEARSAL === 'true';
for (;;) {
  await new Promise((done) => setTimeout(done, 20));
  if (rehearsal) continue;
  const next = n + 1, at = Date.now();
  insertWal.run(next, at); insertJournal.run(next, at);
  appendFileSync('/data/events.log', next + '\\n');
  writeFileSync('/data/state.json.next', JSON.stringify({ n: next })); renameSync('/data/state.json.next', '/data/state.json');
  await redis('SET', 'tick', next); await redis('SET', 'expiring:' + next, 'x', 'PX', 600000);
  await qdrant('/collections/ticks/points?wait=true', 'PUT', { points: [{ id: next, vector: [1, next % 7, 2, 3], payload: { n: next } }] });
  // A product also writes now and then to one of its larger collections.
  if (seeded && next % 25 === 0) await qdrant('/collections/' + seedName(1) + '/points?wait=true', 'PUT', { points: [{ id: 1000000 + next, vector: seedVector(1, next), payload: { id: 'tick:' + next, content: 'tick ' + next } }] });
  n = next;
}
`;
const ledger = `set -euo pipefail
export PGPASSWORD=$(cat /config/password)
q() { psql -h ledger-postgres -U ledger -d ledger -qAtX -v ON_ERROR_STOP=1 -c "$1"; }
until q 'SELECT 1' >/dev/null 2>&1; do sleep 0.5; done
q 'CREATE TABLE IF NOT EXISTS ticks(n bigint PRIMARY KEY, at timestamptz NOT NULL DEFAULT clock_timestamp())'
n=$(q 'SELECT coalesce(max(n),0) FROM ticks'); touch /data/ledger.log
while :; do
  sleep 0.05
  [[ "\${HIVE_REHEARSAL:-}" != true ]] || continue
  n=$((n + 1)); q "INSERT INTO ticks(n) VALUES ($n)"; printf '%s\\n' "$n" >> /data/ledger.log
done
`;

const projects = new Set();
let registryImage, passed = false;
const report = { schema: 1, startedAt: new Date().toISOString() };
try {
  registryImage = await startRegistryImage(id);
  for (const name of ['probe', 'probe-redis', 'probe-qdrant', 'ledger', 'ledger-postgres', 'hive-registry']) mkdirSync(join(owned, 'config', name), { recursive: true, mode: 0o700 });
  put(join(owned, 'config', 'probe', 'service.mjs'), probe);
  put(join(owned, 'config', 'probe.env'), `REDIS_PASSWORD=${secrets.redis}\nQDRANT_KEY=${secrets.qdrant}\nSEED_SCALE=${seedScale}\n`);
  put(join(owned, 'config', 'probe-redis', 'redis.conf'), `bind 0.0.0.0\nprotected-mode yes\ndir /data\nappendonly yes\nappendfsync everysec\nrequirepass ${secrets.redis}\n`);
  put(join(owned, 'config', 'probe-qdrant', 'qdrant.yaml'), `log_level: WARN\ntelemetry_disabled: true\nstorage:\n  storage_path: /data/storage\n  snapshots_path: /data/snapshots\nservice:\n  host: 0.0.0.0\n  http_port: 6333\n  api_key: ${secrets.qdrant}\n`);
  put(join(owned, 'config', 'ledger', 'ledger.sh'), ledger);
  put(join(owned, 'config', 'ledger', 'password'), secrets.postgres);
  put(join(owned, 'config', 'ledger.env'), 'LEDGER=fixture\n');
  put(join(owned, 'config', 'ledger-postgres', 'password'), secrets.postgres);
  put(join(owned, 'config', 'probe-redis.env'), 'FIXTURE=redis\n'); put(join(owned, 'config', 'probe-qdrant.env'), 'FIXTURE=qdrant\n'); put(join(owned, 'config', 'ledger-postgres.env'), 'FIXTURE=postgres\n');
  // The fixture's own service configuration belongs to the service account, as an operator would
  // prepare it; everything else on the host is created by the host side itself.
  if (sudoHost) execute('chown', ['-R', serviceUser, join(owned, 'config')]);
  execute('openssl', ['genpkey', '-algorithm', 'ED25519', '-out', join(temp, 'publisher.key')]);
  execute('openssl', ['pkey', '-in', join(temp, 'publisher.key'), '-pubout', '-out', join(temp, 'publisher.pub')]);
  const datastore = (name, format) => ({ ...release.components[name], kind: 'datastore', storageFormat: format, readableFormats: [format], catalog: fixtureCatalog(name), service: { ...release.components[name].service, user, networks: ['default'] } });
  const manifest = {
    schema: 1, version: '0.1.0',
    profiles: { core: ['hive-registry', 'probe', 'probe-redis', 'probe-qdrant', 'ledger', 'ledger-postgres'], full: ['hive-registry', 'probe', 'probe-redis', 'probe-qdrant', 'ledger', 'ledger-postgres'] },
    components: {
      'hive-registry': hiveRegistryComponent(registryImage.image, user),
      'probe-redis': datastore('oathweave-redis', 'redis-aof-v1'),
      'probe-qdrant': datastore('hivemem-qdrant', 'qdrant-v1.18.3'),
      'ledger-postgres': { ...datastore('magnus-postgres', 'ledger-postgres-17'), service: { ...release.components['magnus-postgres'].service, user, networks: ['default'], environment: { PGDATA: '/data/pgdata', POSTGRES_DB: 'ledger', POSTGRES_USER: 'ledger', POSTGRES_PASSWORD_FILE: '/config/password', POSTGRES_INITDB_ARGS: '--data-checksums' }, healthcheck: { test: ['CMD', 'pg_isready', '-h', '127.0.0.1', '-U', 'ledger', '-d', 'ledger'], interval: '1s', timeout: '5s', retries: 60 } } },
      probe: { image: images.node, kind: 'application', storageFormat: 'probe-v1', readableFormats: ['probe-v1'], catalog: fixtureCatalog('probe'), service: { user, command: ['node', '/config/service.mjs'], depends_on: { 'probe-redis': { condition: 'service_healthy' }, 'probe-qdrant': { condition: 'service_healthy' } }, healthcheck: { test: ['CMD', 'node', '-e', "fetch('http://127.0.0.1:8080/').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"], interval: '1s', timeout: '3s', retries: 30, start_period: '900s' } } },
      ledger: { image: images.postgres, kind: 'application', storageFormat: 'ledger-v1', readableFormats: ['ledger-v1'], catalog: fixtureCatalog('ledger'), service: { user, command: ['bash', '/config/ledger.sh'], depends_on: { 'ledger-postgres': { condition: 'service_healthy' } }, healthcheck: { test: ['CMD', 'bash', '-c', 'test -s /data/ledger.log'], interval: '1s', timeout: '3s', retries: 60 } } },
    },
  };
  const manifestFile = join(temp, '0.1.0.json');
  put(manifestFile, manifest);
  execute('openssl', ['pkeyutl', '-sign', '-inkey', join(temp, 'publisher.key'), '-rawin', '-in', manifestFile, '-out', manifestFile + '.sig']);
  const component = (name, env = true) => ({ host: 'control', configDirectory: join(owned, 'config', name), ...(env ? { envFile: join(owned, 'config', name + '.env') } : {}) });
  const config = { schema: 1, installation: id, release: '0.1.0', profile: 'custom', origin: 'https://console.example.com', hosts: { control: { ...hostEntry, directory: owned } },
    components: { 'hive-registry': { host: 'control', envFile: join(owned, 'config', 'hive-registry.env'), configDirectory: join(owned, 'config', 'hive-registry') }, probe: component('probe'), 'probe-redis': component('probe-redis'), 'probe-qdrant': component('probe-qdrant'), ledger: component('ledger'), 'ledger-postgres': component('ledger-postgres') },
    agents: [], inference: [] };
  const configPath = join(temp, 'installation.json');
  put(configPath, config);
  // Each isolated rehearsal is removed once checked: Docker has a limited pool of networks.
  const rehearse = (archive) => {
    const result = cli('rehearse', ['--archive', archive]);
    const isolated = join(owned, 'rehearsals', archive, 'isolated.json');
    assert.equal(JSON.parse(readFileSync(join(owned, 'rehearsals', archive, 'result.json'), 'utf8')).result, 'passed');
    try { execute('docker', ['compose', '-f', isolated, 'down', '--timeout', '10']); } catch {}
    return result;
  };
  const cli = (command, extra = [], ok = true, controller = root, configFile = configPath) => {
    const started = Date.now();
    const result = spawnSync(join(controller, 'hive.sh'), [command, '--config', configFile, '--release', '0.1.0', '--manifest', manifestFile, '--signature', manifestFile + '.sig', '--trust-key', join(temp, 'publisher.pub'), '--non-interactive', '--yes', ...extra], { env: environment, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    put(join(temp, command + '-' + (extra.find((value) => !value.startsWith('-')) ?? 'run') + '.log'), result.stdout + '\n--- stderr\n' + result.stderr);
    assert.equal(result.status === 0, ok, command + ': ' + result.stderr.slice(-2500));
    return { ...result, seconds: (Date.now() - started) / 1000 };
  };
  const compose = join(owned, 'compose.json');
  projects.add(compose);
  const containers = () => Object.fromEntries(docker('compose', '-f', compose, 'ps', '-q').split('\n').filter(Boolean).map((container) => JSON.parse(docker('inspect', container, '--format', '{"name":{{json .Config.Labels}},"started":{{json .State.StartedAt}},"running":{{.State.Running}}}'))).map((item) => [item.name['com.docker.compose.service'], { started: item.started, running: item.running }]));

  say('install: probe with SQLite, files, Redis and Qdrant; ledger with PostgreSQL');
  cli('install');
  await new Promise((done) => setTimeout(done, 4000));
  const project = JSON.parse(readFileSync(compose, 'utf8')).name;

  // A client on the suite network asks the probe for its state every 50 ms through each backup.
  const poll = () => {
    const name = id + '-client-' + randomBytes(2).toString('hex');
    const child = spawn('docker', ['run', '--rm', '--name', name, '--network', project + '_default', '--user', user, images.node, 'node', '--input-type=module', '-e', `for(;;){const t=Date.now();let ok=false;try{const r=await fetch('http://probe:8080/',{signal:AbortSignal.timeout(30000)});ok=r.ok;await r.text();}catch{}console.log(JSON.stringify({at:t,ms:Date.now()-t,ok}));await new Promise(d=>setTimeout(d,50));}`], { stdio: ['ignore', 'pipe', 'ignore'] });
    let text = '';
    child.stdout.on('data', (chunk) => { text += chunk; });
    return { stop: async () => { spawnSync('docker', ['rm', '-f', name], { stdio: 'ignore' }); await new Promise((done) => child.once('exit', done)); return text.trim().split('\n').filter((line) => line.startsWith('{')).map((line) => JSON.parse(line)); } };
  };
  const walGaps = (from, to) => {
    const database = new DatabaseSync(join(owned, 'data', 'probe', 'wal.db'), { readOnly: true, timeout: 5000 });
    try {
      const rows = database.prepare('SELECT at FROM ticks WHERE at BETWEEN ? AND ? ORDER BY n').all(from, to).map((row) => row.at);
      let longest = 0; for (let index = 1; index < rows.length; index++) longest = Math.max(longest, rows[index] - rows[index - 1]);
      return { ticks: rows.length, longestGapMs: longest };
    } finally { database.close(); }
  };
  // A pause that grows with the data, or with the number of collections, fails here.
  const withinBudget = (receipt) => {
    for (const item of receipt.snapshot.pauses) assert(item.pausedSeconds < pauseBudget, `The ${[...item.pause, ...item.stores].join(', ')} pause took ${item.pausedSeconds} s, over the ${pauseBudget} s budget`);
  };
  const backup = async (archive, extra = []) => {
    const before = containers(), client = poll();
    await new Promise((done) => setTimeout(done, 1500));
    const from = Date.now();
    const result = cli('backup', ['--archive', archive, ...extra]);
    const to = Date.now();
    await new Promise((done) => setTimeout(done, 1500));
    const requests = (await client.stop()).filter((item) => item.at >= from && item.at <= to);
    const after = containers();
    return { result, before, after, requests, ticks: walGaps(from, to), seconds: result.seconds, receipt: JSON.parse(readFileSync(join(owned, 'backups', archive, 'receipt.json'), 'utf8')), bytes: statSync(join(owned, 'backups', archive, 'state.tar.gz')).size };
  };

  say('online backup while every writer writes');
  const online = await backup('online-a');
  assert.equal(online.receipt.mode, 'online');
  // The installation is root's, as on production hosts, so a root host side leaves it root's.
  if (sudoHost) for (const name of ['', 'state.tar.gz', 'receipt.json']) assert.equal(statSync(join(owned, 'backups', 'online-a', name)).uid, 0, 'A root-owned installation was given to another owner');
  assert.deepEqual(online.after, online.before, 'No service stopped or restarted');
  assert(online.requests.length > 20 && online.requests.every((item) => item.ok), 'Every client request was answered');
  report.online = {
    seconds: online.seconds, archiveBytes: online.bytes, longestPauseSeconds: online.receipt.snapshot.longestPauseSeconds,
    pauses: online.receipt.snapshot.pauses.map((item) => ({ services: [...item.pause, ...item.stores], pausedSeconds: item.pausedSeconds, attempt: item.attempt, ...(item.steps ? { steps: item.steps, staged: item.staged } : {}) })),
    clientRequests: online.requests.length, clientFailures: online.requests.filter((item) => !item.ok).length, longestClientWaitMs: Math.max(...online.requests.map((item) => item.ms)),
    writerTicks: online.ticks, stores: Object.fromEntries(Object.entries(online.receipt.snapshot.stores).map(([name, value]) => [name, { files: value.files, bytes: value.bytes, method: value.store?.method ?? 'files', ...(value.store?.reused !== undefined ? { reusedSnapshots: value.store.reused, pausedSnapshots: value.store.captured } : {}), ...(value.store?.verified ? { verified: value.store.verified } : {}) }])),
  };
  report.online.dataBytes = Number(execute('du', ['-sk', join(owned, 'data')]).split('\t')[0]) * 1024;
  report.online.pauseBudgetSeconds = pauseBudget;
  withinBudget(online.receipt);
  say(`online backup: ${online.seconds}s, longest pause ${online.receipt.snapshot.longestPauseSeconds}s, longest client wait ${report.online.longestClientWaitMs} ms, ${online.bytes} bytes`);

  // Every store of the archive, read back independently of the controller.
  const inspect = (archive) => {
    const where = join(temp, 'inspect-' + archive);
    mkdirSync(where, { mode: 0o700 });
    execute('tar', ['-xzf', join(owned, 'backups', archive, 'state.tar.gz'), '-C', where, 'data']);
    const data = join(where, 'data');
    const sqlite = (file) => { const database = new DatabaseSync(file, { readOnly: true }); try { const row = database.prepare('SELECT count(*) AS rows, coalesce(max(n),0) AS n, coalesce(min(n),0) AS first FROM ticks').get(); return { rows: Number(row.rows), n: Number(row.n), first: Number(row.first), integrity: database.prepare('PRAGMA integrity_check').get().integrity_check, journal: database.prepare('PRAGMA journal_mode').get().journal_mode }; } finally { database.close(); } };
    const result = { wal: sqlite(join(data, 'probe', 'wal.db')), journal: sqlite(join(data, 'probe', 'journal.db')) };
    const lines = readFileSync(join(data, 'probe', 'events.log'), 'utf8').trim().split('\n').map(Number);
    result.log = { lines: lines.length, n: lines.at(-1), contiguous: lines.every((value, index) => value === lines[0] + index) };
    result.state = JSON.parse(readFileSync(join(data, 'probe', 'state.json'), 'utf8')).n;
    result.sidecars = execute('tar', ['-tzf', join(owned, 'backups', archive, 'state.tar.gz')]).split('\n').filter((name) => /\.db-(wal|shm|journal)$/.test(name));
    result.blob = sha(readFileSync(join(data, 'probe', 'blob.bin')));
    const ledgerLines = readFileSync(join(data, 'ledger', 'ledger.log'), 'utf8').trim().split('\n').filter(Boolean).map(Number);
    result.ledgerLog = ledgerLines.at(-1) ?? 0;
    const run = (name, args) => docker('run', '-d', '--name', name, '--network', 'none', '--user', user, '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges:true', '--tmpfs', '/tmp:mode=1777', ...args);
    const name = id + '-inspect-' + archive;
    try {
      run(name + '-redis', ['--mount', `type=bind,source=${join(data, 'probe-redis')},target=/data`, '--mount', `type=bind,source=${join(owned, 'config', 'probe-redis')},target=/config,readonly`, images.redis, 'redis-server', '/config/redis.conf']);
      let redis;
      for (let attempt = 0; attempt < 60 && !redis; attempt++) { try { redis = docker('exec', '-e', 'REDISCLI_AUTH=' + secrets.redis, name + '-redis', 'sh', '-c', 'redis-cli --no-auth-warning get tick; redis-cli --no-auth-warning --scan --pattern "expiring:*" | wc -l; redis-cli --no-auth-warning pttl "$(redis-cli --no-auth-warning --scan --pattern "expiring:*" | head -1)"').split('\n'); if (!/^[0-9]+$/.test(redis[0])) redis = undefined; } catch { execute('sleep', ['0.5']); } }
      result.redis = { tick: Number(redis[0]), expiringKeys: Number(redis[1]), ttlMs: Number(redis[2]) };
      run(name + '-qdrant', ['--workdir', '/data', '--mount', `type=bind,source=${join(data, 'probe-qdrant')},target=/data`, '--mount', `type=bind,source=${join(owned, 'config', 'probe-qdrant')},target=/config,readonly`, '--entrypoint', '/qdrant/qdrant', images.qdrant, '--config-path', '/config/qdrant.yaml']);
      let points;
      for (let attempt = 0; attempt < 60 && !points; attempt++) { try { points = JSON.parse(docker('run', '--rm', '--network', 'container:' + name + '-qdrant', images.node, 'node', '--input-type=module', '-e', `const h={'api-key':${JSON.stringify(secrets.qdrant)},'Content-Type':'application/json'};const c=await (await fetch('http://127.0.0.1:6333/collections/ticks/points/count',{method:'POST',headers:h,body:'{"exact":true}'})).json();let max=0,offset=null;do{const p=await (await fetch('http://127.0.0.1:6333/collections/ticks/points/scroll',{method:'POST',headers:h,body:JSON.stringify({limit:1000,offset,with_payload:true})})).json();for(const x of p.result.points)max=Math.max(max,x.payload.n);offset=p.result.next_page_offset;}while(offset!==null&&offset!==undefined);console.log(JSON.stringify({count:c.result.count,n:max}))`)); } catch { execute('sleep', ['0.5']); } }
      result.qdrant = points;
      run(name + '-postgres', ['--tmpfs', `/var/run/postgresql:uid=${serviceUid},gid=${serviceGid},mode=700`, '-e', 'PGDATA=/data/pgdata', '--mount', `type=bind,source=${join(data, 'ledger-postgres')},target=/data`, images.postgres]);
      let rows;
      for (let attempt = 0; attempt < 120 && !rows; attempt++) { try { rows = docker('exec', name + '-postgres', 'psql', '-h', '/var/run/postgresql', '-U', 'ledger', '-d', 'ledger', '-At', '-c', 'SELECT count(*), coalesce(max(n),0) FROM ticks').split('|').map(Number); } catch { execute('sleep', ['0.5']); } }
      result.postgres = { rows: rows[0], n: rows[1] };
    } finally { for (const suffix of ['-redis', '-qdrant', '-postgres']) spawnSync('docker', ['rm', '-f', name + suffix], { stdio: 'ignore' }); }
    return result;
  };
  // A stopped backup stops the writers mid-tick, so rows are contiguous only until the first
  // restart; the order of the stores holds throughout.
  const consistent = (state, online = true, contiguous = online) => {
    const order = [state.wal.n, state.journal.n, state.log.n, state.state, state.redis.tick, state.qdrant.n];
    for (let index = 1; index < order.length; index++) assert(order[index] <= order[index - 1], 'Write order holds between stores: ' + order.join(' '));
    assert(order.at(-1) >= order[0] - 1, 'All stores hold the same instant, within the one tick in flight: ' + order.join(' '));
    if (contiguous) { assert.equal(state.wal.rows, state.wal.n); assert.equal(state.journal.rows, state.journal.n); assert(state.log.contiguous); assert.equal(state.qdrant.count, state.qdrant.n); }
    assert(state.postgres.n === state.ledgerLog || state.postgres.n === state.ledgerLog + 1, 'Ledger file and PostgreSQL hold the same instant: ' + state.postgres.n + ' ' + state.ledgerLog);
    if (contiguous) assert.equal(state.postgres.rows, state.postgres.n);
    // The stopped format copies a stopped store's files as they are, sidecars included.
    if (online) assert.deepEqual(state.sidecars, [], 'No SQLite sidecar is archived');
    assert.equal(state.wal.journal, 'wal'); assert.equal(state.journal.journal, 'delete');
    assert(state.redis.ttlMs > 0 && state.redis.ttlMs <= 600000, 'Redis expiry stays absolute');
    return order;
  };
  say('archive: every store holds one instant');
  report.online.restoredStores = inspect('online-a');
  report.online.storeOrder = consistent(report.online.restoredStores);

  say('rehearse the online archive');
  report.online.rehearsalSeconds = rehearse('online-a').seconds;

  say('stopped backup, the --stopped fallback');
  const stopped = await backup('stopped-a', ['--stopped']);
  assert.equal(stopped.receipt.mode, undefined, 'The stopped archive is the original format');
  report.stopped = { seconds: stopped.seconds, archiveBytes: stopped.bytes, clientFailures: stopped.requests.filter((item) => !item.ok).length, longestWriterGapMs: stopped.ticks.longestGapMs, restarted: Object.keys(stopped.after).filter((name) => stopped.after[name].started !== stopped.before[name].started).sort() };
  assert(report.stopped.restarted.length > 0, 'The stopped backup restarts services');
  report.stopped.restoredStores = inspect('stopped-a');
  consistent(report.stopped.restoredStores, false);
  rehearse('stopped-a');

  if (oldController) {
    say('an archive written by the earlier controller');
    const old = cli('backup', ['--archive', 'earlier-a'], true, oldController);
    report.earlierController = { seconds: old.seconds, receiptMode: JSON.parse(readFileSync(join(owned, 'backups', 'earlier-a', 'receipt.json'), 'utf8')).mode ?? 'stopped (original format)' };
    consistent(inspect('earlier-a'), false);
    rehearse('earlier-a');
    // The online archive has the stopped layout, so the earlier controller restores it too.
    cpSync(join(owned, 'backups', 'online-a'), join(owned, 'backups', 'online-a-earlier'), { recursive: true });
    const earlierRehearsal = cli('rehearse', ['--archive', 'online-a-earlier'], true, oldController);
    assert.equal(JSON.parse(readFileSync(join(owned, 'rehearsals', 'online-a-earlier', 'result.json'), 'utf8')).result, 'passed');
    try { execute('docker', ['compose', '-f', join(owned, 'rehearsals', 'online-a-earlier', 'isolated.json'), 'down', '--timeout', '10']); } catch {}
    report.earlierController.rehearsesOnlineArchive = earlierRehearsal.status === 0;
  }

  // ---- Failures: the suite keeps serving, nothing is kept, no other archive changes. ----
  const archives = () => Object.fromEntries(readdirSync(join(owned, 'backups')).filter((name) => !name.startsWith('.')).map((name) => [name, sha(readFileSync(join(owned, 'backups', name, 'state.tar.gz')))]));
  const failure = async (archive, setup, pattern, configFile = configPath) => {
    const kept = archives(), before = containers(), client = poll();
    await new Promise((done) => setTimeout(done, 1000));
    setup?.();
    const from = Date.now();
    const result = cli('backup', ['--archive', archive], false, root, configFile);
    const to = Date.now();
    await new Promise((done) => setTimeout(done, 1000));
    const requests = (await client.stop()).filter((item) => item.at >= from && item.at <= to);
    assert.match(result.stderr, pattern);
    assert(!existsSync(join(owned, 'backups', archive)), 'No archive is kept');
    assert.deepEqual(readdirSync(join(owned, 'backups')).filter((name) => name.startsWith('.')), [], 'No staging is left');
    assert.deepEqual(archives(), kept, 'No other archive changed or was removed');
    assert.deepEqual(containers(), before, 'Every service kept running');
    for (const container of docker('compose', '-f', compose, 'ps', '-q').split('\n')) assert.equal(docker('inspect', container, '--format', '{{.State.Paused}}'), 'false');
    assert(requests.every((item) => item.ok), 'Every client request was answered');
    assert.equal(JSON.parse(readFileSync(join(owned, 'transaction.json'), 'utf8')).phase, 'complete', 'The transaction is closed');
    return { refused: pattern.source, clientFailures: requests.filter((item) => !item.ok).length, otherArchivesUnchanged: true, servicesKeptRunning: true };
  };
  say('failure: not enough free space');
  const small = join(temp, 'small-disk.json');
  // The host preflight passes, with a reserve just under the free space; the snapshot and its
  // archive would not fit beside it.
  const freeMiB = Number(execute('df', ['-Pm', owned]).trim().split('\n')[1].split(/\s+/)[3]);
  put(small, { ...config, hosts: { control: { ...config.hosts.control, minimumFreeMiB: freeMiB - 50 } } });
  report.failures = { space: await failure('fail-space', null, /needs [0-9]+ MiB free/, small) };
  say('failure: a store snapshot fails while its writer is paused');
  report.failures.duringPause = await failure('fail-pause', () => { const blocker = join(owned, 'data', 'ledger-postgres', '.hive-snapshot-fail-pause'); mkdirSync(blocker); put(join(blocker, 'occupied'), 'x'); }, /PostgreSQL base backup failed/);
  assert(!existsSync(join(owned, 'data', 'ledger-postgres', '.hive-snapshot-fail-pause')), 'The store temporary is removed');
  say('failure: a service is not running');
  docker('compose', '-f', compose, 'stop', 'ledger');
  const stoppedResult = cli('backup', ['--archive', 'fail-serving'], false);
  assert.match(stoppedResult.stderr, /every suite service running and healthy/);
  docker('compose', '-f', compose, 'up', '-d', '--wait', 'ledger');
  report.failures.notServing = { refused: true };

  say('a later online backup succeeds');
  const second = await backup('online-b');
  assert(second.requests.every((item) => item.ok));
  consistent(inspect('online-b'), true, false);
  report.secondOnline = { seconds: second.seconds, longestPauseSeconds: second.receipt.snapshot.longestPauseSeconds, pauses: second.receipt.snapshot.pauses.map((item) => ({ services: [...item.pause, ...item.stores], pausedSeconds: item.pausedSeconds, attempt: item.attempt })), longestClientWaitMs: Math.max(...second.requests.map((item) => item.ms)) };
  withinBudget(second.receipt);

  // ---- Restores: the online archive, then the stopped one. Writers stop for reconciliation. ----
  // Each restore is its own reviewed plan: the controller keeps one restore's evidence per plan.
  const restore = (archive, configFile = configPath) => {
    docker('compose', '-f', compose, 'stop', '--timeout', '30');
    const current = execute('bash', ['-c', 'cd "$1/data"; find . -type f -print0 | sort -z | xargs -0 -r sha256sum --zero | sha256sum | cut -d " " -f1', 'bash', owned]).trim();
    const receipt = JSON.parse(readFileSync(join(owned, 'backups', archive, 'receipt.json'), 'utf8'));
    const reconcile = join(temp, 'reconciliation-' + archive + '.json');
    put(reconcile, { hosts: { control: { installationUUID: JSON.parse(readFileSync(join(owned, 'installation.json'), 'utf8')).uuid, archiveSHA256: receipt.sha256, currentDataSHA256: current, subsequentWritesReconciled: true } } });
    const result = cli('restore', ['--archive', archive, '--reconciliation', reconcile], true, root, configFile);
    const database = new DatabaseSync(join(owned, 'data', 'probe', 'wal.db'), { readOnly: true, timeout: 5000 });
    let restoredRows;
    try { restoredRows = Number(database.prepare('SELECT count(*) AS c FROM ticks WHERE n <= ?').get(report.online.restoredStores.wal.n).c); } finally { database.close(); }
    return { seconds: result.seconds, restoredRowsUpToArchive: restoredRows, servicesRunning: Object.values(containers()).every((item) => item.running) };
  };
  say('restore the online archive');
  report.restoreOnline = restore('online-a');
  assert.equal(report.restoreOnline.restoredRowsUpToArchive, report.online.restoredStores.wal.n);
  assert(report.restoreOnline.servicesRunning);
  await new Promise((done) => setTimeout(done, 3000));
  say('restore the stopped archive');
  const secondPlan = join(temp, 'installation-second-restore.json');
  put(secondPlan, { ...config, hosts: { control: { ...config.hosts.control, minimumFreeMiB: 2048 } } });
  report.restoreStopped = restore(oldController ? 'earlier-a' : 'stopped-a', secondPlan);
  assert(report.restoreStopped.servicesRunning);
  passed = true;
  report.result = 'passed';
  console.log(JSON.stringify(report, null, 2));
  console.log('PASS: online backup with live writers: no service stopped, pauses measured, one-instant stores in write order, verified, rehearsed and restored; stopped and earlier-controller archives rehearse and restore; failures keep serving and keep no archive.');
} finally {
  report.finishedAt = new Date().toISOString();
  writeFileSync(join(temp, 'report.json'), JSON.stringify(report, null, 2));
  if (!keep) for (const file of projects) try { execute('docker', ['compose', '-f', file, 'down', '--timeout', '10']); } catch {}
  for (const line of spawnSync('docker', ['ps', '-aq', '--filter', 'name=' + id], { encoding: 'utf8' }).stdout.trim().split('\n').filter(Boolean)) spawnSync('docker', ['rm', '-f', line], { stdio: 'ignore' });
  registryImage?.stop();
  target?.stop();
  if (passed && !keep) rmSync(temp, { recursive: true, force: true });
  else console.error('Private online-backup evidence retained at ' + temp);
}
