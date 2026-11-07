// Online backup helpers for hive.sh backup. Executed only inside the pinned recovery
// container, as the owning service user, with one service's live /data mounted. Prints JSON
// summaries only: never a secret, a row or file content.
//
// The pause must not grow with the data: everything that can be copied while the service serves
// is copied then, and the pause only proves that copy still current, or brings it up to date.
//
// precopy  copies the service's files while it serves, SQLite databases (and a WAL database's
//          log) as bytes too, and records each one's version: its file identity and times, and for
//          a database its change counter and log header.
// capture  runs while the service is paused. Every SQLite database is read in one read
//          transaction, so a writer paused inside a commit is reported busy and retried; within it
//          a database whose version is unchanged since its pre-copy is kept as copied, and any
//          other is brought up to date by comparing it with its copy and writing only what
//          differs. The copy is then exactly the committed state of the pause instant: the
//          database file, and for a WAL database the log, whose committed frames SQLite replays.
//          Each file is brought up to date the same way.
// verify   runs after the pause, against the copy only: a WAL copy's log is checkpointed into it,
//          then SQLite integrity and journal mode are checked.
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import {
  appendFileSync, closeSync, existsSync, fstatSync, ftruncateSync, lstatSync, mkdirSync, openSync, readFileSync, readSync, readdirSync,
  rmSync, chmodSync, utimesSync, writeFileSync, writeSync,
} from 'node:fs';
import { join } from 'node:path';

const HEADER = 'SQLite format 3\0';
const SIDECARS = ['-wal', '-shm', '-journal'];
const TAIL = 64 * 1024;
const CHUNK = 1024 * 1024;
// File times come from a coarse clock: a file changed shortly before it was read can change again
// without a new time. Such a file is compared by content while paused, never kept by its times.
export const RACY_MS = 1000;
// A paused writer can hold a SQLite lock that blocks readers. The shell resumes the service and
// retries the whole capture when this status is returned.
export const BUSY_EXIT = 75;

