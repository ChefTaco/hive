# Suite backups

`./hive.sh backup --config FILE --archive ID --yes` takes a verified, host-bound archive of an
installation while it keeps serving. No container stops or restarts. Each application pauses
only while its own state is captured, usually for well under a second; requests to it wait and
are then answered. `--stopped` keeps the original behaviour, which stops every service while
the archive is written.

Upgrades and rollbacks still take their pre-change backup with the suite stopped, because the
migration that follows needs the suite stopped anyway.

## What is captured, and how

Services are captured in groups: applications together with the datastores they depend on.
Applications sharing a datastore, including the Embermend API and worker, pause together;
transitively shared dependencies form one group and each datastore is captured once.
For each group, the controller:

1. while it serves, snapshots every Qdrant collection of the group and records each collection's
   version, then copies the application's files and SQLite databases and records their versions;
2. pauses every application in the group (the cgroup freezer, `docker pause`), so nothing in the group changes;
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

### Ardent Project Studio

Ardent Project Studio keeps all of its state in its data volume, `data/ardentstudio` on its host
(the `ardentstudio-data` volume, mounted at `/data`): `studio.sqlite` in WAL mode and the
content-addressed files under `blobs/aa/bb/<sha256>` that its records name. The database refers to
files by digest, so the two are one backup unit: the online backup captures both in the same
pause, the database by the SQLite method and the files as files. A file is never changed once
written, and Studio writes a file before the row that names it, so every file a captured row
names is in the archive. `blobs/tmp/` holds uploads in progress; Studio clears it when it starts,
so a restored partial upload is removed. After restoring an archive older than Studio's HiveMem
knowledge, reindex the project's reference files in Studio to bring HiveMem back in line.

The staging lives beside the backups, owner-only. Every staging directory mounted into a product
container belongs to that product's service user and is private to it; the host side runs as root
on a production host, so it never relies on its own ownership.

The ingress is never paused. Its files (certificates and their locks) are written by atomic
rename, so each copy is one complete version. Static UI services hold no state.

Online and stopped archives share the same layout: every store in one is the store it would be
after a clean stop. `hive.sh rehearse` and `hive.sh restore` treat both alike. Suite-only online
archives remain compatible with earlier controllers. Archives containing `native-profiles/`
require this controller and a Magnus agent with native snapshot support; older controllers refuse
the additional member instead of silently dropping it. Old stopped archives retain their original
coverage, subject to the native inventory check below.
The receipt records `"mode": "online"`, each pause, and how each store was captured and
verified; a stopped archive's receipt has no `mode`.

### Magnus-managed native profiles

Backups also discover the local, installer-owned Magnus agent's Ardent profiles. These include
profiles created through **New Agent** even when the installation file has `"agents": []`.
Discovery is limited to installation hosts and the canonical native account attached to this
installation's Magnus. It does not traverse unrelated fleet machines or adopt other accounts.

**Agents installed outside the Hive installer are not part of Hive backups.** Hive includes only
the agent its installer created and recorded in `ROOT.native-owner.json` (normally
`/opt/magnus-agent.native-owner.json`), and only on a host where the installation places Magnus.
On a host without the Magnus component, discovery does not run. A Magnus agent installed by
other tooling, such as a fleet agent owned by an ordinary account, is neither stopped nor
archived. The backup, upgrade or restore check continues and prints `native profiles not
included` with the reason. The receipt records it as `"nativeProfiles": {"included": false,
"reason": "no-magnus-component" | "not-installer-owned" | "no-native-agent"}`. Back such agents up
with their own tooling. An installer-owned root that fails its ownership checks is an error.

The installer-owned agent must support the product's `native-snapshot` contract. Magnus 3.1.0 is
the first release with it, and suite 3.9.6 is the first suite release that pins it. With an older
agent (Magnus 3.0.3 and earlier) its profiles are listed as not included, with `"reason":
"no-native-snapshot"` and the agent's version, and backups, upgrades and restore checks continue.
They are included with no further change once the agent runs 3.1.0 or later: after an upgrade to
3.9.6, `./hive.sh post-upgrade` (or `./hive.sh magnus-agent install`) moves the installer-owned
agent to the pinned 3.1.0. No flag is needed. An agent
whose `native-snapshot` fails, or that does not run, stops the backup. If native preparation fails
before it has reserved or stopped anything, the upgrade or `--stopped` backup closes its
transaction as aborted and the suite keeps serving; after that point it holds for recovery.

