#!/usr/bin/env bash
# Functional tests for release-manager.sh. Run: bash scripts/lib/release-manager.test.sh
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=/dev/null
source "$SCRIPT_DIR/release-manager.sh"

PASS=0
FAIL=0
fail() { echo "  FAIL: $1"; FAIL=$((FAIL + 1)); }
pass() { PASS=$((PASS + 1)); }
assert_eq() { if [[ "$1" == "$2" ]]; then pass; else fail "${3:-} (expected '$2', got '$1')"; fi; }
assert_true() { if eval "$1"; then pass; else fail "${2:-assertion failed}: $1"; fi; }
assert_false() { if eval "$1"; then fail "${2:-expected failure}: $1"; else pass; fi; }

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

echo "release-manager: init + prepare + activate"
BASE="$WORK/svc"
release_manager_init "$BASE"
assert_true "[[ -d '$BASE/releases' && -d '$BASE/shared' ]]" "init creates layout"

ID1="20260101000000-aaaa"
DIR1="$(release_manager_prepare "$BASE" "$ID1")"
assert_eq "$DIR1" "$BASE/releases/$ID1" "prepare returns release dir"
echo "code-v1" > "$DIR1/marker"
release_manager_activate "$BASE" "$ID1"
assert_eq "$(release_manager_current_id "$BASE")" "$ID1" "activate sets current"
assert_eq "$(cat "$BASE/current/marker")" "code-v1" "current resolves to release"

echo "release-manager: second release + rollback"
ID2="20260101000005-bbbb"
DIR2="$(release_manager_prepare "$BASE" "$ID2")"
echo "code-v2" > "$DIR2/marker"
release_manager_activate "$BASE" "$ID2"
assert_eq "$(cat "$BASE/current/marker")" "code-v2" "current is v2"

TARGET="$(release_manager_rollback_target "$BASE")"
assert_eq "$TARGET" "$ID1" "rollback target is previous release"
release_manager_activate "$BASE" "$TARGET"
assert_eq "$(cat "$BASE/current/marker")" "code-v1" "rolled back to v1"

echo "release-manager: explicit rollback target + unknown id"
assert_eq "$(release_manager_rollback_target "$BASE" "$ID2")" "$ID2" "explicit rollback id honored"
assert_false "release_manager_rollback_target '$BASE' 'nope' 2>/dev/null" "unknown rollback id fails"

echo "release-manager: activate unknown id fails"
assert_false "release_manager_activate '$BASE' 'ghost' 2>/dev/null" "activate unknown release fails"

echo "release-manager: prune keeps newest N and never the active one"
BASE2="$WORK/svc2"
release_manager_init "$BASE2"
for i in 1 2 3 4 5 6 7; do
  id="2026010100000$i-cccc"
  release_manager_prepare "$BASE2" "$id" >/dev/null
done
# Activate an OLD release to prove prune never deletes the active one.
release_manager_activate "$BASE2" "20260101000001-cccc"
release_manager_prune "$BASE2" 5
mapfile -t remaining < <(release_manager_list "$BASE2")
assert_eq "${#remaining[@]}" "5" "prune keeps 5 releases"
assert_true "[[ -d '$BASE2/releases/20260101000001-cccc' ]]" "prune keeps active release"
assert_true "[[ -d '$BASE2/releases/20260101000007-cccc' ]]" "prune keeps newest release"

echo "release-manager: legacy migration moves state into shared"
BASE3="$WORK/svc3"
mkdir -p "$BASE3/data" "$BASE3/dist"
echo "SECRET=1" > "$BASE3/.env"
echo "db" > "$BASE3/data/router.db"
release_manager_migrate_legacy "$BASE3"
assert_true "[[ -f '$BASE3/shared/.env' ]]" "legacy .env moved to shared"
assert_true "[[ -f '$BASE3/shared/data/router.db' ]]" "legacy data moved to shared"
assert_true "[[ ! -e '$BASE3/.env' ]]" "legacy .env removed from root"
# Idempotent second run is a no-op and does not error.
release_manager_migrate_legacy "$BASE3"
assert_true "[[ -f '$BASE3/shared/.env' ]]" "legacy migration idempotent"

echo ""
echo "release-manager tests: $PASS passed, $FAIL failed"
[[ "$FAIL" -eq 0 ]]
