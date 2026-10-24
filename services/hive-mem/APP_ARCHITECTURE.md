# HiveMem Architecture

HiveMem is the shared long-term memory service for Hive, Hermes, SDK clients, and agent tooling. The production runtime is the strict TypeScript core in [`ts-core/`](ts-core), deployed as `hivemem.service` under `/opt/hivemem`. The old Python/FastAPI implementation has been removed from this repo.

## Runtime Shape

| Component | Current implementation | Notes |
| --- | --- | --- |
| API server | Node 24 TypeScript core | `ts-core/src/server.ts` exposes REST, dashboard compatibility, and health endpoints. |
| Persistence | Qdrant snapshot adapter | Enabled in production with `HIVEMEM_TS_PERSISTENCE=qdrant` and the deployed Qdrant env. |
| Memory store | TypeScript `HiveMemStore` | Hydrates Qdrant collections, normalizes legacy payloads, and flushes snapshots back to Qdrant. |
| Reasoning | Deterministic TypeScript local heuristics | Summaries, consolidation, dreams, peer cards, conflict scans, and message extraction run without external LLM calls. |
| Auth | HS256 JWT with role/scopes | `HIVEMEM_JWT_SECRET` signs agent/admin tokens. `HIVEMEM_ADMIN_TOKEN` is a deploy/tooling convention, not a separate server credential. |
| Dashboard | Compatibility routes in the TS server | The standalone HiveMem dashboard remains reachable, while Hive Router provides the first-party unified Memory page. |
| Hermes plugin | Python REST client | Kept Python because Hermes Agent is Python; it talks to HiveMem over REST only. |

Full Hive deployments run HiveMem on internal HTTPS port `18443`. Hive Router serves the public UI on `443` and proxies `/v1/*`, `/dashboard`, and `/dashboard/*` to the internal HiveMem listener.

## Data Model

Active memories live in Qdrant collections named by scope and type:

- `shared_episodic`, `shared_semantic`, `shared_procedural`
- `<agent>_private_episodic`, `<agent>_private_semantic`, `<agent>_private_procedural`

Metadata and operational records live in underscore collections such as `_agents`, `_sessions`, `_episodes`, `_conclusions`, `_queue`, `_queue_archive`, `_workspaces`, `_webhooks`, and `_webhook_deliveries`.

Memory records include content, type, scope, agent id, source, confidence, importance, tags, metadata, sensitivity, retention policy, `workspace_id`, optional `session_id`, validity timestamps, relationships, provenance, endorsement state, and deletion state. The TypeScript Qdrant loader also accepts older payloads that lack `id` or `workspace_id`; it synthesizes stable ids from the collection and point id and defaults missing workspaces to `default`.

Workspace isolation uses the Option A model documented in [`docs/decisions/0001-workspace-isolation.md`](docs/decisions/0001-workspace-isolation.md): collections stay global and each record carries an indexed `workspace_id`. Search/browse style requests can use `workspace_id=*` for all readable workspaces. Admin principals may read across agents; non-admin principals can read their own private memories and shared memories.

## API Surface

The TypeScript core implements the active REST contract:

- Health, readiness, dependency status, stats, metrics, embed.
- Memory CRUD, batch, browse, search, text/hybrid search aliases, related/conflict/diff/graph helpers.
- Sessions, episodes, messages, context packing, deterministic chat, SSE chat.
- Queue status, retry/cancel, manual job execution, archive and consolidation helpers.
- Workspaces, workspace members/settings/export/import/prune.
- Agents, profile bundles, peer cards, conclusions, representations, graph entities/relations/neighborhoods.
- Webhook endpoint CRUD, test emission, delivery listing.
- Auth utility endpoints for login-with-token, current principal, token mint/refresh/revoke compatibility.
- Dashboard compatibility routes for the legacy HiveMem dashboard.

The authoritative endpoint reference is [`HIVEMEM_API.md`](HIVEMEM_API.md). Generated OpenAPI snapshots for the monorepo live under [`../../docs/openapi/`](../../docs/openapi/).

## Deployment

Use [`scripts/deploy_server.sh`](scripts/deploy_server.sh) through the root Hive deploy when possible:

```bash
HIVEMEM_ENV_FILE=services/hive-mem/.env.production npm run deploy
```

The deploy script:

1. Loads the private HiveMem env.
2. Generates/installs TLS material.
3. Syncs the service to `/opt/hivemem`.
4. Copies the private env to `/opt/hivemem/.env`.
5. Builds `ts-core`.
6. Installs `docker/hivemem-ts.service` as `hivemem.service`.
7. Restarts the service and verifies `/v1/health/ready`.

`HIVEMEM_RUNTIME=typescript` is the only deployable runtime. Full Hive deployments use `HIVEMEM_WEB_PORT=18443` internally and expose public memory traffic through Hive Router.

For the unified Hive UI, Router needs a server-side memory proxy token. The root deploy first uses `HIVE_ROUTER_MEMORY_PROXY_TOKEN` when explicitly set; otherwise it recovers `HIVEMEM_ADMIN_TOKEN`, `HERMES_HIVEMEM_TOKEN`, or `HIVEMEM_MCP_TOKEN` from the private HiveMem env and writes the value only to the remote Router env. Browser code never receives that token.

## Development Commands

```bash
npm --prefix ts-core run typecheck
npm --prefix ts-core run build
npm --prefix ts-core test
npm run test:dual-stack
npm run test:hermes-dual-stack
```

The root monorepo gates are:

```bash
npm run typecheck
npm run build
npm run test
npm run scan:secrets
```

## File Map

```text
ts-core/
  src/server.ts       REST/dashboard compatibility server
  src/store.ts        In-memory domain store and access checks
  src/persistence.ts  Qdrant snapshot load/flush adapter
  src/reasoning.ts    Deterministic local reasoning provider
  src/auth.ts         HS256 JWT verification and signing helpers
  tests/              REST, compatibility, and Qdrant persistence tests
docker/
  hivemem-ts.service  Production systemd unit
scripts/
  deploy_server.sh    Remote deploy script
hermes-plugin/
  Python Hermes Agent memory provider
```
