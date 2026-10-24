import assert from 'node:assert/strict';
import test from 'node:test';
import type { AddressInfo } from 'node:net';
import { InMemoryHiveMemStore, createHiveMemServer, signToken } from '../src/index.js';
import { dream } from '../src/reasoning.js';
import type { AuthPrincipal, QueueJobRecord } from '../src/types.js';

const admin: AuthPrincipal = { agentId: 'operator', scopes: ['*'], rawClaims: { role: 'admin' } };
const principal = (id: string, workspaces = ['a', 'shared']): AuthPrincipal => ({ agentId: id, scopes: ['memories:read', 'memories:write', 'queue:read'], rawClaims: { workspace_ids: workspaces } });
function setup(): InMemoryHiveMemStore {
  const store = new InMemoryHiveMemStore();
  for (const workspace_id of ['a', 'b', 'shared']) store.createWorkspace(admin, { workspace_id, members: [{ agent_id: 'alpha', role: 'member' }, { agent_id: 'beta', role: 'member' }] });
  return store;
}
const memory = (store: InMemoryHiveMemStore, owner: AuthPrincipal, content: string, workspace_id = 'a') => store.createMemory(owner, { content, workspace_id, type: 'episodic', scope: 'private', confidence: 0.9, importance: 0.7 });

test('consolidation rejects cross-workspace and peer sources without enqueuing; execution rechecks validity', async () => {
  const store = setup(), alpha = principal('alpha', ['a', 'b', 'shared']), beta = principal('beta', ['b', 'shared']);
  const own = memory(store, alpha, 'Alpha prefers accurate provenance.'), peer = memory(store, beta, 'Beta prefers private context.', 'b');
  const before = store.snapshot().queueJobs.length;
  assert.throws(() => store.consolidateMemories(alpha, { workspace_id: 'shared', memory_ids: [own.id] }), /requested workspace/);
  assert.throws(() => store.consolidateMemories(alpha, { workspace_id: 'b', memory_ids: [peer.id] }), /requested workspace/);
  assert.equal(store.snapshot().queueJobs.length, before);
  const accepted = store.consolidateMemories(alpha, { workspace_id: 'a', memory_ids: [own.id], operation_id: 'late-retirement' });
  store.updateMemory(alpha, own.id, { valid_to: '2020-01-01T00:00:00.000Z' });
  const failed = await store.runQueueJob(admin, String(accepted.job_id));
  assert.equal(failed.status, 'failed');
  assert.match(failed.error!, /no longer current/);
  assert.equal(store.listPeerConclusions(alpha, alpha.agentId, new URLSearchParams('workspace_id=a')).length, 0);
});

test('operation receipts survive completion, restart and queue archival; canonical set replay and conflicting reuse', async () => {
  const store = setup(), alpha = principal('alpha');
  const a = memory(store, alpha, 'I prefer referenced evidence.'), b = memory(store, alpha, 'I prefer exact dates.');
  const body = { workspace_id: 'a', memory_ids: [b.id, a.id], operation_id: 'durable-1' };
  const first = store.consolidateMemories(alpha, body);
  assert.equal(store.consolidateMemories(alpha, { ...body, memory_ids: [a.id, b.id, a.id] }).job_id, first.job_id);
  const completed = await store.runQueueJob(admin, String(first.job_id));
  assert.equal(completed.status, 'completed');
  assert.equal(store.consolidateMemories(alpha, body).job_id, first.job_id);
  store.updateMemory(alpha, a.id, { valid_to: '2020-01-01T00:00:00.000Z' });
  assert.equal(store.consolidateMemories(alpha, body).job_id, first.job_id);
  assert.throws(() => store.consolidateMemories(alpha, { ...body, strategy: 'changed' }), /different payload/);
  const snapshot = store.snapshot(); snapshot.queueJobs = snapshot.queueJobs.filter(job => job.id !== completed.id);
  const restarted = new InMemoryHiveMemStore({ snapshot });
  const reconciled = restarted.getQueueOperation(alpha, body.operation_id, new URLSearchParams('workspace_id=a&task_type=consolidation'));
  assert.equal(reconciled.id, completed.id); assert.deepEqual(reconciled.result, completed.result);
  assert.equal(restarted.consolidateMemories(alpha, body).job_id, first.job_id);
  assert.throws(() => restarted.getQueueOperation(principal('beta', ['a']), body.operation_id, new URLSearchParams('workspace_id=a&task_type=consolidation')), /not found/);
  assert.throws(() => restarted.getQueueOperation(principal('alpha', ['shared']), body.operation_id, new URLSearchParams('workspace_id=a&task_type=consolidation')), /workspace/);
});

