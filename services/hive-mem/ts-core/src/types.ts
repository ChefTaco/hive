export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };

export type MemoryScope = "private" | "shared";
export type MemoryType = "episodic" | "semantic" | "procedural";
export type MemorySource =
  | "conversation"
  | "research"
  | "observation"
  | "consolidation"
  | "user_feedback"
  | "skill"
  | "system";
export type Sensitivity = "public" | "internal" | "sensitive" | "restricted";
export type RedactionPolicy = "none" | "redact" | "exclude";

export interface AuthPrincipal {
  agentId: string;
  scopes: readonly string[];
  rawClaims: JsonObject;
}

export interface MemoryRelationship {
  target_id: string;
  type: "supports" | "contradicts" | "updates" | "duplicates" | "causes" | "part_of" | "derived_from" | "about_entity";
  confidence: number;
  metadata: JsonObject;
}

export interface MemoryCreate {
  content: string;
  type: MemoryType;
  scope: MemoryScope;
  source?: MemorySource;
  confidence?: number;
  importance?: number;
  tags?: string[];
  metadata?: JsonObject;
  sensitivity?: Sensitivity;
  retention_class?: string;
  redaction_policy?: RedactionPolicy;
  workspace_id?: string;
  session_id?: string | null;
  expires_at?: string | null;
  valid_from?: string | null;
  valid_to?: string | null;
  observed_at?: string | null;
  relationships?: MemoryRelationship[];
  confidence_reason?: string | null;
  supersedes?: string | null;
}

export interface MemoryRecord extends Required<Omit<MemoryCreate, "confidence_reason" | "importance" | "source" | "workspace_id" | "session_id" | "expires_at" | "valid_from" | "valid_to" | "observed_at" | "relationships" | "supersedes">> {
  id: string;
  agent_id: string;
  source: MemorySource;
  confidence: number;
  importance: number;
  workspace_id: string;
  session_id: string | null;
  created_at: string;
  updated_at: string;
  expires_at: string | null;
  valid_from: string | null;
  valid_to: string | null;
  observed_at: string | null;
  relationships: MemoryRelationship[];
  confidence_provenance: JsonObject[];
  supersedes: string | null;
  superseded_by: string | null;
  superseded_at: string | null;
  corroborated_by: string[];
  endorsements: number;
  endorsed_by: string[];
  opposed_by: string[];
  deleted_at: string | null;
  effective_confidence: number | null;
  sanitization_warnings: string[] | null;
}

export interface MemoryUpdate {
  content?: string;
  confidence?: number;
  importance?: number;
  tags?: string[];
  metadata?: JsonObject;
  sensitivity?: Sensitivity;
  retention_class?: string;
  redaction_policy?: RedactionPolicy;
  workspace_id?: string;
  session_id?: string | null;
  expires_at?: string | null;
  valid_from?: string | null;
  valid_to?: string | null;
  observed_at?: string | null;
  relationships?: MemoryRelationship[];
}

export interface SearchRequest {
  offset?: number;
  query?: string;
  scope?: MemoryScope;
  type?: MemoryType;
  tags?: string[];
  workspace_id?: string;
  session_id?: string;
  agent_filter?: string;
  from_self?: boolean;
  min_confidence?: number;
  min_importance?: number;
  limit?: number;
  include_deleted?: boolean;
  include_sensitive?: boolean;
  filters?: SearchFilters;
  as_of?: string;
  graph?: SearchGraphOptions;
  diversity?: SearchDiversityOptions;
}

export interface SearchFilters {
  project_id?: string;
  source_id?: string;
  publisher_ids?: string[];
  scope?: MemoryScope;
  type?: MemoryType;
  tags_all?: string[];
  min_confidence?: number;
  min_importance?: number;
}

export interface SearchGraphOptions {
  enabled: boolean;
  max_hops: 0 | 1;
  max_expansions: number;
  relationship_types?: MemoryRelationship["type"][];
}

export interface SearchDiversityOptions {
  enabled: boolean;
  lambda: number;
}

export interface MemoryCitation {
  memory_id: string;
  publisher: string;
  source_ref: string | null;
  revision: string | null;
  observed_at: string | null;
  valid_from: string | null;
  valid_to: string | null;
  expires_at: string | null;
  freshness: "current" | "live_recheck" | "historical";
  relationship_path: string[];
}

