# Changelog

All notable changes to this project are documented in this file. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project follows
[Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

- Separate unprivileged HTTPS ingress/static-console deployment candidate and
  disposable native/container SSO, resource API and protocol transport acceptance.
- Experimental shell suite controller with offline installation plans, signed
  release verification, constrained per-host Compose rendering and fail-closed
  activation. Recovery, agent and inference adapters remain gated.
- Reproducible public product extraction with provenance hashes and an explicit
  ecosystem migration and workflow-parity ledger.
- Opt-in `test:e2e:fresh` command installs exact public npm packages for all four
  services, tests environment-configured model streaming and memory recall with
  the published SDK, checks Skills distribution and restart persistence, and
  removes its isolated installation, processes and containers automatically.
- Test-only settings `HIVE_FRESH_VERSION` and `HIVE_FRESH_REPORT_PATH`; provider
  settings reuse `HIVE_E2E_*`. No server configuration, migrations, compatibility
  ranges, production credentials or signing-key changes are required.

## [1.2.2] - 2026-11-02

### Security

- Require TLS 1.2 or newer for Python deployment, readiness and Redis backup connections.
  Router IAM/HiveMem HTTPS clients always verify certificates, including development loopback;
  keep legacy insecure-TLS switches false and configure the corresponding CA path instead.
- Return fixed queue failure messages instead of exception details, including older stored
  job errors; keep account identifiers and SSH diagnostics out of operator-tool output.
- Use linear URL normalization and backup path classification, constrain the test registry's
  redirects to public npm, and separate executable test fixtures from their JSON data.
- No datastore migrations, new required server env names, wire schema changes or secret/key actions.
  The legacy TLS switches remain recognized; they no longer disable certificate verification.

### Added

- Environment-configured `deploy:npm` for existing independent systemd/npm installations, with
  exact bundle/engine checks, verified off-host backups, guarded code switching, automation
  opt-outs, durable host receipts and required live provider streaming/memory-recall cleanup.
- Optional operator-tool configuration `HIVE_NPM_DEPLOY_TARGETS`; existing `DEPLOY_*` and
  `HIVE_E2E_*` values provide SSH, credentials and the model provider. No server env names were
  removed or made required, and no migration, wire-format or secret/key changes are introduced.
- Keep staged runtime directories readable by the original service accounts under the worker's
  restrictive umask. Preservation checks allow provider-health telemetry changes while still
  rejecting changes to provider configuration or credentials.

### Migration impact and compatibility

- No new migrations; minimum upgrade-from versions and data/wire compatibility ranges are unchanged.
  Existing configurations, credentials and signing keys require no migration or rotation.
- The launcher and all four servers are released together as 1.2.2. Unchanged SDKs remain at 1.0.3.

## [1.2.1] - 2026-11-02

### Fixed

- Accept reordered npm registry JSON keys during fresh installation and staged upgrades, while still rejecting changed manifests and package integrity.
- Wait for the complete public npm release bundle and verify tarball integrity before building release images.

### Migration impact and compatibility

- No new migrations, required/optional/removed environment names, wire changes or secret/key actions.
  Migration impact remains fast; minimum upgrade-from versions and data compatibility are unchanged.
- The published 1.2.0 launcher can bootstrap from its unchanged public tarballs with `init --from DIR`;
  enrolled 1.2.0 installs should upgrade using the complete 1.2.1 tarball bundle with `upgrade --from DIR`.
  See UPGRADING.md for exact commands.

## [1.2.0] - 2026-11-01

### Added

- Hive 1.2 managed release bundles, versioned npm runtimes, explicit adoption, whole-stack
  upgrade/rollback, verified native-store backups, recovery receipts and migration planning.
- Read-only JSON checks and release/compatibility metadata across all server packages;
  owner-only upgrade coordinator, console upgrade review/apply and update notices.
- Public-npm-to-packed upgrade/restore CI on Node 24 and 26, including old SDKs and tokens.
- Non-root multi-platform server images with provenance/SBOMs, exact/minor/major channels,
  and enrolled Compose startup gates with recovery to recorded image digests.

### New environment variables

- Optional, default off outside managed setup: `HIVE_AUTO_MIGRATE`, `HIVE_UPDATE_CHECK`,
  `HIVE_AUTO_UPGRADE`, `HIVE_UI_UPGRADE`, `HIVE_COMPOSE_UPGRADE_SUPERVISOR`.
- Optional coordinator policy: `HIVE_AUTO_UPGRADE_POLICY`, `HIVE_AUTO_UPGRADE_WINDOW`,
  `HIVE_AUTO_UPGRADE_TIMEZONE`, `HIVE_BACKUP_DIR`, `HIVE_UPDATE_REGISTRY`.
- Internal managed wiring: `HIVE_MANAGED_PROJECT`, `HIVE_COORDINATOR_SOCKET`.
- No new required secrets and no removed environment names. Managed initialization explicitly
  enables migrations/checks; unattended application stays off. Images enable backed-up migrations.

### Migration impact and compatibility

- Minimum tested adoption: launcher/Skills 1.1.0 and IAM/Router/HiveMem 1.0.3. Existing IAM
  SQL/checksums are preserved; format adoption is fast and does not destructively convert data.
- Startup no longer silently applies pending migrations without explicit opt-in. Explicit IAM
  migration does not provision signing keys, users or clients. Edited migration history fails closed.
- Wire formats remain compatible with existing 1.x consumers and SDK 1.0.3. Unknown peer versions
  warn. Old IAM code cannot accept unknown future migrations; incompatible rollback requires an
  explicitly reviewed data restore. No secret/signing-key rotation or regeneration is required.
- Launcher and all four servers move to 1.2.0; unchanged SDKs remain 1.0.3.

## [1.1.0] - 2026-11-01

### Added

- Launcher support for optional Hive Skills: install/configure/start, TLS and private state,
  Router integration, OS/PAM administration, status/doctor, and dependency-ordered shutdown.
  `--services all` includes Skills; the default three-service setup remains compatible.
- Skills `env-schema` and read-only `check` commands for launcher integration.
- Public `@hivemagnus/hive-skills` server package with a CLI, explicit environment-file loading,
  Hermes distribution scripts, bundled seed source, and fresh-install CI coverage.
- A migration runbook for existing systemd installations using pinned public npm packages.
- `npm run test:e2e:model`: environment-configured real-provider verification covering ordinary
  inference, streaming, SDK memory recall, authentication, traces and cleanup, with private reports
  and network-free regression tests.

### Changed

- Launcher and Skills packages are 1.1.0; unchanged servers/SDKs retain their versions.
  Release tags match the launcher, and publishing skips versions already on npm.
- Launcher-managed servers trust the generated local CA unless the user supplies a CA override.

### Fixed

- Skills resolves its deployment helper and bundled seed source from the installed package,
  and explicit initial seeding promotes the bundled release to the stable channel.
- Full-state backups retain systemd drop-ins and the active npm runtime's manifest and lockfile,
  so isolated recovery preserves service overrides and the inputs needed to reinstall code.

## [1.0.3] - 2026-10-31

### Fixed

- **Memory SDK**: context helpers preserve the server's formatted recall content, citations and
  token budget, and support nested retrieval records alongside legacy flat memories. Real model
  prompts no longer lose retrieved facts as `Memory: undefined`.
- **Router authentication**: client-key expiry in metadata is enforced, including existing keys
  without a database expiry. Expired or malformed metadata expiry fails closed.

## [1.0.2] - 2026-10-31

### Fixed

- **Hive console**: a fresh Router no longer appears degraded solely because the optional
  security exporter has not loaded IAM keys yet. The key-cache diagnostic remains visible,
  and aging or expired cached keys still degrade the Router status.

## [1.0.1] - 2026-10-31

### Added

- The Hive IAM server is published as the Docker image `ghcr.io/cheftaco/hive-iam-server`
  (`linux/amd64` and `linux/arm64`, with build provenance and an SBOM). The Compose example can
  run it instead of building (`IAM_IMAGE`), and `npm run check:iam-compose` runs that example end
  to end.

### Fixed

- **Privacy and authentication**: IAM access logs omit query strings; launcher diagnostics
  omit URL credentials, queries and fragments, and env quoting errors omit rejected values.
  Router strips credential-like caller headers before forwarding to providers and redacts them
  in traces. HiveMem rejects malformed JWT claims and returns safe JSON parse errors while
  continuing to accept legacy tokens that omit optional claims. Skills rejects malformed
  session signatures without a server error and updates its Hono server adapter.

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

[Unreleased]: https://github.com/ChefTaco/hive/compare/v1.0.1...HEAD
[1.0.1]: https://github.com/ChefTaco/hive/compare/v1.0.0...v1.0.1
[1.0.0]: https://github.com/ChefTaco/hive/releases/tag/v1.0.0
