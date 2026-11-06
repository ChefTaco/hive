// Unit tests for the hive.sh migrate-native data helpers: what preservation compares exactly and
// which columns a live client may change. Fake data only.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { CREDENTIAL_TABLES, LIVE_COLUMNS, canonicalRedisValue, compareDatabases, compareRedis, databaseState } from './migrate-native-data.mjs';

const fixture = (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'hive-migrate-data-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const file = join(directory, 'router.db');
  const database = new DatabaseSync(file);
  database.exec(`CREATE TABLE ClientApiKey (id TEXT PRIMARY KEY, name TEXT, keyPrefix TEXT, keyHash TEXT, enabled INTEGER, metadataJson TEXT, lastUsedAt TEXT, createdAt TEXT, updatedAt TEXT, expiresAt TEXT);
    CREATE TABLE Trace (id TEXT PRIMARY KEY, body TEXT);
    INSERT INTO ClientApiKey VALUES ('key-1','portal','sk-fake1','fakesalt:fakehash',1,'{"scopes":["models:read"]}',NULL,'2026-01-01T00:00:00.000+00:00','2026-01-01T00:00:00.000+00:00',NULL);
    INSERT INTO Trace VALUES ('trace-1','fake');`);
  return { file, database, before: databaseState(file) };
};
const compare = (state, file, options) => {
  const columns = Object.fromEntries(Object.entries(state.tables).map(([name, table]) => [name, table.columns]));
  const stable = Object.fromEntries(Object.entries(state.tables).filter(([, table]) => table.stableColumns).map(([name, table]) => [name, table.stableColumns]));
  return compareDatabases(state, databaseState(file, columns, stable), [], options);
};
const live = { tables: CREDENTIAL_TABLES.emberpath, live: true };

test('the live columns are exactly the API key usage stamps', () => {
  assert.deepEqual(LIVE_COLUMNS, { ClientApiKey: ['lastUsedAt', 'updatedAt'] });
  assert(Object.isFrozen(LIVE_COLUMNS) && Object.isFrozen(LIVE_COLUMNS.ClientApiKey));
  assert.deepEqual(CREDENTIAL_TABLES, { oathweave: ['clients', 'roles', 'user_role_assignments'], emberpath: ['ClientApiKey'], hiveskills: [] });
});

test('the capture keeps hashes without the live columns', (t) => {
  const { before } = fixture(t);
  assert.deepEqual(before.tables.ClientApiKey.stableColumns, ['id', 'name', 'keyPrefix', 'keyHash', 'enabled', 'metadataJson', 'createdAt', 'expiresAt']);
  assert.equal(before.tables.ClientApiKey.stableHashes.length, 1);
  assert.equal(before.tables.Trace.stableHashes, undefined);
});

test('preservation is exact: a used API key is a changed row', (t) => {
  const { file, database, before } = fixture(t);
  database.exec("UPDATE ClientApiKey SET lastUsedAt='2026-01-02T00:00:00.000+00:00', updatedAt='2026-01-02T00:00:00.000+00:00'");
  assert.deepEqual(compare(before, file).violations, ['ClientApiKey: 1 existing rows changed or removed']);
});

test('while serving, only the usage stamps of a credential row may change', (t) => {
  const { file, database, before } = fixture(t);
  database.exec("UPDATE ClientApiKey SET lastUsedAt='2026-01-02T00:00:00.000+00:00', updatedAt='2026-01-02T00:00:00.000+00:00'; UPDATE Trace SET body='changed'");
  database.exec("INSERT INTO ClientApiKey VALUES ('key-2','new','sk-fake2','fakesalt:other',1,NULL,NULL,'2026-01-03T00:00:00.000+00:00','2026-01-03T00:00:00.000+00:00',NULL)");
  const result = compare(before, file, live);
  assert.deepEqual(result.violations, []);
  assert.deepEqual(result.changed, { ClientApiKey: { before: 1, after: 2, removedOrChanged: 0, addedOrChanged: 1 } });
  for (const change of ["keyHash='fakesalt:replaced'", "keyPrefix='sk-other'", 'enabled=0', `metadataJson='{"scopes":["*"]}'`, "expiresAt='2026-02-01T00:00:00.000+00:00'", "createdAt='2026-01-05T00:00:00.000+00:00'"]) {
    const other = fixture(t);
    other.database.exec(`UPDATE ClientApiKey SET ${change}`);
    assert.deepEqual(compare(other.before, other.file, live).violations, ['ClientApiKey: 1 existing rows changed or removed'], change);
  }
  const removed = fixture(t);
  removed.database.exec('DELETE FROM ClientApiKey');
  assert.deepEqual(compare(removed.before, removed.file, live).violations, ['ClientApiKey: 1 existing rows changed or removed']);
});

