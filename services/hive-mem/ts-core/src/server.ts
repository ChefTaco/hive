import type { JsonValue } from "./types.js";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { timingSafeEqual } from "node:crypto";
import { AuthError, isUsableSigningSecret, MAX_TOKEN_LINEAGE, parentTokenIds, signToken, verifyBearerToken } from "./auth.js";
import { DEFAULT_AGENT_SCOPES } from "./issue-token.js";
import { InMemoryHiveMemStore } from "./store.js";
import type { AuthPrincipal, ChatResponse } from "./types.js";
import { ValidationError } from "./validation.js";
import { TokenRevocationStore } from "./revocation-store.js";
import { memoryOperations } from './operations.js';

export interface HiveMemServerOptions {
  jwtSecret?: string;
  renewalSecret?: string;
  store?: InMemoryHiveMemStore;
  maxBodyBytes?: number;
  revocationFilePath?: string;
  /** Static bearer token accepted on `/metrics` in addition to admin JWTs. */
  metricsToken?: string;
  /** Serve `/metrics` without credentials to loopback clients only. */
  metricsAllowLoopback?: boolean;
}

class PayloadTooLargeError extends Error {
  readonly status = 413;
}

const responseStores = new WeakMap<ServerResponse, InMemoryHiveMemStore>();
const responseAudits = new WeakMap<ServerResponse, { principal: AuthPrincipal; path: string; method: string; requestId: string }>();

async function sendNoContent(response: ServerResponse): Promise<void> {
  const audit = responseAudits.get(response);
  if (audit) responseStores.get(response)?.recordOperation('api.mutation', audit.principal, { path: audit.path, method: audit.method, request_id: audit.requestId, status: 204 });
  await responseStores.get(response)?.flushPersistence();
  response.writeHead(204); response.end();
}

async function sendJson(response: ServerResponse, status: number, body: unknown): Promise<void> {
  if (status >= 200 && status < 300) {
    const audit = responseAudits.get(response);
    if (audit && !(body && typeof body === "object" && "dry_run" in body && body.dry_run === true)) responseStores.get(response)?.recordOperation("api.mutation", audit.principal, { path: audit.path, method: audit.method, request_id: audit.requestId, status });
    await responseStores.get(response)?.flushPersistence();
  }
  const payload = JSON.stringify(body);
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(payload),
  });
  response.end(payload);
}

async function sendJsonWithHeaders(response: ServerResponse, status: number, body: unknown, headers: Record<string, string>): Promise<void> {
  if (status >= 200 && status < 300) await responseStores.get(response)?.flushPersistence();
  const payload = JSON.stringify(body);
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(payload),
    ...headers,
  });
  response.end(payload);
}

function sendText(response: ServerResponse, status: number, contentType: string, body: string): void {
  response.writeHead(status, {
    "content-type": contentType,
    "content-length": Buffer.byteLength(body),
  });
  response.end(body);
}

async function readBody(request: IncomingMessage, maxBodyBytes = Number.parseInt(process.env.HIVEMEM_MAX_BODY_BYTES ?? "1048576", 10)): Promise<unknown> {
  const configuredLimit = (request as IncomingMessage & { hiveMaxBodyBytes?: number }).hiveMaxBodyBytes ?? maxBodyBytes;
  const declaredLength = Number.parseInt(request.headers["content-length"] ?? "0", 10);
  if (Number.isFinite(declaredLength) && declaredLength > configuredLimit) {
    request.resume();
    throw new PayloadTooLargeError(`Request body exceeds ${configuredLimit} bytes`);
  }
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of request) {
    const buffer = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
    total += buffer.length;
    if (total > configuredLimit) {
      request.resume();
      throw new PayloadTooLargeError(`Request body exceeds ${configuredLimit} bytes`);
    }
    chunks.push(buffer);
  }
  if (chunks.length === 0) return {};
  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw.trim()) return {};
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    throw new SyntaxError("Invalid JSON request body");
  }
}

function auth(request: IncomingMessage, secret: string, isRevoked: (jti: string) => boolean, store: InMemoryHiveMemStore): AuthPrincipal {
  const header = Array.isArray(request.headers.authorization) ? request.headers.authorization[0] : request.headers.authorization;
  const principal = verifyBearerToken(header, secret, { isRevoked });
  store.assertCredentialActive(principal);
  return principal;
}

function cookieValue(request: IncomingMessage, name: string): string | undefined {
  const raw = request.headers.cookie;
  if (!raw) return undefined;
  for (const part of raw.split(";")) {
    const [key, ...valueParts] = part.trim().split("=");
    if (key === name) return decodeURIComponent(valueParts.join("="));
  }
  return undefined;
}

function dashboardCookieAuth(request: IncomingMessage, secret: string, isRevoked: (jti: string) => boolean, store: InMemoryHiveMemStore): AuthPrincipal {
  const token = cookieValue(request, "hivemem_dash");
  const principal = verifyBearerToken(token ? `Bearer ${token}` : undefined, secret, { isRevoked });
  const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);
  store.assertCredentialActive(principal);
  const apiPath = url.pathname.replace(/^\/dashboard\/api/u, "/v1");
  const neededScope = requiredScope(request.method ?? "GET", apiPath);
  if (neededScope) requireScope(principal, neededScope);
  return principal;
}

function listConclusions(store: InMemoryHiveMemStore, principal: AuthPrincipal, peerId: string, params: URLSearchParams): unknown {
  const paginate = params.get("paginate") === "true" || params.has("cursor");
  return paginate ? store.listPeerConclusionsPage(principal, peerId, params) : store.listPeerConclusions(principal, peerId, params);
}

function isLoopbackAddress(address: string | undefined): boolean {
  if (!address) return false;
  return address === "::1" || address.startsWith("127.") || address.startsWith("::ffff:127.");
}

function authorizeMetrics(
  request: IncomingMessage,
  options: {
    jwtSecret: string;
    isRevoked: (jti: string) => boolean;
    store: InMemoryHiveMemStore;
    metricsToken: string | undefined;
    metricsAllowLoopback: boolean;
  },
): void {
  if (options.metricsAllowLoopback && isLoopbackAddress(request.socket.remoteAddress)) return;
  const header = Array.isArray(request.headers.authorization) ? request.headers.authorization[0] : request.headers.authorization;
  if (!header?.startsWith("Bearer ")) throw new AuthError(401, "Missing bearer token");
  const supplied = header.slice("Bearer ".length).trim();
  if (options.metricsToken) {
    const expected = Buffer.from(options.metricsToken);
    const actual = Buffer.from(supplied);
    if (expected.length === actual.length && timingSafeEqual(expected, actual)) return;
  }
  const principal = auth(request, options.jwtSecret, options.isRevoked, options.store);
  if (!isAdminPrincipal(principal)) throw new AuthError(403, "Admin role or metrics token required");
}

function isAdminPrincipal(principal: AuthPrincipal): boolean {
  return principal.rawClaims.role === "admin" || principal.scopes.includes("admin:all");
}

function scopeMatches(granted: string, required: string): boolean {
  if (granted === "*" || granted === required) return true;
  if (!granted.endsWith(":*")) return false;
  return required.startsWith(granted.slice(0, -1));
}

function requireScope(principal: AuthPrincipal, required: string): void {
  if (isAdminPrincipal(principal) || principal.scopes.some((scope) => scopeMatches(scope, required))) return;
  throw new AuthError(403, `${required} scope is required`);
}

