# Hive:Magnus ecosystem implementation plan

Updated: 2026-11-05. **Implementation has resumed at the operator's instruction.**

This document consolidates the approved architecture, subsequent corrections,
recorded implementation progress, current defects, and work still required.
Preserve recovery evidence; do not retire legacy paths merely because a candidate
implementation or test exists.

## Current direction (supersedes conflicting statements below)

HiveXUI is the single browser UI for every Hive:Magnus product.

- Port the remaining product consoles into HiveXUI, including Magnus. This replaces
  the earlier decision that Magnus keeps its own console until a later merge.
- Use one cohesive visual theme across all modules.
- Show a UI section only when its product is installed. An operator who did not
  install a product sees no trace of it.
- After the UI is merged, hold a whole-console design review. Keep the Magnus UI's
  visually impressive parts, such as its animations and marquees, rather than
  flattening them, and respect reduced-motion preferences.
- After that review: publish the release, then update the HiveMagnus repository
  and website.
- `--relax-auth-limits` greatly relaxes sign-in and password-attempt limits for testing
  without changing stored policy. Throttling stays enabled at a high ceiling, and the
  relaxed state is visible in the plan, status and console.

Decisions on the Magnus console port:

- Web terminal: a separate gateway holds the SSH key, never the browser. Access requires
  an administrator link, `magnus:terminal` and fresh identity verification, and gets a
  security review before release.
- Removed: switching between multiple control nodes (each installation has one API and
  its own console) and the embedded Hermes dashboard.
- Skills: HiveSkills is the only registry. The Magnus module shows installed Skills per node.
- The standalone Magnus console is deprecated after the HiveXUI module passes browser
  acceptance. Published versions stay available.

Decisions on the theme and first sign-in:

- The console has one dark theme, in the Magnus style, for now. Light mode returns later.
- First production sign-in uses a one-time password reset token. The operator runs the
  provided script with the token and sets the administrator password. No agent sees the
  password, and only that administrator account changes. This supersedes the statements
  below that resets are not authorized, for this path only.

The operator has authorized publishing, restarting services and production impact.
Passing tests do not by themselves establish acceptance; review what the screens show.

Detailed historical evidence remains in [ECOSYSTEM_MIGRATION.md](ECOSYSTEM_MIGRATION.md)
and [WORKFLOW_PARITY.md](WORKFLOW_PARITY.md). Those documents record candidate
checks, which are separate from acceptance of a real installation. Their earlier
completion statements must be read with the current limitations below.

## 1. Product boundaries

| Product | Responsibility |
| --- | --- |
| Hive | Bash installer/controller, deployment inventory, tested release bundles, upgrades, backups, restore and recovery, and the Hive Registry (the install catalog of one installation) |
| Emberpath | External model providers, routing, aliases, quotas, inference requests and telemetry |
| Oathweave | Identity, authentication, authorization, OAuth/OIDC, users, roles, service identities and enrollment coordination |
| HiveMem | Memory, workspaces, retrieval, consolidation and memory integrations |
| HiveSkills | Skills registry, immutable archives, assignments and distribution |
| HiveXUI | Shared TypeScript/React browser application consuming product-owned APIs and contracts |
| Magnus / Ardent | Fleet control, authenticated jobs, privileged host operations and agent execution |
| Cindertrace | Security collection APIs, cases, investigations, evidence, response review and approvals |
| ChatterMost | Chat APIs, storage, realtime events, attachments and Mattermost compatibility |
| Emberfold | Context engine, library/SDK, CLI and optional HTTP service |

Products keep independent versions, datastores, migrations, credentials and backup
procedures. A Hive release pins a tested combination rather than assigning one
version to every product. Extracted repositories retain licenses, notices and
source attribution. Hive's published history, packages, tags and releases remain
available for provenance and recovery.

HiveXUI replaces each product's own console, including Magnus and Cindertrace, once
its module is complete. Durable operations stay in the owning product's backend;
HiveXUI only calls product APIs.

## 2. Corrections that supersede the original plan

### External inference only

