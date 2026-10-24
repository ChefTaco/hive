import { ContextPackage } from "./context.js";
import { HiveMemHTTPError } from "./errors.js";
import type {
  ConclusionPage,
  ConclusionRecord,
  ContextResponse,
  HiveMemOptions,
  KnowledgeSourceSyncResponse,
  MemoryRecord,
  PeerCardResponse,
  QueueJobRecord,
  QueueStatusResponse,
  SearchResponse,
  SessionRecord,
  WebhookEndpoint,
} from "./types.js";

function env(name: string): string | undefined {
  const proc = globalThis as unknown as { process?: { env?: Record<string, string | undefined> } };
  return proc.process?.env?.[name];
}

export class HiveMem {
  readonly baseUrl: string;
  token?: string;
  readonly workspaceId: string;
  readonly timeoutMs: number;
  readonly maxRetries: number;
  private readonly fetchImpl: typeof fetch;
  private readonly requestIdProvider?: () => string;
  private readonly authRefresh?: () => string | undefined | Promise<string | undefined>;
  private readonly onRequest?: (method: string, url: string, init: RequestInit) => void;
  private readonly onResponse?: (response: Response) => void;

  constructor(options: HiveMemOptions = {}) {
    this.baseUrl = (options.baseUrl ?? env("HIVEMEM_API_URL") ?? "http://localhost:18790").replace(/\/$/, "");
    this.token = options.token ?? env("HIVEMEM_TOKEN") ?? env("HIVEMEM_MCP_TOKEN");
    this.workspaceId = options.workspaceId ?? env("HIVEMEM_WORKSPACE_ID") ?? "default";
    this.timeoutMs = options.timeoutMs ?? 30_000;
    this.maxRetries = options.maxRetries ?? 2;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.requestIdProvider = options.requestIdProvider;
    this.authRefresh = options.authRefresh;
    this.onRequest = options.onRequest;
    this.onResponse = options.onResponse;
  }

  private url(path: string): string {
    return `${this.baseUrl}${path.startsWith("/") ? path : `/${path}`}`;
  }

  private async request<T>(method: string, path: string, init: RequestInit = {}, params?: Record<string, unknown>): Promise<T> {
    const url = new URL(this.url(path));
    for (const [key, value] of Object.entries(params ?? {})) {
      if (value !== undefined && value !== null) url.searchParams.set(key, String(value));
    }
    const headers = new Headers(init.headers);
    headers.set("Accept", "application/json");
    if (init.body && !headers.has("Content-Type")) headers.set("Content-Type", "application/json");
    if (this.requestIdProvider) headers.set("X-Request-ID", this.requestIdProvider());
    if (this.token) headers.set("Authorization", `Bearer ${this.token}`);

    for (let attempt = 0; attempt <= this.maxRetries; attempt += 1) {
      const refreshed = await this.authRefresh?.();
      if (refreshed) {
        this.token = refreshed;
        headers.set("Authorization", `Bearer ${this.token}`);
      }
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
      try {
        const requestInit = { ...init, method, headers, signal: controller.signal };
        this.onRequest?.(method, String(url), requestInit);
        const response = await this.fetchImpl(url, requestInit);
        this.onResponse?.(response);
        if (response.status >= 500 && attempt < this.maxRetries) continue;
        if (!response.ok) {
          let details: unknown;
          let message = response.statusText;
          try {
            details = await response.json();
            if (details && typeof details === "object" && "detail" in details) message = String((details as { detail: unknown }).detail);
          } catch {
            message = await response.text();
          }
          throw new HiveMemHTTPError(response.status, message, details);
        }
        if (response.status === 204) return undefined as T;
        return (await response.json()) as T;
      } finally {
        clearTimeout(timeout);
      }
    }
    throw new HiveMemHTTPError(599, "HiveMem request retries exhausted");
  }

  health(): Promise<Record<string, unknown>> {
    return this.request("GET", "/v1/health");
  }

  getMemory(memoryId: string, options: { includeHistory?: boolean } = {}): Promise<MemoryRecord> {
    const params = options.includeHistory ? { include_history: true } : {};
    return this.request("GET", `/v1/memories/${encodeURIComponent(memoryId)}`, {}, params);
  }

  createMemory(body: Record<string, unknown>): Promise<MemoryRecord> {
    return this.request("POST", "/v1/memories", { body: JSON.stringify({ workspace_id: this.workspaceId, ...body }) });
  }

  searchMemories(query: string, body: Record<string, unknown> = {}, options: { explain?: boolean } = {}): Promise<SearchResponse> {
    return this.request("POST", "/v1/memories/search", { body: JSON.stringify({ workspace_id: this.workspaceId, ...body, query }) }, { explain: options.explain ?? false });
  }

  syncKnowledgeSource(body: Record<string, unknown>): Promise<KnowledgeSourceSyncResponse> {
    return this.request("POST", "/v1/knowledge/sources/sync", { body: JSON.stringify({ workspace_id: this.workspaceId, ...body }) });
  }

