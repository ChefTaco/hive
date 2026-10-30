import { existsSync, readFileSync } from "node:fs";
import { durableJson, removeDurableFile } from "./durable-file.js";
import { createHash } from "node:crypto";
import type {
  AgentInfo,
  ConclusionRecord,
  EpisodeRecord,
  JsonObject,
  JsonValue,
  MemoryRecord,
  MessageRecord,
  QueueJobRecord,
  SessionRecord,
  WebhookDeliveryRecord,
  WebhookEndpointRecord,
  WorkspaceRecord,
} from "./types.js";

export interface PersistedAgentRecord extends AgentInfo {
  metadata: JsonObject;
}

export interface HiveMemSnapshot {
  operations?: JsonObject[];
  memories: MemoryRecord[];
  agents: PersistedAgentRecord[];
  conclusions: ConclusionRecord[];
  episodes: EpisodeRecord[];
  messages: MessageRecord[];
  sessions: SessionRecord[];
  workspaces: WorkspaceRecord[];
  queueJobs: QueueJobRecord[];
  webhooks: WebhookEndpointRecord[];
  webhookDeliveries: WebhookDeliveryRecord[];
}

export interface HiveMemPersistence {
  readonly kind: "qdrant";
  load(): Promise<HiveMemSnapshot>;
  save(snapshot: HiveMemSnapshot): Promise<void>;
  probe?(): Promise<void>;
}

export interface QdrantHiveMemPersistenceOptions {
  url: string;
  apiKey?: string;
  fetchImpl?: typeof fetch;
  journalPath?: string;
}

interface QdrantCollectionListResponse {
  result?: { collections?: Array<{ name?: unknown }> };
}

interface QdrantScrollResponse {
  result?: {
    points?: Array<{ id?: unknown; payload?: unknown; vector?: unknown }>;
    next_page_offset?: JsonValue | { [key: string]: JsonValue };
  };
}

interface QdrantPoint {
  id: string;
  vector: number[];
  payload: JsonObject;
}

const vectorDimensions = {
  memory: 768,
  metadata: 4,
} as const;

const sharedMemoryCollections = ["shared_episodic", "shared_semantic", "shared_procedural"] as const;
const metadataCollections = {
  agents: "_agents",
  conclusions: "_conclusions",
  episodes: "_episodes",
  queue: "_queue",
  sessions: "_sessions",
  webhooks: "_webhooks",
  webhookDeliveries: "_webhook_deliveries",
  workspaces: "_workspaces",
  operations: "_operations",
} as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isJsonValue(value: unknown): value is JsonValue {
  if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") return true;
  if (Array.isArray(value)) return value.every(isJsonValue);
  if (isRecord(value)) return Object.values(value).every(isJsonValue);
  return false;
}

function asJsonObject(value: unknown): JsonObject {
  if (!isRecord(value)) return {};
  const output: JsonObject = {};
  for (const [key, nested] of Object.entries(value)) output[key] = isJsonValue(nested) ? nested : null;
  return output;
}

function metadataVector(): number[] {
  return Array.from({ length: vectorDimensions.metadata }, () => 0);
}

export function deterministicEmbedding(text: string): number[] {
  const vector = Array.from({ length: vectorDimensions.memory }, () => 0);
  const terms = text.toLowerCase().split(/[^a-z0-9_]+/u).filter(Boolean);
  for (const term of terms.length ? terms : [text]) {
    let hash = 2166136261;
    for (const char of term) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619);
    const index = Math.abs(hash) % vector.length;
    vector[index] = (vector[index] ?? 0) + 1;
  }
  const norm = Math.sqrt(vector.reduce((total, value) => total + value * value, 0)) || 1;
  return vector.map((value) => value / norm);
}

function stablePointId(collection: string, recordId: string): string {
  const hex = createHash("sha256").update(collection + ":" + recordId).digest("hex").slice(0, 32);
  return hex.slice(0, 8) + "-" + hex.slice(8, 12) + "-4" + hex.slice(13, 16) + "-" + ((Number.parseInt(hex.slice(16, 18), 16) & 0x3f) | 0x80).toString(16).padStart(2, "0") + hex.slice(18, 20) + "-" + hex.slice(20, 32);
}

function memoryCollection(memory: MemoryRecord): string {
  return memory.scope === "shared" ? "shared_" + memory.type : memory.agent_id + "_private_" + memory.type;
}

