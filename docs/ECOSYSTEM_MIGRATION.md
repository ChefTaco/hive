# Ecosystem separation

The target is a Bash-controlled Docker suite with independently released products:
Emberpath (models), Oathweave (identity), HiveMem (memory), HiveSkills (registry),
HiveXUI (static browser application), Magnus/Ardent (fleet/runtime), Cindertrace
(security), ChatterMost (chat), and Emberfold (context).

## Migration ledger

This ledger distinguishes implemented extraction from accepted deployment. A
source snapshot or passing unit test is not evidence of a production cutover.

| Gate | State | Evidence required to close |
| --- | --- | --- |
| Public source inventory and provenance | Implemented | Per-product provenance.json records source revision and original file hashes |
| Independent backend builds and tests | In progress | Clean installation, typecheck, build, existing regression suites |
| Static HiveXUI extraction | Build/container and synthetic render checks pass | No backend imports; browser render and workflow acceptance |
| Direct product authorization | Implemented; bounded regression tests pass | Resource audience, permissions, revocation and step-up regression tests |
| Oathweave browser SSO | Protocol acceptance passes; complete UX pending | PKCE, consent, MFA/passkeys, recovery, session/logout acceptance |
| Security and chat UI consolidation | Candidate modules build; full parity pending | Existing route/workflow parity including files, sockets and approvals |
| Shell suite lifecycle | In progress | Unattended/interactive, resume, multi-host, backup/restore, upgrade tests |
| Host agent enrollment | Pending | Scoped credentials, existing profile preservation, real heartbeat/job proof |
| CPU/CUDA/ROCm inference | Pending | Physical hardware generation and streaming proof for each supported profile |
| Production adoption and migration | Pending | Installation-bound restored backup, single writer, acceptance and recovery proof |
| Published release and branding | Pending | Verified artifacts, compatibility lock and accurate walkthroughs |

## Source inventory and ownership

The extracted Router currently includes administration, IAM/Memory proxying,
actor enrollment and upgrade coordination. Those compatibility paths remain until
their product-owned replacements pass acceptance. UI assets are extracted into
HiveXUI; Emberpath no longer builds or packages the browser application.

Oathweave retains immutable IAM migrations, JWT keys/issuer configuration, users,
roles, sessions and client registrations. HiveMem retains its TypeScript core,
SDKs and Python Hermes integration. HiveSkills retains its archives, registry,
assignment policies and native clients. Each snapshot vendors the existing
recovery engine as build tooling so it does not import another checkout.

Existing Hive services, public packages, tags and recovery procedures remain
available. Do not remove or reseed an existing deployment to demonstrate progress.
Independent installations must never share credentials, databases or backups.

## Workflow parity

- Models: providers, discovery, model aliases, routing objectives/rules,
  heuristics, generation/testing, streaming/failover, client quotas, traces,
  audit, configuration import/export and revision recovery.
- Identity: users, roles, groups, service accounts, clients, sessions, password
  policy, MFA/passkeys, devices, step-up, audit and host-account mappings.
- Memory: search/browse/CRUD, workspaces, agents, sessions, graph/conflicts,
  conclusions, queue operations, webhooks and delivery inspection.
- Skills: catalogue, immutable archive releases, channels, assignments, pull
  manifests, compatibility filtering, deployments and audit.
- Security: overview, sources, events, entities, cases, evidence, investigation
  revisions, policies, assurance, response preview/approval, audit and lab.
- Chat: teams/channels/DMs, threads, reactions, members, attachments/previews,
  profile images, search, administration, bots, realtime updates and native clients.

## Cutover rules

Inventory the real installation privately before adoption. Preserve issuer URLs,
keys, identities, migration history, audit chains and storage. Restore a backup in
isolation with external dispatch disabled, test the candidate, then stop the old
writer before routing traffic to the replacement. Preserve the previous runtime.
Binary rollback requires data compatibility; database restore requires explicit
write reconciliation. No hardware profile is certified without hardware proof.

## Current verification boundary

The five extracted products build independently. Oathweave public clients enforce
exact redirects and S256 PKCE, bind authorization codes to server sessions, issue
resource-specific permissions, and support a separate HTTPS browser issuer without
changing native JWT issuers. Browser tokens stay in memory. Core resource APIs
require reviewed issuer/subject links to local product IDs. Cindertrace also caps
roles by explicit local mappings; ChatterMost retains native role/membership state
and exchanges authorized identity for encrypted, revocation-bound native sessions.
Native machine credentials remain independent of human browser SSO.

`npm run test:suite:sso` starts disposable Oathweave/Redis/SQLite with verified local
TLS. It proves code replay rejection, native/browser issuer separation, exact
resource permission claims and logout revocation. It does not prove every browser
login, passkey, recovery, consent or step-up workflow.

`npm run test:suite:ingress` runs disposable bridge-network containers. It proves
explicit native/browser path mappings, unchanged user headers, certificate-name
rejection, streaming and WebSocket transport. It does not prove product-level
permissions, attachment access or migrated-data compatibility. Build the local
candidate images as described in `deployment/README.md` first.

The console has candidate security and chat modules, locally bundled brand fonts,
light/dark themes and lazy loading. The original Hive console pages are retained
as a porting baseline. Memory aggregation, actor coordination, Skills workflows,
advanced chat administration and all permission/visual/accessibility parity still
need completion. Existing frontends remain active until those gates pass.

The Bash controller verifies signed manifests and image digests, plans placement,
checks hosts and applies constrained Compose definitions. It refuses unsupported
agent/inference selections and lifecycle operations rather than reporting partial
success. Interactive generation currently requires further component setup.
Backup/restore/adoption/upgrade/rollback adapters, ingress assembly, complete
preflight, secrets/bootstrap, interrupted multi-host recovery, agent installation
and managed inference remain open. No official suite manifest or publisher trust
key has been released. This is not an installation or migration release.

Operational identity inventories and proposed account links are private ignored
artifacts, with independent installation boundaries and explicit pending decisions.
Agent and historical chat test accounts must not be inferred to be human
users from their bot flags. Existing identity and product state has not been changed.

## Verified candidate checks

The local extraction pass has passing typechecks/builds and bounded regressions:
Emberpath's resource auth preserves a reviewed existing local ID; Oathweave's
native/browser issuers remain distinct; HiveMem and HiveSkills deny unlinked
subjects; ChatterMost preserves encrypted session binding through store reload and
accepts only explicitly configured console origins for cookie mutations/sockets.
The real Oathweave-to-Emberpath HTTP test denies unauthorized writes and rejects
resource access after logout. The memory SDK's independent build and tests pass.

Owned OpenAPI baselines now live in the extracted repositories. Emberpath and
HiveMem inherit incomplete schema coverage; HiveSkills adds a source-derived route
inventory. Their drift checks do not claim full request/response contract coverage.
That remains a frontend cutover gate alongside released contract exports.

Synthetic desktop/mobile browser checks cover security/chat renders, theme changes,
mobile navigation disclosure, Escape focus restoration, reduced-motion preference
and horizontal overflow. Their API/WebSocket fixtures are synthetic. They do not
establish authenticated browser parity against real migrated product data.

Cindertrace's full workspace privacy walk encounters a pre-existing ignored
recovery tree. Exact staged-byte and clean public-candidate scans pass with zero
findings. Recovery state is retained. The complete workspace gate remains open;
this source is not a migration or publication approval.
