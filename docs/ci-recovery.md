# Backup and recovery CI

The recovery job runs ownership checks, installation and seeding, two online backups, a stopped
backup, independent archive inspection, online/stopped rehearsals, insufficient-space and
paused-store failures, a non-serving-service refusal, and two reconciled restores. The job name
describes this scope. Its total duration is not the online backup duration or service pause.

`recovery-report.json` is retained as a CI artifact and summarized in the job summary, including
each phase, controller command durations, corpus size, pause durations, ownership checks and
wrapper overhead. Reports contain synthetic fixture metadata, not credentials or service logs.
Controller command durations are nested within their phases, not additional elapsed time.
Failure reports identify the failed phase and retain the disposable driver's private evidence.
Cleanup is measured separately. A controller failure still fails the job.

## Coverage selection

- Main pushes, manual runs and release tags use seed scale **1**: about 520 MiB, eighty Qdrant
  collections and about thirty thousand vectors, large active/idle SQLite databases, Redis,
  PostgreSQL and files. The five-second pause budget stays in force.
- Only pull requests consisting entirely of recognized console presentation files or the root
  README/contribution prose use seed scale **0.02**. They execute the same ownership, consistency,
  failure/retry, rehearsal and **both restore** cases, with less generated data. They do not replace
  the installation-sized pause/performance proof.
- Installer/controller, datastore, schema, shared contracts, dependency/lock, workflow, release,
  unknown, deleted, renamed or special-mode changes require the full corpus. Missing or divergent
  history, malformed changes, absent classifier output and classifier failure also select full.
  A failed classifier leaves CI failed even if fallback recovery succeeds.
- The tag publication job depends on successful full recovery. The reusable workflow defaults to
  full; manual focused runs must explicitly opt out.

All ordinary source tests, both Node versions, image/Compose recovery, public npm upgrades and
browser integration remain enabled. The focused corpus changes only this recovery acceptance.

## Efficiency and boundaries

Recovery has a separate runner and can overlap the existing verification jobs. This reduces the
critical path, with an extra runner and image preparation; it does not eliminate recovery work.
Fast regression tests remain in the canonical Node jobs instead of running a third copy in the
recovery job; the latter runs the real ownership and recovery acceptance.
The same disposable sudo host runs ownership and recovery checks, retaining a real password-
requiring SSH/sudo transport and separate service UID/GID. A synthetic PID-1 shell writer handles
TERM so stopping it does not consume the controller's kill timeout. Production stop timeouts are
unchanged. Synthetic Compose cleanup also has bounded coordinator and Docker shutdown; forced
termination fails the fixture, and the original assertion is logged before cleanup. Client readiness and post-backup recovery require observed successful responses rather
than fixed sleeps, and restored writers must demonstrably advance before the next restore.

Container inspection is batched. Independent Redis, Qdrant and PostgreSQL inspection copies start
together; they have separate extracted data directories. Lifecycle commands, same-installation
backups, failure injections, rehearsals and restores remain sequential: parallelizing those would
contend for the controller lock or invalidate reconciliation and write-order evidence. Completed
rehearsal resources are released once by the controller and verified by the driver.

Do not cache mutable fixture databases, restored stores, ownership state or sudo credentials.
Do not lower the full corpus, loosen pause/consistency assertions, or remove either restore to
improve reported time. The ordinary focused suite still verifies independent archive contents,
SQLite integrity, immutable blob bytes, store write order, Redis expiry and retained archives.

## Measuring changes

Use comparable `ubuntu-24.04` runners, Node 24.22.1 and seed scale 1 for before/after claims.
Record runner image version, CPU count, exact commit/run, corpus/archive sizes, phase durations,
first/second backup and longest pauses. Include cold image/host setup and cleanup in totals;
separate those from driver phases. Focused-versus-full timings are different workloads and must
be labelled separately. Parallel job overlap is a wall-clock benefit, not measured compute savings.
The reusable workflow also accepts manual runs: `full=true, baseline=false` measures the current
driver; `baseline=true` explicitly checks out the frozen v2.4.0 driver and always uses scale 1.
Both run on the same runner image/Node pool and print CPU/image metadata. Baseline phase timestamps
and its original JSON are retained in the workflow log; current runs also publish structured
phase artifacts. Baseline mode is unavailable to normal CI/release callers.

Baseline example: [the v2.4.0 exact-head run](https://github.com/ChefTaco/hive/actions/runs/42714552912)
used Ubuntu image `20261101.360.1`. Its first online backup took **68.118 s** for **519 MiB**, with a
**1.122 s** longest pause. The online rehearsal took **92.606 s**, stopped backup **92.666 s**, and
restore controller commands **51.599 / 51.765 s**. Full-step time includes the other phases above.
The follow-up pull request records comparable hosted before/after measurements and their limits.