function isMemoryCollection(collection: string): boolean {
  return sharedMemoryCollections.includes(collection as (typeof sharedMemoryCollections)[number]) || /_private_(episodic|semantic|procedural)$/u.test(collection);
}

function point(collection: string, recordId: string, payload: JsonObject, vector: number[]): QdrantPoint {
  return { id: stablePointId(collection, recordId), vector, payload };
}

function recordPayload(record: object, recordType?: string): JsonObject {
  return asJsonObject(recordType ? { ...record, record_type: recordType } : { ...record });
}

function payloadRecord<T>(payload: unknown): T | null {
  return isRecord(payload) ? (asJsonObject(payload) as T) : null;
}

function memoryTypeFromCollection(collection: string): MemoryRecord["type"] {
  if (collection.endsWith("_semantic")) return "semantic";
  if (collection.endsWith("_procedural")) return "procedural";
  return "episodic";
}

function memoryScopeFromCollection(collection: string): MemoryRecord["scope"] {
  return collection.startsWith("shared_") ? "shared" : "private";
}

function agentIdFromCollection(collection: string): string {
  if (collection.startsWith("shared_")) return "shared";
  return collection.replace(/_private_(episodic|semantic|procedural)$/u, "") || "unknown";
}

function stringArray(value: JsonValue | undefined): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function relationships(value: JsonValue | undefined): MemoryRecord["relationships"] {
  if (!Array.isArray(value)) return [];
  const allowedTypes = new Set(["supports", "contradicts", "updates", "duplicates", "causes", "part_of", "derived_from", "about_entity"]);
  return value.flatMap((item) => {
    if (!isRecord(item) || typeof item.target_id !== "string" || typeof item.type !== "string" || !allowedTypes.has(item.type)) return [];
    return [{
      target_id: item.target_id,
      type: item.type as MemoryRecord["relationships"][number]["type"],
      confidence: typeof item.confidence === "number" ? item.confidence : 0.5,
      metadata: isRecord(item.metadata) ? asJsonObject(item.metadata) : {},
    }];
  });
}

function normalizeMemoryRecord(collection: string, pointId: unknown, payload: JsonObject): MemoryRecord | null {
  if (typeof payload.content !== "string" || !payload.content.trim()) return null;
  const timestamp = typeof payload.created_at === "string" ? payload.created_at : new Date(0).toISOString();
  return {
    id: typeof payload.id === "string" && payload.id ? payload.id : collection + ":" + String(pointId || stablePointId(collection, payload.content)),
    content: payload.content,
    type: payload.type === "semantic" || payload.type === "procedural" || payload.type === "episodic" ? payload.type : memoryTypeFromCollection(collection),
    scope: payload.scope === "shared" || payload.scope === "private" ? payload.scope : memoryScopeFromCollection(collection),
    agent_id: typeof payload.agent_id === "string" && payload.agent_id ? payload.agent_id : agentIdFromCollection(collection),
    source: payload.source === "conversation" || payload.source === "research" || payload.source === "observation" || payload.source === "consolidation" || payload.source === "user_feedback" || payload.source === "skill" || payload.source === "system" ? payload.source : "observation",
    confidence: typeof payload.confidence === "number" ? payload.confidence : 0.75,
    importance: typeof payload.importance === "number" ? payload.importance : 0.5,
    tags: stringArray(payload.tags),
    metadata: isRecord(payload.metadata) ? asJsonObject(payload.metadata) : {},
    sensitivity: payload.sensitivity === "public" || payload.sensitivity === "sensitive" || payload.sensitivity === "restricted" || payload.sensitivity === "internal" ? payload.sensitivity : "internal",
    retention_class: typeof payload.retention_class === "string" ? payload.retention_class : "standard",
    redaction_policy: payload.redaction_policy === "redact" || payload.redaction_policy === "exclude" || payload.redaction_policy === "none" ? payload.redaction_policy : "none",
    workspace_id: typeof payload.workspace_id === "string" && payload.workspace_id ? payload.workspace_id : "default",
    session_id: typeof payload.session_id === "string" ? payload.session_id : null,
    created_at: timestamp,
    updated_at: typeof payload.updated_at === "string" ? payload.updated_at : timestamp,
    expires_at: typeof payload.expires_at === "string" ? payload.expires_at : null,
    valid_from: typeof payload.valid_from === "string" ? payload.valid_from : null,
    valid_to: typeof payload.valid_to === "string" ? payload.valid_to : null,
    observed_at: typeof payload.observed_at === "string" ? payload.observed_at : null,
    relationships: relationships(payload.relationships),
    confidence_provenance: Array.isArray(payload.confidence_provenance) ? payload.confidence_provenance.filter(isRecord).map(asJsonObject) : [],
    supersedes: typeof payload.supersedes === "string" ? payload.supersedes : null,
    superseded_by: typeof payload.superseded_by === "string" ? payload.superseded_by : null,
    superseded_at: typeof payload.superseded_at === "string" ? payload.superseded_at : (typeof payload.superseded_by === "string" ? (typeof payload.updated_at === "string" ? payload.updated_at : timestamp) : null),
    corroborated_by: stringArray(payload.corroborated_by),
    endorsements: typeof payload.endorsements === "number" ? payload.endorsements : 0,
    endorsed_by: stringArray(payload.endorsed_by),
    opposed_by: stringArray(payload.opposed_by),
    deleted_at: typeof payload.deleted_at === "string" ? payload.deleted_at : null,
    effective_confidence: typeof payload.effective_confidence === "number" ? payload.effective_confidence : null,
    sanitization_warnings: Array.isArray(payload.sanitization_warnings) ? stringArray(payload.sanitization_warnings) : null,
  };
}

