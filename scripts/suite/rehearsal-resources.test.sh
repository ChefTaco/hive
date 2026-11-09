#!/usr/bin/env bash
# Finished isolated rehearsals release only their stopped Docker resources, retaining evidence/data.
set -Eeuo pipefail
umask 077
ROOT=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)
temporary=$(mktemp -d)
trap 'rm -rf -- "$temporary"' EXIT
fail() { printf 'FAIL: %s\n' "$*" >&2; exit 1; }
digest() { sha256sum -- "$1" | cut -d ' ' -f1; }
atomic_json() { [[ ${FAKE_RECEIPT_FAIL:-false} != true ]] && jq . > "$1"; }
die() { printf '%s\n' "$*" >&2; exit 1; }
source <(sed -n '/^# Rehearsal resources /,/^# End rehearsal resources\./p' "$ROOT/scripts/suite/host-runtime.sh")
mkdir "$temporary/bin"
export DOCKER_CALLS="$temporary/docker-calls"
cat > "$temporary/bin/docker" <<'DOCKER'
#!/usr/bin/env bash
set -euo pipefail
[[ $1 == compose && $2 == -f ]]
file=$3; shift 3
printf '%s:%s\n' "$1" "$file" >> "$DOCKER_CALLS"
case $1 in
  ps) [[ ${2:-} != --status || ${FAKE_RUNNING:-false} != true ]] || printf 'running-container\n';;
  logs) [[ ${FAKE_LOG_FAIL:-false} != true ]] || exit 1; printf 'protected-fixture-output\n';;
  down)
    [[ "$*" == 'down --timeout 45' ]] || exit 1
    [[ ${FAKE_DOWN_FAIL:-false} != true ]] || exit 1;;
  *) exit 1;;
esac
DOCKER
chmod 700 "$temporary/bin/docker"
export PATH="$temporary/bin:$PATH"
directory="$temporary/install" identity=fixture installation=example-suite host=control
fixture() {
  rm -rf -- "$directory"; mkdir -p "$directory/rehearsals" "$directory/backups"
  : > "$DOCKER_CALLS"
  unset FAKE_RECEIPT_FAIL FAKE_RUNNING FAKE_LOG_FAIL FAKE_DOWN_FAIL
  restored="$directory/rehearsals/archive"; mkdir -p "$restored/data" "$directory/backups/archive"
  printf 'retained-data\n' > "$restored/data/keep"
  printf 'owned-backup\n' > "$directory/backups/archive/state.tar.gz"
  sha=$(digest "$directory/backups/archive/state.tar.gz")
  jq -n --arg sha "$sha" '{uuid:"fixture",installation:"example-suite",host:"control",verified:true,sha256:$sha}' > "$directory/backups/archive/receipt.json"
  jq -n --arg sha "$sha" '{schema:1,installationUUID:"fixture",archiveSHA256:$sha,isolated:true,portsPublished:false,result:"passed",candidatePlan:("a"*64)}' > "$restored/result.json"
  jq -n --arg base "$restored" '{name:"rehearsal-example-suite-control-archive",services:{api:{image:"fixture:1",environment:{HIVE_REHEARSAL:"true"},volumes:[{type:"bind",source:($base+"/data"),target:"/data"}],env_file:[($base+"/service.env")]}},networks:{default:{internal:true,driver:"bridge"}}}' > "$restored/isolated.json"
}
edit() { jq "$2" "$1" > "$temporary/edit"; mv "$temporary/edit" "$1"; }
refused() {
  if hive_release_rehearsal_resources "$restored"; then fail "$1 was accepted"; fi
  ! rg -q '^down:' "$DOCKER_CALLS" || fail "$1 removed resources"
  [[ ! -e "$restored/resources-released.json" ]] || fail "$1 recorded success"
}
for result in passed failed; do
  fixture; edit "$restored/result.json" ".result=\"$result\""
  hive_release_rehearsal_resources "$restored" || fail "Stopped $result rehearsal did not release resources"
  [[ $(cat "$restored/data/keep") == retained-data && -f "$restored/result.json" ]] || fail 'Restored data or result was removed'
  jq -e '.resourcesReleased==true and (.evidenceDirectory|startswith("resource-evidence."))' "$restored/resources-released.json" >/dev/null || fail 'Cleanup receipt missing'
  evidence=$(jq -r .evidenceDirectory "$restored/resources-released.json")
  [[ $(cat "$restored/$evidence/container-output.log") == protected-fixture-output ]] || fail 'Diagnostics were lost'
  [[ $(stat -c %a "$restored/$evidence") == 700 ]] || fail 'Diagnostics directory is public'
  calls=$(wc -l < "$DOCKER_CALLS"); hive_release_rehearsal_resources "$restored" || fail 'Repeat cleanup failed'
  [[ $(wc -l < "$DOCKER_CALLS") == "$calls" ]] || fail 'Acknowledged cleanup was repeated'
