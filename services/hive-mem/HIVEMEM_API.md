# HiveMem API Reference

> Standalone reference for agents and agentic coding tools integrating with HiveMem.
> Base URL: use the deployed `HIVEMEM_API_URL`. Development default: `http://localhost:18790`. Production deployments commonly expose HTTPS on `HIVEMEM_WEB_PORT` (for example, `https://hivemem.example.com`).

## Current TypeScript capability boundary (2026-09-07)

The runtime capability matrix served at `GET /v1/capabilities` is the authority
for runtime behavior; some compatibility routes below preserve older API shapes.
Read it before scheduling maintenance. Default retrieval is
deterministic lexical/token-hash, not a loaded neural embedding model. Explicit
`mode: "semantic"` requires a configured shadow index. Unsupported mutations
return 501 rather than synthetic success. Each installation keeps its own content,
signing secrets, storage and model configuration; separate installations never
share them.

## Authentication

Every `/v1` request except unauthenticated health endpoints (`GET /v1/health`, `GET /v1/health/live`, `GET /v1/health/ready`, `GET /v1/health/dependencies`) and token validation at `POST /v1/auth/login` requires a JWT bearer token:

```http
Authorization: Bearer <token>
```

Tokens are HS256 JWTs signed by `HIVEMEM_JWT_SECRET`. Agent tokens are issued by admin-only `POST /v1/agents/register` or `POST /v1/auth/tokens`. Scopes may be encoded as a space-delimited `scope` string or an array-style `scopes` claim. Default agent tokens use an explicit compatibility scope set rather than `*`, and automation can request narrower scopes. Token payload:

```json
{"iss":"hivemem","aud":"hivemem-api","sub":"<agent_id>","role":"agent","scope":"memories:read workspace:default","token_type":"access","iat":1741449600,"exp":1741536000,"jti":"<uuid>"}
```

Admin-only endpoints require the same JWT shape with `"role": "admin"`; narrowly scoped operator tokens may use route-specific scopes such as `admin:queue` where supported. `HIVEMEM_ADMIN_TOKEN` is only a script/deployment convention for carrying an admin JWT; it is not a separate auth scheme. Rotating `HIVEMEM_JWT_SECRET` invalidates every TypeScript-core token.

### Login and Token Validation

```http
POST /v1/auth/login
```

Login accepts an existing JWT token, validates it, and returns principal metadata without changing the token.

Token login request:

```json
{ "token": "eyJ..." }
```

Response:

```json
{
  "token": "eyJ...",
  "token_type": "bearer",
  "expires_at": "2027-05-20T12:00:00Z",
  "agent_id": "admin",
  "role": "admin",
  "scopes": ["*"]
}
```

```http
GET /v1/auth/me
```

Returns the current bearer-token principal:

```json
{ "agent_id": "agent-alpha", "role": "agent", "jti": "uuid", "scopes": ["memories:read", "workspace:default"], "token_type": "access" }
```

### Dashboard Login

`/dashboard` accepts the existing JWT flow (`?token=<jwt>` or pasted token form) for agent and admin JWTs and stores it in the `HttpOnly; Secure; SameSite=Strict` dashboard cookie.

### Token Lifecycle

Agent registration and token issuance also accept optional `expires_at` (a future timestamp) as an absolute upper bound. It can shorten `expires_hours`, including below one hour, and never extends it. Expired/invalid deadlines and workspace claims return 422 before credential rotation mutates token generations.

Tokens require all security claims shown above and have a maximum lifetime of 30 days. Admin-only `POST /v1/auth/tokens` mints agent-role scoped tokens, defaulting to 24 hours when `expires_hours` is omitted.

```http
POST /v1/auth/tokens
GET /v1/auth/tokens
POST /v1/auth/revoke
POST /v1/auth/refresh
```

Workspace policy can override global sanitization defaults with `policy.sanitization` (`mode`, `detect_pii`, `detect_secrets`, `deny_regexes`). Legacy `metadata.sanitization` is still honored.

`POST /v1/auth/tokens` mints a scoped agent token for an administrator-selected agent. Wildcard and `admin:*` scopes are rejected. Useful agent scopes include `memories:read`, `memories:write`, `sessions:read`, `sessions:write`, `agents:read`, `workspaces:read`, `workspaces:write`, `webhooks:read`, `webhooks:write`, and `queue:read`. `POST /v1/auth/refresh` issues a replacement token with the same role/scopes and a new one-hour expiry that never outlives its parent. Refreshed tokens record their ancestors' `jti` values in a `parent_jtis` claim (at most 16 refreshes deep), so revoking a token also revokes every token refreshed from it. `POST /v1/auth/revoke` persists the target token's `jti` until its expiry.

---

## Endpoints

### Current Route Inventory

All REST API router paths below are mounted under `/v1`. Dashboard routes are mounted without the `/v1` prefix.