const sha = (value) => createHash('sha256').update(value).digest('hex');
export const busyError = (error) => [5, 6].includes((error?.errcode ?? -1) & 0xff) || (error?.code === 'ERR_SQLITE_ERROR' && error?.errcode === 0) || /busy|locked/i.test(String(error?.message));
// A file a serving product removes while it is read, such as a finished rollback journal,
// is not part of its state.
const vanished = (error) => error?.code === 'ENOENT';
const glob = (pattern) => new RegExp('^' + pattern.split('*').map((part) => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('[^/]*') + '$');

function excluded(relative, patterns) {
  return patterns.some((pattern) => {
    const expression = glob(pattern);
    const parts = relative.split('/');
    // A pattern names a path or any directory above it.
    for (let index = 1; index <= parts.length; index++) if (expression.test(parts.slice(0, index).join('/'))) return true;
    return false;
  });
}

function header(file) {
  const descriptor = openSync(file, 'r'), buffer = Buffer.alloc(100);
  try { return { bytes: buffer.subarray(0, readSync(descriptor, buffer, 0, 100, 0)) }; } finally { closeSync(descriptor); }
}
const isSqlite = (file) => header(file).bytes.subarray(0, 16).toString('latin1') === HEADER;
// Bytes 18 and 19 of the header are 2 for a database in WAL mode.
const journalMode = (file) => (header(file).bytes[18] === 2 ? 'wal' : 'rollback');

// The live tree, without the excluded paths. Only directories and regular files owned by this
// service are accepted: anything else needs the stopped backup and a reviewed inventory.
export function walk(root, exclude = [], owner = process.getuid()) {
  const entries = [];
  const visit = (relative) => {
    let names;
    try { names = readdirSync(relative ? join(root, relative) : root).sort(); } catch (error) { if (relative && vanished(error)) return; throw error; }
    for (const name of names) {
      const path = relative ? relative + '/' + name : name;
      if (excluded(path, exclude)) continue;
      let state;
      try { state = lstatSync(join(root, path), { bigint: true }); } catch (error) { if (vanished(error)) continue; throw error; }
      if (Number(state.uid) !== owner) throw Error('A file is owned by another user: ' + path);
      if (state.isDirectory()) { entries.push({ path, type: 'directory', mode: Number(state.mode) & 0o7777, mtimeMs: Number(state.mtimeMs) }); visit(path); continue; }
      if (!state.isFile()) throw Error('Unsupported file type in a live data directory: ' + path);
      entries.push({ path, type: 'file', mode: Number(state.mode) & 0o7777, size: Number(state.size), ino: String(state.ino), mtimeNs: String(state.mtimeNs), ctimeNs: String(state.ctimeNs), mtimeMs: Number(state.mtimeMs) });
    }
  };
  visit('');
  for (const entry of entries) {
    if (entry.type !== 'file') continue;
    try { entry.kind = isSqlite(join(root, entry.path)) ? 'sqlite' : 'file'; } catch (error) { if (!vanished(error)) throw error; entry.kind = 'vanished'; }
  }
  const databases = new Set(entries.filter((entry) => entry.kind === 'sqlite').map((entry) => entry.path));
  for (const entry of entries) {
    if (entry.kind !== 'file') continue;
    const suffix = SIDECARS.find((item) => entry.path.endsWith(item));
    // A sidecar belongs to its database: its committed content is in the SQLite copy.
    if (suffix && databases.has(entry.path.slice(0, -suffix.length))) entry.kind = 'sidecar';
  }
  return entries;
}

// Copies from an open descriptor so the copy is one version of the file: a file that is
// replaced by rename while it is read keeps its old content in this descriptor.
function copyFrom(source, target, mode, offset = 0) {
  const input = openSync(source, 'r');
  try {
    const before = fstatSync(input, { bigint: true });
    const output = openSync(target, offset ? 'a' : 'w', 0o600);
    const buffer = Buffer.allocUnsafe(CHUNK);
    let position = offset, read;
    try {
      while ((read = readSync(input, buffer, 0, CHUNK, position)) > 0) { writeSync(output, buffer, 0, read); position += read; }
    } finally { closeSync(output); }
    chmodSync(target, mode);
    const after = fstatSync(input, { bigint: true });
    const stable = before.size === after.size && before.mtimeNs === after.mtimeNs && before.ctimeNs === after.ctimeNs;
    return { bytes: position, ino: String(after.ino), mtimeNs: String(after.mtimeNs), ctimeNs: String(after.ctimeNs), changedMs: Math.max(Number(after.mtimeMs), Number(after.ctimeMs)), stable, tail: tailDigest(source, position) };
  } finally { closeSync(input); }
}

// Brings a copy up to date with an open file: both are read, and only the chunks that differ
// are written. Reports whether anything within the copy's earlier length changed, or only a tail
// was added.
export function syncFrom(input, target, mode) {
  const size = Number(fstatSync(input).size);
  const output = openSync(target, existsSync(target) ? 'r+' : 'w', 0o600);
  const wanted = Buffer.allocUnsafe(CHUNK), held = Buffer.allocUnsafe(CHUNK);
  let position = 0, written = 0, rewrote = false;
  try {
    const length = Number(fstatSync(output).size);
    while (position < size) {
      const read = readSync(input, wanted, 0, Math.min(CHUNK, size - position), position);
      if (read === 0) break;
      const have = position < length ? readSync(output, held, 0, Math.min(read, length - position), position) : 0;
      if (have !== read || wanted.compare(held, 0, read, 0, read) !== 0) {
        if (have > 0 && wanted.compare(held, 0, have, 0, have) !== 0) rewrote = true;
        writeSync(output, wanted, 0, read, position); written += read;
      }
      position += read;
    }
    if (length > position) rewrote = true;
    ftruncateSync(output, position);
  } finally { closeSync(output); }
  chmodSync(target, mode);
  return { compared: position, written, rewrote };
}

const readAt = (descriptor, position, length) => { const buffer = Buffer.alloc(length); return buffer.subarray(0, readSync(descriptor, buffer, 0, length, position)).toString('hex'); };
const openIfPresent = (path) => { try { return openSync(path, 'r'); } catch (error) { if (vanished(error)) return null; throw error; } };
const fileVersion = (descriptor) => {
  const state = fstatSync(descriptor, { bigint: true });
  return { ino: String(state.ino), size: Number(state.size), mtimeNs: String(state.mtimeNs), ctimeNs: String(state.ctimeNs), changedMs: Math.max(Number(state.mtimeMs), Number(state.ctimeMs)) };
};
const walMode = (descriptor) => readAt(descriptor, 18, 1) === '02';
// What a database's committed state is made of: the database file, with the change counter every
// rollback-journal commit increments, and in WAL mode the log, whose header changes when the log
// restarts and which only grows otherwise; an empty log, as a reader creates, holds nothing. A
// rollback journal with content may be hot.
function databaseVersion(file, database, log) {
  const logged = log !== null && Number(fstatSync(log).size) > 0;
  const version = { database: { ...fileVersion(database), counter: readAt(database, 24, 4) }, log: logged ? { ...fileVersion(log), header: readAt(log, 0, 32) } : null, journal: false };
  const journal = openIfPresent(file + '-journal');
  if (journal !== null) try { version.journal = Number(fstatSync(journal).size) > 0 && /[^0]/.test(readAt(journal, 0, 28)); } finally { closeSync(journal); }
  return version;
}
const versionKey = (version) => JSON.stringify([version.database && { ...version.database, changedMs: 0 }, version.log && { ...version.log, changedMs: 0 }, version.journal]);
export const sameDatabaseVersion = (a, b) => Boolean(a && b) && !a.journal && !b.journal && versionKey(a) === versionKey(b);
export const racy = (version, at) => at - Math.max(version.database.changedMs, version.log?.changedMs ?? 0) < RACY_MS;
function databaseVersionAt(file) {
  const database = openSync(file, 'r');
  let log = null;
  try { if (walMode(database)) log = openIfPresent(file + '-wal'); return databaseVersion(file, database, log); } finally { if (log !== null) closeSync(log); closeSync(database); }
}

function tailDigest(file, length) {
  const start = Math.max(0, length - TAIL), buffer = Buffer.alloc(length - start), descriptor = openSync(file, 'r');
  try { readSync(descriptor, buffer, 0, buffer.length, start); } finally { closeSync(descriptor); }
  return sha(buffer);
}

const directories = (target, entries) => {
  for (const entry of entries) if (entry.type === 'directory') mkdirSync(join(target, entry.path), { recursive: true, mode: 0o700 });
};

export function precopy({ source, target, work, exclude = [] }) {
  const entries = walk(source, exclude);
  directories(target, entries);
  const state = {};
  let bytes = 0;
  for (const entry of entries) {
    const from = join(source, entry.path), to = join(target, entry.path);
    if (entry.kind === 'sqlite') {
      // Copied as bytes while the writer writes, so the copy may be torn: it is kept only if the
      // database's version was the same before and after, and is then one committed state.
      let record;
      try {
        const before = databaseVersionAt(from);
        const copied = copyFrom(from, to, entry.mode);
        const log = before.log ? copyFrom(from + '-wal', to + '-wal', entry.mode) : null;
        if (!before.log) rmSync(to + '-wal', { force: true });
        const after = databaseVersionAt(from);
        record = { database: true, version: after, clean: copied.stable && (log?.stable ?? true) && sameDatabaseVersion(before, after) && !racy(after, Date.now()) };
        bytes += copied.bytes + (log?.bytes ?? 0);
      } catch (error) { if (vanished(error)) continue; throw error; }
      state[entry.path] = record;
      continue;
    }
    if (entry.kind !== 'file') continue;
    let copied;
    try { copied = copyFrom(from, to, entry.mode); } catch (error) { if (vanished(error)) continue; throw error; }
    state[entry.path] = { size: copied.bytes, ino: copied.ino, mtimeNs: copied.mtimeNs, ctimeNs: copied.ctimeNs, stable: copied.stable, tail: copied.tail, racy: Date.now() - copied.changedMs < RACY_MS };
    bytes += copied.bytes;
  }
  writeFileSync(join(work, 'precopy.json'), JSON.stringify(state), { mode: 0o600 });
  return { files: Object.keys(state).length, bytes };
}

const changing = (path) => { const error = Error('A file changed while it was captured: ' + path); error.busy = true; return error; };

// A database at the pause instant, inside one read transaction: a writer paused inside a commit
// holds a lock that makes the read busy, so the capture is retried with the writer resumed. A
// writer that only reserved the database has changed nothing in it yet.
function captureDatabase(from, to, prior, mode, path) {
  let database;
  try {
    database = new DatabaseSync(from, { readOnly: true, timeout: 100 });
    database.exec('BEGIN');
    database.prepare('SELECT count(*) AS n FROM sqlite_schema').get();
  } catch (error) {
    try { database?.close(); } catch {}
    // Node reports SQLITE_BUSY and SQLITE_LOCKED without an error code.
    if (busyError(error)) { const busy = Error('SQLite database is locked: ' + path); busy.busy = true; throw busy; }
    throw error;
  }
  let file = null, log = null;
  try {
    file = openSync(from, 'r');
    const wal = walMode(file);
    if (wal) log = openIfPresent(from + '-wal');
    // The read lock was granted, so SQLite found no hot journal: a journal left by a writer that
    // only reserved the database has changed nothing in it.
    const version = { ...databaseVersion(from, file, log), journal: false };
    const journalMode = wal ? 'wal' : 'rollback', logged = version.log !== null;
    // Unchanged since a clean pre-copy: that copy is this committed state, and is not read again.
    if (prior?.database && prior.clean && sameDatabaseVersion(prior.version, version) && existsSync(to) && (!logged || existsSync(to + '-wal'))) return { journalMode, kept: true, log: logged, compared: 0, written: 0 };
    // Otherwise the copy is brought up to date, writing only what differs. A WAL database's log
    // is copied with it: the committed frames in it are replayed by SQLite, an uncommitted tail
    // left by a paused writer is not.
    let compared = 0, written = 0;
    if (logged) { const synced = syncFrom(log, to + '-wal', mode); compared += synced.compared; written += synced.written; } else rmSync(to + '-wal', { force: true });
    const synced = syncFrom(file, to, mode);
    compared += synced.compared; written += synced.written;
    if (versionKey({ ...databaseVersion(from, file, log), journal: false }) !== versionKey(version)) throw changing(path);
    return { journalMode, kept: false, log: logged, compared, written };
  } finally {
    // Closing these descriptors also drops this process's POSIX locks on the database, the read
    // lock included; nothing is read after this point.
    if (log !== null) closeSync(log);
    if (file !== null) closeSync(file);
    try { database.exec('COMMIT'); } catch {}
    database.close();
  }
}

// While the service is paused nothing changes its files, so this is the consistent state.
// A file unchanged since the pre-copy is kept, unless it had changed just before it was read
// (RACY_MS): then it is compared by content. A file that only grew, on the same inode and with
// the end of the earlier copy unchanged, gains its new tail. Any other file is copied again.
export async function capture({ source, target, work, exclude = [] }) {
  const previous = existsSync(join(work, 'precopy.json')) ? JSON.parse(readFileSync(join(work, 'precopy.json'), 'utf8')) : {};
  const entries = walk(source, exclude);
  directories(target, entries);
  const result = { sqlite: [], kept: 0, appended: 0, copied: 0, removed: 0, compared: 0, written: 0 };
  const expected = new Set(entries.filter((entry) => entry.type === 'directory' || entry.kind === 'file' || entry.kind === 'sqlite').map((entry) => entry.path));
  for (const entry of entries) {
    const from = join(source, entry.path), to = join(target, entry.path);
    if (entry.kind === 'sqlite') {
      rmSync(to + '-shm', { force: true }); rmSync(to + '-journal', { force: true });
      let outcome;
      try { outcome = captureDatabase(from, to, previous[entry.path], entry.mode, entry.path); } catch (error) {
        if (!vanished(error)) throw error;
        expected.delete(entry.path); continue;
      }
      if (outcome.log) expected.add(entry.path + '-wal');
      result.compared += outcome.compared; result.written += outcome.written;
      result.sqlite.push({ path: entry.path, journalMode: outcome.journalMode, mode: entry.mode, mtimeMs: entry.mtimeMs, kept: outcome.kept });
      continue;
    }
    if (entry.kind !== 'file') continue;
    const prior = previous[entry.path];
    const same = prior && !prior.database && prior.stable && prior.ino === entry.ino && prior.ctimeNs === entry.ctimeNs && prior.mtimeNs === entry.mtimeNs && prior.size === entry.size && existsSync(to);
    if (same && !prior.racy) { result.kept++; continue; }
    let grew, copied;
    try {
      if (prior && !prior.database && prior.stable && prior.ino === entry.ino && existsSync(to) && (same || prior.racy)) {
        // Changed just before its pre-copy: its times prove nothing, so its content is compared.
        const input = openSync(from, 'r');
        let synced, stable;
        try { const before = fileVersion(input); synced = syncFrom(input, to, entry.mode); stable = versionKey({ database: before }) === versionKey({ database: fileVersion(input) }); } finally { closeSync(input); }
        if (!stable) throw changing(entry.path);
        result.compared += synced.compared; result.written += synced.written;
        if (synced.written === 0) result.kept++; else if (synced.rewrote) result.copied++; else result.appended++;
        continue;
      }
      grew = prior && !prior.database && prior.stable && prior.ino === entry.ino && entry.size > prior.size && existsSync(to) && lstatSync(to).size === prior.size && tailDigest(from, prior.size) === prior.tail;
      copied = copyFrom(from, to, entry.mode, grew ? prior.size : 0);
    } catch (error) {
      // Only a service that is not paused, such as the edge, can remove a file now.
      if (!vanished(error)) throw error;
      expected.delete(entry.path); entry.kind = 'vanished'; continue;
    }
    // Only a service that is not paused, such as the edge, can change a file now: capture again.
    if (!copied.stable) throw changing(entry.path);
    result.written += copied.bytes - (grew ? prior.size : 0);
    if (grew) result.appended++; else result.copied++;
  }
  // Anything the pre-copy wrote that the paused service no longer has.
  const prune = (relative) => {
    for (const name of readdirSync(relative ? join(target, relative) : target)) {
      const path = relative ? relative + '/' + name : name;
      if (excluded(path, exclude)) continue;
      const state = lstatSync(join(target, path));
      if (!expected.has(path)) { rmSync(join(target, path), { recursive: true, force: true }); result.removed++; continue; }
      if (state.isDirectory()) prune(path);
    }
  };
  prune('');
  for (const entry of entries) if (entry.kind === 'file') utimesSync(join(target, entry.path), entry.mtimeMs / 1000, entry.mtimeMs / 1000);
  for (const entry of [...entries].reverse()) if (entry.type === 'directory') { chmodSync(join(target, entry.path), entry.mode); utimesSync(join(target, entry.path), entry.mtimeMs / 1000, entry.mtimeMs / 1000); }
  writeFileSync(join(work, 'capture.json'), JSON.stringify(result), { mode: 0o600 });
  return { sqlite: result.sqlite.length, sqliteKept: result.sqlite.filter((item) => item.kept).length, kept: result.kept, appended: result.appended, copied: result.copied, removed: result.removed, compared: result.compared, written: result.written };
}

export function verify({ target, work }) {
  const captured = JSON.parse(readFileSync(join(work, 'capture.json'), 'utf8'));
  const databases = [];
  for (const item of captured.sqlite) {
    const file = join(target, item.path);
    const database = new DatabaseSync(file);
    let pages;
    try {
      // A WAL copy holds its committed frames in its log: they are folded into the database.
      if (existsSync(file + '-wal')) {
        const checkpoint = database.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get();
        if (checkpoint.busy !== 0) throw Error('SQLite log could not be checkpointed in the copy: ' + item.path);
      }
      // The copy keeps the source journal mode, so the product opens it as it left it.
      const mode = database.prepare('PRAGMA journal_mode').get().journal_mode;
      if (item.journalMode === 'wal' && mode !== 'wal') database.exec('PRAGMA journal_mode=WAL');
      if (item.journalMode !== 'wal' && mode === 'wal') database.exec('PRAGMA journal_mode=DELETE');
      const integrity = database.prepare('PRAGMA integrity_check').all().map((row) => Object.values(row)[0]);
      if (integrity.join() !== 'ok') throw Error('SQLite integrity failed in the copy: ' + item.path);
      pages = Number(database.prepare('PRAGMA page_count').get().page_count);
    } finally { database.close(); }
    for (const suffix of SIDECARS) rmSync(file + suffix, { force: true });
    if (journalMode(file) !== item.journalMode) throw Error('SQLite journal mode differs in the copy: ' + item.path);
    chmodSync(file, item.mode);
    utimesSync(file, item.mtimeMs / 1000, item.mtimeMs / 1000);
    databases.push({ path: item.path, journalMode: item.journalMode, pages });
  }
  // Contents are hashed once by the controller, in parallel, for the archive manifest.
  let files = 0, bytes = 0;
  const visit = (relative) => {
    for (const name of readdirSync(relative ? join(target, relative) : target).sort()) {
      const path = relative ? relative + '/' + name : name, state = lstatSync(join(target, path));
      if (state.isDirectory()) { visit(path); continue; }
      if (!state.isFile()) throw Error('Unsupported file type in a copy: ' + path);
      files++; bytes += state.size;
    }
  };
  visit('');
  return { files, bytes, sqlite: databases };
}

// The Qdrant API key and snapshot directory come from the product's own mounted configuration.
export function qdrantConfigText(text) {
  const value = (name) => /^\s*(?:"|')?([^"'#\n]*?)(?:"|')?\s*$/.exec(text.split('\n').find((line) => new RegExp('^\\s*' + name + ':').test(line))?.split(/:(.*)/s)[1] ?? '')?.[1]?.trim();
  return { apiKey: value('api_key') || undefined, snapshots: value('snapshots_path') || '/qdrant/snapshots' };
}
const qdrantConfig = (file) => qdrantConfigText(readFileSync(file, 'utf8'));
async function qdrant(url, config) {
  const { apiKey, snapshots } = qdrantConfig(config);
  // A collection the product removed meanwhile answers 404: optional requests then return null.
  const json = async (path, init = {}, optional = false) => {
    const response = await fetch(url + path, { ...init, headers: { 'Content-Type': 'application/json', ...(apiKey ? { 'api-key': apiKey } : {}) } });
    if (optional && response.status === 404) { await response.body?.cancel(); return null; }
    if (!response.ok) throw Error('Qdrant request failed: ' + response.status + ' ' + path.split('?')[0]);
    return (await response.json()).result;
  };
  return { json, snapshots };
}
const collectionNames = async (json) => {
  const names = (await json('/collections')).collections.map((item) => item.name).sort();
  for (const name of names) if (!/^[A-Za-z0-9_.-]{1,255}$/.test(name)) throw Error('A Qdrant collection name needs the stopped backup: ' + name);
  return names;
};
const countPoints = async (json, name, optional = false) => (await json('/collections/' + encodeURIComponent(name) + '/points/count', { method: 'POST', body: JSON.stringify({ exact: true }) }, optional))?.count;
const snapshotDirectory = (snapshots) => {
  if (!snapshots.startsWith('/data/')) throw Error('The Qdrant snapshot directory must be inside its data directory');
  return snapshots.slice('/data/'.length);
};

const canonical = (value) => Array.isArray(value) ? value.map(canonical)
  : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])])) : value;
