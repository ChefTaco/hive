import assert from 'node:assert/strict';
import test from 'node:test';
import type { AddressInfo } from 'node:net';
import { InMemoryHiveMemStore, createHiveMemServer, signToken } from '../src/index.js';
import type { AuthPrincipal, JsonObject } from '../src/types.js';

const admin: AuthPrincipal = { agentId: 'operator', scopes: ['*'], rawClaims: { role: 'admin' } };
const principal = (id: string, workspaces = ['a', 'b']): AuthPrincipal => ({
  agentId: id,
  scopes: ['memories:read', 'memories:write', 'queue:read'],
  rawClaims: { workspace_ids: workspaces },
});

function setup(): InMemoryHiveMemStore {
  const store = new InMemoryHiveMemStore();
  for (const workspace_id of ['a', 'b']) {
    store.createWorkspace(admin, { workspace_id, members: [{ agent_id: 'alpha', role: 'member' }, { agent_id: 'beta', role: 'member' }] });
  }
  return store;
}

const remember = (store: InMemoryHiveMemStore, owner: AuthPrincipal, content: string, extra: Record<string, unknown> = {}) =>
  store.createMemory(owner, { content, workspace_id: 'a', type: 'episodic', scope: 'private', confidence: 0.9, importance: 0.7, ...extra });

test('forgetting a subject also deletes superseded and retired versions so history reads cannot recover them', () => {
  const store = setup();
  const alpha = principal('alpha');
  const original = remember(store, alpha, 'Project Falcon launch code is 1234.');
  const replacement = remember(store, alpha, 'Project Falcon launch code rotated.', { supersedes: original.id });
  const retired = remember(store, alpha, 'Project Falcon was paused once.');
  store.updateMemory(alpha, retired.id, { valid_to: '2020-01-01T00:00:00.000Z' });
  assert.equal(store.getMemory(alpha, original.id, true).id, original.id);

  const preview = store.forgetSubject(alpha, { workspace_id: 'a', subject: 'falcon' });
  assert.equal(preview.matched, 3);
  const result = store.forgetSubject(alpha, { workspace_id: 'a', subject: 'falcon', dry_run: false });
  assert.equal(result.deleted, 3);
  for (const id of [original.id, replacement.id, retired.id]) assert.throws(() => store.getMemory(alpha, id, true), /not found/i);

  const purged = store.purgeMemories(admin, { workspace_id: 'a', dry_run: false });
  assert.equal(purged.purged, 3);
});

test('expired memories are excluded from history reads', () => {
  const store = setup();
  const alpha = principal('alpha');
  const memory = remember(store, alpha, 'Temporary access window.');
  store.updateMemory(alpha, memory.id, { expires_at: '2020-01-01T00:00:00.000Z' });
  assert.throws(() => store.getMemory(alpha, memory.id), /not found/i);
  assert.throws(() => store.getMemory(alpha, memory.id, true), /not found/i);
});

test('conclusion history includes superseded records but never soft-deleted ones', () => {
  const store = setup();
  const alpha = principal('alpha');
  const old = store.createConclusion(alpha, 'alpha', { content: 'first claim', workspace_id: 'a' });
  const newer = store.createConclusion(alpha, 'alpha', { content: 'corrected claim', workspace_id: 'a', supersedes: old.id });
  const removed = store.createConclusion(alpha, 'alpha', { content: 'removed claim', workspace_id: 'a' });
  store.deleteConclusion(alpha, removed.id);

  assert.equal(store.getConclusion(alpha, old.id, true).superseded_by, newer.id);
  assert.throws(() => store.getConclusion(alpha, removed.id, true), /not found/i);
  assert.throws(() => store.getConclusion(admin, removed.id, true), /not found/i);

  for (const flag of ['include_history', 'include_deleted']) {
    const params = new URLSearchParams({ workspace_id: 'a', [flag]: 'true' });
    const listed = store.listPeerConclusions(alpha, 'alpha', params).map((record) => record.id);
    assert.deepEqual(new Set(listed), new Set([old.id, newer.id]));
    const paged = store.listPeerConclusionsPage(alpha, 'alpha', params).results.map((record) => record.id);
    assert.deepEqual(new Set(paged), new Set([old.id, newer.id]));
  }
});

