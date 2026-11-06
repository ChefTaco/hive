// Unit tests for the online backup helper. They run the helper's own functions on the host,
// against a live SQLite writer in this process.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { busyError, capture, precopy, verify, walk, qdrantConfigText } from './snapshot-data.mjs';

const fixture = () => {
  const root = mkdtempSync(join(tmpdir(), 'hive-snapshot-'));
  for (const name of ['data', 'out', 'work']) mkdirSync(join(root, name), { mode: 0o700 });
  return { root, source: join(root, 'data'), target: join(root, 'out'), work: join(root, 'work') };
};
const rows = (file) => { const database = new DatabaseSync(file, { readOnly: true }); try { return database.prepare('SELECT count(*) AS c FROM t').get().c; } finally { database.close(); } };

test('a live WAL database is copied at the capture instant, in WAL mode, without sidecars', async () => {
  const { root, source, target, work } = fixture();
  try {
    const live = new DatabaseSync(join(source, 'live.db'));
    live.exec('PRAGMA journal_mode=WAL; CREATE TABLE t(n INTEGER PRIMARY KEY, v TEXT)');
    const insert = live.prepare('INSERT INTO t(v) VALUES (?)');
    for (let index = 0; index < 500; index++) insert.run('before ' + index);
    assert(existsSync(join(source, 'live.db-wal')), 'The writer keeps committed frames in the WAL');
    precopy({ source, target, work });
    assert(!existsSync(join(target, 'live.db')), 'A database is never pre-copied as a file');
    for (let index = 0; index < 250; index++) insert.run('after ' + index);
    const result = await capture({ source, target, work });
    assert.equal(result.sqlite, 1);
    for (let index = 0; index < 100; index++) insert.run('later ' + index);
    const verified = verify({ target, work });
    assert.deepEqual(verified.sqlite, [{ path: 'live.db', journalMode: 'wal', pages: verified.sqlite[0].pages }]);
    assert.deepEqual(readdirSync(target).sort(), ['live.db'], 'No -wal or -shm sidecar is copied or left behind');
    assert.equal(readFileSync(join(target, 'live.db')).subarray(18, 20).toString('hex'), '0202', 'The copy stays in WAL mode');
    assert.equal(rows(join(target, 'live.db')), 750, 'The copy holds every row committed at capture, WAL frames included');
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
    assert.deepEqual(result, { sqlite: 0, kept: 2, appended: 1, copied: 3, removed: 1 });
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
