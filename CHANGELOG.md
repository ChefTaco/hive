# Changelog

All notable changes to this project are documented in this file. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project follows
[Semantic Versioning](https://semver.org/).

## Unreleased

- Validate suite images on native amd64 and arm64 runners before publication, reuse their build caches, and require the full advisory scan before publishing a signed release. Run the Registry on the patched Node runtime.

- Reconcile PostgreSQL template catalogs as well as ordinary databases so later database creation and restores inherit current ICU metadata. Restore the template connection-admission setting before finishing or recovering a failed migration.

- Build PostgreSQL 17.11 and 18.6 against patched XML and locale libraries. Require explicit offline collation reconciliation for existing data, with authenticated private-socket execution, reindex-before-refresh and a durable runtime receipt. Publish only after ownership, failure, backup and restore checks on both architectures; installer adoption requires a separate declared storage-format migration.

- Add a patched glibc Node runtime and reduce Qdrant and Redis userspace while preserving their upstream service binaries and datastore formats.
- Retain complete image advisory reports, add an all-findings gate for new suite image publication, and exercise runtime locking and persisted datastore restarts. PostgreSQL base changes remain gated on locale, extension and recovery compatibility proof; see `docs/ADVISORY_REMEDIATION.md`.

## [2.4.2] - 2026-11-10

### Fixed

- Successful upgrades refresh an existing local Hive certificate-renewal service
  to the verified controller checkout. Renewal options and timer state are retained; customized,
  unsafe or unrelated units are not replaced. The launcher can retain the new checkout without
  requiring a manual edit of the renewal service.
  Unattended refresh honors the host's protected sudo-password file and sends its value only on stdin.
- Pin Magnus server, gateway and native host agent 2.3.4. The corrected standalone agent lock
  allows clean native installation with lifecycle scripts disabled. The 2.3.3 lock used by
  Hive 2.4.1 was inconsistent; upgrades safely retained the previous native agent on failure.
- Magnus now checks a clean installation of its actual packed agent before publication and
  on both supported Node versions, including a regression for development dependencies that
  remain validated when omitted from the installed runtime.

### Security

- All 18 pinned images passed on amd64 and arm64 with zero fixable HIGH/CRITICAL findings
  under the existing image-specific exception policy; no new exceptions were added. Unfixed
  upstream advisories remain: CVE-2023-2953, CVE-2023-45853, CVE-2025-69720, CVE-2026-119373, CVE-2026-119374, CVE-2026-119379, CVE-2026-16742, CVE-2026-24882, CVE-2026-41992, CVE-2026-53613, CVE-2026-53615, CVE-2026-54369, CVE-2026-6653, CVE-2026-74860, CVE-2026-76642, CVE-2026-76844, CVE-2026-78408, CVE-2026-78409, CVE-2026-78410, CVE-2026-85091, CVE-2026-86138, CVE-2026-86139, CVE-2026-86140, CVE-2026-86142, CVE-2026-86143, CVE-2026-86144, CVE-2026-9538.

## [2.4.1] - 2026-11-10

### Changed

- Pin HiveXUI 0.2.5 for canonical command-result status and initial Studio agent guidance.
- Pin Magnus server, gateway and native host agent 2.3.3, tracking Ardent 2.3.1.
- Pin Ardent Project Studio 0.1.1 with the published Magnus service contract and patched lint tooling.
- Publish ingress 2.0.5 with Caddy 2.11.9 and its matching checksum-pinned base.

- Refresh dependencies of the legacy Router workspace and its console build (Vite 8 and React
  plugin 6). Native install scripts stay explicitly versioned.

- Measure backup/recovery acceptance by phase and run it independently of Node verification.
  Presentation-only pull requests use a smaller real corpus; installer, shared, unknown, main
  and release changes retain the full corpus, with conservative fallback on classification failure.
  Both sizes retain ownership, failure recovery, rehearsals and both restore paths.
- Synthetic Compose failure cleanup is bounded and retains the original assertion; a forced
  coordinator stop fails the fixture instead of qualifying supervisor absence.
- Synthetic recovery writers stop gracefully; client readiness replaces fixed sleeps, and
  ownership checks share one disposable sudo host with the recovery driver.
- CI package setup uses authenticated HTTPS sources, bounded retries and download inactivity
  deadlines. Failed fixture builds expose package diagnostics; browser setup has a bounded deadline.

### Fixed

- Certificate renewal selects the exact tagged release when multiple signed releases share
  controller code. Untagged, incompatible and multiply tagged choices remain ambiguous;
  signature and source verification still apply. Compatible saved configuration pins are retained.

### Security

- All 18 pinned images passed the release scan on amd64 and arm64 with no fixable HIGH or
  CRITICAL findings under the existing image-specific exception policy. Unfixed upstream
  advisories remain: CVE-2023-2953, CVE-2023-45853, CVE-2025-69720, CVE-2026-119373,
  CVE-2026-119374, CVE-2026-119379, CVE-2026-16742, CVE-2026-24882, CVE-2026-41992,
  CVE-2026-53613, CVE-2026-53615, CVE-2026-54369, CVE-2026-6653, CVE-2026-74860, CVE-2026-76642,
  CVE-2026-76844, CVE-2026-78408, CVE-2026-78409, CVE-2026-78410, CVE-2026-85091, CVE-2026-86138,
  CVE-2026-86139, CVE-2026-86140, CVE-2026-86142, CVE-2026-86143, CVE-2026-86144, CVE-2026-9538.

### Next

- Pin the Magnus native agent bundle as `agentArtifacts` in the release, so the agent needs no
  host Node.js.
- A bring-your-own certificate for `magnus-agent install` on a host without Tailscale.
- Adding the Magnus agent port to an existing installation, as a reviewed configuration change.
- An Emberfold area in HiveXUI; Emberfold is reachable only through its API.

## [2.4.0] - 2026-11-09

### Added

- Guided full-node enrollment includes commands, managed cron and selected restricted web terminals.
  The installer reviews the scheduler boundary and can promote its Ardent-only nodes while retaining
  completed history and profiles. Native profile maintenance resumes after refusal; reruns recover
  interrupted pauses.
- Native agent setup configures the explicit restricted terminal account; full-node setup prepares
  cron only when the capability is selected. The standalone Ardent-only command remains available.
- Pins Magnus server, fleet gateway and host agent 2.3.2, and HiveXUI 0.2.4. The console exposes
  approved command timeouts and finite UTC cron creation, pause and resume with explicit expiry.
  Other product image pins remain those of Hive 2.3.0.

### Fixed

- Verified stopped rehearsal containers and networks are released after checks and before later
  upgrades, while restored data, archive receipts and protected diagnostics remain available.
  Retries retain finished prior attempts and restore fresh test stores.
- Restricted terminals retain PTY marker traversal under the native service umask, while keeping
  journals private and markers owner-only.
- Managed cron last-run status and bounded execution history come from verified scheduler
  occurrences, including earlier runs; uncertain results remain pending and legacy history is retained.
- The native agent listener forwards the exact managed-terminal claim and receipt routes.
  Full enrollment checks these routes with non-mutating validation requests before pausing profiles.
- Full enrollment prepares scheduler discovery before its final approval snapshot, so newly
  activated user helpers cannot invalidate the first review. Post-approval drift still holds enrollment.
- Native dependency failures report a bounded npm error code while keeping raw diagnostics private
  and retaining the previous agent.
- Local agent commands accept a protected sudo-password file for unattended enrollment and
  repair, using standard input only and retaining the interactive sudo prompt when no file is supplied.
  Completed enrollment reads back the repaired runtime before reporting its version and readiness.
- Upgrades verify signed product schema commands even when the storage format is unchanged.
  Pending writes require explicit approval bound to the plan, run first on isolated restored
  stores, and retain exact product-owned recovery evidence. Current schemas skip migration;
  missing consent is detected before shutdown. Failed journal writes cannot start a migration.
- Release candidates can promote to their stable release through the upgrade path; moving from
  stable to its earlier candidate still requires an explicit rollback.

### Migration impact

- Magnus applies two additive participant-claim migrations. Existing history, profiles and
  credentials are retained; full enrollment requires an exact approved review. The upgrade
  keeps the standard host-bound backup and isolated restore rehearsal before activation.

### Security

- All 18 pinned images passed the release scan on amd64 and arm64 with no fixable HIGH or
  CRITICAL findings. Unfixed upstream advisories remain:
  CVE-2023-2953, CVE-2023-45853, CVE-2025-69720, CVE-2026-119373, CVE-2026-119374,
  CVE-2026-119379, CVE-2026-16742, CVE-2026-24882, CVE-2026-41992, CVE-2026-53613,
  CVE-2026-53615, CVE-2026-54369, CVE-2026-6653, CVE-2026-74860, CVE-2026-76642,
  CVE-2026-76844, CVE-2026-78408, CVE-2026-78409, CVE-2026-78410, CVE-2026-85091,
  CVE-2026-86138, CVE-2026-86139, CVE-2026-86140, CVE-2026-86142, CVE-2026-86143,
  CVE-2026-86144, CVE-2026-9538

## [2.3.0] - 2026-11-09

### Added

- Guided local installation prepares Docker and controller tools with consent, activates new
  Docker group membership without logging out or changing the operator's primary group, creates
  the installation directory, and offers
  a Tailscale console certificate when the host is already configured for it. The optional local
  web terminal can prepare its own restricted account and dedicated key. After installation,
  setup offers certificate renewal and the Magnus host agent. Saved configurations, unattended
  installs and planning retain their existing behavior.
- Fresh single-host installations can review observed native-owner and service process evidence
  before enabling managed Ardent actions. Setup obtains live participant drain proofs and uses
  a separate generated reconciliation authority. Existing histories require independent review;
  node-wide commands, cron and web terminals remain excluded on an Ardent-only node.

### Fixed

- The Magnus host installer prepares a non-root native-runtime owner and its user services,
  preserves native settings on repair, and stages the exact Ardent dependency from the signed
  agent's lockfile so the console can offer Install package. Runtime installation stays explicit.
- Emberfold receives the certificate authority referenced by its outbound TLS environment.
- Setup no longer asks for a native agent runtime when the selected release offers none.
- The browser walkthrough returns from fullscreen Studio before visiting the next console page
  and preserves intermediate results during long reviews.

### Changed

- Pin Magnus 2.2.3 with verified TLS endpoint selection, IP-only certificate compatibility,
  automatic recovery from an unusable DNS endpoint and the native owner's npm cache repair.
- Pin HiveXUI 0.2.3 with the correct Studio readiness route, independent product access when
  a valid suite user has no Emberpath identity, and supported API-key metadata examples.
- Pin Emberpath 2.0.3 with per-key trace privacy accepted by its strict public metadata contract.
- Pin HiveSkills 1.3.2, whose catalog explicitly reports no promoted release instead of breaking
  client response validation.

### Security

- All 18 pinned images passed the release scan on amd64 and arm64 with no fixable HIGH or
  CRITICAL findings. Unfixed upstream advisories remain:
  CVE-2023-2953, CVE-2023-45853, CVE-2025-69720, CVE-2026-119373, CVE-2026-119374,
  CVE-2026-119379, CVE-2026-16742, CVE-2026-24882, CVE-2026-41992, CVE-2026-53613,
  CVE-2026-53615, CVE-2026-54369, CVE-2026-6653, CVE-2026-74860, CVE-2026-76642,
  CVE-2026-76844, CVE-2026-78408, CVE-2026-78409, CVE-2026-78410, CVE-2026-85091,
  CVE-2026-86138, CVE-2026-86139, CVE-2026-86140, CVE-2026-86142, CVE-2026-86143,
  CVE-2026-86144, CVE-2026-9538

## [2.2.0] - 2026-11-08

### Added

- An external Magnus: an installation configuration can name a Magnus control API that runs
  outside the installation, `"external": {"magnus": {"url": "https://magnus.example.com:4000"}}`
  (HTTPS, a DNS host name and an optional port), in place of the `magnus` component. Ardent Project
  Studio can then run on the console host without the component. Fresh setup registers the
  `hivexui-magnus` browser client, lists Magnus in the console's `runtime.json`, routes the ingress
  Magnus routes to the external URL (`MAGNUS_TRUST_FILE` verifies it against the ingress image's
  system trust store and on its own name; every other product keeps the suite authority), points
  Studio at it, and writes `config/.initializer/external-magnus.env` with the Oathweave issuer, key
  set, userinfo and identity links to add on that Magnus. Interactive setup asks for it when Magnus is
  not selected; `plan` and `doctor` show it, and host preflight checks the console host's routes to
  it. The Hive Registry records it as installed and `external`, so the console shows its section
  (Hive Registry 1.1.0, image `hive-registry:2.0.3`). It works on installations moved with
  `migrate-native` too, whose migration then adds the Magnus client and route; a
  `console.nativeListeners` entry for `magnus` is refused beside it. `deployment/FULL.md` lists the
  manual steps for an existing installation. An installation without an external Magnus generates
  the same files and Compose definition as before; its ingress configuration adapts to the same
  routes.
- `hive.sh console-clients add`: creates the HiveXUI browser clients of Magnus (the component or
  external) and Ardent Project Studio in an existing Oathweave store, and adds their permissions to
  `SUITE_ADMIN`, in one transaction inside the Oathweave container that refuses any other change.

### Fixed

- An upgrade that adds a component the installation's recorded storage formats predate, such as
  Ardent Project Studio on an installation set up before Studio existed, no longer stops with
  `Storage transition needs --allow-migrations`: a component that is not deployed yet and has no
  data starts at its release's format, as on a fresh install. Data without a recorded format is
  still refused without an explicit migration.

### Release

- Pin the Hive Registry 1.1.0 (`hive-registry` 2.0.3, which records an external product), and
  Magnus server, fleet gateway and host-agent package 2.2.1 (Ardent 2.3.0). Every other image is
  unchanged from 2.1.1, including Ardent Project Studio 0.1.0. Both architectures pass the image gate
  with no fixable HIGH or CRITICAL findings; unfixed distribution findings remain.
- No datastore format change for existing products. Existing installations use the reviewed upgrade
  plan, pre-change backup and restored-copy rehearsal; adding an external Magnus and Ardent Project
  Studio to an existing installation is the manual configuration change in `deployment/FULL.md`,
  followed by `hive.sh upgrade` and `hive.sh console-clients add`.

## [2.1.1] - 2026-11-08

The publisher key is unchanged: DER SHA-256 `c0d0665a70969f37c8f1cffbdcf8e54df13626f8dbd4b5759a7c44843d86d1b2`.

The tag `v2.1.0` was pushed before its signed manifest was committed, so its release check failed
and nothing was published. Release tags are never moved; 2.1.1 is the first release with these
changes.

### Added

- Ardent Project Studio (`ardentstudio`) as an optional product: its catalog entry (Studio section,
  `/studio`, `/api/ardentstudio`), release contract (`ardentstudio-v1`, offered only when the
  release inputs name its image and selected by no profile), fresh configuration with its
  Oathweave browser client, two machine clients for Magnus and HiveMem with generated secrets and
  their service links, the ingress route (prefix kept, no cookies, unbuffered streams, 404 when it
  is not installed), the interactive offer with the full profile, and its data volume in backups.
  An installation without it is unchanged.
- Magnus's HiveMem service identity: fresh setup with Magnus, HiveMem and Oathweave on one host
  declares the Oathweave machine client `magnus-hivemem` (audience `hivemem`, `admin:agents`,
  `workspaces:write` and the memory and session scopes Magnus grants Ardent agents) with a
  generated secret, links it in HiveMem as `magnus-ardent`, and gives Magnus the
  `MAGNUS_ARDENT_HIVEMEM_*` settings, so Ardent New Agent enrolls every agent in HiveMem and
  creates their `ardent-agents` workspace. When Magnus runs on another host, setup says so and
  configures none of it.
- Magnus's HiveSkills registry for Ardent skill installs: with HiveSkills selected, fresh setup
  writes `MAGNUS_ARDENT_HIVESKILLS_URL` (the registry's internal HTTPS address, trusted through the
  suite authority) into Magnus's environment.
- Magnus command reconciliation: fresh setup generates an independent
  `COMMAND_RECONCILIATION_SECRET` for Magnus, and `hive.sh magnus-agent install` copies it into
  each node agent's environment, refusing a key shorter than 32 characters. Existing installations
  add it by hand (`deployment/FULL.md`).
- Magnus browser routes for New Agent: its operation status and stream, `POST /ardent/agents`,
  operation resume and a profile's HiveMem enrollment. The ingress forwards `Last-Event-ID` to
  Magnus and removes `x-acting-subject` from browser requests.

### Fixed

- The ingress (`hive-ingress` 2.0.4) removes vulnerable go-jose v3 by upgrading Smallstep crypto to 0.92.0,
  pinning the upstream certificates compatibility commit and using go-jose v4.1.9. No local
  certificate authority or TLS configuration is changed.
- Upgrade the ingress's x/crypto pin past removal of the obsolete OpenPGP package (GO-2026-5932).
- Restored-peer rehearsals run a static native client with request data in protected JSON,
  avoiding JavaScript construction from session headers and retained attachment metadata.
- Fresh initialization reads machine-client secrets and the initial security-console password
  directly from protected files, keeping them out of subprocess arguments and shell traces.

### Release

- Pin Oathweave 2.1.0, HiveMem 1.4.0, HiveXUI 0.2.0 (the fullscreen Studio and the Magnus New Agent
  wizard), Magnus server, fleet gateway and host-agent package 2.2.0 (Ardent 2.2.1), the ingress
  2.0.4, and offer Ardent Project Studio 0.1.0 (`ghcr.io/cheftaco/ardent-studio`). Every other image
  is unchanged from 2.0.6. Both architectures pass the image gate with no fixable HIGH or CRITICAL
  findings; unfixed distribution findings remain.
- No datastore format change for existing products. Existing installations use the reviewed upgrade
  plan, pre-change backup and restored-copy rehearsal; adding Ardent Project Studio, Magnus's
  HiveMem identity and the command reconciliation key to an existing installation is a manual
  configuration change (`deployment/FULL.md`).

## [2.0.6] - 2026-11-07

The publisher key is unchanged: DER SHA-256 `c0d0665a70969f37c8f1cffbdcf8e54df13626f8dbd4b5759a7c44843d86d1b2`.

### Added

- `hive.sh --release latest` resolves the latest published suite release once and launches its
  matching tagged controller. Exact versions remain selectable, retained checkouts leave the
  original checkout untouched, and manifest signatures and controller digests remain enforced.
  API errors, dirty retained checkouts and publisher-key changes stop before setup.

### Security

- Keep Cindertrace collector secrets and secret-bearing JSON out of process arguments. Read credential files and JSON through files or stdin; test every `jq` invocation rather than sampling short-lived processes.
- Require a complete, integrity-bearing `npm-shrinkwrap.json` inside the signed Magnus agent tarball. Install the staged package with `npm ci --omit=dev --ignore-scripts` against the public registry, and check it before changing the installed agent. Unlocked packages from earlier releases are refused; publish a new locked agent artifact and a newly signed suite release before using this controller.
- Align legacy IAM workspace overrides and its lock with Hono 4.13.16 and `@hono/node-server` 2.1.6, retaining the SimpleWebAuthn 14.1.0 update. Test `text/ping` CSRF and raw request-target backslashes.

### Release

- Refresh the ingress with `golang.org/x/net` 0.62.0 (CVE-2026-78661) and the hardened Qdrant/PostgreSQL images with patched zlib (CVE-2026-76844 and CVE-2026-85091). Keep the datastore binaries and storage formats unchanged. Both architectures pass the image gate with no fixable HIGH or CRITICAL findings; unfixed distribution findings remain.
- Pin Oathweave 2.0.4 and Magnus server, fleet gateway and host-agent package 2.1.2. The dashboard artifact includes Next.js 16.4.5; the HTTP adapter is 2.1.6. Preserve the SimpleWebAuthn 14.1.0 fix.
- No datastore format or schema change relative to Hive 2.0.5. Existing installations use the reviewed upgrade plan, pre-change backup and restored-copy rehearsal. Native agent runtime artifacts remain external to this release.

## [2.0.5] - 2026-11-07

`releases/2.0.5.json` pins exactly the images and versions of 2.0.4 except Oathweave, now 2.0.3.
The controller is unchanged (`controllerSHA256` equals 2.0.4's), and so is the publisher key
(fingerprint `c0d0665a70969f37c8f1cffbdcf8e54df13626f8dbd4b5759a7c44843d86d1b2`).

### Security

- Oathweave 2.0.3 updates `@simplewebauthn/server` to 14.1.0, which fixes GHSA-2g3p-m8c9-hhwh:
  certificate revocation lists are processed only for attestation certificates that chain to a
  trusted anchor. Oathweave requests no attestation, but a passkey registration response can
  still carry an attestation certificate chain.
- Rescanned on 2026-11-07, the images have no CRITICAL or HIGH finding with a fix available, on
  linux/amd64 and linux/arm64, and their unfixed findings are exactly those listed for 2.0.4.

### Dependencies

- Oathweave (`services/hive-iam`): `@simplewebauthn/server` 14 (includes the fix for
  GHSA-2g3p-m8c9-hhwh), BullMQ 6, nanoid 6, dotenv 18, argon2 0.45, `@hono/swagger-ui` 0.6,
  Prisma 7.10, Hono 4.13.16 and `@hono/node-server` 2.1.6. argon2 0.45 renames the `Options`
  type to `HashOptions`; hashes keep the same encoding, and stored 0.43 hashes verify.
  BullMQ 6 processes audit jobs that BullMQ 5 queued. Both lock files (workspace and the
  standalone deployment lock) are updated together.
- Router: dotenv 18, Hono 4.13.16 and `@hono/node-server` 2.1.6. HiveSkills, HiveMem core and the
  IAM SDK: minor and patch updates.

## [2.0.4] - 2026-11-07

`releases/2.0.4.json` pins exactly the images and versions of 2.0.3 and now also the Magnus agent
package, `@hivemagnus/magnus-agent` 2.1.1 with its registry integrity
(`components.magnus.agentPackage`). The rest of the release is the controller. The publisher key
is unchanged (fingerprint `c0d0665a70969f37c8f1cffbdcf8e54df13626f8dbd4b5759a7c44843d86d1b2`).

### Security

- Rescanned on 2026-11-07, the images have no CRITICAL or HIGH finding with a fix available, on
  linux/amd64 and linux/arm64, and their unfixed findings are exactly those listed for 2.0.3.
- The ingress links `github.com/go-jose/go-jose/v3` v3.0.5 (GHSA-mgcc-cww5-fp2q,
  GHSA-4w3g-jfj2-cw2q, GHSA-vvm8-gf78-28g4; no patched v3 release). Its only importer in the
  build is `go.step.sm/crypto/jose`, through Caddy's PKI app (`caddypki`, the smallstep
  authority). The newest `smallstep/certificates` (v0.30.2) does not build with the
  `go.step.sm/crypto` release that moved to go-jose v4, so no update removes it yet. The suite's
  ingress never configures that app: its configuration has only the `http` and `tls` apps,
  certificates are loaded from files, there is no automation, internal issuer or `acme_server`,
  and the admin API is off, so the vulnerable parsing is not reachable.


### Added

- A fresh installation with Magnus can publish the Magnus agent API for host agents on its own
  port (`console.nativeListeners: [{"port": N, "component": "magnus"}]`, offered by interactive
  setup, off by default). The ingress serves it on the console bind address with the console
  certificate and its own route set: the agent and Hermes sync routes only, the agent
  credentials only, and the client address in `X-Forwarded-For`. Before this, a host agent on a
  fresh single-host installation had no route to Magnus, so the full profile's fleet could not
  have nodes. See [Magnus host agents](deployment/FULL.md#magnus-host-agents).
- `hive.sh magnus-agent install|status|remove` installs the Magnus agent on the Magnus host or
  another fleet host through the controller's transport. It checks Node.js against the agent's
  engines and, with consent, installs Node.js 24 from NodeSource's signed apt repository with a
  pinned key fingerprint; installs exactly the agent version the release pins, verified against
  the tarball integrity the release manifest now records (`components.magnus.agentPackage`,
  from the release inputs and checked against the registry when publishing); moves the node
  credentials into a root-only environment without printing them or passing them as arguments;
  sets up the agent's own upgradeable service; waits for Magnus to accept its first heartbeat;
  and offers to approve the host key for the web terminal. It is idempotent and upgrades in place.
- `hive.sh cindertrace-collector add ID --sources SOURCE[,SOURCE]`, `list` and `remove ID`
  provision the credentials Cindertrace collectors sign events with. A credential is generated
  on the Cindertrace host into an owner-only file and never printed; Cindertrace ingests while a
  collector exists, and only Cindertrace is recreated. Before this, a fresh installation could
  not receive security events without editing its digest-checked environment. See
  [sending security events](deployment/FULL.md#sending-security-events-to-cindertrace).
- `npm run check:release-docs` fails when an install example names anything but the newest
  signed release.
- CI runs the ingress transport acceptance, which now proves the agent port's allowlist, that
  forged identity headers on it have no effect and that the console port still refuses agent
  credentials.

### Fixed

- The online backup's pauses no longer grow with the data. An application was paused for the
  whole capture of its group, which included a snapshot of every Qdrant collection, a full copy of
  every SQLite database and the write of the Redis dump; on an installation with 80 collections
  and a few hundred MiB of SQLite, the memory and identity groups paused for many seconds, and
  clients with shorter timeouts saw errors. Now everything that can be taken while the application
  serves is taken first, and the pause only proves those copies current or brings what changed up
  to date:
  - Qdrant collections are snapshotted while serving, between two readings of each collection's
    version (its shards' operation numbers, queued updates, points, segments and configuration).
    While paused, only collections written or created since are snapshotted again. A Qdrant that
    reports no versions has every collection snapshotted while paused, as before.
  - SQLite databases are copied while serving. While paused, in one read transaction, a database
    unchanged since its copy is kept without being read again, and any other is compared with its
    copy and only what differs is written; a WAL database's log is copied with it and checkpointed
    into the copy afterwards. Files changed shortly before their copy are compared by content.
  - Redis forks its snapshot while the application is paused; the dump is written and collected
    after the pause.
  Each group still holds the state of one instant. The receipt now records each pause's steps
  (`steps`) and the work done before it (`staged`). The online backup acceptance seeds a data set
  of a real installation's size and fails when any pause exceeds a budget (2 s by default).
- A command that failed in its read-only checks (staging, storage compatibility, native and
  external preflight) left its transaction open, so `doctor` reported `incomplete-transaction`
  and every other plan was refused until the same plan succeeded. Nothing had changed on the
  host, so the transaction now closes as `aborted`, keeping its record; `doctor` treats it as
  closed and the next plan proceeds. From quiescence on, recovery is unchanged. See
  [when a command stops](deployment/README.md#when-a-command-stops-transactions-and-recovery).
- A host side that runs as root through `sudoPasswordFile` on an installation an ordinary account
  owns left root-owned archives, rehearsals, transactions and receipts that account could not
  read. Every host action now gives what it wrote back to the installation directory's owner,
  keeping modes; service data and root-owned installations, as on production hosts, are
  unchanged.
- The installation guide, README and deployment overview of 2.0.3 still installed 2.0.2.
- FULL.md now shows how to create the web terminal's restricted node account and gateway key.

## [2.0.3] - 2026-11-06

A controller release. `releases/2.0.3.json` pins exactly the images and versions of 2.0.2;
only `hive.sh` changes. The publisher key is unchanged (fingerprint
`c0d0665a70969f37c8f1cffbdcf8e54df13626f8dbd4b5759a7c44843d86d1b2`).

### Upgrading

- Upgrade any 2.0.2 installation that takes online backups: on a host whose host side runs as root
  (`sudoPasswordFile`, as production hosts use), every online backup of an installation with
  HiveMem failed in 2.0.2. It failed safely: every service kept serving and no archive was kept.
  `--stopped` backups were not affected. Run the upgrade from a checkout of `v2.0.3`; no option
  is needed even though the installation file still names an earlier release.

### Security

- Rescanned on 2026-11-06, the images have no CRITICAL or HIGH finding with a fix available, on
  linux/amd64 and linux/arm64. Since 2.0.2, the vulnerability database lists three more HIGH
  findings with no fix available upstream: CVE-2026-85091 (zlib1g) in every image on a Debian
  base, and CVE-2026-119374 and CVE-2026-119379 (libsqlite3-0) in `hive-postgres` and
  `hive-qdrant`. The other unfixed findings are those listed for 2.0.0.

### Fixed

- The online backup works when the host side runs as root. The directory it stages a Qdrant
  store's collection snapshots in, for the verification Qdrant that rebuilds the store, was
  created by the host side, so as root it was root's and owner-only; Qdrant, running as its
  service user, could not read the snapshots and stopped, and the backup reported that a snapshot
  helper could not start. The directory now belongs to the service user and stays private to it.
  Every other staging directory and file the online backup, rehearsal and restore mount into a
  product container already belonged to that product's service user.
- Commands use the checkout's own signed release when the installation file names a release this
  controller cannot run. An upgrade leaves the file unchanged, so from the new checkout `backup`,
  `upgrade` and `rollback` refused with `Signed release requires different controller source`
  unless given `--release`. The choice is reported, the file is never rewritten, `--release`
  still chooses, and `--manifest` uses that manifest's version.
- A migrated Emberpath signs in through Oathweave. It kept the native Router's
  `HIVE_ROUTER_AUTH_MODE=os`, which checks OS passwords with `pamtester`, which the product image
  does not have: its own password sign-in could never succeed and `check` reported auth-mode FAIL.
  Migration, and the next `hive.sh upgrade` of an installation migrated earlier, set `iam-oidc`
  when the native Router's Oathweave client is configured. Console access is unchanged: it uses
  Oathweave tokens, which Emberpath accepts in either mode.
- Interactive setup explains the console bind address: the default, 127.0.0.1, serves this host
  only.

### Added

- `npm run test:suite:online-backup:sudo` runs the online backup acceptance with the host side as
  root through `sudo -S` over SSH, the way production hosts run it, while every service runs as a
  non-root user; CI runs it. `scripts/suite/sudo-host.sh` provides that host for the distributed
  and native-migration rehearsals too.

## [2.0.2] - 2026-11-06

`releases/2.0.2.json` pins Oathweave 2.0.2, Emberpath 2.0.2 and HiveMem 1.3.2, which ship
together: they carry Emberpath's self-renewing HiveMem service credential. Every other image is
exactly as in 2.0.1: HiveSkills 1.3.1, HiveXUI 0.1.1, Magnus 2.1.1 (with the optional fleet
gateway), Cindertrace 0.2.1, ChatterMost 0.4.1, Emberfold 0.2.1, `hive-registry:2.0.2`,
`hive-ingress:2.0.2` and the hardened datastores. The publisher key is unchanged (fingerprint
`c0d0665a70969f37c8f1cffbdcf8e54df13626f8dbd4b5759a7c44843d86d1b2`). The controller also
backs up a running suite online, fixes the ingress keep-alive race behind occasional POST 503s,
checks console certificate names for real, and adds a guided single-host installation
([deployment/QUICKSTART.md](deployment/QUICKSTART.md)).

### Upgrading

- On an installation migrated with `hive.sh migrate-native` (2.0.0 or 2.0.1), run
  `hive.sh upgrade` to 2.0.2 **before the copied `HIVE_ROUTER_MEMORY_PROXY_TOKEN` expires**.
  Until the upgrade, the console's memory pages, memory agents in the actors list, and actor
  onboarding and rotation depend on that static token, and fail once it expires. The upgrade
  provisions the self-renewing credential with no other step; afterwards the token is only a
  fallback. Set the installation file's `release` to `2.0.2` (or pass `--release 2.0.2`) and
  run the upgrade from a checkout of the `v2.0.2` tag. Like every upgrade, it first takes a
  backup with the suite stopped.
- The products' own changes: Oathweave 2.0.2 creates installation-owned machine clients at
  startup (`IAM_MACHINE_CLIENT_SECRETS`), HiveMem 1.3.2 accepts linked Oathweave service
  identities (`HIVEMEM_OATHWEAVE_SERVICES_JSON`) and its image listens on all interfaces
  through `HIVEMEM_TS_CORE_HOST`, and Emberpath 2.0.2 renews its HiveMem token in-process and
  names itself on its admin port's fallback page. See each product's changelog.

### Security

- Rescanned on 2026-11-06 (`scripts/release/scan-suite-images.sh`), every pinned image has no
  CRITICAL or HIGH finding with a fix available, on linux/amd64 and linux/arm64. The accepted
  exceptions in `deployment/trivy/` are unchanged, and the unfixed findings are exactly those
  listed for 2.0.0, including in the three new product images.
- The service credential is scoped to HiveMem: an Oathweave confidential client limited to the
  client credentials grant, whose five-minute tokens carry the `hivemem` audience and cannot be
  exchanged for a HiveMem bearer token. Its secret is generated on the host and never printed.

### Added

- `scripts/install-prerequisites.sh` installs what `hive.sh` needs on Ubuntu 22.04 and 24.04 and
  Debian 12 and 13 (amd64, arm64): Docker Engine and the Compose plugin from Docker's apt
  repository, after checking its signing key, and the tools the controller and host scripts use.
  It shows its plan before changing anything, is safe to re-run, adds the operator to the
  `docker` group, can create the installation directory, and has `--check`, `--dry-run` and
  `--controller` modes. It refuses unsupported systems, snap Docker and rootless Docker.
- `scripts/console-certificate.sh` issues the console certificate with `tailscale cert`, owned
  by the operator with an owner-only key, checks any certificate the way the installer does, and
  renews it into a running installation, weekly from a systemd timer if asked.
- `hive.sh tls-refresh` installs a renewed console certificate into a fresh installation: it
  checks the files at `bootstrap.certificateFile` and `privateKeyFile`, copies them into the
  ingress, records them in the initialization receipt and restarts only the ingress.
  Repeating `install` keeps working afterwards. Without `--release` it uses the release that
  pins the checkout's own controller. `scripts/console-certificate.sh renew` and its weekly
  timer run it.
- [Install Hive on one host](deployment/QUICKSTART.md): a step-by-step guide from a bare host
  to a signed-in console, with every setup question, certificate choices, backups, upgrades,
  firewall notes, controller-over-SSH setup and common errors.
- Emberpath's HiveMem credential renews itself. `hive.sh migrate-native prepare`, `hive.sh upgrade`
  and `hive.sh install` declare an Oathweave machine client for Emberpath wherever it serves
  HiveMem-backed endpoints, with its secret generated on the host and never printed. Emberpath
  fetches five-minute `hivemem` tokens and renews them itself, so the copied native
  `HIVE_ROUTER_MEMORY_PROXY_TOKEN` no longer has to be renewed or refreshed: it remains only a
  fallback until it expires. A migrated 2.0.0 or 2.0.1 installation switches over on its next
  `hive.sh upgrade`. Requires Emberpath 2.0.2, HiveMem 1.3.2 and Oathweave 2.0.2.

### Changed

- `hive.sh backup` takes its archive while the suite keeps serving. No container stops or
  restarts: each application pauses only while its own stores are captured (on a hive-sized
  installation, about a second, and under four seconds for HiveMem with 81 vector
  collections), and its requests wait instead of failing. SQLite is copied with the online
  backup API, Redis with `BGSAVE`, Qdrant with per-collection snapshots, PostgreSQL with
  `pg_basebackup`, and files are copied while serving and brought up to date in the pause. Each
  store is rebuilt and verified by its own product image before the archive is written, and the
  archive is verified while the suite serves. The archive has the stopped layout, so `rehearse`
  and `restore` (including an earlier controller's) accept it, and stopped archives keep
  restoring. The receipt records `"mode": "online"` and every pause. `--stopped` keeps the
  previous behaviour. A failed backup resumes every service and keeps no archive. Upgrades and
  rollbacks still back up with the suite stopped. See `deployment/BACKUPS.md`.
- Tree digests, which every backup, rehearsal and restore computes, hash files in parallel. A
  datastore's preallocated sparse files can appear many times larger than they are, so this
  also shortens the stopped backup. The digests are unchanged.

- `hive-set-admin-password` accepts the protected token file as its only argument
  (`hive-set-admin-password FILE`), as well as `--token-file FILE`. A token value given as an
  argument is still refused.

### Fixed

- The console certificate name check never failed: `openssl x509 -checkhost` exits 0 when the
  name does not match, so a console certificate for another name passed setup and `doctor`.
  Setup and host preflight now use `openssl verify -verify_hostname` (or `-verify_ip`) and
  refuse it, naming the origin.
- Host preflight and setup name a missing tool, an unreachable Docker daemon or a missing
  Compose plugin, with the command that installs the prerequisites, instead of failing silently.
- `install` no longer prints "Review the plan, then run install" while it installs, and ends
  with the console origin, where the initial sign-in is, and the next commands.
- Interactive setup offers `/opt/ID` as the installation directory and asks again, with the
  command that creates it, when a local directory cannot be created; it asks for an SSH
  configuration file for an SSH target; before an install it connects to each SSH host and
  checks its directory; and a repeated setup offers to continue with the configuration it
  already wrote instead of asking every question and then refusing.
- The ingress no longer fails an occasional POST with `503 Service unavailable`. It kept idle
  upstream connections for Caddy's default of two minutes, while the products, all Node servers,
  close an idle keep-alive connection after five seconds. A request sent on a connection at the
  instant its backend closed it failed: a GET was retried on a new connection, but a POST, such as
  a memory write or search, was not. Clients saw it rarely, and more often under load, such as
  during an online backup. Every upstream transport now closes idle connections after two
  seconds (`keepalive 2s` in `deployment/Caddyfile`), and `npm run test:suite:ingress-keepalive`
  reproduces the race against the real ingress image.
- `hive.sh upgrade`, `rollback` and `adopt` install the release's Caddyfile wherever the
  installed one differs, keeping the previous file as `Caddyfile.previous`. Before, an
  installation that already had the Hive Registry route kept its Caddyfile, so the transport fix
  reaches existing and migrated installations with their 2.0.2 upgrade.
- The README and `deployment/README.md` install the current release, and
  `deployment/MIGRATE_NATIVE.md` documents the memory credential, the token-file argument and
  when `refresh-memory-token` is still needed. `deployment/BACKUPS.md` describes online backups.
- The restored-peer proof script validates and encodes the attachment ID it requests.

## [2.0.1] - 2026-11-06

A controller-only release. `releases/2.0.1.json` pins exactly the images and versions of 2.0.0;
only `hive.sh` changes. Rescanned on 2026-11-06, the images have no CRITICAL or HIGH finding
with a fix available, and their unfixed findings are those listed for 2.0.0.

### Added

- `hive.sh migrate-native refresh-memory-token` copies a renewed `HIVE_ROUTER_MEMORY_PROXY_TOKEN`
  from the native Router environment into the suite Emberpath and recreates it, without printing
  the value.

### Changed

- `hive.sh migrate-native verify` checks a live suite without failing on client writes: the
  preservation receipt of its cutover, the serving checks and the invariants no client changes.
  It writes `migration/live-verification.json` and no longer compares rows or vectors.
- A cutover started with 2.0.0 and not finished cannot be continued by this controller: roll it
  back, then run `prepare` and `cutover` again. A suite that a 2.0.0 cutover verified passes
  `verify`, which accepts that exact verification as its receipt.

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
- Verification no longer passes a store it could not read. A comparison that ran while Oathweave
  was writing could fail with `database is locked`, and that store was left out of the result
  unchecked. Readers now wait for the lock, and an unreadable store is a violation.

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
