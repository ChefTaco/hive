// Unit tests for the online backup helper. They run the helper's own functions on the host,
// against a live SQLite writer in this process.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { busyError, capture, precopy, verify, walk, qdrantConfigText, qdrantCapture, qdrantPrecapture, qdrantVersionsFrom, RACY_MS } from './snapshot-data.mjs';

const fixture = () => {
  const root = mkdtempSync(join(tmpdir(), 'hive-snapshot-'));
  for (const name of ['data', 'out', 'work']) mkdirSync(join(root, name), { mode: 0o700 });
  return { root, source: join(root, 'data'), target: join(root, 'out'), work: join(root, 'work') };
};
const rows = (file) => { const database = new DatabaseSync(file, { readOnly: true }); try { return database.prepare('SELECT count(*) AS c FROM t').get().c; } finally { database.close(); } };
// Waits until files written so far are no longer recent enough to be compared by content.
const settled = () => new Promise((done) => setTimeout(done, RACY_MS + 50));
const precopied = (work) => JSON.parse(readFileSync(join(work, 'precopy.json'), 'utf8'));

test('a live WAL database is pre-copied while serving and brought up to date at the capture instant, in WAL mode, without sidecars', async () => {
  const { root, source, target, work } = fixture();
  try {
    const live = new DatabaseSync(join(source, 'live.db'));
    live.exec('PRAGMA journal_mode=WAL; CREATE TABLE t(n INTEGER PRIMARY KEY, v TEXT)');
    const insert = live.prepare('INSERT INTO t(v) VALUES (?)');
    for (let index = 0; index < 500; index++) insert.run('before ' + index);
    assert(existsSync(join(source, 'live.db-wal')), 'The writer keeps committed frames in the WAL');
    precopy({ source, target, work });
    assert(existsSync(join(target, 'live.db')) && existsSync(join(target, 'live.db-wal')), 'The database and its log are pre-copied while serving');
    assert.equal(precopied(work)['live.db'].clean, false, 'A database written just before is not trusted by its times');
    for (let index = 0; index < 250; index++) insert.run('after ' + index);
    const result = await capture({ source, target, work });
    assert.equal(result.sqlite, 1); assert.equal(result.sqliteKept, 0);
    for (let index = 0; index < 100; index++) insert.run('later ' + index);
    const verified = verify({ target, work });
    assert.deepEqual(verified.sqlite, [{ path: 'live.db', journalMode: 'wal', pages: verified.sqlite[0].pages }]);
    assert.deepEqual(readdirSync(target).sort(), ['live.db'], 'No -wal or -shm sidecar is copied or left behind');
    assert.equal(readFileSync(join(target, 'live.db')).subarray(18, 20).toString('hex'), '0202', 'The copy stays in WAL mode');
    assert.equal(rows(join(target, 'live.db')), 750, 'The copy holds every row committed at capture, WAL frames included');
    live.close();
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('an Ardent Project Studio volume keeps its database and the content-addressed files it names as one unit', async () => {
  const { root, source, target, work } = fixture();
  try {
    // The layout ArdentStudio writes in /data: studio.sqlite (WAL), blobs/aa/bb/<sha256>, blobs/tmp.
    const blob = (content) => { const sha = createHash('sha256').update(content).digest('hex'); const dir = join(source, 'blobs', sha.slice(0, 2), sha.slice(2, 4)); mkdirSync(dir, { recursive: true }); writeFileSync(join(dir, sha), content); return sha; };
    mkdirSync(join(source, 'blobs', 'tmp'), { recursive: true });
    const live = new DatabaseSync(join(source, 'studio.sqlite'));
    live.exec('PRAGMA journal_mode=WAL; CREATE TABLE t(n INTEGER PRIMARY KEY, sha TEXT NOT NULL)');
    const insert = live.prepare('INSERT INTO t(sha) VALUES (?)');
    insert.run(blob('reference file'));
    precopy({ source, target, work });
    // Written while serving, after the pre-copy: a new blob first, then the row that names it.
    insert.run(blob(Buffer.alloc(2 * 1024 * 1024, 3)));
    writeFileSync(join(source, 'blobs', 'tmp', 'upload-in-progress'), 'partial');
    await capture({ source, target, work });
    const verified = verify({ target, work });
    assert.deepEqual(verified.sqlite.map((entry) => [entry.path, entry.journalMode]), [['studio.sqlite', 'wal']]);
    const copy = new DatabaseSync(join(target, 'studio.sqlite'), { readOnly: true });
    try {
      const named = copy.prepare('SELECT sha FROM t ORDER BY n').all().map((row) => row.sha);
      assert.equal(named.length, 2, 'The copy holds every row committed at capture');
      for (const sha of named) {
        const file = join(target, 'blobs', sha.slice(0, 2), sha.slice(2, 4), sha);
        assert.equal(createHash('sha256').update(readFileSync(file)).digest('hex'), sha, 'A file the database names is missing or differs');
      }
    } finally { copy.close(); }
    live.close();
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('a rollback-journal database keeps its mode, and a held write lock is reported as busy', async () => {
  const { root, source, target, work } = fixture();
  try {
    const live = new DatabaseSync(join(source, 'journal.db'));
    live.exec('CREATE TABLE t(n INTEGER PRIMARY KEY); INSERT INTO t VALUES (1), (2)');
    // A paused writer inside a commit holds the exclusive lock.
    live.exec('BEGIN EXCLUSIVE; INSERT INTO t VALUES (3)');
    await assert.rejects(capture({ source, target, work }), (error) => error.busy === true && /locked/.test(error.message));
    live.exec('ROLLBACK');
    // A writer that only reserved the database does not block a consistent read.
    live.exec('BEGIN IMMEDIATE; INSERT INTO t VALUES (4)');
    await capture({ source, target, work });
    live.exec('COMMIT');
    assert.equal(verify({ target, work }).sqlite[0].journalMode, 'rollback');
    assert.equal(rows(join(target, 'journal.db')), 2, 'An uncommitted transaction is not in the copy');
    assert.equal(readFileSync(join(target, 'journal.db')).subarray(18, 20).toString('hex'), '0101');
    live.close();
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('files: unchanged are kept, appended gain their tail, replaced and rewritten are copied, removed are pruned', async () => {
  const { root, source, target, work } = fixture();
  try {
    mkdirSync(join(source, 'logs'));
    writeFileSync(join(source, 'blob.bin'), Buffer.alloc(3 * 1024 * 1024, 7));
    writeFileSync(join(source, 'logs', 'audit.jsonl'), '{"n":1}\n');
    writeFileSync(join(source, 'state.json'), '{"n":1}');
    writeFileSync(join(source, 'rewritten.txt'), 'aaaa');
    writeFileSync(join(source, 'gone.txt'), 'x');
    writeFileSync(join(source, 'orphan-journal'), 'an ordinary file whose name ends like a sidecar');
    assert.deepEqual(precopy({ source, target, work }), { files: 6, bytes: 3 * 1024 * 1024 + 8 + 7 + 4 + 1 + 47 });
    appendFileSync(join(source, 'logs', 'audit.jsonl'), '{"n":2}\n');
    writeFileSync(join(source, 'state.json.next'), '{"n":2}'); renameSync(join(source, 'state.json.next'), join(source, 'state.json'));
    await new Promise((done) => setTimeout(done, 20));
    writeFileSync(join(source, 'rewritten.txt'), 'bbbb');
    rmSync(join(source, 'gone.txt'));
    writeFileSync(join(source, 'new.txt'), 'new');
    const result = await capture({ source, target, work });
    assert.deepEqual({ ...result, compared: undefined, written: undefined }, { sqlite: 0, sqliteKept: 0, kept: 2, appended: 1, copied: 3, removed: 1, compared: undefined, written: undefined });
    // Every file here changed just before its pre-copy, so even the unchanged ones were compared.
    assert(result.compared >= 3 * 1024 * 1024);
    for (const name of ['blob.bin', 'logs/audit.jsonl', 'state.json', 'rewritten.txt', 'new.txt', 'orphan-journal']) assert.deepEqual(readFileSync(join(target, name)), readFileSync(join(source, name)), name);
    assert(!existsSync(join(target, 'gone.txt')));
    const verified = verify({ target, work });
    assert.equal(verified.files, 6);
    assert.equal(verified.bytes, 3 * 1024 * 1024 + 16 + 7 + 4 + 3 + 47);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('a file that grew after its earlier copy changed is copied again in full', async () => {
  const { root, source, target, work } = fixture();
  try {
    writeFileSync(join(source, 'log'), 'first line\n');
    precopy({ source, target, work });
    // Same inode, longer, but the earlier bytes changed: not an append.
    writeFileSync(join(source, 'log'), 'FIRST LINE\nsecond line\n', { flag: 'r+' });
    const result = await capture({ source, target, work });
    assert.equal(result.appended, 0); assert.equal(result.copied, 1);
    assert.equal(readFileSync(join(target, 'log'), 'utf8'), 'FIRST LINE\nsecond line\n');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('excluded store paths are neither copied nor pruned from a materialized store', async () => {
  const { root, source, target, work } = fixture();
  try {
    mkdirSync(join(source, 'appendonlydir')); writeFileSync(join(source, 'appendonlydir', 'live.aof'), 'live');
    writeFileSync(join(source, 'dump.rdb'), 'live'); writeFileSync(join(source, 'temp-123.rdb'), 'live'); writeFileSync(join(source, 'extra.txt'), 'kept');
    mkdirSync(join(target, 'appendonlydir')); writeFileSync(join(target, 'appendonlydir', 'restored.manifest'), 'materialized'); writeFileSync(join(target, 'dump.rdb'), 'materialized');
    const exclude = ['appendonlydir', 'dump.rdb', 'temp-*.rdb'];
    precopy({ source, target, work, exclude });
    await capture({ source, target, work, exclude });
    assert.equal(readFileSync(join(target, 'dump.rdb'), 'utf8'), 'materialized');
    assert.deepEqual(readdirSync(join(target, 'appendonlydir')), ['restored.manifest']);
    assert(!existsSync(join(target, 'temp-123.rdb')));
    assert.equal(readFileSync(join(target, 'extra.txt'), 'utf8'), 'kept');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('a database unchanged since its pre-copy is kept while paused without being read again', async () => {
  const { root, source, target, work } = fixture();
  try {
    for (const [name, mode] of [['kept.db', 'DELETE'], ['kept-wal.db', 'WAL']]) {
      const database = new DatabaseSync(join(source, name));
      database.exec(`PRAGMA journal_mode=${mode}; CREATE TABLE t(n INTEGER PRIMARY KEY, b BLOB)`);
      const insert = database.prepare('INSERT INTO t(b) VALUES (?)');
      for (let index = 0; index < 64; index++) insert.run(Buffer.alloc(16384, index));
      database.close();
    }
    await settled();
    precopy({ source, target, work });
    assert.equal(precopied(work)['kept.db'].clean, true); assert.equal(precopied(work)['kept-wal.db'].clean, true);
    const result = await capture({ source, target, work });
    assert.equal(result.sqlite, 2); assert.equal(result.sqliteKept, 2);
    assert.equal(result.compared, 0, 'Nothing was read again while paused');
    const verified = verify({ target, work });
    assert.deepEqual(verified.sqlite.map((item) => [item.path, item.journalMode]).sort(), [['kept-wal.db', 'wal'], ['kept.db', 'rollback']]);
    assert.deepEqual(readdirSync(target).sort(), ['kept-wal.db', 'kept.db']);
    assert.equal(rows(join(target, 'kept.db')), 64); assert.equal(rows(join(target, 'kept-wal.db')), 64);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('a database changed after its pre-copy is brought up to date by writing only what differs', async () => {
  const { root, source, target, work } = fixture();
  try {
    const live = new DatabaseSync(join(source, 'journal.db'));
    live.exec('CREATE TABLE t(n INTEGER PRIMARY KEY, b BLOB)');
    const insert = live.prepare('INSERT INTO t(b) VALUES (?)');
    live.exec('BEGIN'); for (let index = 0; index < 256; index++) insert.run(Buffer.alloc(16384, 1)); live.exec('COMMIT');
    await settled();
    precopy({ source, target, work });
    assert.equal(precopied(work)['journal.db'].clean, true);
    // A commit in place, after the copy: the change counter moves, the size does not.
    live.exec('UPDATE t SET b = zeroblob(16384) WHERE n = 3');
    const result = await capture({ source, target, work });
    assert.equal(result.sqliteKept, 0);
    const size = statSync(join(source, 'journal.db')).size;
    assert(result.compared === size && result.written > 0 && result.written < size, 'Only the chunks that changed were written');
    assert.deepEqual(readFileSync(join(target, 'journal.db')), readFileSync(join(source, 'journal.db')), 'The copy equals the paused database');
    verify({ target, work });
    const copy = new DatabaseSync(join(target, 'journal.db'), { readOnly: true });
    try { assert.equal(copy.prepare('SELECT count(*) AS c FROM t WHERE b = zeroblob(16384)').get().c, 1); } finally { copy.close(); }
    live.close();
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('a database whose log restarted after its pre-copy is not kept', async () => {
  const { root, source, target, work } = fixture();
  try {
    const live = new DatabaseSync(join(source, 'live.db'));
    live.exec('PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; CREATE TABLE t(n INTEGER PRIMARY KEY, v TEXT)');
    const insert = live.prepare('INSERT INTO t(v) VALUES (?)');
    for (let index = 0; index < 50; index++) insert.run('before ' + index);
    await settled();
    precopy({ source, target, work });
    assert.equal(precopied(work)['live.db'].clean, true);
    // A full checkpoint, then a commit that restarts the log from its start.
    live.exec('PRAGMA wal_checkpoint(TRUNCATE)'); insert.run('after');
    const result = await capture({ source, target, work });
    assert.equal(result.sqliteKept, 0);
    verify({ target, work });
    assert.equal(rows(join(target, 'live.db')), 51);
    live.close();
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test(`a file changed within ${RACY_MS} ms before its pre-copy is compared while paused, not kept by its times`, async () => {
  const { root, source, target, work } = fixture();
  try {
    writeFileSync(join(source, 'old.bin'), Buffer.alloc(2 * 1024 * 1024, 2)); await settled();
    writeFileSync(join(source, 'fresh.bin'), Buffer.alloc(2 * 1024 * 1024, 1));
    precopy({ source, target, work });
    assert.equal(precopied(work)['fresh.bin'].racy, true); assert.equal(precopied(work)['old.bin'].racy, false);
    // A change the times cannot show: in place, same size, times put back.
    const times = statSync(join(source, 'fresh.bin'));
    writeFileSync(join(source, 'fresh.bin'), Buffer.alloc(2 * 1024 * 1024, 3), { flag: 'r+' });
    utimesSync(join(source, 'fresh.bin'), times.atime, times.mtime);
    const result = await capture({ source, target, work });
    assert.equal(result.compared, 2 * 1024 * 1024, 'Only the recently changed file was compared');
    assert.deepEqual(readFileSync(join(target, 'fresh.bin')), readFileSync(join(source, 'fresh.bin')));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// A Qdrant that answers what the helper asks, with versions the test changes between steps.
async function fakeQdrant(collections, options = {}) {
  const snapshots = [];
  const server = createServer((request, response) => {
    const url = new URL(request.url, 'http://qdrant'), send = (status, result) => { response.writeHead(status, { 'Content-Type': 'application/json' }); response.end(JSON.stringify({ result })); };
    let body = '';
    request.on('data', (chunk) => { body += chunk; });
    request.on('end', () => {
      if (request.headers['api-key'] !== 'synthetic-key') return send(403, null);
      if (url.pathname === '/telemetry') return send(200, { collections: { collections: Object.entries(collections).map(([id, item]) => ({ id, config: item.config ?? { params: { size: 4 } },
        shards: [{ id: 0, remote: [], local: { num_points: item.points, segments: [{ info: { uuid: item.segment ?? 'segment-1' } }], update_queue: options.unversioned ? { length: 0 } : { length: item.queued ?? 0, op_num: item.operation } } }] })) } });
      if (url.pathname === '/collections') return send(200, { collections: Object.keys(collections).map((name) => ({ name })) });
      if (url.pathname === '/aliases') return send(200, { aliases: [] });
      const match = /^\/collections\/([^/]+)\/(snapshots|points\/count)$/.exec(url.pathname);
      if (!match) return send(404, null);
      const name = decodeURIComponent(match[1]), item = collections[name];
      if (!item) return send(404, null);
      if (match[2] === 'points/count') return send(200, { count: item.points });
      const snapshot = name + '-' + snapshots.length + '.snapshot';
      snapshots.push(snapshot); options.onSnapshot?.(name);
      return send(200, { name: snapshot, checksum: 'sum-' + snapshot, size: 1 });
    });
  });
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  return { url: 'http://127.0.0.1:' + server.address().port, snapshots, close: () => new Promise((done) => server.close(done)) };
}
const qdrantFixture = () => {
  const root = mkdtempSync(join(tmpdir(), 'hive-qdrant-'));
  writeFileSync(join(root, 'qdrant.yaml'), 'storage:\n  snapshots_path: /data/snapshots\nservice:\n  api_key: synthetic-key\n');
  return { root, config: join(root, 'qdrant.yaml'), created: () => readFileSync(join(root, 'qdrant-created.jsonl'), 'utf8').trim().split('\n').map((line) => JSON.parse(line).name).sort() };
};

test('Qdrant: while paused only collections written since their snapshot, or created since, are snapshotted again', async () => {
  const { root, config, created } = qdrantFixture();
  // busy is written while its own snapshot is taken, so that snapshot is not trusted either.
  const collections = { quiet: { operation: 5, points: 3 }, written: { operation: 7, points: 2 }, busy: { operation: 1, points: 1 }, removed: { operation: 2, points: 4 } };
  const qdrant = await fakeQdrant(collections, { onSnapshot: (name) => { if (name === 'busy' && qdrant.snapshots.length < 5) collections.busy.operation++; } });
  try {
    const staged = await qdrantPrecapture({ url: qdrant.url, config, work: root });
    assert.deepEqual({ ...staged, seconds: undefined }, { versioned: true, collections: 4, clean: 3, seconds: undefined });
    collections.written.operation++; collections.written.points++;
    delete collections.removed; collections.added = { operation: 1, points: 1 };
    const result = await qdrantCapture({ url: qdrant.url, config, work: root });
    assert.equal(result.reused, 1); assert.equal(result.captured, 3);
    assert.deepEqual(Object.keys(result.snapshots).sort(), ['added', 'busy', 'quiet', 'written']);
    assert.match(result.snapshots.quiet.name, /^quiet-[0-3]\.snapshot$/, 'The quiet collection keeps its snapshot taken while serving');
    assert.match(result.snapshots.written.name, /^written-[4-7]\.snapshot$/);
    assert.deepEqual(result.collections, { added: 1, busy: 1, quiet: 3, written: 3 });
    assert.deepEqual(created(), [...qdrant.snapshots].sort(), 'Every snapshot created is recorded, for removal of the ones not kept');
  } finally { await qdrant.close(); rmSync(root, { recursive: true, force: true }); }
});

test('Qdrant: a write still queued, a changed configuration or no versions mean a new snapshot', async () => {
  const { root, config } = qdrantFixture();
  const collections = { queued: { operation: 1, points: 1 }, configured: { operation: 1, points: 1 }, quiet: { operation: 1, points: 1 } };
  const qdrant = await fakeQdrant(collections);
  try {
    await qdrantPrecapture({ url: qdrant.url, config, work: root });
    collections.configured.config = { params: { size: 4 }, hnsw_config: { m: 32 } };
    // A write the paused writer sent before the pause lands while the capture waits for it.
    collections.queued.queued = 1;
    setTimeout(() => { collections.queued.queued = 0; collections.queued.operation++; }, 60);
    const result = await qdrantCapture({ url: qdrant.url, config, work: root });
    assert.equal(result.reused, 1); assert.match(result.snapshots.quiet.name, /^quiet-[0-2]\.snapshot$/);
    // Never settling, the capture snapshots everything.
    collections.quiet.queued = 1;
    assert.equal((await qdrantCapture({ url: qdrant.url, config, work: root, settle: 3 })).reused, 0);
  } finally { await qdrant.close(); rmSync(root, { recursive: true, force: true }); }
  const old = qdrantFixture(), unversioned = await fakeQdrant({ only: { operation: 1, points: 1 } }, { unversioned: true });
  try {
    assert.deepEqual(await qdrantPrecapture({ url: unversioned.url, config: old.config, work: old.root }), { versioned: false });
    assert.equal(unversioned.snapshots.length, 0, 'Nothing is snapshotted while serving without versions');
    const result = await qdrantCapture({ url: unversioned.url, config: old.config, work: old.root });
    assert.equal(result.reused, 0); assert.equal(result.captured, 1);
  } finally { await unversioned.close(); rmSync(old.root, { recursive: true, force: true }); }
});

test('Qdrant versions come from per-shard operation numbers and refuse what they cannot vouch for', () => {
  const telemetry = (queue, remote = []) => ({ collections: { collections: [{ id: 'a', config: { params: {} }, shards: [{ id: 0, remote, local: { num_points: 1, segments: [{ info: { uuid: 's' } }], update_queue: queue } }] }] } });
  assert.equal(qdrantVersionsFrom(telemetry({ length: 0, op_num: 4 })).a.shards[0].operation, 4);
  assert.equal(qdrantVersionsFrom(telemetry({ length: 0 })), null, 'No operation number');
  assert.equal(qdrantVersionsFrom(telemetry({ length: 0, op_num: 4 }, [{ peer_id: 2 }])), null, 'A remote shard');
  assert.equal(qdrantVersionsFrom({}), null);
});

test('links and special files are refused, as by the stopped backup', () => {
  const { root, source } = fixture();
  try {
    execFileSync('mkfifo', [join(source, 'pipe')]);
    assert.throws(() => walk(source), /Unsupported file type/);
    rmSync(join(source, 'pipe'));
    execFileSync('ln', ['-s', '/etc/hostname', join(source, 'link')]);
    assert.throws(() => walk(source), /Unsupported file type/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('SQLite lock errors are classified for a retry', () => {
  assert(busyError({ code: 'ERR_SQLITE_ERROR', errcode: 0, message: 'not an error' }));
  assert(busyError({ errcode: 5, message: 'database is locked' }));
  assert(busyError({ errcode: 517, message: 'database is locked' }));
  assert(!busyError({ code: 'ERR_SQLITE_ERROR', errcode: 11, message: 'database disk image is malformed' }));
});

test('the Qdrant key and snapshot directory are read from the product configuration', () => {
  assert.deepEqual(qdrantConfigText('log_level: WARN\nstorage:\n  storage_path: /data/storage\n  snapshots_path: /data/snapshots\nservice:\n  read_only_api_key: other\n  api_key: "synthetic-key"\n'), { apiKey: 'synthetic-key', snapshots: '/data/snapshots' });
  assert.deepEqual(qdrantConfigText('service:\n  http_port: 6333\n'), { apiKey: undefined, snapshots: '/qdrant/snapshots' });
});
