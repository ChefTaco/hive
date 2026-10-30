import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'node:https';
import { execFileSync, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { InMemoryHiveMemStore } from '../services/hive-mem/ts-core/dist/src/store.js';
import { verifyHiveMemWebhook } from '../services/hive-mem/sdks/typescript/dist/index.js';

test('a real Memory event is accepted once by both SDK receivers', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'hivemem-sdk-receiver-'));
  const cert = join(directory, 'cert.pem'); const key = join(directory, 'key.pem');
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', cert, '-days', '1', '-subj', '/CN=localhost', '-addext', 'subjectAltName=DNS:localhost'], { stdio: 'ignore' });
  const secret = randomBytes(32).toString('hex'); let verification; let receiverFailure;
  const server = createServer({ key: readFileSync(key), cert: readFileSync(cert) }, async (request, response) => {
    try {
      const chunks = []; for await (const chunk of request) chunks.push(chunk);
      const body = Buffer.concat(chunks).toString();
      const options = { secret, body, timestamp: request.headers['x-hivemem-timestamp'], nonce: request.headers['x-hivemem-nonce'], signature: request.headers['x-hivemem-signature'] };
      const seenNonces = new Set();
      const ts = [await verifyHiveMemWebhook({ ...options, seenNonces }), await verifyHiveMemWebhook({ ...options, seenNonces })];
      const python = spawn(process.env.HIVE_TEST_PYTHON ?? 'python3', ['-c', [
        'import json, sys', 'from hivemem_sdk.webhooks import verify_webhook_signature',
        'options = json.load(sys.stdin)', "options['body'] = options['body'].encode('utf-8')",
        "options['seen_nonces'] = set()", 'print(json.dumps([verify_webhook_signature(**options), verify_webhook_signature(**options)]))',
      ].join('\n')], { timeout: 5000, env: { ...process.env, PYTHONPATH: fileURLToPath(new URL('../services/hive-mem/sdks/python/src', import.meta.url)) }, stdio: ['pipe', 'pipe', 'pipe'] });
      const output = []; python.stdout.on('data', (chunk) => output.push(chunk)); python.stderr.resume();
      const exited = new Promise((resolve, reject) => { python.once('error', reject); python.once('exit', resolve); });
      python.stdin.end(JSON.stringify(options));
      assert.equal(await exited, 0, 'Python SDK receiver must execute successfully');
      verification = { ts, python: JSON.parse(Buffer.concat(output).toString()), event: JSON.parse(body) };
      response.writeHead(202); response.end('verified');
    } catch (error) { receiverFailure = error; response.writeHead(500); response.end('fixture verification failed'); }
  });
  await new Promise((resolve) => server.listen(0, resolve));
  process.env.HIVEMEM_WEBHOOK_ALLOWED_PRIVATE_HOSTS = 'localhost'; process.env.HIVEMEM_WEBHOOK_CA_FILE = cert;
  try {
    const store = new InMemoryHiveMemStore();
    const principal = { agentId: 'sdk-receiver-fixture', scopes: ['*'], rawClaims: { role: 'admin' } };
    store.createWebhook(principal, { url: `https://localhost:${server.address().port}/events`, secret, event_types: ['memory.created'] });
    const memory = store.createMemory(principal, { content: 'Synthetic SDK event', type: 'semantic', scope: 'private' });
    const job = store.snapshot().queueJobs.find((job) => job.task_type === 'webhook_delivery');
    const result = await store.runQueueJob(principal, job.id);
    if (receiverFailure) throw receiverFailure;
    assert.equal(result.result.status, 'delivered');
    assert.deepEqual(verification.ts, [true, false]); assert.deepEqual(verification.python, [true, false]);
    assert.equal(verification.event.resource_id, memory.id);
    assert.equal(verification.event.event_type, 'memory.created');
  } finally {
    server.closeAllConnections(); await new Promise((resolve) => server.close(resolve));
    delete process.env.HIVEMEM_WEBHOOK_ALLOWED_PRIVATE_HOSTS; delete process.env.HIVEMEM_WEBHOOK_CA_FILE;
    rmSync(directory, { recursive: true });
  }
});
