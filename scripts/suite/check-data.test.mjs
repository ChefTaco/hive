import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { checkData } from './check-data.mjs';
const fixture = () => {
  const root = mkdtempSync(join(tmpdir(), 'hive-data-integrity-'));
  for (const name of ['source', 'scratch']) mkdirSync(join(root, name), { mode: 0o700 });
  return root;
};
test('checks an uncheckpointed WAL family without changing any source bytes', () => {
  const root = fixture(),
    file = join(root, 'source/database.sqlite');
  const database = new DatabaseSync(file);
  try {
    database.exec(
      'PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; CREATE TABLE records(id INTEGER PRIMARY KEY,value TEXT); INSERT INTO records(value) VALUES (hex(randomblob(9000)));',
    );
    const expectedPages = Object.values(database.prepare('PRAGMA page_count').get())[0];
    const names = readdirSync(join(root, 'source')),
      before = names.map((name) => readFileSync(join(root, 'source', name)));
    const result = checkData(join(root, 'source'), join(root, 'scratch'));
    assert.equal(result.databases, 1);
    assert.equal(result.pages, expectedPages);
    assert.deepEqual(
      names.map((name) => readFileSync(join(root, 'source', name))),
      before,
    );
    assert.equal(readdirSync(join(root, 'scratch')).length, 0);
  } finally {
    database.close();
    rmSync(root, { recursive: true, force: true });
  }
});
test('corrupt SQLite fails even when later files are healthy', () => {
  const root = fixture();
  try {
    writeFileSync(
      join(root, 'source/a-corrupt.sqlite'),
      Buffer.concat([Buffer.from('SQLite format 3\0'), Buffer.alloc(512)]),
    );
    const database = new DatabaseSync(join(root, 'source/z-valid.sqlite'));
    database.exec('CREATE TABLE records(id INTEGER)');
    database.close();
    assert.throws(() => checkData(join(root, 'source'), join(root, 'scratch')));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
