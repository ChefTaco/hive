#!/usr/bin/env bash
# Finished isolated rehearsals release their stopped Docker resources and keep every file. Then a
# passed rehearsal's restored copy (data/, config/, releases/, agents/, agent-profiles/,
# native-profiles/ and scratch directories) can be released while its evidence stays byte-exact:
# the newest copies stay full, and stage housekeeping still accepts the rest.
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
source "$ROOT/scripts/suite/rehearsal-copy-host.sh"
mkdir "$temporary/bin"
export DOCKER_CALLS="$temporary/docker-calls"
cat > "$temporary/bin/docker" <<'DOCKER'
#!/usr/bin/env bash
set -euo pipefail
if [[ $1 == ps ]]; then
  # containers_remain: docker ps -aq --filter label=com.docker.compose.project=PROJECT
  [[ "$*" != *"project=${FAKE_CONTAINERS:-none}" ]] || printf 'leftover-container\n'
  exit 0
fi
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
  [[ $(cat "$restored/data/keep") == retained-data && -f "$restored/result.json" ]] || fail 'Releasing container resources removed restored data or the result'
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

# ---- Restored copies ----
copies_fixture() { # Passed rehearsals r1 (oldest) .. r3 (newest), a failed and an incomplete one.
  local name days result
  rm -rf -- "$directory"; mkdir -p "$directory/rehearsals" "$directory/backups"
  exec 9>"$directory/controller.lock"
  : > "$DOCKER_CALLS"; unset FAKE_CONTAINERS
  for name in r1:3:passed r2:2:passed r3:1:passed failed:2:failed; do
    days=${name#*:}; result=${days#*:}; days=${days%%:*}; name=${name%%:*}
    restored="$directory/rehearsals/$name"; mkdir -p "$restored" "$directory/backups/$name"
    printf 'backup %s\n' "$name" > "$directory/backups/$name/state.tar.gz"
    sha=$(digest "$directory/backups/$name/state.tar.gz")
    jq -n --arg sha "$sha" '{uuid:"fixture",installation:"example-suite",host:"control",verified:true,sha256:$sha}' > "$directory/backups/$name/receipt.json"
    jq -n --arg sha "$sha" --arg result "$result" '{schema:1,installationUUID:"fixture",archiveSHA256:$sha,isolated:true,portsPublished:false,result:$result,candidatePlan:("a"*64)}' > "$restored/result.json"
    jq -n --arg base "$restored" --arg name "rehearsal-example-suite-control-$name" '{name:$name,services:{api:{image:"fixture:1",environment:{HIVE_REHEARSAL:"true"},volumes:[{type:"bind",source:($base+"/data/api"),target:"/data"}],env_file:[($base+"/config/api.env")]}},networks:{default:{internal:true,driver:"bridge"}}}' > "$restored/isolated.json"
    mkdir -p "$restored"/{data/api,config,releases/0.1.0,agents/one,agent-profiles/one,native-profiles/bundle,.integrity-api.fixture}
    head -c 65536 /dev/urandom > "$restored/data/api/store"; printf 'SECRET=fixture-only\n' > "$restored/config/api.env"
    printf 'm\n' > "$restored/releases/0.1.0/manifest"; printf 'p\n' > "$restored/agent-profiles/one/p"; printf 'n\n' > "$restored/native-profiles/bundle/n"
    for file in compose.json receipt.json installation.json data-formats.json "schema-upgrade.$(printf 'b%.0s' {1..64}).json" "manifest.$(printf 'b%.0s' {1..64}).json" unknown-future-file; do printf '{"fixture":"%s"}\n' "$file" > "$restored/$file"; done
    hive_release_rehearsal_resources "$restored" || fail "Fixture $name could not release its resources"
    touch -d "@$(( $(date +%s) - days * 86400 ))" "$restored/result.json"
  done
  mkdir -p "$directory/rehearsals/incomplete/data"; printf 'x\n' > "$directory/rehearsals/incomplete/data/x"
}
evidence() { # DIR: every file that must stay byte-exact
  (cd "$1" && find . -path ./data -prune -o -path ./config -prune -o -path ./releases -prune -o -path ./agents -prune -o -path ./agent-profiles -prune -o -path ./native-profiles -prune -o -name '.integrity-*' -prune -o -name copy-released.json -o -type f -print0 | sort -z | xargs -0 sha256sum)
}
released_ok() { # DIR
  local member
  for member in data config releases agents agent-profiles native-profiles; do [[ ! -e "$1/$member" ]] || fail "$1/$member was not released"; done
  [[ -z $(find "$1" -maxdepth 1 -name '.integrity-*' -o -maxdepth 1 -name '.releasing.*' | head -1) ]] || fail "$1 kept scratch or trash"
  [[ -d "$1" && ! -L "$1" && $(stat -c %a "$1/copy-released.json") == 600 ]] || fail "$1 record is missing or public"
  jq -e --arg compose "$(digest "$1/isolated.json")" --arg result "$(digest "$1/result.json")" --arg archive "$(jq -r .archiveSHA256 "$1/result.json")" \
    '.schema==1 and .installationUUID=="fixture" and .composeSHA256==$compose and .resultSHA256==$result and .archiveSHA256==$archive and
     (.released|sort)==(["agent-profiles","agents","config","data","native-profiles","releases",".integrity-api.fixture"]|sort) and
     .releasedKiB>0 and (.releasedAt|test("^20")) and (.trigger|IN("prune","rehearse","schedule"))' "$1/copy-released.json" >/dev/null || { cat "$1/copy-released.json" >&2; fail "$1 record is wrong"; }
}
copies_fixture
for name in r1 r2 r3 failed; do evidence "$directory/rehearsals/$name" > "$temporary/evidence-$name"; done
plan=$(hive_rehearsal_copy_plan 1 | jq -sc .)
jq -e '(map(select(.release))|map(.name)|sort)==["r1","r2"] and (map(select(.release|not))|map(.name))==["r3"] and (map(select(.name=="r3"))[0].reason=="newest full restored copy")' <<< "$plan" >/dev/null || { printf '%s\n' "$plan" >&2; fail 'keep-full 1 selected the wrong copies'; }
calls=$(wc -l < "$DOCKER_CALLS")
results=$(hive_release_rehearsal_copies 1 prune false) || { printf '%s\n' "$results" >&2; fail 'Releasing copies failed'; }
jq -e 'map(select(.status=="released"))|map(.name)|sort==["r1","r2"]' <<< "$results" >/dev/null || fail 'The wrong copies were released'
for name in r1 r2; do
  released_ok "$directory/rehearsals/$name"
  cmp -s "$temporary/evidence-$name" <(evidence "$directory/rehearsals/$name") || fail "$name evidence changed"
  [[ -d "$directory/rehearsals/$name/$(jq -r .evidenceDirectory "$directory/rehearsals/$name/resources-released.json")" ]] || fail "$name lost its resource evidence"
done
for name in r3 failed; do [[ -f "$directory/rehearsals/$name/data/api/store" && -f "$directory/rehearsals/$name/config/api.env" ]] || fail "$name lost its full copy"; done
[[ -f "$directory/rehearsals/incomplete/data/x" ]] || fail 'An incomplete rehearsal was released'
# Stage housekeeping, unchanged since 2.4.0, accepts the released rehearsals without Docker.
hive_cleanup_completed_rehearsals || fail 'Stage housekeeping refused a released copy'
for name in r1 r2; do hive_release_rehearsal_resources "$directory/rehearsals/$name" || fail "$name no longer passes resource release"; done
[[ $(wc -l < "$DOCKER_CALLS") == "$calls" ]] || fail 'Housekeeping ran Docker on a released copy'
# Idempotent: nothing more to release; a direct repeat reports it.
[[ $(hive_release_rehearsal_copies 1 prune false) == '[]' ]] || fail 'A repeat released more'
jq -e '.status=="already-released"' <<< "$(hive_release_rehearsal_copy "$directory/rehearsals/r1" r1 prune 0.1.0 '')" >/dev/null || fail 'A repeat was not idempotent'
cmp -s "$temporary/evidence-r1" <(evidence "$directory/rehearsals/r1") || fail 'A repeat changed evidence'
# The rehearse step keeps none besides the copy it is about to extract: only within its own transaction.
plan=$(printf 'c%.0s' {1..64}) input='{"operation":"upgrade"}'
jq -n --arg plan "$(printf 'd%.0s' {1..64})" '{plan:$plan,phase:"backed-up",operation:"upgrade"}' > "$directory/transaction.json"
if results=$(hive_release_rehearsal_copies 0 rehearse true); then fail 'Another transaction allowed a release'; fi
jq -e '.[0].reason|test("transaction is in phase backed-up")' <<< "$results" >/dev/null && [[ -d "$directory/rehearsals/r3/data" ]] || fail 'Another transaction was not refused'
jq -n --arg plan "$plan" '{plan:$plan,phase:"backed-up",operation:"upgrade"}' > "$directory/transaction.json"
if hive_release_rehearsal_copies 0 rehearse false > /dev/null; then fail 'An open transaction allowed a prune release'; fi
hive_release_rehearsal_copies 0 rehearse true > "$temporary/rehearse" || { cat "$temporary/rehearse" >&2; fail 'The owning rehearse step could not release'; }
released_ok "$directory/rehearsals/r3"; jq -e '.trigger=="rehearse"' "$directory/rehearsals/r3/copy-released.json" >/dev/null || fail 'The trigger was not recorded'
[[ -d "$directory/rehearsals/failed/data" ]] || fail 'A failed rehearsal was released'
rm -f "$directory/transaction.json"
# The lock is required.
copies_fixture; exec 9>&-
if results=$(hive_release_rehearsal_copies 0 prune false); then fail 'A release ran without the host lock'; fi
jq -e '.[0].reason|test("lock")' <<< "$results" >/dev/null && [[ -d "$directory/rehearsals/r1/data" ]] || fail 'A release without the lock changed something'
exec 9>"$directory/controller.lock"

# Refusals, each leaving the copy untouched.
copy_refused() { # NAME REASON
  local result
  if result=$(hive_release_rehearsal_copy "$directory/rehearsals/$1" "$1" prune 0.1.0 ''); then fail "$2: released"; fi
  jq -e --arg reason "$2" '.status=="refused" and (.reason|contains($reason))' <<< "$result" >/dev/null || fail "$2: $result"
  [[ -f "$directory/rehearsals/$1/data/api/store" && ! -e "$directory/rehearsals/$1/copy-released.json" ]] || fail "$2: the copy changed"
}
copy_refused failed 'did not pass'
rm "$directory/rehearsals/r1/resources-released.json"; copy_refused r1 'resources-released.json is missing'
edit "$directory/rehearsals/r2/isolated.json" '.services.api.environment.EXTRA="1"'; copy_refused r2 'containers have not been released'
export FAKE_CONTAINERS=rehearsal-example-suite-control-r3; copy_refused r3 'containers still exist'; unset FAKE_CONTAINERS
copies_fixture; mv "$directory/rehearsals/r1/data" "$temporary/elsewhere-data"; ln -s "$temporary/elsewhere-data" "$directory/rehearsals/r1/data"
if hive_release_rehearsal_copy "$directory/rehearsals/r1" r1 prune 0.1.0 '' > /dev/null; then fail 'A symlinked member was released'; fi
[[ -f "$temporary/elsewhere-data/api/store" ]] || fail 'A symlink target was touched'
copies_fixture; printf 'changed\n' >> "$directory/backups/r1/state.tar.gz"; copy_refused r1 'checksum differs'
copies_fixture; mv "$directory/rehearsals/r1" "$temporary/r1-real"; ln -s "$temporary/r1-real" "$directory/rehearsals/r1"
[[ $(hive_rehearsal_copy_plan 0 | jq -s 'map(select(.name=="r1"))|length') == 0 ]] || fail 'A symlinked rehearsal was planned'
if hive_release_rehearsal_copy "$directory/rehearsals/r1" r1 prune 0.1.0 '' > /dev/null; then fail 'A symlinked rehearsal was released'; fi
[[ -f "$temporary/r1-real/data/api/store" ]] || fail 'A symlinked rehearsal changed'
# Parity with resource release: whatever hive_release_rehearsal_resources refuses, so does this.
for patch in '.name="production"' '.services.api.ports=["8443:8443"]' '.networks.default.internal=false' '.services.api.volumes[0].source="/opt/other"' '.services.api.env_file=["/opt/other.env"]' '.services.api.environment.HIVE_REHEARSAL="false"'; do
  copies_fixture; restored="$directory/rehearsals/r1"; edit "$restored/isolated.json" "$patch"
  edit "$restored/resources-released.json" ".composeSHA256=\"$(digest "$restored/isolated.json")\""
  if hive_release_rehearsal_resources "$restored"; then fail "Resource release accepted $patch"; fi
  [[ -n $(hive_rehearsal_copy_refusal "$restored" r1 false) ]] || fail "Copy release accepted $patch"
done

# An interrupted release is finished on the next pass, with what it had already moved.
copies_fixture; restored="$directory/rehearsals/r1"
mkdir "$restored/.releasing.interrupted"; mv "$restored/data" "$restored/.releasing.interrupted/data"
jq -e 'map(select(.name=="r1"))[0].release' <<< "$(hive_rehearsal_copy_plan 1 | jq -sc .)" >/dev/null || fail 'An interrupted release was not planned again'
hive_release_rehearsal_copy "$restored" r1 prune 0.1.0 '' > /dev/null || fail 'An interrupted release was not finished'
released_ok "$restored"
copies_fixture; restored="$directory/rehearsals/r1"
hive_release_rehearsal_copy "$restored" r1 prune 0.1.0 '' > /dev/null; mkdir -p "$restored/.releasing.left/data"; printf 'x' > "$restored/.releasing.left/data/x"
hive_release_rehearsal_copy "$restored" r1 prune 0.1.0 '' > /dev/null || fail 'A recorded release with leftovers failed'
[[ ! -e "$restored/.releasing.left" ]] || fail 'Leftover trash was not removed'
# A superseded attempt in rehearsal-history/ is always released.
copies_fixture; hive_archive_rehearsal_attempt "$directory/rehearsals/r3" || fail 'Attempt not archived'
attempt=$(find "$directory/rehearsal-history/r3" -mindepth 1 -maxdepth 1 -type d)
jq -e --arg path "${attempt#"$directory/"}" 'map(select(.path==$path))[0] | .kind=="attempt" and .release' <<< "$(hive_rehearsal_copy_plan 1 | jq -sc .)" >/dev/null || fail 'An attempt was not selected'
hive_release_rehearsal_copies 1 prune false > /dev/null || fail 'An attempt could not be released'
released_ok "$attempt"
[[ -d "$directory/rehearsals/r2/data" ]] || fail 'With r3 superseded, r2 is the newest full copy'
printf 'Passed: restored copies release with evidence byte-exact, keep the newest N, stay accepted by stage housekeeping, refuse failed, unreleased, mismatched, symlinked or busy rehearsals, need the lock and their own transaction, finish interrupted releases and are idempotent.\n'