function emptySnapshot(): HiveMemSnapshot {
  return {
    memories: [],
    agents: [],
    conclusions: [],
    episodes: [],
    messages: [],
    sessions: [],
    workspaces: [],
    queueJobs: [],
    webhooks: [],
    webhookDeliveries: [],
  };
}

export class QdrantHiveMemPersistence implements HiveMemPersistence {
  readonly kind = "qdrant" as const;
  private readonly baseUrl: string;
  private readonly apiKey: string | undefined;
  private readonly fetchImpl: typeof fetch;
  private readonly journalPath: string | undefined;
  private readonly persisted = new Map<string, Map<string, QdrantPoint>>();
  private readonly knownCollections = new Set<string>();
  private recovering = false;
  private recoveredVectors = new Map<string, number[]>();

  duplicateReport(): Array<{ id: string; copies: number }> {
    const counts = new Map<string, number>();
    for (const [collection, points] of this.persisted) if (isMemoryCollection(collection)) for (const item of points.values()) { const id = String(item.payload.id); counts.set(id, (counts.get(id) ?? 0) + 1); }
    return [...counts].filter(([, copies]) => copies > 1).map(([id, copies]) => ({ id, copies }));
  }

  async probe(): Promise<void> { await this.listCollections(); }


  constructor(options: QdrantHiveMemPersistenceOptions) {
    this.baseUrl = options.url.replace(/\/+$/u, "");
    this.apiKey = options.apiKey;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.journalPath = options.journalPath;
  }