export interface SearchScoreComponents {
  lexical_rank: number | null;
  graph_rank: number | null;
  confidence_rank: number;
  importance_rank: number;
  freshness_rank: number;
  rrf_score: number;
  mmr_score: number;
}

export interface SearchResult {
  memory: MemoryRecord;
  score: number;
  collection: string;
  is_own: boolean;
  citation?: MemoryCitation;
  score_components?: SearchScoreComponents;
  selection_reason?: "query" | "relationship" | "entity";
  explanation?: {
    vector_score: number;
    importance_boost: number;
    text_match: boolean;
    final_score: number;
  } | null;
}

export interface SearchResponse {
  results: SearchResult[];
  total_searched: number;
  collections_searched: string[];
}

export interface BrowseResponse {
  memories: MemoryRecord[];
  results: MemoryRecord[];
  total: number;
  offset: number;
  limit: number;
  next_cursor: string | null;
}

export type MessageRole = "system" | "user" | "assistant" | "tool" | "agent" | "observer";

export interface EpisodeRecord {
  id: string;
  episode_id: string;
  owner_agent_id: string;
  title: string | null;
  workspace_id: string;
  session_id: string | null;
  peer_id: string | null;
  metadata: JsonObject;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
}

export interface MessageRecord {
  id: string;
  episode_id: string;
  message_id: string;
  owner_agent_id: string;
  workspace_id: string;
  session_id: string | null;
  role: MessageRole;
  content: string;
  speaker_id: string | null;
  observed_at: string;
  metadata: JsonObject;
  memory_job_id: string | null;
  memory_id: string | null;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
}

export interface EpisodeMessagesResponse {
  episode: EpisodeRecord;
  messages: MessageRecord[];
}

export interface EmbedResponse {
  embeddings: number[][];
  model: "nomic-embed-text-v1.5";
  dimensions: 768;
}

export interface StatsResponse {
  agents: number;
  memories: number;
  sessions: number;
  workspaces: number;
  queue_jobs: number;
  webhooks: number;
  webhook_deliveries: number;
  conclusions: number;
  episodes: number;
  messages: number;
}

export interface SessionCreate {
  session_id?: string;
  title?: string | null;
  scope?: MemoryScope;
  workspace_id?: string;
  metadata?: JsonObject;
}

export interface SessionRecord {
  session_id: string;
  owner_agent_id: string;
  scope: MemoryScope;
  title: string | null;
  workspace_id: string;
  metadata: JsonObject;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
}

export interface ContextRequest {
  search_query?: string;
  query?: string;
  scope?: MemoryScope;
  type?: MemoryType;
  tags?: string[];
  workspace_id?: string;
  session_id?: string;
  max_memories?: number;
  token_budget?: number;
  include_session_memories?: boolean;
  include_sensitive?: boolean;
  filters?: SearchFilters;
  as_of?: string;
  graph?: SearchGraphOptions;
  diversity?: SearchDiversityOptions;
}

export interface ContextMemory {
  memory: MemoryRecord;
  collection: string;
  score: number | null;
  tokens_used: number;
  citation?: MemoryCitation;
  score_components?: SearchScoreComponents;
  selection_reason?: "query" | "relationship" | "entity";
}

export interface ContextResponse {
  memories: ContextMemory[];
  summary: {
    content: string;
    memory_count: number;
  };
  representation: JsonObject;
  formatted_context: {
    format: "markdown";
    content: string;
  };
  metadata: {
    generated_at: string;
    token_budget: number;
    tokens_used: number;
    truncated: boolean;
    retrieval_mode?: "lexical_graph_rrf_v1";
    candidate_count?: number;
    stale_suppressed?: number;
    graph_expansions?: number;
  };
}

export interface KnowledgeSourceChunk {
  chunk_key: string;
  content: string;
  content_hash: string;
  heading?: string | null;
  tags?: string[];
  entities?: JsonObject[];
}

export interface KnowledgeSourceSyncRequest {
  mode: "preview" | "apply";
  workspace_id: string;
  project_id: string;
  source_id: string;
  source_uri: string;
  revision: string;
  observed_at: string;
  scope?: "shared";
  expires_at?: string | null;
  chunks: KnowledgeSourceChunk[];
}

