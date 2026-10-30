import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { createHiveMemServer, signToken } from "../src/index.js";

const jwtSecret = "dual_stack_test_secret_32_bytes_or_more";
const runId = "dual-" + Date.now().toString(36);

interface Target {
  name: string;
  baseUrl: string;
  token: string;
  close?: () => Promise<void>;
}

interface HttpResult<T> {
  status: number;
  body: T;
}

function token(agentId: string, secret = jwtSecret): string {
  return signToken(secret, {
    sub: agentId,
    role: "admin",
    scope: "admin:queue memories:read memories:write sessions:read sessions:write context:read",
    exp: Math.floor(Date.now() / 1000) + 3600,
  });
}

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  return "http://127.0.0.1:" + address.port;
}

async function request<T>(target: Target, method: string, path: string, body?: unknown): Promise<HttpResult<T>> {
  const headers: Record<string, string> = { authorization: "Bearer " + target.token, accept: "application/json" };
  if (body !== undefined) headers["content-type"] = "application/json";
  const init: RequestInit = { method, headers };
  if (body !== undefined) init.body = JSON.stringify(body);
  const response = await fetch(target.baseUrl + path, init);
  const parsed = response.status === 204 ? undefined : ((await response.json()) as T);
  return { status: response.status, body: parsed as T };
}

function pythonTargetFromEnv(): Target | null {
  const env = process.env;
  const baseUrl = env.HIVEMEM_DUALSTACK_PYTHON_URL?.replace(/\/+$/u, "");
  if (!baseUrl) return null;
  const suppliedToken = env.HIVEMEM_DUALSTACK_TOKEN ?? env.HIVEMEM_TOKEN;
  const secret = env.HIVEMEM_DUALSTACK_JWT_SECRET ?? env.HIVEMEM_JWT_SECRET;
  const mintedToken = secret ? token(env.HIVEMEM_DUALSTACK_AGENT_ID ?? "dual-stack-agent", secret) : null;
  const targetToken = suppliedToken ?? mintedToken;
  if (!targetToken) return null;
  return { name: "python", baseUrl, token: targetToken };
}

async function createTypeScriptTarget(): Promise<Target> {
  const server = createHiveMemServer({ jwtSecret });
  const baseUrl = await listen(server);
  return {
    name: "typescript",
    baseUrl,
    token: token("dual-stack-agent"),
    close: () => {
      server.closeAllConnections();
      return new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    },
  };
}

async function exerciseCommonContract(target: Target): Promise<void> {
  const workspaceId = runId + "-" + target.name;
  const sessionId = workspaceId + "-session";
  const episodeId = workspaceId + "-episode";

  const health = await fetch(target.baseUrl + "/v1/health/ready");
  assert.equal(health.status, 200, target.name + " ready health");
  const healthBody = (await health.json()) as { status?: unknown; checks?: unknown };
  assert.equal(healthBody.status, "ok", target.name + " ready status");

  const workspace = await request<Record<string, unknown>>(target, "POST", "/v1/workspaces", {
    workspace_id: workspaceId,
    title: "Dual Stack " + target.name,
    members: [],
  });
  assert.equal(workspace.status === 201 || workspace.status === 200, true, target.name + " workspace create");
  assert.equal(workspace.body.workspace_id, workspaceId);

  const session = await request<Record<string, unknown>>(target, "POST", "/v1/sessions", {
    session_id: sessionId,
    title: "Dual Stack Session",
    scope: "private",
    workspace_id: workspaceId,
  });
  assert.equal(session.status, 201, target.name + " session create");
  assert.equal(session.body.session_id, sessionId);

  const memory = await request<Record<string, unknown>>(target, "POST", "/v1/memories", {
    content: "Dual stack compatibility memory for " + target.name + " " + runId,
    type: "semantic",
    scope: "private",
    workspace_id: workspaceId,
    session_id: sessionId,
    tags: ["dual-stack", target.name, runId],
  });
  assert.equal(memory.status, 201, target.name + " memory create");
  assert.equal(typeof memory.body.id, "string");

  const browse = await request<Record<string, unknown>>(target, "GET", "/v1/memories/browse?workspace_id=" + encodeURIComponent(workspaceId) + "&limit=5");
  assert.equal(browse.status, 200, target.name + " browse");
  assert.equal(Array.isArray(browse.body.memories) || Array.isArray(browse.body.results), true, target.name + " browse list shape");

  const search = await request<{ results?: Array<{ memory?: { id?: string } }> }>(target, "POST", "/v1/memories/search", {
    query: runId,
    workspace_id: workspaceId,
    limit: 5,
  });
  assert.equal(search.status, 200, target.name + " search");
  assert.equal(search.body.results?.some((item) => item.memory?.id === memory.body.id), true, target.name + " search finds created memory");

  const context = await request<Record<string, unknown>>(target, "POST", "/v1/context", {
    search_query: runId,
    workspace_id: workspaceId,
    max_memories: 3,
  });
  assert.equal(context.status, 200, target.name + " context");
  assert.equal(Array.isArray(context.body.memories), true, target.name + " context memories");

  const episode = await request<Record<string, unknown>>(target, "POST", "/v1/episodes", {
    episode_id: episodeId,
    workspace_id: workspaceId,
    session_id: sessionId,
    title: "Dual Stack Episode",
  });
  assert.equal(episode.status, 201, target.name + " episode create");

  const message = await request<Record<string, unknown>>(target, "POST", "/v1/episodes/" + encodeURIComponent(episodeId) + "/messages", {
    message_id: episodeId + "-message",
    role: "user",
    content: "Dual stack episode message " + runId,
    memory_type: "episodic",
  });
  assert.equal(message.status, 201, target.name + " message create");
  assert.equal(typeof message.body.memory_job_id === "string" || message.body.memory_job_id === null, true, target.name + " message memory job shape");

  const queue = await request<Record<string, unknown>>(target, "GET", "/v1/queue/status?workspace_id=" + encodeURIComponent(workspaceId));
  assert.equal(queue.status, 200, target.name + " queue status");
  assert.equal(Array.isArray(queue.body.jobs), true, target.name + " queue jobs shape");
}

describe("HiveMem dual-stack REST compatibility", () => {
  const targets: Target[] = [];

  before(async () => {
    targets.push(await createTypeScriptTarget());
    const python = pythonTargetFromEnv();
    if (python) targets.push(python);
  });

  after(async () => {
    await Promise.all(targets.map((target) => target.close?.()));
  });

  it("exercises the common REST contract on every configured implementation", async () => {
    assert.equal(targets.length >= 1, true);
    for (const target of targets) await exerciseCommonContract(target);
  });

  it("documents live Python coverage configuration", () => {
    if (targets.some((target) => target.name === "python")) return;
    assert.equal(process.env.HIVEMEM_DUALSTACK_PYTHON_URL, undefined, "set HIVEMEM_DUALSTACK_PYTHON_URL plus HIVEMEM_DUALSTACK_TOKEN or HIVEMEM_DUALSTACK_JWT_SECRET to include Python HiveMem in this suite");
  });
});
