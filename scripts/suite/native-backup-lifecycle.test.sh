#!/usr/bin/env bash
# Exercise the real host lifecycle/archive boundaries with a native product that
# requires its Magnus coordinator while live, and verifies an existing bundle offline.
set -Eeuo pipefail
ROOT=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)
temporary=$(mktemp -d)
trap 'rm -rf -- "$temporary"' EXIT
fail() { printf 'FAIL: %s\n' "$*" >&2; exit 1; }
mkdir "$temporary/bin"
cat > "$temporary/bin/docker" <<'DOCKER'
#!/usr/bin/env bash
set -euo pipefail
[[ "$1" == compose && "$2" == -f ]] || exit 1
shift 3
case "$1" in
  stop) printf 'suite-stop\n' >> "$FIXTURE_CALLS"; touch "$FIXTURE_STOPPED";;
  up) printf 'suite-up\n' >> "$FIXTURE_CALLS"; rm -- "$FIXTURE_STOPPED";;
  ps) [[ -f "$FIXTURE_STOPPED" ]] || printf 'fixture-running-container\n';;
  *) exit 1;;
esac
DOCKER
chmod 700 "$temporary/bin/docker"
export PATH="$temporary/bin:$PATH"
script=$(cat <<'NATIVE'
fixture_coordinator() {
  [[ ! -f "$FIXTURE_STOPPED" ]] || { printf 'Coordinator unavailable after suite stop\n' >&2; return 1; }
  printf 'coordinator-%s\n' "$1" >> "$FIXTURE_CALLS"
}
native_backup_begin() {
  printf 'native-begin:%s\n' "${1:-false}" >> "$FIXTURE_CALLS"
  [[ "$FIXTURE_NATIVE" == true ]] || return 0
  fixture_coordinator reserve || return 1
  touch "$FIXTURE_HELD"
}
native_backup_capture() {
  [[ "$FIXTURE_NATIVE" == true ]] || return 0
  [[ -f "$FIXTURE_HELD" ]] || return 1
  if [[ -d "$1" ]]; then
    [[ $(cat "$1/bundle/profile-state") == 'fixture native state' ]] || return 1
    printf 'native-bundle-verified-offline\n' >> "$FIXTURE_CALLS"
    return 0
  fi
  fixture_coordinator verify || return 1
  mkdir -p "$1/bundle"
  printf 'fixture native state\n' > "$1/bundle/profile-state"
  printf '{"fixture":true}\n' > "$1/bundle/manifest.json"
  printf 'native-captured\n' >> "$FIXTURE_CALLS"
}
native_backup_finish() {
  [[ -f "$FIXTURE_HELD" ]] || return 0
  fixture_coordinator verify || return 1
  printf 'native-resumed\n' >> "$FIXTURE_CALLS"
  fixture_coordinator release || return 1
  rm -- "$FIXTURE_HELD"
}
NATIVE
)
script+=$'\n'
for file in ownership-host.sh adapters-host.sh host-runtime.sh; do script+=$(cat "$ROOT/scripts/suite/$file")$'\n'; done

fixture() {
  operation=$1; FIXTURE_NATIVE=$2
  directory="$temporary/$operation-$FIXTURE_NATIVE"
  mkdir -p "$directory"/{data/probe,config,releases,backups,rehearsals}
  export FIXTURE_NATIVE FIXTURE_CALLS="$directory/calls" FIXTURE_STOPPED="$directory/stopped" FIXTURE_HELD="$directory/native-held"
  : > "$FIXTURE_CALLS"
  printf 'fixture suite state\n' > "$directory/data/probe/state"
  printf '{"services":{"probe":{"image":"example.com/probe:1","volumes":[]}}}\n' > "$directory/compose.json"
  printf '{"version":"0.1.0"}\n' > "$directory/receipt.json"
  printf '{"installation":"example","host":"control","uuid":"fixture-uuid"}\n' > "$directory/installation.json"
  plan=$(printf '%064d' 1)
  jq -nc --arg plan "$plan" --arg operation "$operation" '{schema:1,plan:$plan,operation:$operation,phase:"prepared"}' > "$directory/transaction.json"
}
run() {
  jq -nc --arg directory "$directory" --arg plan "$plan" --arg operation "$operation" --arg action "$1" \
    '{directory:$directory,installation:"example",host:"control",plan:$plan,operation:$operation,action:$action,version:"0.1.0",archive:"fixture",agents:[],inference:[]}' |
    bash <(printf '%s\n' "$script") > "$temporary/result" 2> "$temporary/error" || { cat "$temporary/error" >&2; return 1; }
}
before() {
  local first second
  first=$(grep -nxF "$1" "$FIXTURE_CALLS" | head -n1 | cut -d: -f1)
  second=$(grep -nxF "$2" "$FIXTURE_CALLS" | head -n1 | cut -d: -f1)
  [[ -n "$first" && -n "$second" && "$first" -lt "$second" ]] || fail "$1 must precede $2"
}