  async load(): Promise<HiveMemSnapshot> {
    this.persisted.clear();
    const snapshot = emptySnapshot();
    const collections = await this.listCollections();
    const existingCollections = new Set(collections);
    for (const name of collections) this.knownCollections.add(name);
    for (const collection of collections.filter(isMemoryCollection)) {
      const records = await this.scrollMemoryCollection(collection);
      snapshot.memories.push(...records);
    }

    if (existingCollections.has(metadataCollections.agents)) {
      for (const payload of await this.scrollCollection(metadataCollections.agents)) {
        const record = payloadRecord<PersistedAgentRecord>(payload);
        if (record) snapshot.agents.push(record);
      }
    }
    if (existingCollections.has(metadataCollections.conclusions)) {
      for (const payload of await this.scrollCollection(metadataCollections.conclusions)) {
        const record = payloadRecord<ConclusionRecord>(payload);
        if (record) snapshot.conclusions.push(record);
      }
    }
    if (existingCollections.has(metadataCollections.episodes)) {
      for (const payload of await this.scrollCollection(metadataCollections.episodes)) {
        const raw = payloadRecord<JsonObject>(payload);
        if (!raw) continue;
        if (raw.record_type === "message") snapshot.messages.push(raw as unknown as MessageRecord);
        else snapshot.episodes.push(raw as unknown as EpisodeRecord);
      }
    }
    if (existingCollections.has(metadataCollections.queue)) {
      for (const payload of await this.scrollCollection(metadataCollections.queue)) {
        const record = payloadRecord<QueueJobRecord>(payload);
        if (record) snapshot.queueJobs.push(record);
      }
    }
    if (existingCollections.has(metadataCollections.sessions)) {
      for (const payload of await this.scrollCollection(metadataCollections.sessions)) {
        const record = payloadRecord<SessionRecord>(payload);
        if (record) snapshot.sessions.push(record);
      }
    }
    if (existingCollections.has(metadataCollections.webhooks)) {
      for (const payload of await this.scrollCollection(metadataCollections.webhooks)) {
        const record = payloadRecord<WebhookEndpointRecord>(payload);
        if (record) snapshot.webhooks.push(record);
      }
    }
    if (existingCollections.has(metadataCollections.webhookDeliveries)) {
      for (const payload of await this.scrollCollection(metadataCollections.webhookDeliveries)) {
        const record = payloadRecord<WebhookDeliveryRecord>(payload);
        if (record) snapshot.webhookDeliveries.push(record);
      }
    }
    if (existingCollections.has(metadataCollections.workspaces)) {
      for (const payload of await this.scrollCollection(metadataCollections.workspaces)) {
        const record = payloadRecord<WorkspaceRecord>(payload);
        if (record) snapshot.workspaces.push(record);
      }
    }
    // Restrictive tie-break prevents a stale shared copy winning a restart.
    const canonical = new Map<string, MemoryRecord>();
    for (const memory of snapshot.memories) {
      const old = canonical.get(memory.id);
      if (!old || memory.updated_at > old.updated_at || (memory.updated_at === old.updated_at && memory.scope === "private")) canonical.set(memory.id, memory);
    }
    snapshot.memories = [...canonical.values()];
    snapshot.operations = existingCollections.has(metadataCollections.operations) ? await this.scrollCollection(metadataCollections.operations) : [];
    if (this.journalPath && existsSync(this.journalPath) && !this.recovering) {
      const journal = JSON.parse(readFileSync(this.journalPath, "utf8")) as { snapshot?: HiveMemSnapshot; vectors?: Array<[string, number[]]> };
      const pending = journal.snapshot ?? journal as unknown as HiveMemSnapshot;
      this.recoveredVectors = new Map(journal.vectors ?? []);
      for (const key of Object.keys(snapshot) as Array<keyof HiveMemSnapshot>) {
        if (key === "operations" && pending[key] === undefined) continue;
        if (!Array.isArray(pending[key])) throw new Error("Invalid pending HiveMem journal");
      }
      this.recovering = true;
      try { await this.save(pending); return await this.load(); } finally { this.recovering = false; }
    }
    return snapshot;
  }

