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

The optional Skills registry has no public npm package. Preserve its existing deployment and
state independently; installing the three public servers does not replace it.

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
