#!/usr/bin/env node
// Live client traffic for scripts/suite/native-migration-rehearsal.mjs. It plays the clients a
// busy native installation keeps serving during a cutover: an Emberpath API key on the model
// port, memory writes and reads on the console and memory ports, and client_credentials token
// requests on the identity port. Every request is logged with its time and status.
// Usage: native-migration-traffic.mjs PRIVATE_JSON
// The configuration file is owner-only and holds the credentials, which reach curl only
// through owner-only header and body files, never a command line.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { appendFileSync, existsSync, lstatSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const file = process.argv[2];
assert(file, 'Usage: native-migration-traffic.mjs PRIVATE_JSON');
const stat = lstatSync(file);
assert(stat.isFile() && stat.uid === process.getuid() && (stat.mode & 0o077) === 0, 'The traffic configuration must be owner-only');
const c = JSON.parse(readFileSync(file, 'utf8'));
const work = c.work;
const secretFile = (name, content) => { const path = join(work, name); writeFileSync(path, content, { mode: 0o600 }); return path; };
const headers = {
  apiKey: secretFile('api-key.header', 'Authorization: Bearer ' + c.apiKey + '\n'),
  memory: secretFile('memory.header', 'Authorization: Bearer ' + c.memoryToken + '\n'),
};
const tokenBody = secretFile('token.body', JSON.stringify({ grant_type: 'client_credentials', client_id: c.clientId, client_secret: c.clientSecret }));
let sequence = 0, stopping = false, inflight = 0;

function request(kind, name, port, path, extra) {
  return new Promise((done) => {
    inflight++;
    const started = Date.now();
    execFile('curl', ['-sS', '-o', '/dev/null', '-w', '%{http_code}', '--max-time', '10', '--resolve', `${name}:${port}:${c.address}`, '--cacert', c.trust, ...extra, `https://${name}:${port}${path}`], { encoding: 'utf8' }, (error, stdout) => {
      inflight--;
      const status = (stdout || '').trim() || '000';
      appendFileSync(c.log, JSON.stringify({ at: new Date(started).toISOString(), ms: Date.now() - started, kind, port, status, ok: /^2/.test(status) && !error }) + '\n', { mode: 0o600 });
      done();
    });
  });
}

function round() {
  const n = sequence++;
  const body = secretFile('memory-' + (n % 8) + '.body', JSON.stringify({ content: `Live rehearsal traffic memory ${n} written during the cutover window.`, type: 'semantic', scope: 'shared', source: 'observation', tags: ['cutover-traffic'] }));
  const search = secretFile('search.body', JSON.stringify({ query: 'cutover traffic', limit: 3 }));
  return Promise.all([
    request('api-key', c.fqdn, 4020, '/v1/models', ['-H', '@' + headers.apiKey]),
    request('memory-write', c.fqdn, 443, '/v1/memories', ['-H', '@' + headers.memory, '-H', 'Content-Type: application/json', '--data-binary', '@' + body]),
    request('memory-read', c.memoryName, c.memoryPort, '/v1/memories/search', ['-H', '@' + headers.memory, '-H', 'Content-Type: application/json', '--data-binary', '@' + search]),
    request('memory-read-console', c.fqdn, 443, '/v1/stats', ['-H', '@' + headers.memory]),
    request('client-token', c.fqdn, 4200, '/api/v1/oauth/token', ['-H', 'Content-Type: application/json', '--data-binary', '@' + tokenBody]),
  ]);
}

function stop() {
  if (stopping) return;
  stopping = true;
  const wait = setInterval(() => {
    if (inflight > 0) return;
    clearInterval(wait);
    for (const path of [...Object.values(headers), tokenBody, join(work, 'search.body'), ...Array.from({ length: 8 }, (_, index) => join(work, 'memory-' + index + '.body'))]) rmSync(path, { force: true });
    process.exit(0);
  }, 100);
}
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
const timer = setInterval(() => {
  if (existsSync(c.stopFile)) { clearInterval(timer); stop(); return; }
  if (!stopping) void round();
}, c.intervalMs ?? 2000);
