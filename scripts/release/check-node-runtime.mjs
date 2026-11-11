#!/usr/bin/env node
// Run real TLS, HTTP/2 and embedded-database checks in a disposable runtime.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { parseArgs } from 'node:util';

const { values } = parseArgs({ options: {
  image: { type: 'string' },
  platform: { type: 'string', default: 'linux/amd64' },
} });
assert(values.image, '--image is required');
const proof = String.raw`
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { readFileSync } = require('node:fs');
const http2 = require('node:http2');
const { DatabaseSync } = require('node:sqlite');
const { once } = require('node:events');
(async () => {
  assert.equal(process.version, 'v26.13.1');
  assert.equal(process.getuid(), 1000);
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1',
    '-subj', '/CN=localhost', '-addext', 'subjectAltName=DNS:localhost',
    '-keyout', '/tmp/key.pem', '-out', '/tmp/cert.pem'], { stdio: 'ignore' });
  const cert = readFileSync('/tmp/cert.pem');
  const server = http2.createSecureServer({ key: readFileSync('/tmp/key.pem'), cert });
  server.on('stream', (stream) => {
    const chunks = [];
    stream.on('data', (chunk) => chunks.push(chunk));
    stream.on('end', () => { stream.respond({ ':status': 200 }); stream.end(Buffer.concat(chunks)); });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const client = http2.connect('https://127.0.0.1:' + server.address().port,
    { ca: cert, servername: 'localhost' });
  try {
    await once(client, 'connect');
    assert.equal(client.socket.alpnProtocol, 'h2');
    assert.equal(client.socket.authorized, true);
    await Promise.all(Array.from({ length: 16 }, (_, index) => new Promise((resolve, reject) => {
      const payload = Buffer.alloc(65537 + index, index);
      const stream = client.request({ ':method': 'POST', ':path': '/fixture/' + index });
      const chunks = [];
      stream.on('error', reject);
      stream.on('data', (chunk) => chunks.push(chunk));
      stream.on('end', () => { try { assert.deepEqual(Buffer.concat(chunks), payload); resolve(); } catch (error) { reject(error); } });
      stream.end(payload);
    })));
  } finally {
    client.close();
    await once(client, 'close');
    await new Promise((resolve) => server.close(resolve));
  }
  const db = new DatabaseSync('/tmp/fixture.sqlite');
  db.exec('CREATE TABLE proof (value TEXT); INSERT INTO proof VALUES (\'synthetic\')');
  assert.equal(db.prepare('SELECT value FROM proof').get().value, 'synthetic');
  const sqlite = db.prepare('SELECT sqlite_version() AS version').get().version;
  assert(Number(sqlite.split('.')[1]) >= 54);
  db.close();
  execFileSync('sh', ['-c', 'flock --exclusive --nonblock /tmp/writer.lock true']);
  assert.throws(() => execFileSync('sh', ['-c', 'command -v npm'], { stdio: 'ignore' }));
  console.log(JSON.stringify({ node: process.version, sqlite, openssl: process.versions.openssl,
    arch: process.arch, streams: 16, tls: 'verified', uid: process.getuid() }));
})().catch((error) => { console.error(error); process.exitCode = 1; });
`;
const output = execFileSync('docker', ['run', '--rm', '--platform', values.platform,
  '--read-only', '--tmpfs', '/tmp:uid=1000,gid=1000,mode=700', '--user', '1000:1000',
  '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges:true',
  '--entrypoint', 'node', values.image, '-e', proof], { encoding: 'utf8', timeout: 120000 });
console.log(output.trim());