export interface KnowledgeSourceSyncResponse {
  mode: "preview" | "apply";
  workspace_id: string;
  project_id: string;
  source_id: string;
  revision: string;
  created: number;
  superseded: number;
  retired: number;
  unchanged: number;
  created_ids: string[];
  superseded_ids: string[];
  retired_ids: string[];
}


export type TaskType =
  | "representation"
  | "summary"
  | "consolidation"
  | "dream"
  | "decay_recalc"
  | "conflict_scan"
  | "peer_card"
  | "embedding_reconcile"
  | "webhook_delivery"
  | "message_extract"
  | "sleep"
  | "forgetting_review";

export type JobStatus = "pending" | "in_progress" | "completed" | "failed" | "dead_letter" | "cancelled";

export interface QueueJobRecord {
  id: string;
  task_type: TaskType;
  status: JobStatus;
  work_unit_key: string;
  payload: JsonObject;
  owner_agent_id: string;
  workspace_id: string;
  session_id: string | null;
  peer_id: string | null;
  observer_peer_id: string | null;
  observed_peer_id: string | null;
  idempotency_key: string;
  priority: number;
  retry_count: number;
  created_at: string;
  not_before: string | null;
  started_at: string | null;
  finished_at: string | null;
  locked_at: string | null;
  error: string | null;
  result: JsonObject | null;
}

export type QueueJobSummary = Omit<QueueJobRecord, "payload" | "observer_peer_id" | "observed_peer_id" | "idempotency_key" | "locked_at" | "result">;

export interface WorkerHealth {
  ready: boolean;
  state: 'manual' | 'disabled' | 'stale' | 'degraded' | 'running' | 'idle' | 'starting';
  managed: boolean;
  enabled: boolean;
  running: boolean;
  heartbeat: string | null;
  last_success: string | null;
  error: string | null;
  recovered_on_startup: number;
  pending_jobs: number;
  oldest_pending_seconds: number | null;
}

export interface QueueStatusResponse {
  worker: WorkerHealth;
  jobs: QueueJobSummary[];
  total: number;
  pending_count: number;
  in_progress_count: number;
  failed_count: number;
  dead_letter_count: number;
  offset: number;
  limit: number;
}

export type ConclusionKind = "explicit" | "deductive" | "inductive" | "abductive" | "summary" | "peer_card" | "manual";

export interface ConclusionRecord {
  id: string;
  owner_agent_id: string;
  observer_peer_id: string;
  observed_peer_id: string;
  session_id: string | null;
  workspace_id: string;
  source_memory_ids: string[];
  content: string;
  kind: ConclusionKind;
  confidence: number;
  metadata: JsonObject;
  created_at: string;
  updated_at: string;
  supersedes: string | null;
  superseded_by: string | null;
  deleted_at: string | null;
}

export interface ConclusionSearchResponse {
  results: Array<{ conclusion: ConclusionRecord; score: number }>;
  total_searched: number;
}

export interface RepresentationResponse {
  peer_id: string;
  observer_peer_id: string;
  workspace_id: string;
  session_id: string | null;
  peer_card: ConclusionRecord[];
  conclusions: ConclusionRecord[];
  context: string;
  generated_at: string;
}

export interface PeerCardResponse {
  peer_id: string;
  observer_peer_id: string;
  workspace_id: string;
  cards: ConclusionRecord[];
  generated_at: string;
}

export interface PeerCardReviewResponse {
  peer_id: string;
  observer_peer_id: string;
  workspace_id: string;
  card_count: number;
  active_card_count: number;
  conclusion_count: number;
  latest_card_at: string | null;
  needs_rebuild: boolean;
  notes: string[];
}

export interface AgentInfo {
  agent_id: string;
  display_name: string;
  description: string | null;
  created_at: string;
  updated_at?: string;
  active?: boolean;
  memory_counts: Record<string, number>;
}

export interface AgentRegistered {
  agent_id: string;
  token: string;
  private_collections: string[];
  created_at: string;
}

export interface AgentProfile {
  agent_id: string;
  display_name: string;
  description: string | null;
  total_memories: number;
  shared_memories: number;
  private_memories: number;
  top_tags: Array<{ tag: string; count: number }>;
  memory_types: Record<string, number>;
  sources: Record<string, number>;
  first_memory_at: string | null;
  last_memory_at: string | null;
  avg_confidence: number | null;
}

