# HiveMem

```text
                    ___
                ___/   \___
            ___/   \___/   \___
           /   \___/   \___/   \
           \___/   \___/   \___/   HiveMem
           /   \___/   \___/   \
           \___/   \___/   \___/
               \___/   \___/
                   \___/
```

HiveMem is the shared long-term memory layer for autonomous agents, IDE tools, CLIs, and runtime integrations. Instead of making every client reinvent embeddings, retrieval, deduplication, provenance, and access control, HiveMem gives them one secure, server-side system for remembering facts, preferences, incidents, and derived conclusions.

The production runtime is the strict TypeScript core in [`ts-core/`](ts-core), backed by Qdrant — it stores, retrieves, and deduplicates episodic, semantic, and procedural memories across agents with provenance tracking, scope isolation, and server-side embedding. The old FastAPI/Python service has been removed; Python remains only for SDK/plugin tooling.

**Read next:** [API reference](HIVEMEM_API.md) · [Architecture](APP_ARCHITECTURE.md) · [Security](SECURITY.md) · [Contributing](CONTRIBUTING.md) · [Changelog](CHANGELOG.md)

## Features

- **Server-side embedding.** Clients send plain text. The API embeds with `nomic-embed-text-v1.5` (768-dim cosine); explicit vectors remain accepted for backward compatibility.
- **Per-agent scoping and scoped tokens.** `shared_*` collections are visible only within an authorized workspace; `{agent_id}_private_*` collections are visible only to their owner, while admin tokens can inspect the full console view. Agent identity is derived from the JWT `sub` claim. The TypeScript core supports bounded scoped tokens and persistent `jti` revocation.
- **Workspaces, sessions, and episodes.** Lightweight `workspace_id` and `session_id` filters group memories; optional episodes/messages preserve raw chronology and can asynchronously produce ordinary memories. Workspace records carry policies, members, and effective settings cascades while preserving the indexed Option A storage model.
- **Semantic, text, and hybrid search.** Vector, full-text, and hybrid endpoints share a structured filter DSL with logical operators, `metadata.*` paths, valid-time `as_of` filtering, explainability, and optional MMR diversity controls.
- **Source-cited chat & context.** `POST /v1/chat` and `/v1/context` return deterministic, source-cited answers and token-budgeted prompt packages without calling an external LLM.
- **Async reasoning queue.** Memory writes enqueue summary, peer-card, representation, conflict-scan, consolidation, dream, sleep, and forgetting-review jobs to a Qdrant-backed queue with token-threshold batching, cooldown awareness, worker heartbeats, stale-lock recovery, and retention/archive summaries.
- **Operational telemetry and governance.** Consolidation cron runs and cursors persist separately from queue jobs; `/metrics` exposes request, embedding, Qdrant, queue, consolidation, and webhook metrics; authenticated health reports versions and subsystem readiness; admin audit APIs query memory write history, and workspace export/import supports staging hydration without webhook secrets.
- **Webhooks.** REST-managed endpoints with timestamped HMAC signatures and delivery nonces cover `memory.created`, `session.created`, `summary.updated`, `peer_card.updated`, `conflict.detected`, `queue.empty`, and `webhook.test`.
- **Operator and agent surfaces.** The self-contained `/dashboard`, Python/TypeScript SDKs, REST helper scripts, and Hermes Agent memory-provider plugin all share the same REST API.
- **Compatibility tests.** The TypeScript core uses deterministic node:test coverage for REST compatibility, Qdrant hydration, reasoning, dashboard routes, and the Hermes plugin contract.

## Install from npm

The server is published as [`@hivemagnus/hivemem-server`](ts-core/README.md):

```bash
npx @hivemagnus/hivemem-server check --env-file hivemem.env
npx @hivemagnus/hivemem-server --env-file hivemem.env
```

See [ts-core/README.md](ts-core/README.md) for requirements, the Qdrant one-liner, and configuration.

## Quick Start (development)

```bash
# 1. Start Qdrant
docker compose -f docker/docker-compose.yml up -d qdrant

# 2. Build and test the TypeScript core (production runtime)
npm --prefix ts-core install
npm --prefix ts-core run build
npm run test:ts-core

# 3. Configure
cp .env.example .env
# Edit .env — HIVEMEM_JWT_SECRET is required and must be at least 32 chars.

# 4. Run the TypeScript core (HTTP dev; set TLS + Qdrant env for production parity)
HIVEMEM_JWT_SECRET=<local-secret> HIVEMEM_TS_PERSISTENCE=qdrant \
  HIVEMEM_TS_CORE_HOST=0.0.0.0 HIVEMEM_WEB_PORT=18790 npm --prefix ts-core start

# 5. Health checks
curl http://localhost:18790/v1/health
curl http://localhost:18790/v1/health/ready
```

The default development URL is `http://localhost:18790`. Production deployments typically expose HTTPS on `HIVEMEM_WEB_PORT` (commonly `443`) behind a hostname of your choice; refer to clients through `HIVEMEM_API_URL` rather than a hard-coded host.

## Architecture

```text
Agent clients (SDKs, Hermes provider, custom integrations)
  └─ Plain text over HTTPS to HiveMem API ($HIVEMEM_API_URL)
       └─ Server-side nomic-embed-text-v1.5 embeddings
       └─ Qdrant :6333/:6334 (bound to localhost by default)
       └─ Local storage under $HIVEMEM_STORAGE_PATH (/var/opt/hivemem in the systemd unit and Docker image; ~/.hive/memory for the npm CLI)
```

