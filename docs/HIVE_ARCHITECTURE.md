# Hive Architecture

Hive combines identity, memory, and model-routing operations into one repo and one operator console.

## Services

`services/hive-iam` owns identity, JWT/OAuth flows, roles, groups, service accounts, Linux user mapping, and the Node middleware SDK. It is strict TypeScript and deploys as `hive-iam.service` under `/opt/hive-iam`.

`services/hive-mem` owns semantic memory, sessions, task history, queue/consolidation, dashboard APIs, and the HiveMem dashboard. It runs the strict TypeScript core (`services/hive-mem/ts-core`) as `hivemem.service` under `/opt/hivemem`, backed by the existing Qdrant store. The old Python/FastAPI service has been removed from the repo.

`services/hive-router` owns provider routing, OpenAI-compatible API compatibility, trace/audit views, and the unified Hive UI. It is strict TypeScript and deploys as `hive-router.service` under `/opt/hive-router`.

`services/hive-skills` owns the Hermes Skills registry. It is a strict TypeScript/Hono service with SQLite metadata, immutable SHA-256 verified archives, PAM-backed OS operator authentication, and an audit log. It deploys as `hive-skills.service` under `/opt/hive-skills` and intentionally updates Hermes through a user-level pull timer instead of modifying Hermes Agent core.

## Unified UI

The Hive UI is delivered by Hive Router's admin plane. It keeps Router's OS/PAM login and operator allowlist model and adds major app pages:

- Hive overview with an animated lattice for IAM, Memory, and Router.
- IAM page with typed health/status data from Hive IAM.
- Memory page with native HiveMem search, browse, CRUD, graph/conflict inspection, queue controls, webhook inspection, stats, recent memories, sessions, agents, and queue state. The legacy HiveMem `/dashboard` remains proxied for deeper operations.
- Actors page that computes one inventory across IAM users, service accounts, Linux system users, Router client keys, and Memory agents.
- Incidents page that groups failed Router traces and IAM audit denials/failures by `x-hive-request-id` or a short failure window.
- Router page plus the existing provider, routing, testing, trace, key, audit, docs, and settings tools.

Status data is provided by `GET /api/hive/status`, which probes local service health endpoints and returns a typed JSON summary to the React UI. Operator views are backed by `GET /api/hive/actors`, `GET /api/hive/incidents`, and `/api/memory/*`. The Memory endpoints use `HIVE_ROUTER_MEMORY_PROXY_TOKEN` server-side so browser code never stores a HiveMem bearer token. Router deploy recovers that token from `HIVE_ROUTER_MEMORY_PROXY_TOKEN` or the HiveMem env keys `HIVEMEM_ADMIN_TOKEN`, `HERMES_HIVEMEM_TOKEN`, and `HIVEMEM_MCP_TOKEN`.

## Deploy Topology

Each host you deploy to is an independent installation. Content, databases,
identity/credential state, memory workspaces, and Skills assignments are never
shared between installations, and matching code versions do not imply matching
data or configuration. Deploy and verify each host separately with its own
private env, certificate trust, backup archive, and acceptance results. Never
restore one installation's archive onto another or copy credentials between
hosts to eliminate drift.

`npm run deploy` requires `HIVE_DEPLOY_HOST` (the SSH host) and `HIVE_PUBLIC_FQDN`
(the DNS name the Router serves), for example `HIVE_DEPLOY_HOST=hive` and
`HIVE_PUBLIC_FQDN=hive.example.com`. Run it again with different values, such as
`memory-host` and `memory.example.com`, to deploy the same full-server shape to
another host. Set `HIVE_DEPLOY_SKILLS=true` on the host that should also run Hive
Skills. Operational tools (`doctor`, `audit:deployments`, `backup`) read the host
list from `HIVE_HOSTS`, a comma-separated list of `host:fqdn[:services]` entries
such as `hive:hive.example.com:skills,memory-host:memory.example.com`.

