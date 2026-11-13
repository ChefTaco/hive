// Data helpers for hive.sh migrate-native. The interpreter runs on the host in a restricted,
// pinned container, so the controller and the host need no Node runtime. Prints JSON summaries
// only: no secret, row content or password hash is ever written to standard output.
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { createConnection } from 'node:net';
import { readFileSync, writeFileSync } from 'node:fs';

// A live product may hold a write lock for a moment: readers wait for it rather than fail.
const sha = (value) => createHash('sha256').update(value).digest('hex');
const quote = (name) => '"' + name.replaceAll('"', '""') + '"';
const canonical = (value) =>
  Array.isArray(value) ? value.map(canonical)
    : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]))
      : value;
const rowText = (row) => JSON.stringify(row, (_, value) => (typeof value === 'bigint' ? value.toString() : ArrayBuffer.isView(value) ? Buffer.from(value.buffer, value.byteOffset, value.byteLength).toString('base64') : value));
// Rebuilt by the product on every start. It is never data a person or client wrote.
const regenerated = (table, row) => table === 'RuntimeSetting' && row.key === 'openapi.document';

// The only columns a live client may change in a preserved credential row: using an Emberpath API
// key stamps it. Everything else in these rows (hash, prefix, scopes, enabled, expiry) must stay
// exactly as captured. Keep this list minimal and explicit: each entry weakens a live check.
export const LIVE_COLUMNS = Object.freeze({ ClientApiKey: Object.freeze(['lastUsedAt', 'updatedAt']) });

// Credential and registration tables that machine clients only read. While they use the suite,
// these may gain rows but no existing row may change, except in LIVE_COLUMNS. Password hashes
// are checked separately, by the accounts command, because a sign-in stamps the users row.
export const CREDENTIAL_TABLES = Object.freeze({
  oathweave: Object.freeze(['clients', 'roles', 'user_role_assignments']),
  emberpath: Object.freeze(['ClientApiKey']),
  hiveskills: Object.freeze([]),
});

const rowHashes = (table, rows, columns) => rows.filter((row) => !regenerated(table, row))
  .map((row) => sha(rowText(Object.fromEntries(columns.map((column) => [column, row[column]])))).slice(0, 40)).sort();

export function databaseState(file, columnsByTable, stableColumnsByTable) {
  const database = new DatabaseSync(file, { readOnly: true, timeout: 30000 });
  try {
    const integrity = database.prepare('PRAGMA integrity_check').all().map((row) => Object.values(row)[0]);
    if (integrity.join() !== 'ok') throw Error('SQLite integrity check failed: ' + file);
    if (database.prepare('PRAGMA foreign_key_check').all().length) throw Error('SQLite foreign key check failed: ' + file);
    const names = database.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map((row) => row.name);
    const tables = {};
    for (const name of names) {
      const columns = columnsByTable?.[name] ?? database.prepare('PRAGMA table_info(' + quote(name) + ')').all().map((row) => row.name);
      const rows = database.prepare('SELECT ' + columns.map(quote).join(',') + ' FROM ' + quote(name)).all();
      const hashes = rowHashes(name, rows, columns);
      tables[name] = { columns, count: hashes.length, digest: sha(hashes.join('\n')), hashes };
      // Hashes without the live columns, so a live comparison can ignore exactly those.
      const stable = stableColumnsByTable ? stableColumnsByTable[name] : LIVE_COLUMNS[name] && columns.filter((column) => !LIVE_COLUMNS[name].includes(column));
      if (stable && stable.length < columns.length) Object.assign(tables[name], { stableColumns: stable, stableHashes: rowHashes(name, rows, stable) });
    }
    return { tables };
  } finally { database.close(); }
}

