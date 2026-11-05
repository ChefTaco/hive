# Candidate workflow parity

See the [current plan](ECOSYSTEM_IMPLEMENTATION_PLAN.md) for
unfinished work and verification limits. In particular, loading placeholders and
navigation scripts that finish before background requests settle do not establish
screen parity.

This checklist records product ownership and the available candidate checks. A
fresh fixture, an existing-data restore and a production migration are separate
acceptance decisions. Keep retained native clients, legacy consoles and release
archives until the installation-specific gates pass.

| Product | Retained workflows | Candidate checks | Installation-specific gate |
| --- | --- | --- | --- |
| Oathweave | Users, roles/groups, service identities, clients, sessions, host mappings and audit | Independent API tests; PKCE, consent, passkeys, TOTP, recovery, step-up and targeted session revocation browser drills | Existing operator sign-in, unchanged issuer/keys/registrations and reviewed account links |
| Emberpath | Providers and discovery, aliases, rules, heuristics, quotas, testing, streaming, traces, audit and configuration recovery | Owned request/read contracts for all current model-console workflows; verified external HTTPS protocols, native clients, browser edits/generation and configuration recovery; atomic update and nested-secret regressions | Real external endpoint and protected credential authorization; installation routing acceptance |
| HiveMem | Browse/search/CRUD, workspace ownership/membership, sessions, graph/conflicts, consolidation, queue and webhooks | Scoped API regressions and browser operations; actual managed worker, HTTPS/HMAC outcomes, history and restart; source data/vector restoration | Existing workspace permissions and real integration destinations |
| HiveSkills | Catalogue, immutable releases, compatibility, channel assignments, targets, credentials, distributions, approvals and audit | Browser publication/assignment/enrollment; actual native sync, exact one-use approval, interruption and original-receipt reconciliation | Reviewed target mappings, approved Magnus node enrollment and each live consumer |
| Cindertrace | Overview, sources, events/entities, cases, revisions, evidence, policies, assurance, response review, audit and lab | Native/API console interoperability; signed ingestion and investigation browser checks; real database/signed HTTPS expiry, concurrent approval, one dispatch and durable unknown outcomes | Current operator login, retained evidence/audit state and approved response targets |
| ChatterMost | Teams/channels/DMs/groups, membership, threads, reactions, files/previews, profiles, search, administration, supervision and bots | Actual browser conversations/admin, native sessions/WebSockets/attachments, interrupted credential receipts, accessible desktop/mobile renders | Existing native sessions, product ownership/membership and each migrated agent |
| Magnus / Ardent | Existing fleet console, authenticated native jobs and host execution | Non-root API/queue isolation, transactional first initialization, native heartbeat/read-only job, actual user-service stop/restart and scoped Ardent integrations | Selected existing fleet/profile enrollment, approved host changes and persistent gateway supervision |
| Emberfold | Independent library, CLI and optional HTTP service | Full-profile service readiness; packaged SDK source-preserving checkpoint/rebuild checks | Selected live profiles and any enabled optional HTTP consumer |
| HiveXUI | One browser shell, product modules, read-only incident correlation, unavailable states, themes, keyboard flows and deep links | Strict build, immutable product-owned contract checks, no persistent bearer storage, actual browser workflows and accessibility scans | Released contract/image selection and authenticated restored-data browser review |
| Hive | Interactive/unattended setup, selected products, planning, adoption, status/doctor, backup, rehearsal, upgrade, rollback and restore | Fresh core/full/custom, strict SSH inventories, interruption/retry, stable IDs/credentials, exact migrations, isolated restores and compatible bundle activation | Separate physical-host acceptance, coordinated maintenance backup, one active writer and explicit cutover approval |

## Reproducible developer checks

The public drivers require explicit private configuration or a new protected
output directory. Their fixtures never select a production installation implicitly.

- `npm run test:suite`, `test:suite:adapters`, `test:suite:sso`,
  `test:suite:ingress`, `test:suite:containers` and `test:suite:lifecycle` cover
  controller, protocol, authentication, transport and recovery boundaries.
- `test:suite:core` and the distributed driver cover real candidate containers.
  `deployment/README.md`, `DISTRIBUTED.md`, `FULL.md` and `CUSTOM.md` describe the
  inputs and limits, including the single physical host used for SSH fixtures.
- `deployment/NATIVE_AGENTS.md`, `NATIVE_INITIALIZATION.md`,
  `NATIVE_CONSUMERS.md`, `USER_SERVICES.md` and `SKILLS_DEPLOYMENT.md` distinguish
  installed, initialized, authorized and accepted native consumers. Hermes's
  optional messaging artifact proves native Skills tools and Chat adapter
  components separately from a model-driven, supervised gateway.
- `deployment/REHEARSALS.md` and `EXISTING_DATA_REHEARSALS.md` cover independent
  restored state, original archive hashes and consistency limits of online capture.
- Each product owns its API/contract and security gates. OpenAPI drift checks do
  not imply complete response schema coverage for routes still marked as a baseline.

Current direct suite workflows use product-owned browser exports for identity,
account security, enrollment, models, memory, Skills, security and chat. Immutable
artifacts retain source revisions, checksums and original licenses/notices. Native
read DTOs preserve historical data separately from stricter write validation.
Browser-computed summaries retain local aggregate types and validate every input
against its owning product contract. Incident groups are read-only correlation
hints; durable investigations and approved responses remain product-owned.

Inference services, hosted providers and all model assets remain external. Tests
use disposable protocol responders, never an inference runtime or model download.
No candidate check authorizes production cutover or replaces operator-controlled
provider consent, publisher trust, host enrollment or a maintenance window.

The current existing-data migration scope selects independent Hive installations
and separate security/chat stores. It does not select an existing Magnus fleet or
Ardent profile for adoption. Select their effective configuration, current database
checkpoint, signing keys and per-profile state before a separate isolated restore.
The optional Emberfold HTTP service is stateless; caller-owned context histories
and embedded SDK profiles require their own selected recovery inputs.
