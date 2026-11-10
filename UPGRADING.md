# Upgrading Hive

Hive 1.2 introduces managed release bundles for the launcher, IAM, Router, HiveMem and optional
Skills. The launcher and servers share the release version; each bundle records exact package
pins, tested SDK versions, Node engines, configuration changes, migration impact and compatibility
in `package.json.hiveRelease`. Consumer applications keep control of their SDK dependencies.

## Suite 3.0: patched datastore runtime

The container suite selects maintained system libraries and patched embedded SQLite.
Product database schemas and PostgreSQL majors are retained. PostgreSQL's glibc/ICU
change requires an explicit maintenance window to rebuild indexes before recording
new collation versions. The PostgreSQL images omit LLVM JIT; workloads relying on
JIT acceleration need separate performance validation.

For an existing full installation, use the published release controller:

```bash
./hive.sh upgrade --config ~/.config/hive/ID/installation.json --release 3.0.1 --allow-migrations
```

The installer verifies a pre-change backup, rehearses the new runtime and migration
on a disposable copy, then migrates the stopped live stores. Credentials, ownership,
PostgreSQL majors, application records and component selection are retained. A
core installation without PostgreSQL does not need this storage transition.
Individual product selections remain supported.

A failed or uncertain live migration holds the transaction for recovery; never
repeat it blindly. PostgreSQL startup requires its successful runtime receipt.
Code-only rollback to the former collation runtime is refused. Recovery requires
write reconciliation and a verified rehearsal of the original-state backup using
the retained original controller and images; it must not discard later writes.

Ardent 3.0 changes its low-level SQLite handle; integrations using driver-specific
methods must adapt. HTTP/CLI contracts remain compatible. The new driver packages
Linux x64/arm64 Node-API binaries, so native installs need no database compiler,
postinstall download or manual rebuild.

### Retrying a failed 3.0.0 full-stack rehearsal

Use 3.0.1 or later for an existing full installation. Version 3.0.0 could reconcile
only the first PostgreSQL store when a migration subprocess consumed the controller's
component list. The remaining stores refused startup, and the isolated rehearsal
held activation before live migration. Fresh installations do not use that transition.

Run the same upgrade command above with `--allow-migrations`. A subsequent signed
upgrade can continue only after verifying that stopped live data, configuration,
storage formats, active definition, receipt, ownership and permissions still match
the original verified backup and that no native agent was staged. It retains the
failed transaction, backup and rehearsal, and records an archive-bound handoff.
Changed data or an uncertain live migration remains held for explicit recovery.
Do not edit transaction or runtime receipts, or refresh collation metadata manually.

## Managed npm installations

Requirements: Linux, supported Node.js (`^24.22.1 || ^26.13.0`), npm, `flock`, and working backup access to
the configured datastores. First create an installation:

```bash
npx @hivemagnus/hive init --yes
npx @hivemagnus/hive start
```

Select `--services all` to include Skills. Foreground operation remains the default.
Choose the service set at enrollment. Re-running `init` preserves that inventory and refuses
to add packages to an active release; use a separate `HIVE_HOME` for additional services.
`--manager systemd` writes and enables systemd **user** units. Start `hive.service` and
`hive-coordinator.service` with `systemctl --user start`; enable lingering yourself if you want
the user manager to survive logout. No root service or passwordless sudo rule is installed.

Upgrade every enrolled component, including the managed launcher, together:

```bash
npx @hivemagnus/hive@latest upgrade --dry-run
npx @hivemagnus/hive@latest upgrade
npx @hivemagnus/hive@latest upgrade --to 1.2.2
```

The explicit version is the **bundle version**, not a request to independently resolve each
component. Absent optional services are never added by an upgrade. Server `upgrade` and
`rollback` commands delegate to the same enrolled launcher. A global npm installation and
the npx cache are not overwritten.
Use the explicit `@latest` bootstrap when an older launcher is installed globally or locally.
Launchers from 1.2 onward delegate to the managed engine. Already published pre-1.2 launchers
cannot gain that behavior retroactively; stop using their `install` command after adoption.
When an engine protocol changes, the staged launcher must advertise support and reproduce the
approved plan before taking over. Configuration or signing-key changes invalidate that plan.

Code lives in `$HIVE_HOME/versions/<version>-<transaction-id>`; `current` selects the active
release and `runtime` is its compatibility link. Configuration, keys, certificates and data
stay outside releases. Every installed release has its own exact npm project and lockfile.
Only `better-sqlite3` and `argon2` native install scripts are approved; the optional
`msgpackr-extract` script is denied.

An upgrade stages and validates packages first. Under the installation lock it pauses traffic
and workers, stops writers, verifies backups, applies migrations, switches `current`, starts
services in dependency order, and checks live readiness and running package versions.
The foreground supervisor is replaced by a detached supervisor during an upgrade; its logs
are in `$HIVE_HOME/run/upgrade-services.log`.

`--dry-run` does not install packages, write configuration/cache files, migrate or restart.
For offline testing, `--from DIR` selects complete `npm pack` artifacts instead of registry
packages. Keep the source directory private if it contains local evidence.

