import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import test from 'node:test';
import { createHiveMemServer } from '../src/server.js';
import { InMemoryHiveMemStore } from '../src/store.js';
import { signToken } from '../src/auth.js';
import type { AuthPrincipal } from '../src/types.js';

const admin: AuthPrincipal = { agentId: 'operator', scopes: ['*'], rawClaims: { role: 'admin' } };

test('forget preview is inert and apply is idempotent', () => {
  const store = new InMemoryHiveMemStore();
  store.createMemory(admin, { content: 'forget fixture', scope: 'private', type: 'semantic' });
  const before = structuredClone(store.snapshot());
  assert.equal(store.forgetSubject(admin, { subject: 'fixture', dry_run: true }).matched, 1);
  assert.deepEqual(store.snapshot(), before);
  assert.equal(store.forgetSubject(admin, { subject: 'fixture', dry_run: false }).deleted, 1);
  assert.equal(store.forgetSubject(admin, { subject: 'fixture', dry_run: false }).deleted, 0);
});

test('disabled and rotated credentials remain contained across hydration and re-enable', async () => {
  const secret = randomBytes(32).toString('hex');
  const store = new InMemoryHiveMemStore();
  store.registerAgent(admin, { agent_id: 'fixture', display_name: 'Fixture' }, 'unused');
  const token = signToken(secret, { sub: 'fixture', scope: '*', exp: Math.floor(Date.now() / 1000) + 300 });
  store.updateAgent(admin, 'fixture', { active: false });
  const restored = new InMemoryHiveMemStore({ snapshot: store.snapshot() });
  const server = createHiveMemServer({ store: restored, jwtSecret: secret });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  try {
    const base = `http://127.0.0.1:${address.port}`;
    const request = () => fetch(base + '/v1/memories', { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ content: 'must not write', scope: 'private', type: 'semantic' }) });
    assert.equal((await request()).status, 403);
    assert.equal((await fetch(base + '/v1/auth/refresh', { method: 'POST', headers: { authorization: `Bearer ${token}` } })).status, 403);
    assert.equal((await fetch(base + '/dashboard/api/webhooks', { headers: { cookie: 'hivemem_dash=' + token } })).status, 403);
    assert.equal((await fetch(base + '/dashboard/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token }) })).status, 403);
    const otherToken = signToken(secret, { sub: 'unrelated', scope: '*', exp: Math.floor(Date.now() / 1000) + 300 });
    assert.equal((await fetch(base + '/v1/auth/me', { headers: { authorization: `Bearer ${otherToken}` } })).status, 200);
    restored.updateAgent(admin, 'fixture', { active: true });
    assert.equal((await request()).status, 403);
    assert.equal(restored.snapshot().memories.length, 0);
    const generation = restored.rotateAgentCredentials(admin, 'fixture');
    assert.throws(() => restored.assertCredentialActive({ agentId: 'fixture', scopes: ['*'], rawClaims: { token_generation: generation - 1 } }), /rotated/);
    restored.assertCredentialActive({ agentId: 'fixture', scopes: ['*'], rawClaims: { token_generation: generation } });
    const currentToken = signToken(secret, { sub: 'fixture', scope: 'memories:read', workspace_ids: ['default'], token_generation: generation, exp: Math.floor(Date.now() / 1000) + 300 });
    const refreshed = await fetch(base + '/v1/auth/refresh', { method: 'POST', headers: { authorization: `Bearer ${currentToken}` } });
    assert.equal(refreshed.status, 200);
    const freshBody = await refreshed.json() as { token: string };
    const claims = JSON.parse(Buffer.from(freshBody.token.split('.')[1]!, 'base64url').toString());
    assert.equal(claims.token_generation, generation); assert.deepEqual(claims.workspace_ids, ['default']);
  } finally { await new Promise<void>((resolve) => server.close(() => resolve())); }
});

test('persistence failure fails writes and readiness while liveness survives; retry recovers', async () => {
  let fail = true;
  const store = new InMemoryHiveMemStore({ persistence: { kind: 'qdrant', load: async () => new InMemoryHiveMemStore().snapshot(), save: async () => { if (fail) throw new Error('unavailable'); } } });
  store.configureWorker(true);
  const secret = randomBytes(32).toString('hex');
  const token = signToken(secret, { sub: 'fixture', scope: '*', exp: Math.floor(Date.now() / 1000) + 300 });
  const server = createHiveMemServer({ store, jwtSecret: secret });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}`;
  try {
    const result = await fetch(base + '/v1/memories', { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ content: 'durability fixture', scope: 'private', type: 'semantic' }) });
    assert.equal(result.status, 503);
    await assert.rejects(store.workerTick(), /indeterminate/);
    assert.equal(store.workerHealth().state, 'degraded');
    assert.equal(store.workerHealth().ready, false);
    assert.equal((await fetch(base + '/v1/health/ready')).status, 503);
    assert.equal((await fetch(base + '/v1/health/live')).status, 200);
    fail = false;
    store.retryPersistence();
    await store.flushPersistence();
    await store.workerTick();
    assert.equal(store.workerHealth().state, 'idle');
    assert.equal(store.workerHealth().error, null);
    assert.equal((await fetch(base + '/v1/health/ready')).status, 200);
  } finally { await new Promise<void>((resolve) => server.close(() => resolve())); }
});

test('exclusive-writer recovery requeues only interrupted claims and reports honest worker state', async (t) => {
  const source = new InMemoryHiveMemStore();
  source.createMemory(admin, { content: 'worker recovery fixture', type: 'semantic', scope: 'private' });
  const snapshot = source.snapshot();
  const pending = snapshot.queueJobs[0]!;
  snapshot.queueJobs = [
    { ...pending, status: 'in_progress', locked_at: new Date().toISOString() },
    { ...pending, id: 'cancelled-fixture', status: 'cancelled' },
    { ...pending, id: 'completed-fixture', status: 'completed' },
    { ...pending, id: 'dead-fixture', status: 'dead_letter' },
  ];
  let saved = snapshot;
  const store = new InMemoryHiveMemStore({ snapshot, persistence: { kind: 'qdrant', load: async () => saved, save: async (value) => { saved = structuredClone(value); } } });
  assert.equal(store.workerHealth().state, 'manual');
  store.configureWorker(false);
  assert.equal(store.workerHealth().state, 'disabled');
  assert.equal(store.recoverInterruptedJobs(), 1);
  await store.flushPersistence();
  assert.deepEqual(saved.queueJobs.map((job) => job.status), ['pending', 'cancelled', 'completed', 'dead_letter']);
  assert.equal(saved.queueJobs[0]!.locked_at, null);
  assert.equal(store.workerHealth().recovered_on_startup, 1);
  store.configureWorker(true);
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  t.mock.timers.tick(60_001);
  assert.equal(store.workerHealth().state, 'stale');
  assert.equal(store.workerHealth().ready, false);
  await store.workerTick();
  assert.equal(store.workerHealth().ready, true);
  assert.equal(store.workerHealth().state, 'idle');
  assert.ok(store.workerHealth().last_success);
});

test('forget invalidates transitive derived content across restart and browse', () => {
  const store = new InMemoryHiveMemStore();
  const source = store.createMemory(admin, { content: 'subject fixture', type: 'semantic', scope: 'private' });
  const derived = store.createMemory(admin, { content: 'derived private fact', type: 'semantic', scope: 'private', metadata: { source_memory_ids: [source.id] } });
  store.createMemory(admin, { content: 'second level fact', type: 'semantic', scope: 'private', metadata: { source_memory_ids: [derived.id] } });
  store.forgetSubject(admin, { subject: 'subject fixture', dry_run: false });
  const restored = new InMemoryHiveMemStore({ snapshot: store.snapshot() });
  assert.equal(restored.browse(admin, new URLSearchParams()).total, 0);
  assert.equal(restored.search(admin, { query: 'fact' }, false).results.length, 0);
});

test('every lifecycle withdrawal contains source content across all current-data surfaces and restart', async (t) => {
  for (const withdrawal of ['expired', 'superseded', 'forgotten', 'purged'] as const) {
    await t.test(withdrawal, () => {
      const store = new InMemoryHiveMemStore();
      const workspace = `containment-${withdrawal}`;
      store.createWorkspace(admin, { workspace_id: workspace, title: workspace });
      const sentinel = `withdrawn-${withdrawal}-sentinel`;
      const source = store.createMemory(admin, {
        content: sentinel,
        type: 'semantic',
        scope: 'private',
        workspace_id: workspace,
        metadata: { entities: [{ id: `entity-${withdrawal}`, name: sentinel }] },
        ...(withdrawal === 'expired' ? { expires_at: new Date(Date.now() + 60_000).toISOString() } : {}),
      });
      store.createMemory(admin, {
        content: `derived ${sentinel}`,
        type: 'semantic',
        scope: 'private',
        workspace_id: workspace,
        metadata: { source_memory_ids: [source.id] },
      });
      store.createMemory(admin, {
        content: 'independent graph fixture',
        type: 'semantic',
        scope: 'private',
        workspace_id: workspace,
        relationships: [{ target_id: source.id, type: 'supports', confidence: 1 }],
      });
      store.createConclusion(admin, admin.agentId, {
        content: `conclusion ${sentinel}`,
        kind: 'deductive',
        workspace_id: workspace,
        source_memory_ids: [source.id],
      });
      store.createConclusion(admin, admin.agentId, {
        content: `card ${sentinel}`,
        kind: 'peer_card',
        workspace_id: workspace,
        source_memory_ids: [source.id],
      });

      if (withdrawal === 'expired') {
        const snapshot = store.snapshot();
        const record = snapshot.memories.find((memory) => memory.id === source.id)!;
        record.expires_at = new Date(Date.now() - 1).toISOString();
        assertContained(new InMemoryHiveMemStore({ snapshot }), workspace, sentinel, source.id);
        return;
      }
      if (withdrawal === 'superseded') {
        store.createMemory(admin, { content: 'current replacement', type: 'semantic', scope: 'private', workspace_id: workspace, supersedes: source.id });
      } else if (withdrawal === 'forgotten') {
        assert.ok(Number(store.forgetSubject(admin, { subject: sentinel, workspace_id: workspace, dry_run: false }).deleted) >= 1);
      } else {
        store.deleteMemory(admin, source.id);
        const preview = structuredClone(store.snapshot());
        assert.ok(Number(store.purgeMemories(admin, { workspace_id: workspace, dry_run: true }).matched) >= 1);
        assert.deepEqual(store.snapshot(), preview);
        assert.ok(Number(store.purgeMemories(admin, { workspace_id: workspace, dry_run: false }).purged) >= 1);
        assert.ok(!store.snapshot().memories.some((memory) => memory.id === source.id));
      }
      assertContained(store, workspace, sentinel, source.id);
    });
  }
});

function assertContained(store: InMemoryHiveMemStore, workspace: string, sentinel: string, sourceId: string): void {
  const params = new URLSearchParams({ workspace_id: workspace });
  const context = store.context(admin, { search_query: sentinel, workspace_id: workspace });
  assert.equal(context.memories.length, 0);
  assert.ok(!context.summary.content.includes(sentinel));
  const surfaces = {
    browse: store.browse(admin, params),
    search: store.search(admin, { query: sentinel, workspace_id: workspace }, false),
    graph: store.graphNeighborhood(admin, params),
    entities: store.listGraphEntities(admin, params),
    relations: store.listGraphRelations(admin, params),
    conclusions: store.listPeerConclusions(admin, admin.agentId, params),
    cards: store.getPeerCard(admin, admin.agentId, params),
    export: store.exportWorkspace(admin, workspace),
  };
  for (const [name, value] of Object.entries(surfaces)) assert.ok(!JSON.stringify(value).includes(sentinel), `${sentinel} resurfaced through ${name} before restart`);
  assert.ok(!JSON.stringify(surfaces.relations).includes(sourceId), 'withdrawn target retained a graph edge');
  const restarted = new InMemoryHiveMemStore({ snapshot: structuredClone(store.snapshot()) });
  const restartedContext = restarted.context(admin, { search_query: sentinel, workspace_id: workspace });
  assert.equal(restartedContext.memories.length, 0);
  assert.ok(!restartedContext.summary.content.includes(sentinel));
  const restartedRendered = JSON.stringify({
    browse: restarted.browse(admin, params),
    search: restarted.search(admin, { query: sentinel, workspace_id: workspace }, false),
    graph: restarted.graphNeighborhood(admin, params),
    entities: restarted.listGraphEntities(admin, params),
    relations: restarted.listGraphRelations(admin, params),
    conclusions: restarted.listPeerConclusions(admin, admin.agentId, params),
    cards: restarted.getPeerCard(admin, admin.agentId, params),
    export: restarted.exportWorkspace(admin, workspace),
  });
  assert.ok(!restartedRendered.includes(sentinel), `${sentinel} resurfaced after restart`);
}

test('many synchronous mutations coalesce into one durable checkpoint', async () => {
  let writes = 0; let memories = 0;
  const store = new InMemoryHiveMemStore({ persistence: { kind: 'qdrant', load: async () => new InMemoryHiveMemStore().snapshot(), save: async (snapshot) => { writes++; memories = snapshot.memories.length; } } });
  for (let n = 0; n < 1000; n++) store.createMemory(admin, { content: 'corpus fixture ' + n, type: 'semantic', scope: 'private' });
  await store.flushPersistence();
  assert.equal(writes, 1); assert.equal(memories, 1000);
});

test('workspace prune defaults to preview and applies only explicitly', () => {
  const store = new InMemoryHiveMemStore();
  store.createWorkspace(admin, { workspace_id: 'retention-fixture', title: 'Retention fixture' });
  store.createMemory(admin, { content: 'expired fixture', type: 'semantic', scope: 'private', workspace_id: 'retention-fixture', expires_at: new Date(Date.now() - 1000).toISOString() });
  const before = structuredClone(store.snapshot());
  assert.equal(store.pruneWorkspace(admin, 'retention-fixture').dry_run, true);
  assert.deepEqual(store.snapshot(), before);
  assert.equal(store.pruneWorkspace(admin, 'retention-fixture', false).archived, 1);
});

test('conflicts persist decisions and hide unreadable sources from resolution, graph and audit', async () => {
  const alice: AuthPrincipal = { agentId: 'alice', scopes: ['*'], rawClaims: {} };
  const resolvingOperator: AuthPrincipal = { ...admin, agentId: 'alice' };
  const bob: AuthPrincipal = { agentId: 'bob', scopes: ['*'], rawClaims: {} };
  const store = new InMemoryHiveMemStore();
  const secret = store.createMemory(bob, { content: 'private-source-sentinel', type: 'semantic', scope: 'private' });
  const visible = store.createMemory(alice, { content: 'public-source-sentinel', type: 'semantic', scope: 'shared', relationships: [{ target_id: secret.id, type: 'contradicts', confidence: 1, metadata: { evidence: 'private-edge-sentinel' } }] });
  await store.runNextQueueJob(admin, new URLSearchParams());
  assert.equal(store.dashboardConflicts(alice, new URLSearchParams()).total, 0);
  const before = structuredClone(store.snapshot());
  assert.equal(store.resolveDashboardConflict(alice, visible.id, {}).resolved_count, 0);
  assert.deepEqual(store.snapshot(), before);
  const graph = JSON.stringify(store.graphNeighborhood(alice, new URLSearchParams({ memory_id: visible.id })));
  assert.ok(!graph.includes(secret.id)); assert.ok(!graph.includes('private-edge-sentinel'));
  assert.throws(() => store.adminAudit(alice, new URLSearchParams()), /Admin/);
  assert.equal(store.dashboardConflicts(admin, new URLSearchParams()).total, 1);
  assert.throws(() => store.resolveDashboardConflict(resolvingOperator, visible.id, { action: 'sensitive-free-text' }), /action/);
  assert.equal(store.resolveDashboardConflict(resolvingOperator, visible.id, { action: 'dismiss' }).resolved_count, 1);
  const restored = new InMemoryHiveMemStore({ snapshot: structuredClone(store.snapshot()) });
  assert.equal(restored.dashboardConflicts(admin, new URLSearchParams()).total, 0);
  assert.equal(restored.resolveDashboardConflict(resolvingOperator, visible.id, {}).resolved_count, 0);
  const conflict = restored.snapshot().operations?.find((entry) => entry.kind === 'conflict');
  assert.equal(conflict?.action, 'dismiss'); assert.equal(conflict?.resolved_by, resolvingOperator.agentId);
  const audit = JSON.stringify(restored.adminAudit(admin, new URLSearchParams()));
  assert.ok(audit.includes('conflict.resolve')); assert.ok(!audit.includes('sentinel'));
  const scopedAdmin = { ...admin, rawClaims: { role: 'admin', workspace_ids: ['elsewhere'] } };
  assert.equal(restored.adminAudit(scopedAdmin, new URLSearchParams()).total, 0);
});

test('issuance honors an absolute actor deadline and validates before rotating credentials', async () => {
  const secret = randomBytes(32).toString('hex'); const store = new InMemoryHiveMemStore();
  store.registerAgent(admin, { agent_id: 'deadline', display_name: 'Deadline' }, 'unused');
  const token = signToken(secret, { sub: admin.agentId, role: 'admin', scope: '*', exp: Math.floor(Date.now() / 1000) + 600 });
  const server = createHiveMemServer({ jwtSecret: secret, store });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  try {
    const issue = (body: unknown) => fetch(`http://127.0.0.1:${address.port}/v1/auth/tokens`, { method: 'POST', headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const request = { agent_id: 'deadline', scopes: ['memories:read'], workspace_ids: ['default'], rotate_previous: true };
    const before = store.credentialGeneration('deadline');
    assert.equal((await issue({ ...request, expires_at: new Date(Date.now() - 1000).toISOString() })).status, 422);
    assert.equal((await issue({ ...request, workspace_ids: ['*'] })).status, 422);
    assert.equal(store.credentialGeneration('deadline'), before);
    const expiresAt = new Date(Date.now() + 120_000).toISOString();
    const response = await issue({ ...request, expires_at: expiresAt, expires_hours: 24 });
    assert.equal(response.status, 201);
    const value = await response.json() as { expires_at: string; token: string };
    assert.ok(Date.parse(value.expires_at) <= Date.parse(expiresAt));
    const claims = JSON.parse(Buffer.from(value.token.split('.')[1]!, 'base64url').toString());
    assert.deepEqual(claims.workspace_ids, ['default']); assert.equal(claims.token_generation, before + 1);
  } finally { await new Promise<void>((resolve) => server.close(() => resolve())); }
});
