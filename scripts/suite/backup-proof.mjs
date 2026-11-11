// Developer proof for an online backup taken under live traffic. Every store of a suite host
// is inventoried before the backup (T0), inside the archive (A) and after the backup (T1):
// SQLite rows, Qdrant points with vectors and payloads, Redis records with absolute expiry, and
// file contents. The archive must hold every record that was unchanged from T0 to T1, exactly;
// every other difference is a record that live traffic wrote, changed or removed while the
// backup ran, and is counted and reported as such. Never prints a record or secret.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { closeSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, readSync, readdirSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { DatabaseSync, backup } from 'node:sqlite';
import { serviceUser } from './sudo-target.mjs';

const root = resolve(import.meta.dirname, '../..');
const sha = (value) => createHash('sha256').update(value).digest('hex');
const docker = (...args) => execFileSync('docker', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 512 * 1024 * 1024 }).trim();
const header = (file) => { const descriptor = openSync(file, 'r'), buffer = Buffer.alloc(16); try { readSync(descriptor, buffer, 0, 16, 0); } finally { closeSync(descriptor); } return buffer.toString('latin1'); };
const STORES = { 'oathweave-redis': ['appendonlydir', 'dump.rdb'], 'hivemem-qdrant': ['storage', 'snapshots', '.qdrant-initialized'] };

function walk(base) {
  const files = [];
  const visit = (relative) => {
    for (const name of readdirSync(join(base, relative)).sort()) {
      const path = relative ? relative + '/' + name : name, state = lstatSync(join(base, path));
      if (state.isDirectory()) visit(path); else if (state.isFile()) files.push(path);
    }
  };
  visit('');
  return files;
}
const prefixDigest = (file, length) => {
  const hash = createHash('sha256'), descriptor = openSync(file, 'r'), buffer = Buffer.allocUnsafe(1 << 20);
  let position = 0, read;
  try { while (position < length && (read = readSync(descriptor, buffer, 0, Math.min(buffer.length, length - position), position)) > 0) { hash.update(buffer.subarray(0, read)); position += read; } } finally { closeSync(descriptor); }
  return position === length ? hash.digest('hex') : null;
};

// SQLite rows by content, read from a consistent online copy so a live writer is never blocked.
async function sqliteRows(file, scratch) {
  const copy = join(scratch, 'copy-' + randomBytes(6).toString('hex') + '.db');
  const source = new DatabaseSync(file, { readOnly: true, timeout: 5000 });
  try { await backup(source, copy, { rate: 2147483647 }); } finally { source.close(); }
  const database = new DatabaseSync(copy, { readOnly: true });
  try {
    const tables = {};
    for (const { name } of database.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all()) {
      const text = (row) => JSON.stringify(row, (_, value) => (typeof value === 'bigint' ? value.toString() : ArrayBuffer.isView(value) ? Buffer.from(value.buffer, value.byteOffset, value.byteLength).toString('base64') : value));
      tables[name] = database.prepare('SELECT * FROM "' + name.replaceAll('"', '""') + '"').all().map((row) => sha(text(row)).slice(0, 40));
    }
    return tables;
  } finally { database.close(); rmSync(copy, { force: true }); }
}

// Reached through a helper container in the store's network namespace, as the controller does.
function inContainer(container, code, environment = {}) {
  const result = docker('run', '--rm', '--network', 'container:' + container, '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges:true', '--user', serviceUser,
    ...Object.entries(environment).flatMap(([key, value]) => ['-e', key + '=' + value]), '--mount', `type=bind,source=${join(root, 'scripts/suite')},target=/tools,readonly`,
    'node:24.22.3-slim@sha256:dc26ae92c9fb15cf6b1d63e20f0944b2efe0f115b20e00be48fb23fceb061c54', 'node', '--no-warnings', '--input-type=module', '-e', code);
  return JSON.parse(result);
}
const qdrantPoints = (container, key) => inContainer(container, `
  import { createHash } from 'node:crypto';
  const sha = (v) => createHash('sha256').update(v).digest('hex');
  const canonical = (v) => Array.isArray(v) ? v.map(canonical) : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, canonical(v[k])])) : v;
  const json = async (path, body) => { const r = await fetch('http://127.0.0.1:6333' + path, { method: body ? 'POST' : 'GET', headers: { 'api-key': process.env.KEY, 'Content-Type': 'application/json' }, body: body && JSON.stringify(body) }); if (!r.ok) throw Error(String(r.status)); return (await r.json()).result; };
  const result = {};
  for (const { name } of (await json('/collections')).collections) {
    const hashes = []; let offset;
    do { const page = await json('/collections/' + encodeURIComponent(name) + '/points/scroll', { limit: 512, with_vector: true, with_payload: true, ...(offset != null ? { offset } : {}) }); for (const p of page.points) hashes.push(String(p.id) + ':' + sha(JSON.stringify(canonical(p))).slice(0, 40)); offset = page.next_page_offset; } while (offset != null);
    result[name] = hashes;
  }
  console.log(JSON.stringify(result));`, { KEY: key });