test('paged conclusions follow the unpaged confidence ordering with a stable cursor', () => {
  const store = setup();
  const alpha = principal('alpha');
  for (const [index, confidence] of [0.2, 0.9, 0.5, 0.9, 0.7].entries()) {
    store.createConclusion(alpha, 'alpha', { content: `claim ${index}`, workspace_id: 'a', confidence });
  }
  const unpaged = store.listPeerConclusions(alpha, 'alpha', new URLSearchParams('workspace_id=a'));
  const paged: number[] = [];
  const seen = new Set<string>();
  let cursor: string | null = null;
  do {
    const params = new URLSearchParams('workspace_id=a&limit=2');
    if (cursor) params.set('cursor', cursor);
    const page = store.listPeerConclusionsPage(alpha, 'alpha', params);
    for (const record of page.results) {
      assert.equal(seen.has(record.id), false);
      seen.add(record.id);
      paged.push(record.confidence);
    }
    cursor = page.next_cursor;
  } while (cursor);
  assert.deepEqual(paged, unpaged.map((record) => record.confidence));
  assert.deepEqual(paged, [0.9, 0.9, 0.7, 0.5, 0.2]);
});

test('finished queue operation receipts are pruned after the retention window', async () => {
  const store = setup();
  const alpha = principal('alpha');
  const source = remember(store, alpha, 'Receipt source.');
  const first = store.consolidateMemories(alpha, { workspace_id: 'a', memory_ids: [source.id], operation_id: 'old-op' });
  await store.runQueueJob(admin, String(first.job_id));
  const query = new URLSearchParams('workspace_id=a&task_type=consolidation');
  assert.equal(store.getQueueOperation(alpha, 'old-op', query).id, first.job_id);

  const snapshot = store.snapshot();
  const longAgo = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000).toISOString();
  snapshot.queueJobs = snapshot.queueJobs.map((job) => job.id === first.job_id ? { ...job, finished_at: longAgo } : job);
  snapshot.operations = (snapshot.operations ?? []).map((operation): JsonObject => operation.kind === 'queue-operation'
    ? { ...operation, created_at: longAgo, job: { ...(operation.job as JsonObject), finished_at: longAgo } }
    : operation);
  const restarted = new InMemoryHiveMemStore({ snapshot });
  const fresh = remember(restarted, alpha, 'Second receipt source.');
  restarted.consolidateMemories(alpha, { workspace_id: 'a', memory_ids: [fresh.id], operation_id: 'new-op' });
  assert.throws(() => restarted.getQueueOperation(alpha, 'old-op', query), /not found/i);
  assert.equal(restarted.getQueueOperation(alpha, 'new-op', query).status, 'pending');
});

test('dedupe merging caps conclusion sources at 100', async () => {
  const store = setup();
  const alpha = principal('alpha');
  const sources = Array.from({ length: 150 }, (_, index) => remember(store, alpha, `Evidence item ${index}.`).id);
  store.createConclusion(alpha, 'alpha', { content: 'Shared derived claim.', workspace_id: 'a', source_memory_ids: sources.slice(0, 100) });
  store.createConclusion(alpha, 'alpha', { content: 'Shared derived claim.', workspace_id: 'a', source_memory_ids: sources.slice(50) });
  const queued = store.schedulePeerDream(alpha, 'alpha', { workspace_id: 'a', include_peer_card: false });
  await store.runQueueJob(admin, queued.job_id);
  const all = store.listPeerConclusions(alpha, 'alpha', new URLSearchParams('workspace_id=a&include_history=true&limit=200'));
  assert.ok(all.some((conclusion) => conclusion.superseded_by));
  assert.ok(all.some((conclusion) => !conclusion.superseded_by && conclusion.source_memory_ids.length === 100));
  for (const conclusion of all) assert.ok(conclusion.source_memory_ids.length <= 100);
});

