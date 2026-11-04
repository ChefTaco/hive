// Executed only inside the pinned recovery container against stopped stores.
import {
  readdirSync,
  lstatSync,
  openSync,
  readSync,
  closeSync,
  existsSync,
  copyFileSync,
  mkdtempSync,
  rmSync,
  constants,
} from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export function checkData(source, scratch) {
  let databases = 0,
    pages = 0;
  function walk(directory) {
    for (const name of readdirSync(directory)) {
      const file = join(directory, name),
        state = lstatSync(file);
      if (state.isDirectory()) {
        walk(file);
        continue;
      }
      if (!state.isFile()) throw Error('Unsupported recovery file type');
      const descriptor = openSync(file, 'r'),
        header = Buffer.alloc(16);
      try {
        readSync(descriptor, header, 0, 16, 0);
      } finally {
        closeSync(descriptor);
      }
      if (header.toString() !== 'SQLite format 3\0') continue;
      // SQLite may need a writable shared-memory sidecar even for a read-only
      // WAL database. Check a complete private family copy, never the source.
      const temporary = mkdtempSync(join(scratch, 'sqlite-')),
        target = join(temporary, 'database');
      let database,
        verified = false;
      try {
        copyFileSync(file, target, constants.COPYFILE_FICLONE);
        for (const suffix of ['-wal', '-shm']) {
          const sidecar = file + suffix;
          if (!existsSync(sidecar)) {
            try {
              if (lstatSync(sidecar).isSymbolicLink())
                throw Error('Unsafe recovery database sidecar');
            } catch (error) {
              if (error.code !== 'ENOENT') throw error;
            }
            continue;
          }
          if (!lstatSync(sidecar).isFile() || lstatSync(sidecar).isSymbolicLink())
            throw Error('Unsafe recovery database sidecar');
          copyFileSync(sidecar, target + suffix, constants.COPYFILE_FICLONE);
        }
        database = new DatabaseSync(target, { readOnly: true });
        const result = database.prepare('PRAGMA integrity_check').all();
        if (result.length !== 1 || Object.values(result[0])[0] !== 'ok')
          throw Error('SQLite integrity failed');
        pages += Object.values(database.prepare('PRAGMA page_count').get())[0];
        databases++;
        verified = true;
      } finally {
        database?.close();
        if (verified) rmSync(temporary, { recursive: true });
      }
    }
  }
  walk(source);
  return { sqliteIntegrity: 'passed', databases, pages };
}
