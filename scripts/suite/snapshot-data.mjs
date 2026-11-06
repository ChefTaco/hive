// Online backup helpers for hive.sh backup. Executed only inside the pinned recovery
// container, as the owning service user, with one service's live /data mounted. Prints JSON
// summaries only: never a secret, a row or file content.
//
// precopy  copies the service's ordinary files while it serves, so the pause stays short.
// capture  runs while the service is paused: every SQLite database is copied with the SQLite
//          online backup API (one read transaction, so a consistent snapshot that also includes
//          committed WAL frames), and each file is brought up to date with the paused state.
// verify   runs after the pause, against the copy only: SQLite integrity and journal mode.
import { DatabaseSync, backup } from 'node:sqlite';
import { createHash } from 'node:crypto';
import {
  closeSync, existsSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, readSync, readdirSync,
  rmSync, chmodSync, utimesSync, writeFileSync, writeSync,
} from 'node:fs';
import { join } from 'node:path';

const HEADER = 'SQLite format 3\0';
const SIDECARS = ['-wal', '-shm', '-journal'];
const TAIL = 64 * 1024;
const CHUNK = 1024 * 1024;
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
    return { bytes: position, ino: String(after.ino), mtimeNs: String(after.mtimeNs), ctimeNs: String(after.ctimeNs), stable, tail: tailDigest(source, position) };
  } finally { closeSync(input); }
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
    if (entry.kind !== 'file') continue;
    let copied;
    try { copied = copyFrom(join(source, entry.path), join(target, entry.path), entry.mode); } catch (error) { if (vanished(error)) continue; throw error; }
    state[entry.path] = { size: copied.bytes, ino: copied.ino, mtimeNs: copied.mtimeNs, ctimeNs: copied.ctimeNs, stable: copied.stable, tail: copied.tail };
    bytes += copied.bytes;
  }
  writeFileSync(join(work, 'precopy.json'), JSON.stringify(state), { mode: 0o600 });
  return { files: Object.keys(state).length, bytes };
}

