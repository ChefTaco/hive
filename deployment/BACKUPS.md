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

1. while it serves, snapshots every Qdrant collection of the group and records each collection's
   version, then copies the application's files and SQLite databases and records their versions;
2. pauses the application (the cgroup freezer, `docker pause`), so nothing in the group changes;
3. proves each copy still current or brings it up to date, snapshots again only the collections
   written since, and has Redis fork its snapshot;
4. resumes the application, and records how long it was paused, each step of the pause, and the
   work done before it;
5. collects the Redis dump, then rebuilds each store from its snapshot, with the product's own
   image, in a container with no network, and verifies it.

The pause therefore lasts as long as it takes to check what changed since the copies were taken
and to bring that up to date, not as long as copying the data.

| Store | Online method | Rebuilt and verified as |
|---|---|---|
| SQLite (Oathweave, Emberpath, HiveSkills, Hive Registry and any other) | Copied while serving, with its version: the file's identity and times, the change counter every rollback-journal commit increments, and in WAL mode the log's header and size. While paused, in one read transaction (a writer paused inside a commit makes it busy, and the capture is retried with the writer resumed), a database whose version is unchanged keeps its copy without being read again; any other is compared with its copy and only what differs is written. A WAL database's log is copied with it; `-shm` and `-journal` files are never copied. Runs in the pinned recovery image as the service user | The log of a WAL copy is checkpointed into it, so its committed frames are in the database and an uncommitted tail is not. The original journal mode is kept. `PRAGMA integrity_check` on the copy |
| Redis | `BGSAVE` while the application is paused; the forked child holds that instant, and writes it out after the pause, when the dump is collected. A later save before the dump is copied fails the backup. Expiry stays absolute, as RDB stores it | Loaded by the product image with append-only off, then rewritten to the append-only files the suite runs with. Every saved key loaded or had reached its expiry |
| Qdrant | One snapshot per collection through the API, sixteen at a time, written by Qdrant into its own snapshot directory, taken while serving between two readings of every collection's version: each shard's write-ahead-log operation number, queued updates, point count and segments, and the collection's configuration. While paused, once every update the application sent has landed, a collection whose version is unchanged keeps its snapshot; collections written or created since are snapshotted again. Aliases are recorded while paused. A Qdrant that does not report versions has every collection snapshotted while paused | Restored with `--snapshot` by the product image, aliases recreated. Collections, exact point counts and aliases equal those at capture; a content digest of every collection is recorded |
| PostgreSQL (Magnus, Cindertrace, ChatterMost) | `pg_basebackup` over the local socket, with its WAL streamed | `pg_verifybackup`, then recovery by the product image to a cleanly shut down cluster, then `pg_checksums` |
| Files (attachments, skill archives, audit logs, keys, certificates) | Copied while serving, then brought up to date while paused: an unchanged file is kept, a file that only grew gains its new tail, anything else is copied again. File times come from a coarse clock, so a file changed within a second before its copy is compared by content instead | SHA-256 of every file, in the archive's `snapshot.json` |

The staging lives beside the backups, owner-only. Every staging directory mounted into a product
container belongs to that product's service user and is private to it; the host side runs as root
on a production host, so it never relies on its own ownership.

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
- **Why copies taken while serving still hold that instant.** A copy or snapshot taken before
  the pause is kept only when its store proves nothing was written to it since: the same SQLite
  change counter, log and file times, or the same Qdrant operation numbers and segments. Any
  other is taken again, or brought up to date, while paused. So the archive is the same as one
  captured entirely while paused, and as one taken after a kill at that instant.
  - *HiveMem* keeps no SQLite: its memories and its metadata (agents, sessions, operations,
    queue, webhooks) are Qdrant collections, and its data directory holds a write-recovery
    journal with the full state a write is saving. A write updates collections one after another
    between writing and removing that journal. Collections snapshotted at different moments
    while it writes, without a pause, could hold one collection after a write and another before
    it, with no journal left to repair them: a memory moved between collections could be in
    both or neither, or metadata could disagree with memories. Restore would not notice. With
    the versions checked while paused, every collection holds the paused instant, and a write
    in progress then is in the archive's journal, which HiveMem replays when it starts, as after
    a crash.
  - *Oathweave* keeps users, clients, tokens and audit rows in SQLite, a daily audit log in files,
    and in Redis its audit-event queue (with recently completed jobs), short-lived passkey
    ceremony challenges, consumed sign-in challenges and rate-limit windows. Captured at
    different moments, a Redis copy taken before SQLite would hold audit events SQLite had
    already written (written again after restore), and one taken after would mark as done events
    SQLite never received (lost). Redis forks while Oathweave is paused, at the same instant as
    the SQLite and file copies, so neither happens; jobs running then are retried after
    restore, as after a crash.
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

- A pause lasts as long as it takes to check its group's copies and bring up to date what
  changed since they were taken: the Qdrant collections written meanwhile, and the SQLite
  databases and files that changed, which are compared with their copies at the speed of reading
  them. For PostgreSQL it is still the whole base backup, which grows with the store. The
  receipt records each pause with its steps (`steps`) and the work done before it while serving
  (`staged`); the command output reports the longest pause.
- A datastore shared by two applications, or a datastore format the controller does not know,
  is refused before anything starts; use `--stopped` for it.
- An online backup needs every service running and healthy. A stopped or unhealthy suite is
  backed up with `--stopped`.

## Proof

`npm run test:suite:online-backup` runs real Redis, Qdrant and PostgreSQL images, and writers
that write every store in a fixed order every 20 ms. It checks that no container restarts, that
every client request is answered, that every pause stays within a budget (2 s by default,
`--pause-budget`) on a data set of a real installation's size (`--seed-scale`: 80 Qdrant
collections with 30,000 vectors, a large SQLite database that keeps being written and one that is
not, and Redis keys), that every store in the archive holds the same instant in write order, that the archive rehearses and restores, that stopped archives, including one from
an earlier controller (`--old-controller DIR`), rehearse and restore, and that failures keep
serving and keep nothing. `npm run test:suite:online-backup:sudo` runs the same acceptance with the
host side as root through `sudo -S` over SSH, as on a production host, with every service as a
non-root user; CI runs it. On a migrated installation, `scripts/suite/native-migration-rehearsal.mjs`
with `backupRehearsal` and `backupProof` (see [MIGRATE_NATIVE.md](MIGRATE_NATIVE.md#rehearsing))
backs up under live client traffic and inventories every store before the backup, in the
archive and after it: every record unchanged throughout must be in the archive exactly, and
every other difference is counted as a write made while the backup ran.