**Ollama, llama.cpp, other inference services and hosted API providers are external
dependencies. Hive must not install, provision, manage or store them.**

- No managed inference containers, model downloads, model directories or model
  volumes owned by Hive.
- No model-license acceptance workflow in the installer.
- No physical GPU provisioning, driver replacement, CUDA/ROCm installation,
  GPU-device management, or inference hardware certification owned by Hive.
- No CPU/NVIDIA/AMD inference hardware certification gate for the Hive installer.
  Testing a protocol fixture must never be described as physical GPU validation.
- Existing model files, volumes, containers, provider credentials and external
  services must remain under their current owner's control and must not be deleted.
- Reject obsolete managed-inference configuration, release profiles and generated
  resources with a clear migration message before lifecycle changes begin.
- Hive may configure external endpoints and protected credential references,
  verify TLS/connectivity, discover models, test generation and streaming, then
  register verified providers through Emberpath's API. Registration follows
  successful verification; interrupted or unknown registration outcomes require
  reconciliation.
- Emberpath continues to own routing, aliases, quotas and telemetry. Existing
  external provider configurations remain product-owned.

Ordinary service-host preflight still applies: SSH trust, permissions, architecture,
Docker, storage, ports, TLS and dependencies. Separate physical-host deployment
acceptance remains useful; it is distinct from the removed GPU/inference scope.
See [the inference boundary](../deployment/INFERENCE.md).

### Identity and account ownership

- Oathweave is the suite sign-in authority. Preserve native machine credentials
  and native product sessions where compatibility requires them.
- Link product accounts explicitly by issuer and subject. Preserve local IDs,
  memberships, ownership and permission ceilings. Never merge accounts by email.
- Retain independent installation namespaces. Selecting a primary identity
  authority does not combine installation databases or backup state.
- Existing agent, role-call and historical test identities are not automatically
  treated as human accounts. Reviewed ownership decisions stay in private records.
- Cindertrace's admin console uses Oathweave sign-in and an explicitly linked
  product account, rather than copying or sharing administrator passwords.

### Unknown passwords and isolated sign-in testing

- Unknown existing administrator passwords do not authorize resets or changes
  to production authentication policy.
- A separate authentication fork may contain a clearly identified temporary
  rehearsal operator. Its signing/session authority is separate from production;
  original users, password hashes, signing files and recovery inputs remain intact.
- Temporary-account sign-in proves the integration, not possession of an original
  administrator credential or completion of production ownership acceptance.
- The operator authorized relaxing **only the isolated rehearsal** sign-in limit
  from 5 to 50 attempts per 15 minutes. Throttling remains enabled; production
  limits and existing passwords are unchanged.

### One browser origin and realistic browser acceptance

- The retained Cindertrace console can be routed through the existing rehearsal
  ingress, avoiding a second SSH tunnel or a redirect to an unforwarded port.
- Browser-visible issuer, authorization endpoint, exact callback registration and
  validated landing path must agree with the actual browser origin.
- Never work around origin failures with wildcard origins, credential injection,
  unverified TLS, or blanket rewriting of browser authentication headers.
- A successful login is insufficient. Acceptance must wait for background reads
  and lazy modules to finish, inspect errors, and exercise enabled screens with
  both fresh and older sessions.
- Safe GET/HEAD reads may retry once after successful identity verification with
  fresh credentials. Mutations, approvals and dispatch operations require explicit
  resubmission and must not be replayed automatically.

## 3. Deployment and API architecture

- HiveXUI is strict TypeScript, React and Vite, served as compiled static assets
  by an unprivileged container. No application backend, database access, signing
  keys or infrastructure credentials belong in its bundle or runtime configuration.
- A separate Caddy ingress handles HTTPS and explicit browser/native path mappings.
  It supplies no shared administrator credentials and isolates product cookies.
- Each product runs separately with non-root execution, restricted filesystems,
  health/readiness checks, graceful shutdown, private datastore networks and
  persistent storage. No application container receives the Docker socket or host
  password databases.