test('consolidation logs of another workspace are reported as not found', async () => {
  const store = setup();
  const alpha = principal('alpha');
  const source = remember(store, alpha, 'Workspace A evidence.');
  const queued = store.consolidateMemories(alpha, { workspace_id: 'a', memory_ids: [source.id] });
  await store.runQueueJob(admin, String(queued.job_id));
  assert.equal(store.consolidationLog(alpha, String(queued.job_id)).run_id, queued.job_id);
  assert.throws(() => store.consolidationLog(principal('alpha', ['b']), String(queued.job_id)), /Consolidation run not found/);
});

async function withServer<T>(options: Parameters<typeof createHiveMemServer>[0], run: (base: string) => Promise<T>): Promise<T> {
  const server = createHiveMemServer(options);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    return await run(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}

const secret = 'history-retention-secret-at-least-32-chars';
const exp = () => Math.floor(Date.now() / 1000) + 3600;

test('metrics require an admin token or the configured scrape token unless loopback scraping is enabled', async () => {
  const scrapeToken = 'metrics-scrape-token-with-32-plus-characters';
  await withServer({ jwtSecret: secret, store: new InMemoryHiveMemStore(), metricsToken: scrapeToken, metricsAllowLoopback: false }, async (base) => {
    assert.equal((await fetch(base + '/metrics')).status, 401);
    const agent = signToken(secret, { sub: 'agent', role: 'agent', scope: 'memories:read', exp: exp() });
    assert.equal((await fetch(base + '/metrics', { headers: { authorization: `Bearer ${agent}` } })).status, 403);
    assert.equal((await fetch(base + '/metrics', { headers: { authorization: 'Bearer wrong-token' } })).status, 401);
    assert.equal((await fetch(base + '/metrics', { headers: { authorization: `Bearer ${scrapeToken}` } })).status, 200);
    const adminJwt = signToken(secret, { sub: 'ops', role: 'admin', scope: '*', exp: exp() });
    assert.equal((await fetch(base + '/metrics', { headers: { authorization: `Bearer ${adminJwt}` } })).status, 200);
  });
  await withServer({ jwtSecret: secret, store: new InMemoryHiveMemStore(), metricsAllowLoopback: true }, async (base) => {
    assert.equal((await fetch(base + '/metrics')).status, 200);
  });
  assert.throws(() => createHiveMemServer({ jwtSecret: secret, metricsToken: 'short' }), /at least 32/);
});

test('revoking a token also revokes tokens refreshed from it', async () => {
  await withServer({ jwtSecret: secret, store: new InMemoryHiveMemStore() }, async (base) => {
    const parent = signToken(secret, { sub: 'alpha', role: 'agent', scope: 'memories:read', exp: exp() });
    const refresh = async (token: string): Promise<string> => {
      const response = await fetch(base + '/v1/auth/refresh', { method: 'POST', headers: { authorization: `Bearer ${token}` } });
      assert.equal(response.status, 200);
      return (await response.json() as { token: string }).token;
    };
    const child = await refresh(parent);
    const grandchild = await refresh(child);
    const health = (token: string) => fetch(base + '/v1/memories/browse', { headers: { authorization: `Bearer ${token}` } });
    assert.equal((await health(grandchild)).status, 200);
    const revoked = await fetch(base + '/v1/auth/revoke', {
      method: 'POST',
      headers: { authorization: `Bearer ${parent}`, 'content-type': 'application/json' },
      body: JSON.stringify({ token: parent }),
    });
    assert.equal(revoked.status, 200);
    assert.equal((await health(child)).status, 401);
    assert.equal((await health(grandchild)).status, 401);
  });
});