Native recovery needs root on the owning host. For a local installation, run these commands as
the installation operator; Hive asks for ordinary `sudo` authorization when it needs native
profile access. An existing protected `hosts.HOST.sudoPasswordFile` can supply unattended
authorization. For SSH hosts, use the installation's reviewed privileged transport (a root SSH
account or its protected `hosts.HOST.sudoPasswordFile`). An
unprivileged or inaccessible discovery result fails explicitly; it is not treated as an empty
profile inventory. Keep password files outside version control.

The product's `native-snapshot` contract captures the complete managed Ardent home and shared
installed runtime, including profile databases and journals, credentials, identities, skills,
artifacts, shared policies, runtime/extension receipts, and the generated user-service definitions
and enablement. Original file owners, groups and modes are recorded. Node identity, command
evidence keys and host TLS remain under their existing owner; their binding is checked rather
than regenerated or replaced. Backup archives therefore contain credentials and must remain
private.

Before capturing any suite store, Hive closes this node's reversible Control API admission
reservation, verifies that managed work has settled, and asks the product to stop its manager and
native services. It checks stopped processes and freezes the complete profile inventory through
the suite capture. Suite containers keep serving during an online backup; native profiles stop
for the capture window. Only services that were running before the backup are resumed, with their
enablement preserved. Both online and `--stopped` archives include the product bundle under
`native-profiles/`. The agent must support `native-snapshot`; an agent without it is listed as not
included (above), and one whose `native-snapshot` fails stops the backup instead of producing an
incomplete archive.

Rehearsal verifies every bundled file, runtime receipt, ownership record and profile SQLite
database offline, before starting any isolated suite container. It never starts restored native
services or delivers their pending work. A corrupt or incomplete bundle fails rehearsal even if
the outer archive checksum is valid. Older archives without this bundle remain usable for their
original suite-only coverage; they cannot recover native state they never captured. Restoring
one onto an installation that now has Magnus-owned profiles is refused before stopping anything,
because replacing Magnus's older inventory would orphan those profiles.

### Preparing a restore approval

Restore first needs a successful rehearsal of the exact archive. To obtain current digests
without racing live writes, prepare a held restore:

```bash
./hive.sh restore --config installation.json --archive BACKUP_ID --prepare-reconciliation --yes
```

This verifies the archive, stops the installation and native writers, and prints a JSON template
for each host. It replaces no data and deliberately leaves services held for review. Save the
templates as one private JSON document with a `hosts` object; retain every printed field. Review
and reconcile writes made since the backup, including any profiles added or changed since then.
Restore also requires the configuration directory to be exactly the archive's ("Secrets/
configuration changed since backup" otherwise), so configuration written since the backup, such as
by an upgrade and `post-upgrade` before you restore their `pre-upgrade-*` archive, must be put back
first: while the services are held, move `config` aside and extract the archive's `config` from its
`state.tar.gz` in its place (as root, keeping owners and modes; see UPGRADING, "Suite 3.15.1").
Only after that review, set each host's `subsequentWritesReconciled` to `true` and apply:

```bash
./hive.sh restore --config installation.json --archive BACKUP_ID --reconciliation approval.json --yes
```

For native bundles the template includes `nativeProfiles.archiveManifestSHA256` and
`nativeProfiles.currentInventorySHA256`, binding approval to both the archive and the stopped
current inventory. Restore rechecks them, the canonical account, host/manager identity and all
staged bytes before replacing any native profile. Missing profile directories can be recovered;
the approved account and manager binding must still exist. Previous profile/runtime state is
retained in the protected product recovery journal. After the suite database is restored, Hive
releases only the admission reservation recorded by that exact backup, then returns services to
their archived state.

Pending or uncertain work is preserved as evidence. It is never marked complete, cleared, or
replayed to make a restore pass; unsafe activation stays held for explicit reconciliation.
Interrupted preparation or promotion also remains held, with its exact state directory reported.
Do not remove those journals or a held admission reservation to force progress.

### Continuing a restore before promotion

