import assert from 'node:assert/strict';
import test from 'node:test';
import { randomBytes } from 'node:crypto';
import { InMemoryHiveMemStore } from '../src/store.js';
import { createHiveMemServer } from '../src/server.js';
import { signToken } from '../src/auth.js';
import type { HiveMemSnapshot } from '../src/persistence.js';
import type { AuthPrincipal } from '../src/types.js';

const admin: AuthPrincipal = { agentId: 'operation-fixture', scopes: ['*'], rawClaims: { role: 'admin' } };
async function serve(store: InMemoryHiveMemStore) {
  const secret = randomBytes(32).toString('hex');
  const token = signToken(secret, { sub: admin.agentId, scope: '*', role: 'admin', exp: Math.floor(Date.now() / 1000) + 600 });
  const server = createHiveMemServer({ jwtSecret: secret, store });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const request = (method: string, path: string, body?: unknown) => fetch(`http://127.0.0.1:${address.port}${path}`, {
    method, headers: { authorization: 'Bearer ' + token, cookie: 'hivemem_dash=' + token, 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { request, close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
}

test('all no-content DELETE routes wait for persistence and report its failure', async (t) => {
  for (const kind of ['memory', 'session', 'workspace', 'conclusion', 'card'] as const) for (const failure of [false, true]) {
    await t.test(kind + (failure ? ' failure' : ' durable success'), async () => {
      let fail = false; let saved: HiveMemSnapshot = new InMemoryHiveMemStore().snapshot();
      const store = new InMemoryHiveMemStore({ persistence: { kind: 'qdrant', load: async () => saved, save: async (snapshot) => { if (fail) throw new Error('Injected unavailable persistence'); saved = structuredClone(snapshot); } } });
      let path: string; let isDeleted: (snapshot: HiveMemSnapshot) => boolean;
      if (kind === 'memory') {
        const memory = store.createMemory(admin, { content: 'Deletion fixture', type: 'semantic', scope: 'private' });
        path = '/v1/memories/' + memory.id; isDeleted = (snapshot) => Boolean(snapshot.memories.find((item) => item.id === memory.id)?.deleted_at);
      } else if (kind === 'session') {
        store.createSession(admin, { session_id: 'deletion', workspace_id: 'default' }); path = '/v1/sessions/deletion';
        isDeleted = (snapshot) => Boolean(snapshot.sessions.find((item) => item.session_id === 'deletion')?.deleted_at);
      } else if (kind === 'workspace') {
        store.createWorkspace(admin, { workspace_id: 'deletion', title: 'Deletion fixture' }); path = '/v1/workspaces/deletion';
        isDeleted = (snapshot) => Boolean(snapshot.workspaces.find((item) => item.workspace_id === 'deletion')?.deleted_at);
      } else {
        const conclusion = kind === 'card' ? store.upsertPeerCard(admin, 'peer', { content: 'Card fixture' }) : store.createConclusion(admin, 'peer', { content: 'Conclusion fixture' });
        path = kind === 'card' ? '/v1/peers/peer/card/' + conclusion.id : '/v1/conclusions/' + conclusion.id;
        isDeleted = (snapshot) => Boolean(snapshot.conclusions.find((item) => item.id === conclusion.id)?.deleted_at);
      }
      await store.flushPersistence(); assert.equal(isDeleted(saved), false);
      const server = await serve(store);
      try {
        fail = failure;
        const response = await server.request('DELETE', path);
        assert.equal(response.status, failure ? 503 : 204);
        assert.equal(isDeleted(saved), !failure);
        if (!failure) {
          assert.equal(await response.text(), '');
          assert.ok(saved.operations?.some((entry) => entry.kind === 'api.mutation' && entry.path === path && entry.status === 204));
        } else {
          fail = false; store.retryPersistence(); await store.flushPersistence();
          assert.equal(isDeleted(saved), true, 'An indeterminate failure must be recoverable');
        }
      } finally { await server.close(); }
    });
  }
});

test('every advertised unavailable route returns 501 without changing complete state', async () => {
  const store = new InMemoryHiveMemStore();
  store.createWorkspace(admin, { workspace_id: 'fixture', title: 'Fixture' });
  const server = await serve(store);
  try {
    const response = await server.request('GET', '/v1/capabilities/operations'); assert.equal(response.status, 200);
    const { operations } = await response.json() as { operations: Array<{ id: string; state: string; routes: string[] }> };
    const unavailable = operations.filter((entry) => entry.state === 'unavailable'); assert.equal(unavailable.length, 7);
    for (const operation of unavailable) for (const route of operation.routes) {
      const [method, template] = route.split(' '); const path = template!.replace(':id', 'fixture');
      const before = structuredClone(store.snapshot());
      const result = await server.request(method!, path, method === 'GET' ? undefined : {});
      assert.equal(result.status, 501, route); assert.match((await result.json() as { detail: string }).detail, /unavailable/);
      assert.deepEqual(store.snapshot(), before, route + ' must be inert');
    }
  } finally { await server.close(); }
});

test('queue controls reject impossible transitions and runbooks target real permitted APIs', async () => {
  const store = new InMemoryHiveMemStore();
  store.createMemory(admin, { content: "Shell quote ' $(untrusted) fixture", type: 'semantic', scope: 'shared' });
  const job = store.snapshot().queueJobs[0]!; const server = await serve(store);
  try {
    const runbook = await (await server.request('GET', '/dashboard/api/queue/jobs/' + job.id + '/runbook')).json() as { actions: string[]; curl: string };
    assert.ok(runbook.actions.includes('run')); assert.ok(!runbook.actions.includes('retry'));
    assert.ok(runbook.curl.includes('/v1/queue/jobs/' + job.id + '/run')); assert.ok(!runbook.curl.includes('untrusted'));
    assert.equal((await server.request('POST', '/v1/queue/jobs/' + job.id + '/retry')).status, 409);
    assert.equal((await server.request('POST', '/v1/queue/jobs/' + job.id + '/run')).status, 200);
    const before = structuredClone(store.snapshot());
    assert.equal((await server.request('POST', '/v1/queue/jobs/' + job.id + '/retry')).status, 409);
    assert.equal((await server.request('DELETE', '/v1/queue/jobs/' + job.id)).status, 409);
    assert.deepEqual(store.snapshot(), before);
    const finished = await (await server.request('GET', '/dashboard/api/queue/jobs/' + job.id + '/runbook')).json() as { actions: string[]; curl: string };
    assert.deepEqual(finished.actions, ['inspect', 'copy_curl']); assert.ok(finished.curl.includes('--request GET'));
  } finally { await server.close(); }
});

test('memory detail reports real relationships and jobs without guessing stored embedding identity', () => {
  const store = new InMemoryHiveMemStore();
  const owner: AuthPrincipal = { agentId: 'owner', scopes: ['*'], rawClaims: {} };
  const hidden = store.createMemory({ ...owner, agentId: 'other' }, { content: 'hidden detail sentinel', type: 'semantic', scope: 'private' });
  const visible = store.createMemory(owner, { content: 'visible detail fixture', type: 'semantic', scope: 'private' });
  const source = store.createMemory(owner, { content: 'related detail fixture', type: 'semantic', scope: 'private', relationships: [hidden, visible].map((target) => ({ target_id: target.id, type: 'supports', confidence: 1, metadata: {} })) });
  store.consolidateMemories(owner, { memory_ids: [source.id] });
  const detail = store.describeMemory(owner, source.id);
  assert.equal(detail.collection, 'owner_private_semantic');
  assert.deepEqual((detail.related_memories as Array<{ id: string }>).map((memory) => memory.id), [visible.id]);
  assert.ok((detail.queue_jobs as unknown[]).length > 0);
  assert.equal(detail.audit_status, 'requires_admin');
  assert.equal((detail.provenance as { embedding: { model: unknown } }).embedding.model, null);
  assert.ok(!JSON.stringify(detail.related_memories).includes('hidden detail sentinel'));
});