| Area | Method | Path | Notes |
| --- | --- | --- | --- |
| Root | `GET` | `/` | Redirects to `/dashboard` |
| Health | `GET` | `/v1/health` | Compatibility status; authenticated callers receive operational details |
| Health | `GET` | `/v1/health/live` | Dependency-free liveness |
| Health | `GET` | `/v1/health/ready` | Qdrant + embedding readiness; returns 503 when degraded |
| Health | `GET` | `/v1/health/dependencies` | Dependency report for operator probes |
| Metrics | `GET` | `/metrics` | Prometheus text metrics (admin JWT or metrics token) |
| Stats | `GET` | `/v1/stats` | Collection point counts |
| Auth | `POST` | `/v1/auth/login` | Validate an existing JWT and return principal metadata |
| Auth | `GET` | `/v1/auth/me` | Current bearer-token principal |
| Auth | `POST` | `/v1/auth/tokens` | Mint scoped token |
| Auth | `GET` | `/v1/auth/tokens` | Compatibility token list response |
| Auth | `POST` | `/v1/auth/revoke` | Compatibility revoke success response |
| Auth | `POST` | `/v1/auth/refresh` | Mint a replacement token |
| Memories | `POST` | `/v1/memories` | Create one memory |
| Memories | `POST` | `/v1/memories/batch` | Create 1-100 memories |
| Memories | `GET` | `/v1/memories/{memory_id}` | Fetch accessible memory |
| Memories | `GET` | `/v1/memories/{memory_id}/diff` | Inspect supersession diff |
| Memories | `GET` | `/v1/memories/{memory_id}/graph` | Inspect explicit relationship graph for one memory |
| Memories | `PUT` | `/v1/memories/{memory_id}` | Owner update |
| Memories | `DELETE` | `/v1/memories/{memory_id}` | Owner soft delete |
| Memories | `POST` | `/v1/memories/{memory_id}/endorse` | Up/down vote accessible memory |
| Search | `POST` | `/v1/memories/search` | Deterministic lexical/graph RRF search |
| Search | `POST` | `/v1/memories/search/explain` | Operator search diagnostics |
| Search | `GET` | `/v1/memories/browse` | Non-vector browse with filters and cursor pagination |
| Search | `POST` | `/v1/memories/search/text` | Full-text search |
| Search | `POST` | `/v1/memories/search/hybrid` | Vector + text search |
| Search | `GET` | `/v1/memories/{memory_id}/related` | Similar/related memories |
| Search | `POST` | `/v1/memories/conflicts` | Find likely cross-agent conflicts |
| Knowledge | `POST` | `/v1/knowledge/sources/sync` | Preview/apply revision-aware source chunks |
| Sessions | `POST` | `/v1/sessions` | Create or return existing session metadata |
| Sessions | `GET` | `/v1/sessions` | List readable sessions |
| Sessions | `GET` | `/v1/sessions/{session_id}` | Fetch session metadata |
| Sessions | `PUT` | `/v1/sessions/{session_id}` | Owner update |
| Sessions | `DELETE` | `/v1/sessions/{session_id}` | Owner soft delete |
| Sessions | `GET` | `/v1/sessions/{session_id}/memories` | Browse memories attached to a session |
| Episodes | `POST` | `/v1/episodes` | Create chronological ingest episode |
| Episodes | `GET` | `/v1/episodes` | List episodes |
| Episodes | `GET` | `/v1/episodes/{episode_id}` | Fetch episode plus messages |
| Episodes | `POST` | `/v1/episodes/{episode_id}/messages` | Append raw message; may enqueue extraction |
| Context | `POST` | `/v1/context` | Prompt-ready memory context |
| Context | `POST` | `/v1/sessions/{session_id}/context` | Session-scoped context |
| Chat | `POST` | `/v1/chat` | Deterministic memory-grounded answer |
| Chat | `POST` | `/v1/sessions/{session_id}/chat` | Session-scoped memory-grounded answer |
| Workspaces | `POST` | `/v1/workspaces` | Create workspace metadata |
| Workspaces | `GET` | `/v1/workspaces` | List readable workspaces |
| Workspaces | `GET` | `/v1/workspaces/{workspace_id}` | Fetch workspace metadata |
| Workspaces | `PUT` | `/v1/workspaces/{workspace_id}` | Owner/admin update |
| Workspaces | `DELETE` | `/v1/workspaces/{workspace_id}` | Owner/admin soft delete |
| Workspaces | `GET` | `/v1/workspaces/{workspace_id}/members` | List members |
| Workspaces | `PUT` | `/v1/workspaces/{workspace_id}/members/{agent_id}` | Upsert member |
| Workspaces | `DELETE` | `/v1/workspaces/{workspace_id}/members/{agent_id}` | Remove member |
| Workspaces | `GET` | `/v1/workspaces/{workspace_id}/settings` | Resolved policy cascade |
| Workspaces | `POST` | `/v1/workspaces/{workspace_id}/schedule-dream` | Queue workspace dream consolidation |
| Admin | `GET` | `/v1/admin/audit` | Query append-only write audit log |
| Admin | `POST` | `/v1/backup` | Unavailable (501); use root host-bound backup |
| Admin | `POST` | `/v1/restore` | Unavailable (501); use isolated root recovery |
| Admin | `GET` | `/v1/admin/workspaces/{workspace_id}/export` | Export portable workspace bundle |
| Admin | `POST` | `/v1/admin/workspaces/{workspace_id}/import` | Unavailable (501) |
| Admin | `POST` | `/v1/admin/workspaces/{workspace_id}/prune` | Workspace-scoped soft-delete dry-run/apply |
| Admin | `POST` | `/v1/admin/test-data/cleanup` | Unavailable (501) |
| Admin | `POST` | `/v1/admin/prune` | Unavailable (501); use workspace retention/purge |
| Conclusions | `POST` | `/v1/peers/{peer_id}/conclusions` | Create derived conclusion |
| Conclusions | `GET` | `/v1/peers/{peer_id}/conclusions` | List conclusions |
| Conclusions | `POST` | `/v1/peers/{peer_id}/conclusions/query` | Vector query conclusions |
| Conclusions | `GET` | `/v1/conclusions/{conclusion_id}` | Fetch one owned conclusion (`include_history`) |
| Conclusions | `DELETE` | `/v1/conclusions/{conclusion_id}` | Owner/admin soft delete |
| Conclusions | `GET` | `/v1/peers/{peer_id}/representation` | Peer representation |
| Conclusions | `GET` | `/v1/peers/{peer_id}/context` | Peer context alias |
| Peer Cards | `GET` | `/v1/peers/{peer_id}/card` | List peer-card conclusions |
| Peer Cards | `POST` | `/v1/peers/{peer_id}/card` | Create peer-card conclusion |
| Peer Cards | `PUT` | `/v1/peers/{peer_id}/card/{card_id}` | Replace peer card |
| Peer Cards | `DELETE` | `/v1/peers/{peer_id}/card/{card_id}` | Delete peer card |
| Peer Cards | `POST` | `/v1/peers/{peer_id}/card/rebuild` | Queue card rebuild/dream |
| Peer Cards | `POST` | `/v1/peers/{peer_id}/card/review` | Review active/stale card state |
| Reasoning | `POST` | `/v1/reasoning/providers/compare` | Compare configured reasoning providers |
| Reasoning | `POST` | `/v1/peers/{peer_id}/dream` | Queue peer dream consolidation |
| Lifecycle | `POST` | `/v1/lifecycle/retention/apply` | Retention dry-run/apply |
| Lifecycle | `POST` | `/v1/lifecycle/forget-me` | Subject deletion/anonymization dry-run/apply |
| Lifecycle | `POST` | `/v1/archive/search` | Search archived records |
| Lifecycle | `POST` | `/v1/memories/compactions` | Store compaction provenance |
| Lifecycle | `POST` | `/v1/memories/negotiations` | Store negotiation proposal |
| Lifecycle | `POST` | `/v1/memories/multimodal` | Attach multimodal reference |
| Lifecycle | `POST` | `/v1/memories/critic/review` | Deterministic critic review |
| Queue | `GET` | `/v1/queue/status` | Queue status and filtered job summaries |
| Queue | `GET` | `/v1/queue/jobs/{job_id}` | Fetch full job |
| Queue | `GET` | `/v1/queue/operations/{operation_id}` | Fetch the job for an idempotent operation receipt |
| Queue | `POST` | `/v1/queue/jobs/{job_id}/retry` | Admin retry |
| Queue | `DELETE` | `/v1/queue/jobs/{job_id}` | Admin cancel |
| Webhooks | `POST` | `/v1/webhooks` | Create endpoint |
| Webhooks | `GET` | `/v1/webhooks` | List endpoints |
| Webhooks | `GET` | `/v1/webhooks/{endpoint_id}` | Fetch endpoint |
| Webhooks | `PUT` | `/v1/webhooks/{endpoint_id}` | Update endpoint |
| Webhooks | `DELETE` | `/v1/webhooks/{endpoint_id}` | Soft delete endpoint |
| Webhooks | `POST` | `/v1/webhooks/test` | Emit test event |
| Webhooks | `GET` | `/v1/webhooks/deliveries` | List deliveries |
| Webhooks | `GET` | `/v1/webhooks/deliveries/{delivery_id}` | Fetch delivery |
| Agents | `POST` | `/v1/agents/register` | Admin register agent |
| Agents | `GET` | `/v1/agents` | List agents |
| Agents | `GET` | `/v1/agents/{agent_id}` | Agent metadata |
| Agents | `GET` | `/v1/agents/{agent_id}/profile` | Knowledge profile |
| Agents | `GET` | `/v1/agents/{agent_id}/bundle` | Export profile bundle |
| Agents | `POST` | `/v1/agents/{agent_id}/bundle` | Import/upsert profile bundle |
| Embedding | `POST` | `/v1/embed` | Embed text without storing |
| Dashboard | `GET` | `/dashboard` | HTML dashboard |
| Dashboard | `GET` | `/dashboard/memories/{memory_id}` | Memory deep-link page |
| Dashboard | `POST` | `/dashboard/login` | Cookie login |
| Dashboard API | `GET` | `/dashboard/api/memory-options` | UI option metadata |
| Dashboard API | `POST` | `/dashboard/api/memories` | Dashboard memory create proxy |
| Dashboard API | `GET` | `/dashboard/api/memories/{memory_id}` | Dashboard memory fetch proxy |
| Dashboard API | `GET` | `/dashboard/api/memories/{memory_id}/detail` | Memory detail package |
| Dashboard API | `PUT` | `/dashboard/api/memories/{memory_id}` | Dashboard memory update proxy |
| Dashboard API | `DELETE` | `/dashboard/api/memories/{memory_id}` | Dashboard memory delete proxy |
| Dashboard API | `GET` | `/dashboard/api/agents/{agent_id}/memories` | Agent memory page data |
| Dashboard API | `GET` | `/dashboard/api/sessions` | Session list |
| Dashboard API | `GET` | `/dashboard/api/sessions/{session_id}/memories` | Session memory page data |
| Dashboard API | `GET` | `/dashboard/api/queue/status` | Queue snapshot |
| Dashboard API | `GET` | `/dashboard/api/queue/jobs/{job_id}` | Queue job detail |
| Dashboard API | `GET` | `/dashboard/api/queue/jobs/{job_id}/runbook` | Queue job runbook |
| Dashboard API | `POST` | `/dashboard/api/queue/jobs/{job_id}/retry` | Queue retry proxy |
| Dashboard API | `DELETE` | `/dashboard/api/queue/jobs/{job_id}` | Queue cancel proxy |
| Dashboard API | `GET` | `/dashboard/api/command-palette` | Dashboard command metadata |
| Dashboard API | `GET` | `/dashboard/api/conflicts` | Conflict inbox |
| Dashboard API | `POST` | `/dashboard/api/conflicts/{memory_id}/resolve` | Conflict resolution |
| Dashboard API | `POST` | `/dashboard/api/context/preview` | Context preview |
| Dashboard API | `POST` | `/dashboard/api/lifecycle/retention/apply` | Retention apply proxy |
| Dashboard API | `POST` | `/dashboard/api/lifecycle/forget-me` | Forget-me proxy |
| Dashboard API | `POST` | `/dashboard/api/archive/search` | Archive search proxy |
| Dashboard API | `POST` | `/dashboard/api/memories/compactions` | Compaction proxy |
| Dashboard API | `POST` | `/dashboard/api/memories/negotiations` | Negotiation proxy |
| Dashboard API | `POST` | `/dashboard/api/memories/multimodal` | Multimodal proxy |
| Dashboard API | `POST` | `/dashboard/api/memories/critic/review` | Critic review proxy |
| Dashboard API | `GET` | `/dashboard/api/consolidation/status` | Consolidation status |
| Dashboard API | `GET` | `/dashboard/api/consolidation/logs` | Consolidation run list |
| Dashboard API | `GET` | `/dashboard/api/consolidation/logs/{run_id}` | Consolidation run detail |
| Dashboard API | `GET` | `/dashboard/api/peers/{peer_id}/conclusions` | Peer conclusions proxy |
| Dashboard API | `GET` | `/dashboard/api/peers/{peer_id}/representation` | Peer representation proxy |
| Dashboard API | `POST` | `/dashboard/api/peers/{peer_id}/dream` | Peer dream proxy |
| Dashboard API | `POST` | `/dashboard/api/reasoning/providers/compare` | Reasoning compare proxy |
| Dashboard API | `POST` | `/dashboard/api/search/explain` | Search explain proxy |
| Dashboard API | `GET` | `/dashboard/api/graph/neighborhood` | Graph neighborhood proxy |
| Dashboard API | `GET` | `/dashboard/api/webhooks` | Webhook list proxy |
| Dashboard API | `POST` | `/dashboard/api/webhooks` | Webhook create proxy |
| Dashboard API | `POST` | `/dashboard/api/webhooks/test` | Webhook test proxy |
| Dashboard API | `GET` | `/dashboard/api/webhooks/deliveries` | Webhook delivery list proxy |

