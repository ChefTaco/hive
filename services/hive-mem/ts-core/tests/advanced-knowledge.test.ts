import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import type { AddressInfo } from 'node:net';
import test from 'node:test';
import { ConflictError, InMemoryHiveMemStore } from '../src/store.js';
import { createHiveMemServer, signToken } from '../src/index.js';
import type { AuthPrincipal, KnowledgeSourceSyncResponse } from '../src/types.js';

const admin: AuthPrincipal = { agentId: 'team-alpha', scopes: ['*'], rawClaims: { role: 'admin' } };
const sha = (value: string) => createHash('sha256').update(value).digest('hex');

test('advanced retrieval respects historical validity, graph bounds, citations, and context budgets', () => {
  const sourceStore = new InMemoryHiveMemStore();
  sourceStore.createWorkspace(admin, { workspace_id: 'knowledge', title: 'Knowledge' });
  const old = sourceStore.createMemory(admin, { content: 'alpha router release', type: 'semantic', scope: 'shared', workspace_id: 'knowledge', metadata: { source_ref: 'repo://guide', revision: 'one', entities: [{ entity_id: 'service:router', name: 'Router', type: 'service' }] } });
  const related = sourceStore.createMemory(admin, { content: 'rollback requires the previous manifest', type: 'procedural', scope: 'shared', workspace_id: 'knowledge', relationships: [{ target_id: old.id, type: 'supports', confidence: 1 }] });
  const secondHop = sourceStore.createMemory(admin, { content: 'second hop must stay bounded', type: 'procedural', scope: 'shared', workspace_id: 'knowledge', relationships: [{ target_id: related.id, type: 'supports', confidence: 1 }] });
  const replacement = sourceStore.createMemory(admin, { content: 'alpha router release two', type: 'semantic', scope: 'shared', workspace_id: 'knowledge', supersedes: old.id, metadata: { source_ref: 'repo://guide', revision: 'two', entities: [{ entity_id: 'service:router', name: 'Router', type: 'service' }] } });
  sourceStore.updateMemory(admin, related.id, { relationships: [{ target_id: replacement.id, type: 'supports', confidence: 1 }] });
  const snapshot = sourceStore.snapshot();
  Object.assign(snapshot.memories.find((memory) => memory.id === old.id)!, { created_at: '2026-01-01T00:00:00.000Z', updated_at: '2026-02-01T00:00:00.000Z', superseded_at: '2026-02-01T00:00:00.000Z' });
  Object.assign(snapshot.memories.find((memory) => memory.id === replacement.id)!, { created_at: '2026-02-01T00:00:00.000Z', updated_at: '2026-02-01T00:00:00.000Z' });
  const store = new InMemoryHiveMemStore({ snapshot });

  const historical = store.search(admin, { query: 'alpha router', workspace_id: 'knowledge', as_of: '2026-01-15T00:00:00Z' }, false);
  assert.equal(historical.results[0]?.memory.id, old.id);
  assert.equal(historical.results[0]?.citation?.freshness, 'historical');
  const current = store.search(admin, { query: 'alpha router', workspace_id: 'knowledge' }, false);
  assert.equal(current.results.some((result) => result.memory.id === old.id), false);
  assert.equal(current.results[0]?.memory.id, replacement.id);

  const graph = store.search(admin, { query: 'alpha router', workspace_id: 'knowledge', graph: { enabled: true, max_hops: 1, max_expansions: 12 }, diversity: { enabled: true, lambda: 0.8 } }, false);
  const expanded = graph.results.find((result) => result.memory.id === related.id);
  assert.equal(expanded?.selection_reason, 'relationship');
  assert.deepEqual(expanded?.citation?.relationship_path, [replacement.id, 'reverse:supports', related.id]);
  assert.equal(graph.results.some((result) => result.memory.id === secondHop.id), false);
  assert.deepEqual(store.search(admin, { query: 'alpha router', workspace_id: 'knowledge', graph: { enabled: true, max_hops: 1, max_expansions: 12 }, diversity: { enabled: true, lambda: 0.8 } }, false).results.map((result) => result.memory.id), graph.results.map((result) => result.memory.id));
  for (const result of graph.results) assert.equal(store.getMemory(admin, result.citation!.memory_id).id, result.memory.id);
  store.createMemory(admin, { content: 'alpha router expired record', type: 'semantic', scope: 'shared', workspace_id: 'knowledge', expires_at: '2020-01-01T00:00:00Z' });
  assert.equal(store.search(admin, { query: 'expired record', workspace_id: 'knowledge' }, false).results.length, 0);
  const context = store.context(admin, { search_query: 'alpha router', workspace_id: 'knowledge', max_memories: 8, token_budget: 80 });
  assert.ok(context.formatted_context.content.includes(`[memory:${replacement.id}]`));
  assert.ok(context.metadata.tokens_used <= 80);
  assert.equal(context.metadata.retrieval_mode, 'lexical_graph_rrf_v1');
});