// allowedToChange names tables whose existing rows may change. With tables, only those tables
// are compared. With live, a table listed in LIVE_COLUMNS is compared without those columns.
export function compareDatabases(before, after, allowedToChange = [], { tables, live = false } = {}) {
  const changed = {}, violations = [];
  for (const [name, state] of Object.entries(before.tables)) {
    if (tables && !tables.includes(name)) continue;
    const current = after.tables[name];
    if (!current) { violations.push(name + ': table is gone'); continue; }
    const useStable = live && (LIVE_COLUMNS[name] ?? []).some((column) => state.columns.includes(column));
    if (useStable && !(state.stableHashes && current.stableHashes)) { violations.push(name + ': the capture has no live-tolerant hashes'); continue; }
    const beforeHashes = useStable ? state.stableHashes : state.hashes, afterHashes = useStable ? current.stableHashes : current.hashes;
    const available = new Map();
    for (const hash of afterHashes) available.set(hash, (available.get(hash) ?? 0) + 1);
    let missing = 0;
    for (const hash of beforeHashes) {
      if ((available.get(hash) ?? 0) > 0) available.set(hash, available.get(hash) - 1);
      else missing++;
    }
    const added = current.count - (state.count - missing);
    if (missing || added) {
      changed[name] = { before: state.count, after: current.count, removedOrChanged: missing, addedOrChanged: added };
      if (missing && !allowedToChange.includes(name)) violations.push(name + ': ' + missing + ' existing rows changed or removed');
    }
  }
  return { changed, violations };
}

function accounts(file) {
  const database = new DatabaseSync(file, { readOnly: true, timeout: 30000 });
  try {
    return database.prepare('SELECT id, username, passwordHash FROM users ORDER BY id').all()
      .map((row) => ({ id: row.id, username: row.username, passwordHashSHA256: sha(row.passwordHash ?? '') }));
  } finally { database.close(); }
}

async function qdrantInventory(url) {
  const headers = { 'Content-Type': 'application/json', ...(process.env.MIGRATE_API_KEY ? { 'api-key': process.env.MIGRATE_API_KEY } : {}) };
  const json = async (path, init) => {
    const response = await fetch(url + path, { headers, ...init });
    if (!response.ok) throw Error('Qdrant request failed: ' + response.status);
    return (await response.json()).result;
  };
  const collections = {};
  for (const { name } of (await json('/collections')).collections) {
    const hashes = [];
    let offset;
    do {
      const page = await json('/collections/' + encodeURIComponent(name) + '/points/scroll', { method: 'POST', body: JSON.stringify({ limit: 256, with_vector: true, with_payload: true, ...(offset !== undefined && offset !== null ? { offset } : {}) }) });
      for (const point of page.points) hashes.push(sha(JSON.stringify(canonical(point))));
      offset = page.next_page_offset;
    } while (offset !== undefined && offset !== null);
    collections[name] = { points: hashes.length, contentSHA256: sha(hashes.sort().join('\n')) };
  }
  return { collections, totalCollections: Object.keys(collections).length, totalPoints: Object.values(collections).reduce((sum, item) => sum + item.points, 0) };
}

function redisClient(url) {
  // Credentials arrive through the environment, never in the request on the command line.
  const parsed = new URL(url ?? process.env.MIGRATE_REDIS_URL);
  const socket = createConnection(Number(parsed.port || 6379), parsed.hostname);
  let buffer = Buffer.alloc(0), waiting = [], closed = null;
  const parse = (offset) => {
    const end = buffer.indexOf('\r\n', offset);
    if (end < 0) return null;
    const kind = String.fromCharCode(buffer[offset]), text = buffer.subarray(offset + 1, end).toString(), next = end + 2;
    if (kind === '+') return { value: text, next };
    if (kind === '-') return { error: text, next };
    if (kind === ':') return { value: Number(text), next };
    if (kind === '$') {
      const size = Number(text);
      if (size < 0) return { value: null, next };
      return buffer.length < next + size + 2 ? null : { value: buffer.subarray(next, next + size), next: next + size + 2 };
    }
    if (kind === '*') {
      const items = []; let cursor = next;
      for (let index = 0; index < Number(text); index++) {
        const item = parse(cursor);
        if (!item) return null;
        items.push(item.value); cursor = item.next;
      }
      return { value: items, next: cursor };
    }
    throw Error('Invalid Redis reply');
  };
  socket.on('data', (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    for (;;) {
      if (!waiting.length || !buffer.length) return;
      const reply = parse(0);
      if (!reply) return;
      buffer = buffer.subarray(reply.next);
      const { resolve, reject } = waiting.shift();
      if (reply.error) reject(Error('Redis command rejected')); else resolve(reply.value);
    }
  });
  const command = (...parts) => new Promise((resolve, reject) => {
    if (closed) { reject(closed); return; }
    waiting.push({ resolve, reject });
    const values = parts.map((part) => (Buffer.isBuffer(part) ? part : Buffer.from(String(part))));
    socket.write(Buffer.concat([Buffer.from('*' + values.length + '\r\n'), ...values.flatMap((value) => [Buffer.from('$' + value.length + '\r\n'), value, Buffer.from('\r\n')])]));
  });
  // A connection that ends, with or without an error, answers nothing more: every command still
  // waiting fails, and so does any later one. Otherwise the process would end with status 0 and
  // no result as soon as nothing else kept it running.
  const fail = (error) => { closed ??= error; for (const { reject } of waiting.splice(0)) reject(closed); };
  socket.on('error', fail);
  socket.on('close', () => fail(Error('Redis closed the connection')));
  return { command, close: () => socket.end(), password: process.env.MIGRATE_REDIS_PASSWORD ?? decodeURIComponent(parsed.password) };
}

