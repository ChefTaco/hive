import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createServer, get } from 'node:https';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { nativeReadProof } from './restored-peer-native-proof.mjs';

const bytes = Buffer.from('synthetic retained attachment');
const policy = { headers: { Cookie: 'fixture=synthetic-session', Host: 'localhost:8443', Origin: 'https://localhost:8443' },
  fileId: 'fixture_attachment', fileSha256: createHash('sha256').update(bytes).digest('hex') };
function transport({ status = 200, content = bytes, reply = { seq_reply: 1, status: 'OK' } } = {}) {
  const calls = [];
  class WebSocket extends EventEmitter {
    constructor(url, options) { super(); calls.push({ url, options }); queueMicrotask(() => this.emit('message', JSON.stringify({ event: 'hello' }))); }
    send(text) { calls.push({ ping: JSON.parse(text) }); queueMicrotask(() => this.emit('message', JSON.stringify(reply))); }
    close() { calls.push({ closed: true }); }
    terminate() { calls.push({ terminated: true }); }
  }
  const get = (url, options, callback) => {
    calls.push({ url, options });
    queueMicrotask(() => {
      const response = new EventEmitter(); response.statusCode = status; response.resume = () => undefined;
      callback(response); response.emit('data', content); response.emit('end');
    });
    return new EventEmitter();
  };
  return { calls, ca: Buffer.from('synthetic-ca'), get, WebSocket };
}

test('native proof preserves authenticated attachment reads, digest and WSS ping with inert hostile input', async () => {
  const hostile = '\"};globalThis.hiveProofInjected=true;//</script>\u2028\u2029';
  const input = JSON.parse(JSON.stringify({ ...policy, headers: { ...policy.headers, Cookie: hostile } }));
  const deps = transport();
  await nativeReadProof(input, deps);
  assert.equal(globalThis.hiveProofInjected, undefined);
  for (const call of deps.calls.filter(call => call.options)) {
    assert.deepEqual(call.options.headers, input.headers);
    assert.equal(call.options.ca, deps.ca); assert.equal(call.options.servername, 'localhost');
  }
  assert.equal(deps.calls[0].url, 'https://ingress:8443/api/v4/files/fixture_attachment');
  assert.equal(deps.calls[1].url, 'wss://ingress:8443/api/v4/websocket');
  assert.deepEqual(deps.calls[2], { ping: { seq: 1, action: 'ping', data: {} } });
  assert.deepEqual(deps.calls[3], { closed: true });
  const source = readFileSync(new URL('./restored-peer-rehearsal.mjs', import.meta.url), 'utf8');
  assert(source.includes("readFileSync(new URL('./restored-peer-native-proof.mjs',import.meta.url),'utf8')"));
  assert(source.includes("'node','/config/peer-read-proof.mjs'"));
  const client = readFileSync(new URL('./restored-peer-native-proof.mjs', import.meta.url), 'utf8');
  assert(client.includes("readFileSync('/config/peer-read-proof.json', 'utf8')"));
  assert(!client.includes('process.argv[2]'));
  assert(!source.includes('headers=${'));
});

test('native proof refuses failed reads, digest changes and rejected socket replies', async () => {
  await assert.rejects(nativeReadProof(policy, transport({ status: 403 })), /attachment read failed/);
  await assert.rejects(nativeReadProof(policy, transport({ content: Buffer.from('changed') })), /digest differs/);
  await assert.rejects(nativeReadProof(policy, transport({ reply: { seq_reply: 1, status: 'FAIL' } })), /ping failed/);
});

test('invalid identifiers and header injection fail before a network request without disclosing input', async () => {
  for (const input of [{ ...policy, fileId: '../outside' }, { ...policy, headers: { ...policy.headers, Cookie: 'synthetic-secret\r\nx-extra: injected' } },
    { ...policy, headers: { ...policy.headers, Host: 'outside.example.com', Origin: 'https://outside.example.com' } }]) {
    const deps = transport();
    await assert.rejects(nativeReadProof(input, deps), error => error.message.startsWith('Invalid') && !error.message.includes('synthetic-secret'));
    assert.equal(deps.calls.length, 0);
  }
});

test('native client verifies real HTTPS reads, session authorization and TLS trust', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'hive-native-peer-'));
  let server;
  try {
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', join(directory, 'key'),
      '-out', join(directory, 'cert'), '-subj', '/CN=localhost', '-addext', 'subjectAltName=DNS:localhost', '-days', '1'], { stdio: 'ignore' });
    const ca = readFileSync(join(directory, 'cert'));
    let reads = 0;
    server = createServer({ key: readFileSync(join(directory, 'key')), cert: ca }, (request, response) => {
      if (request.url !== '/api/v4/files/' + policy.fileId || request.headers.cookie !== policy.headers.Cookie
        || request.headers.origin !== policy.headers.Origin || request.headers.host !== policy.headers.Host) {
        response.writeHead(403); response.end(); return;
      }
      reads++; response.end(bytes);
    });
    await new Promise(done => server.listen(0, '127.0.0.1', done));
    const port = server.address().port;
    const local = url => { const result = new URL(url); result.hostname = '127.0.0.1'; result.port = String(port); return result; };
    const deps = { ca, get: (url, options, callback) => get(local(url), options, callback),
      WebSocket: transport().WebSocket };
    await nativeReadProof(JSON.parse(JSON.stringify(policy)), deps);
    assert.equal(reads, 1);
    await assert.rejects(nativeReadProof({ ...policy, headers: { ...policy.headers, Cookie: 'fixture=wrong-session' } }, deps), /attachment read failed/);
    await assert.rejects(nativeReadProof(policy, { ...deps, ca: undefined }), /self-signed certificate/);
  } finally {
    if (server) { server.closeAllConnections(); await new Promise(done => server.close(done)); }
    rmSync(directory, { recursive: true, force: true });
  }
});