test('a live comparison refuses a capture without live-tolerant hashes', (t) => {
  const { file, before } = fixture(t);
  delete before.tables.ClientApiKey.stableHashes;
  delete before.tables.ClientApiKey.stableColumns;
  assert.deepEqual(compare(before, file, live).violations, ['ClientApiKey: the capture has no live-tolerant hashes']);
});

test('row hashes are unchanged from earlier captures', (t) => {
  // The hash of a row is the hash of its JSON in column order, as in earlier releases.
  const { before } = fixture(t);
  assert.deepEqual(before.tables.Trace.hashes, [createHash('sha256').update(JSON.stringify({ id: 'trace-1', body: 'fake' })).digest('hex').slice(0, 40)]);
});

test('Redis records must stay, except those whose own expiry passed', () => {
  const now = Date.parse('2026-01-01T00:00:00Z');
  const before = { a: { value: 'v1', expiresAt: null }, b: { value: 'v2', expiresAt: now - 1000 }, c: { value: 'v3', expiresAt: now + 3600000 } };
  assert.deepEqual(compareRedis(before, { a: before.a, c: before.c }, now), { recorded: 3, present: 2, expiredSinceCapture: 1, missing: 0, changed: 0, unexpected: 0, unchanged: true });
  assert.equal(compareRedis(before, { a: before.a }, now).missing, 1);
  assert.equal(compareRedis(before, { a: { value: 'other', expiresAt: null }, c: before.c }, now).changed, 1);
  assert.equal(compareRedis(before, { ...before, d: { value: 'v4', expiresAt: null } }, now).unexpected, 1);
});

test('a Redis value is compared by content, not by its encoding or member order', () => {
  const b = (text) => Buffer.from(text);
  assert.equal(canonicalRedisValue('hash', [b('f2'), b('v2'), b('f1'), b('v1')]), canonicalRedisValue('hash', [b('f1'), b('v1'), b('f2'), b('v2')]));
  assert.notEqual(canonicalRedisValue('hash', [b('f1'), b('v1')]), canonicalRedisValue('hash', [b('f1'), b('v2')]));
  assert.equal(canonicalRedisValue('set', [b('b'), b('a')]), canonicalRedisValue('set', [b('a'), b('b')]));
  assert.notEqual(canonicalRedisValue('list', [b('b'), b('a')]), canonicalRedisValue('list', [b('a'), b('b')]));
  assert.notEqual(canonicalRedisValue('string', b('1')), canonicalRedisValue('list', [b('1')]));
  assert.equal(canonicalRedisValue('stream', [[b('1-0'), [b('k'), b('v')]]]), JSON.stringify(['stream', [['MS0w', ['aw==', 'dg==']]]]));
});

test('a reader waits for a product holding a write lock instead of failing', async (t) => {
  const { file, database } = fixture(t);
  database.close();
  // A writer in another process holds an exclusive lock for a moment, as a live product does.
  const writer = spawn(process.execPath, ['--no-warnings', '--input-type=module', '-e', `import { DatabaseSync } from 'node:sqlite'; const db = new DatabaseSync(process.argv[1]); db.exec('BEGIN EXCLUSIVE'); console.log('locked'); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1500); db.exec('COMMIT'); db.close();`, file]);
  await new Promise((done) => writer.stdout.once('data', done));
  const started = Date.now();
  const state = databaseState(file);
  assert(Date.now() - started >= 500, 'The reader waited for the lock');
  assert.equal(state.tables.ClientApiKey.count, 1);
  await new Promise((done) => writer.once('exit', done));
});
