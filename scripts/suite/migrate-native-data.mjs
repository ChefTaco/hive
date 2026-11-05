// Data helpers for hive.sh migrate-native. The interpreter runs on the host in a restricted,
// pinned container, so the controller and the host need no Node runtime. Prints JSON summaries
// only: no secret, row content or password hash is ever written to standard output.
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { createConnection } from 'node:net';
import { readFileSync, writeFileSync } from 'node:fs';

const sha = (value) => createHash('sha256').update(value).digest('hex');
const quote = (name) => '"' + name.replaceAll('"', '""') + '"';
const canonical = (value) =>
  Array.isArray(value) ? value.map(canonical)
    : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]))
      : value;
const rowText = (row) => JSON.stringify(row, (_, value) => (typeof value === 'bigint' ? value.toString() : ArrayBuffer.isView(value) ? Buffer.from(value.buffer, value.byteOffset, value.byteLength).toString('base64') : value));
// Rebuilt by the product on every start. It is never data a person or client wrote.
const regenerated = (table, row) => table === 'RuntimeSetting' && row.key === 'openapi.document';

export function databaseState(file, columnsByTable) {
  const database = new DatabaseSync(file, { readOnly: true });
  try {
    const integrity = database.prepare('PRAGMA integrity_check').all().map((row) => Object.values(row)[0]);
    if (integrity.join() !== 'ok') throw Error('SQLite integrity check failed: ' + file);
    if (database.prepare('PRAGMA foreign_key_check').all().length) throw Error('SQLite foreign key check failed: ' + file);
    const names = database.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map((row) => row.name);
    const tables = {};
    for (const name of names) {
      const columns = columnsByTable?.[name] ?? database.prepare('PRAGMA table_info(' + quote(name) + ')').all().map((row) => row.name);
      const rows = database.prepare('SELECT ' + columns.map(quote).join(',') + ' FROM ' + quote(name)).all();
      const hashes = rows.filter((row) => !regenerated(name, row)).map((row) => sha(rowText(row)).slice(0, 40)).sort();
      tables[name] = { columns, count: hashes.length, digest: sha(hashes.join('\n')), hashes };
    }
    return { tables };
  } finally { database.close(); }
}

export function compareDatabases(before, after, allowedToChange = []) {
  const changed = {}, violations = [];
  for (const [name, state] of Object.entries(before.tables)) {
    const current = after.tables[name];
    if (!current) { violations.push(name + ': table is gone'); continue; }
    const available = new Map();
    for (const hash of current.hashes) available.set(hash, (available.get(hash) ?? 0) + 1);
    let missing = 0;
    for (const hash of state.hashes) {
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
  const database = new DatabaseSync(file, { readOnly: true });
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
  let buffer = Buffer.alloc(0), waiting = [];
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
    waiting.push({ resolve, reject });
    const values = parts.map((part) => (Buffer.isBuffer(part) ? part : Buffer.from(String(part))));
    socket.write(Buffer.concat([Buffer.from('*' + values.length + '\r\n'), ...values.flatMap((value) => [Buffer.from('$' + value.length + '\r\n'), value, Buffer.from('\r\n')])]));
  });
  socket.on('error', (error) => { for (const { reject } of waiting.splice(0)) reject(error); });
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

async function redisImport(url, input) {
  const client = redisClient(url);
  if (client.password) await client.command('AUTH', client.password);
  const { records } = JSON.parse(readFileSync(input, 'utf8'));
  let restored = 0, expired = 0;
  // Absolute expiry is kept: a restore can never extend the life of a record.
  for (const record of records) {
    if (record.expiresAt !== null && record.expiresAt <= Date.now()) { expired++; continue; }
    await client.command('RESTORE', Buffer.from(record.key, 'base64'), record.expiresAt ?? 0, Buffer.from(record.dump, 'base64'), 'REPLACE', ...(record.expiresAt ? ['ABSTTL'] : []));
    restored++;
  }
  client.close();
  return { restored, expired };
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
      return compareDatabases(before, databaseState(request.file, columns), request.allowedToChange ?? []);
    }
    case 'accounts': return { accounts: accounts(request.file) };
    case 'qdrant-inventory': {
      const inventory = await qdrantInventory(request.url);
      if (request.output) writeFileSync(request.output, JSON.stringify(inventory), { mode: 0o600 });
      return { totalCollections: inventory.totalCollections, totalPoints: inventory.totalPoints, digest: sha(JSON.stringify(canonical(inventory.collections))) };
    }
    case 'redis-export': return redisExport(request.url, request.prefix, request.output);
    case 'redis-import': return redisImport(request.url, request.input);
    default: throw Error('Unknown data command');
  }
}

if (process.argv[1]) {
  main(JSON.parse(process.argv[1])).then(
    (result) => { console.log(JSON.stringify(result)); process.exit(0); },
    (error) => { console.error('migrate-native data: ' + error.message); process.exit(1); },
  );
}