export interface AgentProfileBundle {
  agent_id: string;
  display_name: string;
  description: string | null;
  default_workspace_id: string;
  default_tags: string[];
  preferred_recall_strategy: string;
  tool_configuration: JsonObject;
  metadata: JsonObject;
  exported_at: string | null;
}

export type ReasoningLevel = "minimal" | "low" | "medium" | "high" | "max";

export interface ChatSourceMemory {
  memory_id: string;
  collection: string;
  content: string;
  score: number;
  confidence: number;
  effective_confidence: number;
  importance: number;
  tags: string[];
  agent_id: string;
  created_at: string;
  is_own: boolean;
}

export interface ChatUsage {
  query_tokens: number;
  answer_tokens: number;
  source_tokens: number;
  total_tokens: number;
}

export interface ChatResponse {
  answer: string;
  reasoning_level: ReasoningLevel;
  sources: ChatSourceMemory[];
  usage: ChatUsage;
  session_id: string | null;
  workspace_id: string;
  requested_at: string;
  processed_at: string;
}

export type WorkspaceRole = "viewer" | "member" | "admin" | "owner";

export interface WorkspaceSanitizationPolicy {
  mode: "warn" | "redact" | "reject" | null;
  detect_pii: boolean | null;
  detect_secrets: boolean | null;
  deny_regexes: string[];
}

export interface WorkspacePolicy {
  retention_days: number | null;
  allowed_scopes: string[];
  reasoning_provider: string | null;
  consolidation_cadence_seconds: number | null;
  webhooks_enabled: boolean;
  sanitization: WorkspaceSanitizationPolicy;
  agent_overrides: Record<string, JsonObject>;
  session_overrides: Record<string, JsonObject>;
}

export interface WorkspaceMember {
  agent_id: string;
  role: WorkspaceRole;
  scopes: string[];
  added_by: string | null;
  created_at: string | null;
  updated_at: string | null;
}

export interface WorkspaceRecord {
  workspace_id: string;
  owner_agent_id: string;
  title: string | null;
  description: string | null;
  metadata: JsonObject;
  policy: WorkspacePolicy;
  members: WorkspaceMember[];
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
}

export interface WorkspaceResolvedSettings {
  workspace_id: string;
  policy: JsonObject;
  source_order: string[];
}

export interface DreamScheduleResponse {
  job_id: string;
  task_type: "dream";
  workspace_id: string;
  peer_id: string;
  observer_peer_id: string;
  session_id: string | null;
  status: JobStatus;
}

export type WebhookEventType =
  | "memory.created"
  | "session.created"
  | "queue.empty"
  | "summary.updated"
  | "peer_card.updated"
  | "conflict.detected"
  | "webhook.test";

export type WebhookDeliveryStatus = "queued" | "delivered" | "failed";

export interface WebhookEndpointRecord {
  id: string;
  owner_agent_id: string;
  workspace_id: string;
  url: string;
  event_types: WebhookEventType[];
  enabled: boolean;
  headers: Record<string, string>;
  has_secret: boolean;
  metadata: JsonObject;
  last_status: WebhookDeliveryStatus | null;
  last_error: string | null;
  last_delivered_at: string | null;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
}

export interface WebhookDeliveryRecord {
  id: string;
  endpoint_id: string;
  owner_agent_id: string;
  workspace_id: string;
  event_id: string;
  event_type: WebhookEventType;
  nonce: string;
  status: WebhookDeliveryStatus;
  attempts: number;
  url: string;
  response_status: number | null;
  error: string | null;
  created_at: string;
  updated_at: string;
  delivered_at: string | null;
}

export interface WebhookDeliveryListResponse {
  deliveries: WebhookDeliveryRecord[];
  total: number;
  offset: number;
  limit: number;
}

export interface WebhookTestEmitResponse {
  event_id: string;
  queued_deliveries: number;
  delivery_ids: string[];
}

export interface GraphNode {
  id: string;
  label: string;
  type: string;
  record_type: "entity" | "memory" | "conclusion";
  metadata: JsonObject;
}

export interface GraphEdge {
  id: string;
  source: string;
  target: string;
  type: string;
  confidence: number;
  valid_from: string | null;
  valid_to: string | null;
  observed_at: string | null;
  superseded_by: string | null;
  metadata: JsonObject;
}

export interface GraphNeighborhoodResponse {
  anchor_id: string | null;
  nodes: GraphNode[];
  edges: GraphEdge[];
}
