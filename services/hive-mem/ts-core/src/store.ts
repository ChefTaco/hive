import { semanticConfig, SemanticIndex } from "./semantic-index.js";
import { allowedPrivateWebhookHost, deliverWebhook, WebhookDeliveryError, type WebhookRequest } from "./webhook-transport.js";
import { createHash, randomUUID } from "node:crypto";
import { deterministicEmbedding, type HiveMemPersistence, type HiveMemSnapshot, type PersistedAgentRecord } from "./persistence.js";
import {
  DEFAULT_REASONING_SETTINGS,
  buildPeerCard as buildPeerCardConclusions,
  dream as dreamConclusions,
  estimateTokens as estimateReasoningTokens,
  extractConclusions,
  normalizeText as normalizeConclusionText,
  summarizeSession as summarizeSessionMemories,
  uuid5,
  type ReasonedConclusion,
} from "./reasoning.js";
import type {
  AgentInfo,
  AgentProfile,
  AgentProfileBundle,
  AgentRegistered,
  AuthPrincipal,
  BrowseResponse,
  ChatResponse,
  ChatSourceMemory,
  ConclusionKind,
  ConclusionRecord,
  ConclusionSearchResponse,
  GraphEdge,
  GraphNeighborhoodResponse,
  GraphNode,
  ContextResponse,
  JsonObject,
  JsonValue,
  KnowledgeSourceSyncRequest,
  KnowledgeSourceSyncResponse,
  MemoryCitation,
  MemoryCreate,
  MemoryRecord,
  MemoryRelationship,
  MemoryScope,
  MemoryType,
  MemoryUpdate,
  PeerCardResponse,
  PeerCardReviewResponse,
  QueueJobRecord,
  QueueJobSummary,
  QueueStatusResponse,
  WorkerHealth,
  ReasoningLevel,
  RepresentationResponse,
  SearchRequest,
  SearchResponse,
  SearchResult,
  SearchScoreComponents,
  SessionCreate,
  SessionRecord,
  WebhookDeliveryListResponse,
  WebhookDeliveryRecord,
  WebhookEndpointRecord,
  WebhookEventType,
  WebhookTestEmitResponse,
  DreamScheduleResponse,
  EpisodeMessagesResponse,
  EpisodeRecord,
  MessageRecord,
  MessageRole,
  StatsResponse,
  WorkspaceMember,
  WorkspacePolicy,
  WorkspaceRecord,
  WorkspaceResolvedSettings,
  WorkspaceRole,
} from "./types.js";
import {
  asJsonObject,
  clampLimit,
  memoryScopes,
  memorySources,
  jobStatuses,
  memoryTypes,
  optionalBoolean,
  optionalJsonObject,
  optionalNullableString,
  optionalNumber,
  optionalString,
  optionalStringArray,
  parseEnum,
  redactionPolicies,
  requiredString,
  taskTypes,
  sensitivities,
  ValidationError,
} from "./validation.js";

export class NotFoundError extends Error {
  readonly status = 404;

  constructor(message: string) {
    super(message);
    this.name = "NotFoundError";
  }
}

export class ForbiddenError extends Error {
  readonly status = 403;

  constructor(message: string) {
    super(message);
    this.name = "ForbiddenError";
  }
}

export class ConflictError extends Error {
  readonly status = 409;

  constructor(message: string) {
    super(message);
    this.name = "ConflictError";
  }
}

export class BadRequestError extends Error {
  readonly status = 400;

  constructor(message: string) {
    super(message);
    this.name = "BadRequestError";
  }
}

function nowIso(): string {
  return new Date().toISOString();
}

function collectionFor(memory: MemoryRecord): string {
  return `${memory.scope}_${memory.type}`;
}

interface ConclusionFilters {
  includeHistory?: boolean;
  includeDeleted?: boolean;
  sessionId?: string;
  kind?: ConclusionKind;
  minConfidence?: number;
}

type ConclusionCursor = { confidence: number; created_at: string; id: string };

function conclusionFilters(params: URLSearchParams): ConclusionFilters {
  const filters: ConclusionFilters = {
    includeHistory: params.get("include_history") === "true" || params.get("include_deleted") === "true",
  };
  const sessionId = params.get("session_id");
  const kind = parseEnum(params.get("kind") ?? undefined, "kind", conclusionKinds);
  if (sessionId) filters.sessionId = sessionId;
  if (kind) filters.kind = kind;
  if (params.has("min_confidence")) {
    const minConfidence = Number.parseFloat(params.get("min_confidence") ?? "0");
    if (!Number.isFinite(minConfidence) || minConfidence < 0 || minConfidence > 1) throw new ValidationError("Invalid min_confidence");
    filters.minConfidence = minConfidence;
  }
  return filters;
}

function compareConclusionPage(left: ConclusionCursor, right: ConclusionCursor): number {
  return right.confidence - left.confidence
    || left.created_at.localeCompare(right.created_at)
    || left.id.localeCompare(right.id);
}

function decodeConclusionCursor(cursor: string, scope: string): ConclusionCursor {
  try {
    if (cursor.length > 1024) throw new Error("cursor");
    const decoded: unknown = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
    if (!decoded || typeof decoded !== "object" || !("scope" in decoded) || decoded.scope !== scope || !("after" in decoded)) throw new Error("cursor");
    const after = decoded.after;
    if (!Array.isArray(after) || after.length !== 3) throw new Error("cursor");
    const [confidence, createdAt, id] = after as unknown[];
    if (typeof confidence !== "number" || !Number.isFinite(confidence) || typeof createdAt !== "string" || typeof id !== "string") throw new Error("cursor");
    return { confidence, created_at: createdAt, id };
  } catch {
    throw new ValidationError("Invalid or mismatched conclusion cursor");
  }
}

function memoryCurrent(memory: MemoryRecord, at = Date.now()): boolean {
  const created = Date.parse(memory.created_at);
  const deleted = memory.deleted_at ? Date.parse(memory.deleted_at) : null;
  const superseded = memory.superseded_at ? Date.parse(memory.superseded_at) : (memory.superseded_by ? Date.parse(memory.updated_at) : null);
  return created <= at
    && (deleted === null || deleted > at)
    && (superseded === null || superseded > at)
    && (!memory.expires_at || Date.parse(memory.expires_at) > at)
    && (!memory.valid_from || Date.parse(memory.valid_from) <= at)
    && (!memory.valid_to || Date.parse(memory.valid_to) > at);
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(canonicalJson).join(',') + ']';
  if (value !== null && typeof value === 'object') return '{' + Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, entry]) => JSON.stringify(key) + ':' + canonicalJson(entry)).join(',') + '}';
  return JSON.stringify(value) ?? 'null';
}
function operationId(raw: JsonObject): string | undefined {
  if (raw.operation_id === undefined) return undefined;
  if (typeof raw.operation_id !== 'string' || !/^[A-Za-z0-9._:-]{1,160}$/.test(raw.operation_id)) throw new ValidationError('Invalid operation_id');
  return raw.operation_id;
}

function canRead(memory: MemoryRecord, principal: AuthPrincipal): boolean {
  if (Array.isArray(principal.rawClaims.workspace_ids) && !principal.rawClaims.workspace_ids.includes(memory.workspace_id)) return false;
  return isAdmin(principal) || memory.agent_id === principal.agentId || memory.scope === "shared";
}

function assertCanWrite(memory: MemoryRecord, principal: AuthPrincipal): void {
  if (memory.agent_id !== principal.agentId) throw new ForbiddenError("Memory is owned by another agent");
}

function tokenize(input: string): string[] {
  return input.toLowerCase().split(/[^a-z0-9_]+/u).filter(Boolean);
}

function estimateTokens(input: string): number {
  return Math.max(1, Math.ceil(input.length / 4));
}

function parseIsoTimestamp(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) throw new ValidationError(`${label} is required`);
  const timestamp = value.trim();
  const millis = Date.parse(timestamp);
  if (!Number.isFinite(millis)) throw new ValidationError(`${label} must be an ISO-8601 timestamp`);
  return new Date(millis).toISOString();
}

function jsonString(value: JsonValue | undefined): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function projectTag(projectId: string): string {
  return "project-" + createHash("sha256").update(projectId).digest("hex").slice(0, 20);
}

function tokenJaccard(left: string, right: string): number {
  const leftTokens = new Set(tokenize(left));
  const rightTokens = new Set(tokenize(right));
  if (!leftTokens.size && !rightTokens.size) return 1;
  let overlap = 0;
  for (const token of leftTokens) if (rightTokens.has(token)) overlap += 1;
  return overlap / Math.max(1, new Set([...leftTokens, ...rightTokens]).size);
}

const relationshipTypes = ["supports", "contradicts", "updates", "duplicates", "causes", "part_of", "derived_from", "about_entity"] as const;

function parseRelationships(value: unknown): MemoryRelationship[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new ValidationError("relationships must be an array");
  return value.map((item, index) => {
    const raw = asJsonObject(item, "relationships[" + index + "]");
    const targetId = requiredString(raw.target_id, "relationships[" + index + "].target_id");
    const type = parseEnum(raw.type, "relationships[" + index + "].type", relationshipTypes);
    if (!type) throw new ValidationError("relationships[" + index + "].type is required");
    return {
      target_id: targetId,
      type,
      confidence: optionalNumber(raw.confidence, "relationships[" + index + "].confidence", 1),
      metadata: optionalJsonObject(raw.metadata, "relationships[" + index + "].metadata") ?? {},
    };
  });
}

function slug(input: string): string {
  return input.toLowerCase().replace(/[^a-z0-9]+/gu, "-").replace(/^-|-$/gu, "") || "entity";
}

function graphEntities(memory: MemoryRecord): GraphNode[] {
  const rawEntities = Array.isArray(memory.metadata.entities) ? memory.metadata.entities : [];
  const nodes: GraphNode[] = [];
  for (const raw of rawEntities) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
    const entity = raw as JsonObject;
    const name = typeof entity.name === "string" && entity.name.trim() ? entity.name.trim() : undefined;
    if (!name) continue;
    const type = typeof entity.type === "string" && entity.type.trim() ? entity.type.trim() : "topic";
    const id = typeof entity.entity_id === "string" && entity.entity_id.trim() ? entity.entity_id.trim() : memory.workspace_id + ":" + type + ":" + slug(name);
    nodes.push({
      id,
      label: name,
      type,
      record_type: "entity",
      metadata: { workspace_id: memory.workspace_id, linked_memory_ids: [memory.id] },
    });
  }
  return nodes;
}

function memoryGraphNode(memory: MemoryRecord): GraphNode {
  return {
    id: memory.id,
    label: memory.content.slice(0, 80),
    type: memory.type,
    record_type: "memory",
    metadata: {
      agent_id: memory.agent_id,
      workspace_id: memory.workspace_id,
      scope: memory.scope,
      tags: memory.tags,
    },
  };
}

function queueSummary(job: QueueJobRecord): QueueJobSummary {
  return {
    id: job.id,
    task_type: job.task_type,
    status: job.status,
    work_unit_key: job.work_unit_key,
    owner_agent_id: job.owner_agent_id,
    workspace_id: job.workspace_id,
    session_id: job.session_id,
    peer_id: job.peer_id,
    priority: job.priority,
    retry_count: job.retry_count,
    created_at: job.created_at,
    not_before: job.not_before,
    started_at: job.started_at,
    finished_at: job.finished_at,
    error: job.error,
  };
}

function isAdmin(principal: AuthPrincipal): boolean {
  return principal.rawClaims.role === "admin" || principal.scopes.includes("admin:all");
}

function assertQueueAdmin(principal: AuthPrincipal): void {
  if (!isAdmin(principal) && !principal.scopes.includes("admin:queue")) throw new ForbiddenError("admin:queue scope is required");
}

function parseMemoryCreate(body: unknown): MemoryCreate {
  const raw = asJsonObject(body, "memory");
  const content = requiredString(raw.content, "content");
  const type = parseEnum(raw.type, "type", memoryTypes);
  const scope = parseEnum(raw.scope, "scope", memoryScopes);
  if (!type || !scope) throw new ValidationError("type and scope are required");
  return {
    content,
    type,
    scope,
    source: parseEnum(raw.source, "source", memorySources, "conversation"),
    confidence: optionalNumber(raw.confidence, "confidence", 0.8),
    importance: optionalNumber(raw.importance, "importance", 0.5),
    tags: optionalStringArray(raw.tags, "tags") ?? [],
    metadata: optionalJsonObject(raw.metadata, "metadata") ?? {},
    sensitivity: parseEnum(raw.sensitivity, "sensitivity", sensitivities, "internal"),
    retention_class: optionalString(raw.retention_class, "retention_class") ?? "standard",
    redaction_policy: parseEnum(raw.redaction_policy, "redaction_policy", redactionPolicies, "none"),
    workspace_id: optionalString(raw.workspace_id, "workspace_id") ?? "default",
    session_id: optionalNullableString(raw.session_id, "session_id") ?? null,
    expires_at: optionalNullableString(raw.expires_at, "expires_at") ?? null,
    valid_from: optionalNullableString(raw.valid_from, "valid_from") ?? null,
    valid_to: optionalNullableString(raw.valid_to, "valid_to") ?? null,
    observed_at: optionalNullableString(raw.observed_at, "observed_at") ?? null,
    relationships: parseRelationships(raw.relationships),
    supersedes: optionalNullableString(raw.supersedes, "supersedes") ?? null,
  };
}

function parseMemoryUpdate(body: unknown): MemoryUpdate {
  const raw = asJsonObject(body, "memory update");
  const update: MemoryUpdate = {};
  const content = optionalString(raw.content, "content");
  if (content !== undefined) update.content = content;
  const confidence = optionalNumber(raw.confidence, "confidence");
  if (confidence !== undefined) update.confidence = confidence;
  const importance = optionalNumber(raw.importance, "importance");
  if (importance !== undefined) update.importance = importance;
  const tags = optionalStringArray(raw.tags, "tags");
  if (tags !== undefined) update.tags = tags;
  const metadata = optionalJsonObject(raw.metadata, "metadata");
  if (metadata !== undefined) update.metadata = metadata;
  const sensitivity = parseEnum(raw.sensitivity, "sensitivity", sensitivities);
  if (sensitivity !== undefined) update.sensitivity = sensitivity;
  const retentionClass = optionalString(raw.retention_class, "retention_class");
  if (retentionClass !== undefined) update.retention_class = retentionClass;
  const redactionPolicy = parseEnum(raw.redaction_policy, "redaction_policy", redactionPolicies);
  if (redactionPolicy !== undefined) update.redaction_policy = redactionPolicy;
  const workspaceId = optionalString(raw.workspace_id, "workspace_id");
  if (workspaceId !== undefined) update.workspace_id = workspaceId;
  const sessionId = optionalNullableString(raw.session_id, "session_id");
  if (sessionId !== undefined) update.session_id = sessionId;
  const expiresAt = optionalNullableString(raw.expires_at, "expires_at");
  if (expiresAt !== undefined) update.expires_at = expiresAt;
  const validFrom = optionalNullableString(raw.valid_from, "valid_from");
  if (validFrom !== undefined) update.valid_from = validFrom;
  const validTo = optionalNullableString(raw.valid_to, "valid_to");
  if (validTo !== undefined) update.valid_to = validTo;
  const observedAt = optionalNullableString(raw.observed_at, "observed_at");
  if (observedAt !== undefined) update.observed_at = observedAt;
  if (raw.relationships !== undefined) update.relationships = parseRelationships(raw.relationships);
  return update;
}

function parseSearchRequest(body: unknown): SearchRequest {
  const raw = asJsonObject(body, "search");
  const offset = optionalNumber(raw.offset, "offset") ?? 0;
  if (!Number.isSafeInteger(offset) || offset < 0) throw new ValidationError("offset must be a non-negative integer");
  const request: SearchRequest = {
    offset,
    query: optionalString(raw.query, "query") ?? "",
    workspace_id: optionalString(raw.workspace_id, "workspace_id") ?? "default",
  };
  const scope = parseEnum(raw.scope, "scope", memoryScopes);
  if (scope !== undefined) request.scope = scope;
  const type = parseEnum(raw.type, "type", memoryTypes);
  if (type !== undefined) request.type = type;
  const tags = optionalStringArray(raw.tags, "tags");
  if (tags !== undefined) request.tags = tags;
  const sessionId = optionalString(raw.session_id, "session_id");
  if (sessionId !== undefined) request.session_id = sessionId;
  const agentFilter = optionalString(raw.agent_filter, "agent_filter");
  if (agentFilter !== undefined) request.agent_filter = agentFilter;
  const fromSelf = optionalBoolean(raw.from_self, "from_self");
  if (fromSelf !== undefined) request.from_self = fromSelf;
  const minConfidence = optionalNumber(raw.min_confidence, "min_confidence");
  if (minConfidence !== undefined) request.min_confidence = minConfidence;
  const minImportance = optionalNumber(raw.min_importance, "min_importance");
  if (minImportance !== undefined) request.min_importance = minImportance;
  const limit = optionalNumber(raw.limit, "limit");
  if (limit !== undefined) request.limit = limit;
  const includeDeleted = optionalBoolean(raw.include_deleted, "include_deleted");
  if (includeDeleted !== undefined) request.include_deleted = includeDeleted;
  const includeSensitive = optionalBoolean(raw.include_sensitive, "include_sensitive");
  if (includeSensitive !== undefined) request.include_sensitive = includeSensitive;
  const filterValue = raw.filters ?? raw.filter;
  if (filterValue !== undefined) {
    const filters = asJsonObject(filterValue, "filters");
    const supported = new Set(["project_id", "source_id", "publisher_ids", "scope", "type", "tags_all", "min_confidence", "min_importance"]);
    for (const key of Object.keys(filters)) if (!supported.has(key)) throw new ValidationError(`filters.${key} is not supported`);
    request.filters = {};
    const projectId = optionalString(filters.project_id, "filters.project_id");
    if (projectId !== undefined) request.filters.project_id = projectId;
    const sourceId = optionalString(filters.source_id, "filters.source_id");
    if (sourceId !== undefined) request.filters.source_id = sourceId;
    const publishers = optionalStringArray(filters.publisher_ids, "filters.publisher_ids");
    if (publishers !== undefined) request.filters.publisher_ids = publishers;
    const filterScope = parseEnum(filters.scope, "filters.scope", memoryScopes);
    if (filterScope !== undefined) request.filters.scope = filterScope;
    const filterType = parseEnum(filters.type, "filters.type", memoryTypes);
    if (filterType !== undefined) request.filters.type = filterType;
    const tagsAll = optionalStringArray(filters.tags_all, "filters.tags_all");
    if (tagsAll !== undefined) request.filters.tags_all = tagsAll;
    const filterConfidence = optionalNumber(filters.min_confidence, "filters.min_confidence");
    if (filterConfidence !== undefined) request.filters.min_confidence = filterConfidence;
    const filterImportance = optionalNumber(filters.min_importance, "filters.min_importance");
    if (filterImportance !== undefined) request.filters.min_importance = filterImportance;
  }
  if (raw.as_of !== undefined) request.as_of = parseIsoTimestamp(raw.as_of, "as_of");
  if (raw.temporal !== undefined) throw new ValidationError("temporal is not supported; use as_of");
  const graphValue = raw.graph;
  if (graphValue !== undefined) {
    const graph = asJsonObject(graphValue, "graph");
    const supported = new Set(["enabled", "max_hops", "max_expansions", "relationship_types"]);
    for (const key of Object.keys(graph)) if (!supported.has(key)) throw new ValidationError(`graph.${key} is not supported`);
    const maxHops = optionalNumber(graph.max_hops, "graph.max_hops") ?? 1;
    const maxExpansions = optionalNumber(graph.max_expansions, "graph.max_expansions") ?? 12;
    if ((maxHops !== 0 && maxHops !== 1) || !Number.isSafeInteger(maxExpansions) || maxExpansions < 0 || maxExpansions > 12) throw new ValidationError("graph is limited to one hop and twelve expansions");
    const rawTypes = optionalStringArray(graph.relationship_types, "graph.relationship_types");
    const relationshipTypesFilter = rawTypes?.map((value) => {
      if (!(relationshipTypes as readonly string[]).includes(value)) throw new ValidationError("graph.relationship_types contains an unsupported value");
      return value as MemoryRelationship["type"];
    });
    request.graph = {
      enabled: optionalBoolean(graph.enabled, "graph.enabled") ?? true,
      max_hops: maxHops,
      max_expansions: maxExpansions,
      ...(relationshipTypesFilter ? { relationship_types: relationshipTypesFilter } : {}),
    };
  }
  const diversityValue = raw.diversity ?? raw.mmr;
  if (diversityValue !== undefined) {
    if (typeof diversityValue === "boolean") request.diversity = { enabled: diversityValue, lambda: 0.8 };
    else {
      const diversity = asJsonObject(diversityValue, "diversity");
      const supported = new Set(["enabled", "lambda"]);
      for (const key of Object.keys(diversity)) if (!supported.has(key)) throw new ValidationError(`diversity.${key} is not supported`);
      const lambda = optionalNumber(diversity.lambda, "diversity.lambda") ?? 0.8;
      if (lambda < 0 || lambda > 1) throw new ValidationError("diversity.lambda must be between 0 and 1");
      request.diversity = { enabled: optionalBoolean(diversity.enabled, "diversity.enabled") ?? true, lambda };
    }
  }
  return request;
}