test('source synchronization previews safely, is idempotent, supersedes changes, and retires removals', () => {
  const store = new InMemoryHiveMemStore();
  store.createWorkspace(admin, { workspace_id: 'hermes:team:main', title: 'Team knowledge' });
  const base = {
    workspace_id: 'hermes:team:main', project_id: 'knowledge-fixture', source_id: 'repo:fixture/docs',
    source_uri: 'repo://fixture/docs', revision: 'one', observed_at: '2026-09-20T00:00:00Z',
    chunks: [
      { chunk_key: 'README.md#one-1:1', content: 'first knowledge chunk', content_hash: sha('first knowledge chunk'), tags: ['docs'], entities: [] },
      { chunk_key: 'README.md#two-2:1', content: 'second knowledge chunk', content_hash: sha('second knowledge chunk'), tags: ['docs'], entities: [] },
    ],
  };
  const before = structuredClone(store.snapshot());
  assert.equal(store.syncKnowledgeSource(admin, { ...base, mode: 'preview' }).created, 2);
  assert.deepEqual(store.snapshot(), before);
  assert.throws(() => store.syncKnowledgeSource(admin, { ...base, mode: 'apply', chunks: [...base.chunks, { chunk_key: 'README.md#bad-3:1', content: 'bad hash', content_hash: '0'.repeat(64) }] }), /content_hash/);
  assert.deepEqual(store.snapshot(), before, 'whole request must be validated before the first write');
  const applied = store.syncKnowledgeSource(admin, { ...base, mode: 'apply' });
  assert.equal(applied.created_ids.length, 2);
  assert.deepEqual(store.syncKnowledgeSource(admin, { ...base, mode: 'apply' }), { ...applied, created: 0, superseded: 0, retired: 0, unchanged: 2, created_ids: [], superseded_ids: [], retired_ids: [] });

  const changed = store.syncKnowledgeSource(admin, { ...base, mode: 'apply', revision: 'two', observed_at: '2026-09-21T00:00:00Z', chunks: [
    { chunk_key: 'README.md#one-1:1', content: 'first corrected knowledge chunk', content_hash: sha('first corrected knowledge chunk'), tags: ['docs'], entities: [] },
  ] });
  assert.equal(changed.superseded, 1); assert.equal(changed.retired, 1);
  const active = store.search(admin, { query: 'knowledge chunk', workspace_id: 'hermes:team:main', filters: { project_id: 'knowledge-fixture', source_id: 'repo:fixture/docs' } }, false);
  assert.deepEqual(active.results.map((result) => result.memory.content), ['first corrected knowledge chunk']);
  assert.deepEqual(new InMemoryHiveMemStore({ snapshot: store.snapshot() }).search(admin, { query: 'corrected knowledge', workspace_id: 'hermes:team:main' }, false).results.map((result) => result.memory.content), ['first corrected knowledge chunk']);
  const retired = store.snapshot().memories.find((memory) => memory.id === changed.retired_ids[0]);
  assert.equal(retired?.valid_to, '2026-09-21T00:00:00.000Z');
  const other: AuthPrincipal = { agentId: 'team-beta', scopes: ['*'], rawClaims: { role: 'admin' } };
  assert.throws(() => store.syncKnowledgeSource(other, { ...base, mode: 'apply', revision: 'three' }), ConflictError);
  const emptied = store.syncKnowledgeSource(admin, { ...base, mode: 'apply', revision: 'three', observed_at: new Date().toISOString(), chunks: [] });
  assert.equal(emptied.retired, 1);
  assert.equal(store.search(admin, { query: 'knowledge chunk', workspace_id: 'hermes:team:main' }, false).results.length, 0);
});

