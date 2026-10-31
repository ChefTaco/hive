# Changelog

All notable changes to this project are documented in this file. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project follows
[Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

- The Hive IAM server is published as the Docker image `ghcr.io/cheftaco/hive-iam-server`
  (`linux/amd64` and `linux/arm64`, with build provenance and an SBOM). The Compose example can
  run it instead of building (`IAM_IMAGE`), and `npm run check:iam-compose` runs that example end
  to end.

### Fixed

- **Hive console**: opening a memory no longer fails to load its conflicts with
  `422 content is required`. The console now sends the memory's content, workspace, scope and type,
  as HiveMem's conflicts API expects.

## [1.0.0] - 2026-10-30

The first public release.

### Added

- **Hive Router**: an OpenAI-compatible model gateway with provider capability discovery,
  adaptive and objective-based routing, streaming-aware failover, per-key quotas, tracing, and the
  unified Hive console.
- **Hive IAM**: an OAuth 2.0 / OIDC identity service with users, roles, service accounts, scoped
  client credentials, audit logging, and secret rotation. Callers can only grant roles and
  permissions they hold, and can only manage accounts with no more access than they have; only
  `SUPER_ADMIN` can grant `SUPER_ADMIN` or change sign-in clients.
- **HiveMem**: a long-term memory API backed by Qdrant, with filtered semantic search, a knowledge
  graph, temporal queries, historical reads, consolidation and reasoning jobs, webhooks, and peer
  conclusions.
- **Hive Skills**: a checksummed skills registry for Hermes Agent.
- npm packages under the `@hivemagnus` scope:
  - `@hivemagnus/hive`, the `hive` launcher (`npx @hivemagnus/hive init`, then `hive start`). It
    installs the server packages on demand after asking, writes an env file per service with
    generated secrets and the wiring between them, creates a local CA and TLS certificate, finds
    or starts Qdrant and Redis (in Docker, after asking), and runs the servers in dependency order
    with health checks. `hive status`, `hive doctor` and `hive install` check and upgrade the setup.
  - `@hivemagnus/hivemem-server`, `@hivemagnus/hive-router` (with the Hive console bundled) and
    `@hivemagnus/hive-iam-server`. Each server command can `start`, `check` its configuration and
    dependencies, print an `env-schema`, and load settings with `--env-file`. The IAM server runs
    its database migrations and creates the first admin account on first start; a Docker image and
    a Compose example with Redis are in `services/hive-iam/apps/iam-core`.
    `hivemem-server issue-token` mints HiveMem access tokens, such as the Router's
    `HIVE_ROUTER_MEMORY_PROXY_TOKEN`.
  - `@hivemagnus/hivemem-sdk` and `@hivemagnus/hive-iam-sdk`, TypeScript SDKs for HiveMem and Hive
    IAM.
- Node.js 24 and Node.js 26 are supported.

### Notes

- Without explicit paths, the servers keep their data in `${HIVE_HOME:-~/.hive}/<service>`.
- HiveMem refuses to start if Qdrant is unreachable. Set `HIVEMEM_TS_PERSISTENCE=memory` to opt in
  to volatile in-memory storage.
- The Router and IAM servers use native add-ons (`better-sqlite3`, and `argon2` for IAM) whose
  install scripts npm 12 blocks by default. The `hive` launcher allows them; when installing a
  server yourself, pass `--allow-scripts=better-sqlite3,argon2` to `npx` or `npm install -g`, or
  list them under `allowScripts` in your project's `package.json`.

[Unreleased]: https://github.com/ChefTaco/hive/compare/v1.0.0...HEAD
[1.0.0]: https://github.com/ChefTaco/hive/releases/tag/v1.0.0
