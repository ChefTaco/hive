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
| Oathweave browser SSO | Disposable browser workflows pass; restored-account sign-in pending | PKCE, consent, MFA/passkeys, recovery, session/logout acceptance |
| Memory and workspace workflows | Disposable create/edit/search/delete, policy/membership and archive/restore pass | Remaining advanced memory, queue and integration parity |
| Security and chat UI consolidation | Candidate modules build; full parity pending | Existing route/workflow parity including files, sockets and approvals |
| Shell suite lifecycle | Fresh co-located core and lifecycle drills pass; full/multi-host gates pending | Unattended/interactive, resume, multi-host, backup/restore, upgrade tests |
| Host agent enrollment | Native Magnus artifact/heartbeat/job proof passes; other runtimes pending | Scoped model-agent identities, existing profile preservation and per-runtime acceptance |
| External inference | Verified HTTPS fixture and actual Emberpath enrollment/inference pass | Operator-owned endpoint acceptance through protected references; no inference provisioning |
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
write reconciliation. Inference services and their model storage remain external to Hive;
rehearsals never restore or launch model containers.

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
login, passkey, recovery, consent or step-up workflow. The optional disposable
`--browser-review` harness supplies generated accounts, a protected recovery outbox
and the real static console for separate browser acceptance. Browser reviews cover
passkeys, TOTP, recovery-code preservation, consent decline/retry, recent-session
step-up without mutation replay, one-use password recovery and prior-session
revocation. They never select or reset an existing installation's account.

`npm run test:suite:ingress` runs disposable bridge-network containers. It proves
explicit native/browser path mappings, identity-cookie isolation, native session
preservation, certificate-name rejection, streaming and WebSocket transport. It does not prove product-level
permissions, attachment access or migrated-data compatibility. Build the local
candidate images as described in `deployment/README.md` first.

The console has candidate security and chat modules, locally bundled brand fonts,
light/dark themes and lazy loading. The original Hive console pages are retained
as a porting baseline. Actor coordination, complete Skills deployment,
advanced chat administration and all permission/visual/accessibility parity still
need completion. Existing frontends remain active until those gates pass.

The Bash controller verifies signed manifests and image digests, plans placement,
checks hosts and applies constrained Compose definitions. Candidate lifecycle
adapters implement host-bound backups, isolated restore rehearsal, exact migrations,
compatible rollback, reconciliation-bound restore, explicit Compose adoption and
transaction receipts. The disposable SQLite lifecycle drill covers retries, restored
candidate execution and uncertain migration refusal. It does not certify interactive
full installs. Two host inventories now have real strict-SSH transport, interrupted
activation, input-drift refusal, stable retry and separate backup/restore proof
through `test:suite:multi-host`. Both SSH targets run on one physical developer
host; this does not certify a deployment across separate physical machines.
The renderer now assembles
signed ingress/static service kinds with a strict public-runtime allowlist and
read-only host preflight. Fresh co-located core configuration/bootstrap, real
terminal setup and unattended installation now have disposable end-to-end proof,
including stable credentials/IDs on retry, four-product sign-in and restore.
The core drill also verifies signed bundle upgrade and compatible rollback with
independent recovery gates and preserved credentials/account links. This proves
bundle activation with unchanged application/storage versions; it does not certify
untested application migrations.
Full/multi-host bootstrap and remaining native runtime integrations remain open.
No official suite manifest or publisher trust key has been released.
This is not an installation or migration release.

`test:suite:core -- --output NEW_PRIVATE_DIRECTORY --external-provider --lifecycle
--browser-review` keeps a developer-owned HTTPS protocol fixture outside the suite
inventory. Failed generation must precede any registration. Successful discovery,
generation and streaming are followed by real Emberpath ingress API enrollment,
idempotent alias/provider checks and an Emberpath inference request over verified
TLS. It installs no inference runtime or model. Browser review holds execution
before backups until its protected completion receipt is written.

Emberpath rehearsal mode skips external provider health probes and all trace or
credential-receipt retention. It reports those providers as unchecked, while local
database readiness remains enforced. Normal readiness retains provider checks.
Independent native backup rehearsals also run the current product candidates;
their data-integrity proof does not replace authenticated operator acceptance.

