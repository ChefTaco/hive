# Existing systemd installations on public npm packages

An existing source deployment can run the public server packages while retaining its
configuration and data directories. This is a maintenance operation on each independent
installation. Do not run `hive init` over production state: its fresh-install defaults are a
different layout and can select different authentication, certificates and credentials.

## Layout and ownership

Keep each service's existing unit, service account, working directory, environment files,
sandbox, certificate renewal and writable paths. Install code separately as root:

```text
/opt/hive-npm/
├── current -> releases/<release-id>
└── releases/<release-id>/runtime/
    ├── package.json
    ├── package-lock.json
    └── node_modules/
```

The runtime manifest pins exact versions of `@hivemagnus/hive`,
`@hivemagnus/hive-router`, `@hivemagnus/hive-iam-server` and
`@hivemagnus/hivemem-server`. Set `private: true` and allow install scripts only for
`better-sqlite3` and `argon2` with `"allowScripts": {"better-sqlite3": true, "argon2": true}`.
Query each package's `latest` tag with `npm view <package> version
--registry=https://registry.npmjs.org`; record and pin those versions before installation.
Use the supported Node version on the target host, then install into a **new** release:

```bash
npm --prefix /opt/hive-npm/releases/<release-id>/runtime install \
  --omit=dev --registry=https://registry.npmjs.org
```

Never update the active runtime in place. Keep the lockfile, registry URLs and integrity hashes;
`npm ci --omit=dev --registry=https://registry.npmjs.org` recreates that release. Check that every
locked dependency has a public registry URL and an integrity hash. Check native SQLite queries
and Argon2 hash/verify using that runtime before activation. Code stays root-owned and readable
by the service users, with no secrets stored in the runtime directory.