  async save(snapshot: HiveMemSnapshot): Promise<void> {
        const memoryCollections = new Map<string, QdrantPoint[]>();
    const priorMemories = new Map([...this.persisted.values()].flatMap((items) => [...items.values()]).filter((item) => typeof item.payload.id === "string").map((item) => [item.payload.id, item]));
    for (const memory of snapshot.memories) {
      const collection = memoryCollection(memory);
      const points = memoryCollections.get(collection) ?? [];
      const previous = priorMemories.get(memory.id);
      const vector = this.recoveredVectors.get(memory.id) ?? (previous?.vector.length ? previous.vector : deterministicEmbedding(memory.content));
      points.push(point(collection, memory.id, recordPayload(memory), vector));
      memoryCollections.set(collection, points);
    }

    if (this.journalPath) durableJson(this.journalPath, { snapshot, vectors: [...memoryCollections.values()].flat().map((item) => [item.payload.id, item.vector]) });

    // Remove stale visible copies before adding the new collection. The fsynced
    // journal resumes an interrupted move; no new duplicate is exposed.
    for (const collection of this.persisted.keys()) {
      if (isMemoryCollection(collection)) await this.removeMissing(collection, memoryCollections.get(collection) ?? []);
    }
    for (const [collection, points] of memoryCollections) await this.ensureAndUpsert(collection, vectorDimensions.memory, points);
    await this.ensureAndUpsert(metadataCollections.agents, vectorDimensions.metadata, snapshot.agents.map((record) => point(metadataCollections.agents, record.agent_id, recordPayload(record), metadataVector())));
    // Historical _conclusions collections use the memory vector schema. Keep
    // their existing 768-dimensional layout so checkpoint writes remain valid.
    await this.ensureAndUpsert(metadataCollections.conclusions, vectorDimensions.memory, snapshot.conclusions.map((record) => point(metadataCollections.conclusions, record.id, recordPayload(record), Array.from({ length: vectorDimensions.memory }, () => 0))));
    await this.ensureAndUpsert(metadataCollections.episodes, vectorDimensions.metadata, [
      ...snapshot.episodes.map((record) => point(metadataCollections.episodes, record.id, recordPayload(record, "episode"), metadataVector())),
      ...snapshot.messages.map((record) => point(metadataCollections.episodes, record.id, recordPayload(record, "message"), metadataVector())),
    ]);
    await this.ensureAndUpsert(metadataCollections.queue, vectorDimensions.metadata, snapshot.queueJobs.map((record) => point(metadataCollections.queue, record.id, recordPayload(record), metadataVector())));
    await this.ensureAndUpsert(metadataCollections.sessions, vectorDimensions.metadata, snapshot.sessions.map((record) => point(metadataCollections.sessions, record.session_id, recordPayload(record), metadataVector())));
    await this.ensureAndUpsert(metadataCollections.webhooks, vectorDimensions.metadata, snapshot.webhooks.map((record) => point(metadataCollections.webhooks, record.id, recordPayload(record), metadataVector())));
    await this.ensureAndUpsert(metadataCollections.webhookDeliveries, vectorDimensions.metadata, snapshot.webhookDeliveries.map((record) => point(metadataCollections.webhookDeliveries, record.id, recordPayload(record), metadataVector())));
    await this.ensureAndUpsert(metadataCollections.workspaces, vectorDimensions.metadata, snapshot.workspaces.map((record) => point(metadataCollections.workspaces, record.workspace_id, recordPayload(record), metadataVector())));
    await this.ensureAndUpsert(metadataCollections.operations, vectorDimensions.metadata, (snapshot.operations ?? []).map((record) => point(metadataCollections.operations, String(record.id), record, metadataVector())));
    if (this.journalPath) removeDurableFile(this.journalPath);
    this.recoveredVectors.clear();
  }

  private async listCollections(): Promise<string[]> {
    const response = await this.request<QdrantCollectionListResponse>("GET", "/collections");
    return (response.result?.collections ?? []).map((collection) => (typeof collection.name === "string" ? collection.name : "")).filter(Boolean);
  }

  private async scrollCollection(collection: string): Promise<JsonObject[]> {
    const payloads: JsonObject[] = [];
    let offset: JsonValue | { [key: string]: JsonValue } | undefined;
    do {
      const response = await this.request<QdrantScrollResponse>("POST", "/collections/" + encodeURIComponent(collection) + "/points/scroll", {
        limit: 256,
        offset,
        with_payload: true,
        with_vector: true,
      });
      const points = response.result?.points ?? [];
      for (const item of points) {
        const payload = asJsonObject(item.payload);
        if (Object.keys(payload).length === 0 || !(payload.id || payload.agent_id || payload.session_id || payload.workspace_id)) throw new Error("Invalid HiveMem metadata in " + collection);
        payloads.push(payload);
        this.rememberPoint(collection, item, payload);
      }
      offset = response.result?.next_page_offset ?? undefined;
    } while (offset !== undefined && offset !== null);
    return payloads;
  }

  private async scrollMemoryCollection(collection: string): Promise<MemoryRecord[]> {
    const records: MemoryRecord[] = [];
    let offset: JsonValue | { [key: string]: JsonValue } | undefined;
    do {
      const response = await this.request<QdrantScrollResponse>("POST", "/collections/" + encodeURIComponent(collection) + "/points/scroll", {
        limit: 256,
        offset,
        with_payload: true,
        with_vector: true,
      });
      const points = response.result?.points ?? [];
      for (const item of points) {
        const record = normalizeMemoryRecord(collection, item.id, asJsonObject(item.payload));
        if (record) { records.push(record); this.rememberPoint(collection, item, recordPayload(record)); }
      }
      offset = response.result?.next_page_offset ?? undefined;
    } while (offset !== undefined && offset !== null);
    return records;
  }

