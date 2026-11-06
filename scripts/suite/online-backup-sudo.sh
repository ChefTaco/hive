#!/usr/bin/env bash
# The online backup acceptance with the host side as root through sudo -S over SSH, as a
# production host runs it, while every service runs as the operator's non-root uid. A
# directory the host side creates and mounts for a service must belong to that service.
# Usage: scripts/suite/online-backup-sudo.sh [SCRATCH_DIR] [-- roundtrip arguments]
set -Eeuo pipefail
root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)
scratch=${1:-$(mktemp -d "${TMPDIR:-/tmp}/hive-online-backup-sudo.XXXXXX")}; (($#)) && shift
[[ "${1:-}" != -- ]] || shift
status=0
"$root/scripts/suite/sudo-host.sh" --scratch "$scratch" -- node "$root/scripts/suite/online-backup-roundtrip.mjs" "$@" || status=$?
if ((status == 0)); then rm -rf -- "$scratch"; else printf 'Private evidence retained at %s\n' "$scratch" >&2; fi
exit "$status"