async function redisExport(url, prefix, output) {
  if (!/^[A-Za-z0-9:_-]+$/.test(prefix)) throw Error('Unsafe Redis namespace');
  const client = redisClient(url);
  if (client.password) await client.command('AUTH', client.password);
  const records = [];
  let cursor = '0';
  do {
    const [next, keys] = await client.command('SCAN', cursor, 'MATCH', prefix + '*', 'COUNT', 500);
    cursor = next.toString();
    for (const key of keys) {
      const dump = await client.command('DUMP', key), ttl = await client.command('PTTL', key);
      if (dump !== null) records.push({ key: key.toString('base64'), dump: dump.toString('base64'), expiresAt: ttl > 0 ? Date.now() + ttl : null });
    }
  } while (cursor !== '0');
  client.close();
  writeFileSync(output, JSON.stringify({ prefix, records }), { mode: 0o600 });
  return { keys: records.length };
}

// A record's value, independent of how Redis encodes it: DUMP bytes change when a store is
// reloaded, so values are read by type. Members of hashes and sets are sorted.
const redisText = (value) => (Buffer.isBuffer(value) ? value.toString('base64') : Array.isArray(value) ? value.map(redisText) : value);
export function canonicalRedisValue(type, reply) {
  const value = redisText(reply);
  if (type === 'hash') {
    const pairs = [];
    for (let index = 0; index < value.length; index += 2) pairs.push([value[index], value[index + 1]]);
    return JSON.stringify([type, pairs.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))]);
  }
  if (type === 'set') return JSON.stringify([type, [...value].sort()]);
  return JSON.stringify([type, value]);
}
const redisRead = { string: ['GET'], hash: ['HGETALL'], set: ['SMEMBERS'], zset: ['ZRANGE', 0, -1, 'WITHSCORES'], list: ['LRANGE', 0, -1], stream: ['XRANGE', '-', '+'] };
async function redisValue(client, key) {
  const type = String(await client.command('TYPE', key));
  const read = redisRead[type];
  if (!read) throw Error('Unsupported Redis record type: ' + type);
  return sha(canonicalRedisValue(type, await client.command(read[0], key, ...read.slice(1))));
}

// Each record under the namespace, by digest only: key, value and absolute expiry.
async function redisInventory(client, prefix) {
  if (!/^[A-Za-z0-9:_-]+$/.test(prefix)) throw Error('Unsafe Redis namespace');
  const records = {};
  let cursor = '0';
  do {
    const [next, keys] = await client.command('SCAN', cursor, 'MATCH', prefix + '*', 'COUNT', 500);
    cursor = next.toString();
    for (const key of keys) {
      const ttl = await client.command('PTTL', key);
      if (ttl === -2) continue;
      records[sha(key)] = { value: await redisValue(client, key), expiresAt: ttl > 0 ? Date.now() + ttl : null };
    }
  } while (cursor !== '0');
  return records;
}