### Recovering a 1.2.0 launcher

Version 1.2.0 incorrectly compares registry JSON object key ordering. For a fresh setup, use
`npx @hivemagnus/hive@1.2.1 init`; existing configuration and secrets are preserved. An enrolled
1.2.0 installation must make its first upgrade from the complete public tarball bundle so its old
engine does not compare reordered registry metadata:

```bash
bundle_dir="$(mktemp -d)"
npm pack --ignore-scripts --pack-destination "$bundle_dir" \
  @hivemagnus/hive@1.2.1 @hivemagnus/hive-iam-server@1.2.1 \
  @hivemagnus/hive-router@1.2.1 @hivemagnus/hivemem-server@1.2.1 \
  @hivemagnus/hive-skills@1.2.1
npx @hivemagnus/hive@1.2.1 upgrade --to 1.2.1 --from "$bundle_dir" --dry-run
npx @hivemagnus/hive@1.2.1 upgrade --to 1.2.1 --from "$bundle_dir"
```

npm verifies the downloaded tarballs, and Hive verifies their exact bundle, lockfile integrity
and backups before migration. The selected service inventory stays unchanged. Retain the tarballs
until the upgrade receipt reports success; subsequent upgrades can use the registry normally.
To reproduce a 1.2.0 bootstrap, download that version of all five packages and run its launcher
with `init --from DIR`; this uses the published code and tarballs without modifying either.

## Existing installations and recovery

An existing installation is never automatically reinitialized:

```bash
npx @hivemagnus/hive adopt --dry-run
# Stop the previous launcher before applying the reviewed adoption.
npx @hivemagnus/hive adopt --apply
```

Adoption recognizes the launcher layout and the tested pre-managed public package set. It
keeps original package bytes, configuration, keys and data. Unknown layouts and unsupported
older component sets require an explicit operator migration. Existing independent systemd
deployments retain their own [release procedure](docs/npm-deployments.md); do not run `init`
over them or assume their directory and user layout matches a managed project.

SQLite backups include committed WAL contents and pass integrity/foreign-key checks. Skills
archives and hashes are included. HiveMem uses native snapshots of owned **single-node**
Qdrant collections plus its local journal/revocations. IAM Redis backups preserve only its
namespace and absolute key expiry. Other collections/namespaces are never flushed. No current
Hive service uses PostgreSQL; clustered or unsupported datastore configurations fail closed.
The native adapters require dedicated standalone Qdrant/Redis stores and an explicit scoped
Redis namespace. Enrollment certifies that all writers belong to this installation; audit
external connections before adoption. Shared external writers retain their operator procedure.
Redis backup credentials need `INFO`, `SCAN`, `DUMP`, `PTTL`, `DEL` and `RESTORE` within the
owned namespace. Recovery never reintroduces one-time authentication challenges.

```bash
hive rollback
hive rollback --to <recorded-release-directory>
```

Code rollback never assumes that old code can read a new schema. The existing IAM runner,
for example, refuses unknown migration history. A compatible failed upgrade automatically
returns to the prior code; incompatible or uncertain state remains stopped in maintenance.
Each transaction records an exact restore command and backup manifest in the owner-only
`run/transaction-<id>.json` receipt.

Data restore is explicit:

```text
hive rollback --restore-data --transaction <id> --confirm-restore <manifest-sha256> --containment-reviewed <review-hash>
```

Use the exact values printed for that transaction. The first reviewed restore attempt preserves
failed state and prints the containment review hash. Before confirming it, reconcile newer
disabled identities, revoked tokens, signing keys, forgotten content and credential disables.
Restoration can discard later application writes. Changed protected keys/configuration or
revocations refuse restoration until reconciled. IAM/Router/Skills credential, session and
permission changes also refuse restoration until
the preserved failed state has been reconciled; a generic restore confirmation cannot undo them.
Upgrades never regenerate or rotate keys, reseed an existing IAM database, or automatically
restore old data. A failed backup forbids
migration; there is no backup-bypass switch.

Interrupted transactions remain held. Inspect their receipt and use explicit rollback/recovery;
do not delete the journal to force another upgrade. Keep previous releases and backups until
the upgrade has been accepted; automatic retention deletion is not enabled.

## Migrations, notices and automation

Every server supports `--version`, read-only `check --json`, `migrate --plan --json`,
`migrate --backup-dir DIR`, and delegated `upgrade`/`rollback`.
Router also supports `check --offline` for the paused configuration-check phase; this never
replaces final live health. First-install IAM provisioning is separate from explicit migration.

| Switch | Default outside managed installs | Managed setup |
| --- | --- | --- |
| `HIVE_AUTO_MIGRATE` | `false` | `init` writes `true`; images default `true` |
| `HIVE_UPDATE_CHECK` | `false` | `init` writes `true` |
| `HIVE_AUTO_UPGRADE` | `false` | Remains `false` |
| `HIVE_UI_UPGRADE` | `false` | Remains `false` |
| `HIVE_COMPOSE_UPGRADE_SUPERVISOR` | `false` | Explicit Compose setup enables it |