If a controller error stops a restore before the product has promoted any files, a newer trusted
controller can continue that exact held operation with:

```bash
./hive.sh restore --config ORIGINAL_CONFIG --archive BACKUP_ID --native-recovery APPROVAL.json --yes
```

This narrow operation supports one installation host with no static `agents` entries. It does not
prepare another restore, acquire another reservation or rerun a rehearsal. Do not combine it with
`--prepare-reconciliation`, `--reconciliation`, `--allow-migrations` or changed authentication limits.
Use the original installation configuration bytes and selected release version. The newly trusted
manifest must retain the same component, network and profile definitions; its controller digest
may differ.

The private approval has a `hosts` object containing that one host. Its fields are:

| Field | Required evidence |
| --- | --- |
| `sessionDirectory` | The exact retained native session directory |
| `prePromotionRestoreReviewed` | `true`, only after reviewing the held operation |
| `transactionSHA256`, `coordinatorSHA256`, `journalSHA256` | Raw-file hashes of the failed suite transaction, native coordinator record and product journal |
| `reconciliationSHA256` | Raw-file hash of the original approved reconciliation |
| `archiveSHA256`, `archiveReceiptSHA256`, `rehearsalSHA256` | Raw-file hashes of the archive, its receipt and its successful rehearsal result |
| `stagedTreeSHA256`, `currentDataSHA256` | The controller's `tree_digest` of the failed extracted stage and current suite data |
| `expectedCurrentInventorySHA256` | The product's unchanged stopped native inventory digest |
| `configurationSHA256`, `manifestSHA256`, `oldControllerSourceSHA256` | The original configuration's raw-file hash, original manifest's raw-file hash and original controller source digest |

The controller verifies these pins, the original plan calculation, clean stopped services and the
exact reservation. The product journal must still say `stopped`, with no source manifest, restored
inventory or promotions recorded. Any restore source or previous promotion marker refuses this
operation. A held or uncertain product operation needs its own recovery instead.

Before continuing, Hive retains the failed transaction and journals and moves the verified old
extraction into private recovery history. It then freshly extracts the same pinned archive and runs
the ordinary restore and startup paths under the old plan. The new controller's provenance and
explicit delegation remain recorded. Startup verifies and releases the fence restored from that
archive; it never substitutes a new reservation or clears uncertain work.

### Recovering a pre-capture native shutdown

If a backup stops during native quiescence, it retains the product reservation, admission hold
and exact failed journals. `backup --native-recovery FILE --archive ID --yes` is an explicit,
recovery-only operation for that narrow phase. It requires a private approval document with a
`hosts` object. Each selected host supplies its reported `sessionDirectory`,
`expectedCurrentInventorySHA256`, `coordinatorSHA256`, `journalSHA256`, and
`quiescenceEffectsReviewed: true`. Obtain and review these digests from the protected stopped
inventory and failed-session records; they are not authorization to discard uncertain work.

Recovery verifies the old failed transaction and exact session, requires clean empty native
services and settled work, and keeps the prior failure evidence. The product rechecks the approved
stopped inventory without reading live SQLite sidecars, then returns services to their original
states and releases only that session's admission hold. No archive or restore is performed.
After it succeeds, take a fresh backup with the current controller. Captures, restores, promotions,
foreign sessions and uncertain work are outside this recovery action and remain held for their
owning reconciliation workflow. Never edit a journal to force it through.

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
- **Native agents** are not suite containers. Magnus-managed profiles and their manager remain
  stopped from frozen inventory through the suite capture, so profile creation and identity
  changes cannot race the Magnus/HiveMem stores. Declared standalone agents retain their own
  adapter contract. Independent manual writers remain outside the reservation's coverage.
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

