# Suite backups

`./hive.sh backup --config FILE --archive ID --yes` takes a verified, host-bound archive of an
installation while it keeps serving. No container stops or restarts. Each application pauses
only while its own state is captured, usually for well under a second; requests to it wait and
are then answered. `--stopped` keeps the original behaviour, which stops every service while
the archive is written.

Upgrades and rollbacks still take their pre-change backup with the suite stopped, because the
migration that follows needs the suite stopped anyway.

## What is captured, and how

Services are captured in groups: one application together with the datastores it depends on.
For each group, the controller:

1. copies the application's ordinary files while it serves;
2. pauses the application (the cgroup freezer, `docker pause`), so nothing in the group changes;
3. captures every store of the group, and brings the copied files up to date;
4. resumes the application, and records how long it was paused;
5. rebuilds each store from its snapshot, with the product's own image, in a container with no
   network, and verifies it.

| Store | Online method | Rebuilt and verified as |
|---|---|---|
| SQLite (Oathweave, Emberpath, HiveSkills, Hive Registry and any other) | SQLite online backup API in one read transaction, run in the pinned recovery image as the service user. Committed WAL frames are included; `-wal`, `-shm` and `-journal` files are never copied | The original journal mode is kept. `PRAGMA integrity_check` on the copy |
| Redis | `BGSAVE` while the application is paused; the forked child holds that instant. Expiry stays absolute, as RDB stores it | Loaded by the product image with append-only off, then rewritten to the append-only files the suite runs with. Every saved key loaded or had reached its expiry |
| Qdrant | One snapshot per collection through the API, sixteen at a time, written by Qdrant into its own snapshot directory; aliases are recorded | Restored with `--snapshot` by the product image, aliases recreated. Collections, exact point counts and aliases equal those at capture; a content digest of every collection is recorded |
| PostgreSQL (Magnus, Cindertrace, ChatterMost) | `pg_basebackup` over the local socket, with its WAL streamed | `pg_verifybackup`, then recovery by the product image to a cleanly shut down cluster, then `pg_checksums` |
| Files (attachments, skill archives, audit logs, keys, certificates) | Copied while serving, then brought up to date while paused: an unchanged file is kept, a file that only grew gains its new tail, anything else is copied again | SHA-256 of every file, in the archive's `snapshot.json` |

The ingress is never paused. Its files (certificates and their locks) are written by atomic
rename, so each copy is one complete version. Static UI services hold no state.

The archive has the same layout and members as a stopped archive: every store in it is the
store it would be after a clean stop. `hive.sh rehearse` and `hive.sh restore` treat both alike,
and an earlier controller can restore an online archive. Old stopped archives keep restoring.
The receipt records `"mode": "online"`, each pause, and how each store was captured and
verified; a stopped archive's receipt has no `mode`.

## Consistency

- **Within a group: one instant.** While an application is paused, none of its stores changes,
  so its SQLite databases, files, Redis and Qdrant or PostgreSQL hold the state of the same
  moment: exactly what they would hold had the application been killed then. Every product
  already recovers from that (HiveMem, for example, from its write-recovery journal), and a
  request in flight is either wholly in the archive or not at all.
- **Between groups: seconds apart.** Groups are captured one after another. The identity
  provider (Oathweave) is captured last, so every account, client or key another product
  refers to is already in the archive. A write made between two groups' capture points can be
  in one product's state and not in another's, as after any restore that drops the last
  seconds of writes. Restore already requires every write after the backup to be reconciled
  first (`--reconciliation`), which covers these too.
- **Between hosts:** each host is captured on its own, one after another.
- **Native agents** are not suite services. When a host has native agent profiles, those agents
  stop while their profiles are copied, and start again.
- Old Qdrant snapshot files in the live snapshot directory are not archived; they are not live
  data.

## Verification while serving

Before the archive is written: each rebuilt store's own check (above), and the offline integrity
checks the rehearsal runs (SQLite integrity, PostgreSQL checksums). Every staged file is hashed
once, in parallel, for the receipt digest and the per-file manifest. After the archive is
written it is read back: the whole compressed stream must check out and its data must hold
exactly the staged files with their sizes. Then it is renamed into place and passes the same
checks as a stopped archive (members, types and the installation binding). Rehearse and restore
check every byte of the data against the receipt digest.

Datastores preallocate sparse files, so a store's apparent size can be many times its real size
(a vector store of 2 GB can appear as 50 GB). Archives keep the files sparse, and tree digests,
including the ones rehearsals and restores check, hash files in parallel.

## Failure

A backup that fails at any step resumes every service it paused, removes its staging and any
snapshot it left in a live store, keeps no archive, and touches no other archive. Its
transaction closes, so the next backup, upgrade or rollback can run. A writer paused inside a
SQLite commit holds a lock that blocks the copy; the controller resumes it and tries again, up
to five times. If a paused service cannot be resumed, the backup reports it and holds the
transaction for recovery; a watchdog started with each pause also resumes it within ten minutes.

`hive.sh backup` never prunes archives.

## Disk

The staged snapshot is the only full copy: the archive is compressed straight from it, and the
staging is removed afterwards. Before anything is written, the controller requires free space
beside the backups for three times the data directory's size, plus the host's `minimumFreeMiB`
reserve: the staged snapshot, the archive, and a Qdrant snapshot while it is rebuilt. When the
data is on another filesystem, the data side needs room for one store snapshot.

## Limits

- A pause lasts as long as its group's capture. For PostgreSQL that is the base backup, and for
  Qdrant the collection snapshots: both grow with the store, Qdrant's mostly with the number of
  collections. The receipt and the
  command output report the longest pause.
- A datastore shared by two applications, or a datastore format the controller does not know,
  is refused before anything starts; use `--stopped` for it.
- An online backup needs every service running and healthy. A stopped or unhealthy suite is
  backed up with `--stopped`.

## Proof

`npm run test:suite:online-backup` runs real Redis, Qdrant and PostgreSQL images, and writers
that write every store in a fixed order every 20 ms. It checks that no container restarts, that
every client request is answered, that every store in the archive holds the same instant in
write order, that the archive rehearses and restores, that stopped archives, including one from
an earlier controller (`--old-controller DIR`), rehearse and restore, and that failures keep
serving and keep nothing. On a migrated installation, `scripts/suite/native-migration-rehearsal.mjs`
with `backupRehearsal` and `backupProof` (see [MIGRATE_NATIVE.md](MIGRATE_NATIVE.md#rehearsing))
backs up under live client traffic and inventories every store before the backup, in the
archive and after it: every record unchanged throughout must be in the archive exactly, and
every other difference is counted as a write made while the backup ran.
