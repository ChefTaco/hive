# Changelog

All notable changes to this project will be documented in this file.

This project follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

- `@hivemagnus/hivemem-server` is published to npm with a `hivemem-server` command (`start`, `check`, `env-schema`, `--env-file`, `--help`, `--version`). `hivemem-ts-core` remains as an alias.

### Changed

- The CLI defaults to Qdrant persistence and refuses to start when Qdrant is unreachable. Set `HIVEMEM_TS_PERSISTENCE=memory` to run a volatile server explicitly; any other value is rejected.
- Without `HIVEMEM_STORAGE_PATH`, local state goes to `${HIVE_HOME:-~/.hive}/memory` (mode `0700`) instead of `/var/opt/hivemem`. The systemd unit and Docker image now set `/var/opt/hivemem` explicitly, so existing deployments keep their paths.
- Invalid or missing settings (JWT secret, port, half-configured TLS, embedding config) stop startup with one line naming the variable and the fix, without a stack trace.

## [1.0.0]

Initial public release.

- Strict TypeScript HiveMem core backed by Qdrant: episodic, semantic, and procedural memories with provenance, valid-time history, deduplication, and workspace/agent scope isolation.
- Lexical, semantic (optional shadow index), and hybrid search with a structured filter DSL, explainability, and MMR diversity controls.
- Source-cited chat and token-budgeted context packages, sessions, episodes, peer cards, and conclusions.
- Durable reasoning queue (summaries, consolidation, dream, forgetting review) with idempotent operation receipts.
- Bounded HS256 JWT auth, scoped agent tokens, renewal grants, and persistent `jti` revocation.
- HMAC-signed webhooks with SSRF-safe destination policy, metrics, audit log, and an operator dashboard.
- TypeScript (`@hivemagnus/hivemem-sdk`) and Python SDKs, and a Hermes Agent memory-provider plugin.