// The version of every collection, from Qdrant's own telemetry. Every write to a shard is a
// numbered operation in its write-ahead log; a collection whose operation number, queued updates,
// point count, segments and configuration are all the same at two moments was not written in
// between. Null when this Qdrant does not report it: then every collection is snapshotted while
// the writer is paused, as before.
export function qdrantVersionsFrom(telemetry) {
  const collections = telemetry?.collections?.collections;
  if (!Array.isArray(collections)) return null;
  const versions = {};
  for (const item of collections) {
    const shards = [];
    for (const shard of item.shards ?? []) {
      const local = shard.local, queue = local?.update_queue;
      if (!local || (shard.remote ?? []).length || typeof queue?.length !== 'number' || typeof queue.op_num !== 'number') return null;
      shards.push({ id: shard.id, operation: queue.op_num, queued: queue.length, points: local.num_points ?? null, segments: sha((local.segments ?? []).map((segment) => segment.info?.uuid ?? '').sort().join(',')) });
    }
    if (typeof item.id !== 'string' || !shards.length) return null;
    versions[item.id] = { config: sha(JSON.stringify(canonical(item.config ?? null))), shards: shards.sort((a, b) => a.id - b.id) };
  }
  return versions;
}
const qdrantVersions = async (json) => qdrantVersionsFrom(await json('/telemetry?details_level=4'));
const idle = (version) => version.shards.every((shard) => shard.queued === 0);
const sameVersion = (a, b) => Boolean(a && b) && JSON.stringify(a) === JSON.stringify(b);
const sameVersions = (a, b) => Boolean(a && b) && JSON.stringify(Object.keys(a).sort()) === JSON.stringify(Object.keys(b).sort()) && Object.keys(a).every((name) => sameVersion(a[name], b[name]));
// The collections whose snapshot taken while serving still holds their paused state.
export function reusableCollections(previous, versions, names) {
  if (!previous?.versioned || !versions) return [];
  const clean = new Set(previous.clean);
  return names.filter((name) => clean.has(name) && previous.snapshots[name] && previous.collections[name] !== undefined && sameVersion(previous.versions[name], versions[name]));
}

