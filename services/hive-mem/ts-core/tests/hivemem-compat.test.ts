import { InMemoryHiveMemStore } from "../src/store.js";
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { createHiveMemServer, signToken, type AgentInfo, type AgentProfile, type AgentProfileBundle, type AgentRegistered, type BrowseResponse, type ChatResponse, type EmbedResponse, type EpisodeMessagesResponse, type EpisodeRecord, type ConclusionRecord, type ConclusionSearchResponse, type ContextResponse, type GraphNeighborhoodResponse, type MemoryRecord, type MessageRecord, type PeerCardResponse, type PeerCardReviewResponse, type QueueJobRecord, type QueueStatusResponse, type RepresentationResponse, type SearchResponse, type SessionRecord, type DreamScheduleResponse, type StatsResponse, type WebhookDeliveryListResponse, type WebhookDeliveryRecord, type WebhookEndpointRecord, type WebhookTestEmitResponse, type WorkspaceMember, type WorkspaceRecord, type WorkspaceResolvedSettings } from "../src/index.js";

const jwtSecret = "test_secret_32_bytes_or_more_xxxx";

// Sign a raw HS256 token from arbitrary claims, used to reproduce legacy
// Python-minted agent tokens (no iss/aud/jti, long lifetime).
function signRawToken(secret: string, claims: Record<string, unknown>): string {
  const encode = (value: unknown): string => Buffer.from(JSON.stringify(value)).toString("base64url");
  const header = encode({ alg: "HS256", typ: "JWT" });
  const payload = encode(claims);
  const signature = createHmac("sha256", secret).update(`${header}.${payload}`).digest("base64url");
  return `${header}.${payload}.${signature}`;
}

function token(agentId: string): string {
  return signToken(jwtSecret, {
    sub: agentId,
    scope: "memories:read memories:write sessions:read sessions:write context:read agents:read agents:write workspaces:read workspaces:write webhooks:read webhooks:write queue:read",
    exp: Math.floor(Date.now() / 1000) + 3600,
  });
}

function adminToken(agentId: string): string {
  return signToken(jwtSecret, {
    sub: agentId,
    role: "admin",
    scope: "admin:queue memories:read memories:write sessions:read sessions:write context:read",
    exp: Math.floor(Date.now() / 1000) + 3600,
  });
}

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address() as AddressInfo;
  return `http://127.0.0.1:${address.port}`;
}

async function request<T>(baseUrl: string, method: string, path: string, body?: unknown, bearer = token("agent-a")): Promise<{ status: number; body: T }> {
  return requestWithHeaders(baseUrl, method, path, { authorization: `Bearer ${bearer}` }, body);
}

