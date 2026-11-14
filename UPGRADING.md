# Upgrading Hive

A suite installation upgrades to a newer signed release with the release's own controller:

```bash
./hive.sh upgrade --config ~/.config/hive/ID/installation.json --release X.Y.Z
```

The launcher checks out and verifies the tagged controller of that release. The upgrade prints its
plan, takes a verified pre-change backup and rehearses data changes on a copy before activation.
Moving from 2.x to 3.x with existing PostgreSQL stores also needs `--allow-migrations`, described
below, and so does moving an installation with Emberpath or HiveSkills from a release before
3.4.0 to 3.4.0 or later, an installation with Embermend from a release before 3.6.0 to 3.6.0 or
later, and an installation that runs Magnus from a release before 3.8.0 to 3.8.0 or later. A failed or uncertain step holds its transaction for recovery, as described in
[when a command stops](deployment/README.md#when-a-command-stops-transactions-and-recovery); never
delete transaction or runtime receipts to force another attempt. See also
[the upgrade procedure](deployment/QUICKSTART.md#8-upgrade).

## The setup checklist

From the Hive Registry 1.3.0, an upgrade records the steps that follow it, such as the Magnus host
agent, the HiveXUI browser clients and the Ardent packages, in the registry's
[setup checklist](deployment/FULL.md#setup-checklist). After the upgrade, run
`./hive.sh post-upgrade`: it marks each step it completes as done and lists the rest, which
`./hive.sh status` and HiveXUI show too. Settle a step you finished another way with
`./hive.sh setup done ID`, or one that does not apply with `./hive.sh setup skip ID`. An
installation upgraded from a registry before 1.3.0 gets its first checklist with that upgrade.
The registry keeps it without a migration, so the upgrade needs no `--allow-migrations` for it.

## Suite audit collection

From the release that pins a Cindertrace whose collector reads the suite audit export, an upgrade
of an installation with Cindertrace configures [suite audit collection](deployment/FULL.md#suite-audit-collection)
for each included product whose pinned version serves the export: an Oathweave machine client
per product with a generated secret, the product setting that accepts it, and Cindertrace's
collector settings with the `suite-audit` collector credential. It adds settings only, keeps every
existing client, link, grant and collector, and needs no `--allow-migrations`. Repeating it, or a
later upgrade, never rotates the secrets. The suite does not run the collector process itself;
start it as that section describes.

An older Cindertrace does not know the new sources and refuses to start with the `suite-audit`
credential. Before rolling back to a release whose Cindertrace predates them, run
`./hive.sh cindertrace-collector remove suite-audit`. The other settings are ignored by older
products.

## Suite 3.8.1: Magnus managed requests to agents with a node key

Suite 3.8.1 changes no storage format and needs no flag from 3.8.0. It pins Magnus, its fleet
gateway and agent 2.10.2, which add no migrations; every other pin and the controller are those of
3.8.0. With Magnus 2.10.0, an agent that had bound its own node key refused the server's managed
requests on an enrolled node, so agent upgrades from the console failed. Upgrade the suite first;
Magnus 2.10.2 then reaches those agents and can upgrade them. From 3.7.x, upgrade directly to
3.8.1 with `--allow-migrations`, as described for 3.8.0 below.

## Suite 3.8.0: Magnus node credentials and product security updates

Suite 3.8.0 changes no storage format. It selects the `runtime-2026-11-pg1712-xslt` datastore
profile: the same PostgreSQL 17.12 and 18.7 as `hive-postgres` 17.12-2 and 18.7-2 with libxslt
1.1.45-r8 (CVE-2026-9947, CVE-2026-87636), which start on the existing data with no storage
transition; Redis and Qdrant are unchanged. Magnus 2.10.0 adds two
additive database migrations (new node credential tables and two columns with defaults; no row is
rewritten). The upgrade finds them pending on the restored copy, so an installation that runs Magnus
upgrades from 3.7.x with:

```bash
./hive.sh plan --config ~/.config/hive/ID/installation.json --release 3.8.0 --allow-migrations
./hive.sh upgrade --config ~/.config/hive/ID/installation.json --release 3.8.0 --allow-migrations
```

An installation without Magnus, or with an external Magnus, needs no flag. The other products add
no migration; HiveMem 1.7.0 keeps every existing collection name and gives an encoded name only to
private collections of agent IDs that Qdrant could not store. The controller changes, and the
upgrade installs the new ingress `Caddyfile`, which sends each product one forwarded client address
and routes Magnus 2.10's node credentials. Check these before or after upgrading:

- **Oathweave 2.3.0:** a confidential client must send its client secret to exchange an
  authorization code. The suite's HiveXUI clients are public PKCE clients and need nothing. A
  Magnus console registered as a confidential client needs `HIVE_OAUTH_CLIENT_SECRET`; a
  confidential client without a secret gets one with `POST /clients/{id}/rotate-secret`. Behind
  several proxies, list every tier in `TRUSTED_PROXY_IPS`.
- **Emberpath 2.5.0:** changing a provider's `baseUrl` to another scheme, host or port requires
  its secret again, a provider behind a redirect fails until `baseUrl` is its final address, and
  provider reads and configuration exports show `[redacted]` for credential header values.
- **HiveMem 1.7.0:** editing or moving a memory needs write access to its workspace (and to the
  destination), and only an administrator can create the `default` workspace record.
- **Chattermost 0.6.1:** sockets close when their credential ends, and channel, post and team
  routes require the matching membership or manager role.
- **Magnus 2.10.0:** host agents get their own node keys in `compat` mode; the shared node secret
  keeps working. Upgrade Magnus first, then the agents (`./hive.sh magnus-agent install`). A new
  agent is enrolled with a one-time token. Magnus's server signing key is kept in its data
  directory, so the suite backup includes it. An existing agent that reaches Magnus through the
  suite's host agent port keeps the shared secret until it is enrolled with a token; see
  [Node keys](deployment/FULL.md#node-keys) and Magnus's `docs/NODE_CREDENTIALS.md`. Leave
  `NODE_AUTH_MODE=enforce` off until every agent has a key.

Magnus 2.9.x ignores the new tables. Before moving an agent that has bound a key back to an
older agent release, reset that node's credentials in Magnus, as its upgrade notes describe.

## Suite 3.7.0: PostgreSQL security update

Suite 3.7.0 selects the `runtime-2026-11-pg1712` datastore profile: PostgreSQL 17.12 and 18.7
(`hive-postgres` 17.12-1 and 18.7-1), which fix CVE-2026-6460 and, on 18, CVE-2026-116322. This is a
minor update within each major on the same hardened runtime, so the data files, collation receipt
and storage formats stay as they are. From 3.6.x the PostgreSQL stores need no `--allow-migrations`
and no dump or reload: the upgrade stops the suite, takes its verified backup, rehearses the new
images on a restored copy, then starts them on the existing data. Expect the usual upgrade downtime.
A binary rollback to 3.6.x can still read the data.

The PostgreSQL release notes ask for some indexes to be rebuilt after updating: GiST indexes using
`gist_trgm_ops`, B-tree indexes on `bpchar` columns declared without a length, and any GIN index or
table you suspect is affected by the corruption fixes. The suite's products do not create these
index types. If you added your own, rebuild them with `REINDEX` after the upgrade. Take a new full
backup before relying on PostgreSQL incremental backups.

The same release pins Emberpath 2.4.0, Cindertrace 0.6.1, HiveSkills 1.7.1 and Chattermost 0.5.2,
none of which changes its data format. Emberpath's new Decisions API (`POST /v1/decisions`) stays
off after the upgrade: set `EMBERPATH_DECISIONS_JEV_ENABLED=true` to serve it with the TypeSafe and
OpenRouter keys Emberpath already holds for its shadow decision model, then add the `decision` alias
and its rules as Emberpath's README describes.

## Suite 3.6.1: model API at /v1 on migrated hosts

Suite 3.6.1 changes no data format and needs no flag from 3.6.0. It pins Magnus 2.9.1 and a new
controller. On an installation migrated with `hive.sh migrate-native`, the console port's ingress
overlay sent all of `/v1/*` to HiveMem, so the Emberpath model API answered only on its native
listener. After upgrading, regenerate the overlay so `/v1/models`, `/v1/chat/completions` and the
rest reach Emberpath on the console port:

```sh
./hive.sh migrate-native tls-refresh --config ~/.config/hive/ID/installation.json --release 3.6.1
```

## Suite 3.6: the setup checklist and an Embermend migration

Suite 3.6.0 changes one product's database: Embermend 0.3.0 adds the migration
`20261112000000_audit_export`, a nullable `Audit.actorKind` column and an `Audit (createdAt, id)`
index. Embermend applies its migrations only through the suite's signed `migrate` command and
refuses older history in its exact verifier, so an installation on 3.5.0 that includes Embermend
upgrades with explicit approval; the controller rehearses the migration on the restored copy, runs
it once on the stopped live store and checks the verifier before activation:

```bash
./hive.sh upgrade --config ~/.config/hive/ID/installation.json --release 3.6.0 --allow-migrations
```

No other product changes its data format or adds a migration, so an installation on 3.5.0 without
Embermend upgrades without `--allow-migrations`. An installation on a release before 3.4.0 that
includes Emberpath or HiveSkills still needs it, for the 3.4.0 transitions described below.

This release has its own controller again: it records the [setup checklist](#the-setup-checklist)
and carries [suite audit collection](#suite-audit-collection). The launcher selects the 3.6.0
controller for `--release 3.6.0`; the 3.5.0 controller refuses the 3.6.0 manifest. The upgrade
replaces the Hive Registry with 1.3.0 (image 2.0.7), which records the checklist, and HiveXUI 0.7.0
shows it to administrators. HiveMem 1.6.0, HiveSkills 1.7.0, Ardent Project Studio 0.4.0 and
Embermend 0.3.0 serve the suite audit export and Cindertrace 0.6.0 can collect it, but 3.6.0 does
not configure collection yet: the upgrade adds no audit clients or collector settings.

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