for operation in backup upgrade rollback; do
  fixture "$operation" true
  run native-backup-begin || fail "$operation did not reserve and capture while Magnus was live"
  [[ $(jq -r .phase "$directory/transaction.json") == prepared && -f "$FIXTURE_HELD" ]] || fail 'Native begin lost its held transaction'
  run quiesce || fail "$operation did not quiesce the suite"
  run backup || fail "$operation tried to contact the stopped coordinator or lost its native capture"
  [[ $(jq -r .phase "$directory/transaction.json") == backed-up ]] || fail 'Stopped archive did not record success'
  tar -xOzf "$directory/backups/fixture/state.tar.gz" native-profiles/bundle/profile-state > "$temporary/restored-state"
  [[ $(cat "$temporary/restored-state") == 'fixture native state' ]] || fail 'Dynamic profile absent from the actual archive with agents[]'
  before coordinator-reserve native-captured
  before native-captured suite-stop
  before suite-stop native-bundle-verified-offline
  [[ $(grep -cxF coordinator-verify "$FIXTURE_CALLS") == 1 ]] || fail 'Stopped capture made another live coordinator call'
  run resume-current || fail "$operation did not resume the exact held native session"
  before suite-up native-resumed
  [[ ! -f "$FIXTURE_HELD" && ! -f "$FIXTURE_STOPPED" && $(jq -r .phase "$directory/transaction.json") == complete ]] || fail 'Resume left a hold or incomplete transaction'
done

# The original no-native installation still produces a suite-only archive.
fixture backup false
for action in native-backup-begin quiesce backup resume-current; do run "$action" || fail "Legacy suite-only $action failed"; done
tar -tzf "$directory/backups/fixture/state.tar.gz" > "$temporary/members"
! grep -q '^native-profiles/' "$temporary/members" || fail 'A no-profile installation invented a native bundle'
[[ $(tar -xOzf "$directory/backups/fixture/state.tar.gz" data/probe/state) == 'fixture suite state' ]] || fail 'Legacy suite data changed'

# Restore preparation reserves the current native state, never captures a new
# bundle over the archive selected for restore.
fixture restore true
mkdir -p "$directory/backups/fixture" "$directory/archived/native-profiles/bundle"
printf 'archived native state\n' > "$directory/archived/native-profiles/bundle/profile-state"
tar -czf "$directory/backups/fixture/state.tar.gz" -C "$directory/archived" native-profiles
original=$(sha256sum "$directory/backups/fixture/state.tar.gz")
run native-backup-begin || fail 'Restore could not reserve current native state'
grep -qxF native-begin:true "$FIXTURE_CALLS" || fail 'Restore did not require native recovery for its native archive'
! grep -qxF native-captured "$FIXTURE_CALLS" || fail 'Restore preparation captured new source bytes'
[[ -z $(find "$directory" -mindepth 1 -maxdepth 1 -name 'native-capture.*' -print -quit) && $(sha256sum "$directory/backups/fixture/state.tar.gz") == "$original" ]] || fail 'Restore preparation changed its archived source'

printf 'Passed: stopped backup, upgrade and rollback capture native state before Magnus stops, archive it with agents[], resume only after suite startup, preserve suite-only behavior and never replace restore source.\n'