test('dream operations replay completed jobs and enforce runtime observer identity', async () => {
  const store = setup(), alpha = principal('alpha');
  const body = { workspace_id: 'a', operation_id: 'dream-1', include_peer_card: false };
  const first = store.schedulePeerDream(alpha, 'alpha', body);
  await store.runQueueJob(admin, first.job_id);
  assert.equal(store.schedulePeerDream(alpha, 'alpha', body).job_id, first.job_id);
  assert.throws(() => store.schedulePeerDream(alpha, 'beta', body), /different payload/);
  assert.throws(() => store.scheduleWorkspaceDream(alpha, 'a', { observer_peer_id: 'beta' }), /another observer/);
});

test('queue and consolidation inspection excludes peer owners and revoked workspaces', async () => {
  const store = setup(), alpha = principal('alpha'), beta = principal('beta', ['b', 'shared']);
  const own = memory(store, alpha, 'My own state.', 'shared'), other = memory(store, beta, 'My peer state.', 'shared');
  const a = store.consolidateMemories(alpha, { workspace_id: 'shared', memory_ids: [own.id] });
  const b = store.consolidateMemories(beta, { workspace_id: 'shared', memory_ids: [other.id] });
  await store.runQueueJob(admin, String(b.job_id));
  const state = store.consolidationStatus(alpha, new URLSearchParams('workspace_id=shared'));
  assert.equal(state.pending_jobs, 1); assert.equal(state.last_run, null);
  assert.throws(() => store.getQueueJob(alpha, String(b.job_id)), /not found/);
  assert.throws(() => store.getQueueJob(principal('alpha', ['a']), String(a.job_id)), /workspace/);
  assert.equal(store.queueStatus(principal('alpha', ['a']), new URLSearchParams()).jobs.some(job => job.id === a.job_id), false);
});

test('conclusions validate accessible sources and same-author workspace supersession before any writes', () => {
  const store = setup(), alpha = principal('alpha', ['a', 'b']), beta = principal('beta', ['b']);
  const a = memory(store, alpha, 'Own evidence.'), b = memory(store, beta, 'Peer private evidence.', 'b');
  assert.throws(() => store.createConclusion(alpha, 'alpha', { content: 'forged', workspace_id: 'a', source_memory_ids: [b.id] }), /inaccessible/);
  assert.throws(() => store.createConclusion(alpha, 'alpha', { content: 'outside', workspace_id: 'b', source_memory_ids: [a.id] }), /inaccessible/);
  const old = store.createConclusion(alpha, 'alpha', { content: 'first', workspace_id: 'a', source_memory_ids: [a.id] });
  assert.throws(() => store.createConclusion(alpha, 'alpha', { content: 'bad supersession', workspace_id: 'b', supersedes: old.id }), /same workspace/);
  const newer = store.createConclusion(alpha, 'alpha', { content: 'corrected', workspace_id: 'a', supersedes: old.id, source_memory_ids: [a.id] });
  assert.throws(() => store.getConclusion(alpha, old.id), /not found/);
  assert.equal(store.getConclusion(alpha, old.id, true).superseded_by, newer.id);
  assert.throws(() => store.getConclusion(beta, old.id, true), /not found/);
  assert.throws(() => store.createConclusion(beta, 'beta', { content: 'peer supersession', workspace_id: 'b', supersedes: old.id }), /own conclusions/);
});

test('dedupe retains all motivating sources and originals; dream preference/conflict hints are source linked', async () => {
  const store = setup(), alpha = principal('alpha');
  const a = memory(store, alpha, 'I prefer concise answers.'), b = memory(store, alpha, 'I prefer concise answers. Additional corroboration.');
  const ca = store.createConclusion(alpha, 'alpha', { content: 'Same derived claim.', workspace_id: 'a', source_memory_ids: [a.id] });
  const cb = store.createConclusion(alpha, 'alpha', { content: 'Same derived claim.', workspace_id: 'a', source_memory_ids: [b.id] });
  const queued = store.schedulePeerDream(alpha, 'alpha', { workspace_id: 'a', operation_id: 'dedupe' });
  await store.runQueueJob(admin, queued.job_id);
  const first = store.getConclusion(alpha, ca.id, true), second = store.getConclusion(alpha, cb.id, true);
  const keeper = first.superseded_by ? second : first;
  assert.deepEqual(new Set(keeper.source_memory_ids), new Set([a.id, b.id]));
  assert.equal(first.superseded_by === second.id || second.superseded_by === first.id, true);
  const result = dream([1, 2, 3].map(index => ({ content: `I prefer option ${index}; changed instead.`, confidence: 0.8, source_memory_ids: [`source-${index}`], deleted_at: null, superseded_by: null })), { peerId: 'alpha', sessionId: null });
  assert.deepEqual(result.conclusions.find(item => item.metadata.reasoning === 'dream_preference_pattern')!.source_memory_ids, ['source-1', 'source-2', 'source-3']);
  assert.deepEqual(result.conclusions.find(item => item.metadata.reasoning === 'dream_conflict_hint')!.source_memory_ids, ['source-1', 'source-2', 'source-3']);
});