See [APP_ARCHITECTURE.md](APP_ARCHITECTURE.md) for internals, request flow, data model, and operational behavior, and [HIVEMEM_API.md](HIVEMEM_API.md) for the REST contract.

## Security

Security hardening notes, including webhook destination policy, token handling, and reporting guidance, live in [SECURITY.md](SECURITY.md).

## Contributing

If you'd like to improve HiveMem, start with [CONTRIBUTING.md](CONTRIBUTING.md) for local setup, test commands, and pull request guidance.

## Changelog

Release notes and noteworthy project changes live in [CHANGELOG.md](CHANGELOG.md).

## License

Apache License 2.0. See [LICENSE](LICENSE).

## Testing

```bash
npm --prefix ts-core run typecheck
npm --prefix ts-core test
npm run test:dual-stack
npm run test:hermes-dual-stack
npm --prefix sdks/typescript run typecheck
npm --prefix sdks/typescript test
```

The TypeScript core tests are the production gate.

Integration tests use a deterministic in-process embedder when the configured GGUF model is not available locally; production startup still requires the real configured embedder. The Docker Compose Qdrant service sets a higher `nofile` ulimit so Qdrant can reopen many collections and payload indexes reliably after restarts.

For remote integration testing against a separate host, do not expose Qdrant directly. Run the tests on the HiveMem host, use an SSH tunnel or VPN/firewall rule that restricts Qdrant access to trusted clients, or point tests at the HiveMem API where applicable.

## SDKs, Dashboard, and Integrations

HiveMem ships several first-party integration surfaces, all backed by the same REST API:

- `sdks/python` — sync/async REST client with context-format helpers and typed errors.
- `sdks/typescript` — fetch-based TypeScript client for Node and browser-compatible runtimes.
- `ts-core` — production strict TypeScript core for the REST API, dashboard compatibility routes, queue worker, reasoning, and Qdrant persistence.
- `scripts/` — small REST helper scripts for registration, backup, pruning, and local seed data.
- `hermes-plugin/` — Hermes Agent `MemoryProvider` implementation, deploy script, and tests.

For direct REST smoke checks:

```bash
curl "$HIVEMEM_API_URL/v1/health/ready"
curl "$HIVEMEM_API_URL/v1/memories/search" \
  -H "Authorization: Bearer $HIVEMEM_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"query":"what do we know about qdrant backups?","workspace_id":"default","limit":5}'
```

The dashboard at `/dashboard` is organized as a desktop admin workbench: top-line health and memory metrics, a balanced overview band with Memory Timeline over Task History on the left and Relationship Graph spanning the right half, an editable recent-memory stream, collection and agent activity sidebars, and grouped operations for consolidation analysis, prompt-context preview, conflict review, webhooks, and review workflows. Cleanup and critic operations remain available through REST API operator paths. Unit contract tests validate the rendered template and inline JavaScript.

## Register an Agent

```bash
# Requires an admin JWT in $HIVEMEM_ADMIN_TOKEN or --token
python scripts/register_agent.py --agent-id agent-alpha --display-name "Agent Alpha"
```

Admin JWTs are HS256 bearer tokens signed with `HIVEMEM_JWT_SECRET` and `"role":"admin"`. `HIVEMEM_ADMIN_TOKEN` is a deploy/tooling convention for carrying one of those JWTs; it is not a separate server-side auth mechanism. Agent JWTs are shown **once** - store them in the consuming project's secret manager (for example, an OS keyring, a sealed secret, or a per-host `~/.hivemem/credentials/<agent>.json`). Use admin-only `POST /v1/auth/tokens`, bounded `/v1/auth/refresh`, and persistent `/v1/auth/revoke` for the TypeScript token flow; rotate `HIVEMEM_JWT_SECRET` to invalidate every token at once.

## Hermes Agent Memory Provider

The `hermes-plugin/` directory contains a Python Hermes Agent memory-provider plugin named `hivemem`. It installs into a Hermes profile under `plugins/memory/hivemem`, selects `memory.provider: hivemem`, and calls the HiveMem REST API for long-term recall and CRUD-style memory tools. The plugin stays Python while Hermes Agent is Python; the TypeScript migration target is the HiveMem service core and shared contracts behind this REST boundary.

```bash
HERMES_HIVEMEM_TOKEN="$HERMES_HIVEMEM_TOKEN" bash hermes-plugin/scripts/deploy_hermes_plugin.sh \
  --hermes-home "$HOME/.hermes" \
  --api-url "$HIVEMEM_API_URL" \
  --set-active

hermes hivemem status
hermes hivemem test --write-check
```

Non-secret provider configuration is written to `$HERMES_HOME/hivemem.json`; `HERMES_HIVEMEM_TOKEN` is stored in the mode-`0600` Hermes profile `.env`. Non-loopback endpoints require HTTPS with hostname verification against system trust or a PEM supplied through `--ca-file`/`HERMES_HIVEMEM_CA_FILE`; the provider does not follow credentialed redirects.

Plugin tests run independently of Qdrant using a fake HiveMem HTTP server:

```bash
pytest hermes-plugin/tests -v
```

Real-Hermes contract tests are marked `hermes` and run when Hermes Agent is importable.
