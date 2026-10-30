import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { InMemoryHiveMemStore, QdrantHiveMemPersistence, type AuthPrincipal, type JsonObject } from "../src/index.js";

interface StoredPoint {
  id: string;
  vector: number[];
  payload: JsonObject;
}

function principal(agentId = "agent-a", role?: string): AuthPrincipal {
  return { agentId, scopes: ["*"], rawClaims: role ? { role } : {} };
}

async function readJson(request: IncomingMessage): Promise<JsonObject> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  if (chunks.length === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as JsonObject;
}

function send(response: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  response.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(payload) });
  response.end(payload);
}

function pathParts(request: IncomingMessage): string[] {
  return (request.url ?? "/").split("?")[0]!.split("/").filter(Boolean).map(decodeURIComponent);
}

interface FakeQdrant {
  baseUrl: string;
  server: Server;
  collections: Set<string>;
  points: Map<string, Map<string, StoredPoint>>;
}

async function startFakeQdrant(): Promise<FakeQdrant> {
  const collections = new Set<string>();
  const points = new Map<string, Map<string, StoredPoint>>();
  const server = createServer(async (request, response) => {
    try {
      const parts = pathParts(request);
      if (request.method === "GET" && parts.length === 1 && parts[0] === "collections") {
        send(response, 200, { result: { collections: [...collections].sort().map((name) => ({ name })) } });
        return;
      }
      if (request.method === "PUT" && parts.length === 2 && parts[0] === "collections") {
        collections.add(parts[1]!);
        if (!points.has(parts[1]!)) points.set(parts[1]!, new Map());
        send(response, 200, { result: true, status: "ok" });
        return;
      }
      if (request.method === "POST" && parts[3] === "delete") {
        const body = await readJson(request);
        for (const id of body.points as string[]) points.get(parts[1]!)?.delete(id);
        send(response, 200, { result: true });
        return;
      }
      if (request.method === "PUT" && parts.length === 3 && parts[0] === "collections" && parts[2] === "points") {
        const collection = parts[1]!;
        collections.add(collection);
        const body = await readJson(request);
        const rawPoints = Array.isArray(body.points) ? body.points : [];
        const stored = points.get(collection) ?? new Map<string, StoredPoint>();
        for (const raw of rawPoints) {
          if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
          const point = raw as { id?: unknown; vector?: unknown; payload?: unknown };
          if (typeof point.id !== "string" || !Array.isArray(point.vector) || !point.payload || typeof point.payload !== "object" || Array.isArray(point.payload)) continue;
          stored.set(point.id, { id: point.id, vector: point.vector as number[], payload: point.payload as JsonObject });
        }
        points.set(collection, stored);
        send(response, 200, { result: { operation_id: 1, status: "completed" } });
        return;
      }
      if (request.method === "POST" && parts.length === 4 && parts[0] === "collections" && parts[2] === "points" && parts[3] === "scroll") {
        const collection = parts[1]!;
        const stored = [...(points.get(collection)?.values() ?? [])];
        send(response, 200, { result: { points: stored.map((point) => ({ id: point.id, payload: point.payload, vector: point.vector })), next_page_offset: null } });
        return;
      }
      send(response, 404, { status: "error", result: null });
    } catch (error) {
      send(response, 500, { status: "error", error: error instanceof Error ? error.message : String(error) });
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  return { baseUrl: "http://127.0.0.1:" + address.port, server, collections, points };
}

describe("Qdrant HiveMem persistence", () => {
  let fake: FakeQdrant;

  before(async () => {
    fake = await startFakeQdrant();
  });

  after(async () => {
    await new Promise<void>((resolve, reject) => fake.server.close((error) => (error ? reject(error) : resolve())));
  });

  it("loads cleanly from an empty Qdrant and round-trips store snapshots", async () => {
    const persistence = new QdrantHiveMemPersistence({ url: fake.baseUrl });
    const empty = await persistence.load();
    assert.equal(empty.memories.length, 0);
    assert.equal(empty.queueJobs.length, 0);

    const store = new InMemoryHiveMemStore({ persistence });
    const agent = principal();
    const memory = store.createMemory(agent, {
      content: "Qdrant persistence keeps TypeScript HiveMem durable.",
      type: "semantic",
      scope: "private",
      workspace_id: "default",
      tags: ["qdrant", "typescript"],
    });
    const shared = store.createMemory(agent, {
      content: "Shared Qdrant memory uses the Python-compatible collection.",
      type: "episodic",
      scope: "shared",
      workspace_id: "default",
    });
    const session = store.createSession(agent, { session_id: "qdrant-session", scope: "private", workspace_id: "default" });
    const webhook = store.createWebhook(agent, { url: "https://example.com/hivemem-ts", workspace_id: "default" });
    const episode = store.createEpisode(agent, { episode_id: "qdrant-episode", session_id: session.session_id, workspace_id: "default" });
    const message = store.appendEpisodeMessage(agent, episode.episode_id, { message_id: "qdrant-message", content: "Persist this message.", role: "user" });
    await store.flushPersistence();

    assert.equal(fake.collections.has("agent-a_private_semantic"), true);
    assert.equal(fake.collections.has("shared_episodic"), true);
    assert.equal(fake.collections.has("_agents"), true);
    assert.equal(fake.collections.has("_sessions"), true);
    assert.equal(fake.collections.has("_webhooks"), true);
    assert.equal(fake.collections.has("_episodes"), true);
    assert.equal(fake.collections.has("_queue"), true);
    assert.equal(fake.points.get("agent-a_private_semantic")?.size, 1);
    assert.equal(fake.points.get("shared_episodic")?.size, 1);
    const storedMemory = [...(fake.points.get("agent-a_private_semantic")?.values() ?? [])][0];
    assert.equal(storedMemory?.vector.length, 768);
    assert.equal(storedMemory?.payload.id, memory.id);

    const loaded = await persistence.load();
    const hydrated = new InMemoryHiveMemStore({ snapshot: loaded });
    assert.equal(hydrated.getMemory(agent, memory.id).content, memory.content);
    assert.equal(hydrated.getMemory(principal("agent-b"), shared.id).id, shared.id);
    assert.equal(hydrated.listSessions(agent, new URLSearchParams()).some((item) => item.session_id === session.session_id), true);
    assert.equal(hydrated.listWebhooks(agent, new URLSearchParams()).some((item) => item.id === webhook.id), true);
    assert.equal(hydrated.getEpisode(agent, episode.episode_id).messages.some((item) => item.id === message.id), true);
    assert.equal(hydrated.queueStatus(agent, new URLSearchParams("task_type=message_extract")).jobs.some((job) => job.id === message.memory_job_id), true);
  });

  it("writes conclusions with the legacy 768-dimensional Qdrant schema", async () => {
    const persistence = new QdrantHiveMemPersistence({ url: fake.baseUrl });
    const snapshot = await persistence.load();
    const timestamp = new Date().toISOString();
    snapshot.conclusions.push({
      id: 'legacy-conclusion', owner_agent_id: 'agent-a', observer_peer_id: 'agent-a',
      observed_peer_id: 'agent-a', session_id: null, workspace_id: 'default',
      source_memory_ids: [], content: 'Compatibility fixture', kind: 'manual',
      confidence: 1, metadata: {}, created_at: timestamp, updated_at: timestamp,
      supersedes: null, superseded_by: null, deleted_at: null,
    });
    await persistence.save(snapshot);
    const conclusion = [...(fake.points.get('_conclusions')?.values() ?? [])].find((point) => point.payload.id === 'legacy-conclusion');
    assert.equal(conclusion?.vector.length, 768);
  });

  it("normalizes legacy Qdrant memory payloads without ids", async () => {
    fake.collections.add("legacy-agent_private_episodic");
    fake.points.set("legacy-agent_private_episodic", new Map([
      ["legacy-point-1", {
        id: "legacy-point-1",
        vector: [1, ...Array<number>(767).fill(0)],
        payload: {
          agent_id: "legacy-agent",
          content: "Legacy memory payloads did not always include ids.",
          type: "episodic",
          scope: "private",
          source: "conversation",
          created_at: "2026-01-01T00:00:00.000Z",
          updated_at: "2026-01-01T00:00:00.000Z",
          tags: ["legacy"],
        },
      }],
      ["legacy-point-2", {
        id: "legacy-point-2",
        vector: [0, 1, ...Array<number>(766).fill(0)],
        payload: {
          agent_id: "legacy-agent",
          content: "A second legacy memory must not overwrite the first one.",
          type: "episodic",
          scope: "private",
          source: "conversation",
          created_at: "2026-01-02T00:00:00.000Z",
          updated_at: "2026-01-02T00:00:00.000Z",
          tags: ["legacy"],
        },
      }],
    ]));

    const loaded = await new QdrantHiveMemPersistence({ url: fake.baseUrl }).load();
    const legacy = loaded.memories.filter((memory) => memory.agent_id === "legacy-agent");

    assert.equal(legacy.length, 2);
    assert.deepEqual(legacy.map((memory) => memory.id).sort(), [
      "legacy-agent_private_episodic:legacy-point-1",
      "legacy-agent_private_episodic:legacy-point-2",
    ]);
    assert.equal(legacy.every((memory) => memory.workspace_id === "default"), true);
  });
});


describe("collection transitions", () => {
  it("removes old shared payloads and preserves vectors across restart", async () => {
    const fake = await startFakeQdrant();
    try {
      const persistence = new QdrantHiveMemPersistence({ url: fake.baseUrl });
      await persistence.load();
      const store = new InMemoryHiveMemStore({ persistence });
      const memory = store.createMemory(principal(), { content: "move fixture", type: "semantic", scope: "shared" });
      await store.flushPersistence();
      const vector = [...fake.points.get("shared_semantic")!.values()][0]!.vector;
      store.privatizeMemory(principal(), { memory_id: memory.id });
      await store.flushPersistence();
      assert.equal(fake.points.get("shared_semantic")!.size, 0);
      const restored = await new QdrantHiveMemPersistence({ url: fake.baseUrl }).load();
      assert.equal(restored.memories.filter((item) => item.id === memory.id).length, 1);
      assert.equal(restored.memories.find((item) => item.id === memory.id)!.scope, "private");
      assert.deepEqual([...fake.points.get("agent-a_private_semantic")!.values()][0]!.vector, vector);
    } finally { await new Promise<void>((resolve) => fake.server.close(() => resolve())); }
  });
});


it("replays a durable move journal after interruption while preserving original vectors", async () => {
  const fake = await startFakeQdrant(); const directory = mkdtempSync(join(tmpdir(), 'hivemem-journal-'));
  try {
    const first = new QdrantHiveMemPersistence({ url: fake.baseUrl }); await first.load();
    const source = new InMemoryHiveMemStore({ persistence: first });
    const record = source.createMemory(principal(), { content: 'journal fixture', type: 'semantic', scope: 'shared' }); await source.flushPersistence();
    const original = [...fake.points.get('shared_semantic')!.values()][0]!; original.vector = Array<number>(768).fill(0.125);
    let fail = true;
    const interrupted = new QdrantHiveMemPersistence({ url: fake.baseUrl, journalPath: join(directory, 'pending.json'), fetchImpl: async (url, init) => { if (fail && String(url).includes('agent-a_private_semantic/points?')) throw new Error('process interruption'); return fetch(url, init); } });
    const store = new InMemoryHiveMemStore({ snapshot: await interrupted.load(), persistence: interrupted });
    store.privatizeMemory(principal(), { memory_id: record.id }); await assert.rejects(store.flushPersistence(), /indeterminate/);
    assert.equal(fake.points.get('shared_semantic')!.size, 0);
    fail = false;
    const recovered = await new QdrantHiveMemPersistence({ url: fake.baseUrl, journalPath: join(directory, 'pending.json') }).load();
    assert.equal(recovered.memories.filter((item) => item.id === record.id).length, 1);
    assert.equal(recovered.memories.find((item) => item.id === record.id)!.scope, 'private');
    assert.deepEqual([...fake.points.get('agent-a_private_semantic')!.values()][0]!.vector, original.vector);
  } finally { await new Promise<void>((resolve) => fake.server.close(() => resolve())); rmSync(directory, { recursive: true, force: true }); }
});
