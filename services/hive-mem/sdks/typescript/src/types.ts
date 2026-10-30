export type MemoryScope = "private" | "shared";
export type MemoryType = "episodic" | "semantic" | "procedural";
export type WebhookEventType =
  | "memory.created"
  | "session.created"
  | "queue.empty"
  | "summary.updated"
  | "peer_card.updated"
  | "conflict.detected"
  | "webhook.test";

export interface HiveMemOptions {
  baseUrl?: string;
  token?: string;
  workspaceId?: string;
  timeoutMs?: number;
  maxRetries?: number;
  fetchImpl?: typeof fetch;
  requestIdProvider?: () => string;
  authRefresh?: () => string | undefined | Promise<string | undefined>;
  onRequest?: (method: string, url: string, init: RequestInit) => void;
  onResponse?: (response: Response) => void;
}

export interface MemoryRecord {
  id: string;
  agent_id: string;
  content: string;
  type: MemoryType;
  scope: MemoryScope;
  source?: string;
  confidence?: number;
  importance?: number;
  tags?: string[];
  metadata?: Record<string, unknown>;
  workspace_id?: string;
  session_id?: string | null;
  created_at?: string;
  updated_at?: string;
  observed_at?: string | null;
  expires_at?: string | null;
  valid_from?: string | null;
  valid_to?: string | null;
  supersedes?: string | null;
  superseded_by?: string | null;
  superseded_at?: string | null;
  [key: string]: unknown;
}

export interface SearchResponse {
  results: Array<{
    memory: MemoryRecord;
    score: number;
    collection: string;
    is_own: boolean;
    explanation?: {
      vector_score: number;
      importance_boost: number;
      text_match: boolean;
      final_score: number;
    } | null;
    citation?: {
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
    };
    score_components?: Record<string, number | null>;
    selection_reason?: "query" | "relationship" | "entity";
  }>;
  total_searched: number;
  collections_searched: string[];
}

export interface SessionRecord {
  session_id: string;
  owner_agent_id: string;
  scope: MemoryScope;
  title?: string | null;
  workspace_id: string;
  metadata?: Record<string, unknown>;
  created_at: string;
  updated_at: string;
  deleted_at?: string | null;
}

export interface QueueStatusResponse {
  jobs: unknown[];
  total: number;
  pending_count: number;
  in_progress_count: number;
  failed_count: number;
  dead_letter_count: number;
  offset: number;
  limit: number;
}

export interface QueueJobRecord {
  id: string;
  task_type: string;
  status: "pending" | "in_progress" | "completed" | "failed" | "dead_letter" | "cancelled";
  work_unit_key: string;
  payload: Record<string, unknown>;
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
  result: Record<string, unknown> | null;
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
  metadata: Record<string, unknown>;
  created_at: string;
  updated_at: string;
  supersedes: string | null;
  superseded_by: string | null;
  deleted_at: string | null;
}

export interface ConclusionPage {
  results: ConclusionRecord[];
  next_cursor: string | null;
}

export interface WebhookEndpoint {
  id: string;
  owner_agent_id: string;
  workspace_id: string;
  url: string;
  event_types: WebhookEventType[];
  enabled: boolean;
  has_secret: boolean;
  headers: Record<string, string>;
  metadata: Record<string, unknown>;
  created_at: string;
  updated_at: string;
  deleted_at?: string | null;
}

export interface ContextResponse {
  summary?: unknown;
  memories?: MemoryRecord[];
  representation?: unknown;
  formatted_context?: unknown;
  [key: string]: unknown;
}

export interface PeerCardResponse {
  peer_id: string;
  observer_peer_id: string;
  workspace_id: string;
  cards: unknown[];
  generated_at: string;
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