### Store a Memory

```http
POST /v1/memories
```

Store a new memory. The server embeds the text automatically — no local embedding model required.

**Request body:**

| Field | Type | Required | Default | Description |
| --- | --- | --- | --- | --- |
| `content` | string | **yes** | — | Memory text (1–50,000 chars) |
| `type` | string | **yes** | — | `"episodic"`, `"semantic"`, or `"procedural"` |
| `scope` | string | **yes** | — | `"private"` (only you) or `"shared"` (all agents) |
| `source` | string | no | `"conversation"` | Origin: `conversation`, `research`, `observation`, `consolidation`, `user_feedback`, `skill`, `system` |
| `confidence` | float | no | `0.8` | Confidence score 0.0–1.0 |
| `importance` | float | no | auto-computed | Importance score 0.0–1.0 |
| `tags` | string[] | no | `[]` | Categorization tags (max 20, each max 64 chars) |
| `metadata` | object | no | `{}` | Caller-defined metadata retained as evidence; only documented exact search filters are queryable |
| `sensitivity` | string | no | `internal` | `public`, `internal`, `sensitive`, or `restricted` |
| `retention_class` | string | no | `standard` | Operator-defined retention label for policy/prune workflows |
| `redaction_policy` | string | no | `none` | `none`, `redact`, or `exclude`; search/context exclude `exclude` unless sensitive access is requested and authorized |
| `workspace_id` | string | no | `default` | Workspace/namespace id. Option A isolation keeps collections global and filters by this field. |
| `session_id` | string | no | `null` | Optional memory session identifier for grouping related memories |
| `expires_at` | datetime | no | `null` | ISO 8601 expiration timestamp |
| `valid_from` / `valid_to` | datetime | no | `null` | Valid-time window for facts or procedures |
| `observed_at` | datetime | no | `null` | When HiveMem or the source observed this memory |
| `relationships` | object[] | no | `[]` | Links to other memories/entities using `supports`, `contradicts`, `updates`, `duplicates`, `causes`, `part_of`, `derived_from`, or `about_entity` |
| `confidence_reason` | string | no | `null` | Reason stored with the initial confidence provenance event |
| `supersedes` | string | no | `null` | UUID of memory this replaces |
| `embedding` | float[] | no | auto-computed | 768-dim vector (for backward compat; omit to let server embed) |

**Example:**

```bash
curl -X POST "$HIVEMEM_API_URL/v1/memories" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "content": "The lab equipment needs recalibration after the power outage.",
    "type": "episodic",
    "scope": "shared",
    "tags": ["lab", "maintenance"],
    "workspace_id": "default",
    "session_id": "incident-42",
    "confidence": 0.9
  }'
```

**Response (201):**

```json
{
  "id": "a1b2c3d4-...",
  "agent_id": "agent-alpha",
  "content": "The lab equipment needs recalibration after the power outage.",
  "type": "episodic",
  "scope": "shared",
  "source": "conversation",
  "confidence": 0.9,
  "importance": 0.72,
  "tags": ["lab", "maintenance"],
  "metadata": {},
  "sensitivity": "internal",
  "retention_class": "standard",
  "redaction_policy": "none",
  "workspace_id": "default",
  "session_id": "incident-42",
  "created_at": "2026-03-15T10:30:00Z",
  "updated_at": "2026-03-15T10:30:00Z",
  "valid_from": null,
  "valid_to": null,
  "observed_at": null,
  "relationships": [],
  "confidence_provenance": [
    {"at": "2026-03-15T10:30:00Z", "actor_agent_id": "agent-alpha", "old_confidence": null, "new_confidence": 0.9, "reason": "initial_create", "source": "api"}
  ],
  "corroborated_by": [],
  "endorsements": 0,
  "endorsed_by": [],
  "opposed_by": [],
  "effective_confidence": 0.9
}
```

**Create deduplication:** If a near-duplicate exists in the target collection (cosine >= 0.95):

- Same agent → idempotent, returns existing memory
- Different agent → new memory is stored; the existing memory's `corroborated_by` gets the new agent id and its `updated_at` is refreshed

The same deduplication behavior is applied item-by-item for `POST /v1/memories/batch`. Batch-created memories that reference `supersedes` also update the referenced memory's `superseded_by` field when the referenced memory is accessible. Use `GET /v1/memories/{id}/diff` to inspect old/new supersession changes and `GET /v1/memories/{id}/graph` to inspect explicit relationship edges around a memory.

---

### Episodes And Messages

```http
POST /v1/episodes
GET /v1/episodes
GET /v1/episodes/{episode_id}
POST /v1/episodes/{episode_id}/messages
```

Episodes are optional chronological ingest primitives for clients that want to preserve raw message order before extracting memories. Appending a message stores the raw record in `_episodes`; when `produce_memory=true` (default), HiveMem enqueues a `message_extract` job that creates an ordinary private memory and links it back to the message.

Message bodies accept `role`, `content`, optional `speaker_id`, `observed_at`, metadata, and `memory_type` (`episodic`, `semantic`, or `procedural`).

---

### Search Memories

```http
POST /v1/memories/search
```

Deterministic local retrieval shared with the context API. The default path ranks lexical coverage, one-hop graph proximity, effective confidence, importance, and freshness with `lexical_graph_rrf_v1`. It does not require an embedding endpoint. `POST /v1/memories/search/explain` and `?explain=true` preserve the legacy explanation field for compatible clients.

**Request body:**

| Field | Type | Required | Default | Description |
| --- | --- | --- | --- | --- |
| `query` | string | * | — | Natural language search query |
| `scope` | string | no | both | `"private"` or `"shared"` |
| `type` | string | no | both | `"episodic"`, `"semantic"`, or `"procedural"` |
| `agent_filter` | string | no | — | Filter by origin agent_id |
| `from_self` | bool | no | — | `true`=own only, `false`=others only |
| `tags` | string[] | no | — | Filter by tags (OR logic) |
| `workspace_id` | string | no | `default` | Filter to a workspace. Send `null` or `"*"` to search all readable workspaces. |
| `session_id` | string | no | — | Filter to memories associated with a session |
| `filters` | object | no | — | Exact allowlisted structured filters; see below |
| `as_of` | datetime | no | — | Return memories whose valid-time window includes this timestamp |
| `min_confidence` | float | no | — | Minimum confidence threshold |
| `min_importance` | float | no | — | Minimum importance threshold |
| `limit` | int | no | `10` | Max results (1–100) |
| `include_deleted` | bool | no | `false` | Include soft-deleted memories |
| `include_sensitive` | bool | no | `false` | Include sensitive/restricted/excluded memories only when token has `memories:sensitive` |
| `graph` | object | no | disabled | `{enabled,max_hops,max_expansions,relationship_types}`; maximum one hop and 12 additions |
| `diversity` | object/bool | no | disabled | Deterministic token-Jaccard MMR; use `{ "enabled": true, "lambda": 0.8 }` |

Search results add `citation`, `score_components`, and `selection_reason` without removing legacy fields. Citations contain the retained memory ID, publisher, source reference, revision, validity dates, freshness state, and relationship path.

**Example:**

```bash
curl -X POST "$HIVEMEM_API_URL/v1/memories/search" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "query": "lab equipment calibration",
    "scope": "shared",
    "limit": 5
  }'
```

**Response (200):**

```json
{
  "results": [
    {
      "memory": { "id": "...", "content": "...", "type": "episodic", ... },
      "score": 0.8742,
      "collection": "shared_episodic",
      "is_own": false
    }
  ],
  "total_searched": 42,
  "collections_searched": ["shared_episodic", "shared_semantic", "shared_procedural"]
}
```

#### Structured Search Filters

`filters` (the `filter` alias is accepted for compatibility) permits only `project_id`, `source_id`, `publisher_ids`, `scope`, `type`, `tags_all`, `min_confidence`, and `min_importance`. Arbitrary metadata paths and logical-expression DSLs are intentionally unsupported and return `400`. All graph-expanded records are independently rechecked against these filters, workspace claims, visibility, sensitivity, and temporal validity.

`as_of` performs historical retrieval. Current recall suppresses deleted, expired, invalid, and superseded records. Legacy superseded records without `superseded_at` use `updated_at` as an approximate boundary.

---

### Synchronize Project Knowledge Sources

```http
POST /v1/knowledge/sources/sync
```

This operator-facing endpoint uses the existing workspace-scoped `memories:write` permission. It accepts `mode` (`preview` or `apply`), `workspace_id`, `project_id`, stable `source_id` and `source_uri`, `revision`, `observed_at`, optional `expires_at`, and up to 500 pre-chunked records. A chunk contains a stable `chunk_key`, verified SHA-256 `content_hash`, content, optional heading/tags, and optional bounded entities.