done
for patch in '.name="production"' '.services.api.ports=["8443:8443"]' '.services.api.network_mode="host"' \
  '.networks.default.external=true' '.networks.default.internal=false' '.networks.default.name="production"' \
  '.include=["/opt/other/compose.json"]' '.services.api.extends={file:"/opt/other/compose.json",service:"api"}' '.volumes.shared={external:true}' \
  '.services.api.volumes[0].source="/opt/other"' '.services.api.env_file=["/opt/other.env"]' \
  '.services.api.volumes[0].source+="/../../other"' '.services.api.env_file[0]+="/../../other.env"' \
  '.services.api.environment.HIVE_REHEARSAL="false"'; do
  fixture; edit "$restored/isolated.json" "$patch"; refused "Unowned Compose $patch"
done
for patch in '.installationUUID="foreign"' '.archiveSHA256=("b"*64)' '.isolated=false' '.portsPublished=true' '.result="unknown"'; do
  fixture; edit "$restored/result.json" "$patch"; refused "Unverified result $patch"
done
fixture; printf 'changed' >> "$directory/backups/archive/state.tar.gz"; refused 'Changed backup'
fixture; export FAKE_RUNNING=true; refused 'Running rehearsal'
fixture; export FAKE_LOG_FAIL=true; refused 'Unavailable diagnostics'
fixture; ln -s "$temporary/foreign" "$restored/resources-released.json"; refused 'Symlink cleanup receipt'
fixture; mv "$restored/isolated.json" "$temporary/spec"; ln -s "$temporary/spec" "$restored/isolated.json"; refused 'Symlink Compose'
for failure in FAKE_DOWN_FAIL FAKE_RECEIPT_FAIL; do
  fixture; export "$failure=true"
  if hive_release_rehearsal_resources "$restored"; then fail "$failure reported success"; fi
  [[ ! -e "$restored/resources-released.json" || ! -s "$restored/resources-released.json" ]] || fail "$failure wrote a success receipt"
  unset "$failure"; hive_release_rehearsal_resources "$restored" || fail 'Unacknowledged cleanup could not reconcile'
done
fixture; mkdir "$directory/rehearsals/incomplete"; hive_cleanup_completed_rehearsals || fail 'Automatic housekeeping failed'
[[ -f "$restored/resources-released.json" && -d "$directory/rehearsals/incomplete" ]] || fail 'Housekeeping did not retain incomplete evidence'
fixture; hive_archive_rehearsal_attempt "$restored" || fail 'Finished rehearsal could not be retained for a fresh retry'
[[ ! -e "$restored" ]] || fail 'Retry would reuse an old test store'
saved=$(find "$directory/rehearsal-history/archive" -mindepth 1 -maxdepth 1 -type d)
[[ $(cat "$saved/data/keep") == retained-data && -f "$saved/result.json" && -f "$saved/resources-released.json" ]] || fail 'Retry lost prior data or evidence'
fixture; edit "$restored/result.json" '.result="unknown"'
if hive_archive_rehearsal_attempt "$restored"; then fail 'Uncertain rehearsal was archived automatically'; fi
[[ -f "$restored/data/keep" && ! -e "$directory/rehearsal-history" ]] || fail 'Uncertain rehearsal was changed'
printf 'Passed: stopped verified rehearsal resources released, data/evidence retained, idempotency and unsafe/active/foreign/failure refusals.\n'
