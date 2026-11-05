# Changelog

All notable changes to this project are documented in this file. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project follows
[Semantic Versioning](https://semver.org/).

## [2.0.1] - 2026-11-05

A controller-only release. `releases/2.0.1.json` pins exactly the images and versions of 2.0.0;
only `hive.sh` changes.

### Fixed

- `hive.sh migrate-native cutover` no longer rolls back a busy installation. Verification compared
  the running suite with the copy taken when the native services stopped, so the writes of
  clients that reconnected in the seconds before it ran failed it: an Emberpath API key recording
  its use, and memory traffic and the memory worker changing vectors. Verification now has two
  phases. Preservation compares the migrated copy exactly (every row, password hash, signing key,
  the issuer, every vector and every Redis record) after the product migrations and before the
  suite starts, while no port is published and no product or memory worker runs. The serving
  checks then run while clients use the suite: ports, exact certificates, a machine token signed
  by the native key with the native issuer, native memory credentials on both ports, the signing
  keys and the native store bytes, and the credential rows, where a client may change only
  `ClientApiKey.lastUsedAt` and `updatedAt`. Rollback is unchanged. See
  `deployment/MIGRATE_NATIVE.md`.

### Changed

- `hive.sh migrate-native verify` checks a live suite without failing on client writes: the
  preservation receipt of its cutover, the serving checks and the invariants no client changes.
  It writes `migration/live-verification.json` and no longer compares rows or vectors.
- A cutover started with 2.0.0 and not finished cannot be continued by this controller: roll it
  back, then run `prepare` and `cutover` again. A suite that a 2.0.0 cutover verified passes
  `verify`, which accepts that exact verification as its receipt.

## [2.0.0] - 2026-11-05

The first Hive suite release. `./hive.sh --release 2.0.0` installs the core or full profile from
the signed manifest `releases/2.0.0.json`, which pins Oathweave 2.0.1, Emberpath 2.0.1, HiveMem
1.3.1, HiveSkills 1.3.1, HiveXUI 0.1.1, Magnus 2.1.1 (with the optional fleet gateway), Cindertrace
0.2.1, ChatterMost 0.4.1, Emberfold 0.2.1, the Hive Registry and the ingress by image digest. No npm
package is published for this release; the legacy npm packages stay on their 1.x line.

### Security

- Every image the 2.0.0 manifest pins has no CRITICAL or HIGH finding with a fix available, on linux/amd64 and linux/arm64 (`scripts/release/scan-suite-images.sh`). The product images drop npm, npx, corepack and apt from their runtime. The ingress is `hive-ingress:2.0.2`, Caddy 2.11.7 compiled with Go 1.26.10, `golang.org/x/net` v0.60.0 and go-jose v4.1.6, which fixes CVE-2026-78669 (HTTP/2 SETTINGS flood) and the other Go findings of the upstream 2.11.7 build. PostgreSQL, Redis and Qdrant ship as hardened suite images (`hive-postgres`, `hive-redis`, `hive-qdrant`); see `deployment/README.md`.
- Accepted exceptions, each scoped to one image in `deployment/trivy/`: go-jose v3 CVE-2026-116587 (no fixed release; only reachable through Caddy's PKI app, which the suite never enables) and, in `hive-qdrant`, pyo3 GHSA-36hh-v3qg-5jq4 and quinn-proto GHSA-4w2j-m93h-cj5j (listed in Qdrant's bundled SBOM but not linked into its binary).
- `hive-ingress:2.0.0` and `2.0.1` were published from `main` before these fixes and are not used by any release.
- HIGH and CRITICAL findings with no fix available upstream, as scanned on 2026-11-05:
  - Debian 12 base of every product image, `hive-registry` and `hive-redis`: CVE-2023-45853 (zlib, CRITICAL, will not be fixed), CVE-2026-76844 (zlib), CVE-2025-69720 (ncurses), CVE-2026-16742 (libsystemd0, libudev1), CVE-2026-41992 (gzip), CVE-2026-53613, CVE-2026-53615 and CVE-2026-78410 (util-linux), CVE-2026-54369 (libacl1), CVE-2026-9538 (perl-base); `magnus-server` and `cindertrace` also CVE-2023-2953 (libldap).
  - Debian 13 base of `hive-postgres` and `hive-qdrant`: CVE-2025-69720, CVE-2026-119373, CVE-2026-16742, CVE-2026-54369, CVE-2026-76642, CVE-2026-76844, CVE-2026-78408, CVE-2026-78409, CVE-2026-78410 and CVE-2026-9538; `hive-postgres` also CVE-2026-24882, CVE-2026-6653, CVE-2026-74860 and CVE-2026-86138 to CVE-2026-86144 (except CVE-2026-86141).
  - `hive-ingress`: CVE-2026-116587 (go-jose v3, see above). `hivexui`: none.

### Added

- Publish signed suite releases: `releases/X.Y.Z.json` with its Ed25519 signature and the publisher key `trust/publisher.pub`, built by `scripts/release/build-suite-manifest.mjs` from the service contracts in `scripts/suite/release-contracts.mjs` (which the developer proofs now share) and checked by `scripts/release/check-suite-release.sh`. The *Suite release* workflow publishes the suite images from `main` and the GitHub release from the tag. See `docs/RELEASING.md`.

- Add the Magnus fleet gateway as an optional suite component, `magnus-gateway`, with the ingress routes for the browser terminal under `/api/magnus/terminal/*`. It is off by default, and no release profile can select it. `bootstrap.magnusGateway.grantTerminalToInitialOperator` is the separate choice that lists `magnus:terminal` in the `hivexui-magnus` client, which a fresh install no longer does. `hive.sh magnus-trust` approves each node's host key with a fingerprint read on the node.

- Configure Magnus with `RESOURCE_ENROLLMENT_DASHBOARD_PARTICIPANT=absent` when no gateway is selected, so nodes can pass a resource drain.

- Route `GET /api/magnus/docs/openapi.json` to Magnus's public API document.

- Add `hive.sh migrate-native`, which moves an existing native installation onto the suite on its native ports with its issuers, keys, accounts and data, with `plan`, `prepare`, `cutover`, `verify` and `rollback`, and a one-use token for setting the administrator password. See `deployment/MIGRATE_NATIVE.md`.
- Add `backup-hive.sh --online`, a capture for rehearsals that never stops a service. It is not a coordinated recovery point.
- Add the Hive Registry, a mandatory container in every installation: a SQLite install catalog and read-only lookup API at `/api/registry`, written by `hive.sh` from the signed manifest and observed state. `hive.sh registry` looks up entries and manages externally managed products, `status` and `doctor` report drift, and upgrade and adoption add it to existing installations. Not related to the HiveSkills skills registry.

- Publish `ghcr.io/cheftaco/hive-registry` and `ghcr.io/cheftaco/hive-ingress` (linux/amd64 and linux/arm64) from the *Suite release* workflow. `publish.yml` now runs only for legacy `v1.*` tags and no longer builds them.

- Wire Magnus into the suite with HiveXUI as its console: an Oathweave browser client and explicit ADMIN link for the fresh operator, and an `/api/magnus` ingress mapping limited to Magnus's browser-facing routes that forwards no machine credential. `bootstrap.magnusConsoleOrigin` is removed, and a configuration that still sets it is refused with a clear message.

- Add `hive.sh install|upgrade --relax-auth-limits` for testing. It renders the setting for Oathweave, Cindertrace and ChatterMost, is part of the plan digest, and is reported as `authLimits` by the plan and `hive.sh status`.

- Document isolated temporary-account authentication forks and central public-client authorization without weakening existing-account acceptance or changing production identity.

- Verify immutable product-owned browser contract integration, native memory
  pagination and direct authorized incident summaries across the extracted console.

- Record candidate workflow parity, final browser contract checks, authenticated
  peer restores and native consumer acceptance with explicit installation gates.

- Report current native user-service state separately from historical acceptance, and rehearse real user-manager activation, stop/restart, authenticated work and ownership-checked cleanup.

- Verify immutable Skills list/view and scoped Chat adapter consumption with a separately selected public native Hermes messaging artifact, retaining protected profile bytes and explicit gateway supervision limits.

- Rehearse packaged native agent consumption of immutable Skills, scoped Chat WebSockets and the embedded Emberfold SDK in disposable HTTPS fixtures with source-preserving checkpoint recovery.

- Complete integrated native Codex acceptance through the signed Bash adapter and document existing-data rehearsal boundaries.

- Rehearse explicitly captured existing security and chat stores in isolated candidate containers, retaining native account IDs, archives and protected credentials with exact row/file integrity checks and online-backup consistency limits.

- Prepare optional exact Skills host mappings with publisher-verified immutable native clients, protected owner proposals and read-only Magnus readiness checks; incomplete enrollment remains held without activating mappings or dispatching jobs.

- Rehearse coordinated identity enrollment and native Hermes streaming with a
  separately scoped HiveMem plugin, preserving profile credentials through
  product-owned initialization, exact retry, backup and isolated restore.
- Bootstrap custom product selections without allocating unselected backend
  credentials; journal native profile setup before invoking product-owned writes.
- Expand fresh full-suite browser verification for security investigations,
  evidence, native chat sessions, attachments, WebSockets and unexpired revocation.

- Verify scoped native Codex Responses streaming through Emberpath, including
  compressed requests, aliases, protected profiles and cross-product rejection.
- Keep every product's native session cookies at its owning API; preserve bearer
  clients, streaming and chat WebSocket transport at shared HTTPS ingress.
- Rehearse a packaged native Ardent gateway with distinct scoped model and memory
  identities, private CA verification, preserved profiles and isolated recovery.
- Verify native artifact versions, bind extracted contents and credential files to
  retries, isolate launcher environments and record explicit product acceptance.
- Add native-agent acceptance and per-host status summaries; rehearse a packaged
  Magnus agent with verified TLS, heartbeat and an authenticated read-only job.
- Configure protected external-provider enrollment through standalone or suite
  ingress APIs, with interactive CA/credential references and explicit aliases.
- Verify actual Emberpath enrollment and inference after external HTTPS acceptance,
  followed by signed core bundle upgrade, compatible rollback and isolated recovery.
- Pin deployment input files through retries, migrations and activation, with
  explicit configuration revisions and release recovery fingerprints.
- Support protected per-host SSH configuration and rehearse two SSH inventories
  through interrupted activation, credential-drift refusal and isolated recovery.
- Add complete terminal core configuration, protected first-install bootstrap,
  scoped product account links and private initialization before ingress activation.
- Retain controller source/archive digests with release recovery artifacts.
- Exercise interactive and unattended core installation, four-product SSO,
  repeated execution, verified backup and isolated restoration on actual containers.
- Preserve sparse backups and fail immediately on any database integrity error;
  check SQLite WAL families through private copies and retain rehearsal dependencies.
- Isolate identity cookies at shared ingress while preserving native product sessions, streaming and WebSockets.
- Add disposable-account browser rehearsal support for consent, MFA, passkeys, recovery and step-up authentication.
- Separate unprivileged HTTPS ingress/static-console deployment candidate and
  disposable native/container SSO, resource API and protocol transport acceptance.
- Experimental shell suite controller with offline installation plans, signed
  release verification, constrained per-host Compose rendering and fail-closed
  activation. Candidate lifecycle and native-agent adapters include protected recovery
  receipts and isolated tests; production migration gates remain held.
- External-only inference endpoint verification and Emberpath provider enrollment.
  Reject obsolete managed-inference settings and manifests with migration guidance;
  preserve existing model resources and hold legacy inference projects before changes.
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

[2.0.0]: https://github.com/ChefTaco/hive/releases/tag/v2.0.0
[1.0.1]: https://github.com/ChefTaco/hive/compare/v1.0.0...v1.0.1
[1.0.0]: https://github.com/ChefTaco/hive/releases/tag/v1.0.0
