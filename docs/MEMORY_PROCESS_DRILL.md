# Memory process recovery drill

Run `npm run test:memory-recovery` from the repository root after installing the
Memory TypeScript dependencies. Requirements: Node 24, Linux `/proc`, `flock`,
Docker with a local Unix socket, and the pinned Qdrant image (pulled if missing).
The runner refuses remote Docker contexts. It never reads a production env file,
contacts a deployed Hive host, or copies production content or credentials.

The command builds Memory, creates a unique container and volume, generates local
credentials and synthetic memories, then runs the production CLI as a subprocess.
It destroys only those fixture resources on completion. A failed assertion exits
nonzero. The JSON report defaults to `$TMPDIR/hivemem-process-drill.json`; override
with `HIVE_MEMORY_DRILL_REPORT`. Reports contain counts, timings and safe errors,
not tokens or production content. CI uploads the report as `memory-recovery`.

## Required outcomes

- A 201 memory receipt remains readable exactly once after SIGKILL and restart.
- A second process cannot acquire the same storage writer lock.
- A process killed after removing the shared copy but before writing the private
  copy replays its fsynced journal, retains the vector and leaves one private copy.
- Stopping the fixture Qdrant causes writes/readiness to return 503; liveness stays
  200. Restart restores readiness through automatic persistence retry. A failed
  write has an **indeterminate** outcome and may commit during recovery.
- Injected dependency latency delays acknowledgement until the write is durable.
- An episode produces a memory automatically. SIGKILL after a persisted worker
  claim recovers that work within 15 seconds and does not duplicate it on restart.
- An unsupported poison job retries with backoff and reaches `dead_letter`, while
  a healthy job behind it completes. Manual retry/cancel remain available.
- Eight concurrent writes at each corpus size finish with no pending persistence;
  each acknowledgement is below 15 seconds and API peak RSS remains below 1 GiB.

## Reference result

Qdrant `v1.18.1`; all seven fault/recovery checks passed. Interrupted-worker
recovery took 2,966 ms. Synthetic records are approximately 2 KB and distributed
across 12 agents, three memory types and shared/private collections.

| Records before writes | API startup | Eight-write batch | Slowest acknowledgement | API peak RSS | Pending after acknowledgement |
| --- | --- | --- | --- | --- | --- |
| 1,005 | 554 ms | 130 ms | 88 ms | 143 MiB | false |
| 4,000 | 693 ms | 338 ms | 296 ms | 295 MiB | false |

The first corpus includes five records from the recovery scenarios. RSS samples
the API process every 50 ms, not Docker or the fixture runner. The process has a
768 MiB V8 heap cap; the separate Qdrant container has a 1 GiB memory limit.

The synthetic corpus does not model every production content shape,
long-running workload or embedding provider. These measurements establish a
repeatable fixture baseline, not a production latency guarantee. Compare your own
collection sizes (from read-only Qdrant collection metadata) against the corpus
sizes above before relying on them.

## Worker recovery guidance

Read `/v1/health/ready` and the console Queue panel. `manual` means no CLI-managed
loop; `disabled` means configuration explicitly turned it off. `stale` means no
heartbeat for more than 60 seconds. `degraded` includes a safe dependency/recovery
message. Restore the indicated dependency and refresh; a successful worker tick
clears the error. Inspect the job before manually retrying a dead letter.

Keep one writer per storage directory. Claims are recovered immediately only
after startup acquires its OS lock and flushes the recovered state. This does not
provide distributed ownership for multiple writers with different local paths.