// One snapshot per collection, several at a time. Each one is recorded as soon as Qdrant wrote it
// into its live directory, so a failed backup removes it again.
async function snapshotCollections(json, names, width, { directory, journal, optional = false }) {
  const queue = [...names], created = {};
  await Promise.all(Array.from({ length: Math.min(width, names.length) }, async () => {
    while (queue.length) {
      const name = queue.shift();
      const result = await json('/collections/' + encodeURIComponent(name) + '/snapshots?wait=true', { method: 'POST' }, optional);
      if (!result) continue;
      if (journal) appendFileSync(journal, JSON.stringify({ directory, collection: name, name: result.name }) + '\n', { mode: 0o600 });
      created[name] = { name: result.name, checksum: result.checksum, size: result.size };
    }
  }));
  return created;
}
const qdrantAliasList = async (json) => (await json('/aliases')).aliases.map((item) => ({ alias: item.alias_name, collection: item.collection_name }));

// While the product serves: a snapshot and an exact point count of every collection, between two
// readings of every collection's version. A collection written meanwhile is not clean, and is
// snapshotted again while paused.
export async function qdrantPrecapture({ url, config, work, width = 16 }) {
  const { json, snapshots } = await qdrant(url, config);
  const directory = snapshotDirectory(snapshots), started = Date.now();
  const before = await qdrantVersions(json);
  if (!before) { writeFileSync(join(work, 'qdrant-precapture.json'), JSON.stringify({ versioned: false }), { mode: 0o600 }); return { versioned: false }; }
  const names = await collectionNames(json);
  const created = await snapshotCollections(json, names, width, { directory, journal: join(work, 'qdrant-created.jsonl'), optional: true });
  const collections = {};
  await Promise.all(Object.keys(created).map(async (name) => { const count = await countPoints(json, name, true); if (count !== undefined) collections[name] = count; }));
  const versions = await qdrantVersions(json);
  const clean = Object.keys(collections).filter((name) => before[name] && idle(before[name]) && sameVersion(before[name], versions?.[name])).sort();
  writeFileSync(join(work, 'qdrant-precapture.json'), JSON.stringify({ versioned: Boolean(versions), directory, snapshots: created, collections, versions, clean }), { mode: 0o600 });
  return { versioned: Boolean(versions), collections: names.length, clean: clean.length, seconds: (Date.now() - started) / 1000 };
}

