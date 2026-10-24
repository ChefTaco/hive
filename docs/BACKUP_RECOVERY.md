# Host-bound backup and isolated recovery

Every Hive host is a separate installation with its own content. An archive is
bound to its installation name (the target's short hostname). Keep separate archive directories,
access controls and retention policies. Archives contain credentials and private
content; directory mode is 0700 and archive mode is 0600. Do not commit archives.

## Backup

Preview from the repository root:

```bash
npm run backup -- --host hive:hive.example.com --stamp recovery-1 --output-dir backups/hive --dry-run
npm run backup -- --host memory-host:memory.example.com --stamp recovery-1 --output-dir backups/memory-host --dry-run
```

Without `--host`, the first entry of `HIVE_HOSTS` is used. Apply one host at a
time by replacing `--dry-run` with `--apply`. Backup connects using
`HIVE_BACKUP_SSH_USER`/`HIVE_BACKUP_SSH_KEY` (or `DEPLOY_USERNAME`/`DEPLOY_SSH_KEY`), with
`HIVE_BACKUP_SUDO_PASSWORD` when passwordless sudo is unavailable. Set the correct
credential for each target; the tool does not merge host environments.

The remote engine reads effective service env paths and requires SQLite, active
IAM keyring/private CA, Memory storage/revocations, certificates and installed
Skills state. It stops active application units in dependency order, takes native
Qdrant collection snapshots, saves the scoped IAM Redis DUMP records with expiry,
archives SQLite and file state with checksums, then restarts those previously
active units in reverse order even if backup fails. Qdrant and Redis stay running.
Only the active signing-key release is retained, not retired private keys.

This entails a maintenance interruption whose duration depends on corpus size.
Download streams to a protected local file, is verified, and remote staging is
removed. Missing required paths or checksum failures fail the operation.
`recovery/manifest.json` records source identity, timestamp, state paths,
collections and active units. A backup reports snapshot duration, not service RTO.

## Stage a restore

```bash
npm run restore -- --host hive --stamp drill-1 \
  --backup-file backups/hive/hive-hive-recovery-1.tar.gz \
  --output-dir backups/hive --apply
```

Restore validates the archive and host identity before writing a **new local**
`recovery-hive-drill-1` directory. It verifies file/snapshot checksums,
rejects unsafe/duplicate entries, reconstructs the active keyring link within the
isolated tree and runs SQLite integrity/foreign-key checks. It never extracts into
`/`, overwrites an existing recovery tree, or starts production services. The
result file distinguishes staged-and-verified state from running-service recovery.

This replaces the former blind in-place extraction command. Current tests prove
SQLite contents, integrity checks, cross-host refusal and corruption rejection;
complete empty-host service recovery is still an open acceptance task.

## Complete an isolated service drill

Use a dedicated empty recovery VM/container network for the **same source
installation**, without production ingress, model providers, Skills targets or
webhook egress. Do not use another production installation as a recovery target.
Install the matching code revision and Qdrant version. Mount the staged SQLite,
files and active keyring into the expected paths, while provisioning distinct
recovery endpoint names/TLS and disabling outbound worker effects for the drill.

Restore each native Qdrant snapshot with the collection snapshot upload API into
an empty Qdrant instance. Restore only the recorded IAM Redis namespace using
RESTORE and remaining TTL; expired records must stay expired. Never FLUSHALL or
restore into a shared production Redis. Native snapshot formats are documented by
[Qdrant create snapshot](https://api.qdrant.tech/api-reference/snapshots/create-snapshot)
and [Qdrant recover upload](https://api.qdrant.tech/api-reference/snapshots/recover-from-uploaded-snapshot).

Before enabling listeners, reconcile the newest containment information: disabled
agents, token generations and revocations, forgotten/purged source IDs, current
IAM signing-key state and Router key disables. An old archive alone cannot prove
that later revocations/deletions are preserved. Never reintroduce a retired
private signing key. If current containment state is unavailable, keep the
recovery offline and replace credentials before admitting clients.

Start Memory, IAM, Router, then Skills only if present in the source manifest.
Verify IAM token issuance/JWKS and revoked-token rejection; private Memory search,
workspace isolation and interrupted queue recovery; Skills archive digest;
authenticated Router pages. Record elapsed recovery time, archive timestamp/data
loss window, matching code revision and sanitized outcomes. Production promotion
is separate from staging and requires this acceptance record. No automated
in-place promotion or full-stack RTO claim is provided by the staging command.
