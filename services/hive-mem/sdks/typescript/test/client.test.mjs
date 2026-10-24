import assert from "node:assert/strict";
import test from "node:test";
import { ContextPackage, HiveMem } from "../dist/index.js";

test("HiveMem createMemory sends auth and workspace", async () => {
  const seen = {};
  const client = new HiveMem({
    baseUrl: "https://hive.test",
    token: "tok",
    workspaceId: "ws",
    fetchImpl: async (url, init) => {
      seen.url = String(url);
      seen.auth = init.headers.get("authorization");
      seen.body = JSON.parse(init.body);
      return new Response(JSON.stringify({ id: "m1", ...seen.body }), { status: 201, headers: { "content-type": "application/json" } });
    },
  });

  const result = await client.createMemory({ content: "hello", type: "semantic", scope: "private" });
  assert.equal(seen.auth, "Bearer tok");
  assert.equal(seen.body.workspace_id, "ws");
  assert.equal(result.id, "m1");
});

test("ContextPackage produces OpenAI fallback messages", () => {
  const pkg = new ContextPackage({ summary: { content: "summary" }, memories: [{ id: "m", agent_id: "a", content: "memory", type: "semantic", scope: "private" }] });
  const messages = pkg.toOpenAI({ assistantPeerId: "bot" });
  assert.equal(messages[0].content, "Assistant peer id: bot");
  assert.ok(messages.some((message) => message.content.includes("memory")));
});

test("HiveMem syncKnowledgeSource uses the bounded knowledge route and workspace", async () => {
  const seen = {};
  const client = new HiveMem({
    baseUrl: "https://hive.test",
    workspaceId: "team",
    fetchImpl: async (url, init) => {
      seen.url = String(url);
      seen.body = JSON.parse(init.body);
      return new Response(JSON.stringify({ ...seen.body, created: 1, superseded: 0, retired: 0, unchanged: 0, created_ids: ["m1"], superseded_ids: [], retired_ids: [] }), { status: 200, headers: { "content-type": "application/json" } });
    },
  });
  const result = await client.syncKnowledgeSource({ mode: "preview", project_id: "p", source_id: "repo:p", source_uri: "repo://p", revision: "r1", observed_at: "2026-09-21T00:00:00Z", chunks: [] });
  assert.equal(seen.url, "https://hive.test/v1/knowledge/sources/sync");
  assert.equal(seen.body.workspace_id, "team");
  assert.equal(result.created, 1);
});

test("HiveMem middleware hooks and auth refresh are applied", async () => {
  const calls = [];
  const client = new HiveMem({
    baseUrl: "https://hive.test",
    token: "old",
    requestIdProvider: () => "req-1",
    authRefresh: () => "new",
    onRequest: (method, url) => calls.push(["request", method, url]),
    onResponse: response => calls.push(["response", response.status]),
    fetchImpl: async (url, init) => {
      assert.equal(init.headers.get("authorization"), "Bearer new");
      assert.equal(init.headers.get("x-request-id"), "req-1");
      return new Response(JSON.stringify({ peer_id: "user", cards: [], generated_at: "now", observer_peer_id: "agent", workspace_id: "default" }), { status: 200, headers: { "content-type": "application/json" } });
    },
  });

  const card = await client.getPeerCard("user");
  assert.equal(card.peer_id, "user");
  assert.deepEqual(calls[0].slice(0, 2), ["request", "GET"]);
  assert.deepEqual(calls[1], ["response", 200]);
});

test("HiveMem history, conclusion and operation reads use the documented routes", async () => {
  const urls = [];
  const client = new HiveMem({
    baseUrl: "https://hive.test",
    token: "tok",
    workspaceId: "team",
    fetchImpl: async (url) => {
      urls.push(new URL(String(url)));
      return new Response(JSON.stringify({ id: "x", results: [], next_cursor: null }), { status: 200, headers: { "content-type": "application/json" } });
    },
  });

  await client.getMemory("m/1", { includeHistory: true });
  await client.getConclusion("c1");
  await client.listConclusionsPage("peer", { limit: 2, cursor: "abc" });
  await client.getQueueOperation("op-1", "dream");

  assert.equal(urls[0].pathname, "/v1/memories/m%2F1");
  assert.equal(urls[0].searchParams.get("include_history"), "true");
  assert.equal(urls[1].pathname, "/v1/conclusions/c1");
  assert.equal(urls[1].searchParams.has("include_history"), false);
  assert.equal(urls[2].pathname, "/v1/peers/peer/conclusions");
  assert.equal(urls[2].searchParams.get("paginate"), "true");
  assert.equal(urls[2].searchParams.get("cursor"), "abc");
  assert.equal(urls[2].searchParams.get("workspace_id"), "team");
  assert.equal(urls[3].pathname, "/v1/queue/operations/op-1");
  assert.equal(urls[3].searchParams.get("task_type"), "dream");
  assert.equal(urls[3].searchParams.get("workspace_id"), "team");
});