Identity is `(workspace_id, project_id, source_id, chunk_key)`. An unchanged hash is a no-op, a changed hash creates a successor and supersedes the previous chunk, and an omitted key closes the old chunk's validity at `observed_at`. An empty `chunks` array retires the whole selected source. Derived records that cite changed or removed chunks are invalidated through the existing dependency lifecycle. A publisher cannot take over another publisher's current source.

Preview performs all validation and calculates the exact create/supersede/retire counts without mutating state. Apply requests are fully parsed and hash-checked before the first write. The repository CLI is preview-first:

```bash
python3 services/hive-mem/scripts/sync_project_knowledge.py \
  --root /path/to/repository \
  --include 'docs/**/*.md' \
  --project-id example-project \
  --source-id repo:example/docs \
  --source-uri repo://example/docs \
  --revision "$(git -C /path/to/repository rev-parse HEAD)" \
  --workspace-id team:example \
  --api-url "$HERMES_HIVEMEM_API_URL"
```

Add `--apply` only after reviewing the preview. The CLI rejects symlinks, paths outside the selected root, unsupported/binary files, and detected credential material. It uses an explicitly selected existing token environment variable and creates no credential.

---

### Get Memory by ID

```http
GET /v1/memories/{memory_id}
```

| Param | Description |
| --- | --- |
| `include_history` | Query param. If `true`, also returns superseded or retired (`valid_to` in the past) versions. Default: `false`. |

**Response (200):** Full `MemoryRecord` JSON.

Returns `404` if the memory doesn't exist, is soft-deleted, has passed its `expires_at`, is not current (unless `include_history=true`), or belongs to another agent's private collection. Soft-deleted and expired memories are never returned, even with `include_history=true`.

---

### Update Memory

```http
PUT /v1/memories/{memory_id}
```

Only the memory owner can update. All fields optional — only provided fields are changed. If `content` is updated, the server re-embeds automatically.

**Request body:**

| Field | Type | Description |
| --- | --- | --- |
| `content` | string | New content text |
| `embedding` | float[] | Explicit 768-dim vector (optional; server re-embeds if omitted) |
| `confidence` | float | New confidence 0.0–1.0 |
| `importance` | float | New importance 0.0–1.0 |
| `tags` | string[] | New tags |
| `metadata` | object | Replace metadata |
| `workspace_id` | string | Move the memory to a workspace |
| `session_id` | string | Move or attach the memory to a session |
| `expires_at` | datetime | New expiration |
| `sensitivity` | string | New sensitivity label |
| `retention_class` | string | New retention label |
| `redaction_policy` | string | New redaction policy |
| `valid_from` / `valid_to` | datetime | New valid-time window |
| `observed_at` | datetime | New observation timestamp |
| `relationships` | object[] | Replace explicit relationship edges |
| `confidence_reason` | string | Reason stored with the confidence provenance event |

**Response (200):** Updated `MemoryRecord`.

Returns `403` if not the owner.
The update schema does not currently expose `type`, `scope`, `source`, `supersedes`, or `deleted_at`; use promote/privatize for scope moves.

---

### Delete Memory (Soft)

```http
DELETE /v1/memories/{memory_id}
```

Soft-deletes by setting `deleted_at`. Only the owner can delete.

**Response:** `204 No Content`
Returns `403` if not the owner.

---

### Browse Memories

```http
GET /v1/memories/browse
POST /v1/memories/search/text
POST /v1/memories/search/hybrid
GET /v1/memories/{memory_id}/related
POST /v1/memories/conflicts
```

Paginated browsing with filters (no semantic search).

| Query Param | Type | Default | Description |
| --- | --- | --- | --- |
| `scope` | string | both | `"private"` or `"shared"` |
| `type` | string | both | `"episodic"`, `"semantic"`, or `"procedural"` |
| `agent_id` | string | — | Filter by origin agent |
| `tags` | string[] | — | Filter by tags |
| `workspace_id` | string | `default` | Filter to a workspace; use `*` for all readable workspaces |
| `session_id` | string | — | Filter to memories associated with a session |
| `filter` | JSON string | — | Structured filter DSL expression |
| `date_from` | datetime | — | Lower bound |
| `date_to` | datetime | — | Upper bound |
| `as_of` | datetime | — | Valid-time lookup timestamp |
| `offset` | int | `0` | Pagination offset |
| `limit` | int | `20` | Results per page (1–100) |
| `sort_by` | string | `created_at` | Sort field: `created_at`, `updated_at`, or `confidence` |
| `sort_order` | string | `desc` | Sort order: `asc` or `desc` |
| `cursor` | string | — | Opaque cursor from prior response; when present, keyset pagination is used instead of offset |
| `include_sensitive` | bool | `false` | Include `sensitive`/`restricted`/`exclude` memories only when the token has `memories:sensitive` |
| `use_mmr` | bool | `false` | Apply diversity reranking to browsed records |
| `mmr_lambda` | float | `0.7` | Relevance/diversity tradeoff |
| `diversity_by` | string | `content` | Diversity basis: `content`, `agent`, or `tags` |

Browse supports `scope`, `type`, `workspace_id`, `session_id`, `offset`, and `limit`, sorted by most recently updated. Current-source filtering applies by default; explicit deleted-record inspection is admin-only. Cursor/MMR/structured temporal filtering is not implemented.

**Response (200):**

```json
{
  "results": [{ "id": "...", "content": "...", "type": "episodic" }],
  "total": 1,
  "offset": 0,
  "limit": 20,
  "next_cursor": null
}
```

`POST /v1/memories/search/text` and `/search/hybrid` are compatibility aliases for the same deterministic pipeline. Semantic-shadow retrieval is used only when the request explicitly sets `mode: "semantic"` and the optional embedding endpoint and shadow collection are configured; otherwise it is unavailable and is not a deployment dependency.

`GET /v1/memories/{memory_id}/related` searches accessible collections with the source memory vector and returns `{ "source_id": "...", "related": [...] }`; each related item includes `memory`, `similarity`, `collection`, and a relationship label: `near_duplicate`, `corroboration`, `same_topic`, `cross_type`, or `semantically_similar`.

`POST /v1/memories/conflicts` accepts `content`, optional `scope`, `type`, and `workspace_id`, embeds the content, and returns memories from other agents above `HIVEMEM_CONFLICT_SIMILARITY_THRESHOLD`.

---

### Graph Memory

Graph memory is derived from memory and conclusion content into `_entities` and `_relations`. It is read-oriented through REST; normal memory/conclusion writes maintain graph indexes.

```http
GET /v1/graph/entities
GET /v1/graph/relations
GET /v1/graph/entities/{entity_id}
GET /v1/graph/neighborhood
GET /v1/memories/{memory_id}/graph
```

`GET /v1/graph/entities` accepts `workspace_id`, optional entity `type`, and `limit`. Entity types are `person`, `agent`, `project`, `file`, `service`, `incident`, `decision`, and `topic`.

`GET /v1/graph/relations` accepts `workspace_id`, optional `entity_id`, optional valid-time `as_of`, and `limit`. Relation records include source/target entity ids, relation `type`, optional `memory_id` or `conclusion_id`, valid-time fields, confidence, and metadata.

`GET /v1/graph/entities/{entity_id}` returns an entity page with the entity record, linked memories, linked conclusions, and relations.

`GET /v1/graph/neighborhood` accepts either `entity_id` or `memory_id`, plus `workspace_id` and `limit`, and returns graph `nodes`/`edges` suitable for dashboard visualization.

`GET /v1/memories/{memory_id}/graph` returns explicit relationship edges stored directly on a memory record, separate from the entity/relation graph index.

---

### Memory Sessions

Sessions are lightweight, memory-based containers for grouping related memories. HiveMem does **not** store ordered messages or chat turns; attach memories to a session by setting `session_id` on `POST /v1/memories`, `POST /v1/memories/batch`, or `PUT /v1/memories/{id}`.

Session visibility is independent of memory visibility:

- `shared` sessions can be read by any agent.
- `private` sessions can only be read by the owner agent.
- Deleting a session soft-deletes the session metadata only; associated memories keep their `session_id` for auditability.

#### Create Session

```http
POST /v1/sessions
```

Creates a session or returns the existing exact session for the requested `scope`/owner and `session_id`.

| Field | Type | Required | Default | Description |
| --- | --- | --- | --- | --- |
| `session_id` | string | no | generated UUID | Caller-provided identifier, max 128 chars |
| `title` | string | no | `null` | Human-readable title, max 160 chars |
| `scope` | string | no | `private` | `private` or `shared` |
| `workspace_id` | string | no | `default` | Optional namespace/project id |
| `metadata` | object | no | `{}` | Caller-defined structured metadata |

```json
{
  "session_id": "incident-42",
  "title": "Incident 42",
  "scope": "shared",
  "workspace_id": "default",
  "metadata": { "severity": "high" }
}
```

**Response (201 or 200):** `SessionRecord`

```json
{
  "session_id": "incident-42",
  "owner_agent_id": "agent-alpha",
  "scope": "shared",
  "title": "Incident 42",
  "workspace_id": "default",
  "metadata": { "severity": "high" },
  "created_at": "2026-05-17T12:00:00Z",
  "updated_at": "2026-05-17T12:00:00Z",
  "deleted_at": null
}
```

