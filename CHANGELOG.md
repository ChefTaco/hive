# Changelog

All notable changes to this project are documented in this file. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project follows
[Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

- `@hivemagnus/hive`, the `hive` launcher (`npx @hivemagnus/hive init`, then `hive start`). It
  installs the server packages on demand after asking, writes an env file per service with
  generated secrets and the wiring between them, creates a local CA and TLS certificate, finds or
  starts Qdrant and Redis (in Docker, after asking), and runs the servers in dependency order with
  health checks. `hive status`, `hive doctor` and `hive install` check and upgrade the setup.
- `hivemem-server issue-token` mints an access token from `HIVEMEM_JWT_SECRET`
  (`--subject`, `--role admin|agent`, `--scope`, `--ttl` up to 30 days) and prints only the token.
  Use it for the Router's `HIVE_ROUTER_MEMORY_PROXY_TOKEN`. `env-schema` describes it under
  `issueToken`.
- The servers are published to npm, each with a command that can `start`, `check` its
  configuration and dependencies, print an `env-schema`, and load settings with `--env-file`:
  - `@hivemagnus/hivemem-server` (`hivemem-server`)
  - `@hivemagnus/hive-router` (`hive-router`), with the Hive console bundled
  - `@hivemagnus/hive-iam-server` (`hive-iam-server`), which also runs its database migrations and
    creates the first admin account on first start. A Docker image and a Compose example with Redis
    are in `services/hive-iam/apps/iam-core`.
- Node.js 26 is supported alongside Node.js 24.

### Changed

- Without explicit paths, the servers keep their data in `${HIVE_HOME:-~/.hive}/<service>`. The
  production systemd units, deploy scripts and Docker images set their existing paths explicitly.
- HiveMem defaults to Qdrant persistence and refuses to start if Qdrant is unreachable. Set
  `HIVEMEM_TS_PERSISTENCE=memory` to opt in to volatile in-memory storage.
- The Router's default API port is 4020 instead of 443.
- Setting only one of a TLS certificate and key is now an error instead of a silent fallback to HTTP.
- The npm packages are published under the `@hivemagnus` scope as `@hivemagnus/hivemem-sdk` and
  `@hivemagnus/hive-iam-sdk`.
- `hive-router env-schema` describes `HIVE_ROUTER_MEMORY_PROXY_TOKEN` as a token minted with
  `hivemem-server issue-token` (under `issuedTokens`) instead of a shared `HIVEMEM_ADMIN_TOKEN`
  setting, which HiveMem never had.
- The shared contracts package is no longer a separate package. Its schemas now live in the Hive
  Router (`services/hive-router/src/contracts`), and the service manifest used by the ops scripts
  lives in `scripts/lib/service-manifest.ts`.

### Fixed

- Hive Router gives IAM's built-in `SUPER_ADMIN` role full console access, as documented. It only
  matched lowercase role names, which IAM never issues, so the first IAM administrator could not
  open the Memory or status pages. Matching stays exact, so user-defined roles such as `ADMIN` do
  not get full access.

## [1.0.0] - 2026-10-24

The first public release.

### Added

- **Hive Router**: an OpenAI-compatible model gateway with provider capability discovery,
  adaptive and objective-based routing, streaming-aware failover, per-key quotas, tracing, and the
  unified Hive console.
- **Hive IAM**: an OAuth 2.0 / OIDC identity service with users, roles, service accounts, scoped
  client credentials, audit logging, and secret rotation.
- **HiveMem**: a long-term memory API backed by Qdrant, with filtered semantic search, a knowledge
  graph, temporal queries, historical reads, consolidation and reasoning jobs, webhooks, and peer
  conclusions.
- **Hive Skills**: a checksummed skills registry for Hermes Agent.
- TypeScript SDKs for HiveMem and Hive IAM, and shared Zod contracts.

[1.0.0]: https://github.com/ChefTaco/hive/releases/tag/v1.0.0