// Every Redis record: key and value by digest, with its absolute expiry.
const redisRecords = (container, password) => inContainer(container, `
  import { createConnection } from 'node:net';
  import { canonicalRedisValue } from '/tools/migrate-native-data.mjs';
  import { createHash } from 'node:crypto';
  const sha = (v) => createHash('sha256').update(v).digest('hex');
  const socket = createConnection(6379, '127.0.0.1'); let buffer = Buffer.alloc(0); const waiting = [];
  const parse = (o) => { const e = buffer.indexOf('\\r\\n', o); if (e < 0) return null; const k = String.fromCharCode(buffer[o]), t = buffer.subarray(o + 1, e).toString(), n = e + 2;
    if (k === '+' || k === '-') return { value: t, next: n }; if (k === ':') return { value: Number(t), next: n };
    if (k === '$') { const s = Number(t); if (s < 0) return { value: null, next: n }; return buffer.length < n + s + 2 ? null : { value: buffer.subarray(n, n + s), next: n + s + 2 }; }
    if (k === '*') { const items = []; let c = n; for (let i = 0; i < Number(t); i++) { const x = parse(c); if (!x) return null; items.push(x.value); c = x.next; } return { value: items, next: c }; } throw Error('reply'); };
  socket.on('data', (d) => { buffer = Buffer.concat([buffer, d]); for (;;) { if (!waiting.length) return; const r = parse(0); if (!r) return; buffer = buffer.subarray(r.next); waiting.shift()(r.value); } });
  const cmd = (...p) => new Promise((done) => { waiting.push(done); const v = p.map((x) => Buffer.from(String(x))); socket.write(Buffer.concat([Buffer.from('*' + v.length + '\\r\\n'), ...v.flatMap((x) => [Buffer.from('$' + x.length + '\\r\\n'), x, Buffer.from('\\r\\n')])])); });
  await cmd('AUTH', process.env.PASSWORD);
  const read = { string: ['GET'], hash: ['HGETALL'], set: ['SMEMBERS'], zset: ['ZRANGE', 0, -1, 'WITHSCORES'], list: ['LRANGE', 0, -1], stream: ['XRANGE', '-', '+'] };
  const records = {}; let cursor = '0';
  do { const [next, keys] = await cmd('SCAN', cursor, 'COUNT', 1000); cursor = next.toString();
    for (const key of keys) { const ttl = await cmd('PTTL', key); if (ttl === -2) continue; const type = String(await cmd('TYPE', key)); if (!read[type]) continue;
      records[sha(key)] = { value: sha(canonicalRedisValue(type, await cmd(read[type][0], key, ...read[type].slice(1)))), expiresAt: ttl > 0 ? Date.now() + ttl : null }; } } while (cursor !== '0');
  socket.end(); console.log(JSON.stringify(records));`, { PASSWORD: password });

const secretOf = (file, pattern) => pattern.exec(readFileSync(file, 'utf8'))?.[1]?.trim();

