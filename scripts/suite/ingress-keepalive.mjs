#!/usr/bin/env node
// Regression test: the ingress must never send a request on an upstream connection that the
// backend may be closing. Node servers close an idle keep-alive connection after
// server.keepAliveTimeout (5 seconds by default, which every suite product uses). A proxy that
// keeps idle connections longer can reuse one at the instant the backend closes it. Its
// transport then retries an idempotent GET on a new connection, but a POST fails, and the
// ingress answers 503.
//
// The backend here makes that race deterministic: a connection idle for at least the backend's
// keep-alive timeout is closed as soon as the next request arrives on it, exactly as if the
// backend's own close had crossed the request. Each upstream transport the ingress uses (the
// verified HTTPS snippet and the plain HTTP snippet from deployment/Caddyfile) must open a new
// connection instead, so a POST sent after that idle time is answered.
//
//   node scripts/suite/ingress-keepalive.mjs [--caddyfile FILE]
//
// --caddyfile tests another Caddyfile, such as an earlier revision, to show the failure.
// HIVE_INGRESS_TEST_IMAGE selects the ingress image (default: the one the latest release pins).
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { parseArgs } from 'node:util';

const { values: args } = parseArgs({ options: { caddyfile: { type: 'string' } } });
const root = new URL('../..', import.meta.url).pathname;
const latest = readdirSync(join(root, 'releases')).filter((name) => /^\d+\.\d+\.\d+\.json$/.test(name))
  .sort((a, b) => a.localeCompare(b, undefined, { numeric: true })).pop();