test('held-out lexical recall has no private leakage and stays within the 10k-record latency gate', () => {
  const store = new InMemoryHiveMemStore();
  store.createWorkspace(admin, { workspace_id: 'benchmark', title: 'Benchmark' });
  for (let index = 0; index < 10_000; index += 1) store.createMemory(admin, { content: `background corpus item ${index}`, type: 'semantic', scope: 'shared', workspace_id: 'benchmark' });
  const expected = new Map<string, string>();
  for (let index = 0; index < 20; index += 1) {
    const token = `heldouttoken${index}`;
    expected.set(token, store.createMemory(admin, { content: `verified ${token} project fact`, type: 'semantic', scope: 'shared', workspace_id: 'benchmark' }).id);
  }
  let recalled = 0;
  const durations: number[] = [];
  for (const [token, id] of expected) {
    const start = performance.now();
    if (store.search(admin, { query: token, workspace_id: 'benchmark', limit: 8 }, false).results.some((result) => result.memory.id === id)) recalled += 1;
    durations.push(performance.now() - start);
  }
  durations.sort((left, right) => left - right);
  const p95 = durations[Math.ceil(durations.length * 0.95) - 1]!;
  assert.ok(recalled / expected.size >= 0.85);
  assert.ok(p95 < 500, `p95 retrieval latency ${p95.toFixed(1)}ms exceeded 500ms`);

  const owner: AuthPrincipal = { agentId: 'private-owner', scopes: ['memories:read', 'memories:write'], rawClaims: {} };
  const reader: AuthPrincipal = { agentId: 'private-reader', scopes: ['memories:read'], rawClaims: {} };
  store.createMemory(owner, { content: 'private sentinel never leak', type: 'semantic', scope: 'private', workspace_id: 'default' });
  assert.equal(store.search(reader, { query: 'private sentinel', workspace_id: 'default' }, false).results.length, 0);
});

test('high-overlap retrieval bounds selection work to the requested page', () => {
  const store = new InMemoryHiveMemStore();
  store.createWorkspace(admin, { workspace_id: 'overlap', title: 'Overlap' });
  for (let index = 0; index < 750; index += 1) {
    store.createMemory(admin, { content: `hermes hivemem common marker fixture ${index}`, type: 'episodic', scope: 'private', workspace_id: 'overlap' });
  }

  const start = performance.now();
  const plain = store.search(admin, { query: 'hermes hivemem common marker', workspace_id: 'overlap', scope: 'private', limit: 8 }, false);
  const plainDuration = performance.now() - start;
  assert.equal(plain.results.length, 8);
  assert.ok(plainDuration < 500, `non-MMR overlap search took ${plainDuration.toFixed(1)}ms`);

  const diverseStart = performance.now();
  const diverse = store.search(admin, { query: 'hermes hivemem common marker', workspace_id: 'overlap', scope: 'private', limit: 8, diversity: { enabled: true, lambda: 0.8 } }, false);
  const diverseDuration = performance.now() - diverseStart;
  assert.equal(diverse.results.length, 8);
  assert.ok(diverseDuration < 500, `MMR overlap search took ${diverseDuration.toFixed(1)}ms`);
  assert.deepEqual(store.search(admin, { query: 'hermes hivemem common marker', workspace_id: 'overlap', scope: 'private', limit: 8, diversity: { enabled: true, lambda: 0.8 } }, false).results.map((result) => result.memory.id), diverse.results.map((result) => result.memory.id));
});

test('knowledge source synchronization is exposed through the existing authenticated HTTP service', async () => {
  const secret = 'advanced_knowledge_test_secret_32_bytes';
  const store = new InMemoryHiveMemStore();
  store.createWorkspace(admin, { workspace_id: 'hermes:team:main', title: 'Team knowledge' });
  const server = createHiveMemServer({ jwtSecret: secret, store });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const address = server.address() as AddressInfo;
    const token = signToken(secret, { sub: 'team-alpha', scope: 'memories:read memories:write workspaces:read', workspace_ids: ['hermes:team:main'], exp: Math.floor(Date.now() / 1000) + 3600 });
    const content = 'HTTP synchronized source';
    const response = await fetch(`http://127.0.0.1:${address.port}/v1/knowledge/sources/sync`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ mode: 'preview', workspace_id: 'hermes:team:main', project_id: 'http-fixture', source_id: 'repo:http', source_uri: 'repo://http', revision: 'one', observed_at: '2026-09-21T00:00:00Z', chunks: [{ chunk_key: 'README.md#one', content, content_hash: sha(content) }] }),
    });
    assert.equal(response.status, 200);
    assert.equal(((await response.json()) as KnowledgeSourceSyncResponse).created, 1);
    assert.equal(store.snapshot().memories.length, 0);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});