function requiredScope(method: string, pathname: string): string | null {
  if (pathname.startsWith("/v1/auth/")) return null;
  if (pathname.startsWith("/v1/admin/") || pathname === "/v1/backup" || pathname === "/v1/restore") return "admin:all";
  if (pathname.startsWith("/v1/queue/")) return method === "GET" ? "queue:read" : "admin:queue";
  if (pathname.startsWith("/v1/agents")) {
    if (method === "GET") return "agents:read";
    return pathname === "/v1/agents/register" ? "agents:write" : "admin:agents";
  }
  if (pathname.startsWith("/v1/workspaces")) return method === "GET" ? "workspaces:read" : "workspaces:write";
  if (pathname.startsWith("/v1/sessions")) return method === "GET" ? "sessions:read" : "sessions:write";
  if (pathname.startsWith("/v1/context") || pathname.startsWith("/v1/chat")) return "context:read";
  if (pathname.startsWith("/v1/knowledge/")) return method === "GET" ? "memories:read" : "memories:write";
  if (pathname.startsWith("/v1/memories") || pathname.startsWith("/v1/episodes") || pathname.startsWith("/v1/graph") || pathname.startsWith("/v1/peers") || pathname.startsWith("/v1/conclusions") || pathname.startsWith("/v1/archive")) {
    return method === "GET" ? "memories:read" : "memories:write";
  }
  if (pathname.startsWith("/v1/webhooks")) return method === "GET" ? "webhooks:read" : "webhooks:write";
  if (pathname === "/v1/stats") return "memories:read";
  if (pathname === "/v1/embed" || pathname.startsWith("/v1/lifecycle") || pathname.startsWith("/v1/reasoning")) return "memories:write";
  return null;
}

function pathId(pathname: string, prefix: string): string | undefined {
  if (!pathname.startsWith(prefix)) return undefined;
  const rest = pathname.slice(prefix.length);
  if (!rest || rest.includes("/")) return undefined;
  return decodeURIComponent(rest);
}

function pathParts(pathname: string): string[] {
  return pathname.split("/").filter(Boolean).map((part) => decodeURIComponent(part));
}

function pagination(searchParams: URLSearchParams, defaultLimit: number, maxLimit: number): { offset: number; limit: number } {
  const offset = Math.max(0, Number.parseInt(searchParams.get("offset") ?? "0", 10) || 0);
  const rawLimit = Number.parseInt(searchParams.get("limit") ?? String(defaultLimit), 10) || defaultLimit;
  return { offset, limit: Math.min(Math.max(1, rawLimit), maxLimit) };
}

function paged<T>(items: readonly T[], offset: number, limit: number): { results: T[]; total: number; offset: number; limit: number } {
  return { results: items.slice(offset, offset + limit), total: items.length, offset, limit };
}

async function healthPayload(store: InMemoryHiveMemStore) {
  const persistence = await store.persistenceHealth();
  const worker = store.workerHealth();
  const timestamp = new Date().toISOString();
  return {
    status: persistence.ready && worker.ready ? "ok" : "degraded",
    service: "hivemem-ts-core",
    implementation: "typescript",
    persistence,
    worker,
    capabilities: store.capabilities(),
    timestamp,
    checks: [
      { name: "store", status: persistence.ready ? "pass" : "fail", message: persistence.mode },
      { name: "worker", status: worker.ready ? "pass" : "fail", message: worker.state },
      { name: "embedding", status: "pass", message: store.capabilities().embedding },
    ],
  };
}

function liveHealthPayload() {
  return {
    status: "ok",
    service: "hivemem-ts-core",
    implementation: "typescript",
    timestamp: new Date().toISOString(),
    checks: [{ name: "process", status: "pass", message: "running" }],
  };
}

function queueRunbook(job: ReturnType<InMemoryHiveMemStore['getQueueJob']>, principal: AuthPrincipal): Record<string, unknown> {
  const canManage = isAdminPrincipal(principal) || principal.scopes.includes('admin:queue');
  const retryable = canManage && ['failed', 'dead_letter', 'cancelled'].includes(job.status);
  const runnable = canManage && ['pending', 'failed', 'dead_letter'].includes(job.status);
  const cancellable = canManage && ['pending', 'failed', 'dead_letter'].includes(job.status);
  const action = retryable ? '/retry' : runnable ? '/run' : '';
  return {
    job,
    logs: {
      error: job.error,
      result: job.result,
      timestamps: {
        created_at: job.created_at,
        started_at: job.started_at,
        finished_at: job.finished_at,
        locked_at: job.locked_at,
      },
    },
    actions: [...(runnable ? ['run'] : []), ...(retryable ? ['retry'] : []), ...(cancellable ? ['cancel'] : []), 'inspect', 'copy_curl'],
    curl: `curl --request ${action ? 'POST' : 'GET'} "$HIVEMEM_API_URL/v1/queue/jobs/${encodeURIComponent(job.id)}${action}" --header "Authorization: Bearer $HIVEMEM_TOKEN"`,
  };
}

function sseEvent(event: string, data: unknown): string {
  return "event: " + event + "\ndata: " + JSON.stringify(data) + "\n\n";
}