// Every record of the inventory taken at restore is still present with the same value, unless
// its own expiry has passed since. No record was added or changed.
export function compareRedis(before, current, now = Date.now()) {
  let expired = 0, missing = 0, changed = 0, unexpected = 0;
  for (const [key, record] of Object.entries(before)) {
    const present = current[key];
    if (!present) { if (record.expiresAt !== null && record.expiresAt <= now + 2000) expired++; else missing++; continue; }
    if (present.value !== record.value) changed++;
  }
  for (const key of Object.keys(current)) if (!before[key]) unexpected++;
  return { recorded: Object.keys(before).length, present: Object.keys(current).length, expiredSinceCapture: expired, missing, changed, unexpected, unchanged: missing === 0 && changed === 0 && unexpected === 0 };
}

async function redisImport(url, input, inventory) {
  const client = redisClient(url);
  if (client.password) await client.command('AUTH', client.password);
  const { prefix, records } = JSON.parse(readFileSync(input, 'utf8'));
  let restored = 0, expired = 0;
  // Absolute expiry is kept: a restore can never extend the life of a record.
  for (const record of records) {
    if (record.expiresAt !== null && record.expiresAt <= Date.now()) { expired++; continue; }
    await client.command('RESTORE', Buffer.from(record.key, 'base64'), record.expiresAt ?? 0, Buffer.from(record.dump, 'base64'), 'REPLACE', ...(record.expiresAt ? ['ABSTTL'] : []));
    restored++;
  }
  if (inventory) {
    const recorded = await redisInventory(client, prefix);
    writeFileSync(inventory, JSON.stringify({ prefix, records: recorded }), { mode: 0o600 });
    if (Object.keys(recorded).length > restored) { client.close(); throw Error('Redis holds records that were not restored'); }
  }
  client.close();
  return { restored, expired };
}

async function redisCompare(url, input) {
  const before = JSON.parse(readFileSync(input, 'utf8'));
  const client = redisClient(url);
  if (client.password) await client.command('AUTH', client.password);
  const current = await redisInventory(client, before.prefix);
  client.close();
  return compareRedis(before.records, current);
}

async function main(request) {
  switch (request.command) {
    case 'sqlite-state': {
      const state = databaseState(request.file);
      writeFileSync(request.output, JSON.stringify(state), { mode: 0o600 });
      return { tables: Object.keys(state.tables).length, rows: Object.values(state.tables).reduce((sum, table) => sum + table.count, 0) };
    }
    case 'sqlite-compare': {
      const before = JSON.parse(readFileSync(request.before, 'utf8'));
      const columns = Object.fromEntries(Object.entries(before.tables).map(([name, table]) => [name, table.columns]));
      const stable = Object.fromEntries(Object.entries(before.tables).filter(([, table]) => table.stableColumns).map(([name, table]) => [name, table.stableColumns]));
      // credentials: only the credential tables of this component, tolerating LIVE_COLUMNS.
      const tables = request.credentials === true ? CREDENTIAL_TABLES[request.component] ?? [] : request.tables;
      return compareDatabases(before, databaseState(request.file, columns, stable), request.allowedToChange ?? [], { tables, live: request.credentials === true });
    }
    case 'accounts': return { accounts: accounts(request.file) };
    case 'qdrant-inventory': {
      const inventory = await qdrantInventory(request.url);
      if (request.output) writeFileSync(request.output, JSON.stringify(inventory), { mode: 0o600 });
      return { totalCollections: inventory.totalCollections, totalPoints: inventory.totalPoints, digest: sha(JSON.stringify(canonical(inventory.collections))) };
    }
    case 'redis-export': return redisExport(request.url, request.prefix, request.output);
    case 'redis-import': return redisImport(request.url, request.input, request.inventory);
    case 'redis-compare': return redisCompare(request.url, request.input);
    default: throw Error('Unknown data command');
  }
}

// Run with a JSON request as the only argument; imported, it only exports its helpers.
if (process.argv[1]?.startsWith('{')) {
  main(JSON.parse(process.argv[1])).then(
    (result) => { console.log(JSON.stringify(result)); process.exit(0); },
    (error) => { console.error('migrate-native data: ' + error.message); process.exit(1); },
  );
}
