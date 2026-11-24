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
later, an installation that runs Magnus from a release before 3.8.0 to 3.8.0 or later, and every
installation moving from a release before 3.14.0 to 3.14.0 or later (Emberpath 2.6.0's data
format; see [Suite 3.14.0](#suite-3140-ardent-execution-recovery-lineage-and-artifact-transfer-v2)). An
installation that runs Magnus moves to 3.9.0 or later (Magnus 3) from 3.8.1 only, after its nodes
have their keys; see [Suite 3.9.0](#suite-390-magnus-301-node-keys-only). A failed or uncertain step
holds its transaction for recovery, as described in
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

## Service capabilities and agent dependencies

From the release that pins the Hive Registry 1.5.0, an install or upgrade records each product's
[service capabilities](docs/hive-registry-api.md#service-capabilities) with its connection. They
are kept in the stored connection, so the upgrade needs no `--allow-migrations` for them, and a
connection recorded before reads back without the field until the next install, upgrade or adopt
records it. A rollback to a release with an older registry drops them again with its own record.
Products read them only with the registry's existing read credential; nothing new is issued.

`./hive.sh doctor` and `./hive.sh ardent status` list the [agent dependencies](deployment/FULL.md#agent-dependencies)
that Magnus 3.3.0 or later resolves. With an older Magnus they say it is too old to report them,
and `doctor` still passes. Discovery never enables an integration: HiveMem enrollment, skill
installation and channel enablement keep their existing steps.

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

## Emberpath's memory principal: hive-router becomes emberpath

From the release that pins HiveMem 1.9.0, HiveMem data owned by `hive-router`, the HiveMem
principal of Emberpath on an installation migrated from the native Hive Router, moves to
`emberpath`, the principal fresh installations already use. HiveMem keys ownership on that
principal, so the data must move with it. The upgrade does it as HiveMem's signed initialization
(see [Upgrading product schemas](deployment/FULL.md#upgrading-product-schemas)):

1. Before anything stops, the read-only check `hivemem-server rename-agent --from hive-router --to
   emberpath --verify` runs. An installation that never had `hive-router` passes and needs no
   flag. One that has it needs `--allow-migrations`; without it the upgrade stops before any
   service is stopped.
2. With the flag, after the pre-change backup, the rename runs and is verified on the restored
   copy, then once on the stopped live store, journaled like any product migration. It moves
   memories (private ones into `emberpath`'s collections, with their vectors), sessions, episodes,
   conclusions, queue jobs, webhooks, workspace membership, operation receipts and the agent record
   with its credential state. `hive-router` keeps a disabled record, so a token still issued to it
   is refused rather than starting a new, empty owner.
3. Still before any service starts, the memory credential follows: HiveMem's
   `HIVEMEM_OATHWEAVE_SERVICES_JSON` links to `hive-router` name `emberpath`, Emberpath's
   credential record does too, and a still-valid static fallback `HIVE_ROUTER_MEMORY_PROXY_TOKEN`
   for `hive-router` is re-issued by HiveMem for `emberpath` with the same role, scope and
   remaining lifetime (an expired one is left as it is). From 3.12.1, HiveMem's own
   `HIVEMEM_ADMIN_TOKEN` for `hive-router` is re-issued the same way, also when Emberpath runs on
   another host. `config/.memory-identity-renames.json`
   records the rename, so a later credential step never links the old principal again. When
   Emberpath runs on another host than HiveMem, the upgrade prints the `issue-token` command for
   its static token, if it has one.

To see what will move before the upgrade, run the read-only plan with the new HiveMem image
against the running installation (safe while HiveMem serves; `DIRECTORY` is the installation
directory on the HiveMem host, and the image is the one the release pins):

```bash
printf '{"services":{"hivemem":{"image":"ghcr.io/cheftaco/hivemem:1.9.0"}}}\n' > /tmp/hivemem-rename-plan.json
sudo docker compose -f DIRECTORY/compose.json -f /tmp/hivemem-rename-plan.json run --rm --no-deps -T hivemem \
  rename-agent --from hive-router --to emberpath --dry-run
```

If `emberpath` already owns HiveMem data, the rename refuses (exit 3) without writing and the
rehearsal holds the upgrade: merge the two principals by hand with `--allow-existing-target`
first, on the stopped store, after a backup.

**Rolling back across this release.** A rollback restores the pre-upgrade backup, which holds the
data and the credential settings from before the rename, so they stay consistent. A code-only
rollback keeps the renamed data, which older HiveMem versions read, and the re-linked settings.

## Suite 3.14.0: Ardent execution recovery, lineage and artifact transfer v2

3.14.0 pins Magnus 3.3.0 (server, fleet gateway and host agent, which carries Ardent 3.2.0),
Ardent Project Studio 0.5.1, Emberpath 2.6.0, HiveSkills 1.9.0, HiveXUI 0.12.0, Oathweave 2.3.3
and the Hive Registry 1.5.0 (image 2.0.13). HiveMem, Cindertrace, ChatterMost, Emberfold, Embermend,
the ingress image and the datastore and storage recovery profiles are those of 3.13.5. Oathweave
2.3.3 fixes fresh installations, which failed on Oathweave's first start from 3.13.0 to 3.13.5;
it changes nothing for an existing installation. The
controller changes too: the ingress allows the new Magnus browser routes, and a new Studio is
named by its installation.

**Take the upgrade with `--allow-migrations`.** Emberpath 2.6.0 moves its router data from
`emberpath-managed-format-2` to `emberpath-managed-format-3`, which adds six nullable `Trace`
columns and two indexes. The change is additive and fast. Every installation has Emberpath, so
every upgrade to 3.14.0 needs the flag; without it the upgrade stops before any service is stopped:

```bash
./hive.sh plan --config ~/.config/hive/ID/installation.json --release 3.14.0 --allow-migrations
./hive.sh upgrade --config ~/.config/hive/ID/installation.json --release 3.14.0 --allow-migrations
```

The installer takes and verifies the pre-change backup, runs `emberpath migrate` on the restored
copy, then once on the stopped live store, as described in
[Suite 3.4](#suite-34-emberpath-and-hiveskills-data-formats). The transition is declared from
`managed-format-2` only: an installation still on a release before 3.4.0 (`emberpath-v1`) upgrades
to a release from 3.4.0 to 3.13.5 first. A code-only `rollback` from 3.14.0 is refused, because no
earlier release reads the new format; recover with the verified pre-upgrade backup.

**Ardent Project Studio: back up, migrations 7 to 10 are one-way.** Studio 0.5.1 runs its
migrations 7 to 10 on its first start. They are additive and keep existing rows, but Studio 0.4.x
no longer starts on a database they have run on. The upgrade's pre-change backup covers Studio's
data; keep it until you have checked Studio on 0.5.1, because going back to 0.4.x means restoring
it. Studio 0.5.1 still works with an older Magnus: task recovery, Ardent lineage, artifact transfer
v2 and definition deploy need Magnus 3.3.0 and agents that report those capabilities, and fall back
otherwise.

- The Studio of a fresh installation gets `ARDENT_STUDIO_INSTANCE_ID=<installation ID>`, so its
  execution references name the installation (`hive.sh add` does not add Studio). An existing Studio keeps the default `local`, which is fine. To use the
  installation ID, add the line to `config/ardentstudio.env` before you run `plan`, so the
  pre-change backup and the plan include it. References recorded earlier keep `local`.

**Ardent 3.2.0: interrupted tasks resume after a restart by default.** An agent's task that was
`running` continues under the same ID from its last completed model or tool boundary instead of
becoming `unknown`; a task with an unsettled effect is held for a decision, which Studio and
HiveXUI offer. Set `execution.recovery.enabled: false` in the profile's Ardent configuration for
the earlier behaviour. Release any extension package that pins an exact `@hivemagnus/ardent` peer
for 3.2.0 before Magnus moves the agents: a managed upgrade holds the runtime when a peer differs.
Profiles keep their installed Ardent until a managed upgrade moves them; until then the new
recovery, lineage and artifact reads answer `409 unsupported_capability`.

**Magnus 3.3.0** adds no migration. Host agents: `./hive.sh post-upgrade --yes` (or
`./hive.sh magnus-agent install`) moves the agents the suite installs to 3.3.0; fleet agents that
Magnus manages move with `magnus-server agents upgrade --to 3.3.0`. An external Magnus is upgraded
outside this release, and the **Installed software** page lists it as differing until it runs
3.3.0.

- Magnus 3.3.0 has new optional settings `MAGNUS_HIVE_REGISTRY_URL` and
  `MAGNUS_HIVE_REGISTRY_TOKEN_FILE` for [agent dependency discovery](deployment/FULL.md#agent-dependencies).
  The suite does not set them, on a fresh Magnus or an existing one, and you do not need them: the
  suite already configures HiveMem and HiveSkills for Magnus explicitly, and an explicit setting
  always wins. The Registry's internal endpoints are addresses on the installation's private
  network, which agents on fleet hosts cannot reach, so a Registry-resolved Emberpath would give
  New Agent a model URL those agents cannot use. Until Magnus distinguishes the URL it uses from
  the one it gives agents, `doctor` and `ardent status` report Emberpath as `missing` unless
  `MAGNUS_ARDENT_EMBERPATH_URL` is set; neither fails because of it.

**Ingress.** The Magnus browser allowlist adds `GET /api/v1/ardent/dependencies` and
`POST /api/v1/ardent/agent-definitions/validate` and `/install`, and forwards `Range` and
`If-Range` when the browser sends them, so HiveXUI can show the dependency report and resume an
artifact download. The upgrade installs the new Caddyfile with the release.

## Suite 3.13.5: agent checklist item

3.13.5 is a controller release with the product pins, datastore profile and storage recovery profile
of 3.13.4 (Magnus 3.2.1, Hive Registry 1.4.2). Upgrade from 3.13.0 or later with `plan` and
`upgrade` as usual; no flag is needed.

- After an upgrade that changes the Magnus agent pin, an unattended `post-upgrade` without `--yes`
  still does not update the agent on the Magnus host, and now says that unattended use needs
  `--yes`. Run `./hive.sh post-upgrade --yes`, or `./hive.sh magnus-agent install`.
- `./hive.sh magnus-agent install` on the Magnus host now records `magnus-agent-enrolled` as done once
  the pinned agent runs and Magnus has accepted its heartbeat. Previously the item stayed pending
  until `post-upgrade` ran again. An agent on a fleet host never settles it.

## Suite 3.13.4: Hive Registry 1.4.2

3.13.4 pins the Hive Registry 1.4.2 (image 2.0.12) and is otherwise 3.13.3: Magnus 3.2.1, the same
other products, datastore and storage recovery profiles, and the same controller. The Registry's
startup line now reports the port it is bound to and its two flags, and logs nothing taken from
its environment. There are no Registry schema or API changes.

- Upgrade from 3.13.0 or later with `plan` and `upgrade` as usual; no flag is needed. An
  installation on 3.13.2 or earlier also gets Magnus 3.2.1; see "Suite 3.13.3" below.

## Suite 3.13.3: Magnus 3.2.1

3.13.3 pins Magnus 3.2.1 for the server, the fleet gateway and the host agent. Every other product,
the datastore profile, the storage recovery profile and the controller are the same as in 3.13.2.
Magnus 3.2.1 changes no settings or migrations: its server and console packages ship
production-only `npm-shrinkwrap.json` files, so a native npm install no longer records their
development tooling as `extraneous` lock entries.

- Upgrade from 3.13.0, 3.13.1 or 3.13.2 with `plan` and `upgrade` as usual; no flag is needed.
- Host agents: `./hive.sh post-upgrade` (or `./hive.sh magnus-agent install`) moves the agents
  the suite installs to 3.2.1. Fleet agents that Magnus manages move with
  `magnus-server agents upgrade --to 3.2.1`.
- An external Magnus is upgraded outside this release. The **Installed software** page compares
  it with this release's pins: a Magnus and agents on 3.2.1 match 3.13.3, and ones still on 3.2.0
  are listed as differing until they are upgraded.

## Suite 3.13.2: console-clients checklist

Suite 3.13.2 pins the same products as 3.13.0 and 3.13.1, and only the controller changes, so run it
from its own release checkout. Upgrading from 3.13.0 or 3.13.1 needs no flag and no configuration
change. From 3.12.9, follow the 3.13.0 steps below with 3.13.2, including the `hivexui-registry`
policy before any `plan`, `rehearse` or `upgrade`.

- `console-clients add` reads Oathweave before it asks for confirmation. When every client exists
  and `SUITE_ADMIN` has their permissions, it changes nothing and records
  `oathweave-console-clients` as done, without `--yes`. An unattended `post-upgrade` therefore no
  longer leaves that item pending after each upgrade. Earlier controllers left it pending; settle
  it there with `./hive.sh setup done oathweave-console-clients` once the clients exist.

```bash
./hive.sh upgrade --config ~/.config/hive/ID/installation.json --release 3.13.2
```

## Suite 3.13.1: controller fixes

Suite 3.13.1 pins the same products as 3.13.0, and only the controller changes, so run it from its
own release checkout. Upgrading from 3.13.0 needs no flag and no configuration change. From 3.12.9,
follow the 3.13.0 steps below with 3.13.1, including the `hivexui-registry` policy before any
`plan`, `rehearse` or `upgrade`.

- `rehearse` followed by `upgrade` under one plan works again when the release changes the ingress
  Caddyfile. 3.13.0 refused the upgrade with "Deployment input artifacts changed for this plan".
- A failed read-only check (stage, compatibility, preflight, native preparation) closes its
  transaction as aborted on an installation migrated from native services, as it does on others.
  3.13.1 does not close a transaction that a 3.13.0 controller already left prepared; `doctor`
  reports it as an incomplete transaction.

```bash
./hive.sh upgrade --config ~/.config/hive/ID/installation.json --release 3.13.1
```

## Suite 3.13.0: Hive Registry 1.4.1 and the Installed software view

Suite 3.13.0 pins the Hive Registry 1.4.1, HiveXUI 0.11.0 and Magnus 3.2.0 (the server, the fleet
gateway and the host agent package), and adds HiveXUI's Installed software view: the signed
release's pins beside what each host reports it runs. No storage format changes and no product has
a migration, so an upgrade from 3.12.9 needs no flag. The controller changes, so run 3.13.0 from
its own release checkout. For an existing installation:

1. Before any `plan`, `rehearse` or `upgrade` of 3.13.0, add the `hivexui-registry` policy to
   `IAM_BROWSER_CLIENT_POLICIES` in `config/oathweave.env`, as `deployment/FULL.md`, "Hive
   Registry inventory", describes. A rehearsal or upgrade pins the deployment inputs of its plan,
   so an edit after one of them makes that plan refuse ("Deployment input artifacts changed for
   this plan") until the installation has a new `configurationRevision`.
2. Upgrade. The controller writes `config/hive-registry/identity.json` and `authority.pem`.
3. Run `./hive.sh console-clients add` (or `./hive.sh post-upgrade` where it runs it), then sign
   out of the console and in again.
4. Run `./hive.sh status` once, so the registry records what the hosts run.

With the 3.13.0 controller itself, do not run `rehearse` on its own before the upgrade: the
upgrade installs the new Caddyfile (which adds the Magnus installation route) after the
rehearsal pinned the old one, and refuses. The upgrade rehearses its own pre-change backup
anyway. Up to 3.13.0, an installation that moved from native services with `migrate-native`
does not close a transaction that failed in its read-only checks. Each further command then
stops with "A different transaction requires recovery". Releases after 3.13.0 fix both.

A rollback to a release with an older registry keeps both files and the recorded observations;
that registry ignores them. Step 1 and the new registry files change the deployment inputs that
3.12.9's own plan pinned, so a rollback to 3.12.9 stops with "Deployment input artifacts changed for
this plan" until the installation has a new `configurationRevision`: set one in
`installation.json`, then run the rollback from the retained 3.12.9 checkout.

```bash
./hive.sh plan    --config ~/.config/hive/ID/installation.json --release 3.13.0
./hive.sh upgrade --config ~/.config/hive/ID/installation.json --release 3.13.0
```

After upgrading, `./hive.sh post-upgrade` from the retained 3.13.0 checkout also updates the
installer-owned Magnus host agent to 3.2.0. An external Magnus and other fleet nodes are upgraded
by their own reviewed procedures. A native npm install of Magnus 3.2.0 no longer needs an `effect`
override; Magnus's own installation report shows whether it matches the shipped lock.

## Suite 3.12.9: effect 3.22.1 in the Prisma-based products

Suite 3.12.9 pins Oathweave 2.3.2, Emberpath 2.5.4, Embermend 0.3.4, Magnus 3.1.5 (the server,
the fleet gateway and the host agent package, with Ardent 3.1.4) and ChatterMost 0.7.2, each of
which forces the npm package `effect` to 3.22.1 (CVE-2026-121707). It also brings 3.12.8's
changes, HiveXUI 0.10.3 among them, because 3.12.8 was tagged but never published. The datastore
profile, the storage recovery profile and the controller are those of 3.12.7, and none of these
product versions has a database migration, so an upgrade from 3.12.7 needs no migration flag.

```bash
./hive.sh plan    --config ~/.config/hive/ID/installation.json --release 3.12.9
./hive.sh upgrade --config ~/.config/hive/ID/installation.json --release 3.12.9
```

After upgrading, run `./hive.sh post-upgrade` from the retained 3.12.9 checkout to update the
installer-owned Magnus host agent to 3.1.5. An external Magnus and other fleet nodes are upgraded by
their own reviewed procedures, not by this upgrade.

## Suite 3.12.8: HiveXUI 0.10.3, Embermend 0.3.3 and Magnus 3.1.4

Suite 3.12.8 was tagged but never published; upgrade to [3.12.9](#suite-3129-effect-3221-in-the-prisma-based-products) instead.

Suite 3.12.8 pins HiveXUI 0.10.3, Embermend 0.3.3 and Magnus 3.1.4 (the server, the fleet gateway
and the host agent package, with Ardent 3.1.4). Every other product pin, the datastore profile,
the storage recovery profile and the controller are those of 3.12.7, and none of these product
versions has a database migration, so an upgrade from 3.12.7 needs no migration flag.

```bash
./hive.sh plan    --config ~/.config/hive/ID/installation.json --release 3.12.8
./hive.sh upgrade --config ~/.config/hive/ID/installation.json --release 3.12.8
```

After upgrading, run `./hive.sh post-upgrade` from the retained 3.12.8 checkout to update the
installer-owned Magnus host agent to 3.1.4. An external Magnus and other fleet nodes are upgraded by
their own reviewed procedures, not by this upgrade.

## Suite 3.12.7: Oathweave client addresses

Suite 3.12.7 pins the same products as 3.12.6 and changes only the controller, so run it from its
own release checkout. Upgrading from 3.12.6 needs no migration flag.

```bash
./hive.sh plan    --config ~/.config/hive/ID/installation.json --release 3.12.7
./hive.sh upgrade --config ~/.config/hive/ID/installation.json --release 3.12.7
```

On an installation without `console.networkSubnet`, the upgrade sets Oathweave's
`TRUSTED_PROXY_IPS` to Docker's private ranges, so Oathweave limits sign-ins and records audit
events per browser instead of per ingress. It replaces a `TRUSTED_PROXY_IPS` you added to
`config/oathweave.env` by hand on such an installation; the private ranges include the suite
network's range that the earlier instructions named. Installations with a pinned network, which
includes every `migrate-native` installation, are unchanged. IP allowlists on Oathweave accounts or
clients now see browser addresses rather than the ingress's.

## Suite 3.12.6: ChatterMost 0.7.1

Suite 3.12.6 updates ChatterMost and its migrator to 0.7.1, a security release with no database
migration. Every other product pin stays that of 3.12.5. Upgrading from 3.12.5 needs no migration
flag. The controller changes, so run 3.12.6 from its own release checkout.

```bash
./hive.sh plan    --config ~/.config/hive/ID/installation.json --release 3.12.6
./hive.sh upgrade --config ~/.config/hive/ID/installation.json --release 3.12.6
```

ChatterMost 0.7.1 limits each client address to 200 open WebSocket connections, 120 handshakes a
minute and 20 connections that have not signed in, and counts sign-up, password changes and
password resets against the per-address sign-in budget (`RATE_LIMIT_LOGIN_SOURCE_MAX`, 20 a
minute). With the ingress on ChatterMost's host and no published ChatterMost port, the upgrade
sets ChatterMost's `TRUSTED_PROXIES` so these limits apply to each browser rather than to the
ingress; see [Client addresses and reverse proxies](deployment/README.md#client-addresses-and-reverse-proxies).
A ChatterMost placed on another host with a published port keeps using the connecting address.

## Suite 3.12.5: Fleet test submissions

Suite 3.12.5 updates HiveXUI to 0.10.2. The Fleet Submit test form now sends task UUIDs
that Ardent accepts. HiveXUI includes the patched nginx package, and Hive ingress 2.0.7
rebuilds Caddy with Go 1.26.11. Upgrading from 3.12.4 requires no migration flag.

```bash
./hive.sh plan    --config ~/.config/hive/ID/installation.json --release 3.12.5
./hive.sh upgrade --config ~/.config/hive/ID/installation.json --release 3.12.5
```

## Suite 3.12.4: guided setup

New installations launched with `--release latest` use the retained, verified checkout for
installation, certificate renewal and backup pruning. Use the checkout path printed by the launcher
when resuming setup with the exact version. Guided Tailscale setup accepts `tailscale` as the
HTTPS bind address and reuses the certificate it prepares, including for a custom HTTPS port.
Suite 3.12.4 uses the product and datastore digests from 3.12.3. Use the normal signed upgrade
from 3.12.3:

```bash
./hive.sh plan    --config ~/.config/hive/ID/installation.json --release 3.12.4
./hive.sh upgrade --config ~/.config/hive/ID/installation.json --release 3.12.4
```

## Suite 3.12.3: bounded container logs and security updates

Suite 3.12.3 pins HiveMem 1.9.1 and HiveXUI 0.10.1, which move to `@hivemagnus/hive-common` 0.5.1
(a fix for a polynomial regular-expression denial of service in the path handling of the
unauthenticated health endpoints), and the Hive Registry 1.3.2 (image 2.0.9), which no longer logs
successful health and readiness probes. Every other product pin, the datastore profile and the
storage recovery profile are those of 3.12.2 (Cindertrace 0.8.1, Emberpath 2.5.3 and Magnus 3.1.3).
None of the three has a schema migration: HiveMem 1.9.1 keeps 1.9.0's storage, so its signed
initialization verifier finds nothing pending on an installation already on 3.12.x, and an upgrade
from 3.12.2 needs no migration flag. The controller changes (bounded container logs, below), so a
checkout of the 3.12.2 tag refuses the 3.12.3 manifest; run 3.12.3 from a checkout of its tag
(`--release latest` or `--release 3.12.3`).

```bash
./hive.sh plan    --config ~/.config/hive/ID/installation.json --release 3.12.3
./hive.sh upgrade --config ~/.config/hive/ID/installation.json --release 3.12.3
```

**Bounded container logs.** From suite 3.12.3, every container the controller creates rotates its
Docker log (`json-file`, 10 MB per file, 3 files), as
[Container logs](deployment/README.md#container-logs) describes. The setting is part of the
rendered Compose file, and Docker Compose recreates a container whose configuration changed. So
the first upgrade to 3.12.3 recreates every container on each host, including datastores and other
services whose image is unchanged, instead of only restarting them. Data is kept: every store is a
bind mount of the installation's `data` directory.

The log of each replaced container is removed with it, so `docker logs` shows nothing from before
the upgrade. Save what you need first, for example
`docker compose -f /opt/hive/compose.json logs --no-color > /path/to/pre-upgrade.log`, with the
installation directory in place of `/opt/hive`. This is also how an oversized log goes away.

To use other bounds, set `containerLogs` (`{"maxSize":"50m","maxFiles":5}`) in the installation
file before the upgrade. Containers that the suite did not create keep their own log settings; see
[Container logs](deployment/README.md#container-logs) for a host-wide Docker default.

**Upgrading from 3.12.1, 3.12.0 or 3.11.x.** Follow [Suite 3.12.2](#suite-3122-cindertrace-081),
[Suite 3.12.1](#suite-3121-memory-identity-relink-fixes) and, from 3.11.x,
[Suite 3.12.0](#suite-3120-cindertrace-080-and-the-emberpath-memory-principal) with
`--release 3.12.3`: from 3.11.x the upgrade needs `--allow-migrations` where `hive-router` owns
HiveMem data, as for 3.12.0.

**Rolling back to 3.12.2.** Run the rollback from the 3.12.2 release checkout. It restores the
pre-upgrade backup and the older Compose file, and recreates every container again, with Docker's
unbounded default log and without the history of the 3.12.3 containers. Controllers before 3.12.3
refuse the `containerLogs` key, so remove it from the installation file first.

## Suite 3.12.2: Cindertrace 0.8.1

Suite 3.12.2 pins Cindertrace 0.8.1, for Cindertrace and the optional `cindertrace-collector`
component, which run the same image. Every other product pin, the datastore profile and the storage
recovery profile are those of 3.12.1 (HiveXUI 0.10.0, HiveMem 1.9.0, Emberpath 2.5.3 and Magnus
3.1.3). Cindertrace 0.8.1 has no schema migration, so the upgrade's Cindertrace verifier finds
nothing pending and an upgrade from 3.12.1 needs no migration flag. The controller changes (the
collector's source settings accept the quiet-source settings), so a checkout of the 3.12.1 tag
refuses the 3.12.2 manifest; run 3.12.2 from a checkout of its tag (`--release latest` or
`--release 3.12.2`).

```bash
./hive.sh plan    --config ~/.config/hive/ID/installation.json --release 3.12.2
./hive.sh upgrade --config ~/.config/hive/ID/installation.json --release 3.12.2
```

What changes in Cindertrace's collector:

- **UniFi flows from Loki.** UniFi Network 11 no longer logs firewall hits as syslog lines, so the
  `netflow` and `unifi_dns` sources went silent. The collector now reads a gateway's IPFIX or
  NetFlow v9 export decoded by GoFlow2 (JSON lines in Loki): each flow becomes a `netflow` event,
  plus `unifi_dns` activity when either port is 53, with byte, packet and flow counts scaled by the
  sampling rate. It also reads UniFi's CEF lines (Activity Logging to a SIEM server) on the Loki
  path. Point `LOKI_QUERY` at every stream of the gateway, as
  [Events from a separate logging host](deployment/FULL.md#events-from-a-separate-logging-host)
  describes, then repeat `cindertrace-collector add ID --run` to recreate the collector.
- **Summary rows.** Five-minute flow and firewall summaries no longer lose the rows of later polls
  of the same window as duplicates, so busy windows count every row.
- **Quiet sources.** A watched source whose polls succeed but that has had no event for
  `SECURITY_FUSION_QUIET_AFTER_HOURS` hours (default 6, `0` turns it off) reports `degraded` under
  **Cindertrace > Sources**. `SECURITY_FUSION_QUIET_SOURCES` lists the watched sources (default
  `netflow`). The defaults apply after the upgrade: a collector that polls `netflow` but receives
  no flows shows `netflow` as `degraded` after six hours. Set either in the collector's source settings file.

**Upgrading from 3.12.0 or 3.11.x.** Follow [Suite 3.12.1](#suite-3121-memory-identity-relink-fixes)
and, from 3.11.x, [Suite 3.12.0](#suite-3120-cindertrace-080-and-the-emberpath-memory-principal)
with `--release 3.12.2`: from 3.11.x the upgrade needs `--allow-migrations` where `hive-router`
owns HiveMem data, as for 3.12.0.

**Rolling back to 3.12.1.** Run the rollback from the 3.12.1 release checkout. It restores the
pre-upgrade backup; the 3.12.1 controller refuses a collector source settings file that sets the
quiet-source settings, so remove them before repeating `cindertrace-collector add ID --run` there.

## Suite 3.12.1: memory identity relink fixes

Suite 3.12.1 is a controller release. Every product pin, the datastore profile and the storage
recovery profile are those of 3.12.0 (Cindertrace 0.8.0, HiveXUI 0.10.0, HiveMem 1.9.0, Emberpath
2.5.3 and Magnus 3.1.3), and no storage format changes, so an upgrade from 3.12.0 needs no
migration flag. The controller has a new signed source digest, so a checkout of the 3.12.0 tag
refuses the 3.12.1 manifest; run 3.12.1 from a checkout of its tag (`--release latest` or
`--release 3.12.1`).

```bash
./hive.sh plan    --config ~/.config/hive/ID/installation.json --release 3.12.1
./hive.sh upgrade --config ~/.config/hive/ID/installation.json --release 3.12.1
```

The release fixes two cases of the HiveMem identity re-link that runs with
[Emberpath's memory principal](#emberpaths-memory-principal-hive-router-becomes-emberpath):

- **HiveMem's own admin token.** The re-link also re-issues `HIVEMEM_ADMIN_TOKEN` in HiveMem's
  environment when it was issued for the old ID, with the same role, scope and remaining lifetime.
  Under 3.12.0 an installation that completed the rename kept an operator token that HiveMem
  refuses.
- **An interrupted re-link.** A crash between moving a re-linked settings file into place and
  pinning it is now finished by repeating the same upgrade. The deployment-input checks first
  complete, or refuse, this plan's journaled change, and accept only files that hold their
  journaled original or staged content and a result equal to the journaled digest.

**Installations already on 3.12.0.** An installation that already completed the rename under
3.12.0 needs nothing extra and no flag. The upgrade's verifier finds the rename complete, and the
re-link that follows it re-issues a `HIVEMEM_ADMIN_TOKEN` still issued for `hive-router` (an
expired one is left as it is; issue a new one with `hivemem-server issue-token` when needed).
Fresh installations, and installations without data owned by `hive-router`, are not affected.

**Upgrading from 3.11.x.** Follow [Suite 3.12.0](#suite-3120-cindertrace-080-and-the-emberpath-memory-principal)
with `--release 3.12.1`: the upgrade needs `--allow-migrations` where `hive-router` owns HiveMem
data, as for 3.12.0, and now gets both fixes above, so a retry finishes an interrupted re-link.

**Rolling back to 3.12.0.** Run the rollback from the 3.12.0 release checkout. It restores the
pre-upgrade backup; both releases pin the same products.

## Suite 3.12.0: Cindertrace 0.8.0 and the emberpath memory principal

Suite 3.12.0 pins Cindertrace 0.8.0, HiveXUI 0.10.0, HiveMem 1.9.0, Emberpath 2.5.3 and Magnus
3.1.3 (the server, the fleet gateway and the host agent package, with Ardent 3.1.4). Every other
product pin, the datastore profile and the storage recovery profile are those of 3.11.2. Pass
`--release 3.12.0` to later commands, as described in
[the upgrade procedure](deployment/QUICKSTART.md#8-upgrade). From an earlier release, follow the
steps below for each release you skip.

**`--allow-migrations` where `hive-router` owns HiveMem data.** HiveMem 1.9.0 brings the signed
initialization that moves HiveMem data from `hive-router` to `emberpath`, described in
[Emberpath's memory principal](#emberpaths-memory-principal-hive-router-becomes-emberpath).
Installations migrated from the native Hive Router (`hive.sh migrate-native`) have such data, so
their upgrade needs `--allow-migrations`; without it the upgrade stops before any service is
stopped. Fresh installations need no flag. Run the read-only `rename-agent --dry-run` shown there
first to see what moves.

```bash
./hive.sh plan    --config ~/.config/hive/ID/installation.json --release 3.12.0 --allow-migrations
./hive.sh upgrade --config ~/.config/hive/ID/installation.json --release 3.12.0 --allow-migrations
```

**New controller.** The controller gains `hive.sh add`, the HiveMem rename and credential re-link
and the managed collector, so 3.12.0 has its own controller source and a checkout of the 3.11.2 tag
refuses the 3.12.0 manifest. Run 3.12.0 from a checkout of its tag; `--release latest` and
`--release 3.12.0` select it.

**Cindertrace's standalone console is gone.** Cindertrace 0.8.0 no longer ships its own console.
The suite already served Cindertrace through HiveXUI, so an installation with Cindertrace needs no
change; HiveXUI 0.10.0 adds a Cindertrace recovery sign-in with Cindertrace's local accounts for
when Oathweave is unavailable. Cindertrace's API, collector and schema migrations are unchanged
from 0.7.2, and its settings, including `SECURITY_CONSOLE_TOKEN_SECRET`, stay as they are.

**Adding Cindertrace to an installation.** An installation without Cindertrace can add it after
upgrading, with `./hive.sh add cindertrace --config FILE --release 3.12.0`; see
[Adding a product to an existing installation](deployment/FULL.md#adding-a-product-to-an-existing-installation).

**Managed collector.** The release offers the optional `cindertrace-collector` component, which
runs Cindertrace's collector inside the installation for sources outside it, such as a logging
host's Loki. No profile selects it, so an upgrade does not start it; add it with
`cindertrace-collector add ID --sources ... --run` and `./hive.sh add cindertrace-collector`, as
[Events from a separate logging host](deployment/FULL.md#events-from-a-separate-logging-host)
describes.

**Magnus 3.1.3.** An external Magnus is upgraded by its own procedure, not by this upgrade. A
leftover `SECURITY_FUSION_RECEIPT_SIGNING_KEY` in a Magnus server's settings is now ignored.

**Rolling back to 3.11.2.** Run the rollback from the 3.11.2 release checkout. It restores the
pre-upgrade backup, which holds HiveMem data and the memory credential from before the rename.
The `cindertrace-collector` component is new in 3.12.0 and 3.11.2 does not know it, so add it only
once you no longer expect to roll back.

## Suite 3.11.2: product maintenance releases

Suite 3.11.2 pins Oathweave 2.3.1, HiveMem 1.8.1, Emberpath 2.5.2, Magnus 3.1.2 (the server, the
fleet gateway and the host agent package) and Ardent Project Studio 0.4.3. HiveXUI stays at 0.9.2;
its Magnus browser contract is byte-identical to Magnus 3.1.2's. The datastore profile and the
storage recovery profile are those of 3.11.1, no storage format changes and none of these product
versions has a database migration, so an upgrade from 3.11.1 needs no flag. Pass `--release 3.11.2`
to later commands, as described in [the upgrade procedure](deployment/QUICKSTART.md#8-upgrade).
From an earlier release, follow the steps below for each release you skip, with 3.11.2 in place of
3.11.1.

**New controller.** The `hive.sh --help` text changed, so 3.11.2 has its own controller source and
a checkout of the 3.11.1 tag refuses the 3.11.2 manifest. Run 3.11.2 from a checkout of its tag;
`--release latest` and `--release 3.11.2` select it.

**Emberpath security export.** Emberpath 2.5.2 removes the static security-export credential,
which expired on 2026-09-30. `GET /api/security/events` accepts only the `security-exporter`
Oathweave client token. `HIVE_ROUTER_SECURITY_EXPORT_TOKEN_HASH` in `config/emberpath.env` is now
ignored and can stay. `HIVE_ROUTER_SECURITY_EXPORT_STATIC_FALLBACK_ENABLED=true` is still refused at
startup, as it has been since the credential expired, so a running Emberpath 2.5.1 needs no change.

**Oathweave SDK issuer.** The Oathweave server is unchanged. Its in-repository SDK now expects the
server's default issuer, `hive-iam`, when a verifier sets none. This affects only services built
against that SDK; no pinned suite image changes because of it, so an installation needs no change.

**Rolling back to 3.11.1.** Nothing to change first; the earlier product versions read the same
data. Run the rollback from the 3.11.1 release checkout.

## Suite 3.11.1: Cindertrace 0.7.2

Suite 3.11.1 pins Cindertrace 0.7.2, whose standalone console is built with Next.js 16.4.6 for
GHSA-mfr8-8qww-v76h. Every other product pin, the datastore profile, the storage recovery profile
and the controller are those of 3.11.0, and no storage format changes, so an upgrade from 3.11.0
needs no flag. Cindertrace 0.7.2 has no database migration. Pass `--release 3.11.1` to later
commands, as described in [the upgrade procedure](deployment/QUICKSTART.md#8-upgrade). From an
earlier release, follow the steps below for each release you skip, with 3.11.1 in place of 3.11.0.

**Shared controller.** 3.11.0 and 3.11.1 have the same controller source, so a checkout of either
tag can run both releases' commands; give the exact version to keep 3.11.1's pins. The
administrator access journals of 3.11.0 keep the same ownership under 3.11.1.

**Rolling back to 3.11.0.** Nothing to change first; Cindertrace 0.7.1 reads the same data.

## Suite 3.11.0: guided administrator product access

Suite 3.11.0 pins HiveMem 1.8.0 and ChatterMost 0.7.0, including the matching ChatterMost
migrator. These releases add product-owned native administrator provisioning with durable
receipts. All other product pins, datastore and storage recovery profiles, and storage formats
are unchanged from 3.10.0. An upgrade from 3.10.0 needs no `--allow-migrations`; older releases
retain the upgrade requirements documented below.

After upgrading, create your administrator in **Oathweave > Users**, then run:

```bash
./hive.sh admin-access setup --release 3.11.0
```

Choose the exact account and review its installed products. Hive requests sudo when needed,
creates separate native identities, installs their reviewed links and grants, adds the Suite
Administrator role and reconnects affected services. It preserves the initial operator, other
accounts, service identities and existing ownership. Sign out of HiveXUI and sign in with your
own account afterward. No manual identity-file editing is needed; see
[administrator product access](deployment/QUICKSTART.md#administrator-product-access).

The setup checklist now tracks `administrator-product-access` separately from `first-admin`.
Guided setup records both as done after it finishes. Upgrading alone does not choose an account
or grant product access automatically. A successful interactive upgrade offers the guided flow;
an unattended upgrade leaves it for you to run later. For an exact account, use
`admin-access setup alice`. Read its retained operation with `admin-access status alice`.
After an interruption, repeat the same
setup command to follow the original account IDs and protected receipts rather than creating a
replacement identity.

The command covers products managed by this installation; an external Magnus needs its own
installation owner. Native agent enrollment and service permissions stay unchanged. Embermend
application and target scopes stay explicit. If existing administrator permissions include web
terminal access, the review discloses it and Magnus keeps its usual recent-authentication check.

After guided administrator setup, keep using the retained 3.11.0 or a newer compatible
controller for maintenance. Earlier controllers change ownership of the new protected access
journals during privileged operations on operator-owned installations. Returning to one needs
a separately reviewed recovery procedure; retain the verified 3.11.0 backup and its receipts.

Take and rehearse a fresh backup after access setup. Restoring an archive from before a grant
change also requires reviewing its configuration changes with the installation owner; the restore
guard refuses to pair archived accounts with changed secrets or identity links.

## Suite 3.10.0: guided Ardent assistants and local native recovery

Suite 3.10.0 adds `./hive.sh ardent setup`: it installs the verified Ardent package staged by
Magnus and creates the default `assistant` profile through Magnus's durable New Agent workflow.
The guided local installer offers this after full-node enrollment. Existing installations can
run it from the retained 3.10.0 checkout when ready. Supply a model endpoint and model when
prompted; Hive configures HiveMem, starts the profile and tests real inference. See
[Create an Ardent assistant](deployment/FULL.md#create-an-ardent-assistant) for named profiles,
unattended settings and explicit recovery. Existing profiles are preserved; an upgrade never
creates or reconfigures one automatically.

Every product pin remains that of 3.9.8, including Magnus 3.1.1 and its staged Ardent 3.1.3.
The datastore and storage recovery profiles, initialization contracts and storage formats are
unchanged. An upgrade from 3.9.8 needs no `--allow-migrations`; older releases retain the upgrade
requirements documented below. Run `./hive.sh post-upgrade` to verify the existing agent and
package versions and settle applicable checklist steps. Package maintenance keeps enrollment
scope and existing native identities, credentials and journals.

Local native backup, rehearsal and restore now request ordinary sudo authorization from the
installation operator when needed. Protected unattended and remote privilege configuration
remains explicit. Profiles created through New Agent are included automatically in native suite
backups; do not duplicate them in installation.json `agents`. The recovery contracts and held
restore review remain unchanged. Keep the selected release checkout for later lifecycle commands
and scheduled services.

## Suite 3.9.8: guided setup and verified quick diagnostics

Suite 3.9.8 pins Magnus 3.1.1: the server, fleet gateway and node agent. Every other product
pin, datastore profile, storage recovery profile and storage format stays unchanged from 3.9.7,
so an upgrade from 3.9.7 needs no migration flag. The controller includes the guided setup fixes
below and has a new signed source digest. Existing backups and native profiles keep their
normal recovery contracts.

After upgrading, run `./hive.sh post-upgrade` from the retained 3.9.8 checkout to update the
installer-owned Magnus host agent to 3.1.1. Update other fleet nodes through their usual reviewed
agent upgrade workflow. Package updates preserve each node's existing enrollment scope; they do
not grant full-node capabilities automatically.

**Fresh local setup.** Full-node enrollment recognizes the exact backup-pruning job written by
this installation's current controller, after an independent privileged crontab read. The job
stays outside Magnus management. Edited jobs, duplicate jobs and unrelated user schedules still
require independent review. Successful certificate renewal scheduling and host-agent installation
are recorded immediately in the setup checklist, including when a later review fails. The initial
operator's personal administrator step remains pending. Child commands retain the selected release,
manifest, signature and trust key.

**Quick diagnostics.** The fixed **magnus status** action runs only the exact reviewed service
status diagnostic, with its bounded timeout, signed completion receipt and empty supervised process
group. Both the server and agent need 3.1.1 for the new completion registry. Unsupported quick
commands return an explanatory refusal before any work is registered or dispatched; use node
diagnostics or the dedicated managed operation instead. Verified historical uptime receipts keep
their original authority. Existing uncertain work is never relabeled or replayed and still needs
its normal explicit reconciliation.

## Suite 3.9.7: HiveXUI 0.9.2 and the read-only software status

Suite 3.9.7 pins HiveXUI 0.9.2. Every other product pin, including Magnus 3.1.0, the datastore
profile, the storage recovery profile and the controller are those of 3.9.6, and no storage format
changes, so an upgrade from 3.9.6 needs no flag. Pass `--release 3.9.7` to later commands, as
described in [the upgrade procedure](deployment/QUICKSTART.md#8-upgrade). From 3.8.1, upgrade
directly to 3.9.7 as described for 3.9.0 below, with 3.9.7 and Magnus 3.1.0 in place of 3.9.0 and
3.0.1.

**The node software card reads a read-only endpoint.** In HiveXUI, **Magnus > Fleet > Nodes**, node
detail's Software revisions card reads Magnus 3.1.0's `GET /api/v1/nodes/:nodeId/software` when
you press **Check versions** or **Read update cache**: the installed versions (Node.js, npm,
Python, Redis, Docker, Tailscale and the Magnus agent) and the pending updates in the node's
existing APT cache, with the time of its last repository refresh. It no longer dispatches shell
commands, refreshes no repository and runs nothing on the node, and node viewers can use it. The
suite ingress already passes this route. **APT upgrade** stays an explicit operator command.

**Mixed fleets.** A node whose agent is older than 3.1.0 answers `SOFTWARE_STATUS_UNAVAILABLE`;
the card then says that the software status is unavailable and to update Magnus and the node agent,
instead of showing an error, and it never falls back to a shell command. The same applies to an
external Magnus server older than 3.1.0, which does not have the route. Move agents that Magnus
manages with `magnus-server agents upgrade --to 3.1.0`, and the agents the suite installs with
`./hive.sh post-upgrade` or `./hive.sh magnus-agent install --config FILE --host HOST`.

**Rolling back to 3.9.6.** Nothing to change first; the card then dispatches its earlier shell
probes again.

## Suite 3.9.6: Magnus 3.1.0 and native profile backup

Suite 3.9.6 pins Magnus 3.1.0: the server, the fleet gateway and the node agent. Every other
product pin, the datastore profile, the storage recovery profile and the controller are those of
3.9.5, and no storage format changes. Magnus 3.1.0 adds no migrations and no settings, so an upgrade
from 3.9.5 needs no flag. Pass `--release 3.9.6` to later commands, as described in
[the upgrade procedure](deployment/QUICKSTART.md#8-upgrade). From 3.8.1, upgrade directly to 3.9.6
as described for 3.9.0 below, with 3.9.6 and Magnus 3.1.0 in place of 3.9.0 and 3.0.1.

**Native profiles are now backed up.** Magnus 3.1.0 is the first release whose agent has the
`native-snapshot` contract. Once the Magnus agent that the Hive installer created runs 3.1.0,
backups, upgrades and rollbacks include its Ardent profiles, also those created through **New
Agent**, and the receipt's `nativeProfiles` reads `"included": true`; see
[Magnus-managed native profiles](deployment/BACKUPS.md#magnus-managed-native-profiles). No flag or
setting turns this on. The upgrade's own pre-change backup still runs with the agent that was
installed before, so it lists those profiles as not included ("the installed Magnus agent 3.0.3
has no native-snapshot"). `./hive.sh post-upgrade` (or `./hive.sh magnus-agent install`) then moves
the agent to the pinned 3.1.0, and every later backup includes them.

**Agents installed outside the Hive installer are still not part of Hive backups.** A host without
the installation's Magnus component, or a Magnus agent without the installer's ownership record
(such as a fleet agent that Magnus upgrades with `magnus-server agents upgrade --to 3.1.0`), is
listed as not included, as in 3.9.5. Back those agents up with their own tooling.

Magnus 3.1.0 mixes with 3.0.x agents in both directions; agents that Magnus manages move with
`magnus-server agents upgrade --to 3.1.0`. An external Magnus is upgraded outside this
installation.

**Rolling back to 3.9.5.** Nothing to change first. The 3.9.5 controller restores and rehearses
archives that hold native profiles, and its rollback takes and rehearses its own backup.

## Suite 3.9.5: restored copies and native profile backup

Suite 3.9.5 changes no storage format and needs no flag from 3.9.4: every product pin (including
Magnus 3.0.3), the datastore profile and the storage recovery profile are those of 3.9.4. The
controller changes, so the release pins a new controller digest. Pass `--release 3.9.5` to later
commands, as described in [the upgrade procedure](deployment/QUICKSTART.md#8-upgrade). From
3.8.1, upgrade directly to 3.9.5 as described for 3.9.0 below, with 3.9.5 and Magnus 3.0.3 in
place of 3.9.0 and 3.0.1.

**Restored copies.** Only the newest passed rehearsal keeps its full restored copy. The rehearse
step of the upgrade releases the restored files (`data/`, `config/`, `releases/`, `agents/`,
`agent-profiles/`, `native-profiles/`) of every earlier passed rehearsal before it extracts its
own, so the upgrade needs less free space than before. Each one keeps `result.json`,
`isolated.json`, `resources-released.json`, its container diagnostics and its small records, and
gains `copy-released.json`. Their backups stay restorable, also by the 3.9.4 and earlier
controllers. Rehearsals made by older controllers keep their copies until
`./hive.sh backups prune --apply` or the [daily prune](deployment/BACKUPS.md#daily-pruning)
releases them; the dry run lists them as `release copy, frees X`. `--keep-full N` keeps more full
copies for one run. `./hive.sh rehearse --archive ID` rebuilds one to inspect it. On an
installation with several hosts, `prune --apply` now releases copies on each host; removing
pairs stays refused there. See [restored copies](deployment/BACKUPS.md#restored-copies).

**Native profiles in backups.** From 3.9.5, backups, upgrades and rollbacks also capture the
Ardent profiles of the Magnus agent that the Hive installer created, even when the installation
file has `"agents": []`; see [Magnus-managed native profiles](deployment/BACKUPS.md#magnus-managed-native-profiles).
This needs a Magnus agent with the `native-snapshot` contract, and **no Magnus release has it
yet**: with Magnus 3.0.3, those profiles are listed as not included ("the installed Magnus agent
3.0.3 has no native-snapshot"), in the output and in the backup receipt, and the backup and the
upgrade continue, as in 3.9.4, which backed up no native profiles. **Agents installed outside the
Hive installer are not part of Hive backups**: a host without the installation's Magnus
component, or a Magnus agent without the installer's ownership record (such as a fleet agent
owned by an ordinary account), is also listed as not included. The receipt's `nativeProfiles`
field says which. An installer-owned agent that fails its ownership checks, or whose
`native-snapshot` fails, stops the backup. If that happens in an upgrade before anything was
reserved or stopped, the transaction closes as aborted and the suite keeps serving.

An archive that does contain `native-profiles/` (only possible with a Magnus agent that has the
contract) needs the 3.9.5 or later controller to rehearse or restore: older controllers refuse
the member. Restoring a suite-only archive onto an installation whose installer-owned agent now
has backed-up profiles is refused, because it would orphan them. 3.9.5 also adds
`restore --prepare-reconciliation` and the narrow `backup --native-recovery` and
`restore --native-recovery` operations; see [backups](deployment/BACKUPS.md).

**Rolling back to 3.9.4.** Nothing to change first. The 3.9.4 controller accepts rehearsals whose
copies were released, and its rollback takes and rehearses its own backup. If the daily prune is
enabled, the rollback points it back at the 3.9.4 controller.

## Suite 3.9.4: daily backup pruning

Suite 3.9.4 changes no storage format and needs no flag from 3.9.3: every product pin, the datastore
profile and the storage recovery profile are those of 3.9.3. The controller changes, so the release
pins a new controller digest. Pass `--release 3.9.4` to later commands, as described in
[the upgrade procedure](deployment/QUICKSTART.md#8-upgrade). From 3.8.1, upgrade directly to 3.9.4
as described for 3.9.0 below, with 3.9.4 and Magnus 3.0.3 in place of 3.9.0 and 3.0.1.

The 3.9.4 controller can prune old backup and rehearsal pairs every day on a single-host
installation: `./hive.sh backups schedule enable [--at HH:MM]` adds one line to the crontab of the
controller's user that runs `backups prune --apply` with the installation file's retention settings,
`status` shows it with its last run and `disable` removes it. See
[daily pruning](deployment/BACKUPS.md#daily-pruning). An upgrade changes nothing here: an existing
installation prunes on a schedule only once its operator enables it, and installations with
several hosts refuse, as for `prune --apply`. Guided setup of a new single-host installation offers
it, defaulting to yes at 03:40, and saved configurations ask for it with
`"retention": {"schedule": "HH:MM"}`, which `install` reads.

Each scheduled run prunes only while the installation's receipt names the controller the line runs.
A later `upgrade`, `rollback` or `adopt` moves the line to the controller it ran with, so run them
with the controller that should own the schedule. A run that meets another controller's receipt,
the controller lock or an open transaction removes nothing and says so in its log.

The 3.9.3 and older controllers do not know the line and refuse `retention.schedule`. Before rolling
back to one of them, run `./hive.sh backups schedule disable` with the 3.9.4 controller and remove
`retention.schedule` from the installation file. A line left behind refuses every run, because the
installation then runs another controller; remove it with `crontab -e`.

## Suite 3.9.3: retention and the hive-common 0.5.0 products

Suite 3.9.3 changes no storage format and needs no flag from 3.9.2. It pins HiveMem 1.7.1,
HiveSkills 1.8.1, Cindertrace 0.7.1, Embermend 0.3.2, Emberpath 2.5.1, Ardent Project Studio 0.4.2
and ChatterMost 0.6.4, which move to `@hivemagnus/hive-common` 0.5.0 and add no migrations
(ChatterMost's 0.6.1 is a reviewed upgrade source); every other pin, the datastore profile and the
storage recovery profile are those of 3.9.2. The controller changes, so the release pins a new
controller digest: it adds `./hive.sh backups list|prune`, as described below, with automatic
pruning off by default, accepts protected sudo password files with or without a final newline,
recognizes the `node-MainThread` process name in fresh Magnus node enrollment, and lets the
browser ingress pass Magnus's read-only `GET /api/v1/nodes/ID/software` route. Pass `--release
3.9.3` to later commands, as described in [the upgrade procedure](deployment/QUICKSTART.md#8-upgrade).

Leave the installation file without `retention` to keep the defaults, under which an upgrade
removes no backup; a 3.9.2 or older controller refuses the key, so remove it before rolling back.

Retention protects only archives that the installation's state files name, the newest restorable
pairs it keeps, and those newer than its age limit. It does not know which archive you plan to
restore later. Before `./hive.sh backups prune --apply`, or before turning on `"auto": true`, copy
any such archive, for example a pre-3.0.0 original-state backup kept for the PostgreSQL collation
recovery, outside the installation directory.

From 3.8.1, upgrade directly to 3.9.3 as described for 3.9.0 below, with 3.9.3 and Magnus 3.0.3 in
place of 3.9.0 and 3.0.1; managed agents still cross the major from 2.10.3, with `magnus-server
agents upgrade --to 3.0.3 --allow-major` or the HiveXUI option.

## Backup and rehearsal retention

From suite 3.9.3, the controller has [retention rules](deployment/BACKUPS.md#retention) for old
pre-change backups and their restore rehearsals. Automatic pruning is **off by default**.
Single-host installations can review `./hive.sh backups prune` (a dry run), remove eligible pairs
with `--apply`, or explicitly opt into pruning after successful upgrades with
`"retention": {"keep":5,"keepDays":14,"auto":true}`. The defaults keep the newest 5 restorable
pairs and everything from the last 14 days, plus the installed release's upgrade archive,
anything a transaction, receipt, recovery record or reconciliation names, and every backup
without a rehearsal.

Multi-host installations support listing and dry runs only. Destructive pruning refuses before
any host action, including when `auto` is explicitly enabled, until selection and deletion have
coordinated locking across all hosts. A change in protection on one host must not leave a restore
point without its counterpart elsewhere. A pruning refusal never fails a completed upgrade.

Retention is not in suite 3.9.2 or earlier. Their controllers reject an installation file with
`retention`: remove the key before rolling back to one of them. The 3.9.3 controller rejects
`retention.schedule`, added in 3.9.4 for the [daily prune](deployment/BACKUPS.md#daily-pruning).

## Suite 3.9.2: Magnus 3.0.3, HiveXUI 0.9.1, ingress 2.0.6

Suite 3.9.2 changes no storage format and needs no flag from 3.9.1. It pins Magnus, its fleet
gateway and agent 3.0.3, HiveXUI 0.9.1 and `hive-ingress` 2.0.6; every other pin, the datastore
profile and the storage recovery profile are those of 3.9.1. The controller is that of 3.9.1, so
the release pins the same controller digest; pass `--release 3.9.2` to later commands, as described
in [the upgrade procedure](deployment/QUICKSTART.md#8-upgrade).

Magnus 3.0.3 changes only the node agent and adds no migrations and no settings. The agent now
creates the missing parents of the Ardent install prefix, as the owner and one level at a time
inside the owner home, so installing or updating the Ardent package works on a fresh owner account
without `~/.local/share`. Move the agents to 3.0.3 as for any patch within the major: `./hive.sh
post-upgrade` and `./hive.sh magnus-agent install --config FILE --host HOST` for the agents the suite
installs, and `magnus-server agents upgrade --to 3.0.3` for the agents Magnus manages. Retry a
failed **Update package** once the node's agent runs 3.0.3.

HiveXUI 0.9.1 offers ADMIN an **Allow major upgrade** option in Upgrade agents against a Magnus
that reports 3.0.1 or later, the browser counterpart of `magnus-server agents upgrade
--allow-major`. The ingress 2.0.6 is the same Caddy build as 2.0.5 with the OpenTelemetry log SDK
1.47.0 (CVE-2026-128085).

From 3.8.1, upgrade directly to 3.9.2 as described for 3.9.0 below, with 3.9.2 and Magnus 3.0.3 in
place of 3.9.0 and 3.0.1; managed agents still cross the major from 2.10.3, with `magnus-server
agents upgrade --to 3.0.3 --allow-major` or the HiveXUI option.

## Suite 3.9.1: Magnus 3.0.2, retiring the shared keys

Suite 3.9.1 changes no storage format and needs no flag from 3.9.0. It pins Magnus, its fleet
gateway and agent 3.0.2, which add no migrations; every other pin, the datastore profile and the
storage recovery profile are those of 3.9.0. The controller changes, so the release pins a new
controller digest: `./hive.sh post-upgrade` now settles the `ardent-packages-updated` setup item
itself, read only, when Magnus reports every Ardent installation on the version its node agent
stages, and otherwise names the installations that are behind.

Magnus 3.0.2 removes the last uses of the shared keys that Magnus 3.0.0 kept. The server signs the
console drain finding it records for itself with its server key instead of `RESULT_SIGNING_SECRET`,
and fetches the agents' writer proofs whether or not that key is set. The new verify-only
`RESULT_SIGNING_PREVIOUS_SECRET` (server) and `COMMAND_RECONCILIATION_PREVIOUS_SECRET` (agent) keep
records stored with the shared keys verifying, and `magnus-agent historical-settlements
list|reseal|prune` moves an agent's stored historical settlements to its node-local keys. Nothing
changes until an operator moves a key: the upgrade changes no existing `config/magnus.env` or agent
`.env`.

To retire the keys, first move the server and every agent to 3.0.2: the suite upgrade moves a
suite-managed Magnus, `./hive.sh post-upgrade` and `./hive.sh magnus-agent install --config FILE
--host HOST` the agents the suite installs, and `magnus-server agents upgrade --to 3.0.2` (within
the major, no `--allow-major`) the agents Magnus manages. Then follow Magnus's
`docs/NODE_CREDENTIALS.md`, "Retiring the shared keys": on the server, rename
`RESULT_SIGNING_SECRET=` to `RESULT_SIGNING_PREVIOUS_SECRET=` in `config/magnus.env` and restart
Magnus; on each agent, rename `COMMAND_RECONCILIATION_SECRET=` to
`COMMAND_RECONCILIATION_PREVIOUS_SECRET=`, restart it, run `magnus-agent historical-settlements
reseal --apply` as root, check with `historical-settlements list --check`, then remove the previous
slot.

From 3.8.1, upgrade directly to 3.9.1 as described for 3.9.0 below, with 3.9.1 and Magnus 3.0.2 in
place of 3.9.0 and 3.0.1; managed agents still cross the major from 2.10.3, with `magnus-server
agents upgrade --to 3.0.2 --allow-major`.

## Suite 3.9.0: Magnus 3.0.1, node keys only

Suite 3.9.0 pins Magnus, its fleet gateway and agent 3.0.1, and HiveXUI 0.9.0, whose console reads
the Magnus 3 contract. Every other pin, the datastore profile, the storage recovery profile and
every storage format are those of 3.8.1. Magnus 3.0.0 and 3.0.1 add no migrations to 2.10.2 (their
release metadata lists none), so **an upgrade from 3.8.1 needs no flag**. The controller changes
as the next section describes, so the release pins a new controller digest.

Magnus 3 upgrades from 2.10.2 only, so an installation on a release before 3.8.1 upgrades to
3.8.1 first (from 3.7.x with `--allow-migrations`, as described for 3.8.0 below). Then, in this
order:

1. **Prepare the fleet on 3.8.1 (Magnus 2.10.2).** Every agent runs 2.10.2 or later and every
   node has its key, as the next section's list describes: `./hive.sh magnus-agent install --config
   FILE [--host HOST]` for the agents the suite installs, and enrollment with a one-time token for
   any other. Optionally run Magnus with `NODE_AUTH_MODE=warn` for a day. Before the upgrade,
   `GET /api/v1/node-credentials/summary` must report no blockers and `config/magnus.env` must
   set no `NODE_AUTH_MODE`.
2. **Upgrade the Magnus server first, 2.10.2 to 3.0.1,** with the suite:
   `./hive.sh upgrade --config FILE --release 3.9.0`. Before it confirms the plan or changes
   anything, the upgrade checks the running Magnus as Magnus 3's own start-up guard will, and
   refuses, naming the blockers, while a real node has no active key, its keys were all revoked,
   its agent does not sign evidence or runs 2.10.0 or 2.10.1, or the server key cannot be read.
   Magnus 3.0.1 itself, with `NODE_AUTH_MODE` unset, refuses to start on the same blockers. Agents
   on 2.10.2 keep working with the 3.0.1 server.
3. **Then the agents, 2.10.2 to 2.10.3 to 3.0.1.** After the upgrade, `./hive.sh post-upgrade`
   moves the Magnus host's own agent to the pinned 3.0.1, and `./hive.sh magnus-agent install
   --config FILE --host HOST` does the same for each fleet host the suite installed; agents keep
   their keys. Agents that Magnus manages move with its managed upgrade, which crosses the major
   only from 2.10.3: run, in Magnus's container (`docker compose -f DIRECTORY/compose.json exec
   magnus ...`), `magnus-server agents upgrade --to 2.10.3 --dry-run`, then without `--dry-run`,
   then `magnus-server agents upgrade --to 3.0.1 --allow-major --dry-run`, then without
   `--dry-run`. See Magnus's `docs/NODE_CREDENTIALS.md`, "Moving agents across a major version".

To upgrade before every node is ready, set `NODE_AUTH_MODE=compat` explicitly in
`config/magnus.env` first: the check then passes with a deprecation note and Magnus 3.0.1 keeps
accepting the shared node secret for this major. That explicit `compat` is also the rollback: a
Magnus 3.0.1 that locks agents out returns to the shared node secret by setting
`NODE_AUTH_MODE=compat` in `config/magnus.env` and restarting it, with no change of release;
remove it again once the summary has no blockers.

## Magnus 3.0.0: node keys only

Suite 3.9.0 is the release that pins Magnus 3 (3.0.1). Magnus 3.0.0 runs in `enforce` mode by
default: nodes authenticate with their own keys only, the shared node secret is refused in both
directions, HMAC-only evidence is refused, and the automatic binding of keys for existing nodes is closed. A Magnus whose
`NODE_AUTH_MODE` is unset **refuses to start** while any real node has no active key, an agent
does not sign its evidence, or an agent runs 2.10.0 or 2.10.1. See Magnus's
`docs/NODE_CREDENTIALS.md`, "Upgrading to 3.0.0".

Before the suite upgrade, on the current release (Magnus 2.10.2):

1. Run every agent on 2.10.2 or later (`./hive.sh magnus-agent install --config FILE [--host HOST]`).
2. Give every node its key. An agent that reaches Magnus through the suite's host agent port never
   binds one automatically; enroll it with a token as Magnus's guide describes.
3. Set `NODE_AUTH_MODE=warn` in `config/magnus.env`, restart Magnus, use the fleet for a day, and
   confirm `GET /api/v1/node-credentials/summary` reports `enforceReady: true`.
4. Remove `NODE_AUTH_MODE` again (or set `enforce`) before the upgrade. To upgrade first and
   enforce later, set `NODE_AUTH_MODE=compat` explicitly instead: Magnus 3.0.0 honours it,
   deprecated, for this major.

What the controller of 3.9.0 changes:

- `hive.sh magnus-agent install` copies no `NODE_MANAGER_SECRET`, `RESULT_SIGNING_SECRET` or
  `COMMAND_RECONCILIATION_SECRET` to an agent. A new agent, and an existing agent without a key,
  is enrolled with a one-time token (read by `magnus-agent enroll --token-file -`); without a token
  the install stops before changing anything. An agent with a key keeps it. An existing agent's
  `.env` keeps the secret lines it has: they are never removed, because records it MACed with
  `RESULT_SIGNING_SECRET` stay readable only with it. To retire it, follow Magnus's guide: move its
  value to `RESULT_SIGNING_PREVIOUS_SECRET` (and keep it there while those records matter); the
  agent can then no longer be downgraded to 2.10.x without losing them.
- A fresh installation generates none of those three secrets for Magnus. An upgrade never changes
  an existing `config/magnus.env`.
- The ingress `Caddyfile` the upgrade installs no longer relays `x-node-token` on the host agent
  port; the node signature headers, token enrollment and the server key still pass. The
  shared-secret legacy upgrade was never routed there.
- `hive.sh upgrade` checks the running Magnus 2.x first, before the plan is confirmed and before
  any change, as Magnus 3's start-up guard will: it reads the active release, `NODE_AUTH_MODE` in
  `config/magnus.env` and the fleet (real nodes only: the internal `__control-api__` and
  `__dashboard__` log sources and decommissioned nodes never count). With the mode unset it
  refuses while a node has no active key, its keys were all revoked, its agent does not sign
  evidence, its agent runs 2.10.0 or 2.10.1, or the server key cannot be read, naming the blockers
  and the two ways out. An explicit `compat` or `warn` passes with a deprecation note, an explicit
  `enforce` passes and names what it will refuse, a value other than those three is refused, and so
  is a Magnus older than 2.10.2. A Magnus that does not answer is refused unless the mode is
  explicit. An external Magnus is only warned about; `hive.sh plan` contacts no host and prints a
  note instead.
- `hive.sh post-upgrade` reads Magnus's fleet summary and lists its blockers, notes an explicit
  (deprecated) `compat` or `warn`, and marks the `magnus-node-keys` setup step done when the
  summary has no blockers.

The controller changes, so the release pins a new controller digest. A release that pins Magnus
2.10.x keeps the earlier behaviour exactly.

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

## Suite 3.4: Emberpath and HiveSkills data formats

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
