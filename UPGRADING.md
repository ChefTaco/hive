# Upgrading Hive

A suite installation upgrades to a newer signed release with the release's own controller:

```bash
./hive.sh upgrade --config ~/.config/hive/ID/installation.json --release X.Y.Z
```

The launcher checks out and verifies the tagged controller of that release. The upgrade prints its
plan, takes a verified pre-change backup and rehearses data changes on a copy before activation.
Moving from 2.x to 3.x with existing PostgreSQL stores also needs `--allow-migrations`, described
below. A failed or uncertain step holds its transaction for recovery, as described in
[when a command stops](deployment/README.md#when-a-command-stops-transactions-and-recovery); never
delete transaction or runtime receipts to force another attempt. See also
[the upgrade procedure](deployment/QUICKSTART.md#8-upgrade).

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