// While the service is paused nothing changes its files, so this is the consistent state.
// A file unchanged since the pre-copy is kept. A file that only grew, on the same inode and
// with the end of the earlier copy unchanged, gains its new tail. Any other file is copied again.
export async function capture({ source, target, work, exclude = [] }) {
  const previous = existsSync(join(work, 'precopy.json')) ? JSON.parse(readFileSync(join(work, 'precopy.json'), 'utf8')) : {};
  const entries = walk(source, exclude);
  directories(target, entries);
  const result = { sqlite: [], kept: 0, appended: 0, copied: 0, removed: 0 };
  const expected = new Set(entries.filter((entry) => entry.type === 'directory' || entry.kind === 'file' || entry.kind === 'sqlite').map((entry) => entry.path));
  for (const entry of entries) {
    const from = join(source, entry.path), to = join(target, entry.path);
    if (entry.kind === 'sqlite') {
      rmSync(to, { force: true });
      for (const suffix of SIDECARS) rmSync(to + suffix, { force: true });
      let database;
      try {
        database = new DatabaseSync(from, { readOnly: true, timeout: 100 });
        // One step copies every page inside a single read transaction.
        await backup(database, to, { rate: 2147483647 });
      } catch (error) {
        // A writer paused inside a write transaction holds the lock. The backup step then
        // fails with SQLITE_BUSY or SQLITE_LOCKED, which Node reports without an error code.
        if (busyError(error)) { const busy = Error('SQLite database is locked: ' + entry.path); busy.busy = true; throw busy; }
        throw error;
      } finally { database?.close(); }
      chmodSync(to, entry.mode);
      result.sqlite.push({ path: entry.path, journalMode: journalMode(from), mode: entry.mode, mtimeMs: entry.mtimeMs });
      continue;
    }
    if (entry.kind !== 'file') continue;
    const prior = previous[entry.path];
    const same = prior && prior.stable && prior.ino === entry.ino && prior.ctimeNs === entry.ctimeNs && prior.mtimeNs === entry.mtimeNs && prior.size === entry.size && existsSync(to);
    if (same) { result.kept++; continue; }
    let grew, copied;
    try {
      grew = prior && prior.stable && prior.ino === entry.ino && entry.size > prior.size && existsSync(to) && lstatSync(to).size === prior.size && tailDigest(from, prior.size) === prior.tail;
      copied = copyFrom(from, to, entry.mode, grew ? prior.size : 0);
    } catch (error) {
      // Only a service that is not paused, such as the edge, can remove a file now.
      if (!vanished(error)) throw error;
      expected.delete(entry.path); entry.kind = 'vanished'; continue;
    }
    // Only a service that is not paused, such as the edge, can change a file now: capture again.
    if (!copied.stable) { const changing = Error('A file changed while it was captured: ' + entry.path); changing.busy = true; throw changing; }
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
  return { sqlite: result.sqlite.length, kept: result.kept, appended: result.appended, copied: result.copied, removed: result.removed };
}

export function verify({ target, work }) {
  const captured = JSON.parse(readFileSync(join(work, 'capture.json'), 'utf8'));
  const databases = [];
  for (const item of captured.sqlite) {
    const file = join(target, item.path);
    const database = new DatabaseSync(file);
    let pages;
    try {
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
  const json = async (path, init = {}) => {
    const response = await fetch(url + path, { ...init, headers: { 'Content-Type': 'application/json', ...(apiKey ? { 'api-key': apiKey } : {}) } });
    if (!response.ok) throw Error('Qdrant request failed: ' + response.status + ' ' + path.split('?')[0]);
    return (await response.json()).result;
  };
  return { json, snapshots };
}
const collectionNames = async (json) => (await json('/collections')).collections.map((item) => item.name).sort();
const countPoints = async (json, name) => (await json('/collections/' + encodeURIComponent(name) + '/points/count', { method: 'POST', body: JSON.stringify({ exact: true }) })).count;

// One snapshot per collection, several at a time: Qdrant spends most of a snapshot on fixed
// per-collection work, so this keeps the writer's pause short. Aliases are recorded too.
export async function qdrantSnapshot({ url, config, width = 16 }) {
  const { json, snapshots } = await qdrant(url, config);
  if (!snapshots.startsWith('/data/')) throw Error('The Qdrant snapshot directory must be inside its data directory');
  const names = await collectionNames(json);
  for (const name of names) if (!/^[A-Za-z0-9_.-]{1,255}$/.test(name)) throw Error('A Qdrant collection name needs the stopped backup: ' + name);
  const queue = [...names], created = {};
  await Promise.all(Array.from({ length: Math.min(width, names.length) }, async () => {
    while (queue.length) {
      const name = queue.shift();
      const result = await json('/collections/' + encodeURIComponent(name) + '/snapshots?wait=true', { method: 'POST' });
      created[name] = { name: result.name, checksum: result.checksum, size: result.size };
    }
  }));
  const collections = {};
  for (const name of names) collections[name] = await countPoints(json, name);
  const aliases = (await json('/aliases')).aliases.map((item) => ({ alias: item.alias_name, collection: item.collection_name }));
  return { directory: snapshots.slice('/data/'.length), snapshots: created, collections, aliases };
}
// Recreates recorded aliases in a restored store, then reports what it holds.
export async function qdrantAliases({ url, config, aliases }) {
  const { json } = await qdrant(url, config);
  if (aliases.length) await json('/collections/aliases', { method: 'POST', body: JSON.stringify({ actions: aliases.map((item) => ({ create_alias: { collection_name: item.collection, alias_name: item.alias } })) }) });
  return { aliases: (await json('/aliases')).aliases.map((item) => ({ alias: item.alias_name, collection: item.collection_name })) };
}

const canonical = (value) => Array.isArray(value) ? value.map(canonical)
  : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])])) : value;
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
    case 'qdrant-snapshot': return qdrantSnapshot(request);
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