- Compose bridge networking is local to each host. Across hosts, configure explicit
  HTTPS endpoints and verify certificates; never use another host's Compose name.
- Each product owns its OpenAPI and browser-safe contract exports. HiveXUI uses
  pinned released artifacts or generated clients, never sibling backend imports.
  Hive owns deployment manifests, not application schemas.
- Use Authorization Code with PKCE S256 for public browser clients, exact redirects,
  state and nonce checks, in-memory resource tokens and Oathweave-owned SSO cookies.
  Every API validates issuer, signature, audience, lifetime and permissions.
- Preserve OpenAI-compatible model endpoints, distinct memory endpoints,
  Mattermost/native chat behavior and signed security protocols.
- Magnus owns approved host changes, agent jobs and skill deployment execution.
  Durable operations remain in their owning backend. Without Magnus-managed jobs,
  HiveXUI presents the corresponding Hive CLI workflow for suite lifecycle work.

## 4. Recorded implementation progress

These are candidate implementation/evidence states, not a production release or
an assertion that every check was rerun at this pause.

| Area | Recorded progress | Remaining qualification |
| --- | --- | --- |
| Product extraction | Emberpath, Oathweave, HiveMem, HiveSkills and HiveXUI repositories, attribution, independent builds and containers exist | Publish reviewed immutable images/contracts and pin a tested release combination |
| API authorization | Resource audiences, explicit account links, permission ceilings, revocation and native compatibility have candidate regressions | Complete installation-specific acceptance and remaining contract/schema coverage |
| Browser authentication | PKCE, consent, MFA/passkeys, recovery, step-up and logout have disposable candidate checks | Original-account acceptance remains open; current step-up concurrency defect is unfinished |
| Workflow parity | Model, identity, memory/workspace, Skills, security and chat modules and native/API drills are recorded | Complete settled browser walkthroughs against the final candidate and each selected restored installation |
| Hive lifecycle | Interactive/unattended core/full/custom, strict SSH placement, retry, adoption, backups, rehearsal, migrations and compatible upgrade/rollback have disposable drills | Real installation and separate physical-host acceptance; application/storage migration compatibility |
| Agents | Magnus heartbeat/jobs/user-service restart and scoped Ardent/Codex/Hermes/Skills/chat/context candidate drills exist | Select existing profiles, preserve their state, complete operator provider authorization and persistent supervision acceptance |
| External providers | Verified HTTPS fixtures, model discovery, generation, streaming and Emberpath registration ordering are implemented | Real operator-owned endpoint/credential acceptance; no managed inference or GPU work |
| Existing data | Independent native backup captures and isolated restore/data-integrity drills are recorded | Fresh coordinated maintenance backups, complete authenticated browser/agent/provider acceptance and reviewed activation/recovery |
| Branding/docs | Product directory, contracts, guides and candidate runbooks have been updated | Reconcile the final shipped architecture and release evidence after remaining gates close |

Known coverage limits include incomplete response-schema coverage on inherited
routes, unreleased official suite manifests/trust keys, synthetic fixture versus
real-installation differences, and multi-host SSH drills performed on one physical
developer host. Do not substitute any of these for the corresponding remaining gate.

## 5. Exact checkpoint at pause

### Current isolated rehearsal

- Shared-origin Oathweave/HiveXUI and retained Cindertrace sign-in are running
  against copied state. No production cutover or password reset was performed.
- Real browser checks verified shared sign-in, explicit consent, Cindertrace admin
  access, secure HttpOnly product cookies, no persisted browser bearer tokens and
  rejection of a captured product cookie after Oathweave logout.
- Protocol checks rejected wrong audiences, code replay, foreign-origin logout and
  direct business mutations. Earlier integrity checks preserved original users,
  signing material and all 30 Cindertrace business-table hashes.
- The isolated overview wiring has now been corrected: Emberpath readiness maps
  to its actual health route; Oathweave has an explicit read-only console client;
  and the rehearsal proxy no longer forces interactive browser mode onto bearer
  API requests. Fresh-session probes showed both configured products ready.
