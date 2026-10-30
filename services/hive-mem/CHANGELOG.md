# Changelog

All notable changes to this project will be documented in this file.

This project follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and [Semantic Versioning](https://semver.org/).

## [1.0.0]

Initial public release.

- Strict TypeScript HiveMem core backed by Qdrant: episodic, semantic, and procedural memories with provenance, valid-time history, deduplication, and workspace/agent scope isolation.
- Lexical, semantic (optional shadow index), and hybrid search with a structured filter DSL, explainability, and MMR diversity controls.
- Source-cited chat and token-budgeted context packages, sessions, episodes, peer cards, and conclusions.
- Durable reasoning queue (summaries, consolidation, dream, forgetting review) with idempotent operation receipts.
- Bounded HS256 JWT auth, scoped agent tokens, renewal grants, and persistent `jti` revocation.
- HMAC-signed webhooks with SSRF-safe destination policy, metrics, audit log, and an operator dashboard.
- TypeScript (`@hivemagnus/hivemem-sdk`) and Python SDKs, and a Hermes Agent memory-provider plugin.
- `@hivemagnus/hivemem-server` on npm, with a `hivemem-server` command (`start`, `check`, `env-schema`, `issue-token`, `--env-file`). It defaults to Qdrant persistence and refuses to start when Qdrant is unreachable (`HIVEMEM_TS_PERSISTENCE=memory` opts in to volatile storage). Without `HIVEMEM_STORAGE_PATH`, local state goes to `${HIVE_HOME:-~/.hive}/memory`.
