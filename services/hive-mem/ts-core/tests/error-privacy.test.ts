import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import test from 'node:test';
import { InMemoryHiveMemStore, createHiveMemServer, signToken } from '../src/index.js';
import type { AuthPrincipal, QueueJobRecord } from '../src/types.js';

const admin: AuthPrincipal = { agentId: 'synthetic-operator', scopes: ['*'], rawClaims: { role: 'admin' } };

test('queue failures preserve retry state without returning or persisting exception details', async () => {
  const store = new InMemoryHiveMemStore();
  const receipt = store.schedulePeerDream(admin, admin.agentId, { workspace_id: 'default', operation_id: 'privacy-check' });
  const privateDetail = 'synthetic-private-diagnostic-at-internal-module.ts:123';
  Object.defineProperty(store, 'executeQueueJob', { value: async () => { throw new Error(privateDetail); } });
  const secret = 'synthetic-test-signing-key-at-least-32-bytes';
  const server = createHiveMemServer({ store, jwtSecret: secret });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const token = signToken(secret, { sub: admin.agentId, role: 'admin', scope: '*', exp: Math.floor(Date.now() / 1000) + 300 });
  try {
    const response = await fetch(`${base}/v1/queue/jobs/${receipt.job_id}/run`, { method: 'POST', headers: { authorization: `Bearer ${token}` } });
    assert.equal(response.status, 200);
    const text = await response.text();
    assert.ok(!text.includes(privateDetail));
    const result = JSON.parse(text);
    assert.equal(result.status, 'failed');
    assert.equal(result.retry_count, 1);
    assert.equal(result.error, 'Queue job execution failed');
    assert.ok(!JSON.stringify(store.snapshot()).includes(privateDetail));
    const restored = new InMemoryHiveMemStore({ snapshot: store.snapshot() });
    assert.equal(restored.getQueueJob(admin, receipt.job_id).error, result.error);
    const legacy = store.snapshot();
    legacy.queueJobs[0]!.error = privateDetail;
    const upgraded = new InMemoryHiveMemStore({ snapshot: legacy });
    assert.equal(upgraded.getQueueJob(admin, receipt.job_id).error, result.error);
    assert.ok(!JSON.stringify(upgraded.queueStatus(admin, new URLSearchParams())).includes(privateDetail));
    const operation = legacy.operations!.find((record) => record.kind === 'queue-operation')!;
    (operation.job as unknown as QueueJobRecord).error = privateDetail;
    legacy.queueJobs = [];
    const archived = new InMemoryHiveMemStore({ snapshot: legacy });
    assert.equal(archived.getQueueOperation(admin, 'privacy-check', new URLSearchParams('workspace_id=default&task_type=dream')).error, result.error);
    assert.ok(!JSON.stringify(archived.schedulePeerDream(admin, admin.agentId, { workspace_id: 'default', operation_id: 'privacy-check' })).includes(privateDetail));
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});