function sendChatSse(response: ServerResponse, chat: ChatResponse): void {
  response.writeHead(200, { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache" });
  response.write(sseEvent("message_start", { reasoning_level: chat.reasoning_level, session_id: chat.session_id, workspace_id: chat.workspace_id }));
  const chunkSize = 120;
  for (let index = 0; index < chat.answer.length; index += chunkSize) {
    response.write(sseEvent("answer_chunk", chat.answer.slice(index, index + chunkSize)));
  }
  for (const source of chat.sources) response.write(sseEvent("source", source));
  response.write(sseEvent("done", { usage: chat.usage, processed_at: chat.processed_at }));
  response.end();
}

function wantsStream(body: unknown): boolean {
  return Boolean(body && typeof body === "object" && !Array.isArray(body) && "stream" in body && body.stream === true);
}

const defaultAgentScopes = DEFAULT_AGENT_SCOPES;

function safeAgentScopes(value: unknown): string[] {
  const scopes = Array.isArray(value) && value.every((scope) => typeof scope === "string") ? value : defaultAgentScopes;
  if (scopes.some((scope) => scope === "*" || scope.startsWith("admin:"))) throw new ValidationError("Agent tokens cannot receive wildcard or admin scopes");
  return [...new Set(scopes)];
}

function tokenWorkspaces(raw: Record<string, unknown>): Record<string, JsonValue> {
  if (raw.workspace_ids === undefined) return {};
  if (!Array.isArray(raw.workspace_ids) || raw.workspace_ids.length === 0 || raw.workspace_ids.some((value) => typeof value !== "string" || !value || value === "*")) throw new ValidationError("workspace_ids requires explicit workspace IDs");
  return { workspace_ids: raw.workspace_ids as string[] };
}
function tokenExpiry(raw: Record<string, unknown>): number {
  const hours = typeof raw.expires_hours === "number" && Number.isFinite(raw.expires_hours) ? Math.max(1, Math.min(720, raw.expires_hours)) : 24;
  let expiry = Math.floor(Date.now() / 1000 + hours * 3600);
  if (raw.expires_at !== undefined) {
    const deadline = typeof raw.expires_at === "string" ? Date.parse(raw.expires_at) : NaN;
    if (!Number.isFinite(deadline) || deadline <= Date.now() + 1000) throw new ValidationError("expires_at must be a future timestamp");
    expiry = Math.min(expiry, Math.floor(deadline / 1000));
  }
  return expiry;
}
function agentRegistrationToken(body: unknown, jwtSecret: string): string {
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new ValidationError("agent registration must be an object");
  const raw = body as Record<string, unknown>;
  const agentId = typeof raw.agent_id === "string" ? raw.agent_id : undefined;
  if (!agentId) throw new ValidationError("agent_id is required");
  const scopes = safeAgentScopes(raw.token_scopes).join(" ");
  return signToken(jwtSecret, { sub: agentId, role: "agent", scope: scopes, ...tokenWorkspaces(raw), exp: tokenExpiry(raw) });
}
function loginResponse(token: string, principal: AuthPrincipal): Record<string, unknown> {
  return {
    token,
    access_token: token,
    token_type: "bearer",
    agent_id: principal.agentId,
    role: typeof principal.rawClaims.role === "string" ? principal.rawClaims.role : "agent",
    scopes: [...principal.scopes],
    expires_at: typeof principal.rawClaims.exp === "number" ? new Date(principal.rawClaims.exp * 1000).toISOString() : null,
  };
}

function tokenFromBody(body: unknown): string | null {
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  const raw = body as Record<string, unknown>;
  return typeof raw.token === "string" && raw.token.trim() ? raw.token.trim() : null;
}

function issueTokenFromBody(body: unknown, principal: AuthPrincipal, jwtSecret: string, store: InMemoryHiveMemStore): Record<string, unknown> {
  if (!isAdminPrincipal(principal)) throw new AuthError(403, "Admin role is required to issue tokens");
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new ValidationError("token request must be an object");
  const raw = body as Record<string, unknown>;
  const agentId = typeof raw.agent_id === "string" && raw.agent_id.trim() ? raw.agent_id.trim() : principal.agentId;
  const scopes = safeAgentScopes(raw.scopes ?? raw.token_scopes);
  const exp = tokenExpiry(raw);
  const workspaces = tokenWorkspaces(raw);
  const generation = raw.rotate_previous === true ? store.rotateAgentCredentials(principal, agentId) : store.credentialGeneration(agentId);
  store.assertCredentialActive({ agentId, scopes, rawClaims: { token_generation: generation } });
  const token = signToken(jwtSecret, { sub: agentId, role: "agent", scope: scopes.join(" "), exp, token_generation: generation, ...workspaces });
  return { token, access_token: token, token_type: "bearer", agent_id: agentId, scopes, expires_at: new Date(exp * 1000).toISOString() };
}

function errorStatus(error: unknown): number {
  if (error instanceof ValidationError) return error.status;
  if (error instanceof SyntaxError) return 400;
  if (error && typeof error === "object" && "status" in error && typeof error.status === "number") return error.status;
  return 500;
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return "Internal server error";
}

export type HiveMemRequestHandler = (request: IncomingMessage, response: ServerResponse) => void;

export function createHiveMemHandler(options: HiveMemServerOptions = {}): HiveMemRequestHandler {
  const jwtSecret = options.jwtSecret ?? process.env.HIVEMEM_JWT_SECRET;
  const renewalSecret = options.renewalSecret ?? process.env.HIVEMEM_RENEWAL_SECRET;
  if (!isUsableSigningSecret(jwtSecret)) {
    throw new Error("HIVEMEM_JWT_SECRET must be a non-placeholder secret of at least 32 bytes");
  }
  if (renewalSecret && (Buffer.byteLength(renewalSecret) < 32 || renewalSecret === jwtSecret)) {
    throw new Error("HIVEMEM_RENEWAL_SECRET must be independent and at least 32 bytes");
  }
  const maxBodyBytes = options.maxBodyBytes ?? Number.parseInt(process.env.HIVEMEM_MAX_BODY_BYTES ?? "1048576", 10);
  if (!Number.isInteger(maxBodyBytes) || maxBodyBytes < 1024) throw new Error("HIVEMEM_MAX_BODY_BYTES must be an integer of at least 1024");
  const store = options.store ?? new InMemoryHiveMemStore();
  const revocations = new TokenRevocationStore(options.revocationFilePath ?? process.env.HIVEMEM_REVOCATION_FILE);
  const isRevoked = (jti: string) => revocations.has(jti);
  const metricsToken = options.metricsToken ?? (process.env.HIVEMEM_METRICS_TOKEN || undefined);
  const metricsAllowLoopback = options.metricsAllowLoopback ?? process.env.HIVEMEM_METRICS_ALLOW_LOOPBACK === "true";
  if (metricsToken !== undefined && metricsToken.length < 32) throw new Error("HIVEMEM_METRICS_TOKEN must be at least 32 characters");

  return async (request, response) => {
    try {
      (request as IncomingMessage & { hiveMaxBodyBytes?: number }).hiveMaxBodyBytes = maxBodyBytes;
      const host = request.headers.host ?? "localhost";
      const url = new URL(request.url ?? "/", `http://${host}`);
      const method = request.method ?? "GET";

      if (method === "GET" && url.pathname === "/metrics") {
        authorizeMetrics(request, { jwtSecret, isRevoked, store, metricsToken, metricsAllowLoopback });
        sendText(response, 200, "text/plain; version=0.0.4; charset=utf-8", store.metricsText());
        return;
      }

      if (method === "GET" && url.pathname === "/") {
        await sendJson(response, 200, { status: "ok", service: "hivemem-ts-core", implementation: "typescript" });
        return;
      }

      if (!url.pathname.startsWith("/v1/health") && url.pathname !== "/metrics" && url.pathname !== "/") responseStores.set(response, store);
      if (responseStores.has(response)) await store.flushPersistence();

      if (method === "POST" && url.pathname === "/v1/auth/login") {
        const body = await readBody(request, maxBodyBytes);
        const suppliedToken = tokenFromBody(body);
        if (!suppliedToken) throw new ValidationError("token is required for TypeScript compatibility login");
        const principal = verifyBearerToken("Bearer " + suppliedToken, jwtSecret, { isRevoked });
        store.assertCredentialActive(principal);
        await sendJson(response, 200, loginResponse(suppliedToken, principal));
        return;
      }

      if (method === "POST" && url.pathname === "/v1/auth/renew") {
        if (!renewalSecret) throw new AuthError(503, "Token renewal is not configured");
        const header = Array.isArray(request.headers.authorization) ? request.headers.authorization[0] : request.headers.authorization;
        const grant = verifyBearerToken(header, renewalSecret, { audience: "hivemem-renewal", tokenType: "renewal", isRevoked });
        if (grant.rawClaims.renewal_version !== 1 || grant.rawClaims.role !== "agent") throw new AuthError(401, "Invalid renewal grant");
        store.assertCredentialActive(grant);
        const scopes = safeAgentScopes([...grant.scopes]);
        const exp = Math.min(Number(grant.rawClaims.exp), Math.floor(Date.now() / 1000) + 30 * 86400);
        const token = signToken(jwtSecret, {
          sub: grant.agentId, role: "agent", scope: scopes.join(" "), exp,
          token_generation: store.credentialGeneration(grant.agentId),
          ...(grant.rawClaims.workspace_ids ? { workspace_ids: grant.rawClaims.workspace_ids } : {}),
        });
        store.recordOperation('auth.renew', grant, { expires_at: new Date(exp * 1000).toISOString() });
        await sendJson(response, 200, { token, access_token: token, token_type: "bearer", agent_id: grant.agentId, expires_at: new Date(exp * 1000).toISOString() });
        return;
      }

      if (method === "GET" && url.pathname === "/v1/health") {
        const health = await healthPayload(store);
        await sendJson(response, health.status === "ok" ? 200 : 503, health);
        return;
      }
      if (method === "GET" && url.pathname === "/v1/health/live") {
        await sendJson(response, 200, liveHealthPayload());
        return;
      }
      if (method === "GET" && (url.pathname === "/v1/health/ready" || url.pathname === "/v1/health/dependencies")) {
        const health = await healthPayload(store);
        await sendJson(response, health.status === "ok" ? 200 : 503, health);
        return;
      }

      if (method === "GET" && (url.pathname === "/dashboard" || url.pathname.startsWith("/dashboard/memories/"))) {
        sendText(response, 200, "text/html; charset=utf-8", `<!doctype html><title>HiveMem TS Dashboard</title><main data-hivemem-dashboard="typescript-compatibility">HiveMem TypeScript compatibility dashboard</main>`);
        return;
      }
      if (method === "POST" && url.pathname === "/dashboard/login") {
        const body = await readBody(request, maxBodyBytes);
        const suppliedToken = tokenFromBody(body);
        if (!suppliedToken) throw new ValidationError("token is required");
        store.assertCredentialActive(verifyBearerToken("Bearer " + suppliedToken, jwtSecret, { isRevoked }));
        await sendJsonWithHeaders(response, 200, { status: "ok" }, { "set-cookie": "hivemem_dash=" + encodeURIComponent(suppliedToken) + "; HttpOnly; Secure; SameSite=Strict; Path=/dashboard; Max-Age=86400" });
        return;
      }

      if (url.pathname.startsWith("/dashboard/api/webhooks")) {
        const principal = dashboardCookieAuth(request, jwtSecret, isRevoked, store);
        if (method === "GET" && url.pathname === "/dashboard/api/webhooks") {
          await sendJson(response, 200, store.listWebhooks(principal, url.searchParams));
          return;
        }
        if (method === "POST" && url.pathname === "/dashboard/api/webhooks") {
          await sendJson(response, 201, store.createWebhook(principal, await readBody(request)));
          return;
        }
        if (method === "POST" && url.pathname === "/dashboard/api/webhooks/test") {
          await sendJson(response, 202, store.testWebhook(principal, await readBody(request)));
          return;
        }
        if (method === "GET" && url.pathname === "/dashboard/api/webhooks/deliveries") {
          await sendJson(response, 200, store.listWebhookDeliveries(principal, url.searchParams));
          return;
        }
      }

      if (url.pathname.startsWith("/dashboard/api/queue/")) {
        const principal = dashboardCookieAuth(request, jwtSecret, isRevoked, store);
        if (method === "GET" && url.pathname === "/dashboard/api/queue/status") {
          await sendJson(response, 200, store.queueStatus(principal, url.searchParams));
          return;
        }
        if (method === "POST" && url.pathname === "/dashboard/api/queue/run-next") {
          await sendJson(response, 200, await store.runNextQueueJob(principal, url.searchParams));
          return;
        }
        const dashboardRunId = url.pathname.endsWith("/run") ? pathId(url.pathname.slice(0, -"/run".length), "/dashboard/api/queue/jobs/") : undefined;
        if (dashboardRunId && method === "POST") {
          await sendJson(response, 200, await store.runQueueJob(principal, dashboardRunId));
          return;
        }
        const dashboardRetryId = url.pathname.endsWith("/retry") ? pathId(url.pathname.slice(0, -"/retry".length), "/dashboard/api/queue/jobs/") : undefined;
        if (dashboardRetryId && method === "POST") {
          await sendJson(response, 200, store.retryQueueJob(principal, dashboardRetryId));
          return;
        }
        const dashboardRunbookId = url.pathname.endsWith("/runbook") ? pathId(url.pathname.slice(0, -"/runbook".length), "/dashboard/api/queue/jobs/") : undefined;
        if (dashboardRunbookId && method === "GET") {
          await sendJson(response, 200, queueRunbook(store.getQueueJob(principal, dashboardRunbookId), principal));
          return;
        }
        const dashboardJobId = pathId(url.pathname, "/dashboard/api/queue/jobs/");
        if (dashboardJobId && method === "GET") {
          await sendJson(response, 200, store.getQueueJob(principal, dashboardJobId));
          return;
        }
        if (dashboardJobId && method === "DELETE") {
          await sendJson(response, 200, store.cancelQueueJob(principal, dashboardJobId));
          return;
        }
      }

      if (url.pathname.startsWith("/dashboard/api/sessions")) {
        const principal = dashboardCookieAuth(request, jwtSecret, isRevoked, store);
        if (method === "GET" && url.pathname === "/dashboard/api/sessions") {
          const { offset, limit } = pagination(url.searchParams, 20, 100);
          await sendJson(response, 200, paged(store.listSessions(principal, url.searchParams), offset, limit));
          return;
        }
        const dashboardSessionMemoriesId = url.pathname.endsWith("/memories") ? pathId(url.pathname.slice(0, -"/memories".length), "/dashboard/api/sessions/") : undefined;
        if (dashboardSessionMemoriesId && method === "GET") {
          const { offset, limit } = pagination(url.searchParams, 20, 100);
          await sendJson(response, 200, paged(store.getSessionMemories(principal, dashboardSessionMemoriesId), offset, limit));
          return;
        }
      }
      if (method === "GET" && url.pathname === "/dashboard/api/memory-options") {
        const principal = dashboardCookieAuth(request, jwtSecret, isRevoked, store);
        await sendJson(response, 200, store.dashboardMemoryOptions(principal));
        return;
      }
      if (method === "GET" && url.pathname === "/dashboard/api/graph/neighborhood") {
        const principal = dashboardCookieAuth(request, jwtSecret, isRevoked, store);
        await sendJson(response, 200, store.graphNeighborhood(principal, url.searchParams));
        return;
      }
      if (method === "GET" && url.pathname === "/dashboard/api/command-palette") {
        const principal = dashboardCookieAuth(request, jwtSecret, isRevoked, store);
        await sendJson(response, 200, store.commandPalette(principal));
        return;
      }
      if (method === "GET" && url.pathname === "/dashboard/api/conflicts") {
        const principal = dashboardCookieAuth(request, jwtSecret, isRevoked, store);
        await sendJson(response, 200, store.dashboardConflicts(principal, url.searchParams));
        return;
      }
      const dashboardConflictId = url.pathname.endsWith("/resolve") ? pathId(url.pathname.slice(0, -"/resolve".length), "/dashboard/api/conflicts/") : undefined;
      if (dashboardConflictId && method === "POST") {
        const principal = dashboardCookieAuth(request, jwtSecret, isRevoked, store);
        await sendJson(response, 200, store.resolveDashboardConflict(principal, dashboardConflictId, await readBody(request)));
        return;
      }
      if (method === "GET" && url.pathname === "/dashboard/api/consolidation/status") {
        const principal = dashboardCookieAuth(request, jwtSecret, isRevoked, store);
        await sendJson(response, 200, store.consolidationStatus(principal, url.searchParams));
        return;
      }
      if (method === "GET" && url.pathname === "/dashboard/api/consolidation/logs") {
        const principal = dashboardCookieAuth(request, jwtSecret, isRevoked, store);
        await sendJson(response, 200, store.consolidationLogs(principal, url.searchParams));
        return;
      }
      const dashboardConsolidationRunId = pathId(url.pathname, "/dashboard/api/consolidation/logs/");
      if (dashboardConsolidationRunId && method === "GET") {
        const principal = dashboardCookieAuth(request, jwtSecret, isRevoked, store);
        await sendJson(response, 200, store.consolidationLog(principal, dashboardConsolidationRunId));
        return;
      }
      if (method === "POST" && url.pathname === "/dashboard/api/lifecycle/retention/apply") {
        const principal = dashboardCookieAuth(request, jwtSecret, isRevoked, store);
        await sendJson(response, 200, store.applyRetention(principal, await readBody(request)));
        return;
      }
      if (method === "POST" && url.pathname === "/dashboard/api/lifecycle/forget-me") {
        const principal = dashboardCookieAuth(request, jwtSecret, isRevoked, store);
        await sendJson(response, 200, store.forgetSubject(principal, await readBody(request)));
        return;
      }
      if (method === "POST" && url.pathname === "/dashboard/api/archive/search") {
        const principal = dashboardCookieAuth(request, jwtSecret, isRevoked, store);
        await sendJson(response, 200, store.searchArchive(principal, await readBody(request)));
        return;
      }
      if (method === "POST" && url.pathname === "/dashboard/api/memories/compactions") {
        const principal = dashboardCookieAuth(request, jwtSecret, isRevoked, store);
        await sendJson(response, 201, store.createCompaction(principal, await readBody(request)));
        return;
      }
      if (method === "POST" && url.pathname === "/dashboard/api/memories/negotiations") {
        const principal = dashboardCookieAuth(request, jwtSecret, isRevoked, store);
        await sendJson(response, 202, store.createNegotiation(principal, await readBody(request)));
        return;
      }
      if (method === "POST" && url.pathname === "/dashboard/api/memories/multimodal") {
        const principal = dashboardCookieAuth(request, jwtSecret, isRevoked, store);
        await sendJson(response, 200, store.createMultimodalReference(principal, await readBody(request)));
        return;
      }
      if (method === "POST" && url.pathname === "/dashboard/api/memories/critic/review") {
        const principal = dashboardCookieAuth(request, jwtSecret, isRevoked, store);
        await sendJson(response, 200, store.criticReview(principal, await readBody(request)));
        return;
      }
      if (method === "POST" && url.pathname === "/dashboard/api/reasoning/providers/compare") {
        const principal = dashboardCookieAuth(request, jwtSecret, isRevoked, store);
        await sendJson(response, 200, store.compareReasoningProviders(principal));
        return;
      }
      if (url.pathname.startsWith("/dashboard/api/peers/")) {
        const principal = dashboardCookieAuth(request, jwtSecret, isRevoked, store);
        const parts = pathParts(url.pathname);
        const peerId = parts[3];
        if (peerId && parts.length === 5 && parts[4] === "conclusions" && method === "GET") {
          await sendJson(response, 200, listConclusions(store, principal, peerId, url.searchParams));
          return;
        }
        if (peerId && parts.length === 5 && parts[4] === "representation" && method === "GET") {
          await sendJson(response, 200, store.peerRepresentation(principal, peerId, url.searchParams));
          return;
        }
        if (peerId && parts.length === 5 && parts[4] === "dream" && method === "POST") {
          await sendJson(response, 202, store.schedulePeerDream(principal, peerId, await readBody(request)));
          return;
        }
      }

      if (method === "POST" && url.pathname === "/dashboard/api/context/preview") {
        const principal = dashboardCookieAuth(request, jwtSecret, isRevoked, store);
        await sendJson(response, 200, store.context(principal, await readBody(request)));
        return;
      }

      if (method === "POST" && url.pathname === "/dashboard/api/search/explain") {
        const principal = dashboardCookieAuth(request, jwtSecret, isRevoked, store);
        await sendJson(response, 200, store.search(principal, await readBody(request), true));
        return;
      }

      if (url.pathname.startsWith("/dashboard/api/agents/")) {
        const principal = dashboardCookieAuth(request, jwtSecret, isRevoked, store);
        const dashboardAgentMemoriesId = url.pathname.endsWith("/memories") ? pathId(url.pathname.slice(0, -"/memories".length), "/dashboard/api/agents/") : undefined;
        if (dashboardAgentMemoriesId && method === "GET") {
          const { offset, limit } = pagination(url.searchParams, 10, 100);
          const memories = store.listAgentMemories(principal, dashboardAgentMemoriesId, url.searchParams);
          await sendJson(response, 200, {
            ...paged(memories, offset, limit),
            agent_id: dashboardAgentMemoriesId,
            is_own: dashboardAgentMemoriesId === principal.agentId,
            can_modify: dashboardAgentMemoriesId === principal.agentId || principal.rawClaims.role === "admin",
          });
          return;
        }
      }

      if (url.pathname.startsWith("/dashboard/api/memories")) {
        const principal = dashboardCookieAuth(request, jwtSecret, isRevoked, store);
        if (method === "POST" && url.pathname === "/dashboard/api/memories") {
          const body = await readBody(request);
          if (body && typeof body === "object" && !Array.isArray(body) && "agent_id" in body && body.agent_id !== principal.agentId) {
            await sendJson(response, 403, { detail: "Authenticate as the selected agent to create its memories" });
            return;
          }
          await sendJson(response, 201, store.createMemory(principal, body));
          return;
        }
        const dashboardDetailId = url.pathname.endsWith("/detail") ? pathId(url.pathname.slice(0, -"/detail".length), "/dashboard/api/memories/") : undefined;
        if (dashboardDetailId && method === "GET") {
          await sendJson(response, 200, store.describeMemory(principal, dashboardDetailId));
          return;
        }
        const dashboardMemoryId = pathId(url.pathname, "/dashboard/api/memories/");
        if (dashboardMemoryId && method === "GET") {
          await sendJson(response, 200, store.getMemory(principal, dashboardMemoryId));
          return;
        }
        if (dashboardMemoryId && method === "PUT") {
          await sendJson(response, 200, store.updateMemory(principal, dashboardMemoryId, await readBody(request)));
          return;
        }
        if (dashboardMemoryId && method === "DELETE") {
          store.deleteMemory(principal, dashboardMemoryId);
          await sendJson(response, 200, { status: "deleted", id: dashboardMemoryId });
          return;
        }
      }

      const principal = auth(request, jwtSecret, isRevoked, store);
      responseStores.set(response, store);
      await store.flushPersistence();
      const neededScope = requiredScope(method, url.pathname);
      if (neededScope) requireScope(principal, neededScope);
      if (!["GET", "HEAD"].includes(method) && !/search|context|chat|browse|embed/.test(url.pathname)) responseAudits.set(response, { principal, path: url.pathname, method, requestId: String(request.headers["x-hive-request-id"] ?? "").slice(0, 128) });

      if (method === "GET" && url.pathname === "/v1/capabilities") { await sendJson(response, 200, store.capabilities()); return; }
      if (method === 'GET' && url.pathname === '/v1/capabilities/operations') { await sendJson(response, 200, { operations: memoryOperations }); return; }

      if (method === "GET" && url.pathname === "/v1/auth/me") {
        await sendJson(response, 200, store.authPrincipal(principal));
        return;
      }
      if (method === "POST" && url.pathname === "/v1/auth/tokens") {
        await sendJson(response, 201, issueTokenFromBody(await readBody(request), principal, jwtSecret, store));
        return;
      }
      if (method === "POST" && url.pathname === "/v1/auth/renewal-grants") {
        if (!renewalSecret) throw new AuthError(503, "Token renewal is not configured");
        if (!isAdminPrincipal(principal)) throw new AuthError(403, "Admin role is required to issue renewal grants");
        const body = await readBody(request);
        if (!body || typeof body !== "object" || Array.isArray(body)) throw new ValidationError("renewal grant request must be an object");
        const raw = body as Record<string, unknown>;
        const agentId = typeof raw.agent_id === "string" ? raw.agent_id.trim() : "";
        if (!agentId) throw new ValidationError("agent_id is required");
        if (!Array.isArray(raw.scopes) || raw.scopes.length === 0 || raw.scopes.some((scope) => typeof scope !== "string" || !scope.trim())) throw new ValidationError("explicit scopes are required");
        const scopes = safeAgentScopes(raw.scopes);
        const workspaces = tokenWorkspaces(raw);
        const hours = typeof raw.expires_hours === "number" && Number.isFinite(raw.expires_hours)
          ? Math.max(1, Math.min(8760, raw.expires_hours)) : 8760;
        const exp = Math.floor(Date.now() / 1000 + hours * 3600);
        const generation = store.credentialGeneration(agentId);
        store.assertCredentialActive({ agentId, scopes, rawClaims: { token_generation: generation } });
        const grant = signToken(renewalSecret, {
          aud: "hivemem-renewal", token_type: "renewal", renewal_version: 1,
          sub: agentId, role: "agent", scope: scopes.join(" "), ...workspaces,
          token_generation: generation, exp,
        });
        await sendJson(response, 201, { grant, agent_id: agentId, expires_at: new Date(exp * 1000).toISOString() });
        return;
      }
      if (method === "GET" && url.pathname === "/v1/auth/tokens") {
        await sendJson(response, 200, store.tokenInventory(principal));
        return;
      }
      if (method === "POST" && url.pathname === "/v1/auth/revoke") {
        const suppliedToken = tokenFromBody(await readBody(request, maxBodyBytes));
        if (!suppliedToken) throw new ValidationError("token is required");
        const target = verifyBearerToken(`Bearer ${suppliedToken}`, jwtSecret);
        if (!isAdminPrincipal(principal) && target.agentId !== principal.agentId) throw new AuthError(403, "Cannot revoke another agent's token");
        const jti = target.rawClaims.jti;
        const exp = target.rawClaims.exp;
        if (typeof jti !== "string" || typeof exp !== "number") throw new AuthError(400, "Token cannot be revoked");
        revocations.add(jti, exp);
        await sendJson(response, 200, { revoked: true, revoked_at: new Date().toISOString() });
        return;
      }
      if (method === "POST" && url.pathname === "/v1/auth/refresh") {
        const now = Math.floor(Date.now() / 1000);
        const parentExp = typeof principal.rawClaims.exp === "number" ? principal.rawClaims.exp : now;
        const exp = Math.min(parentExp, now + 3600);
        const parentJti = typeof principal.rawClaims.jti === "string" ? principal.rawClaims.jti : undefined;
        const lineage = [...parentTokenIds(principal.rawClaims), ...(parentJti ? [parentJti] : [])];
        if (lineage.length > MAX_TOKEN_LINEAGE) throw new AuthError(400, "Token refresh chain is too long; request a new token");
        const newToken = signToken(jwtSecret, {
          sub: principal.agentId,
          scope: principal.scopes.join(" "),
          ...(principal.rawClaims.workspace_ids ? { workspace_ids: principal.rawClaims.workspace_ids } : {}),
          token_generation: store.credentialGeneration(principal.agentId),
          ...(typeof principal.rawClaims.role === "string" ? { role: principal.rawClaims.role } : {}),
          parent_jtis: lineage,
          exp,
        });
        await sendJson(response, 200, { token: newToken, access_token: newToken, token_type: "bearer", expires_at: new Date(exp * 1000).toISOString() });
        return;
      }
      if (method === "GET" && url.pathname === "/v1/admin/audit") {
        await sendJson(response, 200, store.adminAudit(principal, url.searchParams));
        return;
      }
      if (method === "POST" && url.pathname === "/v1/backup") {
        await sendJson(response, 200, store.backup(principal));
        return;
      }
      if (method === "POST" && url.pathname === "/v1/restore") {
        await sendJson(response, 200, store.restore(principal));
        return;
      }
      if (method === "POST" && url.pathname === "/v1/admin/test-data/cleanup") {
        await sendJson(response, 200, store.cleanupTestData(principal));
        return;
      }
      if (method === "POST" && url.pathname === "/v1/admin/prune") {
        await sendJson(response, 200, store.adminPrune(principal));
        return;
      }
      const workspaceExportId = url.pathname.endsWith("/export") ? pathId(url.pathname.slice(0, -"/export".length), "/v1/admin/workspaces/") : undefined;
      if (workspaceExportId && method === "GET") {
        await sendJson(response, 200, store.exportWorkspace(principal, workspaceExportId));
        return;
      }
      const workspaceImportId = url.pathname.endsWith("/import") ? pathId(url.pathname.slice(0, -"/import".length), "/v1/admin/workspaces/") : undefined;
      if (workspaceImportId && method === "POST") {
        await sendJson(response, 200, store.importWorkspace(principal, workspaceImportId));
        return;
      }
      const workspacePruneId = url.pathname.endsWith("/prune") ? pathId(url.pathname.slice(0, -"/prune".length), "/v1/admin/workspaces/") : undefined;
      if (workspacePruneId && method === "POST") {
        await sendJson(response, 200, store.pruneWorkspace(principal, workspacePruneId, url.searchParams.get("dry_run") !== "false"));
        return;
      }

      if (method === "POST" && url.pathname === "/v1/embed") {
        await sendJson(response, 200, store.embedTexts(await readBody(request)));
        return;
      }
      if (method === "GET" && url.pathname === "/v1/stats") {
        await sendJson(response, 200, store.stats());
        return;
      }
      if (method === "POST" && (url.pathname === "/v1/memories/search/text" || url.pathname === "/v1/memories/search/hybrid")) {
        await sendJson(response, 200, await store.searchWithMode(principal, await readBody(request), url.searchParams.get("explain") === "true"));
        return;
      }
      if (method === "POST" && url.pathname === "/v1/memories/conflicts") {
        await sendJson(response, 200, store.detectConflicts(principal, await readBody(request)));
        return;
      }

      if (url.pathname.startsWith("/v1/peers/") || url.pathname.startsWith("/v1/conclusions/")) {
        const parts = pathParts(url.pathname);
        if (parts[1] === "conclusions" && parts[2] && parts.length === 3 && method === "GET") {
          await sendJson(response, 200, store.getConclusion(principal, parts[2], url.searchParams.get("include_history") === "true"));
          return;
        }
        if (parts[1] === "conclusions" && parts[2] && parts.length === 3 && method === "DELETE") {
          store.deleteConclusion(principal, parts[2]);
          await sendNoContent(response);
          return;
        }
        const peerId = parts[2];
        if (parts[1] === "peers" && peerId && parts.length === 4 && parts[3] === "conclusions" && method === "POST") {
          await sendJson(response, 201, store.createConclusion(principal, peerId, await readBody(request)));
          return;
        }
        if (parts[1] === "peers" && peerId && parts.length === 4 && parts[3] === "conclusions" && method === "GET") {
          await sendJson(response, 200, listConclusions(store, principal, peerId, url.searchParams));
          return;
        }
        if (parts[1] === "peers" && peerId && parts.length === 5 && parts[3] === "conclusions" && parts[4] === "query" && method === "POST") {
          await sendJson(response, 200, store.queryPeerConclusions(principal, peerId, await readBody(request)));
          return;
        }
        if (parts[1] === "peers" && peerId && parts.length === 4 && (parts[3] === "representation" || parts[3] === "context") && method === "GET") {
          await sendJson(response, 200, store.peerRepresentation(principal, peerId, url.searchParams));
          return;
        }
        if (parts[1] === "peers" && peerId && parts.length === 4 && parts[3] === "card" && method === "GET") {
          await sendJson(response, 200, store.getPeerCard(principal, peerId, url.searchParams));
          return;
        }
        if (parts[1] === "peers" && peerId && parts.length === 4 && parts[3] === "card" && method === "POST") {
          await sendJson(response, 201, store.upsertPeerCard(principal, peerId, await readBody(request)));
          return;
        }
        if (parts[1] === "peers" && peerId && parts.length === 5 && parts[3] === "card" && parts[4] === "rebuild" && method === "POST") {
          await sendJson(response, 202, store.schedulePeerDream(principal, peerId, await readBody(request)));
          return;
        }
        if (parts[1] === "peers" && peerId && parts.length === 5 && parts[3] === "card" && parts[4] === "review" && method === "POST") {
          await sendJson(response, 200, store.reviewPeerCard(principal, peerId, url.searchParams));
          return;
        }
        if (parts[1] === "peers" && peerId && parts.length === 5 && parts[3] === "card" && method === "PUT") {
          await sendJson(response, 200, store.replacePeerCard(principal, peerId, parts[4]!, await readBody(request)));
          return;
        }
        if (parts[1] === "peers" && peerId && parts.length === 5 && parts[3] === "card" && method === "DELETE") {
          store.deletePeerCard(principal, peerId, parts[4]!);
          await sendNoContent(response);
          return;
        }
        if (parts[1] === "peers" && peerId && parts.length === 4 && parts[3] === "dream" && method === "POST") {
          await sendJson(response, 202, store.schedulePeerDream(principal, peerId, await readBody(request)));
          return;
        }
      }


      if (url.pathname.startsWith("/v1/episodes")) {
        const parts = pathParts(url.pathname);
        if (method === "GET" && parts.length === 2) {
          await sendJson(response, 200, store.listEpisodes(principal, url.searchParams));
          return;
        }
        if (method === "POST" && parts.length === 2) {
          await sendJson(response, 201, store.createEpisode(principal, await readBody(request)));
          return;
        }
        const episodeId = parts[2];
        if (episodeId && parts.length === 3 && method === "GET") {
          await sendJson(response, 200, store.getEpisode(principal, episodeId));
          return;
        }
        if (episodeId && parts.length === 4 && parts[3] === "messages" && method === "POST") {
          await sendJson(response, 201, store.appendEpisodeMessage(principal, episodeId, await readBody(request)));
          return;
        }
      }

      if (url.pathname.startsWith("/v1/agents")) {
        const parts = pathParts(url.pathname);
        if (method === "POST" && parts.length === 3 && parts[2] === "register") {
          const body = await readBody(request);
          await sendJson(response, 201, store.registerAgent(principal, body, agentRegistrationToken(body, jwtSecret)));
          return;
        }
        if (method === "GET" && parts.length === 2) {
          await sendJson(response, 200, store.listAgents(principal));
          return;
        }
        const agentId = parts[2];
        if (agentId && parts.length === 3 && method === "GET") {
          await sendJson(response, 200, store.getAgent(principal, agentId));
          return;
        }
        if (agentId && parts.length === 3 && method === "PATCH") {
          await sendJson(response, 200, store.updateAgent(principal, agentId, await readBody(request)));
          return;
        }
        if (agentId && parts.length === 4 && parts[3] === "profile" && method === "GET") {
          await sendJson(response, 200, store.agentProfile(principal, agentId));
          return;
        }
        if (agentId && parts.length === 4 && parts[3] === "bundle" && method === "GET") {
          await sendJson(response, 200, store.exportAgentBundle(principal, agentId));
          return;
        }
        if (agentId && parts.length === 4 && parts[3] === "bundle" && method === "POST") {
          await sendJson(response, 200, store.importAgentBundle(principal, agentId, await readBody(request)));
          return;
        }
      }

      if (url.pathname.startsWith("/v1/workspaces")) {
        const parts = pathParts(url.pathname);
        if (method === "GET" && parts.length === 2) {
          await sendJson(response, 200, store.listWorkspaces(principal, url.searchParams));
          return;
        }
        if (method === "POST" && parts.length === 2) {
          await sendJson(response, 201, store.createWorkspace(principal, await readBody(request)));
          return;
        }
        const workspaceId = parts[2];
        if (workspaceId && parts.length === 3 && method === "GET") {
          await sendJson(response, 200, store.getWorkspace(principal, workspaceId, url.searchParams.get("include_deleted") === "true"));
          return;
        }
        if (workspaceId && parts.length === 3 && method === "PUT") {
          await sendJson(response, 200, store.updateWorkspace(principal, workspaceId, await readBody(request)));
          return;
        }
        if (workspaceId && parts.length === 3 && method === "DELETE") {
          store.deleteWorkspace(principal, workspaceId);
          await sendNoContent(response);
          return;
        }
        if (workspaceId && parts.length === 4 && parts[3] === "members" && method === "GET") {
          await sendJson(response, 200, store.listWorkspaceMembers(principal, workspaceId));
          return;
        }
        if (workspaceId && parts.length === 5 && parts[3] === "members" && method === "PUT") {
          await sendJson(response, 200, store.upsertWorkspaceMember(principal, workspaceId, parts[4]!, await readBody(request)));
          return;
        }
        if (workspaceId && parts.length === 5 && parts[3] === "members" && method === "DELETE") {
          await sendJson(response, 200, store.removeWorkspaceMember(principal, workspaceId, parts[4]!));
          return;
        }
        if (workspaceId && parts.length === 4 && parts[3] === "settings" && method === "GET") {
          await sendJson(response, 200, store.workspaceSettings(principal, workspaceId, url.searchParams));
          return;
        }
        if (workspaceId && parts.length === 4 && parts[3] === "schedule-dream" && method === "POST") {
          await sendJson(response, 202, store.scheduleWorkspaceDream(principal, workspaceId, await readBody(request)));
          return;
        }
      }

      if (method === "GET" && url.pathname === "/v1/graph/entities") {
        await sendJson(response, 200, store.listGraphEntities(principal, url.searchParams));
        return;
      }
      if (method === "GET" && url.pathname === "/v1/graph/relations") {
        await sendJson(response, 200, store.listGraphRelations(principal, url.searchParams));
        return;
      }
      if (method === "GET" && url.pathname === "/v1/graph/neighborhood") {
        await sendJson(response, 200, store.graphNeighborhood(principal, url.searchParams));
        return;
      }
      const graphEntityId = pathId(url.pathname, "/v1/graph/entities/");
      if (graphEntityId && method === "GET") {
        await sendJson(response, 200, store.graphEntityPage(principal, graphEntityId, url.searchParams));
        return;
      }

      if (method === "GET" && url.pathname === "/v1/webhooks") {
        await sendJson(response, 200, store.listWebhooks(principal, url.searchParams));
        return;
      }
      if (method === "POST" && url.pathname === "/v1/webhooks") {
        await sendJson(response, 201, store.createWebhook(principal, await readBody(request)));
        return;
      }
      if (method === "POST" && url.pathname === "/v1/webhooks/test") {
        await sendJson(response, 202, store.testWebhook(principal, await readBody(request)));
        return;
      }
      if (method === "GET" && url.pathname === "/v1/webhooks/deliveries") {
        await sendJson(response, 200, store.listWebhookDeliveries(principal, url.searchParams));
        return;
      }
      const webhookDeliveryId = pathId(url.pathname, "/v1/webhooks/deliveries/");
      if (webhookDeliveryId && method === "GET") {
        await sendJson(response, 200, store.getWebhookDelivery(principal, webhookDeliveryId));
        return;
      }
      const webhookEndpointId = pathId(url.pathname, "/v1/webhooks/");
      if (webhookEndpointId && method === "GET") {
        await sendJson(response, 200, store.getWebhook(principal, webhookEndpointId));
        return;
      }
      if (webhookEndpointId && method === "PUT") {
        await sendJson(response, 200, store.updateWebhook(principal, webhookEndpointId, await readBody(request)));
        return;
      }
      if (webhookEndpointId && method === "DELETE") {
        await sendJson(response, 200, store.deleteWebhook(principal, webhookEndpointId));
        return;
      }

      if (method === "POST" && url.pathname === "/v1/memories/consolidate") {
        await sendJson(response, 200, store.consolidateMemories(principal, await readBody(request)));
        return;
      }
      if (method === "POST" && url.pathname === "/v1/memories/promote") {
        await sendJson(response, 200, store.promoteMemory(principal, await readBody(request)));
        return;
      }
      if (method === "POST" && url.pathname === "/v1/memories/privatize") {
        await sendJson(response, 200, store.privatizeMemory(principal, await readBody(request)));
        return;
      }
      if (method === "POST" && url.pathname === "/v1/memories/forgetting/review") {
        await sendJson(response, 202, store.scheduleForgettingReview(principal, await readBody(request)));
        return;
      }
      if (method === "POST" && url.pathname === "/v1/lifecycle/retention/apply") {
        await sendJson(response, 200, store.applyRetention(principal, await readBody(request)));
        return;
      }
      if (method === "POST" && url.pathname === "/v1/lifecycle/forget-me") {
        await sendJson(response, 200, store.forgetSubject(principal, await readBody(request)));
        return;
      }
      if (method === "POST" && url.pathname === "/v1/archive/search") {
        await sendJson(response, 200, store.searchArchive(principal, await readBody(request)));
        return;
      }
      if (method === "POST" && url.pathname === "/v1/memories/compactions") {
        await sendJson(response, 201, store.createCompaction(principal, await readBody(request)));
        return;
      }
      if (method === "POST" && url.pathname === "/v1/memories/negotiations") {
        await sendJson(response, 202, store.createNegotiation(principal, await readBody(request)));
        return;
      }
      if (method === "POST" && url.pathname === "/v1/memories/multimodal") {
        await sendJson(response, 200, store.createMultimodalReference(principal, await readBody(request)));
        return;
      }
      if (method === "POST" && url.pathname === "/v1/memories/critic/review") {
        await sendJson(response, 200, store.criticReview(principal, await readBody(request)));
        return;
      }
      if (method === "POST" && url.pathname === "/v1/reasoning/providers/compare") {
        await sendJson(response, 200, store.compareReasoningProviders(principal));
        return;
      }

      if (method === "POST" && url.pathname === "/v1/memories") {
        await sendJson(response, 201, store.createMemory(principal, await readBody(request)));
        return;
      }
      if (method === "POST" && url.pathname === "/v1/memories/batch") {
        await sendJson(response, 201, store.createMemories(principal, await readBody(request)));
        return;
      }
      if (method === "POST" && url.pathname === "/v1/knowledge/sources/sync") {
        const result = store.syncKnowledgeSource(principal, await readBody(request));
        await sendJson(response, result.mode === "apply" ? 201 : 200, result);
        return;
      }
      if (method === "GET" && url.pathname === "/v1/memories/browse") {
        await sendJson(response, 200, store.browse(principal, url.searchParams));
        return;
      }
      if (method === "POST" && url.pathname === "/v1/admin/purge") { await sendJson(response, 200, store.purgeMemories(principal, await readBody(request))); return; }
      if (method === "POST" && url.pathname === "/v1/memories/search") {
        await sendJson(response, 200, await store.searchWithMode(principal, await readBody(request), url.searchParams.get("explain") === "true"));
        return;
      }

      const memoryDiffId = url.pathname.endsWith("/diff") ? pathId(url.pathname.slice(0, -"/diff".length), "/v1/memories/") : undefined;
      if (memoryDiffId && method === "GET") {
        await sendJson(response, 200, store.memoryDiff(principal, memoryDiffId));
        return;
      }
      const memoryGraphId = url.pathname.endsWith("/graph") ? pathId(url.pathname.slice(0, -"/graph".length), "/v1/memories/") : undefined;
      if (memoryGraphId && method === "GET") {
        await sendJson(response, 200, store.memoryGraph(principal, memoryGraphId));
        return;
      }
      const memoryEndorseId = url.pathname.endsWith("/endorse") ? pathId(url.pathname.slice(0, -"/endorse".length), "/v1/memories/") : undefined;
      if (memoryEndorseId && method === "POST") {
        await sendJson(response, 200, store.endorseMemory(principal, memoryEndorseId, await readBody(request)));
        return;
      }

      const relatedMemoryId = url.pathname.endsWith("/related") ? pathId(url.pathname.slice(0, -"/related".length), "/v1/memories/") : undefined;
      if (relatedMemoryId && method === "GET") {
        await sendJson(response, 200, store.getRelatedMemories(principal, relatedMemoryId, url.searchParams));
        return;
      }
      const memoryId = pathId(url.pathname, "/v1/memories/");
      if (memoryId && method === "GET") {
        await sendJson(response, 200, store.getMemory(principal, memoryId, url.searchParams.get("include_history") === "true"));
        return;
      }
      if (memoryId && method === "PUT") {
        await sendJson(response, 200, store.updateMemory(principal, memoryId, await readBody(request)));
        return;
      }
      if (memoryId && method === "DELETE") {
        store.deleteMemory(principal, memoryId);
        await sendNoContent(response);
        return;
      }

      if (method === "POST" && url.pathname === "/v1/sessions") {
        await sendJson(response, 201, store.createSession(principal, await readBody(request)));
        return;
      }
      if (method === "GET" && url.pathname === "/v1/sessions") {
        await sendJson(response, 200, store.listSessions(principal, url.searchParams));
        return;
      }
      if (method === "POST" && url.pathname === "/v1/chat") {
        const body = await readBody(request);
        const chat = store.chat(principal, body);
        if (wantsStream(body)) sendChatSse(response, chat);
        else sendJson(response, 200, chat);
        return;
      }
      if (method === "POST" && url.pathname === "/v1/context") {
        await sendJson(response, 200, store.context(principal, await readBody(request)));
        return;
      }
      const queueOperationId = pathId(url.pathname, '/v1/queue/operations/');
      if (queueOperationId && method === 'GET') {
        await sendJson(response, 200, store.getQueueOperation(principal, queueOperationId, url.searchParams));
        return;
      }
      if (method === "GET" && url.pathname === "/v1/queue/status") {
        await sendJson(response, 200, store.queueStatus(principal, url.searchParams));
        return;
      }
      if (method === "POST" && url.pathname === "/v1/queue/run-next") {
        await sendJson(response, 200, await store.runNextQueueJob(principal, url.searchParams));
        return;
      }
      const queueRunId = url.pathname.endsWith("/run") ? pathId(url.pathname.slice(0, -"/run".length), "/v1/queue/jobs/") : undefined;
      if (queueRunId && method === "POST") {
        await sendJson(response, 200, await store.runQueueJob(principal, queueRunId));
        return;
      }
      const queueJobId = pathId(url.pathname, "/v1/queue/jobs/");
      if (queueJobId && method === "GET") {
        await sendJson(response, 200, store.getQueueJob(principal, queueJobId));
        return;
      }
      const queueRetryId = url.pathname.endsWith("/retry") ? pathId(url.pathname.slice(0, -"/retry".length), "/v1/queue/jobs/") : undefined;
      if (queueRetryId && method === "POST") {
        await sendJson(response, 200, store.retryQueueJob(principal, queueRetryId));
        return;
      }
      const queueCancelId = pathId(url.pathname, "/v1/queue/jobs/");
      if (queueCancelId && method === "DELETE") {
        await sendJson(response, 200, store.cancelQueueJob(principal, queueCancelId));
        return;
      }

      const sessionChatId = url.pathname.endsWith("/chat") ? pathId(url.pathname.slice(0, -"/chat".length), "/v1/sessions/") : undefined;
      if (sessionChatId && method === "POST") {
        const body = await readBody(request);
        const chat = store.chat(principal, body, sessionChatId);
        if (wantsStream(body)) sendChatSse(response, chat);
        else sendJson(response, 200, chat);
        return;
      }
      const sessionMemoriesId = url.pathname.endsWith("/memories") ? pathId(url.pathname.slice(0, -"/memories".length), "/v1/sessions/") : undefined;
      if (sessionMemoriesId && method === "GET") {
        await sendJson(response, 200, store.getSessionMemories(principal, sessionMemoriesId));
        return;
      }
      const sessionContextId = url.pathname.endsWith("/context") ? pathId(url.pathname.slice(0, -"/context".length), "/v1/sessions/") : undefined;
      if (sessionContextId && method === "POST") {
        await sendJson(response, 200, store.context(principal, await readBody(request), sessionContextId));
        return;
      }
      const sessionId = pathId(url.pathname, "/v1/sessions/");
      if (sessionId && method === "GET") {
        await sendJson(response, 200, store.getSession(principal, sessionId));
        return;
      }
      if (sessionId && method === "PUT") {
        await sendJson(response, 200, store.updateSession(principal, sessionId, await readBody(request)));
        return;
      }
      if (sessionId && method === "DELETE") {
        store.deleteSession(principal, sessionId);
        await sendNoContent(response);
        return;
      }

      await sendJson(response, 404, { detail: "Not found" });
    } catch (error) {
      const status = errorStatus(error);
      const detail = status >= 500 && !(error instanceof Error && error.name === "UnsupportedOperationError") ? "Internal server error" : errorMessage(error);
      if (status >= 500) console.error(error);
      await sendJson(response, status, { detail });
    }
  };
}

export function createHiveMemServer(options: HiveMemServerOptions = {}): Server {
  return createServer(createHiveMemHandler(options));
}

export type { AuthError };
