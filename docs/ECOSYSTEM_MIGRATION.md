# Ecosystem separation

The current [implementation plan and pause checkpoint](ECOSYSTEM_IMPLEMENTATION_PLAN.md)
records superseding scope corrections, unfinished UI authentication work and
remaining acceptance gates. Historical checks below do not close the current
restored-data browser walkthrough gate.

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
| Independent backend builds and tests | Local required gates pass | Published images and released contract artifacts remain separate gates |
| Static HiveXUI extraction | Independent static build, owned contract checks and actual suite browser workflows pass | Released contract/image selection and restored-account browser acceptance |
| Direct product authorization | Implemented; receiving API regressions and immutable browser contracts pass | Installation-specific resource audience, permissions, revocation and step-up acceptance |
| Oathweave browser SSO | Disposable browser workflows pass; restored-account sign-in pending | PKCE, consent, MFA/passkeys, recovery, session/logout acceptance |
| Memory and workspace workflows | Native advanced operations, suite browser checks and actual HTTPS/HMAC worker delivery/restart pass | Existing permissions and operator-owned integration destination acceptance |
| Security and chat UI consolidation | Fresh conversation/admin/files/sockets and investigations pass; durable signed response safety and native-session revocation pass | Migrated-account browser and installation-specific acceptance |
| Shell suite lifecycle | Interactive/unattended core/full, custom and distributed SSH recovery pass; authenticated peer restores and compatible bundle upgrade/rollback pass | Separate physical-host and installation-specific acceptance |
| Host agent enrollment | Native Magnus heartbeat/job/user-service restart, integrated Ardent/Codex/Hermes/plugin recovery and optional native consumers pass | Selected existing profiles, provider authorization and persistent gateway supervision acceptance |
| External inference | Verified HTTPS fixture and actual Emberpath enrollment/inference pass | Operator-owned endpoint acceptance through protected references; no inference provisioning |
| Production adoption and migration | Pending | Installation-bound restored backup, single writer, acceptance and recovery proof |
| Published release and branding | Product directory and guides updated; publication pending | Publisher trust key, reviewed compatibility lock and published immutable artifacts |

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
Independent installations must never share product credentials, databases or backups.
An explicitly selected identity authority may coordinate them through separate
installation namespaces, with reviewed subjects and product-account links.

## Workflow parity

See [the candidate workflow checklist](WORKFLOW_PARITY.md) for ownership,
implemented workflows, available checks and installation-specific gates.

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
as a porting baseline. Oathweave now owns installation-scoped actor coordination and product-owned
atomic credential receipts. Real native enrollment tests now cover exact retry,
credential rotation, original expiry, old-generation refusal, containment and
one-time receipt acknowledgement. The migration proposal explicitly retains
installation namespaces and approved ownership links. Source journals that contain
no enrollment records are reported empty; synthetic legacy receipts have separate
import/reseal/expiry checks. Existing-account browser sign-in remains a separate
operator gate and does not trigger password resets or policy changes.

The Skills API now freezes exact publications, grants expiring one-use approvals
and delegates native execution to explicitly configured Magnus targets. A real
packaged agent installs a publication into a disposable profile; duplicate grants
and an interrupted effect cannot trigger an automatic second execution. Unknown
outcomes require receipt reconciliation. Unconfigured deployments remain visible
as unavailable. Installation-specific browser acceptance and any remaining parity gates
still gate retirement of the retained frontends.