#### List Sessions

```http
GET /v1/sessions
```

Query params: `scope`, `workspace_id`, `include_deleted`, `offset`, `limit`. Returns readable sessions sorted by `updated_at` descending.

#### Get, Update, and Delete Session

```http
GET /v1/sessions/{session_id}
PUT /v1/sessions/{session_id}
DELETE /v1/sessions/{session_id}
```

- `GET` returns the caller's private session first when both a private and shared session have the same `session_id`.
- `PUT` is owner-only and accepts `title`, `workspace_id`, and `metadata`.
- `DELETE` is owner-only and soft-deletes the session metadata.

#### Browse Session Memories

```http
GET /v1/sessions/{session_id}/memories
```

Returns a `BrowseResponse` for accessible memories whose payload has the given `session_id`. Query params: `scope`, `type`, `tags`, `workspace_id`, `filter`, `date_from`, `date_to`, `include_deleted`, `offset`, `limit`, and `cursor`.

---

### Context

Context endpoints return prompt-ready memory packages with token budgeting. Tooling wrappers should call `/v1/context` when no session id is supplied and `/v1/sessions/{session_id}/context` when one is supplied.

```http
POST /v1/context
POST /v1/sessions/{session_id}/context
```

The TypeScript service accepts `search_query` (or `query`), `scope`, `type`, `tags`, `workspace_id`, `session_id`, `max_memories`, `token_budget`, `min_confidence`, `min_importance`, `filters`, `as_of`, `graph`, `diversity`, and `include_sensitive`. It uses the same retrieval engine as `/v1/memories/search`; context defaults to one-hop graph expansion and MMR lambda `0.8` before enforcing the token budget.

Responses preserve the existing summary, representation, memories, formatted-context, and metadata fields. Each selected memory may include its citation and score components. Server-formatted lines begin with stable `[memory:<uuid>]` markers. Metadata identifies `lexical_graph_rrf_v1`, candidate count, graph expansion count, token use, and truncation.

---

### Chat

Chat endpoints synthesize deterministic, source-cited answers from normal memories. They do not create message records or call an LLM provider; future reasoning layers can replace the synthesizer while keeping this contract.

```http
POST /v1/chat
POST /v1/sessions/{session_id}/chat
```

| Field | Type | Required | Default | Description |
| --- | --- | --- | --- | --- |
| `query` | string | yes | — | Natural-language question |
| `query_embedding` | float[] | no | auto-computed | Optional 768-dim query vector |
| `reasoning_level` | string | no | `medium` | `minimal`, `low`, `medium`, `high`, `max` |
| `stream` | bool | no | `false` | If `true`, returns Server-Sent Events |
| `max_sources` | int | no | `5` | Max cited memories, 1–50 |
| `include_citations` | bool | no | `true` | Include source memory snippets |
| `workspace_id` | string | no | `default` or session workspace | Workspace filter |
| `scope`, `type`, `tags`, `date_from`, `date_to`, `min_confidence`, `filter` | mixed | no | — | Memory search filters |

Non-streaming responses include `answer`, `sources`, `usage`, `session_id`, `workspace_id`, `requested_at`, and `processed_at`. Streaming responses emit `message_start`, `answer_chunk`, optional `source`, and `done` events.

---

### Workspaces

Workspace isolation uses **Option A**: memory collections stay global and each memory stores an indexed `workspace_id`. New memory/search/chat requests default to `workspace_id="default"`; send `workspace_id="*"` or `null` on search-style requests to query all readable workspaces.

```http
POST /v1/workspaces
GET /v1/workspaces
GET /v1/workspaces/{workspace_id}
PUT /v1/workspaces/{workspace_id}
DELETE /v1/workspaces/{workspace_id}
GET /v1/workspaces/{workspace_id}/members
PUT /v1/workspaces/{workspace_id}/members/{agent_id}
DELETE /v1/workspaces/{workspace_id}/members/{agent_id}
GET /v1/workspaces/{workspace_id}/settings
POST /v1/workspaces/{workspace_id}/schedule-dream
```

Workspace metadata fields: `workspace_id`, `owner_agent_id`, `title`, `description`, `metadata`, `policy`, `members`, `created_at`, `updated_at`, and `deleted_at`. Membership roles are `viewer`, `member`, `admin`, and `owner`. Workspace read/write/admin checks are enforced for workspace-aware memory, search, context, session, webhook, and dream routes when a workspace metadata record exists; missing workspace records remain allowed for legacy ad-hoc namespaces.

`policy` stores workspace-level `retention_days`, `allowed_scopes`, `reasoning_provider`, `consolidation_cadence_seconds`, `webhooks_enabled`, `sanitization`, and optional `agent_overrides` / `session_overrides`. `GET /settings` returns the effective cascade in workspace -> agent -> session order.

`schedule-dream` queues server-side dream consolidation for `peer_id` (defaults to the caller), optional `session_id`, optional `observer_peer_id`, `include_peer_card`, `force`, and `reason`.

Admin helpers:

```http
POST /v1/backup
POST /v1/restore
GET /v1/admin/workspaces/{workspace_id}/export
POST /v1/admin/workspaces/{workspace_id}/import
POST /v1/admin/workspaces/{workspace_id}/prune?dry_run=true
POST /v1/admin/test-data/cleanup
POST /v1/admin/prune
GET /v1/admin/audit
```

`POST /v1/backup` is unavailable (501). The root host-bound backup command creates
consistent Qdrant snapshots together with the other service state; Memory does
not produce a partial service-only archive through HTTP.

`POST /v1/restore` is unavailable (501). Root restore stages and verifies an isolated recovery tree; it does not automatically restart production services.

Workspace export returns `workspace_id`, readable current `memories`, accessible `sessions`, `exported_at`, and `format_version:1`. Import is unavailable (501).

`GET /v1/admin/audit` requires admin authorization and reads persisted redacted operations, with pagination and supported workspace/action filters. It does not read the former Python JSONL audit log.

`POST /v1/admin/workspaces/{workspace_id}/prune` applies workspace retention only with query `dry_run=false`; preview is the default. It archives eligible memories, not sessions. Unscoped prune is unavailable (501). Bounded permanent deletion of already archived memories is a separate admin `POST /v1/admin/purge` operation with explicit workspace, limit and `dry_run:false`.

`POST /v1/admin/test-data/cleanup` is a narrowly scoped hard-delete endpoint for browser and integration smoke-test data. It accepts `workspace_id`, `tag_prefix`, `agent_id_prefix`, `peer_id_prefix`, `dry_run`, and `limit_per_collection`; at least one prefix is required.

`POST /v1/admin/prune` globally hard-deletes stale records from active memory collections only. Targets include old soft-deleted records, expired records, old superseded records, and optionally low-confidence decayed records. When `HIVEMEM_ARCHIVE_ENABLED=true`, matching records are copied to the `archive` collection before deletion. Response shape is `{ "pruned": { "<collection>": { "soft_deleted": 0, "expired": 0, "superseded": 0, "decayed": 0 } }, "total_pruned": 0 }`.

---

### Conclusions and Representations

Derived conclusions are stored in `_conclusions` as searchable vector records linked to source memories. They are not first-class messages.

```http
POST /v1/peers/{peer_id}/conclusions
GET /v1/peers/{peer_id}/conclusions
POST /v1/peers/{peer_id}/conclusions/query
GET /v1/conclusions/{conclusion_id}
DELETE /v1/conclusions/{conclusion_id}
GET /v1/peers/{peer_id}/representation
GET /v1/peers/{peer_id}/context
GET /v1/peers/{peer_id}/card
POST /v1/peers/{peer_id}/card
PUT /v1/peers/{peer_id}/card/{card_id}
DELETE /v1/peers/{peer_id}/card/{card_id}
POST /v1/peers/{peer_id}/card/rebuild
POST /v1/peers/{peer_id}/card/review
POST /v1/reasoning/providers/compare
POST /v1/peers/{peer_id}/dream
```

Conclusion fields include `observer_peer_id`, `observed_peer_id`, `session_id`, `workspace_id`, `source_memory_ids`, `content`, `kind`, `confidence`, `supersedes`, and `metadata`. `kind` values are `explicit`, `deductive`, `inductive`, `abductive`, `summary`, `peer_card`, and `manual`. Peer-card facts are ordinary conclusions with `kind="peer_card"`; use `supersedes` to correct stale facts.

`GET /v1/conclusions/{conclusion_id}` returns one conclusion owned by the caller (admins may read any). It returns `404` unless the conclusion is current; pass `include_history=true` to also read superseded conclusions or conclusions whose sources are no longer current. Soft-deleted conclusions are never returned.

`GET /v1/peers/{peer_id}/conclusions` accepts `observer_peer_id`, `workspace_id`, `session_id`, `kind`, `min_confidence`, `limit` (default 50, max 200) and `include_history`. Without pagination it returns an array ordered by confidence (highest first). With `paginate=true` (or any `cursor`) it returns `{ "results": [...], "next_cursor": "..." | null }` ordered by confidence descending, then `created_at` and `id`; pass `next_cursor` back as `cursor` with the same filters to read the next page. A cursor reused with different filters or by another caller is rejected with `400`. `include_deleted=true` is accepted as a legacy alias for `include_history=true`; deleted conclusions are never listed.