- Unselected products remain explicitly unconfigured. A retained standalone
  Cindertrace console being available is separate from enabling its HiveXUI module.
- Business writes, collectors, dispatch, notifications, recovery mutations and
  external inference access remain disabled in the current restored rehearsal.
- Rehearsal services are left running. Pausing agent work does not remove their
  containers, copied files, volumes, credentials or recovery evidence.

### Verified Cindertrace walkthrough

The retained console was walked through at desktop and mobile widths: Overview,
Cases, Events, Entities, Sources, Evidence, Policies and Audit. The review included
a saved case, investigation/evidence details, historical audit verification,
keyboard navigation and keyboard scrolling of wide tables. No unexpected
Cindertrace HTTP failure, JavaScript error or document overflow was found.
Disabled lab workflows and response execution were not claimed as tested.

### Unfinished HiveXUI verification and source work

1. The initial GET/HEAD step-up retry fix is committed in HiveXUI as `c38c399`.
   Its candidate image passed 89 tests and the recorded product gates. This is
   the currently activated UI candidate, not a completed fix for all findings.
2. A real test aged only its own temporary SSO session and exposed a second bug:
   verification uses full session invalidation, which can cancel another product's
   in-flight authorization/consent and produce an Oathweave refresh warning.
3. Follow-up edits separate same-session credential refresh from logout/session
   invalidation. They are **unfinished and uncommitted**. Preserve the modified
   `src/lib/browser-auth.ts`, `src/lib/transport.ts` and new
   `src/lib/stepup-concurrency.test.ts` in HiveXUI. Do not treat those edits as a
   verified or activated replacement image. Typecheck/tests were launched, but
   their results were not observed before interruption; no passing result, new
   build, image or commit is claimed for these follow-up changes.
4. The fresh-session navigation script reported 27 views, but inspection found
   that some snapshots still said “Checking product access” or “Loading account
   security.” Its wait logic could return before React effects and background
   requests started. **That report is not complete screen-parity acceptance.**
5. The intended mobile sweep had not completed, and the theme-toggle selector did
   not match the control's accessible name. Theme and full mobile parity must be
   retested with corrected assertions; do not infer success from skipped checks.
6. The expanded restored-data Hive walkthrough is therefore pending. Its earlier
   optimistic summary must not be used to close that gate.

All implementation/testing work was interrupted for this documentation pause.
Private operational evidence and unfinished harness edits remain outside the
public source tree. On resumption, inspect them before changing or cleaning state.

## 6. Remaining work, in resume order

### A. Finish the current UI/authentication defect and verification harness

- [ ] Review the preserved same-session refresh/logout concurrency edits.
- [ ] Prove that concurrent product authorization survives successful step-up,
  retains explicit consent, and never installs a pre-verification stale token.
- [ ] Prove that logout, aborted requests and declined consent remain fail-closed;
  a late completion must not resurrect access.
- [ ] Retain exactly one automatic safe-read retry. Never replay mutations,
  response approvals, enrollment effects or unknown outcomes.
- [ ] Run all required HiveXUI typecheck/build/test/contract/privacy/security gates;
  freeze the final source and build an immutable candidate before activation.
- [ ] Correct the browser harness to observe new requests, completed responses,
  loading UI, lazy modules and a real quiet period after each navigation.
- [ ] Walk every enabled screen on the final candidate with the demo account.
  Capture settled content, errors, fresh/older session behavior, retries, theme
  changes, desktop/mobile layouts, keyboard flows and explicit disabled states.
- [ ] Distinguish expected anonymous/consent/step-up responses from unexpected
  failures. Do not count loading placeholders or unchecked selectors as passes.
- [ ] Re-run shared Cindertrace sign-in/revocation and preservation checks after
  the final UI activation. Record only what the final candidate actually proves.

### B. Close product workflow and contract parity

- [ ] Reconcile every row of WORKFLOW_PARITY.md with the final source, real API
  behavior and installation-specific browser evidence.
- [ ] Complete missing response contracts/OpenAPI coverage and drift checks;
  publish browser-safe immutable artifacts with preserved licenses/notices.