`hive.sh backup` never prunes archives; [retention](#retention) is a separate command.

## Retention

Every upgrade and rollback keeps its pre-change backup in `backups/ID` and the rehearsal that
restored it in `rehearsals/ID`. `restore` accepts an archive only while its passed rehearsal is
there: the two are one restore point. `hive.sh backups` manages them on every host of the
installation:

```bash
./hive.sh backups list                                     # every entry, and why it stays
./hive.sh backups prune                                    # dry run: what would go, and the space it frees
./hive.sh backups prune --keep 5 --keep-days 14 --apply    # remove it
```

### Restored copies

A rehearsal restores the whole backup into `rehearsals/ID` and runs the candidate release on it,
so while it runs it is a complete restored copy of the installation: usually many times the size
of its compressed backup. Once it has passed and its containers are gone, nothing reads that copy
again. A restore check reads only the rehearsal's `result.json`, and `restore` extracts the backup
archive afresh. So only the newest passed rehearsal keeps its full copy. The others **release**
it, from suite 3.9.5, and keep their evidence:

- **Released:** `data/`, `config/` (which holds copies of every secret environment file),
  `releases/`, `agents/`, `agent-profiles/`, `native-profiles/` and leftover integrity scratch
  directories.
- **Kept, byte for byte:**
  - `result.json`, `isolated.json`, `resources-released.json` and the `resource-evidence.*`
    container logs and states;
  - `compose.json`, `receipt.json`, `installation.json` and `data-formats.json`;
  - the schema-upgrade and manifest records;
  - anything else a later release adds.
- **Added:** an owner-only `copy-released.json`. It records:
  - the installation, the archive's SHA-256 and the digests of `isolated.json` and `result.json`;
  - what was released and its size, when, by which trigger (`rehearse`, `prune` or `schedule`),
    and with which release and controller.

Nothing about the restore point changes. The backup stays restorable, by this controller and by
every earlier one since 2.4.0, because their stage housekeeping accepts a rehearsal whose
`resources-released.json` matches its `isolated.json`. To inspect a full copy again, rehearse
the backup once more: `./hive.sh rehearse --archive ID`. That retains the previous attempt in
`rehearsal-history/ID` and makes the new rehearsal the newest full copy.

The copies are released in two places:

- **Each rehearse step.** This covers `hive.sh rehearse` and the rehearsal inside every upgrade
  and rollback. Before it extracts its own copy, the step releases the copies of every earlier
  passed rehearsal and of superseded attempts in `rehearsal-history/`, so the disk never holds
  both. This is best effort: a copy that cannot be released is reported, kept, and retried by
  the next prune; it never fails the step.
- **`backups prune`.** It lists each copy it would release as `release`, with the space that
  frees. `--apply` and the daily prune release them, keeping the newest `--keep-full N` (default
  1, from 1 to 1000). This covers rehearsals made before 3.9.5. `--keep-full` is a command-line
  option only: the installation file has no key for it, because older controllers refuse unknown
  `retention` keys. `backups list` shows a released copy as `restored copy released DATE;
  evidence kept`, with its small size, and its kind stays `restorable`.

A copy is never released from:

- a failed or incomplete rehearsal: those copies are evidence;
- a rehearsal whose container resources are not released yet (no matching
  `resources-released.json`; the next upgrade's staging releases them first), or whose
  containers still exist;
- a rehearsal with a symlink in its path or among the released directories;
- a rehearsal whose backup no longer verifies;
- any rehearsal while another command holds the controller lock, or while a transaction is open,
  except the rehearse step's own.

A release moves the directories into `rehearsals/ID/.releasing.*` on the same file system, writes
`copy-released.json`, then deletes them. An interrupted release is finished by the next one.
Releasing a copy changes no backup. On an installation with several hosts, `prune --apply`
releases copies on each host under that host's lock.

`prune` is a dry run unless `--apply` is given. It prints each entry it would remove, each restored
copy it would release, and the space that frees, and changes nothing. `--apply` removes the
eligible entries, releases the copies and prints each one; before 3.15.0, only on a
single-host installation (see [several hosts](#pruning-on-several-hosts)).
Automatic pruning is off by default; from 3.9.4 an installation can
[prune every day](#daily-pruning).
Each run uses one private snapshot of its installation configuration through planning and
deletion; edits to the operator's configuration file take effect on the next command.

**Several hosts.** `list` and dry runs are available, but pair removal by `--apply` and automatic
pruning are disabled for installations with more than one host. There `--apply` only releases
[restored copies](#restored-copies), which keeps every backup restorable, and then exits with the
same refusal for the pairs the rules match. The current controller cannot hold every
host's lock continuously from selection through deletion. Another controller could protect an
archive on one host after the plan was read, leaving an incomplete restore point if its
counterpart were deleted elsewhere. Pair removal is never requested from any host; an explicit
`"auto": true` does not override this protection.

**What stays.** Retention keeps the union of:

- the newest `keep` restorable pairs (default 5): a verified backup with a passed rehearsal of
  exactly its bytes;
- everything newer than `keepDays` days (default 14), by the time of the backup's receipt (or of
  the rehearsal's result when it has no backup).

Whatever the settings, it never removes:

- the newest restorable pair;
- the upgrade archive of the installed release: the rehearsal whose plan is the one in
  `receipt.json`, and its backup;
- anything a state file in the installation directory names: by name, by path under `backups/` or
  `rehearsals/`, or by the archive's SHA-256 in any top-level JSON file (transactions, the
  receipt, recovery and supersession records, restore reconciliations), or by its rehearsal's plan
  in `receipt.json`, `transaction.json` or a `recovery-transaction` or `recovery-supersession`
  record. An archive a `restore` used stays, because its reconciliation names it;
- a backup that has no rehearsal, such as one `hive.sh backup` took or a backup whose rehearsal
  was removed by hand. It is not restorable until rehearsed again (`./hive.sh rehearse --archive
  ID`), and whatever takes those backups owns their retention; `list` shows them as
  `backup-only`;
- a rehearsal without a result (`incomplete`), and a rehearsal whose containers still exist; the
  next upgrade's staging releases those containers;
- anything at all while another command holds the controller lock, or while a transaction is
  open (an upgrade, rollback, backup, restore or rehearsal between its steps, or one that needs
  recovery). `prune` then refuses and removes nothing.

On an installation with several hosts, the plan treats one archive ID as one restore point: an
entry any host keeps is shown as kept on every host.

#### Pruning on several hosts

A plan reads each host under its lock in turn, so another command can protect an archive on one
host after that host was read. Controllers of suite 3.14.3 and earlier therefore removed no pair
on an installation with several hosts. From 3.15.0, `prune --apply` removes
pairs there in three steps, each one on every host under that host's lock and with no transaction
open:

1. **Set aside.** Each host works out its own plan again and sets aside the requested pairs that
   it still finds removable: it records them in `retention/hold-TOKEN.json`, then renames them to
   `.held-TOKEN-ID` beside them, where no other command finds them. A host that now keeps an
   archive (a new reference, transaction or recovery record) reports it instead. A pair goes
   only when every host holding it set it aside. If any host refuses, holds the lock or cannot be
   reached, nothing is removed on any host and every host puts back what it set aside.
2. **Decide.** Each host records the pairs that go in its hold record, before any host removes
   anything. From then on the prune only finishes forwards: a decided hold is never put back,
   and an undecided one is never removed.
3. **Remove.** Each host removes the decided pairs, records them in `retention/prune-*.json` and
   puts everything else back.

When a prune stops part-way, for example because a host became unreachable, `backups list` names
what is set aside, `prune` refuses to start another one on that host, and the next
`prune --apply` finishes the interrupted one first: forwards on every host when any host
recorded the decision, otherwise by putting everything back. A restore point is therefore never
left removed on some hosts and restorable on others. An archive set aside on a host is not
restorable there until the prune ends, so a `restore` of an archive that is being pruned refuses
before it changes anything.

Automatic pruning (`retention.auto` and the [daily prune](#daily-pruning)) removes pairs on an
installation with several hosts only when the installation file also sets
`"retention": {"multiHost": true}`. Without it, both report that they are off and remove nothing;
`prune --apply` by hand needs no opt-in.

**What goes.** A pair goes as a whole: the rehearsal first, then its `rehearsal-history/ID`
attempts, then the backup, so an interruption never leaves a rehearsal that claims a backup it no
longer has. A failed rehearsal goes with its backup, and a rehearsal or history whose backup is
already gone goes alone, once outside the rules above.

**After an upgrade.** Automatic pruning is off unless the installation explicitly enables it. With that opt-in, a successful upgrade prunes with the installation's settings once
it has completed, and lists what it removed. A problem there is reported and does not fail the
upgrade. Configure it in the installation file:

```json
"retention": { "keep": 5, "keepDays": 14, "auto": false, "schedule": "03:40" }
```

Each key is optional: `keep` from 2 to 1000, `keepDays` from 0 to 3650, and `auto` defaults to
`false`. Set `auto` to `true` to prune after successful upgrades (with several hosts, together
with `multiHost`),
or leave it off and use `--apply` after reviewing a dry run. `--keep` and `--keep-days` override
the file for one run. `schedule`, a 24-hour local time, has `install` set up the
[daily prune](#daily-pruning). Retention is available from suite 3.9.3, and `schedule` from 3.9.4.
The controller of 3.9.2 or earlier refuses an installation file with `retention`, and that of 3.9.3
refuses one with `retention.schedule`: remove the key before running an older release's controller,
for example for a rollback.

**Records and other copies.** Each host records every prune that removed something in
`retention/prune-TIME-ID.json` in its installation directory: when, what triggered it, the
settings, and each removed archive with its kind, time, SHA-256 and size. A prune that released
restored copies records them in `retention/release-TIME-ID.json`. Retention only removes
entries under the host's `backups/`, `rehearsals/` and `rehearsal-history/`. Copies kept elsewhere,
on another machine or by your own backup job, are never touched; use the record's names and
digests to reconcile them.

### Daily pruning

From suite 3.9.4, a single-host installation can run `backups prune --apply` every day from cron,
and from 3.15.0 an installation with several hosts that sets
`"retention": {"multiHost": true}` ([several hosts](#pruning-on-several-hosts)):

```bash
./hive.sh backups schedule enable --at 03:40    # add or replace the line; the default time is 03:40
./hive.sh backups schedule status               # the line, its controller, the rules and the last run
./hive.sh backups schedule disable              # remove the line
```

`enable` writes one line into the crontab of the user who runs it, the controller's user. The line
ends with `# hive-retention-schedule config=FILE`, naming the installation file, so each
installation file has at most one line. `enable` and `disable` read the crontab, replace only that
line and install the result with `crontab FILE`, which replaces the table in one step. Every other
line stays byte for byte; a crontab whose last line has no final newline gains only that newline.
Repeating a command changes nothing. The line looks like this, with `$HOME` expanded:

```text
40 3 * * * PATH=/usr/local/bin:/usr/bin:/bin /opt/hive-controller/hive.sh backups schedule run --config $HOME/.config/hive/hive/installation.json >> $HOME/.local/state/hive/hive/retention-schedule.log 2>&1 # hive-retention-schedule config=$HOME/.config/hive/hive/installation.json
```

It names the controller that enabled it, the installation file and the log, as absolute paths of
letters, digits and `._/@+-` (cron passes the line to `/bin/sh`; `enable` refuses other paths), and
the `PATH` that controller had, so cron finds the same `jq`, `ssh` and `flock`. The time is the
controller machine's local time; choose one away from that installation's backups and upgrades.

**Each run** is `backups prune --apply` with the installation file's `keep` and `keepDays`
(defaults 5 and 14) and one full restored copy; `--keep`, `--keep-days`, `--keep-full` and `--at`
are refused. It needs no terminal: an SSH
host uses the configuration's `sshConfig` and `sudoPasswordFile`, as every other command does. It
takes each host's controller lock and refuses, removing nothing, while another command holds it,
while a transaction is open, and unless the host's `receipt.json` names this controller's digest
(`controllerSourceSHA256`, which install, upgrade, rollback and adoption record). That check runs on
the host under the lock, so a line left on an older or newer controller never prunes with
different code. Each run appends a start line and an end line, each with its UTC time and the
outcome (`succeeded`, or `refused or failed` with its exit status), and the prune's own output to
`$XDG_STATE_HOME/hive/INSTALLATION/retention-schedule.log` (by default under
`~/.local/state/hive/`), which `enable` creates owner-only. Nothing secret is written there. A prune
that removes or releases something records it under `retention/` with the trigger `schedule`. A refused run
is retried the next day.

**Several hosts.** `enable` and every run refuse with the same message as `prune --apply`, before
any host is contacted; cron does not change that. `status` and `disable` work on every installation.

**Controller changes.** A successful `upgrade`, `rollback` or `adopt` rewrites the installation's
line to the controller that ran it, keeping its time and log, and prints the new line; a line
edited by hand is reported and kept. `install` adds the line when the installation file sets
`retention.schedule` (guided setup asks, defaulting to yes at 03:40). Otherwise an upgrade never
adds a line; when the file sets `retention.schedule` without one, it says how to enable it. A
problem with the crontab is reported with the command that fixes it and never fails the completed
operation. A `restore` or `migrate-native` step does not rewrite the line: if the receipt then names
another controller, runs refuse until `enable` is run with that controller. If the controller
directory a line names is removed, runs fail in the log and `status` says so: enable it again from
the controller in use. A per-release checkout, or a controller run with `--manifest` and
`--trust-key`, works the same way: pruning reads no release manifest, so the line names only the
controller and the installation file, and the upgrade run from the next checkout moves it there.

**Rolling back to 3.9.3 or earlier.** Those controllers do not know the line. First, with the
current controller, run `./hive.sh backups schedule disable` and remove `retention.schedule` from
the installation file, which they refuse; then roll back. A line left behind refuses every run,
because the installation then runs another controller: remove it with `crontab -e`.

### Daily backups

From 3.15.0, the daily prune can take an online backup first. Set it in the
installation file:

```json
"retention": { "schedule": "03:40", "backup": { "keep": 7 } }
```

Each run then calls this controller's own `backup --archive scheduled-TIME-ID --yes` before it
prunes, and logs both to the schedule's log. Backups named `scheduled-*` have their own count:
retention keeps the newest `keep` (1 to 365, default 7) and anything a state file names, and
removes older ones whatever their age; other backups without a rehearsal are kept, as before. A
failed backup fails the run but still lets it prune, which never removes the newest scheduled
backups. A scheduled backup is not rehearsed: rehearse it (`./hive.sh rehearse --archive ID`)
before you rely on it for a restore. Controllers of 3.14.3 and earlier refuse `retention.backup`;
remove it before running one, for example for a rollback.

## Off-host copies

An archive holds product secrets, keys and certificates, and a backup on the host it protects is
lost with that host. From 3.15.0:

```bash
./hive.sh backups export ARCHIVE --to /mnt/backup --encrypt age1...         # a local or mounted directory
./hive.sh backups export ARCHIVE --to deploy@backup.example.com:/srv/hive  # over SSH
./hive.sh backups import --from /mnt/backup/hive-backup-ID-ARCHIVE --identity ~/.config/hive/age.key
```

`export` checks each host's backup against its receipt and checksum, copies it from every host
into a new owner-only directory `hive-backup-INSTALLATION-ARCHIVE` (one `HOST.tar`, or
`HOST.tar.age` with `--encrypt`, per host) and writes `manifest.json` with each file's SHA-256.
`--encrypt` takes an [age](https://age-encryption.org) recipient (`age1...`) or an SSH public key
and needs `age` on the controller; without it the copy is not encrypted, and `export` says so.
Over SSH the destination path is created with fixed commands and the files travel on standard
input; nothing is overwritten. `backups list` shows what this machine exported.

`import` takes an export directory on the controller (copy one made over SSH back first). It needs
an export of this installation with exactly its hosts, checks every file against the manifest
(decrypting with `--identity`) before it changes any host, and each host then checks every member
(regular files and directories under the archive only), the receipt and the checksum under its
controller lock before the backup appears in `backups/`. It never replaces an existing backup: when
a host already holds the same verified archive, as after an import that stopped at a later host, it
accepts that copy, so repeating the import completes every host.
An imported backup has no rehearsal: run `./hive.sh rehearse --archive ARCHIVE` before
`restore`. Retention treats it like any backup without a rehearsal and keeps it. Copies kept
outside the installation, by `export` or otherwise, are never touched by retention.

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
- A datastore format the controller does not know is refused before anything starts; use
  `--stopped` for it. Every writer must declare its datastore dependency so the controller can
  pause the complete group. Out-of-suite writers require their own coordinated stopped backup.
- An online backup needs every service running and healthy. A stopped or unhealthy suite is
  backed up with `--stopped`.

## Proof

`npm run test:suite:online-backup` runs real Redis, Qdrant and PostgreSQL images, and writers
that write every store in a fixed order every 20 ms, plus two independent writers sharing
PostgreSQL. It checks that no container restarts, that
every client request is answered, that every pause stays within a budget (5 s by default,
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