  browseMemories(params: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
    return this.request("GET", "/v1/memories/browse", {}, { workspace_id: this.workspaceId, ...params });
  }

  createSession(body: Record<string, unknown> = {}): Promise<SessionRecord> {
    return this.request("POST", "/v1/sessions", { body: JSON.stringify({ workspace_id: this.workspaceId, ...body }) });
  }

  listSessions(params: Record<string, unknown> = {}): Promise<SessionRecord[]> {
    return this.request("GET", "/v1/sessions", {}, { workspace_id: this.workspaceId, ...params });
  }

  context(body: Record<string, unknown> = {}): Promise<ContextPackage> {
    return this.request<ContextResponse>("POST", "/v1/context", { body: JSON.stringify({ workspace_id: this.workspaceId, ...body }) }).then((data) => new ContextPackage(data));
  }

  sessionContext(sessionId: string, body: Record<string, unknown> = {}): Promise<ContextPackage> {
    return this.request<ContextResponse>("POST", `/v1/sessions/${encodeURIComponent(sessionId)}/context`, { body: JSON.stringify({ workspace_id: this.workspaceId, ...body }) }).then((data) => new ContextPackage(data));
  }

  queueStatus(params: Record<string, unknown> = {}): Promise<QueueStatusResponse> {
    return this.request("GET", "/v1/queue/status", {}, params);
  }

  getQueueOperation(operationId: string, taskType: "consolidation" | "dream", params: Record<string, unknown> = {}): Promise<QueueJobRecord> {
    return this.request("GET", `/v1/queue/operations/${encodeURIComponent(operationId)}`, {}, {
      workspace_id: this.workspaceId,
      ...params,
      task_type: taskType,
    });
  }

  listConclusions(peerId: string, params: Record<string, unknown> = {}): Promise<ConclusionRecord[]> {
    return this.request("GET", `/v1/peers/${encodeURIComponent(peerId)}/conclusions`, {}, { workspace_id: this.workspaceId, ...params });
  }

  listConclusionsPage(peerId: string, params: Record<string, unknown> = {}): Promise<ConclusionPage> {
    return this.request("GET", `/v1/peers/${encodeURIComponent(peerId)}/conclusions`, {}, {
      workspace_id: this.workspaceId,
      ...params,
      paginate: true,
    });
  }

  getConclusion(conclusionId: string, options: { includeHistory?: boolean } = {}): Promise<ConclusionRecord> {
    const params = options.includeHistory ? { include_history: true } : {};
    return this.request("GET", `/v1/conclusions/${encodeURIComponent(conclusionId)}`, {}, params);
  }

  peerRepresentation(peerId: string, params: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
    return this.request("GET", `/v1/peers/${encodeURIComponent(peerId)}/representation`, {}, { workspace_id: this.workspaceId, ...params });
  }

  getPeerCard(peerId: string, params: Record<string, unknown> = {}): Promise<PeerCardResponse> {
    return this.request("GET", `/v1/peers/${encodeURIComponent(peerId)}/card`, {}, { workspace_id: this.workspaceId, ...params });
  }

  upsertPeerCard(peerId: string, content: string, body: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
    return this.request("POST", `/v1/peers/${encodeURIComponent(peerId)}/card`, { body: JSON.stringify({ workspace_id: this.workspaceId, ...body, content }) });
  }

  rebuildPeerCard(peerId: string, body: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
    return this.request("POST", `/v1/peers/${encodeURIComponent(peerId)}/card/rebuild`, { body: JSON.stringify({ workspace_id: this.workspaceId, ...body }) });
  }

  reviewPeerCard(peerId: string, params: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
    return this.request("POST", `/v1/peers/${encodeURIComponent(peerId)}/card/review`, {}, { workspace_id: this.workspaceId, ...params });
  }

  exportAgentBundle(agentId: string): Promise<Record<string, unknown>> {
    return this.request("GET", `/v1/agents/${encodeURIComponent(agentId)}/bundle`);
  }

  importAgentBundle(agentId: string, bundle: Record<string, unknown>): Promise<Record<string, unknown>> {
    return this.request("POST", `/v1/agents/${encodeURIComponent(agentId)}/bundle`, { body: JSON.stringify(bundle) });
  }

  createWebhook(url: string, body: Record<string, unknown> = {}): Promise<WebhookEndpoint> {
    return this.request("POST", "/v1/webhooks", { body: JSON.stringify({ workspace_id: this.workspaceId, ...body, url }) });
  }

  listWebhooks(params: Record<string, unknown> = {}): Promise<WebhookEndpoint[]> {
    return this.request("GET", "/v1/webhooks", {}, params);
  }

  testWebhook(body: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
    return this.request("POST", "/v1/webhooks/test", { body: JSON.stringify({ workspace_id: this.workspaceId, ...body }) });
  }

  webhookDeliveries(params: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
    return this.request("GET", "/v1/webhooks/deliveries", {}, params);
  }
}