Set switches explicitly to `false` to keep an operator-owned release process. Normal explicit
`hive upgrade` remains available when unattended upgrades are disabled. Startup with pending
migrations and auto-migrate off fails with the migration command. Slow and one-way migrations
are never applied by automatic startup or unattended updates.

Release notices show available same-major versions, notes and new required env names in the
console, Skills administration, server checks and `hive doctor`. Registry outages leave a
stale/unavailable notice without changing health. Checks transmit no installation identity,
configuration or credentials. A managed supervisor/coordinator shares the daily cache;
standalone checks must be explicitly enabled. Unknown peer versions warn; known incompatible
versions show the exact bundle command. Compatibility metadata does not authorize a token,
relax issuer/audience checks or change the wire contract.

For one-click upgrades, run `hive coordinator`, enable `HIVE_UI_UPGRADE=true` for both it and
Router, and use Settings → Hive updates. The local socket is owner-only. Apply requires upgrade
permission, recent authentication, the correct browser origin and the exact short-lived plan
hash. The web application receives neither sudo access nor a Docker socket. The coordinator
continues while services restart; refresh upgrade status after reconnection.

For unattended updates, explicitly configure `config/upgrade.env` for the coordinator:

```dotenv
HIVE_AUTO_UPGRADE=true
HIVE_AUTO_UPGRADE_POLICY=patch
HIVE_AUTO_UPGRADE_WINDOW=02:00-03:00
HIVE_AUTO_UPGRADE_TIMEZONE=Etc/UTC
```

`minor` permits same-major minor updates. There is no default maintenance window or timezone.
Windows use `HH:MM-HH:MM` within one local day and reserve a full 15-minute execution budget;
repeated DST hours run at most once per local date. Staging is followed by another window
check. Recovery has a separate bounded safety budget. Missing required settings, prerequisites,
slow/one-way migrations and major changes require manual work. A manual major/slow/one-way
upgrade requires `--confirm-plan` from its reviewed dry-run; generic `--yes` cannot approve it.

## Images and managed Compose

The four server images are `ghcr.io/cheftaco/hive-iam-server`, `hive-router`, `hivemem-server`
and `hive-skills`. Stable releases publish immutable `X.Y.Z` plus `X.Y` and `X` channels.
No new `latest` tag is published. Multi-platform images include provenance and SBOMs; moving
channels are promoted after all immutable images pass verification.

```bash
hive init --services all --manager compose --yes
hive coordinator
# In another terminal, from $HIVE_HOME:
docker compose pull && docker compose up -d
```

Managed Compose recovery currently requires Linux, supported host Node/npm and a running host
coordinator with Docker access. It reuses the configured loopback stores from `init` and uses
host networking to preserve their endpoints and TLS names. Keep the coordinator under a durable
service manager. Application containers never mount the Docker socket or the owner CLI
capability in `config/owner-upgrade.key`. Host OS/PAM login identities are not imported into
containers. Use IAM for Router sign-in and configure container PAM identities separately for
Skills administration; the public registry and distribution endpoints do not require them. Standalone Compose
examples support startup backup/migration, but need enrollment for coordinated stack recovery.

Generated Compose pins an exact image version by default. To follow the current major, set
`HIVE_IMAGE_TAG=1` in the managed project's `.env`; `1.2` follows patches only. This is an explicit
channel choice. The host supervisor validates the complete pulled image set, stops old writers,
backs up data, migrates, then admits gated entrypoints. Mixed/partial releases recover the prior
recorded image digests. The host coordinator orders admission using live readiness rather than
Compose health dependencies. CLI/UI upgrades pull and validate every exact target image before
maintenance and preserve the configured exact/minor/major channel. Missing supervision leaves replacement images gated before they open
datastores. Incompatible migrations stay held for explicit restore.

Detached `up -d` is not acceptance: use `hive status` and coordinator status to verify completion.
Do not prune the previous images or remove recovery receipts during the acceptance period.
For scheduled pulls, use the coordinator's enabled policy/window; do not install a separate cron
job that bypasses those controls. Watchtower may monitor the pinned major channel and notify an
operator; leave container replacement to the coordinator.

## Release and verification conventions

Each CHANGELOG release must list new required/optional env names, removed names, migration impact,
minimum upgrade-from versions, wire/data compatibility, rollback limits and any key action.
`release/<version>.json` records reviewed migration policy; `npm run release:manifest` generates
the package metadata and `release:manifest:check` rejects drift. Historical migration SQL is
immutable. Keep secrets, environment files, backups and installation-specific paths untracked.

Run the usual gates plus `npm run check:upgrades` for the real public-npm-to-packed upgrade,
native-store backup/restore, old SDK/token compatibility and failure recovery. CI runs it on
Node 24 and 26. Image/Compose checks additionally cover both architectures, gated startup,
mixed bundles, absent supervision and unhealthy image recovery. Publishing remains a separate
explicitly approved action.