- [ ] Verify model configuration/revisions, memory permissions/workspaces/jobs,
  Skills assignments/distribution, security evidence/approval behavior and chat
  native sessions/threads/files/WebSockets against each selected restored store.
- [ ] Preserve response approval expiry, exact scope, one-use claims and durable
  unknown-outcome handling, including restart and reconciliation.
- [ ] Keep disabled/unavailable modules truthful. Preserve deep links and retained
  frontends until replacement and recovery gates pass.

### C. Finalize installer and release lifecycle acceptance

- [ ] Review the versioned JSON schema, interactive prompts and CLI precedence
  against the corrected external-inference boundary.
- [ ] Repeat required fresh core/full/custom interactive and unattended drills for
  the selected final bundle; verify interruption/retry without reseeding or new
  credentials/enrollments.
- [ ] Verify install, plan, status, doctor, adoption, backup, isolated rehearsal,
  upgrade, rollback and restore with exact migrations and readiness gates.
- [ ] Accept deployment across actual selected hosts; preserve explicit TLS/SSH
  trust, architecture/storage/port checks and private datastore networks.
- [ ] Publish reviewed version/digest-pinned images and host artifacts, released
  contracts, a compatibility lock and a signed suite manifest with publisher trust.
- [ ] Keep automatic upgrades off. Reject input/artifact drift and obsolete
  managed-inference configuration before changes; preserve existing resources.

### D. Accept selected native agents and external providers

- [ ] Select existing Magnus/Ardent/Hermes/Codex installations and profiles
  explicitly; back up their effective configuration, credentials and state.
- [ ] Complete operator-owned provider authorization without replacing existing
  profiles or treating fixture credentials as production consent.
- [ ] Verify scoped model/memory/Skills/chat/context operations and persistent
  gateway/user-service supervision, restart and recovery for each selected profile.
- [ ] Accept real external inference endpoints using protected credential
  references: verified TLS, connectivity, discovery, generation and streaming.
- [ ] Register only verified providers with Emberpath; verify idempotent retries,
  preserved aliases/credentials and reconciliation of unknown registration results.
- [ ] Perform no inference-service/model installation, GPU provisioning or
  hardware-certification work as part of Hive.

### E. Complete installation-specific migration rehearsals

- [ ] Keep independent installations and stores separate; distinguish them from
  multiple hosts belonging to one installation.
- [ ] Retain reviewed identity ownership decisions; leave agent/test identities
  unlinked unless explicitly mapped. Migrate enrollment/recovery records explicitly.
- [ ] Resolve original-account sign-in/ownership acceptance through an
  operator-approved method. Do not reset existing passwords or silently replace
  that gate with temporary-account proof.
- [ ] Capture fresh installation-bound backups, including databases, signing keys,
  issuer URLs, client registrations, audit histories, archives, attachments and
  selected agent profiles. Online historical captures are not maintenance backups.
- [ ] Restore each selected backup independently in isolation, disable effects,
  run the exact candidates, and verify integrity plus authenticated settled browser
  workflows and real scoped agent/model/memory acceptance where authorized.
- [ ] Rehearse recovery, storage compatibility and write reconciliation. Binary
  rollback alone is insufficient when schemas or data formats have changed.

### F. Production activation, publication and retirement — still gated

- [x] Production impact authorized by the operator for this test lab.
- [ ] Activate one pilot with one active writer/dispatcher, readiness and acceptance
  gates, retained previous runtime and a rehearsed recovery procedure.
- [ ] Review the pilot before migrating subsequent installations independently.
- [ ] Reconcile public product branding, installation walkthroughs, diagrams and
  agent guides against the actual released bundle.
- [ ] Retire bundled legacy frontends/superseded installer paths only after full
  replacement, installation-specific acceptance and recovery gates pass.

## 7. Evidence discipline

A passing unit test, healthy process, synthetic fixture or login page is evidence only
for its tested scope. Full acceptance requires settled workflows on the actual selected
candidate and restored installation. Report unfinished, skipped, synthetic and
operator-dependent gates explicitly.
