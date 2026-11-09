#!/usr/bin/env bash
# The online backup acceptance with the host side as root through sudo -S over SSH, as a
# production host runs it, while every service runs as the operator's non-root uid. A
# directory the host side creates and mounts for a service must belong to that service.
# Usage: scripts/suite/online-backup-sudo.sh [SCRATCH_DIR] [-- roundtrip arguments]
set -Eeuo pipefail
started_ns=$(date +%s%N)
root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)
scratch=${1:-$(mktemp -d "${TMPDIR:-/tmp}/hive-online-backup-sudo.XXXXXX")}; (($#)) && shift
[[ "${1:-}" != -- ]] || shift
# The probe installation's Hive Registry: a local candidate build if there is one, otherwise the
# image the latest signed release pins.
if ! docker image inspect hive-registry:candidate >/dev/null 2>&1; then
  latest=$(ls "$root"/releases/[0-9]*.[0-9]*.[0-9]*.json | grep -v inputs | sort -V | tail -1)
  image=$(jq -er '.components["hive-registry"].image' "$latest")
  docker pull --quiet "$image" >/dev/null && docker tag "$image" hive-registry:candidate
fi
status=0
# One isolated root host retains both ownership checks and the real password-requiring SSH
# transport. Avoid starting and handing back the same host tree twice.
"$root/scripts/suite/sudo-host.sh" --scratch "$scratch" -- bash -c '
  set -Eeuo pipefail
  root=$1; scratch=$2; shift 2
  before=$(date +%s%N)
  bash "$root/scripts/suite/ownership-host.test.sh" "$scratch/ownership"
  after=$(date +%s%N)
  printf "%s\n" "$((after-before))" > "$scratch/ownership-nanoseconds"
  node "$root/scripts/suite/online-backup-roundtrip.mjs" --report "$scratch/report.json" "$@"
' recovery "$root" "$scratch" "$@" || status=$?
if [[ -n "${HIVE_RECOVERY_REPORT:-}" ]]; then
  node --input-type=module - "$scratch" "$HIVE_RECOVERY_REPORT" "$started_ns" "$status" <<'NODE'
import { readFileSync, existsSync, writeFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { arch, availableParallelism } from 'node:os';
const [scratch, destination, started, status] = process.argv.slice(2);
const source = join(scratch, 'report.json');
const report = existsSync(source) ? JSON.parse(readFileSync(source, 'utf8')) : { schema: 2, phases: [], result: 'failed' };
report.wrapperSeconds = Number(BigInt(Date.now()) * 1000000n - BigInt(started)) / 1e9;
const ownership = join(scratch, 'ownership-nanoseconds');
report.ownershipSeconds = existsSync(ownership) ? Number(readFileSync(ownership, 'utf8')) / 1e9 : null;
report.wrapperOverheadSeconds = report.wrapperSeconds - (report.totalSeconds ?? 0) - (report.ownershipSeconds ?? 0);
report.runner = { os: process.env.ImageOS ?? 'local', imageVersion: process.env.ImageVersion ?? 'unknown', arch: arch(), cpus: availableParallelism() };
if (status !== '0') report.result = 'failed';
writeFileSync(destination + '.tmp', JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
renameSync(destination + '.tmp', destination);
console.log(`Recovery suite: ${report.wrapperSeconds.toFixed(3)}s total, ${report.result}`);
NODE
fi
if ((status == 0)); then rm -rf -- "$scratch"; else printf 'Private evidence retained at %s\n' "$scratch" >&2; fi
exit "$status"