function parseKnowledgeSourceSync(body: unknown): KnowledgeSourceSyncRequest {
  const raw = asJsonObject(body, "knowledge source sync");
  const supported = new Set(["mode", "workspace_id", "project_id", "source_id", "source_uri", "revision", "observed_at", "scope", "expires_at", "chunks"]);
  for (const key of Object.keys(raw)) if (!supported.has(key)) throw new ValidationError(`${key} is not supported by source sync`);
  const mode = parseEnum(raw.mode, "mode", ["preview", "apply"] as const);
  if (!mode) throw new ValidationError("mode is required");
  const workspaceId = requiredString(raw.workspace_id, "workspace_id");
  const projectId = requiredString(raw.project_id, "project_id");
  const sourceId = requiredString(raw.source_id, "source_id");
  if (!/^[a-z][a-z0-9._-]{0,63}$/u.test(projectId)) throw new ValidationError("project_id is invalid");
  if (!/^[A-Za-z0-9][A-Za-z0-9._:/#-]{0,255}$/u.test(sourceId)) throw new ValidationError("source_id is invalid");
  const sourceUri = requiredString(raw.source_uri, "source_uri");
  if (sourceUri.length > 2048) throw new ValidationError("source_uri is too long");
  const revision = requiredString(raw.revision, "revision");
  if (revision.length > 256) throw new ValidationError("revision is too long");
  const observedAt = parseIsoTimestamp(raw.observed_at, "observed_at");
  const expiresAt = raw.expires_at === null || raw.expires_at === undefined ? null : parseIsoTimestamp(raw.expires_at, "expires_at");
  if (raw.scope !== undefined && raw.scope !== "shared") throw new ValidationError("source sync scope must be shared");
  if (!Array.isArray(raw.chunks) || raw.chunks.length > 500) throw new ValidationError("chunks must contain at most 500 records");
  let totalBytes = 0;
  const chunkKeys = new Set<string>();
  const chunks = raw.chunks.map((value, index) => {
    const chunk = asJsonObject(value, `chunks[${index}]`);
    const allowed = new Set(["chunk_key", "content", "content_hash", "heading", "tags", "entities"]);
    for (const key of Object.keys(chunk)) if (!allowed.has(key)) throw new ValidationError(`chunks[${index}].${key} is not supported`);
    const chunkKey = requiredString(chunk.chunk_key, `chunks[${index}].chunk_key`);
    if (!/^[A-Za-z0-9][A-Za-z0-9._:/#-]{0,511}$/u.test(chunkKey) || chunkKeys.has(chunkKey)) throw new ValidationError("chunk_key is invalid or duplicated");
    chunkKeys.add(chunkKey);
    const content = requiredString(chunk.content, `chunks[${index}].content`);
    totalBytes += Buffer.byteLength(content);
    if (Buffer.byteLength(content) > 65536) throw new ValidationError("a source chunk exceeds 65536 bytes");
    const contentHash = requiredString(chunk.content_hash, `chunks[${index}].content_hash`);
    if (!/^[a-f0-9]{64}$/u.test(contentHash) || createHash("sha256").update(content).digest("hex") !== contentHash) throw new ValidationError("content_hash does not match source chunk content");
    const heading = optionalNullableString(chunk.heading, `chunks[${index}].heading`) ?? null;
    const tags = optionalStringArray(chunk.tags, `chunks[${index}].tags`) ?? [];
    const entities = chunk.entities === undefined ? [] : Array.isArray(chunk.entities) ? chunk.entities.map((entity, entityIndex) => {
      const parsed = asJsonObject(entity, `chunks[${index}].entities[${entityIndex}]`);
      for (const key of Object.keys(parsed)) if (!["entity_id", "name", "type"].includes(key)) throw new ValidationError(`chunks[${index}].entities[${entityIndex}].${key} is not supported`);
      const name = requiredString(parsed.name, `chunks[${index}].entities[${entityIndex}].name`);
      const entityId = optionalString(parsed.entity_id, `chunks[${index}].entities[${entityIndex}].entity_id`);
      const entityType = optionalString(parsed.type, `chunks[${index}].entities[${entityIndex}].type`) ?? "topic";
      if (name.length > 200 || (entityId?.length ?? 0) > 256 || entityType.length > 64) throw new ValidationError("source chunk entity exceeds its size limit");
      return { ...(entityId ? { entity_id: entityId } : {}), name, type: entityType };
    }) : (() => { throw new ValidationError(`chunks[${index}].entities must be an array`); })();
    if (entities.length > 32) throw new ValidationError("a source chunk may contain at most 32 entities");
    return { chunk_key: chunkKey, content, content_hash: contentHash, heading, tags, entities };
  });
  if (totalBytes > 4 * 1024 * 1024) throw new ValidationError("source sync exceeds 4 MiB");
  return { mode, workspace_id: workspaceId, project_id: projectId, source_id: sourceId, source_uri: sourceUri, revision, observed_at: observedAt, scope: "shared", expires_at: expiresAt, chunks };
}

function parseSessionCreate(body: unknown): SessionCreate {
  const raw = asJsonObject(body, "session");
  const session: SessionCreate = {
    title: optionalNullableString(raw.title, "title") ?? null,
    scope: parseEnum(raw.scope, "scope", memoryScopes, "private"),
    workspace_id: optionalString(raw.workspace_id, "workspace_id") ?? "default",
    metadata: optionalJsonObject(raw.metadata, "metadata") ?? {},
  };
  const sessionId = optionalString(raw.session_id, "session_id");
  if (sessionId !== undefined) session.session_id = sessionId;
  return session;
}

const messageRoles = ["system", "user", "assistant", "tool", "agent", "observer"] as const satisfies readonly MessageRole[];

function parseEpisodeCreate(body: unknown): { episode_id: string | null; title: string | null; workspace_id: string; session_id: string | null; peer_id: string | null; metadata: JsonObject } {
  const raw = asJsonObject(body, "episode");
  return {
    episode_id: optionalNullableString(raw.episode_id, "episode_id") ?? null,
    title: optionalNullableString(raw.title, "title") ?? null,
    workspace_id: optionalString(raw.workspace_id, "workspace_id") ?? "default",
    session_id: optionalNullableString(raw.session_id, "session_id") ?? null,
    peer_id: optionalNullableString(raw.peer_id, "peer_id") ?? null,
    metadata: optionalJsonObject(raw.metadata, "metadata") ?? {},
  };
}

function parseMessageCreate(body: unknown): { message_id: string | null; role: MessageRole; content: string; speaker_id: string | null; observed_at: string | null; metadata: JsonObject; produce_memory: boolean; memory_type: MemoryType } {
  const raw = asJsonObject(body, "message");
  return {
    message_id: optionalNullableString(raw.message_id, "message_id") ?? null,
    role: parseEnum(raw.role, "role", messageRoles, "user"),
    content: requiredString(raw.content, "content"),
    speaker_id: optionalNullableString(raw.speaker_id, "speaker_id") ?? null,
    observed_at: optionalNullableString(raw.observed_at, "observed_at") ?? null,
    metadata: optionalJsonObject(raw.metadata, "metadata") ?? {},
    produce_memory: optionalBoolean(raw.produce_memory, "produce_memory") ?? true,
    memory_type: parseEnum(raw.memory_type, "memory_type", memoryTypes, "episodic"),
  };
}

function simpleEmbedding(text: string): number[] {
  return deterministicEmbedding(text);
}

const maxConclusionSources = 100;
const queueOperationReceiptLimit = 10_000;
const queueOperationReceiptRetentionMs = 30 * 24 * 60 * 60 * 1000;
const queueOperationPruneIntervalMs = 60 * 60 * 1000;
const conclusionKinds = ["explicit", "deductive", "inductive", "abductive", "summary", "peer_card", "manual"] as const satisfies readonly ConclusionKind[];

function parseConclusionCreate(body: unknown): {
  observer_peer_id: string | null;
  session_id: string | null;
  source_memory_ids: string[];
  content: string;
  kind: ConclusionKind;
  confidence: number;
  workspace_id: string;
  supersedes: string | null;
  metadata: JsonObject;
} {
  const raw = asJsonObject(body, "conclusion");
  return {
    observer_peer_id: optionalNullableString(raw.observer_peer_id, "observer_peer_id") ?? null,
    session_id: optionalNullableString(raw.session_id, "session_id") ?? null,
    source_memory_ids: optionalStringArray(raw.source_memory_ids, "source_memory_ids") ?? [],
    content: requiredString(raw.content, "content"),
    kind: parseEnum(raw.kind, "kind", conclusionKinds, "manual"),
    confidence: optionalNumber(raw.confidence, "confidence", 0.8),
    workspace_id: optionalString(raw.workspace_id, "workspace_id") ?? "default",
    supersedes: optionalNullableString(raw.supersedes, "supersedes") ?? null,
    metadata: optionalJsonObject(raw.metadata, "metadata") ?? {},
  };
}

function parsePeerCardUpsert(body: unknown): ReturnType<typeof parseConclusionCreate> {
  const raw = asJsonObject(body, "peer card");
  return {
    observer_peer_id: optionalNullableString(raw.observer_peer_id, "observer_peer_id") ?? null,
    session_id: null,
    source_memory_ids: optionalStringArray(raw.source_memory_ids, "source_memory_ids") ?? [],
    content: requiredString(raw.content, "content"),
    kind: "peer_card",
    confidence: optionalNumber(raw.confidence, "confidence", 0.8),
    workspace_id: optionalString(raw.workspace_id, "workspace_id") ?? "default",
    supersedes: optionalNullableString(raw.supersedes, "supersedes") ?? null,
    metadata: { ...(optionalJsonObject(raw.metadata, "metadata") ?? {}), resource: "peer_card" },
  };
}

const bundleMetadataKeys = new Set(["default_workspace_id", "default_tags", "preferred_recall_strategy", "tool_configuration"]);
const sensitiveKeyFragments = ["api_key", "apikey", "authorization", "auth_token", "bearer", "credential", "password", "private_key", "secret", "token"] as const;

function isSensitiveKey(key: string): boolean {
  const normalized = key.toLowerCase().replace(/[- ]/gu, "_");
  return sensitiveKeyFragments.some((fragment) => normalized.includes(fragment));
}

function sensitivePaths(value: unknown, prefix: string): string[] {
  const paths: string[] = [];
  if (value && typeof value === "object" && !Array.isArray(value)) {
    for (const [key, nested] of Object.entries(value)) {
      const path = prefix + "." + key;
      if (isSensitiveKey(key)) paths.push(path);
      else paths.push(...sensitivePaths(nested, path));
    }
  } else if (Array.isArray(value)) {
    value.forEach((nested, index) => paths.push(...sensitivePaths(nested, prefix + "[" + index + "]")));
  }
  return paths;
}

function redactSensitive(value: unknown): JsonValue {
  if (Array.isArray(value)) return value.map(redactSensitive);
  if (value && typeof value === "object") {
    const redacted: JsonObject = {};
    for (const [key, nested] of Object.entries(value)) redacted[key] = isSensitiveKey(key) ? "[REDACTED]" : redactSensitive(nested);
    return redacted;
  }
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean" || value === null) return value;
  return null;
}

function parseAgentRegister(body: unknown): { agent_id: string; display_name: string; description: string | null; token_scopes: string[] } {
  const raw = asJsonObject(body, "agent registration");
  const agentId = requiredString(raw.agent_id, "agent_id");
  if (!/^[a-z0-9_-]{2,32}$/u.test(agentId)) throw new ValidationError("agent_id must match ^[a-z0-9_-]{2,32}$");
  return {
    agent_id: agentId,
    display_name: requiredString(raw.display_name, "display_name"),
    description: optionalNullableString(raw.description, "description") ?? null,
    token_scopes: optionalStringArray(raw.token_scopes, "token_scopes") ?? ["memories:read", "memories:write", "sessions:read", "sessions:write", "context:read"],
  };
}

function parseAgentUpdate(body: unknown): { display_name?: string; description?: string | null; active?: boolean } {
  const raw = asJsonObject(body, "agent update");
  const update: { display_name?: string; description?: string | null; active?: boolean } = {};
  const displayName = optionalString(raw.display_name, "display_name");
  const description = optionalNullableString(raw.description, "description");
  if (displayName !== undefined) update.display_name = displayName;
  if (description !== undefined) update.description = description;
  if (typeof raw.active === "boolean") update.active = raw.active;
  return update;
}

function parseAgentBundle(body: unknown): AgentProfileBundle {
  const raw = asJsonObject(body, "agent bundle");
  const agentId = requiredString(raw.agent_id, "agent_id");
  if (!/^[a-z0-9_-]{2,64}$/u.test(agentId)) throw new ValidationError("agent_id must match ^[a-z0-9_-]{2,64}$");
  return {
    agent_id: agentId,
    display_name: requiredString(raw.display_name, "display_name"),
    description: optionalNullableString(raw.description, "description") ?? null,
    default_workspace_id: optionalString(raw.default_workspace_id, "default_workspace_id") ?? "default",
    default_tags: optionalStringArray(raw.default_tags, "default_tags") ?? [],
    preferred_recall_strategy: optionalString(raw.preferred_recall_strategy, "preferred_recall_strategy") ?? "hybrid",
    tool_configuration: optionalJsonObject(raw.tool_configuration, "tool_configuration") ?? {},
    metadata: optionalJsonObject(raw.metadata, "metadata") ?? {},
    exported_at: optionalNullableString(raw.exported_at, "exported_at") ?? null,
  };
}

const reasoningLevels = ["minimal", "low", "medium", "high", "max"] as const satisfies readonly ReasoningLevel[];
const reasoningSourceLimits = { minimal: 2, low: 5, medium: 10, high: 15, max: 50 } as const satisfies Record<ReasoningLevel, number>;

function parseChatRequest(body: unknown): {
  query: string;
  session_id: string | null;
  reasoning_level: ReasoningLevel;
  stream: boolean;
  max_sources: number;
  include_citations: boolean;
  scope?: MemoryScope;
  type?: MemoryType;
  tags?: string[];
  min_confidence?: number;
  workspace_id?: string;
} {
  const raw = asJsonObject(body, "chat");
  const scope = parseEnum(raw.scope, "scope", memoryScopes);
  const type = parseEnum(raw.type, "type", memoryTypes);
  const tags = optionalStringArray(raw.tags, "tags");
  const minConfidence = optionalNumber(raw.min_confidence, "min_confidence");
  const workspaceId = optionalNullableString(raw.workspace_id, "workspace_id");
  const parsed = {
    query: requiredString(raw.query, "query"),
    session_id: optionalNullableString(raw.session_id, "session_id") ?? null,
    reasoning_level: parseEnum(raw.reasoning_level, "reasoning_level", reasoningLevels, "medium"),
    stream: optionalBoolean(raw.stream, "stream") ?? false,
    max_sources: clampLimit(optionalNumber(raw.max_sources, "max_sources"), 5, 50),
    include_citations: optionalBoolean(raw.include_citations, "include_citations") ?? true,
    ...(scope === undefined ? {} : { scope }),
    ...(type === undefined ? {} : { type }),
    ...(tags === undefined ? {} : { tags }),
    ...(minConfidence === undefined ? {} : { min_confidence: minConfidence }),
    ...(workspaceId === undefined || workspaceId === null ? {} : { workspace_id: workspaceId }),
  };
  return parsed;
}

function chatSourceFromSearchResult(result: SearchResponse["results"][number]): ChatSourceMemory {
  const content = result.memory.content.length > 500 ? result.memory.content.slice(0, 497) + "..." : result.memory.content;
  return {
    memory_id: result.memory.id,
    collection: result.collection,
    content,
    score: result.score,
    confidence: result.memory.confidence,
    effective_confidence: result.memory.effective_confidence ?? result.memory.confidence,
    importance: result.memory.importance,
    tags: result.memory.tags,
    agent_id: result.memory.agent_id,
    created_at: result.memory.created_at,
    is_own: result.is_own,
  };
}

function rankChatSources(results: SearchResponse["results"], maxSources: number, reasoningLevel: ReasoningLevel): ChatSourceMemory[] {
  const cap = Math.min(maxSources, reasoningSourceLimits[reasoningLevel]);
  return [...results]
    .sort((left, right) => {
      const leftConfidence = left.memory.effective_confidence ?? left.memory.confidence;
      const rightConfidence = right.memory.effective_confidence ?? right.memory.confidence;
      return right.score - left.score || rightConfidence - leftConfidence || right.memory.importance - left.memory.importance || right.memory.created_at.localeCompare(left.memory.created_at);
    })
    .slice(0, cap)
    .map(chatSourceFromSearchResult);
}

function synthesizeChatAnswer(query: string, sources: readonly ChatSourceMemory[], reasoningLevel: ReasoningLevel): string {
  if (sources.length === 0) return "No accessible memories matched the question: " + query;
  const highConfidence = sources.filter((source) => source.effective_confidence >= 0.7);
  const tagCounts = new Map<string, number>();
  for (const source of sources) for (const tag of source.tags) tagCounts.set(tag, (tagCounts.get(tag) ?? 0) + 1);
  const themes = [...tagCounts.entries()].sort((left, right) => right[1] - left[1]).slice(0, 3).map(([tag]) => tag).join(", ") || "available memories";
  const lead = highConfidence[0] ?? sources[0]!;
  if (reasoningLevel === "minimal") return "Based on the strongest memory: " + lead.content;
  if (reasoningLevel === "low") return "The best evidence for '" + query + "' points to " + themes + ". Key source: " + lead.content;
  const confidencePhrase = highConfidence.length > 0 ? highConfidence.length + " high-confidence source(s)" : "the available lower-confidence sources";
  const extra = sources.slice(1, 3).map((source) => source.content).join(" ");
  const base = "Regarding '" + query + "', " + confidencePhrase + " across " + sources.length + " memory source(s) suggest themes around " + themes + ". The strongest evidence says: " + lead.content;
  return extra ? base + " Additional supporting evidence: " + extra : base;
}

function chatUsage(query: string, answer: string, sources: readonly ChatSourceMemory[]): ChatResponse["usage"] {
  const queryTokens = estimateTokens(query);
  const answerTokens = estimateTokens(answer);
  const sourceTokens = sources.reduce((total, source) => total + estimateTokens(source.content), 0);
  return { query_tokens: queryTokens, answer_tokens: answerTokens, source_tokens: sourceTokens, total_tokens: queryTokens + answerTokens + sourceTokens };
}

const workspaceRoles = ["viewer", "member", "admin", "owner"] as const satisfies readonly WorkspaceRole[];
const workspacePermissionRank = { viewer: 1, member: 2, admin: 3, owner: 4 } as const satisfies Record<WorkspaceRole, number>;
const workspaceRequiredRank = { read: 1, write: 2, admin: 3, owner: 4 } as const;

function defaultSanitizationPolicy(): WorkspacePolicy["sanitization"] {
  return { mode: null, detect_pii: null, detect_secrets: null, deny_regexes: [] };
}

function defaultWorkspacePolicy(): WorkspacePolicy {
  return {
    retention_days: null,
    allowed_scopes: ["*"],
    reasoning_provider: null,
    consolidation_cadence_seconds: null,
    webhooks_enabled: true,
    sanitization: defaultSanitizationPolicy(),
    agent_overrides: {},
    session_overrides: {},
  };
}

function parseStringMap(value: unknown, name: string): Record<string, JsonObject> {
  if (value === undefined) return {};
  const raw = asJsonObject(value, name);
  const parsed: Record<string, JsonObject> = {};
  for (const [key, mapValue] of Object.entries(raw)) {
    parsed[key] = asJsonObject(mapValue, name + "." + key);
  }
  return parsed;
}

function parseWorkspaceSanitization(value: unknown): WorkspacePolicy["sanitization"] {
  const fallback = defaultSanitizationPolicy();
  if (value === undefined) return fallback;
  const raw = asJsonObject(value, "sanitization");
  const mode = parseEnum(raw.mode ?? undefined, "sanitization.mode", ["warn", "redact", "reject"] as const);
  return {
    mode: mode ?? null,
    detect_pii: raw.detect_pii === undefined || raw.detect_pii === null ? null : optionalBoolean(raw.detect_pii, "sanitization.detect_pii") ?? null,
    detect_secrets: raw.detect_secrets === undefined || raw.detect_secrets === null ? null : optionalBoolean(raw.detect_secrets, "sanitization.detect_secrets") ?? null,
    deny_regexes: optionalStringArray(raw.deny_regexes, "sanitization.deny_regexes") ?? [],
  };
}

function parseWorkspacePolicy(value: unknown): WorkspacePolicy {
  const fallback = defaultWorkspacePolicy();
  if (value === undefined) return fallback;
  const raw = asJsonObject(value, "policy");
  return {
    retention_days: raw.retention_days === undefined || raw.retention_days === null ? null : optionalNumber(raw.retention_days, "policy.retention_days") ?? null,
    allowed_scopes: optionalStringArray(raw.allowed_scopes, "policy.allowed_scopes") ?? fallback.allowed_scopes,
    reasoning_provider: optionalNullableString(raw.reasoning_provider, "policy.reasoning_provider") ?? null,
    consolidation_cadence_seconds: raw.consolidation_cadence_seconds === undefined || raw.consolidation_cadence_seconds === null ? null : optionalNumber(raw.consolidation_cadence_seconds, "policy.consolidation_cadence_seconds") ?? null,
    webhooks_enabled: optionalBoolean(raw.webhooks_enabled, "policy.webhooks_enabled") ?? true,
    sanitization: parseWorkspaceSanitization(raw.sanitization),
    agent_overrides: parseStringMap(raw.agent_overrides, "policy.agent_overrides"),
    session_overrides: parseStringMap(raw.session_overrides, "policy.session_overrides"),
  };
}

function parseWorkspaceMember(value: unknown, index: number): WorkspaceMember {
  const raw = asJsonObject(value, "members[" + index + "]");
  const agentId = requiredString(raw.agent_id, "members[" + index + "].agent_id");
  return {
    agent_id: agentId,
    role: parseEnum(raw.role, "members[" + index + "].role", workspaceRoles, "member"),
    scopes: optionalStringArray(raw.scopes, "members[" + index + "].scopes") ?? [],
    added_by: optionalNullableString(raw.added_by, "members[" + index + "].added_by") ?? null,
    created_at: optionalNullableString(raw.created_at, "members[" + index + "].created_at") ?? null,
    updated_at: optionalNullableString(raw.updated_at, "members[" + index + "].updated_at") ?? null,
  };
}

function parseWorkspaceMembers(value: unknown): WorkspaceMember[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new ValidationError("members must be an array");
  const byAgent = new Map<string, WorkspaceMember>();
  for (const [index, member] of value.entries()) {
    const parsed = parseWorkspaceMember(member, index);
    if (!byAgent.has(parsed.agent_id)) byAgent.set(parsed.agent_id, parsed);
  }
  return [...byAgent.values()];
}

function normalizeWorkspaceMembers(ownerAgentId: string, members: readonly WorkspaceMember[], addedBy: string): WorkspaceMember[] {
  const timestamp = nowIso();
  const byAgent = new Map<string, WorkspaceMember>();
  byAgent.set(ownerAgentId, { agent_id: ownerAgentId, role: "owner", scopes: ["*"], added_by: ownerAgentId, created_at: timestamp, updated_at: timestamp });
  for (const member of members) {
    if (!member.agent_id) continue;
    byAgent.set(member.agent_id, {
      ...member,
      role: member.agent_id === ownerAgentId ? "owner" : member.role,
      scopes: member.agent_id === ownerAgentId ? ["*"] : member.scopes,
      added_by: member.added_by ?? addedBy,
      created_at: member.created_at ?? timestamp,
      updated_at: member.updated_at ?? timestamp,
    });
  }
  const owner = byAgent.get(ownerAgentId);
  if (owner) byAgent.set(ownerAgentId, { ...owner, role: "owner", scopes: ["*"] });
  return [...byAgent.values()];
}

function parseWorkspaceCreate(body: unknown): { workspace_id: string; title: string | null; description: string | null; metadata: JsonObject; policy: WorkspacePolicy; members: WorkspaceMember[] } {
  const raw = asJsonObject(body, "workspace");
  return {
    workspace_id: requiredString(raw.workspace_id, "workspace_id"),
    title: optionalNullableString(raw.title, "title") ?? null,
    description: optionalNullableString(raw.description, "description") ?? null,
    metadata: optionalJsonObject(raw.metadata, "metadata") ?? {},
    policy: parseWorkspacePolicy(raw.policy),
    members: parseWorkspaceMembers(raw.members),
  };
}

function parseWorkspaceUpdate(body: unknown): Partial<Pick<WorkspaceRecord, "title" | "description" | "metadata" | "policy">> {
  const raw = asJsonObject(body, "workspace update");
  const update: Partial<Pick<WorkspaceRecord, "title" | "description" | "metadata" | "policy">> = {};
  const title = optionalNullableString(raw.title, "title");
  if (title !== undefined) update.title = title;
  const description = optionalNullableString(raw.description, "description");
  if (description !== undefined) update.description = description;
  const metadata = optionalJsonObject(raw.metadata, "metadata");
  if (metadata !== undefined) update.metadata = metadata;
  if (raw.policy !== undefined) update.policy = parseWorkspacePolicy(raw.policy);
  return update;
}

function deepMergeJson(base: JsonObject, override: JsonObject): JsonObject {
  const merged: JsonObject = { ...base };
  for (const [key, value] of Object.entries(override)) {
    const current = merged[key];
    if (value && typeof value === "object" && !Array.isArray(value) && current && typeof current === "object" && !Array.isArray(current)) {
      merged[key] = deepMergeJson(current as JsonObject, value as JsonObject);
    } else {
      merged[key] = value;
    }
  }
  return merged;
}

function workspacePolicyJson(policy: WorkspacePolicy): JsonObject {
  return {
    retention_days: policy.retention_days,
    allowed_scopes: policy.allowed_scopes,
    reasoning_provider: policy.reasoning_provider,
    consolidation_cadence_seconds: policy.consolidation_cadence_seconds,
    webhooks_enabled: policy.webhooks_enabled,
    sanitization: {
      mode: policy.sanitization.mode,
      detect_pii: policy.sanitization.detect_pii,
      detect_secrets: policy.sanitization.detect_secrets,
      deny_regexes: policy.sanitization.deny_regexes,
    },
    agent_overrides: policy.agent_overrides,
    session_overrides: policy.session_overrides,
  };
}

const webhookEventTypes = [
  "memory.created",
  "session.created",
  "queue.empty",
  "summary.updated",
  "peer_card.updated",
  "conflict.detected",
  "webhook.test",
] as const satisfies readonly WebhookEventType[];

const defaultWebhookEventTypes = webhookEventTypes.filter((eventType) => eventType !== "webhook.test");
const blockedWebhookHeaderNames = new Set(["authorization", "content-length", "host"]);

function assertWebhookUrl(url: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new BadRequestError("Webhook URL must be a valid HTTPS URL");
  }
  if (parsed.protocol !== "https:") throw new BadRequestError("Webhook URL must use https");
  if (parsed.username || parsed.password) throw new BadRequestError('Webhook URL cannot include credentials');
  const host = parsed.hostname.replace(/^\[|\]$/gu, "").toLowerCase();
  if (allowedPrivateWebhookHost(host)) return;
  const octets = host.split(".").map((part) => Number.parseInt(part, 10));
  const isIpv4 = octets.length === 4 && octets.every((part) => Number.isInteger(part) && part >= 0 && part <= 255);
  const [first = -1, second = -1] = octets;
  if (
    host === "localhost" ||
    host === "::1" ||
    host === "0:0:0:0:0:0:0:1" ||
    (isIpv4 && (first === 10 || first === 127 || (first === 169 && second === 254) || (first === 172 && second >= 16 && second <= 31) || (first === 192 && second === 168)))
  ) {
    throw new BadRequestError("Webhook URL cannot target private, loopback, or link-local addresses");
  }
}

function parseWebhookHeaders(value: unknown): Record<string, string> {
  if (value === undefined) return {};
  const raw = asJsonObject(value, "headers");
  const headers: Record<string, string> = {};
  for (const [key, headerValue] of Object.entries(raw)) {
    if (typeof headerValue !== "string") throw new ValidationError("headers must contain string values");
    const normalized = key.toLowerCase();
    if (blockedWebhookHeaderNames.has(normalized)) throw new ValidationError("headers cannot include " + key);
    headers[key] = headerValue;
  }
  return headers;
}

function parseWebhookEventTypes(value: unknown): WebhookEventType[] {
  if (value === undefined) return [...defaultWebhookEventTypes];
  if (!Array.isArray(value)) throw new ValidationError("event_types must be an array");
  const parsed: WebhookEventType[] = [];
  for (const [index, eventType] of value.entries()) {
    if (typeof eventType !== "string") throw new ValidationError("event_types[" + index + "] must be a string");
    const parsedEventType = parseEnum(eventType, "event_types[" + index + "]", webhookEventTypes);
    if (!parsedEventType) throw new ValidationError("event_types[" + index + "] is required");
    parsed.push(parsedEventType);
  }
  return [...new Set(parsed)];
}

function parseWebhookCreate(body: unknown): {
  workspace_id: string;
  url: string;
  event_types: WebhookEventType[];
  enabled: boolean;
  headers: Record<string, string>;
  has_secret: boolean;
  metadata: JsonObject;
} {
  const raw = asJsonObject(body, "webhook");
  const url = requiredString(raw.url, "url");
  assertWebhookUrl(url);
  return {
    workspace_id: optionalString(raw.workspace_id, "workspace_id") ?? "default",
    url,
    event_types: parseWebhookEventTypes(raw.event_types),
    enabled: optionalBoolean(raw.enabled, "enabled") ?? true,
    headers: parseWebhookHeaders(raw.headers),
    has_secret: typeof raw.secret === "string" && raw.secret.trim().length > 0,
    metadata: optionalJsonObject(raw.metadata, "metadata") ?? {},
  };
}

function parseWebhookTest(body: unknown): { workspace_id: string; event_type: WebhookEventType; data: JsonObject } {
  const raw = asJsonObject(body, "webhook test");
  return {
    workspace_id: optionalString(raw.workspace_id, "workspace_id") ?? "default",
    event_type: parseEnum(raw.event_type, "event_type", webhookEventTypes, "webhook.test"),
    data: optionalJsonObject(raw.data, "data") ?? {},
  };
}

export class InMemoryHiveMemStore {
  private readonly operations = new Map<string, JsonObject>();
  private readonly queueOperationsByJob = new Map<string, string>();
  private queueOperationsPrunedAt = 0;
  private readonly memories = new Map<string, MemoryRecord>();
  private readonly agents = new Map<string, AgentInfo & { metadata: JsonObject }>();
  private readonly conclusions = new Map<string, ConclusionRecord>();
  private readonly episodes = new Map<string, EpisodeRecord>();
  private readonly messages = new Map<string, MessageRecord>();
  private readonly sessions = new Map<string, SessionRecord>();
  private readonly workspaces = new Map<string, WorkspaceRecord>();
  private readonly queueJobs = new Map<string, QueueJobRecord>();
  private readonly webhooks = new Map<string, WebhookEndpointRecord>();
  private readonly webhookDeliveries = new Map<string, WebhookDeliveryRecord>();
  private readonly persistence: HiveMemPersistence | null;
  private persistenceQueue: Promise<void> = Promise.resolve();
  private persistenceError: Error | null = null;
  private persistenceDirty = false;
  private persisting = false;
  private lastPersistedAt: string | null = null;

  async persistenceHealth(): Promise<{ ready: boolean; mode: string; pending: boolean; last_success: string | null }> {
    let ready = !this.persistenceError;
    try { await this.persistence?.probe?.(); } catch { ready = false; }
    return { ready, mode: this.persistence?.kind ?? "memory", pending: this.persisting || this.persistenceDirty, last_success: this.lastPersistedAt };
  }

  retryPersistence(): void {
    if (this.persistenceDirty && !this.persisting) this.startPersistence();
  }


  private readonly webhookTransport: (request: WebhookRequest) => Promise<number>;
  private workerHeartbeat: string | null = null;
  private workerRunning = false;
  private workerManaged = false;
  private workerEnabled = false;
  private workerLastSuccess: string | null = null;
  private workerError: string | null = null;
  private recoveredOnStartup = 0;

  configureWorker(enabled: boolean): void {
    this.workerManaged = true; this.workerEnabled = enabled; this.workerHeartbeat = nowIso();
  }

  /** Call only after the CLI acquires the exclusive writer lock. No job from the
   * prior process can still be executing, so its claim need not wait for expiry. */
  recoverInterruptedJobs(): number {
    let recovered = 0;
    for (const [id, job] of this.queueJobs) if (job.status === "in_progress") {
      this.queueJobs.set(id, { ...job, status: "pending", locked_at: null, not_before: null, error: "Recovered interrupted writer" });
      recovered++;
    }
    this.recoveredOnStartup = recovered;
    if (recovered) {
      this.operations.set("worker:last-recovery", { id: "worker:last-recovery", kind: "worker-recovery", recovered_jobs: recovered, created_at: nowIso() });
      this.queuePersistence();
    }
    return recovered;
  }

  workerHealth(): WorkerHealth {
    const pending = [...this.queueJobs.values()].filter((job) => job.status === "pending" || job.status === "failed");
    const stale = this.workerManaged && this.workerEnabled && (!this.workerHeartbeat || Date.now() - Date.parse(this.workerHeartbeat) > 60_000);
    const ready = !this.workerManaged || !this.workerEnabled || (!stale && !this.workerError);
    const state = !this.workerManaged ? "manual" : !this.workerEnabled ? "disabled" : stale ? "stale" : this.workerError ? "degraded" : this.workerRunning ? "running" : this.workerLastSuccess ? "idle" : "starting";
    return { ready, state, managed: this.workerManaged, enabled: this.workerEnabled, running: this.workerRunning, heartbeat: this.workerHeartbeat, last_success: this.workerLastSuccess, error: this.workerError, recovered_on_startup: this.recoveredOnStartup, pending_jobs: pending.length, oldest_pending_seconds: pending.length ? Math.max(...pending.map((job) => Math.max(0, (Date.now() - Date.parse(job.created_at)) / 1000))) : null };
  }

  constructor(options: { snapshot?: HiveMemSnapshot; persistence?: HiveMemPersistence; webhookTransport?: (request: WebhookRequest) => Promise<number> } = {}) {
    this.webhookTransport = options.webhookTransport ?? deliverWebhook;
    this.persistence = options.persistence ?? null;
    if (options.snapshot) this.hydrate(options.snapshot);
  }

  snapshot(): HiveMemSnapshot {
    return {
      operations: [...this.operations.values()],
      memories: [...this.memories.values()],
      agents: [...this.agents.values()].map((agent): PersistedAgentRecord => ({ ...agent })),
      conclusions: [...this.conclusions.values()],
      episodes: [...this.episodes.values()],
      messages: [...this.messages.values()],
      sessions: [...this.sessions.values()],
      workspaces: [...this.workspaces.values()],
      queueJobs: [...this.queueJobs.values()],
      webhooks: [...this.webhooks.values()],
      webhookDeliveries: [...this.webhookDeliveries.values()],
    };
  }

  async flushPersistence(): Promise<void> {
    let checkpoint: Promise<void>;
    do {
      checkpoint = this.persistenceQueue;
      await checkpoint;
    } while (checkpoint !== this.persistenceQueue);
    if (this.persistenceError) {
      const error = new Error("Memory persistence unavailable; write outcome is indeterminate") as Error & { status: number };
      error.status = 503;
      throw error;
    }
  }

  private hydrate(snapshot: HiveMemSnapshot): void {
    for (const record of snapshot.operations ?? []) {
      if (typeof record.id !== "string") continue;
      this.operations.set(record.id, record);
      if (record.kind === "queue-operation" && typeof record.job_id === "string") this.queueOperationsByJob.set(record.job_id, record.id);
    }
    for (const record of snapshot.memories) this.memories.set(record.id, record);
    for (const record of snapshot.agents) this.agents.set(record.agent_id, record);
    for (const record of snapshot.conclusions) this.conclusions.set(record.id, record);
    for (const record of snapshot.episodes) this.episodes.set(record.id, record);
    for (const record of snapshot.messages) this.messages.set(record.id, record);
    for (const record of snapshot.sessions) this.sessions.set(record.session_id, record);
    for (const record of snapshot.workspaces) this.workspaces.set(record.workspace_id, record);
    for (const record of snapshot.queueJobs) this.queueJobs.set(record.id, record);
    for (const record of snapshot.webhooks) this.webhooks.set(record.id, record);
    for (const record of snapshot.webhookDeliveries) this.webhookDeliveries.set(record.id, record);
  }

  private queuePersistence(): void {
    if (!this.persistence) return;
    // At most one active and one coalesced pending checkpoint, never an
    // unbounded promise chain retaining a full snapshot for each mutation.
    this.persistenceDirty = true;
    if (!this.persisting) this.startPersistence();
  }

  private startPersistence(): void {
    this.persisting = true;
    this.persistenceQueue = Promise.resolve().then(async () => {
      try {
        while (this.persistenceDirty) {
          this.persistenceDirty = false;
          const snapshot = structuredClone(this.snapshot());
          try {
            await this.persistence?.save(snapshot);
            this.lastPersistedAt = nowIso();
            this.persistenceError = null;
          } catch (error) {
            this.persistenceDirty = true;
            this.persistenceError = error instanceof Error ? error : new Error(String(error));
            break;
          }
        }
      } finally {
        // Release ownership in the same microtask as the final dirty check.
        // A chained Promise.finally leaves a gap where a mutation marks dirty
        // while still seeing persisting=true, then never starts its checkpoint.
        this.persisting = false;
      }
    });
  }

  createMemory(principal: AuthPrincipal, body: unknown): MemoryRecord {
    this.ensureAgent(principal.agentId);
    const parsed = parseMemoryCreate(body);
    this.assertWorkspacePermission(principal, parsed.workspace_id ?? "default", "write");
    const timestamp = nowIso();
    const superseded = parsed.supersedes ? this.getMemory(principal, parsed.supersedes) : null;
    if (superseded) {
      assertCanWrite(superseded, principal);
      if (superseded.workspace_id !== (parsed.workspace_id ?? "default")) throw new ValidationError("supersedes must reference a memory in the same workspace");
    }
    const record: MemoryRecord = {
      ...parsed,
      id: randomUUID(),
      agent_id: principal.agentId,
      source: parsed.source ?? "conversation",
      confidence: parsed.confidence ?? 0.8,
      importance: parsed.importance ?? 0.5,
      tags: parsed.tags ?? [],
      metadata: parsed.metadata ?? {},
      sensitivity: parsed.sensitivity ?? "internal",
      retention_class: parsed.retention_class ?? "standard",
      redaction_policy: parsed.redaction_policy ?? "none",
      workspace_id: parsed.workspace_id ?? "default",
      session_id: parsed.session_id ?? null,
      created_at: timestamp,
      updated_at: timestamp,
      expires_at: parsed.expires_at ?? null,
      valid_from: parsed.valid_from ?? null,
      valid_to: parsed.valid_to ?? null,
      observed_at: parsed.observed_at ?? null,
      relationships: parsed.relationships ?? [],
      confidence_provenance: [],
      supersedes: parsed.supersedes ?? null,
      superseded_by: null,
      superseded_at: null,
      corroborated_by: [],
      endorsements: 0,
      endorsed_by: [],
      opposed_by: [],
      deleted_at: null,
      effective_confidence: parsed.confidence ?? 0.8,
      sanitization_warnings: null,
    };
    if (superseded) {
      this.memories.set(superseded.id, { ...superseded, superseded_by: record.id, superseded_at: timestamp, updated_at: timestamp });
      this.invalidateDerived(superseded.id);
    }
    this.memories.set(record.id, record);
    this.queuePersistence();
    if (record.scope === "shared") {
      this.enqueueJob({
        task_type: "conflict_scan",
        work_unit_key: "memory:" + record.id,
        payload: { memory_id: record.id, collection: collectionFor(record) },
        owner_agent_id: principal.agentId,
        workspace_id: record.workspace_id,
        peer_id: typeof record.metadata.peer_id === "string" ? record.metadata.peer_id : null,
        observed_peer_id: typeof record.metadata.peer_id === "string" ? record.metadata.peer_id : null,
        idempotency_key: "conflict_scan:" + record.id,
      });
    }
    if (record.session_id) {
      for (const taskType of ["representation", "summary"] as const) {
        this.enqueueJob({
          task_type: taskType,
          work_unit_key: "session:" + record.session_id,
          payload: { session_id: record.session_id, memory_id: record.id },
          owner_agent_id: principal.agentId,
          workspace_id: record.workspace_id,
          session_id: record.session_id,
          peer_id: typeof record.metadata.peer_id === "string" ? record.metadata.peer_id : null,
          observed_peer_id: typeof record.metadata.peer_id === "string" ? record.metadata.peer_id : null,
          idempotency_key: taskType + ":session:" + record.session_id + ":" + record.workspace_id,
          priority: 0,
        });
      }
    }
    this.emitWebhookForResource(principal, "memory.created", record.workspace_id, "memory", record.id, {
      memory_id: record.id,
      content: record.content,
      type: record.type,
      scope: record.scope,
      session_id: record.session_id,
      tags: record.tags,
    });
    return record;
  }

  createMemories(principal: AuthPrincipal, body: unknown): MemoryRecord[] {
    const raw = asJsonObject(body, "batch");
    if (!Array.isArray(raw.memories) || raw.memories.length === 0) {
      throw new ValidationError("memories must be a non-empty array");
    }
    return raw.memories.map((memory) => this.createMemory(principal, memory));
  }

  syncKnowledgeSource(principal: AuthPrincipal, body: unknown): KnowledgeSourceSyncResponse {
    const request = parseKnowledgeSourceSync(body);
    this.assertWorkspacePermission(principal, request.workspace_id, "write");
    const matching = [...this.memories.values()].filter((memory) =>
      memory.workspace_id === request.workspace_id
      && memory.scope === "shared"
      && memory.metadata.project_id === request.project_id
      && memory.metadata.source_id === request.source_id
      && memory.metadata.content_kind === "project_source_chunk"
      && memoryCurrent(memory));
    const foreignOwner = matching.find((memory) => memory.agent_id !== principal.agentId);
    if (foreignOwner) throw new ConflictError("Knowledge source is owned by another publisher");
    const existingByKey = new Map(matching.map((memory) => [jsonString(memory.metadata.chunk_key) ?? "", memory]));
    const incomingKeys = new Set(request.chunks.map((chunk) => chunk.chunk_key));
    const createdChunks = request.chunks.filter((chunk) => !existingByKey.has(chunk.chunk_key));
    const changedChunks = request.chunks.filter((chunk) => {
      const existing = existingByKey.get(chunk.chunk_key);
      return Boolean(existing && existing.metadata.content_hash !== chunk.content_hash);
    });
    const unchangedChunks = request.chunks.filter((chunk) => existingByKey.get(chunk.chunk_key)?.metadata.content_hash === chunk.content_hash);
    const retired = matching.filter((memory) => {
      const key = jsonString(memory.metadata.chunk_key);
      return Boolean(key && !incomingKeys.has(key));
    });
    const response: KnowledgeSourceSyncResponse = {
      mode: request.mode,
      workspace_id: request.workspace_id,
      project_id: request.project_id,
      source_id: request.source_id,
      revision: request.revision,
      created: createdChunks.length,
      superseded: changedChunks.length,
      retired: retired.length,
      unchanged: unchangedChunks.length,
      created_ids: [],
      superseded_ids: changedChunks.map((chunk) => existingByKey.get(chunk.chunk_key)!.id),
      retired_ids: retired.map((memory) => memory.id),
    };
    if (request.mode === "preview") return response;

    for (const chunk of [...createdChunks, ...changedChunks]) {
      const existing = existingByKey.get(chunk.chunk_key);
      const record = this.createMemory(principal, {
        content: chunk.content,
        type: "semantic",
        scope: "shared",
        source: "research",
        confidence: 0.9,
        importance: 0.6,
        workspace_id: request.workspace_id,
        observed_at: request.observed_at,
        expires_at: request.expires_at,
        tags: [...new Set(["hermes-team", projectTag(request.project_id), "project-source", ...(chunk.tags ?? [])])],
        sensitivity: "internal",
        redaction_policy: "redact",
        ...(existing ? { supersedes: existing.id, relationships: [{ target_id: existing.id, type: "updates", confidence: 1, metadata: { instruction_authority: "none", automatic: true } }] } : {}),
        metadata: {
          project_id: request.project_id,
          source_id: request.source_id,
          source_ref: request.source_uri,
          source_uri: request.source_uri,
          revision: request.revision,
          chunk_key: chunk.chunk_key,
          content_hash: chunk.content_hash,
          heading: chunk.heading,
          entities: chunk.entities,
          instruction_authority: "none",
          content_kind: "project_source_chunk",
          freshness_class: "stable",
          publication_origin: "operator_ingest",
        },
      });
      response.created_ids.push(record.id);
    }
    for (const memory of retired) {
      const closed = { ...memory, valid_to: request.observed_at, updated_at: request.observed_at };
      this.memories.set(memory.id, closed);
      this.invalidateDerived(memory.id);
    }
    if (retired.length) this.queuePersistence();
    return response;
  }

  getMemory(principal: AuthPrincipal, id: string, includeHistory = false): MemoryRecord {
    const memory = this.memories.get(id);
    const expired = Boolean(memory?.expires_at && Date.parse(memory.expires_at) <= Date.now());
    const visible = memory && !memory.deleted_at && !expired && (includeHistory || this.currentMemory(memory)) && canRead(memory, principal);
    if (!memory || !visible) throw new NotFoundError("Memory not found");
    this.assertWorkspacePermission(principal, memory.workspace_id, "read");
    return memory;
  }

  updateMemory(principal: AuthPrincipal, id: string, body: unknown): MemoryRecord {
    const memory = this.getMemory(principal, id);
    assertCanWrite(memory, principal);
    const update = parseMemoryUpdate(body);
    const updated: MemoryRecord = {
      ...memory,
      ...update,
      metadata: update.metadata ?? memory.metadata,
      tags: update.tags ?? memory.tags,
      updated_at: nowIso(),
      effective_confidence: update.confidence ?? memory.effective_confidence,
    };
    this.memories.set(id, updated);
    this.queuePersistence();
    return updated;
  }

  deleteMemory(principal: AuthPrincipal, id: string): void {
    const memory = this.getMemory(principal, id, true);
    assertCanWrite(memory, principal);
    this.memories.set(id, { ...memory, deleted_at: nowIso(), updated_at: nowIso() });
    this.invalidateDerived(id);
    this.queuePersistence();
  }

  browse(principal: AuthPrincipal, params: URLSearchParams): BrowseResponse {
    const offset = Math.max(0, Number.parseInt(params.get("offset") ?? "0", 10) || 0);
    const limit = clampLimit(Number.parseInt(params.get("limit") ?? "50", 10) || 50, 50, 500);
    const workspaceId = params.get("workspace_id") ?? "default";
    this.assertWorkspacePermission(principal, workspaceId, "read");
    const sessionId = params.get("session_id");
    const scope = params.get("scope") as MemoryScope | null;
    const type = params.get("type") as MemoryType | null;
    const includeDeleted = params.get("include_deleted") === "true";
    const memories = [...this.memories.values()]
      .filter((memory) => canRead(memory, principal))
      .filter((memory) => includeDeleted ? isAdmin(principal) : this.currentMemory(memory))
      .filter((memory) => workspaceId === "*" || memory.workspace_id === workspaceId)
      .filter((memory) => !sessionId || memory.session_id === sessionId)
      .filter((memory) => !scope || memory.scope === scope)
      .filter((memory) => !type || memory.type === type)
      .sort((left, right) => right.updated_at.localeCompare(left.updated_at));
    const page = memories.slice(offset, offset + limit);
    return {
      memories: page,
      results: page,
      total: memories.length,
      offset,
      limit,
      next_cursor: offset + limit < memories.length ? String(offset + limit) : null,
    };
  }

  private searchCandidates(principal: AuthPrincipal, body: unknown): { request: SearchRequest; candidates: MemoryRecord[] } {
    const request = parseSearchRequest(body);
    this.assertWorkspacePermission(principal, request.workspace_id ?? "default", "read");
    const includeSensitive = request.include_sensitive === true;
    const asOf = request.as_of ? Date.parse(request.as_of) : Date.now();
    const filters = request.filters;
    const candidates = [...this.memories.values()]
      .filter((memory) => canRead(memory, principal))
      .filter((memory) => request.include_deleted === true || this.currentMemoryAt(memory, asOf))
      .filter((memory) => includeSensitive || (memory.sensitivity !== "sensitive" && memory.sensitivity !== "restricted" && memory.redaction_policy !== "exclude"))
      .filter((memory) => !request.workspace_id || request.workspace_id === "*" || memory.workspace_id === request.workspace_id)
      .filter((memory) => !request.session_id || memory.session_id === request.session_id)
      .filter((memory) => !request.scope || memory.scope === request.scope)
      .filter((memory) => !request.type || memory.type === request.type)
      .filter((memory) => !request.agent_filter || memory.agent_id === request.agent_filter)
      .filter((memory) => request.from_self === undefined || (request.from_self ? memory.agent_id === principal.agentId : memory.agent_id !== principal.agentId))
      .filter((memory) => request.min_confidence === undefined || memory.confidence >= request.min_confidence)
      .filter((memory) => request.min_importance === undefined || memory.importance >= request.min_importance)
      .filter((memory) => !request.tags?.length || request.tags.some((tag) => memory.tags.includes(tag)))
      .filter((memory) => !filters?.project_id || memory.metadata.project_id === filters.project_id)
      .filter((memory) => !filters?.source_id || memory.metadata.source_id === filters.source_id)
      .filter((memory) => !filters?.publisher_ids?.length || filters.publisher_ids.includes(memory.agent_id))
      .filter((memory) => !filters?.scope || memory.scope === filters.scope)
      .filter((memory) => !filters?.type || memory.type === filters.type)
      .filter((memory) => !filters?.tags_all?.length || filters.tags_all.every((tag) => memory.tags.includes(tag)))
      .filter((memory) => filters?.min_confidence === undefined || memory.confidence >= filters.min_confidence)
      .filter((memory) => filters?.min_importance === undefined || memory.importance >= filters.min_importance);

    return { request, candidates };
  }

  private citation(memory: MemoryRecord, path: string[], historical: boolean): MemoryCitation {
    return {
      memory_id: memory.id,
      publisher: memory.agent_id,
      source_ref: jsonString(memory.metadata.source_ref) ?? jsonString(memory.metadata.source),
      revision: jsonString(memory.metadata.revision),
      observed_at: memory.observed_at,
      valid_from: memory.valid_from,
      valid_to: memory.valid_to,
      expires_at: memory.expires_at,
      freshness: historical ? "historical" : memory.metadata.freshness_class === "live_required" ? "live_recheck" : "current",
      relationship_path: path,
    };
  }

  private rankedSearch(principal: AuthPrincipal, body: unknown): { request: SearchRequest; candidates: MemoryRecord[]; results: SearchResult[]; graphExpansions: number } {
    const { request, candidates } = this.searchCandidates(principal, body);
    const terms = tokenize(request.query ?? "");
    const lexical = candidates.map((memory) => {
      const haystack = `${memory.content} ${memory.tags.join(" ")} ${jsonString(memory.metadata.heading) ?? ""}`.toLowerCase();
      const hits = terms.length ? terms.reduce((count, term) => count + (haystack.includes(term) ? 1 : 0), 0) : 1;
      return { memory, hits, coverage: terms.length ? hits / terms.length : 1 };
    }).filter((entry) => !terms.length || entry.hits > 0)
      .sort((left, right) => right.coverage - left.coverage || right.hits - left.hits || left.memory.id.localeCompare(right.memory.id));

    const selected = new Map<string, { memory: MemoryRecord; reason: "query" | "relationship" | "entity"; path: string[] }>();
    for (const entry of lexical) selected.set(entry.memory.id, { memory: entry.memory, reason: "query", path: [] });
    let graphExpansions = 0;
    if (request.graph?.enabled && request.graph.max_hops === 1 && request.graph.max_expansions > 0) {
      const allowed = new Map(candidates.map((memory) => [memory.id, memory]));
      const entityIndex = new Map<string, MemoryRecord[]>();
      for (const memory of candidates) for (const entity of graphEntities(memory)) entityIndex.set(entity.id, [...(entityIndex.get(entity.id) ?? []), memory]);
      const allowedTypes = request.graph.relationship_types ? new Set(request.graph.relationship_types) : null;
      for (const seed of lexical.slice(0, Math.max(1, clampLimit(request.limit, 10, 100) * 2))) {
        const neighbors: Array<{ memory: MemoryRecord; reason: "relationship" | "entity"; path: string[] }> = [];
        for (const relationship of seed.memory.relationships) {
          if (allowedTypes && !allowedTypes.has(relationship.type)) continue;
          const target = allowed.get(relationship.target_id);
          if (target) neighbors.push({ memory: target, reason: "relationship", path: [seed.memory.id, relationship.type, target.id] });
        }
        for (const source of candidates) for (const relationship of source.relationships) {
          if (relationship.target_id !== seed.memory.id || (allowedTypes && !allowedTypes.has(relationship.type))) continue;
          neighbors.push({ memory: source, reason: "relationship", path: [seed.memory.id, `reverse:${relationship.type}`, source.id] });
        }
        for (const entity of graphEntities(seed.memory)) for (const target of entityIndex.get(entity.id) ?? []) {
          if (target.id !== seed.memory.id) neighbors.push({ memory: target, reason: "entity", path: [seed.memory.id, `entity:${entity.id}`, target.id] });
        }
        neighbors.sort((left, right) => left.memory.id.localeCompare(right.memory.id));
        for (const neighbor of neighbors) {
          if (selected.has(neighbor.memory.id)) continue;
          selected.set(neighbor.memory.id, neighbor);
          graphExpansions += 1;
          if (graphExpansions >= request.graph.max_expansions) break;
        }
        if (graphExpansions >= request.graph.max_expansions) break;
      }
    }

    const pool = [...selected.values()];
    const rankMap = (ordered: MemoryRecord[]): Map<string, number> => new Map(ordered.map((memory, index) => [memory.id, index + 1]));
    const lexicalRanks = rankMap(lexical.map((entry) => entry.memory));
    const graphRanks = rankMap(pool.filter((entry) => entry.reason !== "query").map((entry) => entry.memory));
    const confidenceRanks = rankMap(pool.map((entry) => entry.memory).sort((a, b) => (b.effective_confidence ?? b.confidence) - (a.effective_confidence ?? a.confidence) || a.id.localeCompare(b.id)));
    const importanceRanks = rankMap(pool.map((entry) => entry.memory).sort((a, b) => b.importance - a.importance || a.id.localeCompare(b.id)));
    const freshnessRanks = rankMap(pool.map((entry) => entry.memory).sort((a, b) => Date.parse(b.observed_at ?? b.updated_at) - Date.parse(a.observed_at ?? a.updated_at) || a.id.localeCompare(b.id)));
    const rrf = (rank: number | undefined): number => rank ? 1 / (60 + rank) : 0;
    const scored = pool.map((entry) => {
      const lexicalRank = lexicalRanks.get(entry.memory.id);
      const graphRank = graphRanks.get(entry.memory.id);
      const rrfScore = rrf(lexicalRank) + rrf(graphRank) + rrf(confidenceRanks.get(entry.memory.id)) + rrf(importanceRanks.get(entry.memory.id)) + rrf(freshnessRanks.get(entry.memory.id));
      return { ...entry, lexicalRank, graphRank, rrfScore };
    }).sort((left, right) => right.rrfScore - left.rrfScore || left.memory.id.localeCompare(right.memory.id));
    const maxRrf = scored[0]?.rrfScore ?? 1;
    const diverse: Array<(typeof scored)[number] & { mmrScore: number }> = [];
    const remaining = [...scored];
    const diversity = request.diversity?.enabled === true;
    const lambda = request.diversity?.lambda ?? 0.8;
    const selectionCount = Math.min(scored.length, (request.offset ?? 0) + clampLimit(request.limit, 10, 100));
    while (remaining.length && diverse.length < selectionCount) {
      let bestIndex = 0;
      let bestScore = Number.NEGATIVE_INFINITY;
      for (let index = 0; index < remaining.length; index += 1) {
        const candidate = remaining[index]!;
        const similarity = diversity && diverse.length ? Math.max(...diverse.map((chosen) => tokenJaccard(chosen.memory.content, candidate.memory.content))) : 0;
        const mmrScore = diversity ? lambda * (candidate.rrfScore / maxRrf) - (1 - lambda) * similarity : candidate.rrfScore / maxRrf;
        if (mmrScore > bestScore || (mmrScore === bestScore && candidate.memory.id < remaining[bestIndex]!.memory.id)) { bestIndex = index; bestScore = mmrScore; }
      }
      const chosen = remaining.splice(bestIndex, 1)[0]!;
      diverse.push({ ...chosen, mmrScore: bestScore });
    }
    const historical = Boolean(request.as_of && Date.parse(request.as_of) < Date.now());
    const results = diverse.map((entry): SearchResult => {
      const components: SearchScoreComponents = {
        lexical_rank: entry.lexicalRank ?? null,
        graph_rank: entry.graphRank ?? null,
        confidence_rank: confidenceRanks.get(entry.memory.id)!,
        importance_rank: importanceRanks.get(entry.memory.id)!,
        freshness_rank: freshnessRanks.get(entry.memory.id)!,
        rrf_score: entry.rrfScore,
        mmr_score: entry.mmrScore,
      };
      return {
        memory: entry.memory,
        score: Math.max(0, Math.min(1, entry.mmrScore)),
        collection: collectionFor(entry.memory),
        is_own: entry.memory.agent_id === principal.agentId,
        citation: this.citation(entry.memory, entry.path, historical),
        score_components: components,
        selection_reason: entry.reason,
        explanation: null,
      };
    });
    return { request, candidates, results, graphExpansions };
  }

  async searchWithMode(principal: AuthPrincipal, body: unknown, explain: boolean): Promise<SearchResponse> {
    const raw = asJsonObject(body, "search");
    if (raw.mode === undefined || raw.mode === "lexical") return this.search(principal, body, explain);
    if (raw.mode !== "semantic") throw new ValidationError("mode must be lexical or semantic");
    const config = semanticConfig();
    if (!config) return this.unavailable("semantic search requires an explicitly configured embedding model and shadow collection");
    const { request, candidates } = this.searchCandidates(principal, body);
    const index = new SemanticIndex(config);
    const allowed = new Map(candidates.map((memory) => [memory.id, memory]));
    const ranked = await index.query(request.query ?? "", request.workspace_id ?? "default", principal.agentId);
    const results = ranked.flatMap((hit) => {
      const memory = allowed.get(hit.id);
      // Revalidate current content: stale vectors cannot reintroduce deleted or changed content.
      if (!memory || !index.matches(memory, hit.contentHash)) return [];
      return [{ memory, score: hit.score, collection: config.collection, is_own: memory.agent_id === principal.agentId, explanation: null }];
    }).slice(request.offset ?? 0, (request.offset ?? 0) + clampLimit(request.limit, 10, 100));
    return { results, total_searched: candidates.length, collections_searched: [config.collection] };
  }

  search(principal: AuthPrincipal, body: unknown, explain: boolean): SearchResponse {
    const { request, candidates, results: ranked } = this.rankedSearch(principal, body);
    const limit = clampLimit(request.limit, 10, 100);
    const terms = tokenize(request.query ?? "");
    const results = ranked.slice(request.offset ?? 0, (request.offset ?? 0) + limit).map((result) => {
      if (!explain) return { ...result, explanation: null };
      const haystack = `${result.memory.content} ${result.memory.tags.join(" ")}`.toLowerCase();
      const hits = terms.length ? terms.reduce((count, term) => count + (haystack.includes(term) ? 1 : 0), 0) : 1;
      const vectorScore = terms.length ? hits / terms.length : 0.5;
      return { ...result, explanation: { vector_score: vectorScore, importance_boost: result.memory.importance * 0.1, text_match: hits > 0, final_score: result.score } };
    });

    return {
      results,
      total_searched: candidates.length,
      collections_searched: [...new Set(candidates.map(collectionFor))],
    };
  }

  createSession(principal: AuthPrincipal, body: unknown): SessionRecord {
    const parsed = parseSessionCreate(body);
    this.assertWorkspacePermission(principal, parsed.workspace_id ?? "default", "write");
    const timestamp = nowIso();
    const session: SessionRecord = {
      session_id: parsed.session_id ?? randomUUID(),
      owner_agent_id: principal.agentId,
      scope: parsed.scope ?? "private",
      title: parsed.title ?? null,
      workspace_id: parsed.workspace_id ?? "default",
      metadata: parsed.metadata ?? {},
      created_at: timestamp,
      updated_at: timestamp,
      deleted_at: null,
    };
    this.sessions.set(session.session_id, session);
    this.queuePersistence();
    this.enqueueJob({
      task_type: "summary",
      work_unit_key: "session:" + session.session_id,
      payload: { session_id: session.session_id, event: "session_created" },
      owner_agent_id: principal.agentId,
      workspace_id: session.workspace_id,
      session_id: session.session_id,
      idempotency_key: "summary:session:" + session.session_id + ":" + session.workspace_id,
      priority: 0,
    });
    this.emitWebhookForResource(principal, "session.created", session.workspace_id, "session", session.session_id, {
      session_id: session.session_id,
      title: session.title,
      scope: session.scope,
      workspace_id: session.workspace_id,
    });
    return session;
  }

  listSessions(principal: AuthPrincipal, params: URLSearchParams): SessionRecord[] {
    const workspaceId = params.get("workspace_id") ?? "default";
    this.assertWorkspacePermission(principal, workspaceId, "read");
    return [...this.sessions.values()]
      .filter((session) => !session.deleted_at)
      .filter((session) => session.owner_agent_id === principal.agentId || session.scope === "shared")
      .filter((session) => workspaceId === "*" || session.workspace_id === workspaceId)
      .sort((left, right) => right.updated_at.localeCompare(left.updated_at));
  }

  getSession(principal: AuthPrincipal, sessionId: string): SessionRecord {
    const session = this.sessions.get(sessionId);
    if (!session || session.deleted_at || (session.owner_agent_id !== principal.agentId && session.scope !== "shared" && !isAdmin(principal))) throw new NotFoundError("Session not found");
    this.assertWorkspacePermission(principal, session.workspace_id, "read");
    return session;
  }

  getSessionMemories(principal: AuthPrincipal, sessionId: string): MemoryRecord[] {
    this.getSession(principal, sessionId);
    return [...this.memories.values()]
      .filter((memory) => memory.session_id === sessionId)
      .filter((memory) => this.currentMemory(memory))
      .filter((memory) => canRead(memory, principal));
  }

  listAgentMemories(principal: AuthPrincipal, agentId: string, params: URLSearchParams): MemoryRecord[] {
    const workspaceId = params.get("workspace_id") ?? "*";
    this.assertWorkspacePermission(principal, workspaceId, "read");
    return [...this.memories.values()]
      .filter((memory) => memory.agent_id === agentId)
      .filter((memory) => this.currentMemory(memory))
      .filter((memory) => canRead(memory, principal))
      .filter((memory) => workspaceId === "*" || memory.workspace_id === workspaceId)
      .sort((left, right) => right.created_at.localeCompare(left.created_at));
  }

  dashboardMemoryOptions(principal: AuthPrincipal): {
    current_agent_id: string;
    agents: Array<{ agent_id: string; display_name: string; current: boolean }>;
    tags: string[];
    scopes: typeof memoryScopes;
    types: typeof memoryTypes;
    sources: typeof memorySources;
  } {
    const visible = [...this.memories.values()].filter((memory) => this.currentMemory(memory) && canRead(memory, principal));
    const agentIds = new Set<string>([principal.agentId]);
    const tags = new Set<string>();
    for (const memory of visible) {
      agentIds.add(memory.agent_id);
      for (const tag of memory.tags) {
        const normalized = tag.trim();
        if (normalized) tags.add(normalized);
      }
    }
    return {
      current_agent_id: principal.agentId,
      agents: [...agentIds].sort((left, right) => left.localeCompare(right)).map((agentId) => ({ agent_id: agentId, display_name: agentId, current: agentId === principal.agentId })),
      tags: [...tags].sort((left, right) => left.localeCompare(right)),
      scopes: memoryScopes,
      types: memoryTypes,
      sources: memorySources,
    };
  }
  graphNeighborhood(principal: AuthPrincipal, params: URLSearchParams): GraphNeighborhoodResponse {
    const workspaceId = params.get("workspace_id") ?? "default";
    this.assertWorkspacePermission(principal, workspaceId, "read");
    const memoryId = params.get("memory_id");
    const entityId = params.get("entity_id");
    const limit = clampLimit(Number.parseInt(params.get("limit") ?? "40", 10) || 40, 40, 120);
    const readable = [...this.memories.values()]
      .filter((memory) => this.currentMemory(memory))
      .filter((memory) => canRead(memory, principal))
      .filter((memory) => workspaceId === "*" || memory.workspace_id === workspaceId)
      .sort((left, right) => right.updated_at.localeCompare(left.updated_at));
    const byId = new Map(readable.map((memory) => [memory.id, memory]));
    let selected = readable;
    if (memoryId) {
      const seed = byId.get(memoryId);
      selected = seed ? [seed, ...seed.relationships.map((relationship) => byId.get(relationship.target_id)).filter((memory): memory is MemoryRecord => Boolean(memory))] : [];
    } else if (entityId) {
      selected = readable.filter((memory) => graphEntities(memory).some((entity) => entity.id === entityId));
    }
    selected = selected.slice(0, limit);

    const nodes = new Map<string, GraphNode>();
    const edges = new Map<string, GraphEdge>();
    for (const memory of selected) {
      nodes.set(memory.id, memoryGraphNode(memory));
      for (const entity of graphEntities(memory)) {
        nodes.set(entity.id, entity);
        const edgeId = memory.id + ":mentions:" + entity.id;
        edges.set(edgeId, {
          id: edgeId,
          source: memory.id,
          target: entity.id,
          type: "mentions",
          confidence: 1,
          valid_from: null,
          valid_to: null,
          observed_at: memory.observed_at,
          superseded_by: null,
          metadata: { workspace_id: memory.workspace_id },
        });
      }
      for (const relationship of memory.relationships) {
        const target = byId.get(relationship.target_id);
        // A hidden or withdrawn source must not leak through an unresolved edge.
        if (!target) continue;
        nodes.set(target.id, memoryGraphNode(target));
        const edgeId = memory.id + ":" + relationship.type + ":" + relationship.target_id;
        edges.set(edgeId, {
          id: edgeId,
          source: memory.id,
          target: relationship.target_id,
          type: relationship.type,
          confidence: relationship.confidence,
          valid_from: memory.valid_from,
          valid_to: memory.valid_to,
          observed_at: memory.observed_at,
          superseded_by: memory.superseded_by,
          metadata: relationship.metadata,
        });
      }
    }
    return {
      anchor_id: memoryId ?? entityId ?? null,
      nodes: [...nodes.values()].slice(0, limit),
      edges: [...edges.values()].slice(0, limit * 2),
    };
  }

  authPrincipal(principal: AuthPrincipal): Record<string, unknown> {
    this.ensureAgent(principal.agentId);
    return {
      agent_id: principal.agentId,
      sub: principal.agentId,
      role: typeof principal.rawClaims.role === "string" ? principal.rawClaims.role : "agent",
      scopes: [...principal.scopes],
      claims: principal.rawClaims,
    };
  }

  listGraphEntities(principal: AuthPrincipal, params: URLSearchParams): GraphNode[] {
    const workspaceId = params.get("workspace_id") ?? "default";
    this.assertWorkspacePermission(principal, workspaceId, "read");
    const nodes = new Map<string, GraphNode>();
    for (const memory of this.readableMemories(principal, workspaceId)) {
      for (const entity of graphEntities(memory)) {
        const existing = nodes.get(entity.id);
        if (!existing) {
          nodes.set(entity.id, entity);
          continue;
        }
        const existingIds = Array.isArray(existing.metadata.linked_memory_ids) ? existing.metadata.linked_memory_ids.filter((id): id is string => typeof id === "string") : [];
        const nextIds = Array.isArray(entity.metadata.linked_memory_ids) ? entity.metadata.linked_memory_ids.filter((id): id is string => typeof id === "string") : [];
        nodes.set(entity.id, { ...existing, metadata: { ...existing.metadata, linked_memory_ids: [...new Set([...existingIds, ...nextIds])] } });
      }
    }
    return [...nodes.values()].sort((left, right) => left.label.localeCompare(right.label));
  }

  listGraphRelations(principal: AuthPrincipal, params: URLSearchParams): GraphEdge[] {
    const workspaceId = params.get("workspace_id") ?? "default";
    this.assertWorkspacePermission(principal, workspaceId, "read");
    const edges = new Map<string, GraphEdge>();
    const readable = this.readableMemories(principal, workspaceId);
    const byId = new Map(readable.map((memory) => [memory.id, memory]));
    for (const memory of readable) {
      for (const entity of graphEntities(memory)) {
        const id = memory.id + ":mentions:" + entity.id;
        edges.set(id, {
          id,
          source: memory.id,
          target: entity.id,
          type: "mentions",
          confidence: 1,
          valid_from: null,
          valid_to: null,
          observed_at: memory.observed_at,
          superseded_by: null,
          metadata: { workspace_id: memory.workspace_id },
        });
      }
      for (const relationship of memory.relationships) {
        if (!byId.has(relationship.target_id)) continue;
        const id = memory.id + ":" + relationship.type + ":" + relationship.target_id;
        edges.set(id, {
          id,
          source: memory.id,
          target: relationship.target_id,
          type: relationship.type,
          confidence: relationship.confidence,
          valid_from: memory.valid_from,
          valid_to: memory.valid_to,
          observed_at: memory.observed_at,
          superseded_by: memory.superseded_by,
          metadata: relationship.metadata,
        });
      }
    }
    return [...edges.values()].sort((left, right) => left.id.localeCompare(right.id));
  }

  graphEntityPage(principal: AuthPrincipal, entityId: string, params: URLSearchParams): Record<string, unknown> {
    const entities = this.listGraphEntities(principal, params);
    const entity = entities.find((candidate) => candidate.id === entityId);
    if (!entity) throw new NotFoundError("Graph entity not found");
    const linkedIds = Array.isArray(entity.metadata.linked_memory_ids) ? entity.metadata.linked_memory_ids.filter((id): id is string => typeof id === "string") : [];
    const memories = linkedIds.map((id) => this.memories.get(id)).filter((memory): memory is MemoryRecord => Boolean(memory && this.currentMemory(memory) && canRead(memory, principal)));
    return {
      entity,
      memories,
      neighborhood: this.graphNeighborhood(principal, new URLSearchParams({ entity_id: entityId, workspace_id: params.get("workspace_id") ?? "default" })),
    };
  }

  memoryDiff(principal: AuthPrincipal, memoryId: string): Record<string, unknown> {
    const memory = this.getMemory(principal, memoryId);
    return {
      memory_id: memory.id,
      current: memory,
      proposed: null,
      changes: [],
      status: "unchanged",
    };
  }

  memoryGraph(principal: AuthPrincipal, memoryId: string): GraphNeighborhoodResponse {
    const memory = this.getMemory(principal, memoryId);
    return this.graphNeighborhood(principal, new URLSearchParams({ memory_id: memory.id, workspace_id: memory.workspace_id }));
  }

  endorseMemory(principal: AuthPrincipal, memoryId: string, body: unknown): Record<string, unknown> {
    const memory = this.getMemory(principal, memoryId);
    const raw = asJsonObject(body, "endorsement");
    const support = optionalBoolean(raw.support, "support") ?? true;
    const timestamp = nowIso();
    const endorsedBy = new Set(memory.endorsed_by);
    const opposedBy = new Set(memory.opposed_by);
    if (support) {
      endorsedBy.add(principal.agentId);
      opposedBy.delete(principal.agentId);
    } else {
      opposedBy.add(principal.agentId);
      endorsedBy.delete(principal.agentId);
    }
    const updated: MemoryRecord = {
      ...memory,
      endorsed_by: [...endorsedBy].sort((left, right) => left.localeCompare(right)),
      opposed_by: [...opposedBy].sort((left, right) => left.localeCompare(right)),
      endorsements: endorsedBy.size - opposedBy.size,
      updated_at: timestamp,
    };
    this.memories.set(memory.id, updated);
    this.queuePersistence();
    return { memory_id: memory.id, endorsed: support, endorsements: updated.endorsements, memory: updated };
  }

  consolidateMemories(principal: AuthPrincipal, body: unknown): Record<string, unknown> {
    const raw = asJsonObject(body, "consolidation request");
    const workspaceId = optionalString(raw.workspace_id, "workspace_id") ?? "default";
    this.assertWorkspacePermission(principal, workspaceId, "write");
    if (raw.memory_ids !== undefined && (!Array.isArray(raw.memory_ids) || raw.memory_ids.length > 256 || raw.memory_ids.some(id => typeof id !== 'string' || !id))) throw new ValidationError('memory_ids must contain at most 256 nonempty IDs');
    const memoryIds = [...new Set((raw.memory_ids ?? []) as string[])].sort();
    const job = this.enqueueJob({
      task_type: "consolidation",
      work_unit_key: "consolidation:" + workspaceId + ":" + (memoryIds.join(",") || nowIso()),
      payload: { workspace_id: workspaceId, memory_ids: memoryIds, strategy: optionalString(raw.strategy, "strategy") ?? "compatibility" },
      owner_agent_id: principal.agentId,
      workspace_id: workspaceId,
      idempotency_key: "consolidation:" + principal.agentId + ":" + workspaceId + ":" + (memoryIds.join(",") || nowIso()),
      operation_id: operationId(raw),
      priority: optionalNumber(raw.priority, "priority") ?? 0,
    });
    return { job_id: job.id, status: job.status, task_type: job.task_type, memory_ids: memoryIds, workspace_id: workspaceId };
  }

  promoteMemory(principal: AuthPrincipal, body: unknown): Record<string, unknown> {
    const raw = asJsonObject(body, "promote request");
    const memoryId = requiredString(raw.memory_id, "memory_id");
    const memory = this.getMemory(principal, memoryId);
    assertCanWrite(memory, principal);
    const updated: MemoryRecord = { ...memory, scope: "shared", updated_at: nowIso() };
    this.memories.set(memory.id, updated);
    this.queuePersistence();
    return { promoted: true, memory: updated, memory_id: updated.id };
  }

  privatizeMemory(principal: AuthPrincipal, body: unknown): Record<string, unknown> {
    const raw = asJsonObject(body, "privatize request");
    const memoryId = requiredString(raw.memory_id, "memory_id");
    const memory = this.getMemory(principal, memoryId);
    assertCanWrite(memory, principal);
    const updated: MemoryRecord = { ...memory, scope: "private", updated_at: nowIso() };
    this.memories.set(memory.id, updated);
    this.queuePersistence();
    return { privatized: true, memory: updated, memory_id: updated.id };
  }

  scheduleForgettingReview(principal: AuthPrincipal, body: unknown): Record<string, unknown> {
    const raw = asJsonObject(body, "forgetting review");
    const workspaceId = optionalString(raw.workspace_id, "workspace_id") ?? "default";
    this.assertWorkspacePermission(principal, workspaceId, "write");
    const job = this.enqueueJob({
      task_type: "forgetting_review",
      work_unit_key: "forgetting_review:" + workspaceId + ":" + nowIso(),
      payload: { workspace_id: workspaceId, reason: optionalNullableString(raw.reason, "reason") ?? null },
      owner_agent_id: principal.agentId,
      workspace_id: workspaceId,
      idempotency_key: "forgetting_review:" + workspaceId + ":" + nowIso(),
      priority: 0,
    });
    return { job_id: job.id, status: job.status, task_type: job.task_type, workspace_id: workspaceId };
  }

  applyRetention(principal: AuthPrincipal, body: unknown): Record<string, unknown> {
    const raw = asJsonObject(body, "retention request");
    const workspaceId = optionalString(raw.workspace_id, "workspace_id") ?? "default";
    this.assertWorkspacePermission(principal, workspaceId, "write");
    const candidates = [...this.memories.values()].filter((memory) => !memory.deleted_at && (workspaceId === "*" || memory.workspace_id === workspaceId) && (memory.agent_id === principal.agentId || isAdmin(principal)));
    const dryRun = optionalBoolean(raw.dry_run, "dry_run") ?? true;
    const policy = this.workspaces.get(workspaceId)?.policy;
    const days = typeof policy?.retention_days === "number" ? policy.retention_days : null;
    const expired = candidates.filter((memory) => memory.expires_at && Date.parse(memory.expires_at) <= Date.now() || days !== null && days > 0 && Date.parse(memory.created_at) < Date.now() - days * 86400000);
    if (!dryRun) for (const memory of expired) {
      this.memories.set(memory.id, { ...memory, deleted_at: nowIso(), updated_at: nowIso(), metadata: { ...memory.metadata, lifecycle_archived: true } });
      this.invalidateDerived(memory.id);
    }
    if (!dryRun && expired.length) this.recordOperation("retention", principal, { workspace_id: workspaceId, archived: expired.length });
    return { workspace_id: workspaceId, scanned: candidates.length, expired: expired.length, archived: dryRun ? 0 : expired.length, deleted: 0, dry_run: dryRun };
  }

  forgetSubject(principal: AuthPrincipal, body: unknown): Record<string, unknown> {
    const raw = asJsonObject(body, "forget subject request");
    const workspaceId = optionalString(raw.workspace_id, "workspace_id") ?? "default";
    const subject = requiredString(raw.subject, "subject").toLowerCase();
    this.assertWorkspacePermission(principal, workspaceId, "write");
    const dryRun = optionalBoolean(raw.dry_run, "dry_run") ?? true;
    let deleted = 0;
    const timestamp = nowIso();
    const versions = [...this.memories.values()].filter((memory) =>
      !memory.deleted_at
      && canRead(memory, principal)
      && (workspaceId === "*" || memory.workspace_id === workspaceId));
    for (const memory of versions) {
      if (memory.agent_id !== principal.agentId && !isAdmin(principal)) continue;
      const matches = memory.content.toLowerCase().includes(subject)
        || memory.tags.some((tag) => tag.toLowerCase().includes(subject));
      if (!matches) continue;
      if (!dryRun) {
        this.memories.set(memory.id, { ...memory, deleted_at: timestamp, updated_at: timestamp });
        this.invalidateDerived(memory.id);
      }
      deleted += 1;
    }
    if (deleted > 0 && !dryRun) this.queuePersistence();
    return { workspace_id: workspaceId, subject, matched: deleted, deleted: dryRun ? 0 : deleted, redacted: 0, dry_run: dryRun };
  }

  searchArchive(principal: AuthPrincipal, body: unknown): Record<string, unknown> {
    const raw = asJsonObject(body, "archive search");
    const workspaceId = optionalString(raw.workspace_id, "workspace_id") ?? "default";
    this.assertWorkspacePermission(principal, workspaceId, "read");
    const query = optionalString(raw.query, "query") ?? "";
    const matches = [...this.memories.values()].filter((memory) => canRead(memory, principal) && memory.metadata.lifecycle_archived === true && (workspaceId === "*" || memory.workspace_id === workspaceId) && memory.content.toLowerCase().includes(query.toLowerCase()));
    return { results: matches.slice(0, 100), total: matches.length, workspace_id: workspaceId, query };
  }

  createCompaction(principal: AuthPrincipal, body: unknown): Record<string, unknown> {
    const raw = asJsonObject(body, "compaction request");
    const workspaceId = optionalString(raw.workspace_id, "workspace_id") ?? "default";
    this.assertWorkspacePermission(principal, workspaceId, "write");
    const sourceIds = Array.isArray(raw.memory_ids) ? raw.memory_ids.filter((id): id is string => typeof id === "string") : [];
    const content = optionalString(raw.content, "content") ?? "Compatibility compaction for " + sourceIds.length + " memories.";
    const memory = this.createMemory(principal, { content, type: "semantic", scope: "private", source: "consolidation", workspace_id: workspaceId, tags: ["compaction"], metadata: { source_memory_ids: sourceIds } });
    return { compaction_id: randomUUID(), memory_id: memory.id, source_memory_ids: sourceIds, workspace_id: workspaceId, status: "created" };
  }

  createNegotiation(principal: AuthPrincipal, body: unknown): Record<string, unknown> {
    const raw = asJsonObject(body, "negotiation request");
    const workspaceId = optionalString(raw.workspace_id, "workspace_id") ?? "default";
    this.assertWorkspacePermission(principal, workspaceId, "write");
    const job = this.enqueueJob({
      task_type: "conflict_scan",
      work_unit_key: "negotiation:" + workspaceId + ":" + nowIso(),
      payload: { workspace_id: workspaceId, memory_ids: Array.isArray(raw.memory_ids) ? raw.memory_ids.filter((id): id is string => typeof id === "string") : [] },
      owner_agent_id: principal.agentId,
      workspace_id: workspaceId,
      idempotency_key: "negotiation:" + workspaceId + ":" + nowIso(),
      priority: 0,
    });
    return { negotiation_id: randomUUID(), job_id: job.id, status: job.status, workspace_id: workspaceId };
  }

  createMultimodalReference(principal: AuthPrincipal, body: unknown): Record<string, unknown> {
    const raw = asJsonObject(body, "multimodal reference");
    const workspaceId = optionalString(raw.workspace_id, "workspace_id") ?? "default";
    this.assertWorkspacePermission(principal, workspaceId, "write");
    const id = randomUUID();
    const reference = { reference_id: id, workspace_id: workspaceId, media_type: optionalString(raw.media_type, "media_type") ?? "application/octet-stream", status: "recorded", metadata: optionalJsonObject(raw.metadata, "metadata") ?? {} };
    this.operations.set(id, { id, kind: "multimodal-reference", actor: principal.agentId, ...reference }); this.queuePersistence();
    return reference;
  }

  criticReview(_principal: AuthPrincipal, _body: unknown): Record<string, unknown> {
    return this.unavailable("critic review");
  }

  consolidationStatus(principal: AuthPrincipal, params: URLSearchParams): Record<string, unknown> {
    const workspaceId = params.get("workspace_id") ?? "default";
    this.assertWorkspacePermission(principal, workspaceId, "read");
    const jobs = [...this.queueJobs.values()].filter((job) => job.workspace_id === workspaceId && job.task_type === "consolidation" && (isAdmin(principal) || job.owner_agent_id === principal.agentId));
    const pending = jobs.filter((job) => job.status === "pending");
    const lastRun = [...this.operations.values()].filter((run) => run.kind === "consolidation-run" && run.workspace_id === workspaceId && (isAdmin(principal) || run.actor === principal.agentId)).sort((a, b) => String(b.finished_at).localeCompare(String(a.finished_at)))[0] ?? null;
    return { workspace_id: workspaceId, enabled: this.workerEnabled, pending_jobs: pending.length, oldest_pending_seconds: pending.length ? Math.max(...pending.map((job) => (Date.now() - Date.parse(job.created_at)) / 1000)) : null, last_run: lastRun, worker: this.workerHealth() };
  }

  consolidationLogs(principal: AuthPrincipal, params: URLSearchParams): Record<string, unknown> {
    const workspaceId = params.get("workspace_id") ?? "default";
    this.assertWorkspacePermission(principal, workspaceId, "read");
    const runs = [...this.operations.values()].filter((entry) => entry.kind === "consolidation-run" && entry.workspace_id === workspaceId && (isAdmin(principal) || entry.actor === principal.agentId));
    const ids = new Set(runs.map((run) => run.run_id));
    for (const job of this.queueJobs.values()) if (job.task_type === "consolidation" && job.workspace_id === workspaceId && (isAdmin(principal) || job.owner_agent_id === principal.agentId) && !ids.has(job.id)) runs.push({ run_id: job.id, status: job.status, created_at: job.created_at });
    return { results: runs, total: runs.length, workspace_id: workspaceId };
  }

  consolidationLog(principal: AuthPrincipal, runId: string): Record<string, unknown> {
    const notFound = (error: unknown): never => {
      if (error instanceof ForbiddenError || error instanceof NotFoundError) throw new NotFoundError("Consolidation run not found");
      throw error;
    };
    const archived = this.operations.get("run:" + runId);
    if (archived && (isAdmin(principal) || archived.actor === principal.agentId)) {
      try {
        this.assertWorkspacePermission(principal, String(archived.workspace_id), "read");
      } catch (error) {
        notFound(error);
      }
      return archived;
    }
    let job: QueueJobRecord;
    try {
      job = this.getQueueJob(principal, runId);
    } catch (error) {
      return notFound(error);
    }
    if (job.task_type !== "consolidation") throw new NotFoundError("Consolidation run not found");
    return { run_id: job.id, status: job.status, job, logs: [] };
  }

  commandPalette(principal: AuthPrincipal): Record<string, unknown> {
    return {
      commands: [
        { id: "memory.search", title: "Search memories", href: "/dashboard" },
        { id: "queue.status", title: "Inspect queue", href: "/dashboard" },
        { id: "graph.neighborhood", title: "Open graph", href: "/dashboard" },
      ],
      current_agent_id: principal.agentId,
    };
  }

  dashboardConflicts(principal: AuthPrincipal, params: URLSearchParams): Record<string, unknown> {
    const workspaceId = params.get("workspace_id") ?? "default";
    this.assertWorkspacePermission(principal, workspaceId, "read");
    const results = [...this.operations.values()].filter((entry) => entry.kind === "conflict" && entry.workspace_id === workspaceId && entry.resolved !== true && Array.isArray(entry.memory_ids) && entry.memory_ids.every((id) => { const memory = this.memories.get(String(id)); return memory && this.currentMemory(memory) && canRead(memory, principal); }));
    return { results, total: results.length, workspace_id: workspaceId };
  }

  resolveDashboardConflict(principal: AuthPrincipal, memoryId: string, body: unknown): Record<string, unknown> {
    const memory = this.getMemory(principal, memoryId);
    const raw = asJsonObject(body, "conflict resolution");
    assertCanWrite(memory, principal);
    const action = optionalString(raw.action, "action") ?? "acknowledge";
    if (!["acknowledge", "dismiss"].includes(action)) throw new ValidationError("action must be acknowledge or dismiss");
    let resolved = 0;
    for (const [id, entry] of this.operations) if (entry.kind === "conflict" && entry.resolved !== true && entry.workspace_id === memory.workspace_id && Array.isArray(entry.memory_ids) && entry.memory_ids.includes(memoryId) && entry.memory_ids.every((sourceId) => {
      const source = this.memories.get(String(sourceId));
      return source && this.currentMemory(source) && canRead(source, principal);
    })) {
      this.operations.set(id, { ...entry, resolved: true, action, resolved_at: nowIso(), resolved_by: principal.agentId }); resolved++;
    }
    if (resolved) this.recordOperation("conflict.resolve", principal, { memory_id: memoryId, workspace_id: memory.workspace_id, resolved, action });
    return { memory_id: memory.id, resolved: resolved > 0, resolved_count: resolved, action };
  }

  adminAudit(principal: AuthPrincipal, params: URLSearchParams): Record<string, unknown> {
    if (!isAdmin(principal)) throw new ForbiddenError("Admin role is required");
    const offset = Math.max(0, Number(params.get("offset")) || 0);
    const limit = clampLimit(Number(params.get("limit")) || 50, 50, 200);
    const auditKinds = new Set(["api.mutation", "conflict.resolve", "retention", "tombstone"]);
    const events = [...this.operations.values()]
      .filter((entry) => auditKinds.has(String(entry.kind)))
      .filter((entry) => !Array.isArray(principal.rawClaims.workspace_ids) || (typeof entry.workspace_id === "string" && principal.rawClaims.workspace_ids.includes(entry.workspace_id)))
      .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
    return { events: events.slice(offset, offset + limit), total: events.length, offset, limit };
  }

  backup(principal: AuthPrincipal): Record<string, unknown> {
    if (!isAdmin(principal)) throw new ForbiddenError("Admin role is required");
    return this.unavailable("HTTP backup");
  }

  restore(principal: AuthPrincipal): Record<string, unknown> {
    if (!isAdmin(principal)) throw new ForbiddenError("Admin role is required");
    return this.unavailable("HTTP restore");
  }

  cleanupTestData(principal: AuthPrincipal): Record<string, unknown> {
    if (!isAdmin(principal)) throw new ForbiddenError("Admin role is required");
    return this.unavailable("Unscoped test-data cleanup");
  }

  adminPrune(principal: AuthPrincipal): Record<string, unknown> {
    if (!isAdmin(principal)) throw new ForbiddenError("Admin role is required");
    return this.unavailable("Unscoped prune; use workspace retention");
  }

  exportWorkspace(principal: AuthPrincipal, workspaceId: string): Record<string, unknown> {
    this.assertWorkspacePermission(principal, workspaceId, "read");
    return { workspace_id: workspaceId, memories: this.readableMemories(principal, workspaceId), sessions: this.listSessions(principal, new URLSearchParams({ workspace_id: workspaceId })), exported_at: nowIso(), format_version: 1 };
  }

  importWorkspace(principal: AuthPrincipal, workspaceId: string): Record<string, unknown> {
    this.assertWorkspacePermission(principal, workspaceId, "write");
    return this.unavailable("Workspace import");
  }

  pruneWorkspace(principal: AuthPrincipal, workspaceId: string, dryRun = true): Record<string, unknown> {
    this.assertWorkspacePermission(principal, workspaceId, "admin");
    return this.applyRetention(principal, { workspace_id: workspaceId, dry_run: dryRun });
  }

  private readableMemories(principal: AuthPrincipal, workspaceId: string): MemoryRecord[] {
    return [...this.memories.values()]
      .filter((memory) => this.currentMemory(memory))
      .filter((memory) => canRead(memory, principal))
      .filter((memory) => workspaceId === "*" || memory.workspace_id === workspaceId)
      .sort((left, right) => right.updated_at.localeCompare(left.updated_at));
  }

  updateSession(principal: AuthPrincipal, sessionId: string, body: unknown): SessionRecord {
    const session = this.sessions.get(sessionId);
    if (!session || session.deleted_at) throw new NotFoundError("Session not found");
    if (session.owner_agent_id !== principal.agentId) throw new ForbiddenError("Session is owned by another agent");
    const raw = asJsonObject(body, "session update");
    const title = optionalNullableString(raw.title, "title");
    const workspaceId = optionalString(raw.workspace_id, "workspace_id");
    if (workspaceId !== undefined) this.assertWorkspacePermission(principal, workspaceId, "write");
    const metadata = optionalJsonObject(raw.metadata, "metadata");
    const updated: SessionRecord = {
      ...session,
      title: title === undefined ? session.title : title,
      workspace_id: workspaceId ?? session.workspace_id,
      metadata: metadata ?? session.metadata,
      updated_at: nowIso(),
    };
    this.sessions.set(sessionId, updated);
    this.queuePersistence();
    this.enqueueJob({
      task_type: "representation",
      work_unit_key: "session:" + sessionId,
      payload: { session_id: sessionId, event: "session_updated" },
      owner_agent_id: principal.agentId,
      workspace_id: updated.workspace_id,
      session_id: sessionId,
      idempotency_key: "representation:session_update:" + sessionId + ":" + updated.updated_at,
      priority: 0,
    });
    return updated;
  }

  deleteSession(principal: AuthPrincipal, sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (!session || session.deleted_at) throw new NotFoundError("Session not found");
    if (session.owner_agent_id !== principal.agentId) throw new ForbiddenError("Session is owned by another agent");
    const timestamp = nowIso();
    this.sessions.set(sessionId, { ...session, deleted_at: timestamp, updated_at: timestamp });
    this.queuePersistence();
    this.enqueueJob({
      task_type: "summary",
      work_unit_key: "session:" + sessionId,
      payload: { session_id: sessionId, event: "session_deleted" },
      owner_agent_id: principal.agentId,
      workspace_id: session.workspace_id,
      session_id: sessionId,
      idempotency_key: "summary:session_delete:" + sessionId + ":" + timestamp,
      priority: 0,
    });
  }

  getRelatedMemories(principal: AuthPrincipal, memoryId: string, params: URLSearchParams): SearchResponse {
    const memory = this.getMemory(principal, memoryId);
    const limit = clampLimit(Number.parseInt(params.get("limit") ?? "10", 10) || 10, 10, 100);
    return this.search(principal, { query: memory.tags.join(" ") || memory.content, workspace_id: memory.workspace_id, scope: memory.scope, limit }, false);
  }

  detectConflicts(principal: AuthPrincipal, body: unknown): SearchResponse {
    const raw = asJsonObject(body, "conflict request");
    const content = requiredString(raw.content, "content");
    const workspaceId = optionalString(raw.workspace_id, "workspace_id") ?? "default";
    const scope = parseEnum(raw.scope, "scope", memoryScopes);
    const type = parseEnum(raw.type, "type", memoryTypes);
    return this.search(principal, { query: content, workspace_id: workspaceId, ...(scope ? { scope } : {}), ...(type ? { type } : {}), from_self: false, limit: optionalNumber(raw.limit, "limit") ?? 10 }, true);
  }

  getWebhook(principal: AuthPrincipal, endpointId: string): WebhookEndpointRecord {
    const endpoint = this.webhooks.get(endpointId);
    if (!endpoint || endpoint.deleted_at || (!isAdmin(principal) && endpoint.owner_agent_id !== principal.agentId)) throw new NotFoundError("Webhook endpoint not found");
    return this.publicWebhook(endpoint);
  }

  updateWebhook(principal: AuthPrincipal, endpointId: string, body: unknown): WebhookEndpointRecord {
    const endpoint = this.getWebhook(principal, endpointId);
    const raw = asJsonObject(body, "webhook update");
    const url = optionalString(raw.url, "url");
    if (url) assertWebhookUrl(url);
    const updated: WebhookEndpointRecord = {
      ...endpoint,
      url: url ?? endpoint.url,
      workspace_id: optionalString(raw.workspace_id, "workspace_id") ?? endpoint.workspace_id,
      event_types: raw.event_types === undefined ? endpoint.event_types : parseWebhookEventTypes(raw.event_types),
      enabled: optionalBoolean(raw.enabled, "enabled") ?? endpoint.enabled,
      headers: raw.headers === undefined ? endpoint.headers : parseWebhookHeaders(raw.headers),
      has_secret: typeof raw.secret === "string" ? raw.secret.trim().length > 0 : endpoint.has_secret,
      metadata: optionalJsonObject(raw.metadata, "metadata") ?? endpoint.metadata,
      updated_at: nowIso(),
    };
    this.assertWorkspacePermission(principal, updated.workspace_id, 'write');
    this.webhooks.set(endpointId, { ...this.webhooks.get(endpointId), ...updated, ...(typeof (body as Record<string, unknown>)?.secret === "string" ? { signing_secret: (body as Record<string, string>).secret! } : {}) } as WebhookEndpointRecord);
    this.queuePersistence();
    return updated;
  }

  deleteWebhook(principal: AuthPrincipal, endpointId: string): WebhookEndpointRecord {
    const endpoint = this.getWebhook(principal, endpointId);
    const updated = { ...endpoint, enabled: false, deleted_at: nowIso(), updated_at: nowIso() };
    this.webhooks.set(endpointId, updated);
    this.queuePersistence();
    return updated;
  }

  createEpisode(principal: AuthPrincipal, body: unknown): EpisodeRecord {
    const parsed = parseEpisodeCreate(body);
    this.assertWorkspacePermission(principal, parsed.workspace_id, "write");
    const existing = [...this.episodes.values()].find((episode) => episode.owner_agent_id === principal.agentId && episode.episode_id === parsed.episode_id && !episode.deleted_at);
    if (existing) return existing;
    const timestamp = nowIso();
    const record: EpisodeRecord = {
      id: randomUUID(),
      episode_id: parsed.episode_id ?? randomUUID(),
      owner_agent_id: principal.agentId,
      title: parsed.title,
      workspace_id: parsed.workspace_id,
      session_id: parsed.session_id,
      peer_id: parsed.peer_id,
      metadata: parsed.metadata,
      created_at: timestamp,
      updated_at: timestamp,
      deleted_at: null,
    };
    this.episodes.set(record.id, record);
    this.queuePersistence();
    return record;
  }

  listEpisodes(principal: AuthPrincipal, params: URLSearchParams): EpisodeRecord[] {
    const workspaceId = params.get("workspace_id") ?? "default";
    this.assertWorkspacePermission(principal, workspaceId, "read");
    const sessionId = params.get("session_id");
    const limit = clampLimit(Number.parseInt(params.get("limit") ?? "50", 10) || 50, 50, 200);
    return [...this.episodes.values()]
      .filter((episode) => !episode.deleted_at)
      .filter((episode) => isAdmin(principal) || episode.owner_agent_id === principal.agentId)
      .filter((episode) => !workspaceId || workspaceId === "*" || episode.workspace_id === workspaceId)
      .filter((episode) => !sessionId || episode.session_id === sessionId)
      .sort((left, right) => right.updated_at.localeCompare(left.updated_at))
      .slice(0, limit);
  }

  getEpisode(principal: AuthPrincipal, episodeId: string): EpisodeMessagesResponse {
    const episode = [...this.episodes.values()].find((candidate) => candidate.owner_agent_id === principal.agentId && candidate.episode_id === episodeId && !candidate.deleted_at);
    if (!episode) throw new NotFoundError("Episode not found");
    this.assertWorkspacePermission(principal, episode.workspace_id, "read");
    const messages = [...this.messages.values()]
      .filter((message) => message.owner_agent_id === principal.agentId && message.episode_id === episodeId && !message.deleted_at)
      .sort((left, right) => left.observed_at.localeCompare(right.observed_at));
    return { episode, messages };
  }

  appendEpisodeMessage(principal: AuthPrincipal, episodeId: string, body: unknown): MessageRecord {
    const episode = [...this.episodes.values()].find((candidate) => candidate.owner_agent_id === principal.agentId && candidate.episode_id === episodeId && !candidate.deleted_at);
    if (!episode) throw new NotFoundError("Episode not found");
    this.assertWorkspacePermission(principal, episode.workspace_id, "write");
    const parsed = parseMessageCreate(body);
    const timestamp = nowIso();
    const record: MessageRecord = {
      id: randomUUID(),
      episode_id: episodeId,
      message_id: parsed.message_id ?? randomUUID(),
      owner_agent_id: principal.agentId,
      workspace_id: episode.workspace_id,
      session_id: episode.session_id,
      role: parsed.role,
      content: parsed.content,
      speaker_id: parsed.speaker_id,
      observed_at: parsed.observed_at ?? timestamp,
      metadata: parsed.metadata,
      memory_job_id: null,
      memory_id: null,
      created_at: timestamp,
      updated_at: timestamp,
      deleted_at: null,
    };
    if (parsed.produce_memory) {
      const job = this.enqueueJob({
        task_type: "message_extract",
        work_unit_key: "message:" + record.id,
        payload: { episode_id: episodeId, message_id: record.message_id, message_point_id: record.id, memory_type: parsed.memory_type },
        owner_agent_id: principal.agentId,
        workspace_id: episode.workspace_id,
        session_id: episode.session_id,
        idempotency_key: "message_extract:" + record.id,
      });
      record.memory_job_id = job.id;
    }
    this.messages.set(record.id, record);
    this.queuePersistence();
    this.episodes.set(episode.id, { ...episode, updated_at: timestamp });
    this.queuePersistence();
    return record;
  }

  embedTexts(body: unknown): { embeddings: number[][]; model: "hivemem-token-hash-v1"; dimensions: 768 } {
    const raw = asJsonObject(body, "embed request");
    if (!Array.isArray(raw.texts) || raw.texts.length === 0 || raw.texts.length > 32 || raw.texts.some((text) => typeof text !== "string")) throw new ValidationError("texts must be an array of 1 to 32 strings");
    const texts = raw.texts as string[];
    texts.forEach((text, index) => {
      if (text.length > 30000) throw new BadRequestError("Text at index " + index + " exceeds 30,000 character limit.");
      if (!text.trim()) throw new BadRequestError("Text at index " + index + " is empty or whitespace-only.");
    });
    return { embeddings: texts.map(simpleEmbedding), model: "hivemem-token-hash-v1", dimensions: 768 };
  }

  stats(): StatsResponse {
    return {
      agents: this.agents.size,
      memories: [...this.memories.values()].filter((item) => !item.deleted_at).length,
      sessions: [...this.sessions.values()].filter((item) => !item.deleted_at).length,
      workspaces: [...this.workspaces.values()].filter((item) => !item.deleted_at).length,
      queue_jobs: this.queueJobs.size,
      webhooks: [...this.webhooks.values()].filter((item) => !item.deleted_at).length,
      webhook_deliveries: this.webhookDeliveries.size,
      conclusions: [...this.conclusions.values()].filter((item) => !item.deleted_at).length,
      episodes: [...this.episodes.values()].filter((item) => !item.deleted_at).length,
      messages: [...this.messages.values()].filter((item) => !item.deleted_at).length,
    };
  }

  metricsText(): string {
    const stats = this.stats();
    return [
      "# HELP hivemem_ts_memories Active in-memory memories",
      "# TYPE hivemem_ts_memories gauge",
      "hivemem_ts_memories " + stats.memories,
      "# HELP hivemem_ts_queue_jobs In-memory queue jobs",
      "# TYPE hivemem_ts_queue_jobs gauge",
      "hivemem_ts_queue_jobs " + stats.queue_jobs,
      "# HELP hivemem_ts_webhook_deliveries In-memory webhook deliveries",
      "# TYPE hivemem_ts_webhook_deliveries gauge",
      "hivemem_ts_webhook_deliveries " + stats.webhook_deliveries,
    ].join("\n") + "\n";
  }

  createConclusion(principal: AuthPrincipal, peerId: string, body: unknown): ConclusionRecord {
    const parsed = parseConclusionCreate(body);
    const observer = this.authorizedObserver(principal, parsed.observer_peer_id);
    this.assertWorkspacePermission(principal, parsed.workspace_id, "write");
    if (parsed.source_memory_ids.length > maxConclusionSources) throw new ValidationError("At most " + maxConclusionSources + " conclusion sources are allowed");
    for (const sourceId of parsed.source_memory_ids) {
      const memory = this.memories.get(sourceId);
      const conclusion = this.conclusions.get(sourceId);
      const allowed = memory ? memory.workspace_id === parsed.workspace_id && canRead(memory, principal) && !memory.deleted_at : conclusion && conclusion.workspace_id === parsed.workspace_id && conclusion.owner_agent_id === principal.agentId && !conclusion.deleted_at;
      if (!allowed) throw new ForbiddenError('Conclusion source is inaccessible or outside the requested workspace');
    }
    const superseded = parsed.supersedes ? this.conclusions.get(parsed.supersedes) : undefined;
    if (parsed.supersedes && !superseded) throw new NotFoundError('Superseded conclusion not found');
    if (superseded && (superseded.owner_agent_id !== principal.agentId || superseded.workspace_id !== parsed.workspace_id)) throw new ForbiddenError('Can supersede only own conclusions in the same workspace');
    if (superseded?.superseded_by) throw new ConflictError('Conclusion was already superseded');
    const timestamp = nowIso();
    const id = randomUUID();
    if (superseded) this.conclusions.set(superseded.id, { ...superseded, superseded_by: id, updated_at: timestamp });
    const record: ConclusionRecord = {
      id,
      owner_agent_id: principal.agentId,
      observer_peer_id: observer,
      observed_peer_id: peerId,
      session_id: parsed.session_id,
      workspace_id: parsed.workspace_id,
      source_memory_ids: parsed.source_memory_ids,
      content: parsed.content,
      kind: parsed.kind,
      confidence: parsed.confidence,
      metadata: parsed.metadata,
      created_at: timestamp,
      updated_at: timestamp,
      supersedes: parsed.supersedes,
      superseded_by: null,
      deleted_at: null,
    };
    this.conclusions.set(id, record);
    this.queuePersistence();
    return record;
  }

  listPeerConclusions(principal: AuthPrincipal, peerId: string, params: URLSearchParams): ConclusionRecord[] {
    const observer = this.authorizedObserver(principal, params.get("observer_peer_id"));
    const workspaceId = params.get("workspace_id") ?? "default";
    this.assertWorkspacePermission(principal, workspaceId, "read");
    const limit = clampLimit(Number.parseInt(params.get("limit") ?? "50", 10) || 50, 50, 200);
    return this.filteredConclusions(principal, peerId, observer, workspaceId, conclusionFilters(params)).slice(0, limit);
  }

  getConclusion(principal: AuthPrincipal, id: string, includeHistory = false): ConclusionRecord {
    const conclusion = this.conclusions.get(id);
    const owned = conclusion && (isAdmin(principal) || conclusion.owner_agent_id === principal.agentId);
    const visible = conclusion && !conclusion.deleted_at && (includeHistory || this.conclusionCurrent(conclusion));
    if (!conclusion || !owned || !visible) throw new NotFoundError("Conclusion not found");
    this.assertWorkspacePermission(principal, conclusion.workspace_id, "read");
    return conclusion;
  }

  listPeerConclusionsPage(
    principal: AuthPrincipal,
    peerId: string,
    params: URLSearchParams,
  ): { results: ConclusionRecord[]; next_cursor: string | null } {
    const observer = this.authorizedObserver(principal, params.get("observer_peer_id"));
    const workspace = params.get("workspace_id") ?? "default";
    this.assertWorkspacePermission(principal, workspace, "read");
    const filters = conclusionFilters(params);
    const scope = createHash("sha256")
      .update(canonicalJson([
        principal.agentId,
        observer,
        peerId,
        workspace,
        filters.includeHistory,
        filters.kind ?? null,
        filters.sessionId ?? null,
        filters.minConfidence ?? null,
      ]))
      .digest("hex");
    const records = this.filteredConclusions(principal, peerId, observer, workspace, filters).sort(compareConclusionPage);
    let after: ConclusionCursor | undefined;
    const cursor = params.get("cursor");
    if (cursor) after = decodeConclusionCursor(cursor, scope);
    const eligible = after ? records.filter((record) => compareConclusionPage(record, after) > 0) : records;
    const limit = clampLimit(Number.parseInt(params.get("limit") ?? "50", 10) || 50, 50, 200);
    const results = eligible.slice(0, limit);
    const last = results.at(-1);
    const nextCursor = eligible.length > results.length && last
      ? Buffer.from(JSON.stringify({ scope, after: [last.confidence, last.created_at, last.id] })).toString("base64url")
      : null;
    return { results, next_cursor: nextCursor };
  }

  queryPeerConclusions(principal: AuthPrincipal, peerId: string, body: unknown): ConclusionSearchResponse {
    const raw = asJsonObject(body, "conclusion query");
    const observer = this.authorizedObserver(principal, optionalNullableString(raw.observer_peer_id, "observer_peer_id") ?? null);
    const workspaceId = optionalNullableString(raw.workspace_id, "workspace_id") ?? "default";
    this.assertWorkspacePermission(principal, workspaceId, "read");
    const query = optionalString(raw.query, "query") ?? peerId;
    const kind = parseEnum(raw.kind, "kind", conclusionKinds);
    const sessionId = optionalNullableString(raw.session_id, "session_id") ?? undefined;
    const includeHistory = optionalBoolean(raw.include_history, "include_history")
      ?? optionalBoolean(raw.include_deleted, "include_deleted")
      ?? false;
    const minConfidence = optionalNumber(raw.min_confidence, "min_confidence");
    const limit = clampLimit(optionalNumber(raw.limit, "limit"), 10, 100);
    const terms = tokenize(query);
    const filters: ConclusionFilters = { includeHistory };
    if (sessionId) filters.sessionId = sessionId;
    if (kind) filters.kind = kind;
    if (minConfidence !== undefined) filters.minConfidence = minConfidence;
    const candidates = this.filteredConclusions(principal, peerId, observer, workspaceId, filters);
    const results = candidates
      .map((conclusion) => {
        const haystack = conclusion.content.toLowerCase();
        const hits = terms.length === 0 ? 1 : terms.reduce((count, term) => count + (haystack.includes(term) ? 1 : 0), 0);
        return { conclusion, score: Math.min(1, (terms.length === 0 ? 0.5 : hits / terms.length) + conclusion.confidence * 0.1) };
      })
      .sort((left, right) => right.score - left.score)
      .slice(0, limit);
    return { results, total_searched: candidates.length };
  }

  deleteConclusion(principal: AuthPrincipal, conclusionId: string): void {
    const conclusion = this.conclusions.get(conclusionId);
    if (!conclusion || conclusion.deleted_at) throw new NotFoundError("Conclusion not found");
    if (conclusion.owner_agent_id !== principal.agentId && !isAdmin(principal)) throw new ForbiddenError("You do not own this conclusion");
    this.conclusions.set(conclusionId, { ...conclusion, deleted_at: nowIso(), updated_at: nowIso() });
    this.queuePersistence();
  }

  peerRepresentation(principal: AuthPrincipal, peerId: string, params: URLSearchParams): RepresentationResponse {
    const observer = this.authorizedObserver(principal, params.get("observer_peer_id"));
    const workspaceId = params.get("workspace_id") ?? "default";
    this.assertWorkspacePermission(principal, workspaceId, "read");
    const sessionId = params.get("session_id");
    const limit = clampLimit(Number.parseInt(params.get("top_k") ?? "10", 10) || 10, 10, 50);
    const minConfidence = params.has("min_confidence") ? Number.parseFloat(params.get("min_confidence") ?? "0") : undefined;
    const cardFilters: { kind: ConclusionKind; minConfidence?: number } = { kind: "peer_card" };
    if (minConfidence !== undefined) cardFilters.minConfidence = minConfidence;
    const conclusionFilters: { sessionId?: string; minConfidence?: number } = {};
    if (sessionId) conclusionFilters.sessionId = sessionId;
    if (minConfidence !== undefined) conclusionFilters.minConfidence = minConfidence;
    const peerCards = this.filteredConclusions(principal, peerId, observer, workspaceId, cardFilters).slice(0, limit);
    const conclusions = this.filteredConclusions(principal, peerId, observer, workspaceId, conclusionFilters).slice(0, limit);
    return {
      peer_id: peerId,
      observer_peer_id: observer,
      workspace_id: workspaceId,
      session_id: sessionId ?? null,
      peer_card: peerCards,
      conclusions,
      context: [...peerCards, ...conclusions].filter((item) => !item.deleted_at).map((item) => item.content).join("\n"),
      generated_at: nowIso(),
    };
  }

  getPeerCard(principal: AuthPrincipal, peerId: string, params: URLSearchParams): PeerCardResponse {
    const observer = this.authorizedObserver(principal, params.get("observer_peer_id"));
    const workspaceId = params.get("workspace_id") ?? "default";
    this.assertWorkspacePermission(principal, workspaceId, "read");
    const limit = clampLimit(Number.parseInt(params.get("limit") ?? "5", 10) || 5, 5, 50);
    return { peer_id: peerId, observer_peer_id: observer, workspace_id: workspaceId, cards: this.filteredConclusions(principal, peerId, observer, workspaceId, { kind: "peer_card" }).slice(0, limit), generated_at: nowIso() };
  }

  upsertPeerCard(principal: AuthPrincipal, peerId: string, body: unknown): ConclusionRecord {
    const parsed = parsePeerCardUpsert(body);
    return this.createConclusion(principal, peerId, parsed);
  }

  replacePeerCard(principal: AuthPrincipal, peerId: string, cardId: string, body: unknown): ConclusionRecord {
    const existing = this.conclusions.get(cardId);
    if (!existing || existing.deleted_at || existing.observed_peer_id !== peerId || existing.kind !== "peer_card") throw new NotFoundError("Peer card not found");
    if (existing.owner_agent_id !== principal.agentId && !isAdmin(principal)) throw new ForbiddenError("You do not own this peer card");
    const parsed = parsePeerCardUpsert(body);
    const observer = this.authorizedObserver(principal, parsed.observer_peer_id ?? existing.observer_peer_id);
    this.assertWorkspacePermission(principal, parsed.workspace_id, "write");
    const updated: ConclusionRecord = { ...existing, content: parsed.content, observer_peer_id: observer, workspace_id: parsed.workspace_id, source_memory_ids: parsed.source_memory_ids, confidence: parsed.confidence, metadata: { ...existing.metadata, ...parsed.metadata }, supersedes: parsed.supersedes ?? existing.supersedes, updated_at: nowIso() };
    this.conclusions.set(cardId, updated);
    this.queuePersistence();
    return updated;
  }

  deletePeerCard(principal: AuthPrincipal, peerId: string, cardId: string): void {
    const existing = this.conclusions.get(cardId);
    if (!existing || existing.observed_peer_id !== peerId || existing.kind !== "peer_card") throw new NotFoundError("Peer card not found");
    this.deleteConclusion(principal, cardId);
  }

  reviewPeerCard(principal: AuthPrincipal, peerId: string, params: URLSearchParams): PeerCardReviewResponse {
    const observer = this.authorizedObserver(principal, params.get("observer_peer_id"));
    const workspaceId = params.get("workspace_id") ?? "default";
    this.assertWorkspacePermission(principal, workspaceId, "read");
    const cards = this.filteredConclusions(principal, peerId, observer, workspaceId, { kind: "peer_card", includeDeleted: true });
    const conclusions = this.filteredConclusions(principal, peerId, observer, workspaceId, {});
    const active = cards.filter((card) => !card.deleted_at && !card.superseded_by);
    const latest = active.map((card) => card.updated_at).sort().at(-1) ?? null;
    const notes: string[] = [];
    if (active.length === 0) notes.push("No active peer card exists.");
    if (latest && conclusions.some((conclusion) => conclusion.kind !== "peer_card" && conclusion.updated_at > latest)) notes.push("Newer conclusions exist after the latest peer card.");
    return { peer_id: peerId, observer_peer_id: observer, workspace_id: workspaceId, card_count: cards.length, active_card_count: active.length, conclusion_count: conclusions.length, latest_card_at: latest, needs_rebuild: notes.length > 0, notes };
  }

  schedulePeerDream(principal: AuthPrincipal, peerId: string, body: unknown): DreamScheduleResponse {
    const raw = asJsonObject(body, "dream request");
    const observer = this.authorizedObserver(principal, optionalNullableString(raw.observer_peer_id, "observer_peer_id") ?? null);
    const workspaceId = optionalString(raw.workspace_id, "workspace_id") ?? "default";
    this.assertWorkspacePermission(principal, workspaceId, "write");
    const sessionId = optionalNullableString(raw.session_id, "session_id") ?? null;
    const job = this.enqueueJob({
      task_type: "dream",
      work_unit_key: "peer:" + observer + ":" + peerId + ":dream",
      payload: { peer_id: peerId, observer_peer_id: observer, observed_peer_id: peerId, session_id: sessionId, workspace_id: workspaceId, include_peer_card: optionalBoolean(raw.include_peer_card, "include_peer_card") ?? true, force: optionalBoolean(raw.force, "force") ?? false, reason: optionalNullableString(raw.reason, "reason") ?? null },
      owner_agent_id: principal.agentId,
      workspace_id: workspaceId,
      session_id: sessionId,
      peer_id: peerId,
      observer_peer_id: observer,
      observed_peer_id: peerId,
      idempotency_key: "dream:" + workspaceId + ":" + (sessionId ?? "*") + ":" + observer + ":" + peerId,
      operation_id: operationId(raw),
      priority: 2,
    });
    return { job_id: job.id, task_type: "dream", workspace_id: workspaceId, peer_id: peerId, observer_peer_id: observer, session_id: sessionId, status: job.status };
  }

  private authorizedObserver(principal: AuthPrincipal, observerPeerId: string | null): string {
    const observer = observerPeerId || principal.agentId;
    if (observer !== principal.agentId && !isAdmin(principal)) throw new ForbiddenError("Cannot act as another observer");
    return observer;
  }

  private filteredConclusions(
    principal: AuthPrincipal,
    peerId: string,
    observer: string,
    workspaceId: string,
    filters: ConclusionFilters,
  ): ConclusionRecord[] {
    return [...this.conclusions.values()]
      .filter((conclusion) => conclusion.observed_peer_id === peerId)
      .filter((conclusion) => conclusion.observer_peer_id === observer)
      .filter((conclusion) => isAdmin(principal) || conclusion.owner_agent_id === principal.agentId)
      .filter((conclusion) => workspaceId === "*" || conclusion.workspace_id === workspaceId)
      .filter((conclusion) => filters.includeDeleted || !conclusion.deleted_at)
      .filter((conclusion) => filters.includeHistory || filters.includeDeleted || this.conclusionCurrent(conclusion))
      .filter((conclusion) => !filters.sessionId || conclusion.session_id === filters.sessionId)
      .filter((conclusion) => !filters.kind || conclusion.kind === filters.kind)
      .filter((conclusion) => filters.minConfidence === undefined || conclusion.confidence >= filters.minConfidence)
      .sort((left, right) => right.confidence - left.confidence || right.updated_at.localeCompare(left.updated_at));
  }

  recordOperation(kind: string, principal: AuthPrincipal, details: JsonObject): void {
    const id = randomUUID();
    this.operations.set(id, { id, kind, actor: principal.agentId, created_at: nowIso(), ...details });
    this.queuePersistence();
  }

  capabilities(): Record<string, string> {
    return { storage: this.persistence?.kind ?? "volatile", retrieval: semanticConfig() ? "lexical-and-configured-semantic" : "deterministic-lexical", embedding: "hivemem-token-hash-v1", queue: this.workerManaged ? (this.workerEnabled ? "managed" : "disabled") : "manual", webhooks: "https", lifecycle: "retention-and-archive", backup: "operator-script", restore: "operator-script", critic: "unavailable", multimodal: "references-only", credential_expiry: "absolute-deadline", operation_matrix: "/v1/capabilities/operations" };
  }

  tokenInventory(principal: AuthPrincipal): never {
    if (!isAdmin(principal)) throw new ForbiddenError('Admin role required');
    return this.unavailable('Issued-token inventory; containment uses token generations and revocation IDs');
  }

  compareReasoningProviders(_principal: AuthPrincipal): never {
    return this.unavailable('External reasoning-provider comparison');
  }

  describeMemory(principal: AuthPrincipal, id: string): Record<string, unknown> {
    const memory = this.getMemory(principal, id);
    const related = memory.relationships.flatMap((relation) => {
      const target = this.memories.get(relation.target_id);
      return target && target.workspace_id === memory.workspace_id && this.currentMemory(target) && canRead(target, principal) ? [target] : [];
    });
    const jobs = [...this.queueJobs.values()].filter((job) => job.workspace_id === memory.workspace_id &&
      (isAdmin(principal) || job.owner_agent_id === principal.agentId) &&
      (job.payload.memory_id === id || job.payload.resource_id === id || Array.isArray(job.payload.memory_ids) && job.payload.memory_ids.includes(id)));
    const audit = isAdmin(principal) ? [...this.operations.values()].filter((entry) =>
      ['api.mutation', 'conflict.resolve', 'tombstone'].includes(String(entry.kind)) &&
      (entry.memory_id === id || typeof entry.path === 'string' && entry.path.split('/').at(-1) === encodeURIComponent(id))) : [];
    return {
      memory, collection: memory.scope === 'shared' ? 'shared_' + memory.type : memory.agent_id + '_private_' + memory.type,
      provenance: {
        confidence_provenance: memory.confidence_provenance, metadata: memory.metadata,
        embedding: { model: null, dimensions: null, status: 'stored-vector-identity-unreported', default_generator: 'hivemem-token-hash-v1', default_dimensions: 768 },
      },
      related_memories: related, queue_jobs: jobs.slice(0, 100).map(queueSummary),
      audit_events: audit.slice(-100), audit_status: isAdmin(principal) ? 'available' : 'requires_admin',
    };
  }

  private unavailable(operation: string): never {
    const error = new Error(operation + " is unavailable in this runtime; use the documented operator workflow") as Error & { status: number };
    error.status = 501;
    error.name = "UnsupportedOperationError";
    throw error;
  }

  private currentMemory(memory: MemoryRecord, seen = new Set<string>()): boolean {
    return this.currentMemoryAt(memory, Date.now(), seen);
  }

  private currentMemoryAt(memory: MemoryRecord, at: number, seen = new Set<string>()): boolean {
    if (!memoryCurrent(memory, at) || seen.has(memory.id)) return false;
    seen.add(memory.id);
    const sources = memory.metadata.source_memory_ids;
    return !Array.isArray(sources) || sources.every((id) => { const source = this.memories.get(String(id)); return source && this.currentMemoryAt(source, at, new Set(seen)); });
  }

  private conclusionCurrent(conclusion: ConclusionRecord, seen = new Set<string>()): boolean {
    if (conclusion.deleted_at || conclusion.superseded_by || seen.has(conclusion.id)) return false;
    seen.add(conclusion.id);
    return conclusion.source_memory_ids.every((id) => { const memory = this.memories.get(id); if (memory) return this.currentMemory(memory); const source = this.conclusions.get(id); return source ? this.conclusionCurrent(source, new Set(seen)) : false; });
  }

  purgeMemories(principal: AuthPrincipal, body: unknown): Record<string, unknown> {
    if (!isAdmin(principal)) throw new ForbiddenError("Admin role required");
    const raw = asJsonObject(body, "purge"); const workspaceId = requiredString(raw.workspace_id, "workspace_id");
    this.assertWorkspacePermission(principal, workspaceId, "admin");
    const dryRun = optionalBoolean(raw.dry_run, "dry_run") ?? true;
    const candidates = [...this.memories.values()].filter((memory) => Boolean(memory.deleted_at) && memory.workspace_id === workspaceId).slice(0, clampLimit(optionalNumber(raw.limit, "limit"), 100, 500));
    if (!dryRun) for (const memory of candidates) { this.invalidateDerived(memory.id); this.memories.delete(memory.id); this.recordOperation("tombstone", principal, { memory_id: memory.id, workspace_id: workspaceId }); }
    return { dry_run: dryRun, matched: candidates.length, purged: dryRun ? 0 : candidates.length, workspace_id: workspaceId };
  }

  private invalidateDerived(sourceId: string): void {
    const invalid = new Set([sourceId]);
    let changed = true;
    while (changed) {
      changed = false;
      for (const [id, memory] of this.memories) {
        if (!memory.deleted_at && Array.isArray(memory.metadata.source_memory_ids) && memory.metadata.source_memory_ids.some((source) => invalid.has(String(source)))) {
          this.memories.set(id, { ...memory, deleted_at: nowIso(), updated_at: nowIso() }); invalid.add(id); changed = true;
        }
      }
      for (const [id, conclusion] of this.conclusions) {
        if (!conclusion.deleted_at && conclusion.source_memory_ids.some((source) => invalid.has(source))) {
          this.conclusions.set(id, { ...conclusion, deleted_at: nowIso(), updated_at: nowIso() });
          invalid.add(id); changed = true;
        }
      }
    }
  }

  credentialGeneration(agentId: string): number {
    const value = this.agents.get(agentId)?.metadata?.token_generation;
    return typeof value === "number" ? value : 0;
  }

  assertCredentialActive(principal: AuthPrincipal): void {
    const agent = this.agents.get(principal.agentId);
    if (agent && (agent as AgentInfo & { active?: boolean }).active === false) throw new ForbiddenError("Agent is disabled");
    const generation = this.credentialGeneration(principal.agentId);
    if ((principal.rawClaims.token_generation ?? 0) !== generation) throw new ForbiddenError("Agent credential has been rotated");
  }

  rotateAgentCredentials(principal: AuthPrincipal, agentId: string): number {
    if (!isAdmin(principal)) throw new ForbiddenError("Admin role is required");
    this.ensureAgent(agentId);
    const agent = this.agents.get(agentId)!;
    if ((agent as AgentInfo & { active?: boolean }).active === false) throw new ForbiddenError("Agent is disabled");
    const generation = this.credentialGeneration(agentId) + 1;
    this.agents.set(agentId, { ...agent, metadata: { ...agent.metadata, token_generation: generation } });
    this.queuePersistence();
    return generation;
  }

  registerAgent(principal: AuthPrincipal, body: unknown, token: string): AgentRegistered {
    if (!isAdmin(principal)) throw new ForbiddenError("Admin role is required");
    const parsed = parseAgentRegister(body);
    if (this.agents.has(parsed.agent_id)) throw new ConflictError("Agent '" + parsed.agent_id + "' already registered");
    const createdAt = nowIso();
    this.agents.set(parsed.agent_id, {
      agent_id: parsed.agent_id,
      display_name: parsed.display_name,
      description: parsed.description,
      created_at: createdAt,
      memory_counts: {},
      metadata: { operation_id: optionalString(asJsonObject(body, "agent").operation_id, "operation_id") ?? null },
    });
    this.queuePersistence();
    return {
      agent_id: parsed.agent_id,
      token,
      private_collections: [parsed.agent_id + "_private_episodic", parsed.agent_id + "_private_semantic", parsed.agent_id + "_private_procedural"],
      created_at: createdAt,
    };
  }

  listAgents(principal: AuthPrincipal): AgentInfo[] {
    this.ensureAgent(principal.agentId);
    return [...this.agents.values()]
      .map((agent) => ({ ...agent, memory_counts: this.memoryCountsForAgent(agent.agent_id) }))
      .sort((left, right) => left.agent_id.localeCompare(right.agent_id));
  }

  getAgent(_principal: AuthPrincipal, agentId: string): AgentInfo {
    const agent = this.agents.get(agentId);
    if (!agent) throw new NotFoundError("Agent '" + agentId + "' not found");
    return { ...agent, memory_counts: this.memoryCountsForAgent(agentId) };
  }

  updateAgent(principal: AuthPrincipal, agentId: string, body: unknown): AgentInfo {
    if (!isAdmin(principal)) throw new ForbiddenError("Admin role is required");
    const existing = this.agents.get(agentId);
    if (!existing) throw new NotFoundError("Agent '" + agentId + "' not found");
    const parsed = parseAgentUpdate(body);
    const updated = {
      ...existing,
      ...(parsed.display_name !== undefined ? { display_name: parsed.display_name } : {}),
      ...(parsed.description !== undefined ? { description: parsed.description } : {}),
      ...(parsed.active !== undefined ? { active: parsed.active } : {}),
      metadata: { ...existing.metadata, ...(parsed.active === false ? { token_generation: this.credentialGeneration(agentId) + 1 } : {}) },
      updated_at: nowIso(),
    };
    this.agents.set(agentId, updated);
    this.queuePersistence();
    return { ...updated, memory_counts: this.memoryCountsForAgent(agentId) };
  }

  agentProfile(principal: AuthPrincipal, agentId: string): AgentProfile {
    const agent = this.getAgent(principal, agentId);
    const memories = [...this.memories.values()].filter((memory) => memory.agent_id === agentId && this.currentMemory(memory));
    const topTags = new Map<string, number>();
    const memoryTypes: Record<string, number> = {};
    const sources: Record<string, number> = {};
    let confidenceSum = 0;
    let firstMemoryAt: string | null = null;
    let lastMemoryAt: string | null = null;
    let sharedMemories = 0;
    let privateMemories = 0;
    for (const memory of memories) {
      if (memory.scope === "shared") sharedMemories += 1;
      else privateMemories += 1;
      for (const tag of memory.tags) topTags.set(tag, (topTags.get(tag) ?? 0) + 1);
      memoryTypes[memory.type] = (memoryTypes[memory.type] ?? 0) + 1;
      sources[memory.source] = (sources[memory.source] ?? 0) + 1;
      confidenceSum += memory.confidence;
      if (!firstMemoryAt || memory.created_at < firstMemoryAt) firstMemoryAt = memory.created_at;
      if (!lastMemoryAt || memory.created_at > lastMemoryAt) lastMemoryAt = memory.created_at;
    }
    return {
      agent_id: agent.agent_id,
      display_name: agent.display_name,
      description: agent.description,
      total_memories: memories.length,
      shared_memories: sharedMemories,
      private_memories: privateMemories,
      top_tags: [...topTags.entries()].sort((left, right) => right[1] - left[1]).slice(0, 10).map(([tag, count]) => ({ tag, count })),
      memory_types: memoryTypes,
      sources,
      first_memory_at: firstMemoryAt,
      last_memory_at: lastMemoryAt,
      avg_confidence: memories.length > 0 ? Math.round((confidenceSum / memories.length) * 1000) / 1000 : null,
    };
  }

  exportAgentBundle(principal: AuthPrincipal, agentId: string): AgentProfileBundle {
    if (!isAdmin(principal) && principal.agentId !== agentId) throw new ForbiddenError("Agent bundle export requires admin role or matching agent identity");
    const agent = this.agents.get(agentId);
    if (!agent) throw new NotFoundError("Agent '" + agentId + "' not found");
    const metadata = agent.metadata;
    const exportedMetadata: JsonObject = {};
    for (const [key, value] of Object.entries(metadata)) {
      if (!bundleMetadataKeys.has(key)) exportedMetadata[key] = redactSensitive(value) as JsonValue;
    }
    return {
      agent_id: agent.agent_id,
      display_name: agent.display_name,
      description: agent.description,
      default_workspace_id: typeof metadata.default_workspace_id === "string" ? metadata.default_workspace_id : "default",
      default_tags: Array.isArray(metadata.default_tags) && metadata.default_tags.every((tag) => typeof tag === "string") ? metadata.default_tags : [],
      preferred_recall_strategy: typeof metadata.preferred_recall_strategy === "string" ? metadata.preferred_recall_strategy : "hybrid",
      tool_configuration: redactSensitive(metadata.tool_configuration ?? {}) as JsonObject,
      metadata: exportedMetadata,
      exported_at: nowIso(),
    };
  }

  importAgentBundle(principal: AuthPrincipal, agentId: string, body: unknown): AgentProfileBundle {
    if (!isAdmin(principal)) throw new ForbiddenError("Admin role is required");
    const bundle = parseAgentBundle(body);
    if (bundle.agent_id !== agentId) throw new BadRequestError("Path agent_id must match bundle agent_id");
    const paths = [...sensitivePaths(bundle.tool_configuration, "tool_configuration"), ...sensitivePaths(bundle.metadata, "metadata")];
    if (paths.length > 0) throw new BadRequestError("Agent profile bundle contains secret-looking keys: " + paths.slice(0, 10).join(", "));
    const existing = this.agents.get(agentId);
    const createdAt = existing?.created_at ?? nowIso();
    const metadata: JsonObject = {
      ...bundle.metadata,
      token_generation: existing?.metadata.token_generation ?? 0,
      default_workspace_id: bundle.default_workspace_id,
      default_tags: bundle.default_tags,
      preferred_recall_strategy: bundle.preferred_recall_strategy,
      tool_configuration: bundle.tool_configuration,
    };
    this.agents.set(agentId, {
      agent_id: agentId,
      display_name: bundle.display_name,
      description: bundle.description,
      created_at: createdAt,
      ...(existing?.active !== undefined ? { active: existing.active } : {}),
      memory_counts: existing?.memory_counts ?? {},
      metadata,
    });
    this.queuePersistence();
    return { ...bundle, exported_at: nowIso() };
  }

  private ensureAgent(agentId: string): void {
    if (this.agents.has(agentId)) return;
    this.agents.set(agentId, {
      agent_id: agentId,
      display_name: agentId,
      description: null,
      created_at: nowIso(),
      memory_counts: {},
      metadata: {},
    });
    this.queuePersistence();
  }

  private memoryCountsForAgent(agentId: string): Record<string, number> {
    const counts: Record<string, number> = { private_episodic: 0, private_semantic: 0, private_procedural: 0, shared_episodic: 0, shared_semantic: 0, shared_procedural: 0 };
    for (const memory of this.memories.values()) {
      if (memory.agent_id !== agentId || memory.deleted_at) continue;
      const key = memory.scope + "_" + memory.type;
      counts[key] = (counts[key] ?? 0) + 1;
    }
    return counts;
  }

  chat(principal: AuthPrincipal, body: unknown, routeSessionId?: string): ChatResponse {
    const parsed = parseChatRequest(body);
    const requestedAt = nowIso();
    let sessionId = routeSessionId ?? parsed.session_id;
    let workspaceId = parsed.workspace_id ?? "default";
    if (routeSessionId) {
      const session = this.sessions.get(routeSessionId);
      if (!session || session.deleted_at || (session.owner_agent_id !== principal.agentId && session.scope !== "shared")) throw new NotFoundError("Session not found");
      workspaceId = parsed.workspace_id ?? session.workspace_id ?? "default";
      sessionId = routeSessionId;
    }
    const sourceLimit = Math.min(Math.max(parsed.max_sources * 5, parsed.max_sources), 100);
    const searchBody: JsonObject = {
      query: parsed.query,
      workspace_id: workspaceId,
      limit: sourceLimit,
    };
    if (sessionId) searchBody.session_id = sessionId;
    if (parsed.scope) searchBody.scope = parsed.scope;
    if (parsed.type) searchBody.type = parsed.type;
    if (parsed.tags) searchBody.tags = parsed.tags;
    if (parsed.min_confidence !== undefined) searchBody.min_confidence = parsed.min_confidence;
    const searchResults = this.search(principal, searchBody, false).results;
    const rankedSources = rankChatSources(searchResults, parsed.max_sources, parsed.reasoning_level);
    const answer = synthesizeChatAnswer(parsed.query, rankedSources, parsed.reasoning_level);
    const processedAt = nowIso();
    return {
      answer,
      reasoning_level: parsed.reasoning_level,
      sources: parsed.include_citations ? rankedSources : [],
      usage: chatUsage(parsed.query, answer, rankedSources),
      session_id: sessionId ?? null,
      workspace_id: workspaceId,
      requested_at: requestedAt,
      processed_at: processedAt,
    };
  }

  createWorkspace(principal: AuthPrincipal, body: unknown): WorkspaceRecord {
    const parsed = parseWorkspaceCreate(body);
    if (Array.isArray(principal.rawClaims.workspace_ids) && !principal.rawClaims.workspace_ids.includes(parsed.workspace_id)) throw new ForbiddenError("Token does not permit this workspace");
    const existing = this.workspaces.get(parsed.workspace_id);
    if (existing && !existing.deleted_at) {
      this.assertWorkspacePermission(principal, parsed.workspace_id, "read");
      return existing;
    }
    const timestamp = nowIso();
    const record: WorkspaceRecord = {
      workspace_id: parsed.workspace_id,
      owner_agent_id: principal.agentId,
      title: parsed.title,
      description: parsed.description,
      metadata: parsed.metadata,
      policy: parsed.policy,
      members: normalizeWorkspaceMembers(principal.agentId, parsed.members, principal.agentId),
      created_at: timestamp,
      updated_at: timestamp,
      deleted_at: null,
    };
    this.workspaces.set(record.workspace_id, record);
    this.queuePersistence();
    return record;
  }

  listWorkspaces(principal: AuthPrincipal, params: URLSearchParams): WorkspaceRecord[] {
    const includeDeleted = params.get("include_deleted") === "true";
    const ownerAgentId = params.get("owner_agent_id");
    const offset = Math.max(0, Number.parseInt(params.get("offset") ?? "0", 10) || 0);
    const limit = clampLimit(Number.parseInt(params.get("limit") ?? "50", 10) || 50, 50, 200);
    const records = [...this.workspaces.values()]
      .filter((workspace) => includeDeleted || !workspace.deleted_at)
      .filter((workspace) => !ownerAgentId || workspace.owner_agent_id === ownerAgentId)
      .filter((workspace) => isAdmin(principal) || this.hasWorkspacePermission(principal, workspace, "read"))
      .sort((left, right) => right.updated_at.localeCompare(left.updated_at));
    return records.slice(offset, offset + limit);
  }

  getWorkspace(principal: AuthPrincipal, workspaceId: string, includeDeleted = false): WorkspaceRecord {
    const workspace = this.workspaces.get(workspaceId);
    if (!workspace || (!includeDeleted && workspace.deleted_at)) throw new NotFoundError("Workspace not found");
    if (!this.hasWorkspacePermission(principal, workspace, "read")) throw new ForbiddenError("Workspace read permission required");
    return workspace;
  }

  updateWorkspace(principal: AuthPrincipal, workspaceId: string, body: unknown): WorkspaceRecord {
    const workspace = this.getWorkspaceForMutation(workspaceId);
    this.assertWorkspaceRecordPermission(principal, workspace, "admin");
    const updated: WorkspaceRecord = { ...workspace, ...parseWorkspaceUpdate(body), updated_at: nowIso() };
    this.workspaces.set(workspaceId, updated);
    this.queuePersistence();
    return updated;
  }

  deleteWorkspace(principal: AuthPrincipal, workspaceId: string): void {
    const workspace = this.getWorkspaceForMutation(workspaceId);
    this.assertWorkspaceRecordPermission(principal, workspace, "owner");
    const timestamp = nowIso();
    this.workspaces.set(workspaceId, { ...workspace, deleted_at: timestamp, updated_at: timestamp });
    this.queuePersistence();
  }

  listWorkspaceMembers(principal: AuthPrincipal, workspaceId: string): WorkspaceMember[] {
    return this.getWorkspace(principal, workspaceId).members;
  }

  upsertWorkspaceMember(principal: AuthPrincipal, workspaceId: string, agentId: string, body: unknown): WorkspaceRecord {
    const workspace = this.getWorkspaceForMutation(workspaceId);
    this.assertWorkspaceRecordPermission(principal, workspace, "admin");
    const raw = asJsonObject(body, "workspace member");
    const role = parseEnum(raw.role, "role", workspaceRoles, "member");
    if (agentId === workspace.owner_agent_id && role !== "owner") throw new BadRequestError("Workspace owner role cannot be downgraded");
    const timestamp = nowIso();
    const members = workspace.members.filter((member) => member.agent_id !== agentId);
    members.push({ agent_id: agentId, role: agentId === workspace.owner_agent_id ? "owner" : role, scopes: optionalStringArray(raw.scopes, "scopes") ?? [], added_by: principal.agentId, created_at: timestamp, updated_at: timestamp });
    const updated: WorkspaceRecord = { ...workspace, members: normalizeWorkspaceMembers(workspace.owner_agent_id, members, principal.agentId), updated_at: timestamp };
    this.workspaces.set(workspaceId, updated);
    this.queuePersistence();
    return updated;
  }

  removeWorkspaceMember(principal: AuthPrincipal, workspaceId: string, agentId: string): WorkspaceRecord {
    const workspace = this.getWorkspaceForMutation(workspaceId);
    this.assertWorkspaceRecordPermission(principal, workspace, "admin");
    if (agentId === workspace.owner_agent_id) throw new BadRequestError("Workspace owner cannot be removed");
    const timestamp = nowIso();
    const updated: WorkspaceRecord = { ...workspace, members: normalizeWorkspaceMembers(workspace.owner_agent_id, workspace.members.filter((member) => member.agent_id !== agentId), principal.agentId), updated_at: timestamp };
    this.workspaces.set(workspaceId, updated);
    this.queuePersistence();
    return updated;
  }

  workspaceSettings(principal: AuthPrincipal, workspaceId: string, params: URLSearchParams): WorkspaceResolvedSettings {
    const workspace = this.getWorkspace(principal, workspaceId);
    const agentId = params.get("agent_id") ?? principal.agentId;
    const sessionId = params.get("session_id");
    let policy = workspacePolicyJson(workspace.policy);
    const sourceOrder = ["workspace"];
    const agentOverride = workspace.policy.agent_overrides[agentId];
    if (agentOverride) {
      policy = deepMergeJson(policy, agentOverride);
      sourceOrder.push("agent:" + agentId);
    }
    if (sessionId) {
      const sessionOverride = workspace.policy.session_overrides[sessionId];
      if (sessionOverride) {
        policy = deepMergeJson(policy, sessionOverride);
        sourceOrder.push("session:" + sessionId);
      }
    }
    return { workspace_id: workspaceId, policy, source_order: sourceOrder };
  }

  scheduleWorkspaceDream(principal: AuthPrincipal, workspaceId: string, body: unknown): DreamScheduleResponse {
    this.assertWorkspacePermission(principal, workspaceId, "write");
    const raw = asJsonObject(body, "dream request");
    const peerId = optionalString(raw.peer_id, "peer_id") ?? principal.agentId;
    const observerPeerId = this.authorizedObserver(principal, optionalString(raw.observer_peer_id, "observer_peer_id") ?? null);
    const sessionId = optionalNullableString(raw.session_id, "session_id") ?? null;
    const job = this.enqueueJob({
      task_type: "dream",
      work_unit_key: "workspace:" + workspaceId + ":peer:" + observerPeerId + ":" + peerId + ":dream",
      payload: {
        peer_id: peerId,
        observer_peer_id: observerPeerId,
        observed_peer_id: peerId,
        session_id: sessionId,
        workspace_id: workspaceId,
        include_peer_card: optionalBoolean(raw.include_peer_card, "include_peer_card") ?? true,
        force: optionalBoolean(raw.force, "force") ?? false,
        reason: optionalNullableString(raw.reason, "reason") ?? null,
      },
      owner_agent_id: principal.agentId,
      workspace_id: workspaceId,
      session_id: sessionId,
      peer_id: peerId,
      observer_peer_id: observerPeerId,
      observed_peer_id: peerId,
      idempotency_key: "dream:workspace:" + workspaceId + ":" + observerPeerId + ":" + peerId + ":" + (sessionId ?? "none"),
      operation_id: operationId(raw),
      priority: 0,
    });
    return { job_id: job.id, task_type: "dream", workspace_id: workspaceId, peer_id: peerId, observer_peer_id: observerPeerId, session_id: sessionId, status: job.status };
  }

  private getWorkspaceForMutation(workspaceId: string): WorkspaceRecord {
    const workspace = this.workspaces.get(workspaceId);
    if (!workspace || workspace.deleted_at) throw new NotFoundError("Workspace not found");
    return workspace;
  }

  private hasWorkspacePermission(principal: AuthPrincipal, workspace: WorkspaceRecord, permission: keyof typeof workspaceRequiredRank): boolean {
    if (Array.isArray(principal.rawClaims.workspace_ids) && !principal.rawClaims.workspace_ids.includes(workspace.workspace_id)) return false;
    if (isAdmin(principal)) return true;
    if (workspace.owner_agent_id === principal.agentId) return true;
    const member = workspace.members.find((candidate) => candidate.agent_id === principal.agentId);
    if (!member) return false;
    return workspacePermissionRank[member.role] >= workspaceRequiredRank[permission];
  }

  private assertWorkspaceRecordPermission(principal: AuthPrincipal, workspace: WorkspaceRecord, permission: keyof typeof workspaceRequiredRank): void {
    if (!this.hasWorkspacePermission(principal, workspace, permission)) throw new ForbiddenError("Workspace " + permission + " permission required");
  }

  private assertWorkspacePermission(principal: AuthPrincipal, workspaceId: string, permission: keyof typeof workspaceRequiredRank): void {
    if (Array.isArray(principal.rawClaims.workspace_ids) && !principal.rawClaims.workspace_ids.includes(workspaceId)) throw new ForbiddenError("Token does not permit this workspace");
    if (workspaceId === "*" && isAdmin(principal)) return;
    if (workspaceId === "*") throw new ForbiddenError("Workspace wildcard requires admin role");
    const workspace = this.workspaces.get(workspaceId);
    if (!workspace || workspace.deleted_at) {
      if (workspaceId === "default") return;
      throw new NotFoundError("Workspace not found");
    }
    this.assertWorkspaceRecordPermission(principal, workspace, permission);
  }

  private publicWebhook(endpoint: WebhookEndpointRecord): WebhookEndpointRecord {
    const { signing_secret: _secret, ...safe } = endpoint as WebhookEndpointRecord & { signing_secret?: string };
    return safe;
  }

  listWebhooks(principal: AuthPrincipal, params: URLSearchParams): WebhookEndpointRecord[] {
    const workspaceId = params.get("workspace_id") ?? "default";
    return [...this.webhooks.values()]
      .filter((endpoint) => !endpoint.deleted_at)
      .filter((endpoint) => isAdmin(principal) || endpoint.owner_agent_id === principal.agentId)
      .filter((endpoint) => workspaceId === "*" || endpoint.workspace_id === workspaceId)
      .sort((left, right) => right.updated_at.localeCompare(left.updated_at)).map((endpoint) => this.publicWebhook(endpoint));
  }

  createWebhook(principal: AuthPrincipal, body: unknown): WebhookEndpointRecord {
    const parsed = parseWebhookCreate(body);
    const timestamp = nowIso();
    const endpoint: WebhookEndpointRecord & { signing_secret?: string } = {
      ...(typeof (body as Record<string, unknown>).secret === "string" ? { signing_secret: (body as Record<string, string>).secret! } : {}),
      id: randomUUID(),
      owner_agent_id: principal.agentId,
      workspace_id: parsed.workspace_id,
      url: parsed.url,
      event_types: parsed.event_types,
      enabled: parsed.enabled,
      headers: parsed.headers,
      has_secret: parsed.has_secret,
      metadata: parsed.metadata,
      last_status: null,
      last_error: null,
      last_delivered_at: null,
      created_at: timestamp,
      updated_at: timestamp,
      deleted_at: null,
    };
    this.assertWorkspacePermission(principal, parsed.workspace_id, "write");
    this.webhooks.set(endpoint.id, endpoint);
    this.queuePersistence();
    return this.publicWebhook(endpoint);
  }

  testWebhook(principal: AuthPrincipal, body: unknown): WebhookTestEmitResponse {
    const parsed = parseWebhookTest(body);
    const eventId = randomUUID();
    const endpoints = this.matchingWebhooks(principal, parsed.workspace_id, parsed.event_type, true);
    const deliveryIds = endpoints.map((endpoint) => this.enqueueWebhookDelivery(endpoint, eventId, parsed.event_type, { data: parsed.data, test: true }).id);
    return { event_id: eventId, queued_deliveries: deliveryIds.length, delivery_ids: deliveryIds };
  }

  listWebhookDeliveries(principal: AuthPrincipal, params: URLSearchParams): WebhookDeliveryListResponse {
    const offset = Math.max(0, Number.parseInt(params.get("offset") ?? "0", 10) || 0);
    const limit = clampLimit(Number.parseInt(params.get("limit") ?? "50", 10) || 50, 50, 200);
    const workspaceId = params.get("workspace_id");
    const eventType = parseEnum(params.get("event_type") ?? undefined, "event_type", webhookEventTypes);
    const records = [...this.webhookDeliveries.values()]
      .filter((delivery) => isAdmin(principal) || delivery.owner_agent_id === principal.agentId)
      .filter((delivery) => !workspaceId || workspaceId === "*" || delivery.workspace_id === workspaceId)
      .filter((delivery) => !eventType || delivery.event_type === eventType)
      .sort((left, right) => right.created_at.localeCompare(left.created_at));
    return { deliveries: records.slice(offset, offset + limit), total: records.length, offset, limit };
  }

  getWebhookDelivery(principal: AuthPrincipal, id: string): WebhookDeliveryRecord {
    const delivery = this.webhookDeliveries.get(id);
    if (!delivery || (!isAdmin(principal) && delivery.owner_agent_id !== principal.agentId)) throw new NotFoundError("Webhook delivery not found");
    return delivery;
  }

  private matchingWebhooks(principal: AuthPrincipal, workspaceId: string, eventType: WebhookEventType, includeTests = false): WebhookEndpointRecord[] {
    return [...this.webhooks.values()]
      .filter((endpoint) => !endpoint.deleted_at && endpoint.enabled)
      .filter((endpoint) => endpoint.owner_agent_id === principal.agentId)
      .filter((endpoint) => endpoint.workspace_id === workspaceId)
      .filter((endpoint) => includeTests || endpoint.event_types.includes(eventType));
  }

  private emitWebhookForResource(principal: AuthPrincipal, eventType: WebhookEventType, workspaceId: string, resourceType: string, resourceId: string, data: JsonObject): void {
    const eventId = randomUUID();
    for (const endpoint of this.matchingWebhooks(principal, workspaceId, eventType)) {
      this.enqueueWebhookDelivery(endpoint, eventId, eventType, { resource_type: resourceType, resource_id: resourceId, data });
    }
  }

  private enqueueWebhookDelivery(endpoint: WebhookEndpointRecord, eventId: string, eventType: WebhookEventType, payload: JsonObject): WebhookDeliveryRecord {
    const timestamp = nowIso();
    const delivery: WebhookDeliveryRecord = {
      id: randomUUID(),
      endpoint_id: endpoint.id,
      owner_agent_id: endpoint.owner_agent_id,
      workspace_id: endpoint.workspace_id,
      event_id: eventId,
      event_type: eventType,
      nonce: randomUUID(),
      status: "queued",
      attempts: 0,
      url: endpoint.url,
      response_status: null,
      error: null,
      created_at: timestamp,
      updated_at: timestamp,
      delivered_at: null,
    };
    this.webhookDeliveries.set(delivery.id, delivery);
    this.queuePersistence();
    this.webhooks.set(endpoint.id, { ...endpoint, last_status: "queued", last_error: null, updated_at: timestamp });
    this.queuePersistence();
    this.enqueueJob({
      task_type: "webhook_delivery",
      work_unit_key: "webhook:" + delivery.id,
      payload: { delivery_id: delivery.id, endpoint_id: endpoint.id, event_id: eventId, event_type: eventType, ...payload },
      owner_agent_id: endpoint.owner_agent_id,
      workspace_id: endpoint.workspace_id,
      idempotency_key: "webhook_delivery:" + delivery.id,
      priority: 1,
    });
    return delivery;
  }

  private enqueueJob(input: {
    task_type: QueueJobRecord["task_type"];
    work_unit_key: string;
    payload: JsonObject;
    owner_agent_id: string;
    workspace_id: string;
    session_id?: string | null;
    peer_id?: string | null;
    observer_peer_id?: string | null;
    observed_peer_id?: string | null;
    idempotency_key: string;
    priority?: number;
    operation_id?: string | undefined;
  }): QueueJobRecord {
    const receiptKey = input.operation_id ? this.operationReceiptKey(input.owner_agent_id, input.workspace_id, input.task_type, input.operation_id) : undefined;
    const fingerprint = createHash('sha256').update(canonicalJson({ task_type: input.task_type, workspace_id: input.workspace_id, payload: input.payload, session_id: input.session_id ?? null, peer_id: input.peer_id ?? null, observer_peer_id: input.observer_peer_id ?? null, observed_peer_id: input.observed_peer_id ?? null, priority: input.priority ?? 1 })).digest('hex');
    if (receiptKey) {
      const receipt = this.operations.get(receiptKey);
      if (receipt) {
        if (receipt.payload_hash !== fingerprint) throw new ConflictError('operation_id was used with a different payload');
        const live = typeof receipt.job_id === 'string' ? this.queueJobs.get(receipt.job_id) : undefined;
        if (live) return live;
        if (receipt.job && typeof receipt.job === 'object' && !Array.isArray(receipt.job)) return receipt.job as unknown as QueueJobRecord;
        throw new ConflictError('Operation receipt requires reconciliation');
      }
    }
    const existing = !receiptKey && [...this.queueJobs.values()].find((job) => job.owner_agent_id === input.owner_agent_id && job.workspace_id === input.workspace_id && job.task_type === input.task_type && job.idempotency_key === input.idempotency_key && ["pending", "in_progress", "failed"].includes(job.status));
    if (existing) return existing;
    if (input.task_type === 'consolidation' && Array.isArray(input.payload.memory_ids)) for (const id of input.payload.memory_ids) {
      const memory = typeof id === 'string' ? this.memories.get(id) : undefined;
      if (!memory || memory.agent_id !== input.owner_agent_id || memory.workspace_id !== input.workspace_id || !this.currentMemory(memory)) throw new ForbiddenError('Consolidation sources must be current owned memories in the requested workspace');
    }
    const timestamp = nowIso();
    const job: QueueJobRecord = {
      id: randomUUID(),
      task_type: input.task_type,
      status: "pending",
      work_unit_key: input.work_unit_key,
      payload: input.payload,
      owner_agent_id: input.owner_agent_id,
      workspace_id: input.workspace_id,
      session_id: input.session_id ?? null,
      peer_id: input.peer_id ?? null,
      observer_peer_id: input.observer_peer_id ?? null,
      observed_peer_id: input.observed_peer_id ?? null,
      idempotency_key: input.idempotency_key,
      priority: input.priority ?? 1,
      retry_count: 0,
      created_at: timestamp,
      not_before: null,
      started_at: null,
      finished_at: null,
      locked_at: null,
      error: null,
      result: null,
    };
    this.queueJobs.set(job.id, job);
    if (receiptKey) {
      this.operations.set(receiptKey, {
        id: receiptKey,
        kind: "queue-operation",
        operation_id: input.operation_id!,
        actor: input.owner_agent_id,
        workspace_id: input.workspace_id,
        task_type: input.task_type,
        payload_hash: fingerprint,
        job_id: job.id,
        created_at: timestamp,
        job: job as unknown as JsonObject,
      });
      this.queueOperationsByJob.set(job.id, receiptKey);
      this.pruneQueueOperations();
    }
    this.queuePersistence();
    return job;
  }

  private operationReceiptKey(owner: string, workspace: string, task: string, id: string): string {
    return 'queue-operation:' + createHash('sha256').update(canonicalJson([owner, workspace, task, id])).digest('hex');
  }

  getQueueOperation(principal: AuthPrincipal, id: string, params: URLSearchParams): QueueJobRecord {
    const workspace = params.get('workspace_id') ?? 'default';
    this.assertWorkspacePermission(principal, workspace, 'read');
    const task = params.get('task_type');
    if (task !== 'consolidation' && task !== 'dream') throw new ValidationError('task_type must be consolidation or dream');
    if (!/^[A-Za-z0-9._:-]{1,160}$/.test(id)) throw new ValidationError('Invalid operation_id');
    const receipt = this.operations.get(this.operationReceiptKey(principal.agentId, workspace, task, id));
    if (!receipt) throw new NotFoundError('Operation not found');
    const live = typeof receipt.job_id === 'string' ? this.queueJobs.get(receipt.job_id) : undefined;
    if (live) return this.getQueueJob(principal, live.id);
    if (!receipt.job || typeof receipt.job !== 'object' || Array.isArray(receipt.job)) throw new NotFoundError('Operation result not found');
    return receipt.job as unknown as QueueJobRecord;
  }

  private retainQueueOperation(job: QueueJobRecord): void {
    const key = this.queueOperationsByJob.get(job.id);
    const receipt = key ? this.operations.get(key) : undefined;
    if (key && receipt) this.operations.set(key, { ...receipt, job: job as unknown as JsonObject });
  }

  private pruneQueueOperations(now = Date.now()): void {
    const overLimit = this.queueOperationsByJob.size > queueOperationReceiptLimit;
    if (!overLimit && now - this.queueOperationsPrunedAt < queueOperationPruneIntervalMs) return;
    this.queueOperationsPrunedAt = now;
    const terminal = new Set(["completed", "dead_letter", "cancelled"]);
    const prunable: Array<{ key: string; jobId: string; finishedAt: number }> = [];
    for (const [jobId, key] of this.queueOperationsByJob) {
      const receipt = this.operations.get(key);
      if (!receipt) {
        this.queueOperationsByJob.delete(jobId);
        continue;
      }
      const job = (this.queueJobs.get(jobId) ?? receipt.job) as Partial<QueueJobRecord> | undefined;
      if (!job || !terminal.has(String(job.status))) continue;
      const finishedAt = Date.parse(String(job.finished_at ?? receipt.created_at ?? job.created_at ?? ""));
      prunable.push({ key, jobId, finishedAt: Number.isFinite(finishedAt) ? finishedAt : 0 });
    }
    prunable.sort((left, right) => left.finishedAt - right.finishedAt);
    let excess = this.queueOperationsByJob.size - queueOperationReceiptLimit;
    for (const entry of prunable) {
      const expired = now - entry.finishedAt > queueOperationReceiptRetentionMs;
      if (!expired && excess <= 0) break;
      this.operations.delete(entry.key);
      this.queueOperationsByJob.delete(entry.jobId);
      excess -= 1;
    }
  }

  async workerTick(): Promise<void> {
    if (this.workerRunning) return;
    this.workerRunning = true;
    this.workerHeartbeat = nowIso();
    const principal: AuthPrincipal = { agentId: "hivemem-worker", scopes: ["admin:queue"], rawClaims: { role: "admin" } };
    try {
      await this.flushPersistence();
      const interval = Number(process.env.HIVEMEM_CONSOLIDATION_INTERVAL_SECONDS ?? 300) * 1000;
      const cursor = this.operations.get('scheduler:cursor');
      if (interval > 0 && (!cursor || Date.now() - Number(cursor.scanned_at) >= interval)) {
        const groups = new Map<string, MemoryRecord[]>();
        for (const memory of this.memories.values()) if (this.currentMemory(memory)) { const key = memory.agent_id + ':' + memory.workspace_id; const batch = groups.get(key) ?? []; batch.push(memory); groups.set(key, batch); }
        for (const [key, memories] of groups) {
          const watermark = memories.map((memory) => memory.id + ':' + memory.updated_at).sort().join('|');
          if (this.operations.get('scheduler:' + key)?.watermark === watermark) continue;
          const sample = memories[0]!;
          memories.sort((a, b) => a.id.localeCompare(b.id));
          for (let offset = 0; offset < memories.length; offset += 256) this.enqueueJob({ task_type: 'consolidation', work_unit_key: key, payload: { memory_ids: memories.slice(offset, offset + 256).map((memory) => memory.id) }, owner_agent_id: sample.agent_id, workspace_id: sample.workspace_id, idempotency_key: 'scheduled:' + key + ':' + offset + ':' + uuid5(watermark), priority: 0 });
          this.operations.set('scheduler:' + key, { id: 'scheduler:' + key, kind: 'scheduler-cursor', watermark });
        }
        this.operations.set('scheduler:cursor', { id: 'scheduler:cursor', kind: 'scheduler-cursor', scanned_at: Date.now() }); this.queuePersistence();
      }
      for (const [id, job] of this.queueJobs) {
        if (job.status === "in_progress" && (!job.locked_at || Date.parse(job.locked_at) < Date.now() - 60_000)) {
          this.queueJobs.set(id, { ...job, status: "pending", locked_at: null, error: "Recovered interrupted worker" });
          this.queuePersistence();
        }
      }
      try { await this.runNextQueueJob(principal, new URLSearchParams()); }
      catch (error) { if (!(error instanceof NotFoundError)) throw error; }
      await this.flushPersistence();
      this.workerLastSuccess = nowIso(); this.workerError = null;
    } catch (error) {
      this.workerError = this.persistenceError ? "Persistence unavailable; automatic recovery will retry" : "Worker tick failed; inspect queue and dependency status";
      throw error;
    } finally { this.workerHeartbeat = nowIso(); this.workerRunning = false; }
  }

  async runNextQueueJob(principal: AuthPrincipal, params: URLSearchParams): Promise<QueueJobRecord> {
    assertQueueAdmin(principal);
    const taskType = parseEnum(params.get("task_type") ?? undefined, "task_type", taskTypes);
    const workspaceId = params.get("workspace_id");
    const now = nowIso();
    const job = [...this.queueJobs.values()]
      .filter((candidate) => candidate.status === "pending" || candidate.status === "failed")
      .filter((candidate) => !candidate.not_before || candidate.not_before <= now)
      .filter((candidate) => !taskType || candidate.task_type === taskType)
      .filter((candidate) => !workspaceId || candidate.workspace_id === workspaceId)
      .sort((left, right) => right.priority - left.priority || left.created_at.localeCompare(right.created_at))[0];
    if (!job) throw new NotFoundError("No runnable queue job found");
    return this.runQueueJob(principal, job.id);
  }

  async runQueueJob(principal: AuthPrincipal, id: string): Promise<QueueJobRecord> {
    assertQueueAdmin(principal);
    const job = this.getQueueJob(principal, id);
    if (job.status === "cancelled" || job.status === "completed" || job.status === "in_progress") throw new ConflictError("Queue job is not runnable");
    const startedAt = nowIso();
    const running: QueueJobRecord = { ...job, status: "in_progress", started_at: job.started_at ?? startedAt, locked_at: startedAt, error: null };
    this.queueJobs.set(id, running);
    this.retainQueueOperation(running);
    this.queuePersistence();
    try {
      await this.flushPersistence();
      const result = await this.executeQueueJob(running);
      if (this.queueJobs.get(id)?.status === "cancelled") return this.queueJobs.get(id)!;
      const completed: QueueJobRecord = { ...running, status: "completed", finished_at: nowIso(), locked_at: null, error: null, result };
      this.queueJobs.set(id, completed);
      this.retainQueueOperation(completed);
      if (job.task_type === "consolidation") this.operations.set("run:" + id, { id: "run:" + id, kind: "consolidation-run", run_id: id, actor: job.owner_agent_id, workspace_id: job.workspace_id, status: completed.status, created_at: job.created_at, finished_at: completed.finished_at, result: completed.result });
      this.queuePersistence();
      return completed;
    } catch (error) {
      const retryCount = running.retry_count + 1;
      const failed: QueueJobRecord = {
        ...running,
        status: retryCount > 3 ? "dead_letter" : "failed",
        retry_count: retryCount,
        not_before: new Date(Date.now() + Math.min(300_000, 1000 * 2 ** retryCount)).toISOString(),
        locked_at: null,
        finished_at: retryCount > 3 ? nowIso() : running.finished_at,
        error: error instanceof Error ? error.message : String(error),
      };
      this.queueJobs.set(id, failed);
      this.retainQueueOperation(failed);
      if (job.task_type === "consolidation") this.operations.set("run:" + id, { id: "run:" + id, kind: "consolidation-run", run_id: id, actor: job.owner_agent_id, workspace_id: job.workspace_id, status: failed.status, created_at: job.created_at, finished_at: failed.finished_at });
      this.queuePersistence();
      return failed;
    }
  }

  private async executeQueueJob(job: QueueJobRecord): Promise<JsonObject> {
    if (job.task_type !== "webhook_delivery" && (this.agents.get(job.owner_agent_id) as AgentInfo & { active?: boolean } | undefined)?.active === false) return { status: "skipped", reason: "owner_disabled" };
    switch (job.task_type) {
      case "message_extract":
        return this.executeMessageExtract(job);
      case "webhook_delivery":
        return this.executeWebhookDelivery(job);
      case "summary":
        return this.executeSummary(job);
      case "representation":
        return this.executeRepresentation(job);
      case "conflict_scan": {
        const memory = typeof job.payload.memory_id === "string" ? this.memories.get(job.payload.memory_id) : null;
        let conflicts = 0;
        if (memory && !memory.deleted_at) for (const relation of memory.relationships) {
          const target = this.memories.get(relation.target_id);
          if (relation.type !== "contradicts" || !target || target.deleted_at || target.workspace_id !== memory.workspace_id) continue;
          const id = "conflict:" + [memory.id, target.id].sort().join(":");
          if (!this.operations.has(id)) this.operations.set(id, { id, kind: "conflict", workspace_id: memory.workspace_id, memory_ids: [memory.id, target.id], resolved: false, created_at: nowIso() });
          conflicts++;
        }
        this.queuePersistence();
        return { status: "completed", conflict_count: conflicts };
      }
      case "dream":
        return this.executeDream(job);
      case "consolidation":
        return this.executeConsolidation(job);
      case "peer_card":
        return this.executePeerCard(job);
      case "decay_recalc":
      case "embedding_reconcile":
      case "sleep":
      case "forgetting_review":
        return this.unavailable("Queue task " + job.task_type);
      default:
        throw new BadRequestError("No TypeScript queue handler for task type: " + job.task_type);
    }
  }

  private executeMessageExtract(job: QueueJobRecord): JsonObject {
    const messagePointId = typeof job.payload.message_point_id === "string" ? job.payload.message_point_id : null;
    if (!messagePointId) throw new BadRequestError("message_extract payload missing message_point_id");
    const message = this.messages.get(messagePointId);
    if (!message || message.deleted_at) return { status: "skipped", reason: "message_not_found", message_point_id: messagePointId };
    if (message.memory_id) return { status: "skipped", reason: "memory_already_exists", message_point_id: messagePointId, memory_id: message.memory_id };
    const memoryType = parseEnum(job.payload.memory_type, "memory_type", memoryTypes, "episodic");
    const timestamp = nowIso();
    const memory: MemoryRecord = {
      id: randomUUID(),
      agent_id: job.owner_agent_id,
      content: message.content,
      type: memoryType,
      scope: "private",
      source: "conversation",
      confidence: 0.75,
      importance: 0.5,
      tags: ["episode", "message", message.role],
      metadata: { episode_id: message.episode_id, message_id: message.message_id, message_role: message.role, speaker_id: message.speaker_id, raw_message_metadata: message.metadata },
      sensitivity: "internal",
      retention_class: "standard",
      redaction_policy: "none",
      workspace_id: message.workspace_id,
      session_id: message.session_id,
      created_at: timestamp,
      updated_at: timestamp,
      expires_at: null,
      valid_from: null,
      valid_to: null,
      observed_at: message.observed_at,
      relationships: [{ target_id: message.message_id, type: "derived_from", confidence: 1, metadata: { record_type: "message" } }],
      confidence_provenance: [{ at: timestamp, actor_agent_id: job.owner_agent_id, old_confidence: null, new_confidence: 0.75, reason: "message_memory_extract", source: "queue" }],
      supersedes: null,
      superseded_by: null,
      superseded_at: null,
      corroborated_by: [],
      endorsements: 0,
      endorsed_by: [],
      opposed_by: [],
      deleted_at: null,
      effective_confidence: 0.75,
      sanitization_warnings: null,
    };
    this.memories.set(memory.id, memory);
    this.messages.set(message.id, { ...message, memory_id: memory.id, updated_at: timestamp });
    this.queuePersistence();
    return { status: "completed", memory_id: memory.id, message_point_id: messagePointId };
  }

  private async executeWebhookDelivery(job: QueueJobRecord): Promise<JsonObject> {
    const deliveryId = typeof job.payload.delivery_id === "string" ? job.payload.delivery_id : null;
    if (!deliveryId) throw new BadRequestError("webhook_delivery payload missing delivery_id");
    const delivery = this.webhookDeliveries.get(deliveryId);
    if (!delivery) return { status: "skipped", reason: "delivery_not_found", delivery_id: deliveryId };
    const endpoint = this.webhooks.get(delivery.endpoint_id);
    const skip = (reason: string): JsonObject => {
      const timestamp = nowIso();
      this.webhookDeliveries.set(delivery.id, { ...delivery, status: 'failed', response_status: null, error: reason, updated_at: timestamp });
      if (endpoint) this.webhooks.set(endpoint.id, { ...endpoint, last_status: 'failed', last_error: reason, updated_at: timestamp });
      this.queuePersistence();
      return { status: 'skipped', reason };
    };
    if (!endpoint || endpoint.deleted_at || !endpoint.enabled) {
      return skip('endpoint_disabled');
    }
    const resource = typeof job.payload.resource_id === 'string' ? this.memories.get(job.payload.resource_id) : undefined;
    if (this.agents.get(endpoint.owner_agent_id)?.active === false || (job.payload.resource_type === 'memory' && (!resource || !this.currentMemory(resource)))) {
      return skip('resource_no_longer_available');
    }
    if (endpoint.workspace_id !== delivery.workspace_id) return skip('endpoint_workspace_changed');
    try { this.assertWorkspacePermission({ agentId: endpoint.owner_agent_id, scopes: ["*"], rawClaims: {} }, endpoint.workspace_id, "read"); }
    catch { return skip('workspace_access_withdrawn'); }
    const secret = (endpoint as WebhookEndpointRecord & { signing_secret?: string }).signing_secret;
    if (endpoint.has_secret && !secret) return skip('signing_secret_unconfigured');
    let responseStatus: number;
    try {
      responseStatus = await this.webhookTransport({ url: endpoint.url, headers: endpoint.headers, payload: job.payload, ...(secret ? { secret } : {}) });
    } catch (error) {
      const reason = error instanceof WebhookDeliveryError ? error.code : 'transport';
      const responseStatus = error instanceof WebhookDeliveryError ? error.responseStatus : null;
      const timestamp = nowIso();
      this.webhookDeliveries.set(delivery.id, { ...delivery, status: "failed", attempts: delivery.attempts + 1, response_status: responseStatus, error: reason, updated_at: timestamp });
      const current = this.webhooks.get(endpoint.id);
      if (current) this.webhooks.set(endpoint.id, { ...current, last_status: 'failed', last_error: reason, updated_at: timestamp });
      this.queuePersistence();
      throw new Error("Webhook delivery failed");
    }
    const timestamp = nowIso();
    const delivered: WebhookDeliveryRecord = { ...delivery, status: "delivered", attempts: delivery.attempts + 1, response_status: responseStatus, error: null, updated_at: timestamp, delivered_at: timestamp };
    this.webhookDeliveries.set(deliveryId, delivered);
    const current = this.webhooks.get(endpoint.id);
    if (current) this.webhooks.set(endpoint.id, { ...current, last_status: "delivered", last_error: null, last_delivered_at: timestamp, updated_at: timestamp });
    this.queuePersistence();
    return { status: "delivered", delivery_id: deliveryId, response_status: responseStatus };
  }

  private reasoningPeerId(job: QueueJobRecord): string {
    const payloadPeer = typeof job.payload.peer_id === "string" ? job.payload.peer_id : null;
    const payloadTarget = typeof job.payload.target_peer_id === "string" ? job.payload.target_peer_id : null;
    return job.peer_id || job.observed_peer_id || payloadPeer || payloadTarget || job.owner_agent_id;
  }

  private jobObserver(job: QueueJobRecord): string {
    return job.observer_peer_id || job.owner_agent_id;
  }

  private ownedSessionMemories(owner: string, sessionId: string, workspaceId: string): MemoryRecord[] {
    return [...this.memories.values()]
      .filter((memory) => memory.session_id === sessionId)
      .filter((memory) => memory.agent_id === owner)
      .filter((memory) => this.currentMemory(memory))
      .filter((memory) => workspaceId === "*" || memory.workspace_id === workspaceId || (workspaceId === "default" && memory.workspace_id === "default"))
      .sort((left, right) => left.created_at.localeCompare(right.created_at))
      .slice(-DEFAULT_REASONING_SETTINGS.reasoning_max_batch_memories);
  }

  private payloadMemoriesForJob(job: QueueJobRecord): MemoryRecord[] {
    const rawIds = Array.isArray(job.payload.memory_ids)
      ? job.payload.memory_ids.filter((value): value is string => typeof value === "string")
      : typeof job.payload.memory_id === "string"
        ? [job.payload.memory_id]
        : [];
    if (rawIds.length) {
      const wanted = new Set(rawIds);
      const memories = [...this.memories.values()].filter(memory => wanted.has(memory.id) && memory.agent_id === job.owner_agent_id && memory.workspace_id === job.workspace_id && this.currentMemory(memory));
      if (memories.length !== wanted.size) throw new ForbiddenError('Queued sources are no longer current owned memories in the job workspace');
      return memories.sort((left, right) => left.created_at.localeCompare(right.created_at));
    }
    if (job.session_id) return this.ownedSessionMemories(job.owner_agent_id, job.session_id, job.workspace_id);
    return [];
  }

  private memoryBatches(memories: readonly MemoryRecord[]): MemoryRecord[][] {
    const batches: MemoryRecord[][] = [];
    let current: MemoryRecord[] = [];
    let tokens = 0;
    for (const memory of memories) {
      const memoryTokens = estimateReasoningTokens(memory.content) + 24;
      if (current.length && (tokens + memoryTokens > DEFAULT_REASONING_SETTINGS.reasoning_batch_tokens || current.length >= DEFAULT_REASONING_SETTINGS.reasoning_max_batch_memories)) {
        batches.push(current);
        current = [];
        tokens = 0;
      }
      current.push(memory);
      tokens += memoryTokens;
    }
    if (current.length) batches.push(current);
    return batches;
  }

  private representationThreshold(memories: readonly MemoryRecord[], force: boolean): JsonObject | null {
    if (force || !memories.length) return null;
    const minTokens = DEFAULT_REASONING_SETTINGS.reasoning_representation_min_tokens;
    const maxWait = DEFAULT_REASONING_SETTINGS.reasoning_representation_max_wait_seconds;
    const tokens = memories.reduce((sum, memory) => sum + estimateReasoningTokens(memory.content) + 24, 0);
    const oldest = memories.map((memory) => memory.created_at).sort()[0];
    const waited = oldest ? Math.max(0, (Date.now() - Date.parse(oldest)) / 1000) : 0;
    if (tokens < minTokens && waited < maxWait) {
      return { status: "skipped", reason: "token_threshold_not_met", memory_count: memories.length, tokens, min_tokens: minTokens, max_wait_seconds: maxWait, waited_seconds: Math.floor(waited) };
    }
    return null;
  }

  private conclusionPayloadsFor(filters: { owner: string; observer: string; observed: string; workspaceId: string; sessionId?: string | null; kind?: ConclusionKind; limit: number }): ConclusionRecord[] {
    return [...this.conclusions.values()]
      .filter((conclusion) => conclusion.owner_agent_id === filters.owner)
      .filter((conclusion) => conclusion.observer_peer_id === filters.observer)
      .filter((conclusion) => conclusion.observed_peer_id === filters.observed)
      .filter((conclusion) => this.conclusionCurrent(conclusion))
      .filter((conclusion) => filters.workspaceId === "*" || conclusion.workspace_id === filters.workspaceId)
      .filter((conclusion) => !filters.sessionId || conclusion.session_id === filters.sessionId)
      .filter((conclusion) => !filters.kind || conclusion.kind === filters.kind)
      .sort((left, right) => right.confidence - left.confidence || (right.updated_at ?? "").localeCompare(left.updated_at ?? ""))
      .slice(0, filters.limit);
  }

  private storeReasonedConclusion(conclusion: ReasonedConclusion, ctx: { owner: string; observer: string; observed: string; workspaceId: string; sessionId: string | null; uniqueKey?: string }): string {
    const sourceIds = [...new Set(conclusion.source_memory_ids)];
    const normalized = normalizeConclusionText(conclusion.content);
    const seed = ctx.uniqueKey ?? `${ctx.workspaceId}:${ctx.observer}:${ctx.observed}:${ctx.sessionId ?? "None"}:${conclusion.kind}:${normalized}:${sourceIds.join(",")}`;
    const id = uuid5(`hivemem-conclusion:${seed}`);
    const existing = this.conclusions.get(id);
    const timestamp = nowIso();
    const metadata: JsonObject = { ...existing?.metadata, ...conclusion.metadata };
    if (metadata.reasoning_provider === undefined) metadata.reasoning_provider = DEFAULT_REASONING_SETTINGS.reasoning_provider;
    if (metadata.generated_by === undefined) metadata.generated_by = "server_reasoning";
    const record: ConclusionRecord = {
      id,
      owner_agent_id: ctx.owner,
      observer_peer_id: ctx.observer,
      observed_peer_id: ctx.observed,
      session_id: ctx.sessionId,
      workspace_id: ctx.workspaceId || "default",
      source_memory_ids: [...new Set([...(existing?.source_memory_ids ?? []), ...sourceIds])].slice(0, maxConclusionSources),
      content: conclusion.content,
      kind: conclusion.kind,
      confidence: conclusion.confidence,
      metadata,
      created_at: existing?.created_at ?? timestamp,
      updated_at: timestamp,
      supersedes: existing?.supersedes ?? null,
      superseded_by: existing?.superseded_by ?? null,
      deleted_at: null,
    };
    this.conclusions.set(id, record);
    this.queuePersistence();
    return id;
  }

  private dedupeConclusions(conclusions: readonly ConclusionRecord[]): { deduped: number; mergedIds: string[] } {
    const byNorm = new Map<string, ConclusionRecord[]>();
    for (const conclusion of conclusions) {
      if (conclusion.superseded_by || conclusion.kind === "summary") continue;
      const norm = conclusion.kind + ":" + normalizeConclusionText(conclusion.content);
      if (!norm) continue;
      const group = byNorm.get(norm) ?? [];
      group.push(conclusion);
      byNorm.set(norm, group);
    }
    let deduped = 0;
    const mergedIds: string[] = [];
    const timestamp = nowIso();
    for (const group of byNorm.values()) {
      if (group.length < 2) continue;
      group.sort((left, right) => right.confidence - left.confidence || (right.created_at ?? "").localeCompare(left.created_at ?? ""));
      const keeper = group[0];
      if (!keeper) continue;
      const sourceIds = [...new Set(group.flatMap((item) => item.source_memory_ids))].sort().slice(0, maxConclusionSources);
      const mergedIds = [...new Set([...(Array.isArray(keeper.metadata.merged_conclusion_ids) ? keeper.metadata.merged_conclusion_ids.filter((id): id is string => typeof id === 'string') : []), ...group.slice(1).map(item => item.id)])];
      this.conclusions.set(keeper.id, { ...keeper, source_memory_ids: sourceIds, metadata: { ...keeper.metadata, merged_conclusion_ids: mergedIds }, updated_at: timestamp });
      for (const duplicate of group.slice(1)) {
        const current = this.conclusions.get(duplicate.id);
        if (!current) continue;
        this.conclusions.set(duplicate.id, { ...current, superseded_by: keeper.id, updated_at: timestamp });
        mergedIds.push(duplicate.id);
        deduped += 1;
      }
    }
    if (deduped) this.queuePersistence();
    return { deduped, mergedIds };
  }

  private emitReasoningEvent(owner: string, eventType: WebhookEventType, workspaceId: string, resourceType: string, resourceId: string, data: JsonObject): void {
    this.emitWebhookForResource({ agentId: owner, scopes: ["*"], rawClaims: {} }, eventType, workspaceId, resourceType, resourceId, data);
  }

  private dreamPeer(ctx: { owner: string; observer: string; observed: string; workspaceId: string; sessionId: string | null; includePeerCard: boolean }): JsonObject {
    let conclusions = this.conclusionPayloadsFor({ owner: ctx.owner, observer: ctx.observer, observed: ctx.observed, workspaceId: ctx.workspaceId, limit: 500 });
    const { deduped, mergedIds } = this.dedupeConclusions(conclusions);
    conclusions = this.conclusionPayloadsFor({ owner: ctx.owner, observer: ctx.observer, observed: ctx.observed, workspaceId: ctx.workspaceId, limit: 500 });
    const result = dreamConclusions(conclusions, { peerId: ctx.observed, sessionId: ctx.sessionId });
    let stored = 0;
    for (const conclusion of result.conclusions) {
      this.storeReasonedConclusion(conclusion, { owner: ctx.owner, observer: ctx.observer, observed: ctx.observed, workspaceId: ctx.workspaceId, sessionId: ctx.sessionId });
      stored += 1;
    }
    let storedPeerCards = 0;
    const peerCardIds: string[] = [];
    if (ctx.includePeerCard) {
      const cards = result.peer_card ?? buildPeerCardConclusions(conclusions, { peerId: ctx.observed });
      for (const card of cards) {
        peerCardIds.push(this.storeReasonedConclusion(card, { owner: ctx.owner, observer: ctx.observer, observed: ctx.observed, workspaceId: ctx.workspaceId, sessionId: ctx.sessionId }));
        storedPeerCards += 1;
      }
    }
    if (peerCardIds.length) {
      this.emitReasoningEvent(ctx.owner, "peer_card.updated", ctx.workspaceId, "peer", ctx.observed, { peer_id: ctx.observed, observer_peer_id: ctx.observer, peer_card_ids: peerCardIds, session_id: ctx.sessionId });
    }
    const finalDedupe = this.dedupeConclusions(this.conclusionPayloadsFor({ owner: ctx.owner, observer: ctx.observer, observed: ctx.observed, workspaceId: ctx.workspaceId, limit: 500 }));
    return { status: "completed", stored_conclusions: stored, stored_peer_cards: storedPeerCards, deduped: deduped + finalDedupe.deduped, merged_duplicate_ids: [...mergedIds, ...finalDedupe.mergedIds] };
  }

  private executeRepresentation(job: QueueJobRecord): JsonObject {
    if (!DEFAULT_REASONING_SETTINGS.reasoning_enabled) return { status: "reasoning_disabled" };
    const owner = job.owner_agent_id;
    const observer = this.jobObserver(job);
    const peer = this.reasoningPeerId(job);
    const memories = this.payloadMemoriesForJob(job);
    const threshold = this.representationThreshold(memories, job.payload.force === true);
    if (threshold) return threshold;
    let stored = 0;
    for (const batch of this.memoryBatches(memories)) {
      const result = extractConclusions(batch, { peerId: peer, sessionId: job.session_id });
      for (const conclusion of result.conclusions) {
        this.storeReasonedConclusion(conclusion, { owner, observer, observed: peer, workspaceId: job.workspace_id, sessionId: job.session_id });
        stored += 1;
      }
    }
    const dream = stored >= DEFAULT_REASONING_SETTINGS.reasoning_min_new_conclusions
      ? this.dreamPeer({ owner, observer, observed: peer, workspaceId: job.workspace_id, sessionId: job.session_id, includePeerCard: true })
      : { stored_conclusions: 0, stored_peer_cards: 0, deduped: 0 };
    return { status: "completed", task_type: "representation", memories_reviewed: memories.length, stored_conclusions: stored, dream };
  }

  private executeSummary(job: QueueJobRecord): JsonObject {
    if (!DEFAULT_REASONING_SETTINGS.reasoning_enabled) return { status: "reasoning_disabled" };
    const owner = job.owner_agent_id;
    const observer = this.jobObserver(job);
    const peer = this.reasoningPeerId(job);
    if (!job.session_id) return { status: "skipped", reason: "missing_owner_or_session" };
    const memories = this.ownedSessionMemories(owner, job.session_id, job.workspace_id);
    if (!memories.length) return { status: "skipped", reason: "no_session_memories" };
    const force = job.payload.force === true;
    const count = memories.length;
    const shortEvery = DEFAULT_REASONING_SETTINGS.reasoning_summary_short_every;
    const longEvery = DEFAULT_REASONING_SETTINGS.reasoning_summary_long_every;
    const shouldShort = force || count === 1 || count % shortEvery === 0;
    const shouldLong = force || (count >= longEvery && count % longEvery === 0);
    if (!shouldShort && !shouldLong) return { status: "skipped", reason: "summary_threshold_not_met", memory_count: count };
    const previous = this.conclusionPayloadsFor({ owner, observer, observed: peer, workspaceId: job.workspace_id, sessionId: job.session_id, kind: "summary", limit: 5 }).map((conclusion) => conclusion.content).filter(Boolean);
    const summaryIds: string[] = [];
    for (const [summaryType, enabled] of [["short", shouldShort], ["long", shouldLong]] as const) {
      if (!enabled) continue;
      const text = summarizeSessionMemories(memories, { previousSummaries: previous, summaryType, sessionId: job.session_id });
      const id = this.storeReasonedConclusion(
        { content: text, kind: "summary", confidence: summaryType === "short" ? 0.82 : 0.88, source_memory_ids: memories.slice(-longEvery).map((memory) => memory.id), metadata: { summary_type: summaryType, memory_count: count, provider: DEFAULT_REASONING_SETTINGS.reasoning_provider } },
        { owner, observer, observed: peer, workspaceId: job.workspace_id, sessionId: job.session_id, uniqueKey: `summary:${summaryType}:${job.session_id}:${job.workspace_id}:${count}` },
      );
      summaryIds.push(id);
    }
    if (summaryIds.length) {
      this.emitReasoningEvent(owner, "summary.updated", job.workspace_id, "session", job.session_id, { session_id: job.session_id, summary_ids: summaryIds, memory_count: count, peer_id: peer });
    }
    return { status: "completed", memory_count: count, summary_ids: summaryIds };
  }

  private executeConsolidation(job: QueueJobRecord): JsonObject {
    if (!DEFAULT_REASONING_SETTINGS.reasoning_enabled) return { status: "reasoning_disabled" };
    const owner = job.owner_agent_id;
    const observer = this.jobObserver(job);
    const peer = this.reasoningPeerId(job);
    const memories = this.payloadMemoriesForJob(job);
    const reviewedMemoryIds = memories.map((memory) => memory.id);
    const skippedReasons: string[] = [];
    if (!memories.length) skippedReasons.push("no_memories");
    let stored = 0;
    const generatedConclusionIds: string[] = [];
    const conflictConclusionIds: string[] = [];
    const batches: JsonObject[] = [];
    let batchIndex = 0;
    for (const batch of this.memoryBatches(memories)) {
      batchIndex += 1;
      const result = extractConclusions(batch, { peerId: peer, sessionId: job.session_id });
      const batchConclusionIds: string[] = [];
      for (const conclusion of result.conclusions) {
        const id = this.storeReasonedConclusion(conclusion, { owner, observer, observed: peer, workspaceId: job.workspace_id, sessionId: job.session_id });
        generatedConclusionIds.push(id);
        batchConclusionIds.push(id);
        if (conclusion.kind === "abductive") conflictConclusionIds.push(id);
        stored += 1;
      }
      if (!result.conclusions.length) skippedReasons.push(`batch_${batchIndex}:no_conclusions`);
      batches.push({ index: batchIndex, memory_ids: batch.map((memory) => memory.id), tokens: batch.reduce((sum, memory) => sum + estimateReasoningTokens(memory.content) + 24, 0), generated_conclusion_ids: batchConclusionIds });
    }
    const dream = this.dreamPeer({ owner, observer, observed: peer, workspaceId: job.workspace_id, sessionId: job.session_id, includePeerCard: true });
    return {
      status: "completed",
      memories_reviewed: memories.length,
      reviewed_memory_ids: reviewedMemoryIds,
      stored_conclusions: stored,
      generated_conclusion_ids: generatedConclusionIds,
      merged_duplicate_ids: (dream.merged_duplicate_ids as JsonValue) ?? [],
      deduped_conclusions: (dream.deduped as JsonValue) ?? 0,
      conflict_conclusion_ids: conflictConclusionIds,
      skipped_reasons: skippedReasons,
      batches,
      dream,
    };
  }

  private executeDream(job: QueueJobRecord): JsonObject {
    if (!DEFAULT_REASONING_SETTINGS.reasoning_enabled) return { status: "reasoning_disabled" };
    const owner = job.owner_agent_id;
    const observer = this.jobObserver(job);
    const peer = this.reasoningPeerId(job);
    if (!peer) return { status: "skipped", reason: "missing_owner_or_peer" };
    return this.dreamPeer({ owner, observer, observed: peer, workspaceId: job.workspace_id, sessionId: job.session_id, includePeerCard: job.payload.include_peer_card !== false });
  }

  private executePeerCard(job: QueueJobRecord): JsonObject {
    const owner = job.owner_agent_id;
    const observer = this.jobObserver(job);
    const peer = this.reasoningPeerId(job);
    if (!peer) return { status: "skipped", reason: "missing_owner_or_peer" };
    const conclusions = this.conclusionPayloadsFor({ owner, observer, observed: peer, workspaceId: job.workspace_id, sessionId: job.session_id, limit: 200 });
    const cards = buildPeerCardConclusions(conclusions, { peerId: peer });
    const peerCardIds: string[] = [];
    for (const card of cards) {
      peerCardIds.push(this.storeReasonedConclusion(card, { owner, observer, observed: peer, workspaceId: job.workspace_id, sessionId: job.session_id }));
    }
    if (peerCardIds.length) {
      this.emitReasoningEvent(owner, "peer_card.updated", job.workspace_id, "peer", peer, { peer_id: peer, observer_peer_id: observer, peer_card_ids: peerCardIds, session_id: job.session_id });
    }
    return { status: "completed", stored_peer_cards: peerCardIds.length };
  }

  queueStatus(principal: AuthPrincipal, params: URLSearchParams): QueueStatusResponse {
    const offset = Math.max(0, Number.parseInt(params.get("offset") ?? "0", 10) || 0);
    const limit = clampLimit(Number.parseInt(params.get("limit") ?? "50", 10) || 50, 50, 200);
    const status = parseEnum(params.get("status") ?? undefined, "status", jobStatuses);
    const taskType = parseEnum(params.get("task_type") ?? undefined, "task_type", taskTypes);
    const sessionId = params.get("session_id");
    const peerId = params.get("peer_id");
    const workspaceId = params.get("workspace_id");
    const observerPeerId = params.get("observer_peer_id");
    const observedPeerId = params.get("observed_peer_id");
    const workUnitKey = params.get("work_unit_key");
    const requestedOwner = params.get("owner_agent_id");
    if (!isAdmin(principal) && requestedOwner && requestedOwner !== principal.agentId) {
      throw new ForbiddenError("You can only inspect your own queue jobs");
    }
    const ownerAgentId = isAdmin(principal) ? requestedOwner : principal.agentId;
    if (workspaceId) this.assertWorkspacePermission(principal, workspaceId, 'read');
    const canInspectWorkspace = (job: QueueJobRecord): boolean => { try { this.assertWorkspacePermission(principal, job.workspace_id, 'read'); return true; } catch { return false; } };
    const records = [...this.queueJobs.values()]
      .filter(canInspectWorkspace)
      .filter((job) => !status || job.status === status)
      .filter((job) => !taskType || job.task_type === taskType)
      .filter((job) => !sessionId || job.session_id === sessionId)
      .filter((job) => !peerId || job.peer_id === peerId)
      .filter((job) => !ownerAgentId || job.owner_agent_id === ownerAgentId)
      .filter((job) => !workspaceId || job.workspace_id === workspaceId)
      .filter((job) => !observerPeerId || job.observer_peer_id === observerPeerId)
      .filter((job) => !observedPeerId || job.observed_peer_id === observedPeerId)
      .filter((job) => !workUnitKey || job.work_unit_key === workUnitKey)
      .sort((left, right) => right.created_at.localeCompare(left.created_at));
    const count = (state: QueueJobRecord["status"]) => records.filter((job) => job.status === state).length;
    return {
      worker: this.workerHealth(),
      jobs: records.slice(offset, offset + limit).map(queueSummary),
      total: records.length,
      pending_count: count("pending"),
      in_progress_count: count("in_progress"),
      failed_count: count("failed"),
      dead_letter_count: count("dead_letter"),
      offset,
      limit,
    };
  }

  getQueueJob(principal: AuthPrincipal, id: string): QueueJobRecord {
    const job = this.queueJobs.get(id);
    if (!job) throw new NotFoundError("Queue job not found");
    if (!isAdmin(principal) && job.owner_agent_id !== principal.agentId) throw new NotFoundError("Queue job not found");
    this.assertWorkspacePermission(principal, job.workspace_id, 'read');
    return job;
  }

  retryQueueJob(principal: AuthPrincipal, id: string): QueueJobRecord {
    assertQueueAdmin(principal);
    const job = this.queueJobs.get(id);
    if (!job) throw new NotFoundError("Queue job not found");
    if (!['failed', 'dead_letter', 'cancelled'].includes(job.status)) throw new ConflictError('Only failed, dead-letter or cancelled jobs can be retried');
    const updated: QueueJobRecord = {
      ...job,
      status: "pending",
      retry_count: 0,
      error: null,
      locked_at: null,
      finished_at: null,
      not_before: null,
    };
    this.queueJobs.set(id, updated);
    this.retainQueueOperation(updated);
    this.queuePersistence();
    return updated;
  }

  cancelQueueJob(principal: AuthPrincipal, id: string): QueueJobRecord {
    assertQueueAdmin(principal);
    const job = this.queueJobs.get(id);
    if (!job) throw new NotFoundError("Queue job not found");
    if (job.status === 'cancelled') return job;
    if (job.status === 'in_progress' || job.status === 'completed') throw new ConflictError('Work already started; cancellation cannot undo its side effects');

    const updated: QueueJobRecord = { ...job, status: "cancelled" };
    this.queueJobs.set(id, updated);
    this.retainQueueOperation(updated);
    this.queuePersistence();
    return updated;
  }

  context(principal: AuthPrincipal, body: unknown, sessionId?: string): ContextResponse {
    const raw = asJsonObject(body, "context");
    const query = optionalString(raw.search_query, "search_query") ?? optionalString(raw.query, "query") ?? "";
    const maxMemories = clampLimit(optionalNumber(raw.max_memories, "max_memories"), 8, 50);
    const tokenBudget = clampLimit(optionalNumber(raw.token_budget, "token_budget"), 2000, 128000);
    const workspaceId = optionalString(raw.workspace_id, "workspace_id") ?? "default";
    this.assertWorkspacePermission(principal, workspaceId, "read");
    const searchBody: JsonObject = {
      query,
      workspace_id: workspaceId,
      limit: maxMemories,
      graph: raw.graph ?? { enabled: true, max_hops: 1, max_expansions: 12 },
      diversity: raw.diversity ?? raw.mmr ?? { enabled: true, lambda: 0.8 },
    };
    for (const key of ["scope", "type", "tags", "filters", "filter", "as_of", "agent_filter", "min_confidence", "min_importance"] as const) if (raw[key] !== undefined) searchBody[key] = raw[key];
    if (optionalBoolean(raw.include_sensitive, "include_sensitive") === true) searchBody.include_sensitive = true;
    const requestedSession = sessionId ?? optionalString(raw.session_id, "session_id");
    if (requestedSession) searchBody.session_id = requestedSession;
    const ranked = this.rankedSearch(principal, searchBody);
    const candidates = ranked.results.slice(0, maxMemories).map((result) => ({
      memory: result.memory,
      collection: result.collection,
      score: result.score,
      tokens_used: estimateTokens(result.memory.content),
      ...(result.citation ? { citation: result.citation } : {}),
      ...(result.score_components ? { score_components: result.score_components } : {}),
      ...(result.selection_reason ? { selection_reason: result.selection_reason } : {}),
    }));
    const results: typeof candidates = [];
    const contentLines: string[] = [];
    for (const candidate of candidates) {
      const line = `- [memory:${candidate.memory.id}] ${candidate.memory.content}`;
      if (estimateTokens([...contentLines, line].join('\n')) > tokenBudget) continue;
      results.push(candidate); contentLines.push(line);
    }
    const tokensUsed = contentLines.length ? estimateTokens(contentLines.join('\n')) : 0;
    return {
      memories: results,
      summary: {
        content: results.length === 0 ? (candidates.length ? 'No memories fit the context budget.' : 'No matching memories.') : `${results.length} memories selected for context.`,
        memory_count: results.length,
      },
      representation: {
        query,
        workspace_id: workspaceId,
        session_id: requestedSession ?? null,
      },
      formatted_context: {
        format: "markdown",
        content: contentLines.join("\n"),
      },
      metadata: {
        generated_at: nowIso(),
        token_budget: tokenBudget,
        tokens_used: tokensUsed,
        truncated: results.length < candidates.length,
        retrieval_mode: "lexical_graph_rrf_v1",
        candidate_count: ranked.candidates.length,
        stale_suppressed: Math.max(0, this.memories.size - ranked.candidates.length),
        graph_expansions: ranked.graphExpansions,
      },
    };
  }
}