Peer-card endpoints are first-class convenience routes over `kind="peer_card"` conclusions:

- `GET /v1/peers/{peer_id}/card` returns `PeerCardResponse` with active card conclusions for an observer/workspace.
- `POST /v1/peers/{peer_id}/card` creates a peer-card conclusion from `content`, optional `observer_peer_id`, `workspace_id`, `confidence`, `source_memory_ids`, `metadata`, and `supersedes`.
- `PUT /v1/peers/{peer_id}/card/{card_id}` replaces content/confidence/metadata for an owned card; admins may replace any card.
- `DELETE /v1/peers/{peer_id}/card/{card_id}` soft-deletes the card.
- `POST /v1/peers/{peer_id}/card/rebuild` queues the same dream workflow as `/peers/{peer_id}/dream`.
- `POST /v1/peers/{peer_id}/card/review` returns counts, latest active-card timestamp, stale-card notes, and `needs_rebuild`.

`POST /v1/peers/{peer_id}/dream` queues dream-like consolidation for the peer. The worker deduplicates redundant conclusions, flags changed/conflicting state, infers repeated patterns, and refreshes peer cards. Provider credentials are read only from server-side `HIVEMEM_REASONING_*` settings.

`POST /v1/reasoning/providers/compare` runs local/OpenAI-compatible/Anthropic/Gemini/Ollama/vLLM providers against the same memory IDs and reports latency, estimated tokens/cost, JSON validity, grounded conclusion counts, and a simple quality score. Admins may include `select_default_provider` to switch the in-process default for subsequent reasoning jobs.

`POST /v1/memories/forgetting/review` schedules a review-only `forgetting_review` job. Results recommend prune, compress, merge, or anonymize actions for stale, superseded, low-confidence, duplicate, long low-importance, or sensitive memories; no destructive action is applied automatically.

---

### Lifecycle and Frontier Review

```http
POST /v1/lifecycle/retention/apply
POST /v1/lifecycle/forget-me
POST /v1/archive/search
POST /v1/memories/compactions
POST /v1/memories/negotiations
POST /v1/memories/multimodal
POST /v1/memories/critic/review
```

`/v1/lifecycle/retention/apply` evaluates or applies rules by workspace, tag, sensitivity, retention class, age, and action (`expire`, `archive`, `anonymize`, `summarize`, or `preserve`). `dry_run=true` returns affected records without mutating data. `/v1/lifecycle/forget-me` reports and optionally anonymizes or soft-deletes all manageable memories matching a subject. `/v1/archive/search` explicitly searches cold archived memories without changing normal live-memory search behavior.

Compaction records, memory-negotiation proposals, and critic findings are review artifacts stored as derived operator records. Multimodal references are attached to memory metadata with URI, thumbnail, extracted text, and provenance so context APIs can include safe file/image/audio references without loading binary payloads into shared memory.

---

### Queue

HiveMem stores async reasoning jobs in `_queue`. The in-process worker runs local-first reasoning handlers by default and can optionally call server-configured external providers.

```http
GET /v1/queue/status
GET /v1/queue/jobs/{job_id}
GET /v1/queue/operations/{operation_id}?workspace_id=...&task_type=consolidation|dream
POST /v1/queue/jobs/{job_id}/retry
DELETE /v1/queue/jobs/{job_id}
```

Consolidation and dream requests accept an optional client-chosen `operation_id` (`[A-Za-z0-9._:-]{1,160}`). Repeating a request with the same `operation_id` and payload returns the original job instead of enqueueing a new one; reusing it with a different payload returns `409`. `GET /v1/queue/operations/{operation_id}` returns the job recorded for the caller's operation in that workspace and task type, including its final result after completion. Receipts for finished jobs are retained for 30 days (at most 10,000 receipts per installation, oldest finished first).

`GET /v1/queue/status` supports filters for `status`, `task_type`, `session_id`, `peer_id`, `owner_agent_id`, `workspace_id`, `observer_peer_id`, `observed_peer_id`, and `work_unit_key`. Retry/cancel are admin-only. Memory and session writes enqueue summary, representation, consolidation, conflict-scan, and embedding-reconcile tasks where applicable. Representation jobs wait for `HIVEMEM_REASONING_REPRESENTATION_MIN_TOKENS` or `HIVEMEM_REASONING_REPRESENTATION_MAX_WAIT_SECONDS` before doing expensive extraction. When the queue is quiet, the worker may enqueue low-priority `sleep` jobs for background consolidation; sleep jobs stop appearing while ordinary work is pending. Queue records include optional `not_before` timestamps so expensive reasoning can wait for an idle window. Running jobs heartbeat `locked_at`; stale leases are released automatically, and old completed/dead jobs are archived as summaries before queue pruning.

Consolidation cron execution records and explicit scan cursors live in `_cron_runs`, separate from `_queue`, so skipped checks are visible and queue cleanup cannot alter cron watermarks. Completed consolidation job results include reviewed memory IDs, generated conclusions, duplicate merges, conflict hints, skipped reasons, and batch token details for dashboard inspection.

---

### Webhooks and Events

Webhook endpoints are stored in `_webhooks`; delivery attempts are stored in `_webhook_deliveries` and executed by `webhook_delivery` queue jobs. Delivery failures never fail the original memory/session/reasoning write.

```http
POST /v1/webhooks
GET /v1/webhooks
GET /v1/webhooks/{endpoint_id}
PUT /v1/webhooks/{endpoint_id}
DELETE /v1/webhooks/{endpoint_id}
POST /v1/webhooks/test
GET /v1/webhooks/deliveries
GET /v1/webhooks/deliveries/{delivery_id}
```

Create/update fields:

| Field | Type | Default | Description |
| --- | --- | --- | --- |
| `url` | URL | required on create | HTTPS/HTTP webhook destination |
| `workspace_id` | string | `default` | Workspace subscription; `*` matches all workspaces |
| `event_types` | string[] | standard events | Subscribed events; `webhook.test` is always eligible for test emits |
| `enabled` | bool | `true` | Disable without deleting the endpoint |
| `secret` | string | `null` | Optional HMAC secret; never returned by reads |
| `clear_secret` | bool | `false` | Update-only flag to remove the stored secret |
| `headers` | object | `{}` | Extra outbound headers; `Authorization`, `Content-Length`, and `Host` are blocked |
| `metadata` | object | `{}` | Caller-defined endpoint metadata |

Webhook destinations are hardened by default. New endpoint URLs must use HTTPS and must not target loopback, link-local, private, reserved, metadata-service, or otherwise non-public IP ranges unless the server is explicitly configured for a trusted internal deployment. Relevant settings are `HIVEMEM_WEBHOOK_ALLOW_HTTP`, `HIVEMEM_WEBHOOK_ALLOW_PRIVATE_IPS`, `HIVEMEM_WEBHOOK_ALLOWED_HOSTS`, and `HIVEMEM_WEBHOOK_VERIFY_TLS`.

Supported event types: `memory.created`, `session.created`, `queue.empty`, `summary.updated`, `peer_card.updated`, `conflict.detected`, and `webhook.test`.

Normal agent-owned events are delivered only to endpoints owned by the same authenticated principal. System events such as `queue.empty` can fan out to matching enabled workspace endpoints.

Delivery body envelope:

```json
{
  "id": "event-uuid",
  "event_type": "memory.created",
  "workspace_id": "default",
  "owner_agent_id": "agent-alpha",
  "resource_type": "memory",
  "resource_id": "memory-uuid",
  "data": { "memory": { "id": "memory-uuid", "content": "..." } },
  "created_at": "2026-05-23T12:00:00Z"
}
```

Outbound headers include `X-HiveMem-Event`, `X-HiveMem-Delivery`, `X-HiveMem-Timestamp`, `X-HiveMem-Nonce`, and, when a secret is configured, `X-HiveMem-Signature: sha256=<hmac_sha256>`. The replay-safe signature is computed over `timestamp + "." + nonce + "." + canonical_json_body`. SDK helpers verify the HMAC, timestamp replay window, and optional nonce cache. Legacy body-only verification remains available for older deliveries without timestamp/nonce headers.

`GET /v1/webhooks/deliveries` supports filters for `endpoint_id`, `event_type`, `status`, `workspace_id`, `offset`, and `limit`. Delivery statuses are `queued`, `delivered`, and `failed`.

---

## Local Compatibility Tests

HiveMem includes deterministic TypeScript tests for validating retrieval, reasoning, dashboard compatibility, Qdrant hydration, and Hermes-plugin contracts:

```bash
npm --prefix ts-core test
npm run test:dual-stack
npm run test:hermes-dual-stack
```

These are development/CI checks, not public REST endpoints.

---

## Client Tooling

### Python SDK

The source package in `sdks/python` provides sync and async clients, request helpers, context-format adapters, and typed HTTP errors. Non-loopback endpoints require HTTPS with system trust or a private-PKI trust anchor supplied through `ca_file` / `HIVEMEM_CA_FILE`; verification cannot be disabled.

```bash
pip install -e sdks/python
```

