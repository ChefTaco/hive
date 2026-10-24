import assert from 'node:assert/strict';
import test from 'node:test';
import { createHmac, randomBytes } from 'node:crypto';
import { createServer } from 'node:https';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { InMemoryHiveMemStore } from '../src/store.js';
import type { HiveMemPersistence, HiveMemSnapshot } from '../src/persistence.js';
import type { AuthPrincipal } from '../src/types.js';

const admin: AuthPrincipal = { agentId: 'webhook-fixture', scopes: ['*'], rawClaims: { role: 'admin' } };

test('real receivers and transport failures retain truthful delivery state after reload', { timeout: 30_000 }, async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'hivemem-outcomes-'));
  const cert = join(directory, 'cert.pem'); const key = join(directory, 'key.pem');
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', cert, '-days', '1', '-subj', '/CN=localhost', '-addext', 'subjectAltName=DNS:localhost'], { stdio: 'ignore' });
  const secret = randomBytes(32).toString('hex');
  let mode: 'accepted' | 'unavailable' | 'timeout' | 'oversized' = 'accepted';
  const received: Array<{ eventId: string; nonce: string }> = [];
  let onReceive = () => {};
  const server = createServer({ key: readFileSync(key), cert: readFileSync(cert) }, async (request, response) => {
    const chunks = []; for await (const chunk of request) chunks.push(chunk);
    const body = Buffer.concat(chunks).toString();
    const nonce = String(request.headers['x-hivemem-nonce']);
    assert.equal(request.headers['x-hivemem-signature'], 'sha256=' + createHmac('sha256', secret).update(`${request.headers['x-hivemem-timestamp']}.${nonce}.${body}`).digest('hex'));
    received.push({ eventId: JSON.parse(body).event_id as string, nonce }); onReceive();
    if (mode === 'timeout') return;
    if (mode === 'oversized') { response.end('x'.repeat(70_000)); return; }
    response.writeHead(mode === 'accepted' ? 202 : 503); response.end('fixture');
  });
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  process.env.HIVEMEM_WEBHOOK_ALLOWED_PRIVATE_HOSTS = 'localhost'; process.env.HIVEMEM_WEBHOOK_CA_FILE = cert;
  const port = address.port;
  let sequence = 0;
  function fixture(url = `https://localhost:${port}/events`) {
    const path = join(directory, 'state-' + sequence++ + '.json');
    const persistence: HiveMemPersistence = {
      kind: 'qdrant',
      load: async () => JSON.parse(readFileSync(path, 'utf8')) as HiveMemSnapshot,
      save: async (snapshot) => { writeFileSync(path, JSON.stringify(snapshot), { mode: 0o600, flush: true }); },
    };
    const store = new InMemoryHiveMemStore({ persistence });
    const endpoint = store.createWebhook(admin, { url, workspace_id: 'default', event_types: ['memory.created'], secret });
    const emitted = store.testWebhook(admin, { event_type: 'webhook.test', workspace_id: 'default', data: { fixture: true } });
    const deliveryId = emitted.delivery_ids[0]!;
    const job = store.snapshot().queueJobs.find((job) => job.payload.delivery_id === deliveryId)!;
    const reload = async () => { await store.flushPersistence(); return new InMemoryHiveMemStore({ snapshot: await persistence.load(), persistence }); };
    return { store, endpoint, job, deliveryId, reload, persistence };
  }
  try {
    await t.test('non-2xx retries retain status, stable event identity and a durable dead letter', async () => {
      mode = 'unavailable'; const f = fixture(); let store = f.store;
      const first = received.length;
      for (let attempt = 1; attempt <= 4; attempt++) {
        const result = await store.runQueueJob(admin, f.job.id); await store.flushPersistence();
        store = new InMemoryHiveMemStore({ snapshot: await f.persistence.load(), persistence: f.persistence });
        assert.equal(result.status, attempt === 4 ? 'dead_letter' : 'failed');
        assert.equal(store.getQueueJob(admin, f.job.id).status, result.status);
        assert.equal(store.getWebhookDelivery(admin, f.deliveryId).response_status, 503);
        assert.equal(store.getWebhookDelivery(admin, f.deliveryId).attempts, attempt);
        assert.equal(store.getWebhook(admin, f.endpoint.id).last_status, 'failed');
      }
      assert.equal(new Set(received.slice(first).map((entry) => entry.eventId)).size, 1);
      assert.equal(new Set(received.slice(first).map((entry) => entry.nonce)).size, 4);
      mode = 'accepted'; await store.runQueueJob(admin, f.job.id); await store.flushPersistence();
      store = new InMemoryHiveMemStore({ snapshot: await f.persistence.load() });
      assert.equal(store.getWebhookDelivery(admin, f.deliveryId).status, 'delivered');
      assert.equal(store.getWebhookDelivery(admin, f.deliveryId).response_status, 202);
      assert.equal(store.getWebhook(admin, f.endpoint.id).last_error, null);
    });
    for (const scenario of ['dns', 'timeout', 'response_limit'] as const) await t.test(scenario + ' failure is persisted without inventing receiver success', async () => {
      mode = scenario === 'timeout' ? 'timeout' : scenario === 'response_limit' ? 'oversized' : 'accepted';
      const f = fixture(scenario === 'dns' ? 'https://hive-webhook-receiver.invalid/events' : undefined);
      const started = Date.now(); await f.store.runQueueJob(admin, f.job.id); const restored = await f.reload();
      const delivery = restored.getWebhookDelivery(admin, f.deliveryId);
      assert.equal(delivery.status, 'failed'); assert.equal(delivery.error, scenario); assert.equal(delivery.attempts, 1);
      assert.equal(delivery.delivered_at, null); assert.equal(restored.getQueueJob(admin, f.job.id).status, 'failed');
      assert.ok(Date.now() - started < 15_000);
    });
    await t.test('disabled endpoints never send and retain their reason', async () => {
      const f = fixture(); const before = received.length;
      f.store.updateWebhook(admin, f.endpoint.id, { enabled: false });
      const result = await f.store.runQueueJob(admin, f.job.id); const restored = await f.reload();
      assert.deepEqual(result.result, { status: 'skipped', reason: 'endpoint_disabled' });
      assert.equal(restored.getWebhookDelivery(admin, f.deliveryId).attempts, 0);
      assert.equal(restored.getWebhookDelivery(admin, f.deliveryId).error, 'endpoint_disabled');
      assert.equal(received.length, before);
    });
    await t.test('an in-flight delivery cannot overwrite a concurrent endpoint disable', async () => {
      mode = 'accepted'; const f = fixture();
      onReceive = () => { f.store.updateWebhook(admin, f.endpoint.id, { enabled: false }); };
      await f.store.runQueueJob(admin, f.job.id); const restored = await f.reload(); onReceive = () => {};
      assert.equal(restored.getWebhook(admin, f.endpoint.id).enabled, false);
      assert.equal(restored.getWebhookDelivery(admin, f.deliveryId).status, 'delivered');
    });
    await t.test('changed workspace and missing historical secret have explicit unsent outcomes', async () => {
      const f = fixture(); const before = received.length;
      f.store.createWorkspace(admin, { workspace_id: 'other', title: 'Other' });
      f.store.updateWebhook(admin, f.endpoint.id, { workspace_id: 'other' });
      await f.store.runQueueJob(admin, f.job.id);
      assert.equal((await f.reload()).getWebhookDelivery(admin, f.deliveryId).error, 'endpoint_workspace_changed');
      const missing = fixture(); const snapshot = missing.store.snapshot();
      for (const endpoint of snapshot.webhooks) delete (endpoint as unknown as Record<string, unknown>).signing_secret;
      const restored = new InMemoryHiveMemStore({ snapshot, persistence: missing.persistence });
      await restored.runQueueJob(admin, missing.job.id); await restored.flushPersistence();
      const reloaded = new InMemoryHiveMemStore({ snapshot: await missing.persistence.load() });
      assert.equal(reloaded.getWebhookDelivery(admin, missing.deliveryId).error, 'signing_secret_unconfigured');
      assert.equal(received.length, before);
    });
    await t.test('endpoint updates cannot change to a workspace the owner cannot write', () => {
      const owner: AuthPrincipal = { agentId: 'narrow-owner', scopes: ['*'], rawClaims: {} };
      const store = new InMemoryHiveMemStore();
      store.createWorkspace(admin, { workspace_id: 'restricted', title: 'Restricted' });
      const endpoint = store.createWebhook(owner, { url: `https://localhost:${port}/events`, secret });
      const before = structuredClone(store.snapshot());
      assert.throws(() => store.updateWebhook(owner, endpoint.id, { workspace_id: 'restricted' }), /permission/);
      assert.deepEqual(store.snapshot(), before);
      assert.throws(() => store.createWebhook(owner, { url: `https://username:credential@localhost:${port}/events`, secret }), /credentials/);
    });
  } finally {
    server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve()));
    delete process.env.HIVEMEM_WEBHOOK_ALLOWED_PRIVATE_HOSTS; delete process.env.HIVEMEM_WEBHOOK_CA_FILE;
    rmSync(directory, { recursive: true });
  }
});