The Bash controller verifies signed manifests and image digests, plans placement,
checks hosts and applies constrained Compose definitions. Candidate lifecycle
adapters implement host-bound backups, isolated restore rehearsal, exact migrations,
compatible rollback, reconciliation-bound restore, explicit Compose adoption and
transaction receipts. The disposable SQLite lifecycle drill covers retries, restored
candidate execution and uncertain migration refusal. The separate full-profile
driver covers an actual interactive wizard and unattended installation. Two host
inventories now have real strict-SSH transport, interrupted
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
Distributed fresh core bootstrap now passes across two real pinned SSH inventories,
with explicit verified HTTPS endpoints, interrupted activation, stable retry and
separate recovery. Both inventories use one physical developer host. Full-profile
bootstrap also passes explicit per-product migrations, an interrupted migration
whose committed outcome is verified without replay, interrupted activation,
stable retry, independent backups and isolated restores. Custom selection proves
that unselected model/memory services and their credentials are omitted, including
on an ingress-only host. The full drill includes offline integrity checks of all
three PostgreSQL stores and preservation of a chat post and account links.
Coordinated disposable copies of those restores also pass six resource audiences,
native chat sign-in, retained post/attachment reads, WebSocket ping and live-token
revocation, while original restore bytes remain unchanged. These copies retain
synthetic fixture accounts; they do not satisfy existing-account sign-in gates.
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
read-only command against a disposable Magnus API. The core driver additionally proves native Ardent model/memory operations and
pinned Codex Responses streaming through actual Emberpath. The public Hermes bundle
has read-only preflight, separately journaled profile initialization and actual
streaming acceptance. Its product-owned HiveMem plugin proves native provider
registration and workspace-scoped write/search/delete through an explicit HTTPS
memory ingress prefix. Separate native consumer drills verify Ardent Skills, scoped
Chat and embedded Emberfold checkpoint recovery, plus Hermes Skills tools and its
Mattermost adapter using an explicitly selected messaging artifact. An actual
Magnus user-service drill proves activation, stop/restart, renewed acceptance and
ownership-checked cleanup. Existing-profile authorization and persistent gateway
operation retain independent gates. See `deployment/NATIVE_AGENTS.md`,
`deployment/NATIVE_CONSUMERS.md` and `deployment/USER_SERVICES.md`.
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

Owned OpenAPI baselines now live in the extracted repositories. Emberpath's
provider/model/alias write and browser read contracts, and configuration recovery
contract, have independent browser-safe exports pinned by revision and checksum.
Provider/alias responses exclude protected credential fields. Actual version-one
download/import and provider/alias edits pass in the final suite browser; database
regressions prove preserved credentials, reconciled provider references and atomic
rollback of configuration and audit on failure. Other inherited Emberpath and
HiveMem routes retain incomplete response schema coverage; HiveSkills adds a
source-derived route inventory. Drift checks do not imply complete coverage.
Released contract artifacts remain a frontend cutover gate.

Current identity/account/enrollment, Skills, security and chat modules now also
consume immutable owner exports, including their native response envelopes and
request refinements. Read/list responses omit native archive paths and protected
provider relations; one-time credentials use uncached responses. Cross-product
incident summaries now compose authorized trace, identity audit and scoped memory
queue reads in the browser, project only explicit safe details and report missing
sources. Legacy coordinator endpoints remain reserved for retained native recovery.
Memory browser pagination now uses its native offset and has a populated multi-page
browser regression, alongside actual CRUD and generated URL/array-bound checks.

Synthetic desktop/mobile browser checks cover security/chat renders, theme changes,
mobile navigation disclosure, Escape focus restoration, reduced-motion preference
and horizontal overflow. Their API/WebSocket fixtures are synthetic. They do not
establish authenticated browser parity against real migrated product data.

Cindertrace's workspace privacy walk now excludes its ignored local recovery tree,
matching the existing runtime-directory exclusions. The separately reviewed
correction preserves exact staged-index and publication-artifact scans, including
forbidden recovery paths. Its complete verification suite passes while the original
recovery state remains retained. The API owns optional local browser sessions and
preserves existing Redis session keys, revocation generations and throttling; the
retained console can delegate to it. Real API/console browser interoperability and
revocation pass in fresh disposable containers. These checks do not authorize
production identity migration or cutover.

