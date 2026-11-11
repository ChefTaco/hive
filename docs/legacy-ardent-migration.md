# Moving a legacy scoped Ardent runtime to the public package

This is an explicit, host-local maintenance transaction for an existing managed
runtime with a recorded context-engine adoption. Ordinary package updates deliberately
refuse that state. Fresh installations and current public packages use the regular
installer and Magnus package actions instead.

The migration requires Linux, root, Node 24.22.1+ or 26.13.0+, npm, tar, gzip and
runuser. It retains the original owner and every profile sharing the runtime.
Only canonical Magnus user units are accepted. Review custom units separately.
It never initializes profiles, changes their credential files, rotates identities,
restores a live database, or redispatches uncertain work.

Download the exact published `@hivemagnus/ardent` tarball and verify its registry
SHA-512 integrity. Save a root-owned mode-0600 configuration under a root-controlled
directory. Use the actual legacy package name and installed version:

```json
{
  "id": "12345678-1234-1234-1234-123456789012",
  "owner": "operator",
  "profiles": ["assistant"],
  "legacyPackage": "@legacy/ardent",
  "legacyVersion": "0.1.0",
  "version": "3.0.0",
  "archive": "/opt/upgrade/ardent.tgz",
  "integrity": "sha512-REPLACE_WITH_VERIFIED_PUBLISHED_INTEGRITY",
  "recordRoot": "/var/lib/ardent-migrations",
  "agentRoot": "/opt/magnus-agent",
  "quiesceUserUnits": ["schedule-observer.timer", "schedule-observer.service"],
  "compatibilityCheck": {
    "path": "/opt/upgrade/check-extension-parity.mjs",
    "sha256": "REPLACE_WITH_REVIEWED_CHECKER_SHA256"
  }
}
```

Use a fresh UUID for `id`. Every profile under the owner's `.ardent/profiles`
must be named. The script derives the owner's home from the local account database;
configuration contains no deployment host or credential defaults.
A custom build needs an installation-specific capability review **before migration**.
Port custom tools, scheduler handlers, routes and workflow behavior to supported
plugins, then provide a root-owned checker under root-controlled directories with
its exact SHA-256. Preparation runs it as the service owner with arguments:
`PROFILE LEGACY_PACKAGE_DIRECTORY CANDIDATE_PACKAGE_DIRECTORY COPIED_PROFILE_DIRECTORY`.
It must exit successfully only after its isolated parity checks pass. Do not use a
placeholder checker or run live effects to prove parity. Missing or changed checks
fail before activation. Configuration validation alone does not prove compatibility.

The optional `quiesceUserUnits` lists reviewed user timers and services that observe
or write these profiles. Include both timer and service. Active timers stop before
their services; only units that were active resume afterward. Unknown writers still
block the transaction. Do not include unrelated units or the gateway itself.

```sh
sudo node scripts/migrate-legacy-ardent.mjs prepare /etc/hive/ardent-migration.json
sudo node scripts/migrate-legacy-ardent.mjs quiesce /etc/hive/ardent-migration.json
```

Preparation installs only the exact verified public archive, with dependency scripts
disabled. It records and checks the generated public dependency lock, audits production dependencies, validates copied profile configuration,
opens copied journals with the new storage engine, proves that every existing row
survives, and proves the old runtime can reopen those migrated copies. The only
configuration translation is `channels.chattermost` to `channels.mattermost`.
Ambiguous channel ownership fails before activation. Copied job definitions also
pass the candidate's full handler validation. Disabled `hermes` job references can
be recorded in a new revision as `external`; enabled legacy ownership needs an
explicit handoff. Unknown handlers require plugins and are never discarded.

Quiescence stops agent lifecycle admission and the named gateways while retaining
service enablement. A remaining execution lock blocks transfer. It takes a private,
host-bound recovery archive and independently restores and checks the actual stopped
profile bytes. Original runtime, configuration and service hashes bind the transaction.
Services remain stopped at this checkpoint.