// One host's state. live: the running suite directory; archive: an extracted data tree.
export async function inventory({ suite, data, scratch, live = true }) {
  const compose = JSON.parse(readFileSync(join(suite, 'compose.json'), 'utf8'));
  const result = { sqlite: {}, files: {}, qdrant: {}, redis: {} };
  const temporary = [];
  try {
    for (const service of readdirSync(data).sort()) {
      const excluded = STORES[service] ?? [];
      for (const path of walk(join(data, service))) {
        if (excluded.some((item) => path === item || path.startsWith(item + '/'))) continue;
        const file = join(data, service, path);
        if (/-(wal|shm|journal)$/.test(path)) continue;
        if (header(file) === 'SQLite format 3\0') { result.sqlite[service + '/' + path] = await sqliteRows(file, scratch); continue; }
        const content = readFileSync(file);
        result.files[service + '/' + path] = { size: content.length, sha256: sha(content) };
      }
    }
    const key = secretOf(join(suite, 'config/hivemem-qdrant/qdrant.yaml'), /^\s*api_key:\s*(\S+)/m);
    const password = secretOf(join(suite, 'config/oathweave-redis/redis.conf'), /^requirepass\s+(\S+)/m);
    const container = (name, ...args) => { const id = 'proof-' + name + '-' + randomBytes(4).toString('hex'); temporary.push(id); docker('run', '-d', '--name', id, '--network', 'none', '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges:true', '--user', serviceUser, '--tmpfs', '/tmp:mode=1777', ...args); return id; };
    const retry = (work) => { for (let attempt = 0; ; attempt++) { try { return work(); } catch (error) { if (attempt > 90) throw error; execFileSync('sleep', ['1']); } } };
    if (compose.services['hivemem-qdrant']) {
      const target = live ? docker('compose', '-f', join(suite, 'compose.json'), 'ps', '-q', 'hivemem-qdrant')
        : container('qdrant', '--workdir', '/data', '--mount', `type=bind,source=${join(data, 'hivemem-qdrant')},target=/data`, '--mount', `type=bind,source=${join(suite, 'config/hivemem-qdrant')},target=/config,readonly`, '--entrypoint', '/qdrant/qdrant', compose.services['hivemem-qdrant'].image, '--config-path', '/config/qdrant.yaml');
      result.qdrant = retry(() => qdrantPoints(target, key));
    }
    if (compose.services['oathweave-redis']) {
      const target = live ? docker('compose', '-f', join(suite, 'compose.json'), 'ps', '-q', 'oathweave-redis')
        : container('redis', '--mount', `type=bind,source=${join(data, 'oathweave-redis')},target=/data`, '--mount', `type=bind,source=${join(suite, 'config/oathweave-redis')},target=/config,readonly`, compose.services['oathweave-redis'].image, 'redis-server', '/config/redis.conf');
      result.redis = retry(() => redisRecords(target, password));
    }
  } finally { for (const id of temporary) try { docker('rm', '-f', id); } catch { /* gone */ } }
  return result;
}