The optional Skills registry is published separately as `@hivemagnus/hive-skills`.
It has its own runtime and data; see [its migration procedure](#optional-skills-registry).
The launcher supports Skills from 1.1.0 for its own `$HIVE_HOME` layout. Existing systemd
installations below retain their independent layout.

## Preservation and rehearsal

1. Inventory effective units with `systemctl cat` and `systemctl show`. Record the running
   environment, actual SQLite paths, Qdrant collections, Redis namespace, audit/trace paths,
   signing keys and TLS trust. Relative paths depend on the existing working directory.
2. Take a host-bound [full-state backup and isolated restore](BACKUP_RECOVERY.md).
   This pauses application writes while taking snapshots. Retain the original code and units
   as well. Never copy another installation's database, memory, configuration or credentials.
3. Run each new package's `check` command as its existing service user, using its existing
   environment and working directory. IAM's check command uses CLI defaults, so explicitly
   point `IAM_DATA_DIR` at the existing IAM directory when needed. Include the effective
   keyring environment; do not regenerate keys or seed users/clients.
4. Rehearse IAM migrations and Router schema initialization against isolated database copies.
   Verify migration history, integrity, foreign keys and existing rows. When migration bytes
   match and no migrations are pending, the change only needs a code switch. A schema-changing
   release needs a separate tested migration/recovery procedure before activation.
5. Record hashes of environment files, certificates and signing keys, and counts/content checks
   for existing configuration and memory records. Capture a final database baseline with
   application writes stopped immediately before the switch.

## Switch the service entrypoints

Under a maintenance window, stop Router, IAM and Memory. Point `current` at the staged release.
For later upgrades, create a temporary symlink beside `current` and rename it over `current`
atomically. Add `/etc/systemd/system/<service>.service.d/50-npm-runtime.conf` for each service,
resetting only `ExecStart`:

```ini
[Service]
ExecStart=
ExecStart=/usr/bin/node /opt/hive-npm/current/runtime/node_modules/@hivemagnus/hive-router/dist/src/index.js
```

Use these paths for the other two services:

| Unit | Packaged production entrypoint below `runtime/node_modules/` |
| --- | --- |
| `hive-router` | `@hivemagnus/hive-router/dist/src/index.js` |
| `hive-iam` | `@hivemagnus/hive-iam-server/dist/index.js` |
| `hivemem` | `@hivemagnus/hivemem-server/dist/src/cli.js` |

IAM's production entrypoint preserves the original systemd configuration semantics. Its npm CLI
is also available as `hive-iam-server` for checks and explicitly reviewed migrations; the
production entrypoint does not apply pending migrations. Retain the old working directories:
these units still use their existing relative configuration and state paths.

Run `systemctl daemon-reload`, then verify that databases and protected files are unchanged
before starting services. Start Memory and IAM, wait for readiness, then start Router.
Probe using the hostname in each certificate and the correct CA. For local probes, use
`curl --resolve <certificate-name>:<port>:127.0.0.1 --cacert <ca-file> ...`; do not disable TLS
verification. Confirm the effective `ExecStart` and running process command line resolve into
the npm release, and verify that the units remain enabled for boot.

## Acceptance, recovery and future upgrades

Verify authenticated console sign-in, IAM users and Memory dashboard proxies, existing app
configuration and memory, service readiness, and the [real-model end-to-end suite](model-e2e.md).
Use an existing authorized Memory token. Confirm streaming, memory recall and temporary-resource
cleanup. Startup timestamps, usage counters and retained audit records can change during testing;
compare configuration values as well as raw row hashes before calling a difference data loss.

If activation fails, stop the services and restore the previous code pointer (or remove only
these new drop-ins to return to the original source entrypoints), reload systemd, then restart
and verify. For a code-only release with unchanged schemas, leave live data in place. Data
restoration requires reconciliation of writes and credentials since the snapshot.

The backup engine retains service drop-in directories and the resolved npm manifest/lockfile
when `/opt/hive-npm/current/runtime` exists. It does not archive `node_modules` or recreate the
npm `current` link automatically. During disaster recovery, reinstall the recorded release from
its lockfile, restore its code pointer and unit overrides, and follow the isolated recovery
procedure before exposing traffic.

Future updates use a new pinned npm release and the same rehearsal, backup, switch and acceptance
steps. The repository's `npm run deploy` scripts deploy source code and do not manage this npm
pointer; their entrypoint changes are overridden while these drop-ins exist. The installed
launcher remains available inside the runtime for inspection, but its `init`, `install` and
`start` commands manage a separate `$HIVE_HOME` layout, rather than these existing systemd units.

## Optional Skills registry

Install an exact `@hivemagnus/hive-skills` version from the public registry into a new
`/opt/hive-skills/npm/releases/<release-id>/runtime` with its own private `package.json`
and lockfile. This package uses Node's SQLite and needs no native add-on allowlist.
Keep `/opt/hive-skills/npm/current` as an atomic pointer to that release. On installations
whose unit and helper override use `/opt/hive-skills/current`, that link can point to
`npm/current/runtime/node_modules/@hivemagnus/hive-skills`. The package retains
`dist/server.js` and `scripts/deploy-hermes-agent.sh`, so those existing paths still work.

Before switching, stop only `hive-skills` and take a focused archive of its complete shared
directory, unit/overrides, PAM policy and original code pointer. Verify an isolated SQLite
restore and hashes of all archives and configuration. Inspect queued/running deployment jobs
and reconcile any in-flight effects before migration. Rehearse the new package's database
initialization against a copy and compare every existing row. Do not run `seed`.

Switch the pointers atomically and restart the same service with the original unit, account,
environment, writable paths and TLS. Verify readiness, real OS login, unauthenticated denial,
the existing catalog, promoted archive digests and Hermes manifest. Test a bridge pull into
a disposable profile with a restart callback; do not modify a real agent or change its
assignments to prove a server packaging migration. Check that an existing valid session
survives the restart, then log out the test session. Compare all pre-existing database rows,
archive bytes, targets, policies and secret/certificate hashes after migration. Retain audit
records from verification. If activation fails, restore only the original code pointer,
restart and verify; leave the live data in place for a code-only rollback.

Full-state backups include the separate Skills npm manifest/lockfile when
`/opt/hive-skills/npm/current/runtime` exists and Skills belongs to the installation.
Reinstall its recorded release and reconstruct both code pointers during disaster recovery.
Source deployment scripts do not manage the npm runtime pointer and must not replace it
as part of a later source deployment.

## Reusable release command

`npm run deploy:npm` updates all explicitly configured, independent installations in the
systemd/npm layout above. It retains their existing units, service users, working directories,
configuration, signing keys, TLS and datastores. Optional Skills is updated only where already
installed. It never runs `init`, `adopt`, provisioning, seeding or secret/key rotation.

Create an **ignored, owner-only** `.env.npm-deploy` file. All real destinations and credentials
come from the environment; the command supplies no deployment host or model-provider default.

```dotenv
HIVE_NPM_DEPLOY_TARGETS='[{"name":"primary","host":"hive.example.com"},{"name":"secondary","host":"memory.example.com"}]'
DEPLOY_USERNAME=deploy
DEPLOY_SSH_KEY=/opt/deploy/id_ed25519
# Omit for passwordless sudo; otherwise set the existing sudo credential:
DEPLOY_SUDO_PASSWORD=replace-with-existing-sudo-password

HIVE_E2E_USERNAME=admin
HIVE_E2E_PASSWORD=replace-with-existing-operator-password
HIVE_E2E_PROVIDER_URL=http://client.example.com:8000
HIVE_E2E_MODEL=your-exact-Qwen-model-id
HIVE_E2E_PROVIDER_KIND=LLAMACPP
```

Use an existing SSH key and trusted `known_hosts` entry; host-key checking is mandatory.
The SSH account needs sudo permission to execute Python, manage systemd and read the owned state.
Targets must be separate hosts with unique labels. This adapter currently supports the exact
`/opt/hive-npm` and optional `/opt/hive-skills/npm` layout, Linux systemd, SQLite, single-node
Qdrant and scoped Redis. Unknown layouts and enrolled launcher projects are refused.

```bash
chmod 600 .env.npm-deploy
# Read-only inspection, provider discovery and TLS/configuration validation:
npm run deploy:npm -- --env-file .env.npm-deploy --to 1.2.2 --dry-run
# Back up and upgrade each host, accepting it before starting the next:
npm run deploy:npm -- --env-file .env.npm-deploy --to 1.2.2 --apply
# Run live readiness and the full model/cleanup suite without replacing code:
npm run deploy:npm -- --env-file .env.npm-deploy --to 1.2.2 --verify-only
```

An exact stable public npm release is required; no prereleases, downgrades or major transitions.
The default mode is `--dry-run`: it creates no remote files, runtime installations, backups,
registry cache or local reports, and performs no inference or registry writes. It validates
TLS peer identity with configured CA trust, without calling telemetry-writing readiness handlers;
IAM probes use the configured **issuing CA**, not
an assumed leaf certificate. Target packages must form one complete release with matching pins
and engines. Changed engine protocols or wire/SDK compatibility metadata require operator review.
Existing Memory test tokens are read from each host separately; they are never
minted, expanded, printed or copied between installations. The provider must be unauthenticated
and explicitly selected; its `/v1/models` response must include the exact configured model.

An application transaction runs under a host-side systemd worker and an installation lock:

1. Stage exact public npm pins in a new release directory, retaining a lockfile and checking
   registry origins, integrity, the release bundle, Node engines and rollback compatibility.
   Audit production dependencies, refusing high/critical advisories before maintenance.
   Install scripts are disabled, then only `better-sqlite3` and `argon2` are rebuilt; optional
   `msgpackr-extract` scripts are denied. Probe both native modules.
2. Run checks and read-only migration plans as the existing service accounts. Rehearse SQLite
   initialization against isolated copies, requiring every existing row and table to survive.
   This adapter deliberately supports **unchanged migration inventories and data formats**.
   New SQL, changed checksums, slow/one-way migrations, removed configured env names or missing
   required configuration require a separately reviewed migration procedure before deployment.
3. Stop writers in reverse dependency order. Take a host-bound full-state archive with native
   Qdrant snapshots, scoped Redis DUMP records and absolute expirations, SQLite/WAL files, Memory
   local state, protected configuration/keys, Skills archives and effective systemd wiring.
   Verify hashes and extract an isolated recovery tree with SQLite integrity/foreign-key checks.
4. Download an owner-only off-host backup and compare its SHA-256 with the host receipt. The
   worker **cannot migrate until this acknowledgement arrives**. It remains quiesced meanwhile.
5. Run explicit backed-up migration commands and compare every existing SQLite row/table before
   switching. Write the five explicit `false` values into owner-only
   `/etc/hive/automation-off.env`, referenced by additive `60-hive-automation-off.conf` drop-ins.
   Existing env files, units, signing keys and certificates are retained. Switch `current`
   atomically and start Memory, IAM, optional Skills and Router in dependency order.
6. Require expected running versions, readiness, protected-file hashes, existing config rows,
   Qdrant inventories, exact generated OpenAPI content and disabled automation in every process.
   Run the [live model suite](model-e2e.md): inference, incremental SSE, scoped SDK recall and
   citations, streamed recall, provider-bound traces, expiry/auth checks and complete cleanup.
   Only a successful model report with successful cleanup accepts the transaction.

Code directories remain readable by existing service accounts; transaction evidence and secrets
stay owner-only. Provider health status, error and probe timestamps can change during readiness
checks. Their URLs, credentials and other configuration must remain unchanged.

`HIVE_AUTO_UPGRADE`, `HIVE_AUTO_MIGRATE`, `HIVE_UPDATE_CHECK`, `HIVE_UI_UPGRADE` and
`HIVE_COMPOSE_UPGRADE_SUPERVISOR` stay false. No upgrade timer, coordinator or Compose supervisor
is installed. Existing certificate/OS maintenance is retained. If a host already has the exact
release, `--apply` runs live verification without reinstalling, restarting or taking another
backup. A failed host prevents deployment to later hosts; successful earlier hosts retain their
own release and data.

Evidence is private under `output/npm-deploy/<transaction>/` locally and
`/var/backups/hive/npm-deploy/<transaction>/` on each host. Retain backups, package lockfiles,
prior releases and transaction receipts. The worker waits at most 15 minutes at each client
acknowledgement boundary and records conservative recovery after controller loss. A killed host
worker leaves an unfinished transaction that blocks another deployment. Inspect the receipt and
systemd unit `hive-npm-deploy-<transaction>` before retrying; do not delete a pending receipt to
bypass recovery. Network, disk and service operations also have bounded timeouts.

Failures revert code pointers only when verified data compatibility permits restarting the old
release. A migration or preservation failure keeps services stopped with `recovery-required`.
Receipts include the exact host-bound isolated restore inspection command. **Live data restoration
is never automatic**: preserve the failed state and reconcile newer revocations, disabled
identities, signing-key state and Redis expiration before deliberately restoring only that host's
state. Archive extraction and SQLite checks do not claim a running Qdrant/Redis restore test.