async function requestWithHeaders<T>(baseUrl: string, method: string, path: string, headers: Record<string, string>, body?: unknown): Promise<{ status: number; body: T }> {
  const init: RequestInit = {
    method,
    headers: {
      ...headers,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
  };
  if (body !== undefined) init.body = JSON.stringify(body);
  const response = await fetch(`${baseUrl}${path}`, init);
  const parsed = response.status === 204 ? undefined : ((await response.json()) as T);
  return { status: response.status, body: parsed as T };
}

describe("HiveMem TypeScript compatibility core", () => {
  let server: Server;
  let baseUrl: string;

  before(async () => {
    server = createHiveMemServer({ jwtSecret, store: new InMemoryHiveMemStore({ webhookTransport: async () => 202 }) });
    baseUrl = await listen(server);
  });

  after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  });

  it("serves public health and rejects missing auth elsewhere", async () => {
    const health = await fetch(`${baseUrl}/v1/health`);
    assert.equal(health.status, 200);
    const healthBody = (await health.json()) as { status: string; checks: Array<{ name: string; status: string }> };
    assert.equal(healthBody.status, "ok");
    assert.equal(healthBody.checks.some((check) => check.name === "store" && check.status === "pass"), true);

    const live = await fetch(`${baseUrl}/v1/health/live`);
    assert.equal(live.status, 200);
    assert.equal(((await live.json()) as { checks: Array<{ name: string }> }).checks[0]?.name, "process");

    const ready = await fetch(`${baseUrl}/v1/health/ready`);
    assert.equal(ready.status, 200);
    assert.equal(((await ready.json()) as { status: string }).status, "ok");

    const dependencies = await fetch(`${baseUrl}/v1/health/dependencies`);
    assert.equal(dependencies.status, 200);
    assert.equal(((await dependencies.json()) as { status: string }).status, "ok");

    const response = await fetch(`${baseUrl}/v1/memories/browse`);
    assert.equal(response.status, 401);
  });

  it("enforces strict JWT claims, issuance authority, scopes, revocation, and body limits", async () => {
    assert.throws(() => createHiveMemServer({ jwtSecret: "change_me" }), /non-placeholder secret/);

    const noExpiry = signToken(jwtSecret, { sub: "invalid-agent", exp: null });
    const rejectedClaims = await request<Record<string, unknown>>(baseUrl, "GET", "/v1/auth/me", undefined, noExpiry);
    assert.equal(rejectedClaims.status, 401);
    // Backward compatibility: legacy Python-minted agent tokens omit iss/aud/jti
    // and are long-lived (e.g. one year). They must still authenticate.
    const nowSeconds = Math.floor(Date.now() / 1000);
    const legacyAgentToken = signRawToken(jwtSecret, {
      sub: "legacy-agent",
      role: "agent",
      token_type: "access",
      scopes: ["*"],
      iat: nowSeconds,
      exp: nowSeconds + 365 * 24 * 60 * 60,
    });
    assert.equal((await request<Record<string, unknown>>(baseUrl, "GET", "/v1/auth/me", undefined, legacyAgentToken)).status, 200);
    // A present-but-wrong issuer is still rejected.
    const wrongIssuer = signToken(jwtSecret, { sub: "spoofed", iss: "not-hivemem", exp: nowSeconds + 3600 });
    assert.equal((await request<Record<string, unknown>>(baseUrl, "GET", "/v1/auth/me", undefined, wrongIssuer)).status, 401);

    const readOnly = signToken(jwtSecret, { sub: "reader", scope: "memories:read", exp: Math.floor(Date.now() / 1000) + 3600 });
    const deniedWrite = await request<Record<string, unknown>>(baseUrl, "POST", "/v1/memories", { content: "must not be written" }, readOnly);
    assert.equal(deniedWrite.status, 403);

    const deniedIssue = await request<Record<string, unknown>>(baseUrl, "POST", "/v1/auth/tokens", { agent_id: "escalated" }, token("agent-a"));
    assert.equal(deniedIssue.status, 403);
    const deniedAdminScope = await request<Record<string, unknown>>(baseUrl, "POST", "/v1/auth/tokens", { agent_id: "escalated", scopes: ["admin:all"] }, adminToken("admin-security"));
    assert.equal(deniedAdminScope.status, 422);

    const revocable = signToken(jwtSecret, { sub: "revocable", scope: "memories:read", exp: Math.floor(Date.now() / 1000) + 3600 });
    const revoked = await request<Record<string, unknown>>(baseUrl, "POST", "/v1/auth/revoke", { token: revocable }, revocable);
    assert.equal(revoked.status, 200);
    const afterRevoke = await request<Record<string, unknown>>(baseUrl, "GET", "/v1/auth/me", undefined, revocable);
    assert.equal(afterRevoke.status, 401);

    const oversized = await request<Record<string, unknown>>(baseUrl, "POST", "/v1/memories", { content: "x".repeat(1024 * 1024 + 1) });
    assert.equal(oversized.status, 413);
  });

  it("prevents direct-ID reads across workspace boundaries", async () => {
    const workspace = await request<WorkspaceRecord>(baseUrl, "POST", "/v1/workspaces", { workspace_id: "security-private", title: "Security Private" });
    assert.equal(workspace.status, 201);
    const memory = await request<MemoryRecord>(baseUrl, "POST", "/v1/memories", {
      content: "Workspace members only.",
      type: "semantic",
      workspace_id: "security-private",
      scope: "shared",
    });
    assert.equal(memory.status, 201);
    const forbidden = await request<Record<string, unknown>>(baseUrl, "GET", `/v1/memories/${memory.body.id}`, undefined, token("workspace-outsider"));
    assert.equal(forbidden.status, 403);
  });

  it("creates, reads, updates, browses, searches, and soft-deletes memories", async () => {
    const created = await request<MemoryRecord>(baseUrl, "POST", "/v1/memories", {
      content: "Router OIDC login should use Hive IAM.",
      type: "semantic",
      scope: "private",
      tags: ["router", "iam"],
      workspace_id: "default",
      importance: 0.9,
    });
    assert.equal(created.status, 201);
    assert.equal(created.body.agent_id, "agent-a");
    assert.equal(created.body.scope, "private");

    const read = await request<MemoryRecord>(baseUrl, "GET", `/v1/memories/${created.body.id}`);
    assert.equal(read.body.content, created.body.content);

    const updated = await request<MemoryRecord>(baseUrl, "PUT", `/v1/memories/${created.body.id}`, {
      confidence: 0.95,
      metadata: { source: "compat-test" },
    });
    assert.equal(updated.body.confidence, 0.95);
    assert.equal(updated.body.metadata.source, "compat-test");

    const browse = await request<BrowseResponse>(baseUrl, "GET", "/v1/memories/browse?workspace_id=default");
    assert.equal(browse.body.total, 1);

    const search = await request<SearchResponse>(baseUrl, "POST", "/v1/memories/search?explain=true", {
      query: "oidc iam",
      workspace_id: "default",
      limit: 5,
    });
    assert.equal(search.body.results.length, 1);
    assert.equal(search.body.results[0]?.memory.id, created.body.id);
    assert.equal(search.body.results[0]?.explanation?.text_match, true);

    const deleted = await request<undefined>(baseUrl, "DELETE", `/v1/memories/${created.body.id}`);
    assert.equal(deleted.status, 204);

    const afterDelete = await request<{ detail: string }>(baseUrl, "GET", `/v1/memories/${created.body.id}`);
    assert.equal(afterDelete.status, 404);
  });

  it("keeps private memories isolated while allowing shared memory reads", async () => {
    const privateMemory = await request<MemoryRecord>(baseUrl, "POST", "/v1/memories", {
      content: "Private note for agent A.",
      type: "semantic",
      scope: "private",
    });
    const sharedMemory = await request<MemoryRecord>(baseUrl, "POST", "/v1/memories", {
      content: "Shared note for all agents.",
      type: "semantic",
      scope: "shared",
    });

    const otherToken = token("agent-b");
    const privateRead = await request<{ detail: string }>(baseUrl, "GET", `/v1/memories/${privateMemory.body.id}`, undefined, otherToken);
    assert.equal(privateRead.status, 404);

    const sharedRead = await request<MemoryRecord>(baseUrl, "GET", `/v1/memories/${sharedMemory.body.id}`, undefined, otherToken);
    assert.equal(sharedRead.status, 200);
    assert.equal(sharedRead.body.id, sharedMemory.body.id);

    const adminRead = await request<MemoryRecord>(baseUrl, "GET", `/v1/memories/${privateMemory.body.id}`, undefined, adminToken("memory-console"));
    assert.equal(adminRead.status, 200);
    assert.equal(adminRead.body.id, privateMemory.body.id);

    const adminBrowse = await request<{ memories: MemoryRecord[] }>(baseUrl, "GET", "/v1/memories/browse?workspace_id=*&scope=private", undefined, adminToken("memory-console"));
    assert.equal(adminBrowse.body.memories.some((memory) => memory.id === privateMemory.body.id), true);
  });


  it("records queue jobs for session memory and exposes filtered queue status", async () => {
    const session = await request<SessionRecord>(baseUrl, "POST", "/v1/sessions", {
      session_id: "queue-session",
      title: "Queue Session",
      scope: "shared",
      workspace_id: "default",
    });
    assert.equal(session.status, 201);

    const memory = await request<MemoryRecord>(baseUrl, "POST", "/v1/memories", {
      content: "Queue plumbing should record work for shared session memory.",
      type: "episodic",
      scope: "shared",
      session_id: "queue-session",
      workspace_id: "default",
      tags: ["queue"],
    });
    assert.equal(memory.status, 201);

    const status = await request<QueueStatusResponse>(baseUrl, "GET", "/v1/queue/status?session_id=queue-session&workspace_id=default");
    assert.equal(status.status, 200);
    assert.equal(status.body.total >= 2, true);
    assert.equal(status.body.pending_count, status.body.total);
    assert.equal(status.body.in_progress_count, 0);
    assert.equal(status.body.failed_count, 0);
    assert.equal(status.body.dead_letter_count, 0);
    assert.equal(status.body.jobs.every((job) => job.owner_agent_id === "agent-a"), true);
    assert.equal(status.body.jobs.some((job) => job.task_type === "summary"), true);
    assert.equal(status.body.jobs.some((job) => job.task_type === "representation"), true);

    const summaryOnly = await request<QueueStatusResponse>(baseUrl, "GET", "/v1/queue/status?task_type=summary&session_id=queue-session");
    assert.equal(summaryOnly.status, 200);
    assert.equal(summaryOnly.body.jobs.every((job) => job.task_type === "summary"), true);

    const job = await request<QueueJobRecord>(baseUrl, "GET", "/v1/queue/jobs/" + status.body.jobs[0]!.id);
    assert.equal(job.status, 200);
    assert.equal(job.body.payload.session_id, "queue-session");

    const otherToken = token("agent-b");
    const hidden = await request<{ detail: string }>(baseUrl, "GET", "/v1/queue/status?owner_agent_id=agent-a", undefined, otherToken);
    assert.equal(hidden.status, 403);
  });


  it("requires queue admin scope for retry and cancel controls", async () => {
    const session = await request<SessionRecord>(baseUrl, "POST", "/v1/sessions", {
      session_id: "queue-controls",
      scope: "private",
      workspace_id: "default",
    });
    assert.equal(session.status, 201);

    const status = await request<QueueStatusResponse>(baseUrl, "GET", "/v1/queue/status?session_id=queue-controls");
    assert.equal(status.status, 200);
    const jobId = status.body.jobs[0]!.id;

    const denied = await request<{ detail: string }>(baseUrl, "DELETE", "/v1/queue/jobs/" + jobId);
    assert.equal(denied.status, 403);

    const cancelled = await request<QueueJobRecord>(baseUrl, "DELETE", "/v1/queue/jobs/" + jobId, undefined, adminToken("admin-agent"));
    assert.equal(cancelled.status, 200);
    assert.equal(cancelled.body.status, "cancelled");

    const retried = await request<QueueJobRecord>(baseUrl, "POST", "/v1/queue/jobs/" + jobId + "/retry", undefined, adminToken("admin-agent"));
    assert.equal(retried.status, 200);
    assert.equal(retried.body.status, "pending");
    assert.equal(retried.body.retry_count, 0);
    assert.equal(retried.body.error, null);
  });


  it("serves dashboard queue compatibility endpoints through the dashboard cookie", async () => {
    const cookieToken = token("agent-a");
    const adminCookieToken = adminToken("admin-agent");
    const cookie = { cookie: "hivemem_dash=" + encodeURIComponent(cookieToken) };
    const adminCookie = { cookie: "hivemem_dash=" + encodeURIComponent(adminCookieToken) };

    const session = await request<SessionRecord>(baseUrl, "POST", "/v1/sessions", {
      session_id: "dashboard-queue",
      title: "Dashboard Queue",
      scope: "private",
      workspace_id: "default",
    });
    assert.equal(session.status, 201);

    const queue = await requestWithHeaders<QueueStatusResponse>(baseUrl, "GET", "/dashboard/api/queue/status?limit=5", cookie);
    assert.equal(queue.status, 200);
    assert.equal(queue.body.pending_count >= 1, true);
    const jobId = queue.body.jobs.find((job) => job.session_id === "dashboard-queue")!.id;

    const detail = await requestWithHeaders<QueueJobRecord>(baseUrl, "GET", "/dashboard/api/queue/jobs/" + jobId, cookie);
    assert.equal(detail.status, 200);
    assert.equal(detail.body.session_id, "dashboard-queue");

    const runbook = await requestWithHeaders<{ actions: string[]; curl: string; job: QueueJobRecord }>(baseUrl, "GET", "/dashboard/api/queue/jobs/" + jobId + "/runbook", cookie);
    assert.equal(runbook.status, 200);
    assert.deepEqual(runbook.body.actions, ["inspect", "copy_curl"]);
    assert.match(runbook.body.curl, /HIVEMEM_API_URL/);
    assert.equal(runbook.body.job.id, jobId);

    const deniedCancel = await requestWithHeaders<{ detail: string }>(baseUrl, "DELETE", "/dashboard/api/queue/jobs/" + jobId, cookie);
    assert.equal(deniedCancel.status, 403);

    const cancelled = await requestWithHeaders<QueueJobRecord>(baseUrl, "DELETE", "/dashboard/api/queue/jobs/" + jobId, adminCookie);
    assert.equal(cancelled.status, 200);
    assert.equal(cancelled.body.status, "cancelled");

    const retried = await requestWithHeaders<QueueJobRecord>(baseUrl, "POST", "/dashboard/api/queue/jobs/" + jobId + "/retry", adminCookie);
    assert.equal(retried.status, 200);
    assert.equal(retried.body.status, "pending");
  });


  it("executes queue jobs through TypeScript worker compatibility endpoints", async () => {
    const workspace = await request<WorkspaceRecord>(baseUrl, "POST", "/v1/workspaces", { workspace_id: "queue-run-ws", title: "Queue Run WS" });
    assert.equal(workspace.status, 201);

    const episode = await request<EpisodeRecord>(baseUrl, "POST", "/v1/episodes", {
      episode_id: "queue-run-episode",
      workspace_id: "queue-run-ws",
      session_id: "queue-run-session",
    });
    assert.equal(episode.status, 201);

    const message = await request<MessageRecord>(baseUrl, "POST", "/v1/episodes/queue-run-episode/messages", {
      message_id: "queue-run-message",
      role: "user",
      content: "Queue worker should extract this message into memory.",
      memory_type: "semantic",
    });
    assert.equal(message.status, 201);
    assert.equal(typeof message.body.memory_job_id, "string");

    const denied = await request<{ detail: string }>(baseUrl, "POST", "/v1/queue/jobs/" + message.body.memory_job_id + "/run");
    assert.equal(denied.status, 403);

    const completed = await request<QueueJobRecord>(
      baseUrl,
      "POST",
      "/v1/queue/run-next?task_type=message_extract&workspace_id=queue-run-ws",
      undefined,
      adminToken("admin-agent"),
    );
    assert.equal(completed.status, 200);
    assert.equal(completed.body.id, message.body.memory_job_id);
    assert.equal(completed.body.status, "completed");
    assert.equal(typeof completed.body.result?.memory_id, "string");

    const extracted = await request<MemoryRecord>(baseUrl, "GET", "/v1/memories/" + completed.body.result!.memory_id);
    assert.equal(extracted.status, 200);
    assert.equal(extracted.body.type, "semantic");
    assert.equal(extracted.body.metadata.message_id, "queue-run-message");

    const detail = await request<EpisodeMessagesResponse>(baseUrl, "GET", "/v1/episodes/queue-run-episode");
    assert.equal(detail.status, 200);
    assert.equal(detail.body.messages[0]?.memory_id, extracted.body.id);

    const rerun = await request<{ detail: string }>(baseUrl, "POST", "/v1/queue/jobs/" + message.body.memory_job_id + "/run", undefined, adminToken("admin-agent"));
    assert.equal(rerun.status, 409);

    const webhook = await request<WebhookEndpointRecord>(baseUrl, "POST", "/v1/webhooks", { url: "https://example.com/queue-run", workspace_id: "default" });
    assert.equal(webhook.status, 201);
    const emitted = await request<WebhookTestEmitResponse>(baseUrl, "POST", "/v1/webhooks/test", { workspace_id: "default" });
    assert.equal(emitted.status, 202);
    const delivery = await request<WebhookDeliveryRecord>(baseUrl, "GET", "/v1/webhooks/deliveries/" + emitted.body.delivery_ids[0]);
    assert.equal(delivery.status, 200);
    const deliveryJobs = await request<QueueStatusResponse>(baseUrl, "GET", "/v1/queue/status?task_type=webhook_delivery", undefined, adminToken("admin-agent"));
    const deliveryJob = deliveryJobs.body.jobs.find((job) => job.work_unit_key === "webhook:" + delivery.body.id);
    assert.equal(typeof deliveryJob?.id, "string");
    const delivered = await request<QueueJobRecord>(baseUrl, "POST", "/v1/queue/jobs/" + deliveryJob!.id + "/run", undefined, adminToken("admin-agent"));
    assert.equal(delivered.status, 200);
    assert.equal(delivered.body.status, "completed");
    assert.equal(delivered.body.result?.status, "delivered");
    const deliveryAfterRun = await request<WebhookDeliveryRecord>(baseUrl, "GET", "/v1/webhooks/deliveries/" + delivery.body.id);
    assert.equal(deliveryAfterRun.body.status, "delivered");

    const webhookCleanup = await request<WebhookEndpointRecord>(baseUrl, "DELETE", "/v1/webhooks/" + webhook.body.id);
    assert.equal(webhookCleanup.status, 200);
  });

  it("serves dashboard session list and session memory proxy endpoints", async () => {
    const cookie = { cookie: "hivemem_dash=" + encodeURIComponent(token("agent-a")) };
    const session = await request<SessionRecord>(baseUrl, "POST", "/v1/sessions", {
      session_id: "dashboard-sessions",
      title: "Dashboard Sessions",
      scope: "private",
      workspace_id: "default",
    });
    assert.equal(session.status, 201);

    const memory = await request<MemoryRecord>(baseUrl, "POST", "/v1/memories", {
      content: "Dashboard session memory should appear in proxy output.",
      type: "episodic",
      scope: "private",
      session_id: "dashboard-sessions",
      workspace_id: "default",
    });
    assert.equal(memory.status, 201);

    const sessions = await requestWithHeaders<{ results: SessionRecord[]; total: number; offset: number; limit: number }>(
      baseUrl,
      "GET",
      "/dashboard/api/sessions?workspace_id=default&limit=10",
      cookie,
    );
    assert.equal(sessions.status, 200);
    assert.equal(sessions.body.offset, 0);
    assert.equal(sessions.body.limit, 10);
    assert.equal(sessions.body.results.some((item) => item.session_id === "dashboard-sessions"), true);

    const memories = await requestWithHeaders<{ results: MemoryRecord[]; total: number; offset: number; limit: number }>(
      baseUrl,
      "GET",
      "/dashboard/api/sessions/dashboard-sessions/memories?workspace_id=default&limit=5",
      cookie,
    );
    assert.equal(memories.status, 200);
    assert.equal(memories.body.total, 1);
    assert.equal(memories.body.limit, 5);
    assert.equal(memories.body.results[0]?.id, memory.body.id);
  });


  it("serves dashboard memory CRUD, agent listing, and search explain endpoints", async () => {
    const cookie = { cookie: "hivemem_dash=" + encodeURIComponent(token("agent-a")) };
    const created = await requestWithHeaders<MemoryRecord>(
      baseUrl,
      "POST",
      "/dashboard/api/memories",
      cookie,
      {
        content: "Dashboard schema memory from TS core.",
        agent_id: "agent-a",
        type: "episodic",
        scope: "private",
        source: "observation",
        tags: ["dashboard", "ts-core"],
        workspace_id: "default",
      },
    );
    assert.equal(created.status, 201);
    assert.equal(created.body.agent_id, "agent-a");

    const forbidden = await requestWithHeaders<{ detail: string }>(
      baseUrl,
      "POST",
      "/dashboard/api/memories",
      cookie,
      { content: "wrong agent", agent_id: "agent-b", type: "episodic", scope: "private" },
    );
    assert.equal(forbidden.status, 403);

    const fetched = await requestWithHeaders<MemoryRecord>(baseUrl, "GET", "/dashboard/api/memories/" + created.body.id, cookie);
    assert.equal(fetched.status, 200);
    assert.equal(fetched.body.id, created.body.id);

    const detail = await requestWithHeaders<{ memory: MemoryRecord; collection: string; provenance: { metadata: Record<string, unknown> }; queue_jobs: unknown[] }>(
      baseUrl,
      "GET",
      "/dashboard/api/memories/" + created.body.id + "/detail",
      cookie,
    );
    assert.equal(detail.status, 200);
    assert.equal(detail.body.memory.id, created.body.id);
    assert.equal(detail.body.collection, "agent-a_private_episodic");
    assert.deepEqual(detail.body.queue_jobs, []);

    const updated = await requestWithHeaders<MemoryRecord>(
      baseUrl,
      "PUT",
      "/dashboard/api/memories/" + created.body.id,
      cookie,
      { content: "Dashboard schema memory from TS core updated.", tags: ["dashboard", "updated"] },
    );
    assert.equal(updated.status, 200);
    assert.match(updated.body.content, /updated/);

    const agentMemories = await requestWithHeaders<{ results: MemoryRecord[]; agent_id: string; is_own: boolean; can_modify: boolean }>(
      baseUrl,
      "GET",
      "/dashboard/api/agents/agent-a/memories?workspace_id=default",
      cookie,
    );
    assert.equal(agentMemories.status, 200);
    assert.equal(agentMemories.body.agent_id, "agent-a");
    assert.equal(agentMemories.body.is_own, true);
    assert.equal(agentMemories.body.can_modify, true);
    assert.equal(agentMemories.body.results.some((memory) => memory.id === created.body.id), true);

    const search = await requestWithHeaders<SearchResponse>(
      baseUrl,
      "POST",
      "/dashboard/api/search/explain",
      cookie,
      { query: "schema updated", workspace_id: "default", limit: 5 },
    );
    assert.equal(search.status, 200);
    assert.equal(search.body.results.some((result) => result.memory.id === created.body.id && result.explanation?.text_match === true), true);

    const deleted = await requestWithHeaders<{ status: string; id: string }>(baseUrl, "DELETE", "/dashboard/api/memories/" + created.body.id, cookie);
    assert.equal(deleted.status, 200);
    assert.deepEqual(deleted.body, { status: "deleted", id: created.body.id });

    const staleDelete = await requestWithHeaders<{ detail: string }>(baseUrl, "DELETE", "/dashboard/api/memories/" + created.body.id, cookie);
    assert.equal(staleDelete.status, 404);
  });





  it("serves peer conclusions, peer cards, representation, and dream compatibility", async () => {
    const cardCreate = await request<ConclusionRecord>(baseUrl, "POST", "/v1/peers/user-phase9/card", {
      content: "User-phase9 prefers concise status updates.",
      workspace_id: "default",
      confidence: 0.9,
    });
    assert.equal(cardCreate.status, 201);
    assert.equal(cardCreate.body.kind, "peer_card");
    assert.equal(cardCreate.body.observed_peer_id, "user-phase9");

    const listedCard = await request<PeerCardResponse>(baseUrl, "GET", "/v1/peers/user-phase9/card?workspace_id=default");
    assert.equal(listedCard.status, 200);
    assert.equal(listedCard.body.cards[0]?.id, cardCreate.body.id);

    const updated = await request<ConclusionRecord>(baseUrl, "PUT", "/v1/peers/user-phase9/card/" + cardCreate.body.id, {
      content: "User-phase9 prefers terse status updates.",
      workspace_id: "default",
      confidence: 0.85,
      metadata: { source: "compat-test" },
    });
    assert.equal(updated.status, 200);
    assert.match(updated.body.content, /terse/);
    assert.equal(updated.body.metadata.source, "compat-test");

    const source = await request<MemoryRecord>(baseUrl, "POST", "/v1/memories", { content: "Operational risk preference", type: "semantic", scope: "private" });
    const conclusion = await request<ConclusionRecord>(baseUrl, "POST", "/v1/peers/user-phase9/conclusions", {
      content: "User-phase9 often wants the operational risk first.",
      workspace_id: "default",
      kind: "explicit",
      confidence: 0.82,
      source_memory_ids: [source.body.id],
    });
    assert.equal(conclusion.status, 201);
    assert.equal(conclusion.body.kind, "explicit");

    const conclusions = await request<ConclusionRecord[]>(baseUrl, "GET", "/v1/peers/user-phase9/conclusions?workspace_id=default");
    assert.equal(conclusions.status, 200);
    assert.equal(conclusions.body.some((item) => item.id === conclusion.body.id), true);

    const queried = await request<ConclusionSearchResponse>(baseUrl, "POST", "/v1/peers/user-phase9/conclusions/query", {
      query: "operational risk",
      workspace_id: "default",
      limit: 5,
    });
    assert.equal(queried.status, 200);
    assert.equal(queried.body.results.some((item) => item.conclusion.id === conclusion.body.id), true);

    const representation = await request<RepresentationResponse>(baseUrl, "GET", "/v1/peers/user-phase9/representation?workspace_id=default");
    assert.equal(representation.status, 200);
    assert.equal(representation.body.peer_card.some((item) => item.id === cardCreate.body.id), true);
    assert.match(representation.body.context, /terse|operational risk/);

    const review = await request<PeerCardReviewResponse>(baseUrl, "POST", "/v1/peers/user-phase9/card/review?workspace_id=default");
    assert.equal(review.status, 200);
    assert.equal(review.body.active_card_count, 1);
    assert.equal(review.body.conclusion_count >= 2, true);

    const rebuild = await request<DreamScheduleResponse>(baseUrl, "POST", "/v1/peers/user-phase9/card/rebuild", {
      workspace_id: "default",
      force: true,
      reason: "phase9-test",
    });
    assert.equal(rebuild.status, 202);
    assert.equal(rebuild.body.task_type, "dream");
    assert.equal(rebuild.body.peer_id, "user-phase9");

    const dreamQueue = await request<QueueStatusResponse>(baseUrl, "GET", "/v1/queue/status?task_type=dream&peer_id=user-phase9");
    assert.equal(dreamQueue.status, 200);
    assert.equal(dreamQueue.body.jobs.some((job) => job.id === rebuild.body.job_id), true);

    const deletedConclusion = await request<undefined>(baseUrl, "DELETE", "/v1/conclusions/" + conclusion.body.id);
    assert.equal(deletedConclusion.status, 204);

    const deletedCard = await request<undefined>(baseUrl, "DELETE", "/v1/peers/user-phase9/card/" + cardCreate.body.id);
    assert.equal(deletedCard.status, 204);

    const reviewAfterDelete = await request<PeerCardReviewResponse>(baseUrl, "POST", "/v1/peers/user-phase9/card/review?workspace_id=default");
    assert.equal(reviewAfterDelete.status, 200);
    assert.equal(reviewAfterDelete.body.active_card_count, 0);
    assert.equal(reviewAfterDelete.body.needs_rebuild, true);
  });

  it("executes representation, summary, consolidation, and dream reasoning jobs", async () => {
    const admin = adminToken("admin-agent");

    const reasonWs = await request<WorkspaceRecord>(baseUrl, "POST", "/v1/workspaces", { workspace_id: "reason-ws", title: "Reasoning WS" });
    assert.equal(reasonWs.status, 201);
    const reasonSumWs = await request<WorkspaceRecord>(baseUrl, "POST", "/v1/workspaces", { workspace_id: "reason-sum-ws", title: "Reasoning Summary WS" });
    assert.equal(reasonSumWs.status, 201);

    // Consolidation reviews explicit memory_ids, extracts conclusions, dreams, and builds peer cards.
    const memoryContents = [
      "Agent-a prefers concise summaries and uses TypeScript daily.",
      "Agent-a prefers concise summaries and uses TypeScript daily.",
      "The rollout was changed and no longer uses the legacy router.",
    ];
    const memoryIds: string[] = [];
    for (const content of memoryContents) {
      const created = await request<MemoryRecord>(baseUrl, "POST", "/v1/memories", {
        content,
        type: "semantic",
        scope: "private",
        workspace_id: "reason-ws",
        importance: 0.9,
        tags: ["reasoning"],
      });
      assert.equal(created.status, 201);
      memoryIds.push(created.body.id);
    }

    const consolidate = await request<{ job_id: string; status: string }>(baseUrl, "POST", "/v1/memories/consolidate", {
      memory_ids: memoryIds,
      workspace_id: "reason-ws",
    });
    assert.equal(consolidate.status, 200);

    const consolidationRun = await request<QueueJobRecord>(baseUrl, "POST", "/v1/queue/jobs/" + consolidate.body.job_id + "/run", undefined, admin);
    assert.equal(consolidationRun.status, 200);
    assert.equal(consolidationRun.body.status, "completed");
    const consolidationResult = consolidationRun.body.result as {
      status: string;
      memories_reviewed: number;
      stored_conclusions: number;
      generated_conclusion_ids: string[];
      dream: { stored_peer_cards: number; deduped: number };
    };
    assert.equal(consolidationResult.status, "completed");
    assert.equal(consolidationResult.memories_reviewed, 3);
    assert.equal(consolidationResult.stored_conclusions > 0, true);
    assert.equal(consolidationResult.generated_conclusion_ids.length > 0, true);
    assert.equal(consolidationResult.dream.stored_peer_cards > 0, true);

    // Stored conclusions are queryable for the observed peer (owner).
    const conclusions = await request<ConclusionRecord[]>(baseUrl, "GET", "/v1/peers/agent-a/conclusions?workspace_id=reason-ws");
    assert.equal(conclusions.status, 200);
    assert.equal(conclusions.body.some((item) => /prefers concise summaries/i.test(item.content)), true);
    const exactContent = "Agent-a prefers concise summaries and uses TypeScript daily.";
    const preferenceConclusionCount = conclusions.body.filter((item) => item.content === exactContent).length;
    assert.equal(preferenceConclusionCount > 0, true);

    // The dream builds at least one peer card from preference-style conclusions.
    const peerCard = await request<PeerCardResponse>(baseUrl, "GET", "/v1/peers/agent-a/card?workspace_id=reason-ws");
    assert.equal(peerCard.status, 200);
    assert.equal(peerCard.body.cards.length > 0, true);

    // Re-running consolidation is idempotent for extracted conclusions: deterministic IDs prevent duplicates.
    const consolidateAgain = await request<{ job_id: string }>(baseUrl, "POST", "/v1/memories/consolidate", {
      memory_ids: memoryIds,
      workspace_id: "reason-ws",
    });
    const rerun = await request<QueueJobRecord>(baseUrl, "POST", "/v1/queue/jobs/" + consolidateAgain.body.job_id + "/run", undefined, admin);
    assert.equal(rerun.body.status, "completed");
    const conclusionsAfter = await request<ConclusionRecord[]>(baseUrl, "GET", "/v1/peers/agent-a/conclusions?workspace_id=reason-ws");
    assert.equal(conclusionsAfter.body.filter((item) => item.content === exactContent).length, preferenceConclusionCount);

    // Summary jobs turn session memories into summary conclusions.
    const session = await request<SessionRecord>(baseUrl, "POST", "/v1/sessions", { workspace_id: "reason-sum-ws", title: "Reasoning summary" });
    assert.equal(session.status, 201);
    const sessionMemory = await request<MemoryRecord>(baseUrl, "POST", "/v1/memories", {
      content: "Agent-a decided to ship the TypeScript memory runtime this sprint.",
      type: "semantic",
      scope: "private",
      workspace_id: "reason-sum-ws",
      session_id: session.body.session_id,
      importance: 0.8,
    });
    assert.equal(sessionMemory.status, 201);

    const summaryRun = await request<QueueJobRecord>(
      baseUrl,
      "POST",
      "/v1/queue/run-next?task_type=summary&workspace_id=reason-sum-ws",
      undefined,
      admin,
    );
    assert.equal(summaryRun.status, 200);
    assert.equal(summaryRun.body.status, "completed");
    const summaryResult = summaryRun.body.result as { status: string; memory_count: number; summary_ids: string[] };
    assert.equal(summaryResult.status, "completed");
    assert.equal(summaryResult.summary_ids.length, 1);

    const summaryConclusions = await request<ConclusionRecord[]>(baseUrl, "GET", "/v1/peers/agent-a/conclusions?workspace_id=reason-sum-ws&kind=summary");
    assert.equal(summaryConclusions.body.some((item) => item.kind === "summary" && /summary for session/i.test(item.content)), true);

    // A dedicated dream job stores inferred conclusions and peer cards without failing.
    const dream = await request<DreamScheduleResponse>(baseUrl, "POST", "/v1/peers/agent-a/card/rebuild", {
      workspace_id: "reason-ws",
      force: true,
    });
    assert.equal(dream.status, 202);
    const dreamRun = await request<QueueJobRecord>(baseUrl, "POST", "/v1/queue/jobs/" + dream.body.job_id + "/run", undefined, admin);
    assert.equal(dreamRun.body.status, "completed");
    const dreamResult = dreamRun.body.result as { status: string; stored_peer_cards: number };
    assert.equal(dreamResult.status, "completed");
  });

  it("serves agent registration, profile, and bundle compatibility", async () => {
    const registered = await request<AgentRegistered>(
      baseUrl,
      "POST",
      "/v1/agents/register",
      { agent_id: "ts_agent", display_name: "TS Agent", description: "registered in TS", token_scopes: ["memories:read", "memories:write", "agents:read"] },
      adminToken("admin-agent"),
    );
    assert.equal(registered.status, 201);
    assert.equal(registered.body.agent_id, "ts_agent");
    assert.equal(registered.body.private_collections.includes("ts_agent_private_episodic"), true);
    assert.match(registered.body.token, /^[^.]+.[^.]+.[^.]+$/);

    const registeredTokenList = await request<AgentInfo[]>(baseUrl, "GET", "/v1/agents", undefined, registered.body.token);
    assert.equal(registeredTokenList.status, 200);
    assert.equal(registeredTokenList.body.some((agent) => agent.agent_id === "ts_agent"), true);

    const duplicate = await request<{ detail: string }>(
      baseUrl,
      "POST",
      "/v1/agents/register",
      { agent_id: "ts_agent", display_name: "Duplicate" },
      adminToken("admin-agent"),
    );
    assert.equal(duplicate.status, 409);

    const agentMemory = await request<MemoryRecord>(baseUrl, "POST", "/v1/memories", {
      content: "Agent profile memory tagged for bundle compatibility.",
      type: "semantic",
      scope: "shared",
      tags: ["phase9", "agent-profile"],
      confidence: 0.9,
    });
    assert.equal(agentMemory.status, 201);

    const detail = await request<AgentInfo>(baseUrl, "GET", "/v1/agents/agent-a");
    assert.equal(detail.status, 200);
    assert.equal((detail.body.memory_counts.shared_semantic ?? 0) >= 1, true);

    const profile = await request<AgentProfile>(baseUrl, "GET", "/v1/agents/agent-a/profile");
    assert.equal(profile.status, 200);
    assert.equal(profile.body.total_memories >= 1, true);
    assert.equal(profile.body.top_tags.some((tag) => tag.tag === "agent-profile"), true);
    assert.equal(profile.body.avg_confidence !== null, true);

    const bundle: AgentProfileBundle = {
      agent_id: "phase9_agent",
      display_name: "Phase 9 Agent",
      description: "bundle test",
      default_workspace_id: "default",
      default_tags: ["phase9"],
      preferred_recall_strategy: "context",
      tool_configuration: { mcp: true },
      metadata: { owner: "tests" },
      exported_at: null,
    };
    const imported = await request<AgentProfileBundle>(baseUrl, "POST", "/v1/agents/phase9_agent/bundle", bundle, adminToken("admin-agent"));
    assert.equal(imported.status, 200);
    assert.equal(imported.body.preferred_recall_strategy, "context");

    const exported = await request<AgentProfileBundle>(baseUrl, "GET", "/v1/agents/phase9_agent/bundle", undefined, adminToken("admin-agent"));
    assert.equal(exported.status, 200);
    assert.deepEqual(exported.body.default_tags, ["phase9"]);
    assert.equal(exported.body.tool_configuration.mcp, true);

    const crossExport = await request<{ detail: string }>(baseUrl, "GET", "/v1/agents/phase9_agent/bundle");
    assert.equal(crossExport.status, 403);

    const ownBundle = { ...bundle, agent_id: "agent-a", display_name: "Agent A" };
    const ownImport = await request<AgentProfileBundle>(baseUrl, "POST", "/v1/agents/agent-a/bundle", ownBundle, adminToken("admin-agent"));
    assert.equal(ownImport.status, 200);
    const ownExport = await request<AgentProfileBundle>(baseUrl, "GET", "/v1/agents/agent-a/bundle");
    assert.equal(ownExport.status, 200);
    assert.equal(ownExport.body.agent_id, "agent-a");

    const secretBundle = { ...bundle, agent_id: "secret_agent", display_name: "Secret Agent", tool_configuration: { headers: { Authorization: "Bearer secret" } }, metadata: { hermes_token: "secret" } };
    const rejectedSecret = await request<{ detail: string }>(baseUrl, "POST", "/v1/agents/secret_agent/bundle", secretBundle, adminToken("admin-agent"));
    assert.equal(rejectedSecret.status, 400);
    assert.match(rejectedSecret.body.detail, /secret-looking keys/);
  });

  it("serves deterministic chat responses, session chat, and SSE compatibility", async () => {
    const memory = await request<MemoryRecord>(baseUrl, "POST", "/v1/memories", {
      content: "User prefers concise written summaries with bullet lists.",
      type: "episodic",
      scope: "shared",
      tags: ["communication"],
      workspace_id: "default",
    });
    assert.equal(memory.status, 201);

    const chat = await request<ChatResponse>(baseUrl, "POST", "/v1/chat", { query: "What communication style?", max_sources: 3 });
    assert.equal(chat.status, 200);
    assert.match(chat.body.answer, /communication|concise/i);
    assert.equal(chat.body.reasoning_level, "medium");
    assert.equal(chat.body.sources[0]?.memory_id, memory.body.id);
    assert.equal(chat.body.usage.total_tokens > 0, true);

    const noCitations = await request<ChatResponse>(baseUrl, "POST", "/v1/chat", {
      query: "What communication style?",
      include_citations: false,
    });
    assert.equal(noCitations.status, 200);
    assert.deepEqual(noCitations.body.sources, []);
    assert.equal(noCitations.body.usage.source_tokens > 0, true);

    const privateSession = await request<SessionRecord>(baseUrl, "POST", "/v1/sessions", {
      session_id: "private-chat-ts",
      scope: "private",
      workspace_id: "default",
    });
    assert.equal(privateSession.status, 201);

    const privateMemory = await request<MemoryRecord>(baseUrl, "POST", "/v1/memories", {
      content: "Private session evidence.",
      type: "episodic",
      scope: "private",
      session_id: "private-chat-ts",
      workspace_id: "default",
    });
    assert.equal(privateMemory.status, 201);

    const sessionChat = await request<ChatResponse>(baseUrl, "POST", "/v1/sessions/private-chat-ts/chat", { query: "What is private?" });
    assert.equal(sessionChat.status, 200);
    assert.equal(sessionChat.body.session_id, "private-chat-ts");
    assert.equal(sessionChat.body.sources[0]?.memory_id, privateMemory.body.id);

    const denied = await request<{ detail: string }>(baseUrl, "POST", "/v1/sessions/private-chat-ts/chat", { query: "What is private?" }, token("agent-b"));
    assert.equal(denied.status, 404);

    const stream = await fetch(baseUrl + "/v1/chat", {
      method: "POST",
      headers: { authorization: "Bearer " + token("agent-a"), "content-type": "application/json" },
      body: JSON.stringify({ query: "No sources expected", stream: true, workspace_id: "default" }),
    });
    assert.equal(stream.status, 200);
    assert.match(stream.headers.get("content-type") ?? "", /text\/event-stream/);
    const text = await stream.text();
    assert.match(text, /event: message_start/);
    assert.match(text, /event: answer_chunk/);
    assert.match(text, /event: done/);
  });

  it("serves dashboard memory options and context preview endpoints", async () => {
    const cookie = { cookie: "hivemem_dash=" + encodeURIComponent(token("agent-a")) };
    const memory = await request<MemoryRecord>(baseUrl, "POST", "/v1/memories", {
      content: "Context preview should select this dashboard option memory.",
      type: "semantic",
      scope: "private",
      tags: ["options", "context-preview"],
      workspace_id: "default",
    });
    assert.equal(memory.status, 201);

    const options = await requestWithHeaders<{
      current_agent_id: string;
      agents: Array<{ agent_id: string; display_name: string; current: boolean }>;
      tags: string[];
      scopes: string[];
      types: string[];
      sources: string[];
    }>(baseUrl, "GET", "/dashboard/api/memory-options", cookie);
    assert.equal(options.status, 200);
    assert.equal(options.body.current_agent_id, "agent-a");
    assert.equal(options.body.agents.some((agent) => agent.agent_id === "agent-a" && agent.current), true);
    assert.equal(options.body.tags.includes("context-preview"), true);
    assert.deepEqual(options.body.scopes, ["private", "shared"]);
    assert.equal(options.body.types.includes("semantic"), true);
    assert.equal(options.body.sources.includes("observation"), true);

    const preview = await requestWithHeaders<ContextResponse>(
      baseUrl,
      "POST",
      "/dashboard/api/context/preview",
      cookie,
      { search_query: "dashboard option", workspace_id: "default", max_memories: 3 },
    );
    assert.equal(preview.status, 200);
    assert.equal(preview.body.memories.some((item) => item.memory.id === memory.body.id), true);
    assert.match(preview.body.formatted_context.content, /dashboard option/i);
  });


  it("serves dashboard graph neighborhoods from entities and relationships", async () => {
    const cookie = { cookie: "hivemem_dash=" + encodeURIComponent(token("agent-a")) };
    const target = await request<MemoryRecord>(baseUrl, "POST", "/v1/memories", {
      content: "Graph target memory for TS core.",
      type: "semantic",
      scope: "private",
      workspace_id: "default",
      metadata: { entities: [{ type: "project", name: "GraphTarget" }] },
    });
    assert.equal(target.status, 201);

    const source = await request<MemoryRecord>(baseUrl, "POST", "/v1/memories", {
      content: "Graph source memory mentions DashGraph and contradicts target.",
      type: "episodic",
      scope: "private",
      workspace_id: "default",
      metadata: { entities: [{ type: "project", name: "DashGraph" }] },
      relationships: [{ target_id: target.body.id, type: "contradicts", confidence: 0.9, metadata: { source: "test" } }],
    });
    assert.equal(source.status, 201);
    assert.equal(source.body.relationships[0]?.target_id, target.body.id);

    const graph = await requestWithHeaders<GraphNeighborhoodResponse>(
      baseUrl,
      "GET",
      "/dashboard/api/graph/neighborhood?memory_id=" + source.body.id + "&workspace_id=default",
      cookie,
    );
    assert.equal(graph.status, 200);
    assert.equal(graph.body.anchor_id, source.body.id);
    assert.equal(graph.body.nodes.some((node) => node.id === source.body.id && node.record_type === "memory"), true);
    assert.equal(graph.body.nodes.some((node) => node.id === target.body.id && node.record_type === "memory"), true);
    assert.equal(graph.body.nodes.some((node) => node.record_type === "entity" && node.label === "DashGraph"), true);
    assert.equal(graph.body.edges.some((edge) => edge.source === source.body.id && edge.target === target.body.id && edge.type === "contradicts" && edge.confidence === 0.9), true);
    assert.equal(graph.body.edges.some((edge) => edge.source === source.body.id && edge.type === "mentions"), true);
  });



  it("serves memory browse aliases, search aliases, related memories, and conflict detection", async () => {
    const anchor = await request<MemoryRecord>(baseUrl, "POST", "/v1/memories", {
      content: "Compact alias search anchor mentions nebula routing.",
      type: "semantic",
      scope: "shared",
      tags: ["compact-alias", "nebula"],
      workspace_id: "default",
      importance: 0.8,
    });
    assert.equal(anchor.status, 201);

    const relatedPeer = await request<MemoryRecord>(baseUrl, "POST", "/v1/memories", {
      content: "Related compact alias peer for nebula routing.",
      type: "semantic",
      scope: "shared",
      tags: ["compact-alias", "nebula"],
      workspace_id: "default",
    });
    assert.equal(relatedPeer.status, 201);

    const browse = await request<BrowseResponse>(baseUrl, "GET", "/v1/memories/browse?workspace_id=default&limit=5");
    assert.equal(Array.isArray(browse.body.memories), true);
    assert.deepEqual(browse.body.results, browse.body.memories);
    assert.equal(typeof browse.body.next_cursor === "string" || browse.body.next_cursor === null, true);

    for (const path of ["/v1/memories/search/text", "/v1/memories/search/hybrid"]) {
      const search = await request<SearchResponse>(baseUrl, "POST", path, { query: "nebula routing", workspace_id: "default", limit: 5 });
      assert.equal(search.status, 200);
      assert.equal(search.body.results.some((result) => result.memory.id === anchor.body.id), true);
    }

    const related = await request<SearchResponse>(baseUrl, "GET", "/v1/memories/" + anchor.body.id + "/related?limit=5");
    assert.equal(related.status, 200);
    assert.equal(related.body.results.some((result) => result.memory.id === relatedPeer.body.id), true);

    const otherToken = token("agent-b");
    const otherMemory = await request<MemoryRecord>(baseUrl, "POST", "/v1/memories", {
      content: "Conflict detector should find nebula routing disagreement.",
      type: "semantic",
      scope: "shared",
      workspace_id: "default",
      tags: ["conflict"],
    }, otherToken);
    assert.equal(otherMemory.status, 201);

    const conflicts = await request<SearchResponse>(baseUrl, "POST", "/v1/memories/conflicts", {
      content: "nebula routing disagreement",
      workspace_id: "default",
      scope: "shared",
      type: "semantic",
      limit: 5,
    });
    assert.equal(conflicts.status, 200);
    assert.equal(conflicts.body.results.some((result) => result.memory.id === otherMemory.body.id && result.is_own === false), true);
  });

  it("serves broad auth, admin, graph, lifecycle, and consolidation compatibility routes", async () => {
    const adminBearer = adminToken("admin-compat");
    const dashboardCookie = { cookie: "hivemem_dash=" + encodeURIComponent(adminBearer) };

    const login = await request<Record<string, unknown>>(baseUrl, "POST", "/v1/auth/login", { token: adminBearer }, adminBearer);
    assert.equal(login.status, 200);
    assert.equal(login.body.token_type, "bearer");
    assert.equal(login.body.agent_id, "admin-compat");

    const me = await request<Record<string, unknown>>(baseUrl, "GET", "/v1/auth/me", undefined, adminBearer);
    assert.equal(me.status, 200);
    assert.equal(me.body.agent_id, "admin-compat");

    const issued = await request<Record<string, unknown>>(baseUrl, "POST", "/v1/auth/tokens", { agent_id: "issued-agent", scopes: ["memories:read"], expires_hours: 1 }, adminBearer);
    assert.equal(issued.status, 201);
    assert.equal(typeof issued.body.token, "string");

    const target = await request<MemoryRecord>(baseUrl, "POST", "/v1/memories", {
      content: "HiveGraph target memory for relationship compatibility.",
      type: "semantic",
      scope: "shared",
      workspace_id: "default",
      tags: ["hivegraph"],
    }, adminBearer);
    assert.equal(target.status, 201);

    const source = await request<MemoryRecord>(baseUrl, "POST", "/v1/memories", {
      content: "HiveGraph source memory mentions an entity and supports the target.",
      type: "semantic",
      scope: "shared",
      workspace_id: "default",
      tags: ["hivegraph", "source"],
      metadata: { entities: [{ entity_id: "default:system:hivegraph", name: "HiveGraph", type: "system" }] },
      relationships: [{ target_id: target.body.id, type: "supports", confidence: 0.87, metadata: { reason: "compat" } }],
    }, adminBearer);
    assert.equal(source.status, 201);

    const entities = await request<Array<{ id: string; label: string }>>(baseUrl, "GET", "/v1/graph/entities?workspace_id=default", undefined, adminBearer);
    assert.equal(entities.status, 200);
    assert.equal(entities.body.some((entity) => entity.id === "default:system:hivegraph" && entity.label === "HiveGraph"), true);

    const entityPage = await request<Record<string, unknown>>(baseUrl, "GET", "/v1/graph/entities/default%3Asystem%3Ahivegraph?workspace_id=default", undefined, adminBearer);
    assert.equal(entityPage.status, 200);
    assert.equal((entityPage.body.entity as { id?: string }).id, "default:system:hivegraph");

    const relations = await request<Array<{ source: string; target: string; type: string; confidence: number }>>(baseUrl, "GET", "/v1/graph/relations?workspace_id=default", undefined, adminBearer);
    assert.equal(relations.status, 200);
    assert.equal(relations.body.some((edge) => edge.source === source.body.id && edge.target === target.body.id && edge.type === "supports" && edge.confidence === 0.87), true);

    const graph = await request<GraphNeighborhoodResponse>(baseUrl, "GET", "/v1/graph/neighborhood?memory_id=" + source.body.id + "&workspace_id=default", undefined, adminBearer);
    assert.equal(graph.status, 200);
    assert.equal(graph.body.nodes.some((node) => node.id === source.body.id), true);

    const diff = await request<Record<string, unknown>>(baseUrl, "GET", "/v1/memories/" + source.body.id + "/diff", undefined, adminBearer);
    assert.equal(diff.status, 200);
    assert.equal(diff.body.status, "unchanged");

    const memoryGraph = await request<GraphNeighborhoodResponse>(baseUrl, "GET", "/v1/memories/" + source.body.id + "/graph", undefined, adminBearer);
    assert.equal(memoryGraph.status, 200);
    assert.equal(memoryGraph.body.anchor_id, source.body.id);

    const endorsement = await request<Record<string, unknown>>(baseUrl, "POST", "/v1/memories/" + source.body.id + "/endorse", { support: true }, adminBearer);
    assert.equal(endorsement.status, 200);
    assert.equal(endorsement.body.endorsed, true);

    const promoted = await request<{ memory: MemoryRecord; promoted: boolean }>(baseUrl, "POST", "/v1/memories/promote", { memory_id: source.body.id }, adminBearer);
    assert.equal(promoted.status, 200);
    assert.equal(promoted.body.promoted, true);
    assert.equal(promoted.body.memory.scope, "shared");

    const privatized = await request<{ memory: MemoryRecord; privatized: boolean }>(baseUrl, "POST", "/v1/memories/privatize", { memory_id: source.body.id }, adminBearer);
    assert.equal(privatized.status, 200);
    assert.equal(privatized.body.privatized, true);
    assert.equal(privatized.body.memory.scope, "private");

    const consolidation = await request<Record<string, unknown>>(baseUrl, "POST", "/v1/memories/consolidate", { workspace_id: "default", memory_ids: [source.body.id, target.body.id] }, adminBearer);
    assert.equal(consolidation.status, 200);
    assert.equal(consolidation.body.task_type, "consolidation");
    assert.equal(typeof consolidation.body.job_id, "string");

    const forgetting = await request<Record<string, unknown>>(baseUrl, "POST", "/v1/memories/forgetting/review", { workspace_id: "default", reason: "compat" }, adminBearer);
    assert.equal(forgetting.status, 202);
    assert.equal(forgetting.body.task_type, "forgetting_review");

    const retention = await request<Record<string, unknown>>(baseUrl, "POST", "/v1/lifecycle/retention/apply", { workspace_id: "default", dry_run: true }, adminBearer);
    assert.equal(retention.status, 200);
    assert.equal(retention.body.dry_run, true);

    const archive = await request<Record<string, unknown>>(baseUrl, "POST", "/v1/archive/search", { workspace_id: "default", query: "hivegraph" }, adminBearer);
    assert.equal(archive.status, 200);
    assert.equal(archive.body.total, 0);

    const compaction = await request<Record<string, unknown>>(baseUrl, "POST", "/v1/memories/compactions", { workspace_id: "default", memory_ids: [source.body.id], content: "Compacted HiveGraph compatibility memory." }, adminBearer);
    assert.equal(compaction.status, 201);
    assert.equal(typeof compaction.body.memory_id, "string");

    const negotiation = await request<Record<string, unknown>>(baseUrl, "POST", "/v1/memories/negotiations", { workspace_id: "default", memory_ids: [source.body.id, target.body.id] }, adminBearer);
    assert.equal(negotiation.status, 202);
    assert.equal(typeof negotiation.body.job_id, "string");

    const multimodal = await request<Record<string, unknown>>(baseUrl, "POST", "/v1/memories/multimodal", { workspace_id: "default", media_type: "image/png" }, adminBearer);
    assert.equal(multimodal.status, 200);
    assert.equal(multimodal.body.media_type, "image/png");

    const critic = await request<Record<string, unknown>>(baseUrl, "POST", "/v1/memories/critic/review", { memory_id: source.body.id }, adminBearer);
    assert.equal(critic.status, 501);

    const providerCompare = await request<Record<string, unknown>>(baseUrl, "POST", "/v1/reasoning/providers/compare", { prompt: "compat" }, adminBearer);
    assert.equal(providerCompare.status, 501);

    const consolidationStatus = await requestWithHeaders<Record<string, unknown>>(baseUrl, "GET", "/dashboard/api/consolidation/status?workspace_id=default", dashboardCookie);
    assert.equal(consolidationStatus.status, 200);
    assert.equal(consolidationStatus.body.enabled, false);
    assert.equal((consolidationStatus.body.worker as { state: string }).state, "manual");

    const consolidationLogs = await requestWithHeaders<{ results: Array<{ run_id: string }> }>(baseUrl, "GET", "/dashboard/api/consolidation/logs?workspace_id=default", dashboardCookie);
    assert.equal(consolidationLogs.status, 200);
    assert.equal(consolidationLogs.body.results.some((run) => run.run_id === consolidation.body.job_id), true);

    const commandPalette = await requestWithHeaders<Record<string, unknown>>(baseUrl, "GET", "/dashboard/api/command-palette", dashboardCookie);
    assert.equal(commandPalette.status, 200);
    assert.equal(Array.isArray(commandPalette.body.commands), true);

    const dashboardConflicts = await requestWithHeaders<Record<string, unknown>>(baseUrl, "GET", "/dashboard/api/conflicts?workspace_id=default", dashboardCookie);
    assert.equal(dashboardConflicts.status, 200);
    assert.equal(dashboardConflicts.body.total, 0);

    const backup = await request<Record<string, unknown>>(baseUrl, "POST", "/v1/backup", {}, adminBearer);
    assert.equal(backup.status, 501);
    assert.match(String(backup.body.detail), /operator workflow/);

    const audit = await request<Record<string, unknown>>(baseUrl, "GET", "/v1/admin/audit", undefined, adminBearer);
    assert.equal(audit.status, 200);
    assert.ok(Number(audit.body.total) > 0);

    const exported = await request<Record<string, unknown>>(baseUrl, "GET", "/v1/admin/workspaces/default/export", undefined, adminBearer);
    assert.equal(exported.status, 200);
    assert.equal(exported.body.workspace_id, "default");
  });

  it("serves dashboard shell, dashboard peer wrappers, and session detail compatibility", async () => {
    const adminBearer = adminToken("dashboard-admin");
    const dashboard = await fetch(baseUrl + "/dashboard");
    assert.equal(dashboard.status, 200);
    assert.match(await dashboard.text(), /HiveMem TypeScript compatibility dashboard/);

    const login = await request<Record<string, unknown>>(baseUrl, "POST", "/dashboard/login", { token: adminBearer }, adminBearer);
    assert.equal(login.status, 200);
    assert.equal(login.body.status, "ok");

    const cookie = { cookie: "hivemem_dash=" + encodeURIComponent(adminBearer) };
    const conclusion = await request<ConclusionRecord>(baseUrl, "POST", "/v1/peers/dashboard-peer/conclusions", {
      content: "Dashboard wrapper conclusion",
      kind: "manual",
      workspace_id: "default",
    }, adminBearer);
    assert.equal(conclusion.status, 201);

    const dashboardConclusions = await requestWithHeaders<ConclusionRecord[]>(baseUrl, "GET", "/dashboard/api/peers/dashboard-peer/conclusions?workspace_id=default", cookie);
    assert.equal(dashboardConclusions.status, 200);
    assert.equal(dashboardConclusions.body.some((item) => item.id === conclusion.body.id), true);

    const dashboardRepresentation = await requestWithHeaders<RepresentationResponse>(baseUrl, "GET", "/dashboard/api/peers/dashboard-peer/representation?workspace_id=default", cookie);
    assert.equal(dashboardRepresentation.status, 200);
    assert.equal(dashboardRepresentation.body.peer_id, "dashboard-peer");

    const dream = await requestWithHeaders<DreamScheduleResponse>(baseUrl, "POST", "/dashboard/api/peers/dashboard-peer/dream", cookie, { workspace_id: "default", reason: "dashboard-wrapper" });
    assert.equal(dream.status, 202);
    assert.equal(dream.body.task_type, "dream");

    const session = await request<SessionRecord>(baseUrl, "POST", "/v1/sessions", {
      session_id: "session-detail-compat",
      title: "Session Detail Compat",
      workspace_id: "default",
    }, adminBearer);
    assert.equal(session.status, 201);

    const fetched = await request<SessionRecord>(baseUrl, "GET", "/v1/sessions/session-detail-compat", undefined, adminBearer);
    assert.equal(fetched.status, 200);
    assert.equal(fetched.body.title, "Session Detail Compat");
  });

  it("serves embed, stats, and metrics compatibility", async () => {
    const embed = await request<EmbedResponse>(baseUrl, "POST", "/v1/embed", { texts: ["hive memory embedding smoke"] });
    assert.equal(embed.status, 200);
    assert.equal(embed.body.model, "hivemem-token-hash-v1");
    assert.equal(embed.body.dimensions, 768);
    assert.equal(embed.body.embeddings.length, 1);
    assert.equal(embed.body.embeddings[0]?.length, 768);

    const rejected = await request<{ detail: string }>(baseUrl, "POST", "/v1/embed", { texts: ["   "] });
    assert.equal(rejected.status, 400);
    assert.match(rejected.body.detail, /empty or whitespace-only/);

    const stats = await request<StatsResponse>(baseUrl, "GET", "/v1/stats");
    assert.equal(stats.status, 200);
    assert.equal(stats.body.memories >= 1, true);
    assert.equal(stats.body.queue_jobs >= 1, true);

    assert.equal((await fetch(baseUrl + "/metrics")).status, 401);
    assert.equal((await fetch(baseUrl + "/metrics", { headers: { authorization: `Bearer ${token("agent-a")}` } })).status, 403);
    const metrics = await fetch(baseUrl + "/metrics", { headers: { authorization: `Bearer ${adminToken("metrics-scraper")}` } });
    assert.equal(metrics.status, 200);
    assert.match(metrics.headers.get("content-type") ?? "", /text\/plain/);
    const text = await metrics.text();
    assert.match(text, /hivemem_ts_memories/);
    assert.match(text, /hivemem_ts_queue_jobs/);
  });

  it("serves episode and message compatibility with message extraction jobs", async () => {
    const episode = await request<EpisodeRecord>(baseUrl, "POST", "/v1/episodes", {
      episode_id: "episode-compact-compat",
      title: "Compact Compatibility",
      workspace_id: "default",
      session_id: "episode-session",
      peer_id: "user-compact",
      metadata: { source: "test" },
    });
    assert.equal(episode.status, 201);
    assert.equal(episode.body.episode_id, "episode-compact-compat");

    const listed = await request<EpisodeRecord[]>(baseUrl, "GET", "/v1/episodes?workspace_id=default");
    assert.equal(listed.status, 200);
    assert.equal(listed.body.some((item) => item.episode_id === "episode-compact-compat"), true);

    const message = await request<MessageRecord>(baseUrl, "POST", "/v1/episodes/episode-compact-compat/messages", {
      message_id: "episode-message-1",
      role: "user",
      content: "Remember that compact episode compatibility creates extraction jobs.",
      speaker_id: "user-compact",
      memory_type: "episodic",
      metadata: { turn: 1 },
    });
    assert.equal(message.status, 201);
    assert.equal(message.body.message_id, "episode-message-1");
    assert.equal(typeof message.body.memory_job_id, "string");

    const detail = await request<EpisodeMessagesResponse>(baseUrl, "GET", "/v1/episodes/episode-compact-compat");
    assert.equal(detail.status, 200);
    assert.equal(detail.body.episode.episode_id, "episode-compact-compat");
    assert.equal(detail.body.messages[0]?.message_id, "episode-message-1");

    const queue = await request<QueueStatusResponse>(baseUrl, "GET", "/v1/queue/status?task_type=message_extract&session_id=episode-session");
    assert.equal(queue.status, 200);
    assert.equal(queue.body.jobs.some((job) => job.id === message.body.memory_job_id), true);

    const hidden = await request<{ detail: string }>(baseUrl, "GET", "/v1/episodes/episode-compact-compat", undefined, token("agent-b"));
    assert.equal(hidden.status, 404);
  });

  it("serves workspace governance, resolved settings, and scoped memory compatibility", async () => {
    const workspace = await request<WorkspaceRecord>(baseUrl, "POST", "/v1/workspaces", {
      workspace_id: "ts-project-a",
      title: "TS Project A",
      metadata: { env: "test" },
      policy: {
        retention_days: 30,
        allowed_scopes: ["memories:read", "workspace:ts-project-a"],
        reasoning_provider: "local",
        consolidation_cadence_seconds: 3600,
        webhooks_enabled: true,
        sanitization: { mode: "warn", detect_pii: true, detect_secrets: true, deny_regexes: [] },
        agent_overrides: { "agent-b": { reasoning_provider: "ollama" } },
        session_overrides: { "session-a": { sanitization: { mode: "reject" } } },
      },
      members: [{ agent_id: "agent-v", role: "viewer", scopes: ["memories:read"] }],
    });
    assert.equal(workspace.status, 201);
    assert.equal(workspace.body.workspace_id, "ts-project-a");
    assert.equal(workspace.body.owner_agent_id, "agent-a");
    assert.equal(workspace.body.members.some((member) => member.agent_id === "agent-a" && member.role === "owner" && member.scopes.includes("*")), true);

    const listed = await request<WorkspaceRecord[]>(baseUrl, "GET", "/v1/workspaces");
    assert.equal(listed.status, 200);
    assert.equal(listed.body.some((item) => item.workspace_id === "ts-project-a"), true);

    const updated = await request<WorkspaceRecord>(baseUrl, "PUT", "/v1/workspaces/ts-project-a", { title: "TS Project A Updated" });
    assert.equal(updated.status, 200);
    assert.equal(updated.body.title, "TS Project A Updated");

    const memberAdded = await request<WorkspaceRecord>(baseUrl, "PUT", "/v1/workspaces/ts-project-a/members/agent-b", {
      role: "member",
      scopes: ["memories:read", "memories:write"],
    });
    assert.equal(memberAdded.status, 200);
    assert.equal(memberAdded.body.members.some((member) => member.agent_id === "agent-b" && member.role === "member"), true);

    const members = await request<WorkspaceMember[]>(baseUrl, "GET", "/v1/workspaces/ts-project-a/members");
    assert.equal(members.status, 200);
    assert.equal(members.body.some((member) => member.agent_id === "agent-v" && member.role === "viewer"), true);

    const settings = await request<WorkspaceResolvedSettings>(baseUrl, "GET", "/v1/workspaces/ts-project-a/settings?agent_id=agent-b&session_id=session-a");
    assert.equal(settings.status, 200);
    assert.deepEqual(settings.body.source_order, ["workspace", "agent:agent-b", "session:session-a"]);
    assert.equal(settings.body.policy.reasoning_provider, "ollama");
    assert.deepEqual(settings.body.policy.sanitization, { mode: "reject", detect_pii: true, detect_secrets: true, deny_regexes: [] });

    const memberToken = token("agent-b");
    const viewerToken = token("agent-v");
    const memory = await request<MemoryRecord>(
      baseUrl,
      "POST",
      "/v1/memories",
      {
        content: "Workspace-governed TS memory about routers.",
        type: "semantic",
        scope: "shared",
        workspace_id: "ts-project-a",
        tags: ["workspace", "router"],
      },
      memberToken,
    );
    assert.equal(memory.status, 201);

    const viewerWrite = await request<{ detail: string }>(
      baseUrl,
      "POST",
      "/v1/memories",
      { content: "viewer write", type: "semantic", scope: "shared", workspace_id: "ts-project-a" },
      viewerToken,
    );
    assert.equal(viewerWrite.status, 403);

    const missingWorkspaceWrite = await request<{ detail: string }>(baseUrl, "POST", "/v1/memories", {
      content: "missing workspace write",
      type: "semantic",
      scope: "shared",
      workspace_id: "missing-workspace",
    });
    assert.equal(missingWorkspaceWrite.status, 404);

    const search = await request<SearchResponse>(baseUrl, "POST", "/v1/memories/search", { query: "routers", scope: "shared", workspace_id: "ts-project-a" }, memberToken);
    assert.equal(search.status, 200);
    assert.equal(search.body.results.some((result) => result.memory.id === memory.body.id), true);

    const forgedDream = await request<{ detail: string }>(baseUrl, "POST", "/v1/workspaces/ts-project-a/schedule-dream", { peer_id: "agent-b", observer_peer_id: "agent-a" }, memberToken);
    assert.equal(forgedDream.status, 403);
    const dream = await request<DreamScheduleResponse>(
      baseUrl,
      "POST",
      "/v1/workspaces/ts-project-a/schedule-dream",
      { peer_id: "agent-b", observer_peer_id: "agent-b", session_id: "session-a", force: true, reason: "compat-test" },
      memberToken,
    );
    assert.equal(dream.status, 202);
    assert.equal(dream.body.task_type, "dream");
    assert.equal(dream.body.workspace_id, "ts-project-a");

    const dreamQueue = await request<QueueStatusResponse>(baseUrl, "GET", "/v1/queue/status?task_type=dream&workspace_id=ts-project-a", undefined, memberToken);
    assert.equal(dreamQueue.status, 200);
    assert.equal(dreamQueue.body.jobs.some((job) => job.id === dream.body.job_id), true);

    const removed = await request<WorkspaceRecord>(baseUrl, "DELETE", "/v1/workspaces/ts-project-a/members/agent-b");
    assert.equal(removed.status, 200);
    assert.equal(removed.body.members.some((member) => member.agent_id === "agent-b"), false);

    const afterRemove = await request<{ detail: string }>(baseUrl, "GET", "/v1/workspaces/ts-project-a", undefined, memberToken);
    assert.equal(afterRemove.status, 403);

    const deleted = await request<undefined>(baseUrl, "DELETE", "/v1/workspaces/ts-project-a");
    assert.equal(deleted.status, 204);

    const afterDelete = await request<{ detail: string }>(baseUrl, "GET", "/v1/workspaces/ts-project-a");
    assert.equal(afterDelete.status, 404);
  });

  it("serves webhook endpoint, test emit, delivery, and queue compatibility", async () => {
    const endpoint = await request<WebhookEndpointRecord>(baseUrl, "POST", "/v1/webhooks", {
      url: "https://example.com/hivemem",
      workspace_id: "default",
    });
    assert.equal(endpoint.status, 201);
    assert.equal(endpoint.body.has_secret, false);
    assert.equal("secret" in endpoint.body, false);
    assert.equal(endpoint.body.event_types.includes("memory.created"), true);
    assert.equal(endpoint.body.event_types.includes("webhook.test"), false);

    const listed = await request<WebhookEndpointRecord[]>(baseUrl, "GET", "/v1/webhooks?workspace_id=default");
    assert.equal(listed.status, 200);
    assert.equal(listed.body.some((item) => item.id === endpoint.body.id), true);

    const fetched = await request<WebhookEndpointRecord>(baseUrl, "GET", "/v1/webhooks/" + endpoint.body.id);
    assert.equal(fetched.status, 200);
    assert.equal(fetched.body.id, endpoint.body.id);

    const updated = await request<WebhookEndpointRecord>(baseUrl, "PUT", "/v1/webhooks/" + endpoint.body.id, {
      enabled: false,
      event_types: ["memory.created"],
      metadata: { updated: true },
    });
    assert.equal(updated.status, 200);
    assert.equal(updated.body.enabled, false);
    assert.deepEqual(updated.body.event_types, ["memory.created"]);
    assert.equal(updated.body.metadata.updated, true);

    const reenabled = await request<WebhookEndpointRecord>(baseUrl, "PUT", "/v1/webhooks/" + endpoint.body.id, { enabled: true });
    assert.equal(reenabled.status, 200);
    assert.equal(reenabled.body.enabled, true);

    const emitted = await request<WebhookTestEmitResponse>(baseUrl, "POST", "/v1/webhooks/test", { workspace_id: "default" });
    assert.equal(emitted.status, 202);
    assert.equal(emitted.body.queued_deliveries, 1);
    assert.equal(emitted.body.delivery_ids.length, 1);

    const delivery = await request<WebhookDeliveryRecord>(baseUrl, "GET", "/v1/webhooks/deliveries/" + emitted.body.delivery_ids[0]);
    assert.equal(delivery.status, 200);
    assert.equal(delivery.body.event_id, emitted.body.event_id);
    assert.equal(delivery.body.event_type, "webhook.test");

    const deliveries = await request<WebhookDeliveryListResponse>(baseUrl, "GET", "/v1/webhooks/deliveries?workspace_id=default");
    assert.equal(deliveries.status, 200);
    assert.equal(deliveries.body.total >= 1, true);

    for (const url of ["http://example.com/hivemem", "https://127.0.0.1:6333/collections", "https://169.254.169.254/latest/meta-data"]) {
      const rejected = await request<{ detail: string }>(baseUrl, "POST", "/v1/webhooks", { url, workspace_id: "default" });
      assert.equal(rejected.status, 400);
      assert.match(rejected.body.detail, /Webhook URL/);
    }

    const session = await request<SessionRecord>(baseUrl, "POST", "/v1/sessions", {
      session_id: "webhook-session",
      title: "Webhook Session",
      scope: "private",
      workspace_id: "default",
    });
    assert.equal(session.status, 201);

    const memory = await request<MemoryRecord>(baseUrl, "POST", "/v1/memories", {
      content: "Webhook delivery jobs should be queued for writes.",
      type: "semantic",
      scope: "private",
      workspace_id: "default",
      session_id: "webhook-session",
    });
    assert.equal(memory.status, 201);

    const afterWrites = await request<WebhookDeliveryListResponse>(baseUrl, "GET", "/v1/webhooks/deliveries?workspace_id=default");
    assert.equal(afterWrites.body.deliveries.some((item) => item.event_type === "memory.created"), true);
    assert.equal(afterWrites.body.deliveries.some((item) => item.event_type === "session.created" && item.endpoint_id === endpoint.body.id), false);

    const queue = await request<QueueStatusResponse>(baseUrl, "GET", "/v1/queue/status?task_type=webhook_delivery&workspace_id=default");
    assert.equal(queue.status, 200);
    assert.equal(queue.body.total >= 2, true);

    const deleted = await request<WebhookEndpointRecord>(baseUrl, "DELETE", "/v1/webhooks/" + endpoint.body.id);
    assert.equal(deleted.status, 200);
    assert.equal(deleted.body.enabled, false);
    assert.equal(typeof deleted.body.deleted_at, "string");

    const afterDelete = await request<{ detail: string }>(baseUrl, "GET", "/v1/webhooks/" + endpoint.body.id);
    assert.equal(afterDelete.status, 404);
  });

  it("serves dashboard webhook compatibility endpoints through the dashboard cookie", async () => {
    const cookie = { cookie: "hivemem_dash=" + encodeURIComponent(token("agent-a")) };
    const endpoint = await requestWithHeaders<WebhookEndpointRecord>(
      baseUrl,
      "POST",
      "/dashboard/api/webhooks",
      cookie,
      { url: "https://example.net/dashboard-webhook", workspace_id: "default" },
    );
    assert.equal(endpoint.status, 201);

    const listed = await requestWithHeaders<WebhookEndpointRecord[]>(baseUrl, "GET", "/dashboard/api/webhooks?workspace_id=default", cookie);
    assert.equal(listed.status, 200);
    assert.equal(listed.body.some((item) => item.id === endpoint.body.id), true);

    const emitted = await requestWithHeaders<WebhookTestEmitResponse>(baseUrl, "POST", "/dashboard/api/webhooks/test", cookie, { workspace_id: "default" });
    assert.equal(emitted.status, 202);
    assert.equal(emitted.body.queued_deliveries >= 1, true);

    const deliveries = await requestWithHeaders<WebhookDeliveryListResponse>(baseUrl, "GET", "/dashboard/api/webhooks/deliveries?workspace_id=default", cookie);
    assert.equal(deliveries.status, 200);
    assert.equal(deliveries.body.deliveries.some((item) => emitted.body.delivery_ids.includes(item.id)), true);
  });

  it("creates sessions and builds session-scoped context", async () => {
    const session = await request<SessionRecord>(baseUrl, "POST", "/v1/sessions", {
      session_id: "deploy-review",
      title: "Deploy review",
      scope: "private",
      workspace_id: "default",
    });
    assert.equal(session.status, 201);
    assert.equal(session.body.session_id, "deploy-review");

    const memory = await request<MemoryRecord>(baseUrl, "POST", "/v1/memories", {
      content: "The secondary host should be updated after the primary is verified.",
      type: "episodic",
      scope: "private",
      session_id: "deploy-review",
      workspace_id: "default",
      tags: ["secondary-host", "deploy"],
      sensitivity: "sensitive",
    });
    assert.equal(memory.status, 201);

    const sessionMemories = await request<MemoryRecord[]>(baseUrl, "GET", "/v1/sessions/deploy-review/memories");
    assert.equal(sessionMemories.body.length, 1);

    const context = await request<ContextResponse>(baseUrl, "POST", "/v1/sessions/deploy-review/context", {
      search_query: "secondary host verified",
      workspace_id: "default",
      max_memories: 4,
      include_sensitive: true,
    });
    assert.equal(context.status, 200);
    assert.equal(context.body.memories.length, 1);
    assert.match(context.body.formatted_context.content, /secondary host/);
  });
});