Direct Emberpath browser credentials cannot use retained IAM/Memory/Hive proxy or
coordinator routes or the legacy documentation paths, even with overly broad
permission claims. Protected documentation exposes only provider identity fields.
Browser skill
deployment mutations require an explicitly configured Magnus adapter, exact target
grants and publication approval; absent capabilities remain unavailable.
HiveXUI points suite lifecycle work to the controller. Native
compatibility flows remain available for recovery while those replacements are
completed.

HiveMem account links require an existing active identity and an explicit reviewed
credential-generation pin for rotated identities. Regressions cover missing and
disabled accounts, stale pins and native-token rotation. Workspace administration and native advanced memory workflows have independent
regression and browser proof. Installation-specific mapping and real-data acceptance
remain separate gates.

HiveMem's native webhook worker has actual scoped HTTPS/HMAC delivery proof,
including API-visible outcomes, failure reporting, restart without completed-job
replay and disabled-endpoint refusal. Cindertrace's database-backed dispatcher
passes expired and changed approvals, concurrent one-use dispatch, invalid/lost
receipts, durable unknown outcomes and process restart without duplicate commands.
Its synthetic signed HTTPS executor performs no host operations. These disposable
checks do not authorize a real destination or response target.


Isolated native-backup candidate acceptance now has a dedicated developer harness
in `deployment/REHEARSALS.md`. It verifies durable SQLite rows, native signing keys
and complete Qdrant payload/vector digests while keeping application networks
internal and background workers disabled. It excludes reviewed legacy model paths
from candidate copies and preserves original recovery archives. Results and account
links stay private. Historical snapshot success does not replace fresh backup,
complete browser parity, native agent or real external-provider acceptance gates.
Startup seeding now preserves existing Emberpath provider credentials and routing
edits; generated documentation synchronization avoids needless writes.

Fresh full-suite browser checks exercise native chat WebSockets, message/thread
writes, reactions, authenticated attachments, and credential-free file URLs. They
also exercise signed security ingestion, an investigation revision and preserved
evidence with dispatch and retention disabled. An unexpired security bearer and
an existing native chat session work immediately before logout and fail afterward;
token expiry is not used as revocation evidence. Desktop/mobile checks include
one main landmark, no horizontal overflow and automated accessibility checks.
These fresh synthetic checks are distinct from authentication against restored
historical accounts, and never authorize a production cutover.

Existing security and chat data have a separate reusable rehearsal contract in
`deployment/EXISTING_DATA_REHEARSALS.md`. Read-only online capture and isolated
restores preserve product rows, files, runtime configuration and Redis expiry
semantics. Existing native chat administrator/agent authentication and an attachment
read pass without linking historical agent or test accounts. Security readiness,
unauthenticated denial and disabled-dispatch checks pass. Missing current security
operator credentials and expired identity passwords remain operator gates. These
online captures do not substitute for a coordinated maintenance-window backup.

Oathweave now preserves independently created sessions with the same IP address
and user agent. Those signals are risk metadata, not session identities. Heuristic
session deduplication refuses changes; operators select exact session IDs to revoke.
Browser regression and restored-session checks remain part of candidate acceptance.

The current private adoption inventory does not select an existing Magnus fleet or
Ardent profile. Their fresh-container and native fixture checks cannot stand in for
a migration of existing fleet state. Future adoption requires selected effective
configuration, a current database checkpoint and retained keys, plus each selected
profile's independent backup and isolated restore. The optional Emberfold HTTP
service is stateless; contexts remain owned by callers and embedded SDK profiles.

Unknown or expired operator passwords do not authorize password resets or policy
changes. A separately copied authentication fork may use a clearly named temporary
account with distinct runtime signing/session keys and issuers, temporary product
accounts and explicit links; it preserves all original users and recovery inputs.
Its browser proof does not close an existing-administrator ownership or sign-in
gate. The [rehearsal runbook](../deployment/REHEARSALS.md) also documents central
HiveXUI authorization, explicit Oathweave browser discovery and optional standalone
Cindertrace sign-in. These integration instructions do not claim production
configuration or cutover.