const ingressImage = process.env.HIVE_INGRESS_TEST_IMAGE || JSON.parse(readFileSync(join(root, 'releases', latest), 'utf8')).components.ingress.image;
const nodeImage = 'node:24.22.1-slim@sha256:55fb5f5a527ea2c5c4a95f963e48ef90aa38c7b346054fdc8ee9957a2b55d205';
// The backend's keep-alive timeout: Node's default, which the suite products keep.
const BACKEND_KEEPALIVE_MS = 5000;
const caddyfile = readFileSync(args.caddyfile ?? join(root, 'deployment/Caddyfile'), 'utf8');
const temporary = mkdtempSync(join(tmpdir(), 'hive-ingress-keepalive-'));
const id = randomBytes(5).toString('hex'), network = 'hive-keepalive-' + id;
const names = { backend: 'hive-keepalive-backend-' + id, ingress: 'hive-keepalive-ingress-' + id };
const docker = (...argv) => execFileSync('docker', argv, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const delay = (ms) => new Promise((done) => setTimeout(done, ms));
// The containers run as the invoking user, so everything they write can be removed afterwards.
const user = `${process.getuid()}:${process.getgid()}`;

// A top-level snippet, verbatim, or null when this Caddyfile has none.
function snippet(name) {
  const start = caddyfile.indexOf('\n(' + name + ') {\n');
  if (start < 0) return null;
  const end = caddyfile.indexOf('\n}\n', start + 1);
  assert(end > start, 'Unterminated snippet ' + name);
  return caddyfile.slice(start + 1, end + 3);
}

function post(port, path, body) {
  return new Promise((done) => {
    const payload = Buffer.from(JSON.stringify(body));
    const req = request({ host: '127.0.0.1', port, path, method: 'POST', headers: { 'content-type': 'application/json', 'content-length': payload.length } }, (res) => {
      const chunks = []; res.on('data', (chunk) => chunks.push(chunk)); res.on('end', () => done({ status: res.statusCode, body: Buffer.concat(chunks).toString().slice(0, 120) }));
    });
    req.on('error', (error) => done({ status: 0, body: error.message }));
    req.end(payload);
  });
}
function get(port, path) {
  return new Promise((done) => {
    const req = request({ host: '127.0.0.1', port, path }, (res) => { res.resume(); res.on('end', () => done({ status: res.statusCode })); });
    req.on('error', (error) => done({ status: 0, body: error.message }));
    req.end();
  });
}

let result = 'failed';
const report = { ingressImage, caddyfile: args.caddyfile ?? 'deployment/Caddyfile', backendKeepAliveMs: BACKEND_KEEPALIVE_MS, upstreams: {} };
try {
  const verified = snippet('verified_backend');
  assert(verified, 'deployment/Caddyfile defines no verified_backend snippet');
  // An earlier Caddyfile had no snippet for plain HTTP upstreams: they used the default transport.
  const plain = snippet('plain_backend') ?? '(plain_backend) {\n}\n';
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', join(temporary, 'backend.key'), '-out', join(temporary, 'backend.crt'),
    '-subj', '/CN=backend', '-addext', 'subjectAltName=DNS:backend', '-days', '1'], { stdio: 'ignore' });
  writeFileSync(join(temporary, 'backend-ca.pem'), readFileSync(join(temporary, 'backend.crt')));
  writeFileSync(join(temporary, 'Caddyfile'), `{\n\tadmin off\n\tauto_https off\n}\n\n${verified}\n${plain}\n:8080 {\n\thandle /tls/* {\n\t\treverse_proxy https://backend:9443 {\n\t\t\timport verified_backend backend\n\t\t}\n\t}\n\thandle /plain/* {\n\t\treverse_proxy http://backend:9080 {\n\t\t\timport plain_backend\n\t\t}\n\t}\n\thandle_errors {\n\t\trespond "Service unavailable" 503\n\t}\n}\n`);
  writeFileSync(join(temporary, 'backend.cjs'), `
const http = require('http'), https = require('https'), fs = require('fs');
const IDLE = ${BACKEND_KEEPALIVE_MS};
let connections = 0;
function handler(req, res) {
  const chunks = []; req.on('data', (c) => chunks.push(c));
  req.on('end', () => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ method: req.method, url: req.url, connection: req.socket.hiveConnection })); });
}
// Node itself would close the idle connection at IDLE; here that close always meets the next
// request, which makes the proxy's race deterministic.
function track(server, event) {
  server.keepAliveTimeout = 600000;
  server.on(event, (socket) => {
    socket.hiveConnection = ++connections;
    socket.prependListener('data', () => { if (socket.idleSince && Date.now() - socket.idleSince >= IDLE) socket.destroy(); socket.idleSince = 0; });
  });
  server.on('request', (req, res) => res.on('finish', () => { req.socket.idleSince = Date.now(); }));
}
const secure = https.createServer({ key: fs.readFileSync('/config/backend.key'), cert: fs.readFileSync('/config/backend.crt') }, handler);
const plain = http.createServer(handler);
track(secure, 'secureConnection'); track(plain, 'connection');
secure.listen(9443, '0.0.0.0'); plain.listen(9080, '0.0.0.0');
`);
  // Disposable fixtures only; the containers run without DAC override and must read them.
  chmodSync(temporary, 0o755);
  for (const file of readdirSync(temporary)) chmodSync(join(temporary, file), 0o644);
  docker('network', 'create', network);
  docker('run', '-d', '--name', names.backend, '--network', network, '--network-alias', 'backend', '--user', user, '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
    '-v', temporary + ':/config:ro', nodeImage, 'node', '/config/backend.cjs');
  const state = join(temporary, 'state'); mkdirSync(state, { mode: 0o700 });
  docker('run', '-d', '--name', names.ingress, '--network', network, '--user', user, '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
    '-v', temporary + ':/config:ro', '-v', state + ':/data', '-p', '127.0.0.1::8080', ingressImage, 'caddy', 'run', '--config', '/config/Caddyfile', '--adapter', 'caddyfile');
  let port;
  for (let attempt = 0; attempt < 100 && !port; attempt++) {
    const inspect = JSON.parse(docker('inspect', names.ingress))[0];
    assert.notEqual(inspect.State.Status, 'exited', 'The ingress exited: ' + spawnSync('docker', ['logs', names.ingress], { encoding: 'utf8' }).stderr.slice(-1500));
    port = inspect.NetworkSettings.Ports['8080/tcp']?.[0]?.HostPort; if (!port) await delay(100);
  }
  let ready;
  for (let attempt = 0; attempt < 100; attempt++) { ready = await get(port, '/tls/ready'); if (ready.status === 200) break; await delay(200); }
  assert.equal(ready.status, 200, 'The backend answers through the ingress');

  for (const upstream of ['tls', 'plain']) {
    const first = await post(port, `/${upstream}/first`, { n: 1 });
    assert.equal(first.status, 200, upstream + ': the first POST is answered');
    // Idle exactly past the backend's keep-alive timeout.
    await delay(BACKEND_KEEPALIVE_MS + 500);
    const second = await post(port, `/${upstream}/second`, { n: 2 });
    await get(port, `/${upstream}/warm`);
    await delay(BACKEND_KEEPALIVE_MS + 500);
    const idempotent = await get(port, `/${upstream}/after-idle`);
    report.upstreams[upstream] = { postAfterIdle: second.status, postBody: second.status === 200 ? undefined : second.body, getAfterIdle: idempotent.status };
  }
  console.log(JSON.stringify(report, null, 1));
  for (const [upstream, value] of Object.entries(report.upstreams)) {
    assert.equal(value.postAfterIdle, 200, `${upstream}: a POST after ${BACKEND_KEEPALIVE_MS} ms idle reached a connection the backend was closing (status ${value.postAfterIdle})`);
    assert.equal(value.getAfterIdle, 200, `${upstream}: a GET after idle is answered`);
  }
  result = 'passed';
  console.log('PASS: every upstream transport opens a new connection before a backend keep-alive timeout can close it.');
} finally {
  if (result !== 'passed') for (const name of Object.values(names)) { const logs = spawnSync('docker', ['logs', '--tail', '40', name], { encoding: 'utf8' }); if (logs.status === 0) console.error(name + ':\n' + (logs.stdout + logs.stderr).slice(-3000)); }
  for (const name of Object.values(names)) spawnSync('docker', ['rm', '-f', name], { stdio: 'ignore' });
  spawnSync('docker', ['network', 'rm', network], { stdio: 'ignore' });
  rmSync(temporary, { recursive: true, force: true });
  if (result !== 'passed') process.exitCode = 1;
}