  private rememberPoint(collection: string, item: { id?: unknown; vector?: unknown }, payload: JsonObject): void {
    if (typeof item.id !== "string" && typeof item.id !== "number") throw new Error("Invalid Qdrant point ID");
    if (isMemoryCollection(collection) && item.vector !== undefined && (!Array.isArray(item.vector) || item.vector.length !== vectorDimensions.memory || item.vector.some((value) => typeof value !== "number" || !Number.isFinite(value)))) throw new Error("Unsupported vector schema in " + collection + "; migrate explicitly");
    const records = this.persisted.get(collection) ?? new Map<string, QdrantPoint>();
    records.set(String(item.id), { id: String(item.id), payload, vector: Array.isArray(item.vector) ? item.vector as number[] : [] });
    this.persisted.set(collection, records);
  }

  private async removeMissing(collection: string, points: QdrantPoint[]): Promise<void> {
    const prior = this.persisted.get(collection);
    if (!prior) return;
    const wanted = new Set(points.map((entry) => entry.id));
    const removed = [...prior.keys()].filter((id) => !wanted.has(id));
    for (let offset = 0; offset < removed.length; offset += 128) {
      const batch = removed.slice(offset, offset + 128);
      await this.request("POST", "/collections/" + encodeURIComponent(collection) + "/points/delete?wait=true", { points: batch });
      for (const id of batch) prior.delete(id);
    }
  }

  private async ensureAndUpsert(collection: string, dimensions: number, points: QdrantPoint[]): Promise<void> {
    if (!this.knownCollections.has(collection)) {
      await this.request("PUT", "/collections/" + encodeURIComponent(collection), { vectors: { size: dimensions, distance: "Cosine" } }, [200, 409]);
      this.knownCollections.add(collection);
    }
    const prior = this.persisted.get(collection) ?? new Map<string, QdrantPoint>();
    this.persisted.set(collection, prior);
    const changed = points.filter((entry) => JSON.stringify(prior.get(entry.id)?.payload) !== JSON.stringify(entry.payload));
    for (let offset = 0; offset < changed.length; offset += 128) {
      const batch = changed.slice(offset, offset + 128);
      await this.request("PUT", "/collections/" + encodeURIComponent(collection) + "/points?wait=true", { points: batch });
      for (const entry of batch) prior.set(entry.id, entry);
    }
    await this.removeMissing(collection, points);
  }

  private async request<T = unknown>(method: string, path: string, body?: unknown, okStatuses: readonly number[] = [200]): Promise<T> {
    const headers: Record<string, string> = { accept: "application/json" };
    if (this.apiKey) headers["api-key"] = this.apiKey;
    if (body !== undefined) headers["content-type"] = "application/json";
    const init: RequestInit = { method, headers, signal: AbortSignal.timeout(10_000) };
    if (body !== undefined) init.body = JSON.stringify(body);
    const response = await this.fetchImpl(this.baseUrl + path, init);
    if (!okStatuses.includes(response.status)) {
      const text = await response.text().catch(() => "");
      throw new Error("Qdrant " + method + " " + path + " failed with " + response.status + (text ? ": " + text.slice(0, 200) : ""));
    }
    if (response.status === 204) return undefined as T;
    return (await response.json()) as T;
  }
}

/** Qdrant REST base URL from HIVEMEM_QDRANT_URL, QDRANT_URL, or the host/port pair (default http://127.0.0.1:6333). */
export function qdrantUrlFromEnv(env: NodeJS.ProcessEnv = process.env): string {
  return env.HIVEMEM_QDRANT_URL ?? env.QDRANT_URL ?? "http://" + (env.HIVEMEM_QDRANT_HOST ?? env.QDRANT_HOST ?? "127.0.0.1") + ":" + (env.HIVEMEM_QDRANT_PORT ?? env.QDRANT_PORT ?? "6333");
}

export function qdrantPersistenceFromEnv(env: NodeJS.ProcessEnv = process.env): QdrantHiveMemPersistence | null {
  if (env.HIVEMEM_TS_PERSISTENCE !== "qdrant") return null;
  const host = qdrantUrlFromEnv(env);
  return new QdrantHiveMemPersistence({ url: host, ...(env.HIVEMEM_STORAGE_PATH ? { journalPath: env.HIVEMEM_STORAGE_PATH + "/pending-write.json" } : {}), ...(env.QDRANT_API_KEY ? { apiKey: env.QDRANT_API_KEY } : {}) });
}
