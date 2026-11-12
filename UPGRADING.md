# Upgrading Hive

A suite installation upgrades to a newer signed release with the release's own controller:

```bash
./hive.sh upgrade --config ~/.config/hive/ID/installation.json --release X.Y.Z
```

The launcher checks out and verifies the tagged controller of that release. The upgrade prints its
plan, takes a verified pre-change backup and rehearses data changes on a copy before activation.
Moving from 2.x to 3.x with existing PostgreSQL stores also needs `--allow-migrations`, described
below, and so does moving an installation with Emberpath or HiveSkills from a release before
3.4.0 to 3.4.0 or later. A failed or uncertain step holds its transaction for recovery, as described in
[when a command stops](deployment/README.md#when-a-command-stops-transactions-and-recovery); never
delete transaction or runtime receipts to force another attempt. See also
[the upgrade procedure](deployment/QUICKSTART.md#8-upgrade).

## Suite 3.5: event feeds and a new controller

Suite 3.5.0 changes no product data format. Emberpath 2.3.0 and HiveSkills 1.6.0 keep the formats
3.4.0 introduced, and Magnus 2.8.0, Cindertrace 0.5.0 and Embermend 0.2.0 add no database
migration, so an installation on 3.4.0 upgrades without `--allow-migrations`:

```bash
./hive.sh upgrade --config ~/.config/hive/ID/installation.json --release 3.5.0
```

An installation on a release before 3.4.0 that includes Emberpath or HiveSkills still needs
`--allow-migrations`, for the 3.4.0 transitions described below.

Unlike 3.3.0 and 3.4.0, this release has its own controller: the ingress allows the new Magnus
browser routes, and the registry sync records product capabilities. The launcher selects the 3.5.0
controller for `--release 3.5.0`; the 3.4.0 controller refuses the 3.5.0 manifest. The upgrade
replaces the Hive Registry with 1.2.0 (image 2.0.6), which records the `events.v1` capability that
Magnus, Cindertrace, HiveSkills and Embermend now declare, and HiveXUI 0.6.0 reads it to build its
inbox. Emberpath 2.3.0 and HiveSkills 1.6.0 no longer serve their own web UIs; their APIs are
unchanged.


Emberpath 2.2.0 adds its router data format `managed-format-2`: a nullable `Trace.actorId`
column with actor and client-key time indexes. HiveSkills 1.5.0 adds `managed-format-3`: a side
table binding deployment targets to Magnus nodes and agents. Both changes are additive and
existing rows are kept. The suite runs the products with automatic migration off, so neither
starts on data in its older format until its own `migrate` command has run.

Suite 3.4.0 therefore declares a storage transition for each (`emberpath-v1` to
`emberpath-managed-format-2`, `hiveskills-v1` to `hiveskills-managed-format-3`), and an
installation that includes either product upgrades with explicit approval:

```bash
./hive.sh upgrade --config ~/.config/hive/ID/installation.json --release 3.4.0 --allow-migrations
```

Without `--allow-migrations` the upgrade stops before any service is stopped. With it, the
installer takes and verifies the pre-change backup, runs each product's `migrate` on the
restored copy and starts the rehearsal, then runs `migrate` once on the stopped live store and
records the new format before activation. Each `migrate` also keeps the product's own verified
copy of its store under `migration-backups/` in that product's data directory; it stays until you
remove it. Repeating the upgrade does not migrate again. Fresh 3.4.0 installs create the new
formats directly and need no flag.

Code-only rollback from 3.4.0 to an earlier release is refused for these two products, because
the earlier release does not declare the new formats readable. Recovery uses the verified
pre-upgrade backup, as for any other storage transition.

## Suite 3.0: patched datastore runtime

The container suite selects maintained system libraries and patched embedded SQLite.
Product database schemas and PostgreSQL majors are retained. PostgreSQL's glibc/ICU
change requires an explicit maintenance window to rebuild indexes before recording
new collation versions. The PostgreSQL images omit LLVM JIT; workloads relying on
JIT acceleration need separate performance validation.

For an existing full installation, use the published release controller:

```bash
./hive.sh upgrade --config ~/.config/hive/ID/installation.json --release 3.0.3 --allow-migrations
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

When upgrading from 3.0.2 to 3.0.3, omit `--allow-migrations`: the PostgreSQL
runtime and storage formats are unchanged. For an existing native Magnus node,
run the signed release's `hive.sh magnus-agent enroll` with the same installation
configuration. This upgrades the agent and stages the verified Ardent package
while retaining the node identity. In **Magnus → Ardent → Installations**, stop
running profiles, choose **Update package**, then start the profiles again.
Magnus 2.3.7 retains verified older package checkpoints automatically. Preserve
any checkpoint it refuses to verify and use the recovery guidance rather than
removing it by hand.

### Retrying a failed 3.0.0 full-stack rehearsal

Use 3.0.2 or later for an existing full installation. Version 3.0.0 could reconcile
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

## Retired npm 1.x installations

The npm 1.x line (`@hivemagnus/hive`, `hive-router`, `hive-iam-server`, `hivemem-server`,
`hive-skills` and `hive-iam-sdk`) is retired. 1.2.2 was its last release, and it receives no more
fixes. Its source and its upgrade, adoption and recovery documentation remain at the
[`v1.2.2` tag](https://github.com/ChefTaco/hive/blob/v1.2.2/UPGRADING.md).

- **Native systemd installations** (Router, IAM, HiveMem and optional Skills as system services)
  move onto the suite with [`hive.sh migrate-native`](deployment/MIGRATE_NATIVE.md). It keeps every
  native port, certificate, issuer, signing key, account and token, and leaves the native runtime in
  place for rollback.
- **Launcher-managed installations** (`npx @hivemagnus/hive init`) have no automatic migration.
  `hive.sh adopt` takes over existing suite Compose stacks only. Install the suite fresh and move
  agents and clients to it deliberately; never run suite initialization over the launcher's data.
- **SDK consumers**: `@hivemagnus/hivemem-sdk` continues in the
  [HiveMem repository](https://github.com/ChefTaco/HiveMem). The IAM SDK continues in the
  [Oathweave repository](https://github.com/ChefTaco/Oathweave).

## Release conventions

Each CHANGELOG release lists new required and optional configuration, removed names, migration
impact, wire and data compatibility, rollback limits and any key action. How a suite release is
built, signed and verified is in [docs/RELEASING.md](docs/RELEASING.md).