```python
from hivemem_sdk import HiveMemClient

client = HiveMemClient(base_url="$HIVEMEM_API_URL", token="<agent-jwt>", ca_file="/etc/hivemem/client-ca.pem")
memory = client.create_memory(
  content="The operator prefers concise status updates.",
  type="semantic",
  scope="shared",
)
context = client.context(tokens=1200, search_query="communication style")
messages = context.to_openai()
```

### TypeScript SDK

The source package in `sdks/typescript` is a fetch-based client for Node.js and browser-compatible runtimes.

```bash
npm --prefix sdks/typescript install
npm --prefix sdks/typescript run build
```

```ts
import { HiveMem } from "@hivemagnus/hivemem-sdk";

const client = new HiveMem({ apiUrl: process.env.HIVEMEM_API_URL, token: process.env.HIVEMEM_TOKEN });
const results = await client.searchMemories({ query: "communication style", limit: 5 });
const context = await client.context({ tokens: 1200, search_query: "communication style" });
```

### Dashboard and Capability Checks

`/dashboard` includes top-line memory stats, a balanced overview band with Memory Timeline over Task History on the left and Relationship Graph spanning the right half, recent-memory tables whose memory text opens the edit modal, a memory CRUD modal, collection/agent sidebars, a compact queue snapshot, and a cohesive admin workbench. The workbench groups memory detail/search/context/conflict tools, consolidation analysis, webhooks, and review workflows. Unscoped cleanup and critic operations return HTTP 501 and their dashboard boxes/buttons are not rendered. The older separate session browser, search-explanation boxes, and display-preference box are not rendered.

### Operation capability matrix

`GET /v1/capabilities/operations` is the authoritative operation-level contract.
Each entry is `implemented`, `partial`, or `unavailable`, lists its routes, and
states the observable effect or limit. An unavailable route returns HTTP 501
without changing durable state. Partial queue controls expose only state-valid
actions: pending work can run or be cancelled, failed/dead-letter work can be
run, retried, or cancelled, and completed work cannot be retried or cancelled.

HTTP backup, HTTP restore, workspace import, unscoped cleanup/prune, critic
review, external provider comparison, and complete issued-token inventory are
currently unavailable. Use the installation-bound backup and lifecycle tools
where the matrix directs. Archives and credentials of separate installations
remain separate.

---

### Embed Text

```http
POST /v1/embed
```

Convert text to deterministic 768-dimensional token-hash vectors without storing a memory. This endpoint does not call the optional neural embedding provider. Available to any authenticated agent.

**Request body:**

```json
{
  "texts": ["text to embed", "another text"],
  "is_query": false
}
```

| Field | Type | Description |
| --- | --- | --- |
| `texts` | string[] | 1–32 texts to embed (max 30,000 chars each) |
| `is_query` | bool | `true` for search queries, `false` for storage text |

**Response (200):**

```json
{
  "embeddings": [[0.123, -0.456, ...], [...]],
  "model": "hivemem-token-hash-v1",
  "dimensions": 768
}
```

---

### Consolidate Memories

```http
POST /v1/memories/consolidate
```

Cluster similar episodic memories for review.

**Request body:**

```json
{ "scope": "private" }
```

**Response (200):** `{ "clusters": [...], "total_episodic_reviewed": 42, "already_consolidated": 3 }`

`since` defaults to the last 24 hours. Future `since` timestamps return `400`. Clustering is a lightweight server grouping pass; callers are expected to review/convert clusters into semantic memories themselves.

---

### Promote Memory

```http
POST /v1/memories/promote
```

Move a private memory to shared scope.

```json
{ "memory_id": "uuid-here" }
```

Returns `{ "id": "...", "moved_to": "shared_episodic" }` or `shared_semantic`. Only the memory owner can promote. The memory id is preserved. The durable journal removes the stale source point before creating the destination; interrupted moves replay at startup while preserving original vectors.

---

### Privatize Memory

```http
POST /v1/memories/privatize
```

Move a shared memory back to private scope (owner only).

```json
{ "memory_id": "uuid-here" }
```

Returns `{ "id": "...", "moved_to": "<agent_id>_private_episodic" }` or private semantic. Only the memory owner can privatize.

---

### List Agents

```http
GET /v1/agents
```

Returns all registered agents. Available to any authenticated agent.

### Register Agent (admin-only)

```http
POST /v1/agents/register
```

Requires admin JWT (`role=admin`). Creates the agent's private episodic and semantic collections, stores metadata in `_agents`, and returns the agent JWT once.

```json
{
  "agent_id": "agent-alpha",
  "display_name": "Agent Alpha",
  "description": "optional",
  "token_scopes": ["*"]
}
```

`agent_id` must match `^[a-z0-9_-]{2,32}$`. `token_scopes` defaults to `["*"]` when omitted. Duplicate ids return `409`.

### Get Agent

```http
GET /v1/agents/{agent_id}
```

Returns agent metadata and memory counts. Available to any authenticated agent.

### Agent Knowledge Profile

```http
GET /v1/agents/{agent_id}/profile
```

Returns totals, shared/private counts, top tags, memory type/source distribution, first/last memory timestamps, and average confidence.

### Agent Profile Bundle

```http
GET /v1/agents/{agent_id}/bundle
POST /v1/agents/{agent_id}/bundle
```

`GET /bundle` exports agent-facing profile metadata: `agent_id`, `display_name`, `description`, `default_workspace_id`, `default_tags`, `preferred_recall_strategy`, `tool_configuration`, `metadata`, and `exported_at`.

`POST /bundle` is admin-only and imports or updates an agent metadata record from an `AgentProfileBundle`. If the path agent id does not exist, HiveMem creates metadata for it; token issuance remains separate through `/agents/register` or `/auth/tokens`.

---

### Health Check

```http
GET /v1/health
```

**Without auth** — returns minimal status:

```json
{"status": "ok"}
```

If Qdrant is unreachable, status is `"degraded"`.

**With auth** (`Authorization: Bearer <token>`) — returns full details:

```json
{
  "status": "ok",
  "version": "0.1.0",
  "uptime_seconds": 3600,
  "qdrant": {
    "connected": true,
    "collections": ["shared_episodic", "shared_semantic"],
    "client_version": "1.18.0",
    "server_version": "1.15.0",
    "error": null
  },
  "embedding": { "ready": true, "model_path": "/var/opt/hivemem/models/nomic-embed-text-v1.5.Q8_0.gguf", "vector_dim": 768 },
  "queue_worker": { "enabled": true, "running": true, "in_flight": 0 },
  "consolidation_cron": { "enabled": true, "running": true, "last_run_status": "skipped" }
}
```

```http
GET /metrics
```

Returns Prometheus text metrics for request latency, embedding latency, Qdrant latency, queue depth/age, consolidation duration, and webhook delivery results.

`/metrics` requires `Authorization: Bearer <token>` where the token is either an admin JWT or the static scrape token configured in `HIVEMEM_METRICS_TOKEN` (at least 32 characters). Set `HIVEMEM_METRICS_ALLOW_LOOPBACK=true` to let loopback clients (for example a Prometheus agent on the same host) scrape without credentials; remote clients still need a token.

---

### System Stats

```http
GET /v1/stats
```

Collection point counts. Requires agent auth.

---

## Standalone Deployment Contract

HiveMem is designed to run as its own repository and service. External projects should treat this file as the API contract and may symlink it into their own docs.

Recommended standalone defaults:

| Setting | Default | Notes |
| --- | --- | --- |
| `HIVEMEM_API_URL` | `http://localhost:18790` | Canonical URL for agents and tools; override per deployment |
| `HIVEMEM_CA_FILE` | system CA store | Client-side PEM trust anchor for private PKI; certificate and hostname verification remain mandatory |
| `HIVEMEM_WEB_PORT` | `443` | Production HTTPS port used by systemd/deploy scripts |
| `HIVEMEM_CORS_ORIGINS` | `http://localhost:18790` in `.env.example` | Add other dashboard origins explicitly |
| `HIVEMEM_STORAGE_PATH` | `/var/opt/hivemem` | Local standalone storage root (set by the systemd unit and Docker image; the `hivemem-server` CLI defaults to `${HIVE_HOME:-~/.hive}/memory`) |
| `HIVEMEM_BACKUP_PATH` | `/var/opt/hivemem/backups` | Qdrant snapshot storage |
| `HIVEMEM_NFS_BASE_PATH` | `/var/opt/hivemem` | Local resource root unless NFS is explicitly enabled |
| `HIVEMEM_USE_NFS` | `false` | Set true only when intentionally using shared NFS resources |
| `HIVEMEM_EMBEDDING_ENDPOINT` | unset | Optional trusted embedding HTTP API; requires explicit model, revision, dimensions and shadow collection. Legacy GGUF path settings do not load a model in the TypeScript core. |
| `HIVEMEM_WEBHOOKS_ENABLED` | `true` | Enable REST-managed webhook event emission and delivery queueing |
| `HIVEMEM_WEBHOOK_TIMEOUT_SECONDS` | `10` | Per-delivery outbound HTTP timeout |
| `HIVEMEM_ADMIN_TOKEN` | empty | Optional deploy/tooling convention for an admin JWT; the server still validates it only as a normal bearer token |
| `HIVEMEM_REVOCATION_FILE` | `/var/opt/hivemem/revoked-tokens.json` | Protected persistent `jti` revocation registry |
| `HIVEMEM_METRICS_TOKEN` | unset | Static bearer token (>= 32 chars) accepted on `/metrics`; admin JWTs are always accepted |
| `HIVEMEM_METRICS_ALLOW_LOOPBACK` | `false` | Serve `/metrics` without credentials to loopback clients only |
| `HIVEMEM_SANITIZE_DETECTION_MODE` | `warn` | `warn`, `redact`, or `reject` for secret/PII detectors |
| `HIVEMEM_SANITIZE_DETECT_PII` | `true` | Enable email/phone/SSN pattern detection |
| `HIVEMEM_SANITIZE_DETECT_SECRETS` | `true` | Enable token/password/key pattern detection |
| `HIVEMEM_SANITIZE_DENY_REGEXES` | empty | Newline-separated custom regexes for project-specific rejection/redaction policy |