// While the writer is paused. First every write it sent before the pause lands: the versions are
// read until no update is queued and two readings agree. Then a collection whose version still
// equals the clean one its earlier snapshot was taken at is reused, and every other collection,
// one created meanwhile included, is snapshotted now. Aliases are recorded too.
export async function qdrantCapture({ url, config, work, width = 16, settle = 40 }) {
  const { json, snapshots } = await qdrant(url, config);
  const directory = snapshotDirectory(snapshots);
  const file = join(work ?? '/nonexistent', 'qdrant-precapture.json');
  const previous = work && existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : { versioned: false };
  let versions = null;
  if (previous.versioned) {
    let last = await qdrantVersions(json);
    for (let attempt = 0; last && attempt < settle; attempt++) {
      await new Promise((done) => setTimeout(done, 25));
      const next = await qdrantVersions(json);
      if (next && Object.values(next).every(idle) && sameVersions(last, next)) { versions = next; break; }
      last = next;
    }
  }
  const names = await collectionNames(json);
  const reused = new Set(reusableCollections(previous, versions, names));
  const fresh = names.filter((name) => !reused.has(name));
  const created = await snapshotCollections(json, fresh, width, { directory, journal: work ? join(work, 'qdrant-created.jsonl') : null });
  const counts = Object.fromEntries(await Promise.all(fresh.map(async (name) => [name, await countPoints(json, name)])));
  const result = { directory, snapshots: {}, collections: {}, aliases: await qdrantAliasList(json), reused: reused.size, captured: fresh.length };
  for (const name of names) {
    result.snapshots[name] = reused.has(name) ? previous.snapshots[name] : created[name];
    result.collections[name] = reused.has(name) ? previous.collections[name] : counts[name];
  }
  return result;
}

