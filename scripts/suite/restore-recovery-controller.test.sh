#!/usr/bin/env bash
set -Eeuo pipefail
ROOT=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)
source "$ROOT/scripts/suite/controller.sh"
source "$ROOT/scripts/suite/lifecycle.sh"
temporary=$(mktemp -d)
trap 'rm -rf -- "$temporary"' EXIT
fail() { printf 'FAIL: %s\n' "$*" >&2; exit 1; }
HIVE_ROOT=$ROOT HIVE_CONFIG="$temporary/config.json" HIVE_MANIFEST="$temporary/manifest.json" HIVE_NATIVE_RECOVERY_FILE="$temporary/approval.json"
HIVE_ARCHIVE=fixture HIVE_PLAN_DIGEST=current-trusted-plan HIVE_PREPARE_RECONCILIATION=false HIVE_RECONCILIATION='' HIVE_ALLOW_MIGRATIONS=false HIVE_RELAX_AUTH_LIMITS=false
printf '{"hosts":{"control":{}},"agents":[]}\n' > "$HIVE_CONFIG"
printf '{"version":"0.1.1","controllerSHA256":"new","components":{"probe":{}}}\n' > "$HIVE_MANIFEST"
printf '{"hosts":{"control":{"prePromotionRestoreReviewed":true}}}\n' > "$HIVE_NATIVE_RECOVERY_FILE"
chmod 600 "$HIVE_NATIVE_RECOVERY_FILE"
hive_action() {
  printf '%s:%s\n' "$1" "$2" >> "$temporary/calls"
  [[ "$HIVE_NATIVE_RECOVERY_CONFIGURATION_SHA" == "$(sha256sum "$HIVE_CONFIG" | cut -d ' ' -f1)" && -n "$HIVE_NATIVE_RECOVERY_MANIFEST_SEMANTIC_SHA" ]] || return 1
}
refused() {
  : > "$temporary/calls"
  if (hive_restore_native_recovery) > "$temporary/result" 2>&1; then fail "Accepted $1"; fi
  [[ ! -s "$temporary/calls" ]] || fail "Contacted a host before refusing $1"
}
hive_restore_native_recovery > "$temporary/result" 2>&1 || fail 'Valid recovery entry refused'
[[ $(cat "$temporary/calls") == $'control:restore-recovery-check\ncontrol:restore-recovery-apply\ncontrol:restore-recovery-resume' ]] || fail 'Recovery did not preflight/apply/resume in fresh host actions'
[[ "$HIVE_PLAN_DIGEST" == current-trusted-plan ]] || fail 'Recovery leaked its old-plan delegation into the controller'
HIVE_PREPARE_RECONCILIATION=true refused new-preparation
HIVE_RECONCILIATION=example.json refused changed-reconciliation
HIVE_ALLOW_MIGRATIONS=true refused migration
HIVE_RELAX_AUTH_LIMITS=true refused changed-auth-limits
HIVE_ARCHIVE='' refused missing-archive
printf '{"hosts":{"control":{},"peer":{}},"agents":[]}\n' > "$HIVE_CONFIG"; refused multi-host
printf '{"hosts":{"control":{}},"agents":[{"id":"other"}]}\n' > "$HIVE_CONFIG"; refused static-agent
printf '{"hosts":{"control":{}},"agents":[]}\n' > "$HIVE_CONFIG"
chmod 640 "$HIVE_NATIVE_RECOVERY_FILE"; refused shared-approval
printf 'Passed: restore continuation is single-host/native-only, preserves the current controller plan, uses three fresh actions and rejects conflicting new-operation flags before transport.\n'