The provided `scripts/deploy_server.sh` deploys directly from the `hive-mem` repository to the configured `SSH_HOST` from `.env`. It supports `--dry-run` plus SSH key/agent auth through `HIVEMEM_SSH_KEY` or shared `DEPLOY_SSH_KEY`; password bootstrap mode remains available through `SSH_PASSWORD` or `DEPLOY_PASSWORD`. The production service runs from `/opt/hivemem`, writes local operational data under `/var/opt/hivemem`, and uses `/var/log/hivemem` for audit logs.

The former Python runtime had PAM login. The production TypeScript core uses bounded HS256 JWT validation plus a persistent `jti` revocation registry; keep operator login in Hive Router and pass server-side Memory proxy tokens through Router env instead of exposing HiveMem tokens to browsers.

---

## Memory Scoping

| Scope | Who can write | Who can read |
| --- | --- | --- |
| `shared` | Any agent | Any agent |
| `private` | Owner only | Owner only |

- Cross-agent private access → `404` on read, `403` on write/update/delete.
- Ownership is enforced via JWT — `agent_id` in the request body is ignored.

---

## Error Codes

| Code | Meaning |
| --- | --- |
| `400` | Validation error (e.g., invalid embedding dimensions, empty content, future timestamps) |
| `401` | Missing or invalid JWT |
| `403` | Not authorized (e.g., updating another agent's memory) |
| `404` | Memory not found or inaccessible |
| `409` | Conflict (e.g., agent_id already registered) |
| `429` | Rate limit exceeded (max writes per minute per agent) |
| `503` | Embedding model not loaded or feature disabled |

---

## Additional Memory Endpoint Details

### Batch Create Memories

`POST /v1/memories/batch` — Create 1 to 100 memories in one request.

```json
{ "memories": [ { "content": "...", "type": "episodic", "scope": "shared" }, ... ] }
```

Response is a JSON array of `MemoryRecord` objects with status `201`.

Current behavior: batch creation sanitizes, embeds, computes importance, runs deduplication, updates `superseded_by` for accessible `supersedes` references, stores, and audits each newly-created memory. Same-agent duplicates return the existing memory in the response instead of creating a second point.

### Endorse Memory

`POST /v1/memories/{id}/endorse` — Upvote or downvote an accessible memory.

```json
{ "vote": "up" }
```

Use `"down"` to oppose instead of endorse.

Response:

```json
{ "id": "uuid-here", "endorsements": 1, "vote": "up" }
```

The implementation stores `endorsed_by`, `opposed_by`, and net `endorsements`. It does not currently change `confidence`, and it does not restrict voting to shared memories.

### Full-Text Search

`POST /v1/memories/search/text` — Keyword search without embeddings.

```json
{ "query": "deploy.sh", "scope": "shared", "type": "episodic", "limit": 10 }
```

Request fields: `query`, `scope`, `type`, `workspace_id`, `filter`, `as_of`, `limit`, `include_deleted`, `include_sensitive`, `use_mmr`, `mmr_lambda`, and `diversity_by`. Response shape matches semantic search. Scores are currently `1.0` for returned text matches.

### Hybrid Search

`POST /v1/memories/search/hybrid` — Combined vector + text search.

```json
{ "query": "async patterns", "scope": "shared", "type": "semantic", "text_weight": 0.3 }
```

Request fields: `query`, `scope`, `type`, `workspace_id`, `filter`, `as_of`, `limit`, `text_weight`, `include_deleted`, `include_sensitive`, `use_mmr`, `mmr_lambda`, and `diversity_by`. Every hybrid result includes an `explanation`.

### Related Memories

`GET /v1/memories/{id}/related?limit=10` — Find memories related by supersedes, corroboration, or similarity. Returns relationship classification.

### Conflict Detection

`POST /v1/memories/conflicts` — Find conflicting memories across agents.

```json
{ "content": "topic to check", "scope": "shared", "type": "semantic" }
```

### Search Explanations

Add `?explain=true` to `POST /v1/memories/search` to include a per-result `explanation` object. Use `POST /v1/memories/search/explain` for the operator-facing wrapper that also includes `operator_notes`.

```json
{
  "memory": { "id": "uuid-here", "content": "..." },
  "score": 0.95,
  "explanation": {
    "vector_score": 0.85,
    "importance_boost": 0.1,
    "text_match": true,
    "confidence_factor": 0.94,
    "recency_boost": 0.0,
    "rerank_score": 0.95,
    "diversity_penalty": 0.0,
    "filters": ["workspace_id"],
    "exclusions": [],
    "final_score": 0.95
  }
}
```

### Cursor-Based Pagination

`GET /v1/memories/browse?cursor=<opaque>` — Use `next_cursor` from response for efficient pagination through large result sets.

---

Notes:

- `explain=true` exposes search-score breakdowns for REST/SDK tooling.
- `search_memories(..., filters={...})` forwards only the documented exact structured filters. Pass `graph={"enabled": true, "max_hops": 1, "max_expansions": 12}` for bounded graph-assisted retrieval.
- `browse_memories(..., cursor=...)` supports the API's cursor pagination.
- `browse_memories(..., tags=...)` passes tags through to the API, which applies OR tag filtering.
- `detect_conflicts(query=...)` maps to the API's `content` field internally for convenience.
- Tool wrappers should stay thin: forward JSON to REST endpoints and do not load embeddings, reason locally, or bypass server-side auth/workspace checks.

---

## Hermes Agent Memory Provider Plugin

The repository includes a Hermes Agent memory-provider plugin in `hermes-plugin/`. It implements Hermes' `MemoryProvider` contract and talks to HiveMem through the REST endpoints documented above.

### Install

```bash
bash hermes-plugin/scripts/deploy_hermes_plugin.sh \
  --hermes-home "$HOME/.hermes" \
  --api-url "$HIVEMEM_API_URL" \
  --token "$HERMES_HIVEMEM_TOKEN" \
  --set-active
```

The deployment script copies `plugins/memory/hivemem` into the Hermes profile, writes non-secret settings to `$HERMES_HOME/hivemem.json`, stores `HERMES_HIVEMEM_TOKEN` in the Hermes profile `.env` when provided, and can optionally restart the Hermes gateway.

Remote deployment over SSH is supported with `--ssh-host`, `--ssh-user`, and `--remote-hermes-home`.

### Hermes Configuration

Provider selection is stored in Hermes `config.yaml`:

```yaml
memory:
  provider: hivemem
```

Secrets stay in Hermes `.env`:

```bash
HERMES_HIVEMEM_API_URL=https://hivemem.example.com
HERMES_HIVEMEM_TOKEN=<agent-jwt-from-hivemem>
```

Non-secret options are stored in `$HERMES_HOME/hivemem.json`:

```json
{
  "api_url": "https://hivemem.example.com",
  "workspace_id": "default",
  "default_scope": "private",
  "recall_mode": "hybrid",
  "capture_turns": true,
  "max_recall_results": 5,
  "context_tokens": 1200
}
```

### API Calls Used

The plugin does not access Qdrant directly and does not load embeddings locally. It uses:

| Hermes behavior | HiveMem endpoint |
| --- | --- |
| Store tool / turn capture / memory-write mirror | `POST /v1/memories` |
| Search tool / background recall | `POST /v1/memories/search` |
| Get tool | `GET /v1/memories/{memory_id}` |
| Update tool | `PUT /v1/memories/{memory_id}` |
| Delete tool | `DELETE /v1/memories/{memory_id}` |
| Browse tool | `GET /v1/memories/browse` |
| Status/test command | `GET /v1/health` |

### Hermes Tools

When active in `hybrid` or `tools` mode, the provider exposes:

- `hivemem_store`
- `hivemem_search`
- `hivemem_get`
- `hivemem_update`
- `hivemem_delete`
- `hivemem_browse`

Every tool returns a JSON string, including errors, as expected by Hermes. Memory ownership and scope isolation remain enforced by HiveMem using the JWT `sub` claim; the plugin never sends `agent_id` in request bodies.

### Test

```bash
pytest hermes-plugin/tests -v
PYTHONPATH=/path/to/hermes-agent pytest hermes-plugin/tests -m hermes -v
```

Most tests use a fake HiveMem HTTP server. Tests marked `hermes` run the real Hermes interface when Hermes Agent is importable.