An optional host `sshConfig` selects an operator-owned protected SSH configuration;
strict host-key checking and non-interactive authentication remain mandatory.
Environment and read-only configuration mounts are fingerprinted before changes,
checked again before migrations and activation, and retained with release receipts.
Changing those files during a retry fails closed. Restore the original inputs, or
review the change and select a new `configurationRevision` before planning again.
Plans show the controller digest and exact signed image/product/storage versions.

The core restore drill uses private SQLite family copies, including WAL/SHM, for
integrity checks without writing the source. Any failed service aborts verification;
a later healthy datastore cannot mask it. Rehearsals retain selected dependency
ordering and private networks, force every network internal, publish no ports and
disable dispatchers/collectors. Sparse datastore files remain sparse in backups.
Controller source and recovery-archive digests are included in deployment evidence.

Ollama, llama.cpp, other inference services and hosted API providers are external
dependencies. Hive only records endpoints and protected credential references,
verifies HTTPS connectivity/model discovery/generation/streaming and registers
verified providers through Emberpath APIs. The current Bash protocol adapter supports
OpenAI-compatible and native Ollama APIs; other native provider protocols stay configured in Emberpath.
Emberpath owns routing, aliases, quotas and telemetry. Hive does not install or manage
inference services, model files, volumes, licenses, GPUs or hardware certification.
Obsolete managed-inference configuration, release profiles and existing draft Compose
resources are rejected with migration guidance, before lifecycle actions. Preserve all
existing model resources under their current owner. See `deployment/INFERENCE.md`.

`npm run test:suite` checks rejection without SSH, Docker or download calls.
`npm run test:suite:adapters` uses a synthetic external HTTPS provider and verifies
registration ordering, idempotence and unknown-outcome handling. Native artifact
launcher checks preserve existing profiles; they do not prove real agent enrollment.
The separate `test:suite:agents` rehearsal stages a real packaged Magnus agent,
verifies authenticated health and a recent heartbeat, and completes an authenticated
read-only command against a disposable Magnus API. Other runtime acceptance remains
pending. See `deployment/NATIVE_AGENTS.md` for explicit manual startup and acceptance.
`npm run test:suite:lifecycle` exercises the isolated candidate/recovery lifecycle.
None of these tests contacts or modifies a production installation.

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
resource access after logout. `npm run test:suite:containers` repeats this flow
using the actual non-root read-only images, with Redis on a separate internal
network and product APIs on a host-local bridge. The memory SDK's independent build and tests pass.

Owned OpenAPI baselines now live in the extracted repositories. Emberpath and
HiveMem inherit incomplete schema coverage; HiveSkills adds a source-derived route
inventory. Their drift checks do not claim full request/response contract coverage.
That remains a frontend cutover gate alongside released contract exports.

Synthetic desktop/mobile browser checks cover security/chat renders, theme changes,
mobile navigation disclosure, Escape focus restoration, reduced-motion preference
and horizontal overflow. Their API/WebSocket fixtures are synthetic. They do not
establish authenticated browser parity against real migrated product data.

Cindertrace's full workspace privacy walk encounters a pre-existing ignored
recovery tree. A fresh isolated export matching every indexed source file passes
the complete `npm run verify` suite, including its privacy walk, with zero findings.
The exact staged-byte scan also passes. Original recovery state is retained; the
operational checkout's broad filesystem scan still includes it. These candidate
checks are not migration or publication approval.

Direct Emberpath browser credentials cannot use retained IAM/Memory/Hive proxy or
coordinator routes or the legacy documentation paths, even with overly broad
permission claims. Protected documentation exposes only provider identity fields.
Browser skill
deployment mutations return an explicit unavailable state until the Magnus job
adapter exists. HiveXUI points suite lifecycle work to the controller. Native
compatibility flows remain available for recovery while those replacements are
completed.

HiveMem account links require an existing active identity and an explicit reviewed
credential-generation pin for rotated identities. Regressions cover missing and
disabled accounts, stale pins and native-token rotation. Workspace administration
and installation-specific mapping acceptance remain pending.


Isolated native-backup candidate acceptance now has a dedicated developer harness
in `deployment/REHEARSALS.md`. It verifies durable SQLite rows, native signing keys
and complete Qdrant payload/vector digests while keeping application networks
internal and background workers disabled. It excludes reviewed legacy model paths
from candidate copies and preserves original recovery archives. Results and account
links stay private. Historical snapshot success does not replace fresh backup,
complete browser parity, native agent or real external-provider acceptance gates.
Startup seeding now preserves existing Emberpath provider credentials and routing
edits; generated documentation synchronization avoids needless writes.