// Recreates recorded aliases in a restored store, then reports what it holds.
export async function qdrantAliases({ url, config, aliases }) {
  const { json } = await qdrant(url, config);
  if (aliases.length) await json('/collections/aliases', { method: 'POST', body: JSON.stringify({ actions: aliases.map((item) => ({ create_alias: { collection_name: item.collection, alias_name: item.alias } })) }) });
  return { aliases: (await json('/aliases')).aliases.map((item) => ({ alias: item.alias_name, collection: item.collection_name })) };
}

// Point counts and a content digest of every collection: ids, vectors and payloads.
export async function qdrantInventory({ url, config }) {
  const { json } = await qdrant(url, config);
  const collections = {};
  for (const name of await collectionNames(json)) {
    const hashes = [];
    let offset;
    do {
      const page = await json('/collections/' + encodeURIComponent(name) + '/points/scroll', { method: 'POST', body: JSON.stringify({ limit: 256, with_vector: true, with_payload: true, ...(offset !== undefined && offset !== null ? { offset } : {}) }) });
      for (const point of page.points) hashes.push(sha(JSON.stringify(canonical(point))));
      offset = page.next_page_offset;
    } while (offset !== undefined && offset !== null);
    collections[name] = { points: hashes.length, contentSHA256: sha(hashes.sort().join('\n')) };
  }
  return { collections };
}

async function main(request) {
  switch (request.command) {
    case 'precopy': return precopy(request);
    case 'capture': return capture(request);
    case 'verify': return verify(request);
    case 'qdrant-precapture': return qdrantPrecapture(request);
    case 'qdrant-capture': return qdrantCapture(request);
    case 'qdrant-inventory': return qdrantInventory(request);
    case 'qdrant-aliases': return qdrantAliases(request);
    default: throw Error('Unknown snapshot command');
  }
}

// Run with a JSON request as the only argument; imported, it only exports its helpers.
if (process.argv[1]?.startsWith('{')) {
  main(JSON.parse(process.argv[1])).then(
    (result) => { console.log(JSON.stringify(result)); process.exit(0); },
    (error) => { console.error('Hive snapshot: ' + error.message); process.exit(error.busy ? BUSY_EXIT : 1); },
  );
}
