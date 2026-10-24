# HiveMem TypeScript Core

Strict TypeScript production core for HiveMem. It covers the REST and dashboard surfaces used by Hive, Hermes, SDKs, and operator tooling: `/v1/health`, `/v1/health/live`, `/v1/health/ready`, `/v1/health/dependencies`, HS256 bearer auth, memory CRUD/batch/search/browse, search alias routes, related/conflict discovery, deterministic embed, stats/metrics, episode/message capture, agent registration/profile bundles, peer conclusions/cards, workspace governance, sessions, context, deterministic chat, queue status/job inspection/manual execution, and dashboard memory/search/session/queue/options/context-preview/graph/webhook proxy endpoints.

The deployed HiveMem service is this TypeScript runtime, installed as `hivemem.service` by `services/hive-mem/scripts/deploy_server.sh` with `HIVEMEM_RUNTIME=typescript`. Queue workers, consolidation, and reasoning handlers execute in TypeScript with deterministic local-heuristic parity. The old Python/FastAPI service has been removed. The Hermes Agent plugin intentionally remains Python while Hermes Agent is Python and should continue to interact through the REST API only.

## Compatibility Surface

The queue slice mirrors the Python API response shape for `GET /v1/queue/status`, `GET /v1/queue/jobs/:id`, `POST /v1/queue/jobs/:id/retry`, and `DELETE /v1/queue/jobs/:id`. It also exposes dashboard proxy equivalents under `/dashboard/api/memories*`, `/dashboard/api/search/explain`, `/dashboard/api/agents/:id/memories`, `/dashboard/api/queue/*`, and `/dashboard/api/sessions*` using the existing `hivemem_dash` cookie contract, including the queue runbook helper, session-memory listing envelope, memory detail envelope, agent memory listing, memory option picklists, context preview, global/session chat including SSE framing, explicit relationship preservation, graph neighborhoods from memory relationships plus metadata entities, agent metadata/profile bundles, peer conclusions/cards/representation, workspace membership/settings, dream scheduling, full webhook endpoint CRUD, webhook test emission, webhook delivery listings, `/v1/embed`, `/v1/stats`, public `/metrics`, `/v1/episodes*`, `/v1/auth/*`, `/v1/admin/*`, `/v1/graph/*`, `/v1/memories/search/text`, `/v1/memories/search/hybrid`, `/v1/memories/conflicts`, `/v1/memories/:id/related`, `/v1/memories/:id/diff`, `/v1/memories/:id/graph`, `/v1/memories/:id/endorse`, consolidation, lifecycle, archive, compaction, negotiation, multimodal, and critic-review compatibility routes. Memory, session, webhook, and episode writes enqueue typed `summary`, `representation`, `conflict_scan`, `dream`, `webhook_delivery`, and `message_extract` jobs. Admins can execute jobs through `POST /v1/queue/run-next`, `POST /v1/queue/jobs/:id/run`, and the dashboard equivalents. The compatibility worker performs real message-to-memory extraction, webhook delivery state updates, and deterministic local reasoning: `representation` and `consolidation` extract conclusions from reviewed memories, `summary` turns session memories into summary conclusions, `dream` infers stable/preference/conflict conclusions and dedupes duplicates, and `peer_card`/dream rebuild peer cards. Reasoning conclusions use stable UUIDv5 identities so re-running the same job is idempotent, mirroring `hivemem.reasoning.providers.LocalHeuristicReasoningProvider`.

## Reasoning Parity

`src/reasoning.ts` is a deterministic, local-only port of the Python `LocalHeuristicReasoningProvider`. It provides `extractConclusions`, `summarizeSession`, `dream`, and `buildPeerCard` with the same heuristics (interest markers, tag-frequency themes, duplicate/preference/conflict dream signals, and peer-card selection). The store wires these into the queue worker so consolidation and reasoning jobs produce and store conclusions, summaries, and peer cards, emit `summary.updated`/`peer_card.updated` webhooks, and return the same result envelopes as the Python handlers.

## Persistence

By default the core uses an in-memory store, which keeps the test suite deterministic and side-effect free. Production starts it with Qdrant snapshot persistence:

```bash
HIVEMEM_TS_PERSISTENCE=qdrant \
HIVEMEM_QDRANT_URL=http://127.0.0.1:6333 \
HIVEMEM_TS_TLS_CERT_FILE=/opt/hivemem/certs/server.crt \
HIVEMEM_TS_TLS_KEY_FILE=/opt/hivemem/certs/server.key \
HIVEMEM_JWT_SECRET=<set-in-local-env> \
npm start
```

Deploy selection is explicit: `HIVEMEM_RUNTIME=typescript` is the only deployable runtime. `scripts/deploy_server.sh` builds `ts-core`, installs `docker/hivemem-ts.service` as `hivemem.service`, and verifies the HTTPS readiness endpoint.

The adapter writes memories to the existing active memory collections such as `shared_semantic` and `<agent>_private_semantic`, stores metadata records in underscore collections, and keeps episode headers/messages together in `_episodes` using `record_type`. On load, it normalizes legacy Qdrant memory payloads that predate `id` and `workspace_id`, giving them stable synthetic ids instead of collapsing them during hydration.


## Dual-Stack Compatibility

The black-box dual-stack harness runs against a local TypeScript core:

```bash
HIVEMEM_DUALSTACK_TOKEN=<agent-or-admin-jwt> \
npm run test:dual-stack
```

If you have the target JWT secret instead of a token, set `HIVEMEM_DUALSTACK_JWT_SECRET` and optionally `HIVEMEM_DUALSTACK_AGENT_ID`; the test will mint a short-lived admin-scoped HS256 token. The Hermes adapter remains Python, but `npm run test:memory-hermes-dual-stack` builds this TypeScript core, launches it locally, and verifies the real Hermes HiveMem plugin tool flow against it.

## Commands

```bash
npm install
npm run typecheck
npm test
npm run build
HIVEMEM_JWT_SECRET=<set-in-local-env> npm start
```
