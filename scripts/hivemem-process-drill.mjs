import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { createServer } from 'node:http';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { InMemoryHiveMemStore } from '../services/hive-mem/ts-core/dist/src/store.js';
import { QdrantHiveMemPersistence } from '../services/hive-mem/ts-core/dist/src/persistence.js';
import { signToken } from '../services/hive-mem/ts-core/dist/src/auth.js';

const exec = promisify(execFile);
const root = fileURLToPath(new URL('../', import.meta.url));
const directory = await mkdtemp(join(tmpdir(), 'hivemem-process-drill-'));
const name = 'hivemem-process-drill-' + randomUUID();
const volume = name + '-state';
const reportPath = resolve(process.env.HIVE_MEMORY_DRILL_REPORT ?? join(tmpdir(), 'hivemem-process-drill.json'));
const secret = randomBytes(32).toString('hex');
const admin = { agentId: 'drill-operator', scopes: ['*'], rawClaims: { role: 'admin' } };
const token = signToken(secret, { sub: admin.agentId, role: 'admin', scope: '*', exp: Math.floor(Date.now() / 1000) + 3600 });
const report = { started_at: new Date().toISOString(), checks: [], benchmarks: [], passed: false };
const sleep = (milliseconds) => new Promise((done) => setTimeout(done, milliseconds));
let endpoint; let qdrantUrl; let child = null; let base; let proxy; let peakRss = 0; let sampler;
let gate = null; let blocked = false; let releaseGate = () => {}; let delay = 0;
const output = [];
const note = (text) => console.log('[memory-drill] ' + text);
async function docker(...args) { return (await exec('docker', ['--host', endpoint, ...args], { timeout: 120_000, maxBuffer: 4_000_000 })).stdout.trim(); }
async function until(check, label, timeout = 20_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { if (await check()) return; await sleep(100); }
  throw new Error('Timed out: ' + label);
}
async function json(url, method = 'GET', body, headers = {}) {
  const response = await fetch(url, { method, headers: { 'content-type': 'application/json', ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(20_000) });
  const value = await response.json(); return { status: response.status, value };
}
const api = (path, method = 'GET', body) => json(base + path, method, body, { authorization: 'Bearer ' + token });
async function startQdrant() {
  await docker('start', name);
  const ports = JSON.parse(await docker('inspect', '--format', '{{json .NetworkSettings.Ports}}', name));
  qdrantUrl = 'http://127.0.0.1:' + ports['6333/tcp'][0].HostPort;
  await until(async () => { try { return (await fetch(qdrantUrl + '/readyz')).ok; } catch { return false; } }, 'Qdrant readiness');
}
async function rss() {
  if (!child?.pid) return;
  try { const status = await readFile('/proc/' + child.pid + '/status', 'utf8'); const kb = Number(status.match(/^VmRSS:\s+(\d+)/m)?.[1] ?? 0); peakRss = Math.max(peakRss, kb / 1024); } catch {}
}
async function stopApi(signal = 'SIGTERM') {
  if (!child) return;
  const current = child; child = null;
  if (current.exitCode === null && current.signalCode === null) {
    const exited = new Promise((done) => current.once('exit', done));
    const force = setTimeout(() => current.kill('SIGKILL'), 10_000);
    current.kill(signal); await exited; clearTimeout(force);
  }
  // flock's pipe-holding child releases its kernel lock after EOF on SIGKILL.
  await until(async () => { try { await exec('flock', ['-n', join(directory, 'writer.lock'), 'true']); return true; } catch { return false; } }, 'writer lock release', 5000);
}
async function startApi(worker = false) {
  const reservation = createServer(); await new Promise((done) => reservation.listen(0, '127.0.0.1', done));
  const port = reservation.address().port; await new Promise((done) => reservation.close(done));
  base = 'http://127.0.0.1:' + port;
  child = spawn(process.execPath, ['--max-old-space-size=768', 'services/hive-mem/ts-core/dist/src/cli.js'], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'], env: {
    PATH: process.env.PATH, NODE_ENV: 'test', HIVEMEM_JWT_SECRET: secret,
    HIVEMEM_TS_CORE_HOST: '127.0.0.1', HIVEMEM_TS_CORE_PORT: String(port),
    HIVEMEM_STORAGE_PATH: directory, HIVEMEM_TS_PERSISTENCE: 'qdrant',
    HIVEMEM_QDRANT_URL: 'http://127.0.0.1:' + proxy.address().port,
    HIVEMEM_WORKER_ENABLED: String(worker), HIVEMEM_CONSOLIDATION_INTERVAL_SECONDS: '0',
  } });
  for (const stream of [child.stdout, child.stderr]) stream.on('data', (chunk) => { output.push(chunk.toString()); if (output.length > 40) output.shift(); });
  await until(async () => {
    if (child.exitCode !== null) throw new Error('Memory process exited during startup: ' + output.slice(-3).join('').slice(-1500));
    try { return (await json(base + '/v1/health/ready')).status === 200; } catch { return false; }
  }, 'Memory readiness', 30_000);
  const health = (await json(base + '/v1/health/ready')).value;
  assert.equal(health.worker.enabled, worker);
  assert.equal(health.worker.managed, true);
  if (!worker) assert.equal(health.worker.state, 'disabled');
}
function persistence() { return new QdrantHiveMemPersistence({ url: qdrantUrl, journalPath: join(directory, 'pending-write.json') }); }
async function seed(size) {
  assert.equal(child, null, 'Fixture seeding requires the writer to be stopped');
  const adapter = persistence(); const store = new InMemoryHiveMemStore({ snapshot: await adapter.load() });
  const existing = store.snapshot().memories.length;
  const types = ['semantic', 'episodic', 'procedural'];
  for (let n = existing; n < size; n++) store.createMemory({ agentId: 'corpus-' + (Math.floor(n / 3) % 12), scopes: ['*'], rawClaims: {} }, {
    content: 'Synthetic corpus record ' + n + '. ' + 'A locally generated operational note with no production content. '.repeat(30),
    type: types[n % 3], scope: n % 10 === 0 ? 'shared' : 'private', tags: ['drill', 'synthetic'], metadata: { fixture: true, sequence: n },
  });
  const snapshot = store.snapshot(); snapshot.queueJobs = snapshot.queueJobs.filter((job) => job.task_type !== 'conflict_scan');
  await adapter.save(snapshot);
}
async function findMemory(content) {
  const response = await api('/v1/memories/search', 'POST', { query: content, workspace_id: 'default', limit: 100 });
  assert.equal(response.status, 200); return response.value.results.filter((result) => result.memory.content === content);
}
async function storedPoint(collection, id) {
  const response = await json(qdrantUrl + '/collections/' + collection + '/points/scroll', 'POST', { with_payload: true, with_vector: true, limit: 10, filter: { must: [{ key: 'id', match: { value: id } }] } });
  assert.equal(response.status, 200); return response.value.result.points;
}
try {
  endpoint = (await exec('docker', ['context', 'inspect', '--format', '{{(index .Endpoints "docker").Host}}'])).stdout.trim();
  assert.ok(endpoint.startsWith('unix://'), 'The drill only uses a local Unix Docker socket; remote daemons are refused');
  const compose = await readFile(join(root, 'services/hive-mem/docker/docker-compose.yml'), 'utf8');
  const image = compose.match(/image:\s*(qdrant\/qdrant:v[\d.]+)/)?.[1]; assert.ok(image, 'Pinned Qdrant image required');
  report.image = image;
  try { await docker('image', 'inspect', image); } catch { note('Pulling the repository-pinned Qdrant image'); await docker('pull', image); }
  await docker('create', '--name', name, '--label', 'hive.fixture=hivemem-process-drill', '--memory', '1g', '-p', '127.0.0.1::6333', '--mount', 'type=volume,src=' + volume + ',dst=/qdrant/storage', image);
  await startQdrant();
  proxy = createServer(async (request, response) => {
    try {
      const chunks = []; for await (const chunk of request) chunks.push(chunk);
      const body = Buffer.concat(chunks); const parsed = body.length ? JSON.parse(body.toString()) : null;
      if (delay) await sleep(delay);
      const match = gate?.(request.method, request.url, parsed);
      if (match === 'before') { blocked = true; await new Promise((done) => { releaseGate = done; response.once('close', done); }); if (response.destroyed) return; }
      const upstream = await fetch(qdrantUrl + request.url, { method: request.method, headers: { 'content-type': 'application/json' }, ...(body.length ? { body } : {}), signal: AbortSignal.timeout(15_000) });
      const payload = Buffer.from(await upstream.arrayBuffer());
      if (match === 'after') { blocked = true; await new Promise((done) => { releaseGate = done; response.once('close', done); }); if (response.destroyed) return; }
      response.writeHead(upstream.status, { 'content-type': 'application/json' }); response.end(payload);
    } catch { if (!response.destroyed) { response.writeHead(503, { 'content-type': 'application/json' }); response.end('{"error":"Fixture dependency unavailable"}'); } }
  });
  await new Promise((done) => proxy.listen(0, '127.0.0.1', done));
  sampler = setInterval(() => { void rss(); }, 50);
  note('Seeding 1,000 synthetic memories across shared/private collections'); await seed(1000); await startApi();

  const content = 'Durable receipt survives a killed process ' + randomUUID();
  const created = await api('/v1/memories', 'POST', { content, type: 'semantic', scope: 'shared' }); assert.equal(created.status, 201);
  await stopApi('SIGKILL'); await startApi(); assert.equal((await findMemory(content)).length, 1);
  report.checks.push('durable_receipt_survives_sigkill'); note('Successful receipt survived SIGKILL and restart');

  const duplicate = spawn(process.execPath, ['services/hive-mem/ts-core/dist/src/cli.js'], { cwd: root, stdio: 'ignore', env: { PATH: process.env.PATH, HIVEMEM_STORAGE_PATH: directory, HIVEMEM_JWT_SECRET: secret } });
  assert.notEqual(await new Promise((done) => duplicate.once('exit', done)), 0); report.checks.push('second_writer_rejected');

  const point = (await storedPoint('shared_semantic', created.value.id))[0]; assert.ok(point);
  gate = (method, path, body) => method === 'PUT' && path.includes('drill-operator_private_semantic/points') && body?.points?.some((entry) => entry.payload.id === created.value.id) ? 'before' : null;
  const moving = api('/v1/memories/privatize', 'POST', { memory_id: created.value.id }).catch(() => null);
  await until(() => blocked, 'collection move interruption');
  assert.equal((await storedPoint('shared_semantic', created.value.id)).length, 0);
  assert.ok(existsSync(join(directory, 'pending-write.json')));
  await stopApi('SIGKILL'); gate = null; blocked = false; releaseGate(); await moving; await startApi();
  const recovered = (await findMemory(content))[0]; assert.equal(recovered.memory.scope, 'private');
  assert.equal((await storedPoint('shared_semantic', created.value.id)).length, 0);
  const target = (await storedPoint('drill-operator_private_semantic', created.value.id))[0]; assert.ok(target);
  assert.ok(target.vector.every((value, index) => Math.abs(value - point.vector[index]) < 0.000001));
  report.checks.push('interrupted_collection_move_preserves_vector_and_privacy'); note('Interrupted collection move recovered through its fsynced journal');

  await docker('stop', '--time', '1', name);
  const unavailable = await api('/v1/memories', 'POST', { content: 'Indeterminate outage fixture', type: 'semantic', scope: 'private' }); assert.equal(unavailable.status, 503);
  assert.equal((await json(base + '/v1/health/ready')).status, 503); assert.equal((await json(base + '/v1/health/live')).status, 200);
  await startQdrant(); await until(async () => (await json(base + '/v1/health/ready')).status === 200, 'automatic persistence recovery', 15_000);
  assert.equal((await findMemory('Indeterminate outage fixture')).length, 1);
  report.checks.push('real_qdrant_outage_fails_writes_and_recovers');
  delay = 150;
  const slowStart = performance.now();
  assert.equal((await api('/v1/memories', 'POST', { content: 'Slow dependency fixture', type: 'semantic', scope: 'private' })).status, 201);
  assert.ok(performance.now() - slowStart >= 150); delay = 0;
  assert.equal((await json(base + '/v1/health/ready')).value.persistence.pending, false);
  report.checks.push('slow_dependency_waits_for_durable_ack');

  await stopApi(); await startApi(true);
  assert.equal((await api('/v1/episodes', 'POST', { episode_id: 'worker-drill', workspace_id: 'default' })).status, 201);
  gate = (method, path, body) => method === 'PUT' && path.includes('/_queue/points') && body?.points?.some((entry) => entry.payload.status === 'in_progress') ? 'after' : null;
  const message = await api('/v1/episodes/worker-drill/messages', 'POST', { message_id: 'worker-message', content: 'Autonomous restart extraction fixture', role: 'user', produce_memory: true }); assert.equal(message.status, 201);
  await until(() => blocked, 'persisted worker claim'); await stopApi('SIGKILL'); gate = null; blocked = false; releaseGate();
  const restart = performance.now(); await startApi(true);
  await until(async () => (await api('/v1/queue/jobs/' + message.value.memory_job_id)).value.status === 'completed', 'autonomous interrupted-job recovery', 15_000);
  report.worker_recovery_ms = Math.round(performance.now() - restart);
  assert.ok(report.worker_recovery_ms < 15_000, 'Exclusive writer recovery must not wait for the old lease');
  assert.equal((await json(base + '/v1/health/ready')).value.worker.recovered_on_startup, 1);
  assert.equal((await findMemory('Autonomous restart extraction fixture')).length, 1);
  await stopApi('SIGKILL'); await startApi(true); assert.equal((await findMemory('Autonomous restart extraction fixture')).length, 1);
  report.checks.push('autonomous_episode_extraction_recovers_once'); note('Autonomous episode extraction survived a killed worker');

  await stopApi();
  const adapter = persistence(); const snapshot = await adapter.load();
  const poison = { ...snapshot.queueJobs.find((job) => job.id === message.value.memory_job_id), id: randomUUID(), task_type: 'embedding_reconcile', status: 'pending', payload: {}, retry_count: 0, not_before: null, started_at: null, finished_at: null, locked_at: null, result: null, error: null, idempotency_key: 'poison-drill' };
  snapshot.queueJobs.push(poison);
  const pending = new InMemoryHiveMemStore({ snapshot });
  pending.appendEpisodeMessage(admin, 'worker-drill', { message_id: 'after-poison', content: 'Healthy job behind poison fixture', role: 'user', produce_memory: true });
  await adapter.save(pending.snapshot()); await startApi(true);
  await until(async () => (await findMemory('Healthy job behind poison fixture')).length === 1, 'healthy work behind poison');
  await until(async () => (await api('/v1/queue/jobs/' + poison.id)).value.status === 'dead_letter', 'poison dead letter', 25_000);
  report.checks.push('poison_job_does_not_starve_queue_and_dead_letters');

  for (const size of [1000, 4000]) {
    await stopApi(); if (size === 4000) await seed(size); peakRss = 0;
    const actualRecords = (await persistence().load()).memories.length;
    const loading = performance.now(); await startApi(); const loadMs = Math.round(performance.now() - loading);
    const latencies = []; const started = performance.now();
    await Promise.all(Array.from({ length: 8 }, async (_, index) => {
      const start = performance.now();
      const response = await api('/v1/memories', 'POST', { content: 'Concurrent synthetic write ' + size + ':' + index, type: 'semantic', scope: 'private' });
      assert.equal(response.status, 201); latencies.push(performance.now() - start);
    }));
    await rss(); const readiness = (await json(base + '/v1/health/ready')).value;
    assert.equal(readiness.persistence.pending, false);
    const row = { synthetic_corpus: size, records_before_writes: actualRecords, load_ms: loadMs, concurrent_writes: 8, batch_ms: Math.round(performance.now() - started), max_ack_ms: Math.round(Math.max(...latencies)), peak_rss_mib: Math.round(peakRss), persistence_pending_after_ack: readiness.persistence.pending };
    assert.ok(row.max_ack_ms < 15_000, 'Write acknowledgements must remain bounded'); assert.ok(peakRss < 1024, 'Process RSS must remain below one GiB');
    report.benchmarks.push(row); note('Benchmark ' + JSON.stringify(row));
  }
  report.passed = true;
} catch (error) { report.failure = error instanceof Error ? error.message : String(error); process.exitCode = 1; }
finally {
  if (sampler) clearInterval(sampler); gate = null; releaseGate();
  await stopApi('SIGKILL').catch(() => {});
  if (proxy) { proxy.closeAllConnections(); await new Promise((done) => proxy.close(done)); }
  if (endpoint) { await docker('rm', '-f', name).catch(() => {}); await docker('volume', 'rm', volume).catch(() => {}); }
  await rm(directory, { recursive: true, force: true });
  report.finished_at = new Date().toISOString(); await writeFile(reportPath, JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
  console.log(JSON.stringify(report, null, 2)); note('Report: ' + reportPath);
}