Copy the reported recovery archive off-host, verify its SHA-256, and write a root-owned
mode-0600 `backup-ack.json` beside `record.json`. Its `sha256`, `machineIdSHA256` and
`configurationSHA256` fields must match the verified record. Keep this acknowledgement
and recovery material private; never copy one installation's state into another.

```sh
sudo node scripts/migrate-legacy-ardent.mjs apply /etc/hive/ardent-migration.json
sudo node scripts/migrate-legacy-ardent.mjs verify /etc/hive/ardent-migration.json
```

Activation retains the complete old runtime and older checkpoint at unique adjacent
paths, including adoption records and original receipts. It writes the verified public
package receipt, changes only the reviewed service executable path, and stages a pinned
artifact for future Magnus updates. Profile credentials, journals, identity, policies,
peers, schedules, skills and channels stay with the same owner. Readiness must confirm
the requested version, profile and backend before agent admission resumes.

An interrupted promotion is held and is never replayed automatically. Inspect its
private record and surviving paths before recovery. A failure before promotion can
resume the unchanged original services. After promotion, failed candidate services
remain stopped. Do not restore a database over later writes or delete an adoption
record to bypass an ownership check. Reconcile execution outcomes and retain all
checkpoints before selecting a recovery action.

## Finishing a held service activation

If the package and configuration transferred successfully but a dependency such as
Codex sign-in prevented readiness, resolve that dependency for the same service
account. Keep the backend and credentials selected by the profile. Then inspect
the exact held activation without starting services:

```sh
sudo node scripts/migrate-legacy-ardent.mjs check-held /etc/hive/ardent-migration.json
sudo node scripts/migrate-legacy-ardent.mjs finish /etc/hive/ardent-migration.json
```

These commands accept only a held activation after promotion. They recheck the
host-bound backup acknowledgement, retained legacy prefixes, exact candidate code
and lockfile, profile credentials, translated configuration and canonical units.
They never repeat package promotion, restore data or discard an adoption record.
`finish` starts only the already verified target and resumes agent admission only
after its normal acceptance checks pass. Other held phases need reconciliation.

For a Codex profile using ChatGPT authentication, an expired or missing login needs
the account holder's sign-in as the original service owner. To expose management
while that happens, use `start-for-auth` instead of `finish`. It verifies the same
code, recovery and identity checks, and permits only the exact readiness problem
`Codex login required`. It records `awaiting-auth`, resumes the agent and reviewed
observers, and does **not** mark the migration complete. Other readiness problems
keep the candidate stopped. After sign-in, run `finish` and `verify`.

A held failure before promotion can be cancelled with `cancel-before-promotion`.
This requires unchanged original runtime, older checkpoint, configuration and units,
the same host, and no retained promotion paths. It starts the original services and
marks the transaction cancelled; it never restores data or deletes recovery evidence.
If an independent writer caused the failure, review and include its units in a new
configuration with a fresh UUID, then repeat preparation and backup. Existing records
and acknowledgements must never be edited to bypass the failed transition.


## Recovering code while preserving current data

For a verified held activation or `awaiting-auth` transaction, `rollback-code`
rechecks the same recovery, code, configuration, credential and host bindings. It
stops admission, gateways and reviewed observers, takes consistent copies of the
**current** journals, and proves that the old reader can reopen them without changing
existing rows. It then retains the public runtime at a unique adjacent path and
restores only the original runtime, configuration, canonical units and agent artifact
selection. It leaves live journals in place. The resulting phase is `rolled-back-code`,
never a successful migration. A translated job revision requires separate reconciliation
and blocks this automatic code rollback. Interrupted code transfers stay held.

`repair-disabled-jobs` is limited to a verified held activation. It reads original
job definitions from the stopped recovery archive, accepts only the exact original
or intended translated bytes, validates the candidate handlers, and preserves the
old definition under its content digest before installing a new revision. It does
not start gateways, enable jobs, admit work, or rewrite historical receipts.
