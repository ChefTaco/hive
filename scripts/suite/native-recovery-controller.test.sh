#!/usr/bin/env bash
set -Eeuo pipefail
ROOT=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)
source "$ROOT/scripts/suite/controller.sh"
source "$ROOT/scripts/suite/lifecycle.sh"
temporary=$(mktemp -d)
trap 'rm -rf -- "$temporary"' EXIT
fail() { printf 'FAIL: %s\n' "$*" >&2; exit 1; }
HIVE_ROOT=$ROOT HIVE_CONFIG="$temporary/config.json" HIVE_NATIVE_RECOVERY_FILE="$temporary/approval.json"
HIVE_ARCHIVE=example HIVE_PLAN_DIGEST=current-verified-plan
printf '{"hosts":{"control":{},"peer":{}}}\n' > "$HIVE_CONFIG"
hive_action() {
  printf '%s:%s\n' "$1" "$2" >> "$temporary/calls"
  jq -e --arg host "$1" '.hosts[$host].quiescenceEffectsReviewed==true' <<< "$HIVE_NATIVE_RECOVERY_INPUT" >/dev/null
}
approval() { jq -nc --arg host "$1" '{hosts:{($host):{quiescenceEffectsReviewed:true}}}' > "$HIVE_NATIVE_RECOVERY_FILE"; chmod 600 "$HIVE_NATIVE_RECOVERY_FILE"; }
refused() {
  : > "$temporary/calls"
  if (hive_native_recovery) > "$temporary/result" 2>&1; then fail "Recovery accepted $1"; fi
  [[ ! -s "$temporary/calls" ]] || fail "Recovery contacted a host before refusing $1"
}
approval peer
hive_native_recovery > "$temporary/result" 2>&1 || fail 'An approved selected host was not transported'
[[ $(cat "$temporary/calls") == peer:native-backup-recover ]] || fail 'Recovery acted on unapproved hosts or took a backup'
[[ "$HIVE_PLAN_DIGEST" == current-verified-plan ]] || fail 'Recovery replaced the current controller plan with an old one'
grep -q 'No archive was taken' "$temporary/result" || fail 'Recovery-only completion was not explained'
approval missing; refused unknown-host
approval peer; chmod 640 "$HIVE_NATIVE_RECOVERY_FILE"; refused readable-approval
approval peer; mv "$HIVE_NATIVE_RECOVERY_FILE" "$temporary/original"; ln -s "$temporary/original" "$HIVE_NATIVE_RECOVERY_FILE"; refused symlink; rm "$HIVE_NATIVE_RECOVERY_FILE"
approval peer; HIVE_ARCHIVE='' refused missing-archive
approval peer; python3 - "$HIVE_NATIVE_RECOVERY_FILE" <<'PY'
import sys
from pathlib import Path
Path(sys.argv[1]).write_text(' ' * 65537)
PY
refused oversized-approval
printf 'Passed: native recovery transports only approved hosts, preserves the current plan, takes no archive, and refuses unsafe approvals before host actions.\n'