test('stable cursor pages preserve legacy arrays and reject cursors reused with another privacy filter', () => {
  const store = setup(), alpha = principal('alpha');
  const ids = Array.from({ length: 5 }, (_, index) => store.createConclusion(alpha, 'alpha', { content: `claim ${index}`, workspace_id: 'a' }).id);
  assert.equal(Array.isArray(store.listPeerConclusions(alpha, 'alpha', new URLSearchParams('workspace_id=a'))), true);
  const all: string[] = []; let cursor: string | null = null;
  do {
    const params = new URLSearchParams('workspace_id=a&limit=2'); if (cursor) params.set('cursor', cursor);
    const page = store.listPeerConclusionsPage(alpha, 'alpha', params); all.push(...page.results.map(record => record.id)); cursor = page.next_cursor;
    if (cursor) { const invalidCursor = cursor; assert.throws(() => store.listPeerConclusionsPage(alpha, 'beta', new URLSearchParams({ workspace_id: 'a', cursor: invalidCursor })), /mismatched/); }
  } while (cursor);
  assert.deepEqual(new Set(all), new Set(ids)); assert.equal(all.length, ids.length);
});

test('HTTP exposes scoped reconciliation, pagination and historical reads with precise failures', async () => {
  const store = setup(), secret = 'native-learning-fixture-secret-32-characters';
  const server = createHiveMemServer({ jwtSecret: secret, store });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const call = (owner: string, method: string, path: string, body?: unknown, scopes = 'memories:read memories:write queue:read') => fetch(base + path, { method, headers: { authorization: `Bearer ${signToken(secret, { sub: owner, role: 'agent', workspace_ids: ['a', 'shared'], scope: scopes, exp: Math.floor(Date.now() / 1000) + 3600 })}`, 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
  try {
    const original = memory(store, principal('alpha'), 'Actual HTTP source.');
    const body = { workspace_id: 'a', memory_ids: [original.id], operation_id: 'http-1' };
    const response = await call('alpha', 'POST', '/v1/memories/consolidate', body); assert.equal(response.status, 200);
    const receipt = await response.json() as { job_id: string }; const job = await store.runQueueJob(admin, receipt.job_id);
    const retrieved = await call('alpha', 'GET', '/v1/queue/operations/http-1?workspace_id=a&task_type=consolidation'); assert.equal(retrieved.status, 200); assert.equal((await retrieved.json() as QueueJobRecord).id, receipt.job_id);
    assert.equal((await call('beta', 'GET', '/v1/queue/operations/http-1?workspace_id=a&task_type=consolidation')).status, 404);
    assert.equal((await call('alpha', 'GET', '/v1/queue/operations/http-1?workspace_id=a&task_type=consolidation', undefined, 'memories:read')).status, 403);
    assert.equal((await call('alpha', 'POST', '/v1/memories/consolidate', { ...body, priority: 2 })).status, 409);
    const conclusionId = String((job.result!.generated_conclusion_ids as string[])[0]);
    assert.equal((await call('alpha', 'GET', `/v1/conclusions/${conclusionId}`)).status, 200);
    store.updateMemory(principal('alpha'), original.id, { valid_to: '2020-01-01T00:00:00.000Z' });
    assert.equal((await call('alpha', 'GET', `/v1/conclusions/${conclusionId}`)).status, 404);
    assert.equal((await call('alpha', 'GET', `/v1/conclusions/${conclusionId}?include_history=true`)).status, 200);
    assert.equal((await call('beta', 'GET', `/v1/conclusions/${conclusionId}?include_history=true`)).status, 404);
    const paged = await call('alpha', 'GET', '/v1/peers/alpha/conclusions?workspace_id=a&paginate=true&include_history=true&limit=1');
    assert.equal(paged.status, 200); assert.equal(Array.isArray((await paged.json() as { results: unknown[] }).results), true);
  } finally { server.closeAllConnections(); await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
});