// Records as multisets: unchanged from T0 to T1 must be in the archive exactly.
function compareList(before, archived, after) {
  const count = (list) => { const map = new Map(); for (const item of list ?? []) map.set(item, (map.get(item) ?? 0) + 1); return map; };
  const b = count(before), a = count(archived), t = count(after);
  let stable = 0, stableMissing = 0, onlyInArchive = 0;
  for (const [item, times] of b) { const kept = Math.min(times, t.get(item) ?? 0); stable += kept; stableMissing += Math.max(0, kept - (a.get(item) ?? 0)); }
  for (const [item, times] of a) onlyInArchive += Math.max(0, times - Math.max(b.get(item) ?? 0, t.get(item) ?? 0));
  return { before: before?.length ?? 0, archived: archived?.length ?? 0, after: after?.length ?? 0, unchangedThroughout: stable, unchangedMissingFromArchive: stableMissing, archivedIntermediate: onlyInArchive };
}
export function compare(before, archived, after, { liveDirectory, archiveDirectory, now = Date.now(), capturedAt }) {
  const result = { sqlite: {}, qdrant: {}, redis: {}, files: {}, violations: [] };
  for (const database of new Set([...Object.keys(before.sqlite), ...Object.keys(after.sqlite)])) {
    result.sqlite[database] = {};
    for (const table of new Set([...Object.keys(before.sqlite[database] ?? {}), ...Object.keys(after.sqlite[database] ?? {})])) {
      const item = compareList(before.sqlite[database]?.[table], archived.sqlite[database]?.[table], after.sqlite[database]?.[table]);
      result.sqlite[database][table] = item;
      if (item.unchangedMissingFromArchive) result.violations.push(`${database} ${table}: ${item.unchangedMissingFromArchive} unchanged rows missing`);
    }
  }
  for (const collection of new Set([...Object.keys(before.qdrant), ...Object.keys(after.qdrant)])) {
    const item = compareList(before.qdrant[collection], archived.qdrant[collection], after.qdrant[collection]);
    result.qdrant[collection] = item;
    if (item.unchangedMissingFromArchive) result.violations.push(`Qdrant ${collection}: ${item.unchangedMissingFromArchive} unchanged points missing`);
  }
  // Redis values are compared by key; expiry is absolute, so it must not move.
  let unchanged = 0, missing = 0, expired = 0, expiryMoved = 0, changedDuring = 0, written = 0;
  for (const [key, record] of Object.entries(before.redis)) {
    const later = after.redis[key], kept = archived.redis[key];
    if (!later || later.value !== record.value) { changedDuring++; continue; }
    unchanged++;
    if (!kept) { if (record.expiresAt !== null && record.expiresAt <= now) expired++; else missing++; continue; }
    if (kept.value !== record.value) missing++;
    else if ((kept.expiresAt === null) !== (record.expiresAt === null) || (kept.expiresAt !== null && Math.abs(kept.expiresAt - record.expiresAt) > 5000)) expiryMoved++;
  }
  for (const key of Object.keys(archived.redis)) if (!before.redis[key]) written++;
  result.redis = { before: Object.keys(before.redis).length, archived: Object.keys(archived.redis).length, after: Object.keys(after.redis).length, unchangedThroughout: unchanged, unchangedMissingFromArchive: missing, expiredSinceCapture: expired, expiryMoved, changedOrRemovedDuringBackup: changedDuring, writtenDuringBackup: written };
  if (missing) result.violations.push(`Redis: ${missing} unchanged records missing or different`);
  if (expiryMoved) result.violations.push(`Redis: ${expiryMoved} records changed their absolute expiry`);
  // Files: identical when unchanged. A file that changed is an append when the archived copy
  // extends the T0 content and is itself a prefix of the file after the backup.
  let identical = 0, appended = 0, changed = 0, filesMissing = 0, filesWritten = 0;
  for (const [path, record] of Object.entries(before.files)) {
    const later = after.files[path], kept = archived.files[path];
    if (later && later.sha256 === record.sha256) {
      if (kept?.sha256 === record.sha256) identical++; else { filesMissing++; result.violations.push('File changed in the archive although unchanged throughout: ' + path); }
      continue;
    }
    if (!kept) { changed++; continue; }
    const extendsBefore = kept.size >= record.size && prefixDigest(join(archiveDirectory, path), record.size) === record.sha256;
    const prefixOfAfter = later && later.size >= kept.size && prefixDigest(join(liveDirectory, path), kept.size) === kept.sha256;
    if (extendsBefore && prefixOfAfter) appended++; else changed++;
  }
  for (const path of Object.keys(archived.files)) if (!before.files[path]) filesWritten++;
  result.files = { before: Object.keys(before.files).length, archived: Object.keys(archived.files).length, identical, appendedDuringBackup: appended, changedDuringBackup: changed, writtenDuringBackup: filesWritten, unchangedMissingFromArchive: filesMissing };
  result.capturedAt = capturedAt;
  return result;
}

// Inventories one live host before and after an online backup, and its archive.
export async function proveArchive({ suite, archive, before, scratchRoot }) {
  const scratch = mkdtempSync(join(scratchRoot, 'proof-'));
  try {
    const extracted = join(scratch, 'archive');
    mkdirSync(extracted, { mode: 0o700 });
    execFileSync('tar', ['-xzf', join(suite, 'backups', archive, 'state.tar.gz'), '-C', extracted, 'data']);
    const archived = await inventory({ suite, data: join(extracted, 'data'), scratch, live: false });
    const after = await inventory({ suite, data: join(suite, 'data'), scratch });
    const receipt = JSON.parse(readFileSync(join(suite, 'backups', archive, 'receipt.json'), 'utf8'));
    const result = compare(before, archived, after, { liveDirectory: join(suite, 'data'), archiveDirectory: join(extracted, 'data'), capturedAt: receipt.snapshot?.startedAt });
    assert.deepEqual(result.violations, [], 'Every record unchanged through the backup is in the archive');
    return result;
  } finally { rmSync(scratch, { recursive: true, force: true }); }
}
export const snapshotBefore = async ({ suite, scratchRoot }) => {
  const scratch = mkdtempSync(join(scratchRoot, 'proof-'));
  try { return await inventory({ suite, data: join(suite, 'data'), scratch }); } finally { rmSync(scratch, { recursive: true, force: true }); }
};