- HiveMem serves HTTPS on `HIVEMEM_WEB_PORT`; in the official Hive stack this is internal port `18443`.
- Hive IAM serves HTTPS on port `4200` and uses local Redis for audit queue processing.
- Hive Router serves API HTTPS on `4020` and the official unified UI/admin HTTPS on public `443` for `HIVE_PUBLIC_FQDN`.
- Hive Skills serves its own TLS listener on `4030`, reusing the Router-managed server certificate. Hermes hosts pull `GET /v1/agent/manifest` and release archives from this listener.
- HiveMem serves HTTPS internally on `18443` for the official Hive stack. Router proxies `/v1/*`, `/dashboard`, and `/dashboard/*` back to HiveMem so existing memory clients and old dashboard bookmarks continue to work.

The root deploy script runs Memory first on its internal HTTPS port, then IAM, then Router. IAM deploy ensures Redis is installed and active before restarting `hive-iam.service`; first install persists the generated Router client secret in protected IAM env so Router can mint server-side IAM proxy tokens. An existing host without that handoff fails closed and requires audited credential recovery. Router deploy finishes by installing a TLS certificate for the target FQDN (for example one issued by your private network or ACME provider), binding the unified UI/admin listener to `443`, recovering protected IAM/Memory proxy secrets through sudo when needed, and probing IAM plus Memory through service-local URLs.

Router pins the current HiveMem certificate at deploy time and addresses the
internal listener through the certificate's public-FQDN SAN. The Memory-first
order ensures Router always receives the newly issued leaf. Production startup
and deploy both reject `HIVE_STATUS_ALLOW_INSECURE_TLS=true`; the IAM and
HiveMem probes, proxy paths, deploy health gates, and rollback gate retain
certificate and hostname verification.

IAM TLS uses a host-persistent private CA under root-only `/var/lib/hive-iam-pki`. IAM deploys issue a 30-day server leaf for the configured public FQDN, the target's short hostname, `localhost`, and loopback. Router and approved private-CA clients trust `/opt/hive-iam/certs/ca-bundle.crt`; it contains the current CA and, during a controlled rotation, the staged `next-ca.crt`. Every probe keeps certificate and hostname verification enabled. Leaf renewal therefore does not alter a client's trust anchor, and CA rollover can distribute both anchors before any leaf switches issuers.

The optional `example-portal` confidential client shows the least-privilege
pattern for an external application that reads from Hive. Client-credentials
tokens carry audience `example-portal`, client ID `example-portal`, and only
`example-portal:read`; the token service filters any requested permission outside
that allowlist. Authorization-code tokens for the same first-party client also
carry the client-specific audience. The consuming application validates the
signature through IAM's JWKS and enforces issuer, audience, client ID, and
permission before trusting a result.

IAM signing key IDs are RFC 7638 SHA-256 thumbprints derived from the active RSA key. The JWKS publishes the active public key first and may publish retired public keys during an overlap. Tokens are always signed with the active thumbprint. The root-only keyring uses atomic releases under `/var/lib/hive-iam-keyring`; `hive-iam` can read the active release but cannot modify it. Its fsynced transaction journal reconciles interrupted `prepared`, `activated`, or `verified` operations before another rotation. Activation and rollback checks use the managed private CA and compare the exact live RSA material, not only `kid`. Run `/usr/local/libexec/hive-iam/rotate-jwt-signing-key.sh` through sudo to rotate, wait at least `JWT_ACCESS_TTL`, then use `--prune-expired` to remove retired verification keys. Retired private keys are destroyed after a verified cutover rather than archived, and hash-chained receipts are written only after deletion and directory fsync succeed.

## Verification

The deployed UI is verified at `HIVE_PUBLIC_FQDN`, OS/PAM login as an allowlisted operator, and `GET /api/hive/status`. A healthy status payload reports IAM, Memory, and Router as `online`; IAM exposes database and Redis checks, Memory exposes HiveMem health, and Router reports providers, route rules, and trace counts. Deploy proof should also smoke `/api/hive/actors`, `/api/hive/incidents`, `/api/iam/users?limit=1`, `/api/memory/dashboard-data`, and `/api/memory/search?query=&limit=25` through an authenticated Router session on every installation.
