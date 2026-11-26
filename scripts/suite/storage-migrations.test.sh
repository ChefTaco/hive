#!/usr/bin/env bash
# Storage migrators may read stdin. They must not consume later components from
# the controller's enumeration, in either a restored rehearsal or live migration.
set -Eeuo pipefail
umask 077
ROOT=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)
temporary=$(mktemp -d)
trap 'rm -rf -- "$temporary"' EXIT
fail() { printf 'FAIL: %s\n' "$*" >&2; exit 1; }
directory="$temporary/install"
export STORAGE_FIXTURE="$temporary"
mkdir "$temporary/bin"
cat > "$temporary/bin/docker" <<'DOCKER'
#!/usr/bin/env bash
set -Eeuo pipefail
[[ $1 != run ]] || exit 0 # Integrity containers do not attach stdin.
[[ $1 != ps ]] || exit 0 # No rehearsal containers remain.
[[ $1 == compose && $2 == -f ]]
file=$3; shift 3
case $1 in
  run)
    [[ "$1 $2 $3 $4" == 'run --no-deps --rm -T' ]]
    component=$5
    cat > "$STORAGE_FIXTURE/consumed-$component"
    printf '%s\n' "$component" >> "$STORAGE_FIXTURE/migrated"
    printf 'run %s\n' "$component" >> "$STORAGE_FIXTURE/calls"
    [[ "$component" != "${FAIL_STORAGE_COMPONENT:-}" ]];;
  ps) [[ "${RUNNING_STORAGE:-false}" != true || "$*" != 'ps --status running -q' ]] || printf 'running-fixture\n';;
  up|stop) printf '%s\n' "$*" >> "$STORAGE_FIXTURE/calls";;
  config|logs|down) exit 0;;
  *) exit 1;;
esac
DOCKER
chmod 700 "$temporary/bin/docker"
export PATH="$temporary/bin:$PATH"
script=''
for file in ownership-host.sh public-runtime.sh integrity-host.sh input-artifacts-host.sh native-initialization-host.sh adapters-host.sh inference-registration.sh initialize-migrations-host.sh rehearsal-copy-host.sh host-runtime.sh; do
  script+=$(cat "$ROOT/scripts/suite/$file")$'\n'
done
plan=$(printf '%064d' 7)
version=0.2.0
host() {
  jq -nc --arg directory "$directory" --arg action "$1" --arg plan "$plan" --arg version "$version" --arg digest "$(printf '%064d' 2)" \
    --arg archive "${ARCHIVE:-archive}" --arg operation "${OPERATION:-upgrade}" \
    '{directory:$directory,installation:"example-suite",host:"control",action:$action,plan:$plan,version:$version,digest:$digest,archive:$archive,operation:$operation,allowMigrations:true,integrityScript:"ZXhwb3J0IHt9",agents:[],inference:[],placements:{}}' |
    bash <(printf '%s\n' "${HOST_SCRIPT:-$script}") > "$temporary/host.log" 2>&1
}
reset() {
  rm -rf -- "$directory"; rm -f "$temporary/migrated" "$temporary/calls" "$temporary/consumed-"*
  mkdir -p "$directory/data" "$directory/config" "$directory/releases"
  printf '{"installation":"example-suite","host":"control","uuid":"fixture"}' > "$directory/installation.json"
  printf '{"version":"0.1.0","digest":"%064d","plan":"%064d"}' 1 1 > "$directory/receipt.json"
  jq -n --arg base "$directory" --arg user "$(id -u):$(id -g)" '
    {name:"example-suite-control",services:(["alpha","bravo","charlie"]|map(. as $name|{key:$name,value:{image:("example.com/"+$name+"@sha256:"+("0"*64)),user:$user,volumes:[{type:"bind",source:($base+"/data/"+$name),target:"/data"}]}})|from_entries)}
  ' > "$directory/compose.json"
  cp "$directory/compose.json" "$directory/candidate.$plan.json"
  # charlie's migration needs its private store running, as Oathweave's needs its Redis.
  jq -n '{schema:1,version:"0.2.0",components:((["alpha","bravo","charlie"]|map({key:.,value:{kind:"datastore",storageFormat:"store-v2",migration:{from:"store-v1",command:["migrate-fixture"]}}})|from_entries) + {store:{kind:"datastore",storageFormat:"plain-v1"}} | .charlie.requiresLocal=["store"])}' > "$directory/manifest.$plan.json"
  printf '{"alpha":"store-v1","bravo":"store-v1","charlie":"store-v1"}' > "$directory/data-formats.json"
  for component in alpha bravo charlie; do mkdir "$directory/data/$component"; printf 'retained\n' > "$directory/data/$component/state.txt"; done
  for file in signature."$plan" trust."$plan".pub controller."$plan".tar.gz; do : > "$directory/$file"; done
  ( directory=$directory plan=$plan; die() { exit 1; }; atomic_json() { jq . > "$1"; }; source "$ROOT/scripts/suite/input-artifacts-host.sh"; pin_deployment_inputs "$directory/candidate.$plan.json" )
  host prepare || { cat "$temporary/host.log" >&2; fail 'Prepare failed'; }
}
for action in rehearse migrate; do
  reset
  if [[ "$action" == rehearse ]]; then host backup || { cat "$temporary/host.log" >&2; fail 'Backup failed'; }; fi
  host "$action" || { cat "$temporary/host.log" >&2; fail "$action failed"; }
  [[ $(cat "$temporary/migrated") == $'alpha\nbravo\ncharlie' ]] || fail "$action skipped later storage migrations"
  grep -A2 -x 'up -d --wait --wait-timeout 180 store' "$temporary/calls" | tr '\n' ' ' | grep -q '^up -d --wait --wait-timeout 180 store run charlie stop --timeout 45 store' ||
    { cat "$temporary/calls" >&2; fail "$action did not run charlie's migration with its store started and stopped around it"; }
  ! grep -B1 -x 'run alpha' "$temporary/calls" | grep -q '^up ' || fail "$action started a store for a migration that needs none"
  for component in alpha bravo charlie; do [[ ! -s "$temporary/consumed-$component" ]] || fail "$action leaked enumeration input"; done
  if [[ "$action" == rehearse ]]; then
    jq -e '.result=="passed"' "$directory/rehearsals/archive/result.json" >/dev/null || fail 'Rehearsal did not pass'
    jq -e 'all(.[];.=="store-v1")' "$directory/data-formats.json" >/dev/null || fail 'Rehearsal changed live formats'
  else
    jq -e 'all(.[];.=="store-v2")' "$directory/data-formats.json" >/dev/null || fail 'Live migration did not record every format'
  fi
done
reset; export FAIL_STORAGE_COMPONENT=bravo
if host migrate; then fail 'Failed migration reported success'; fi
jq -e '.phase=="migration-started"' "$directory/transaction.json" >/dev/null || fail 'Uncertain migration was not held'
jq -e '.alpha=="store-v2" and .bravo=="store-v1" and .charlie=="store-v1"' "$directory/data-formats.json" >/dev/null || fail 'Unfinished migration recorded success'
unset FAIL_STORAGE_COMPONENT
before=$(cat "$temporary/migrated")
if host migrate; then fail 'Uncertain migration was replayed'; fi
[[ $(cat "$temporary/migrated") == "$before" ]] || fail 'Retry replayed a migration'

failed_rehearsal() {
  plan=$(printf '%064d' 7); version=0.2.0
  reset; host backup || fail 'Recovery fixture backup failed'
  export FAIL_STORAGE_COMPONENT=bravo
  if host rehearse; then fail 'Failed rehearsal reported success'; fi
  unset FAIL_STORAGE_COMPONENT
  host hold || fail 'Failed rehearsal did not hold the suite'
}
new_plan() {
  local previous=$plan
  plan=$(printf '%064d' 8); version=0.3.0
  for prefix in candidate manifest; do cp "$directory/$prefix.$previous.json" "$directory/$prefix.$plan.json"; done
  for file in signature."$plan" trust."$plan".pub controller."$plan".tar.gz; do : > "$directory/$file"; done
  ( directory=$directory plan=$plan; die() { exit 1; }; atomic_json() { jq . > "$1"; }; source "$ROOT/scripts/suite/input-artifacts-host.sh"; pin_deployment_inputs "$directory/candidate.$plan.json" )
}
failed_rehearsal; previous=$plan; new_plan
host prepare || { cat "$temporary/host.log" >&2; fail 'Unchanged failed rehearsal could not hand off'; }
jq -e --arg old "$previous" --arg next "$plan" '.previousPlan==$old and .nextPlan==$next and .liveStateUnchanged==true and .failedIsolatedRehearsal==true' "$directory/recovery-supersession.$plan.json" >/dev/null || fail 'Recovery proof missing'
jq -e --arg plan "$previous" '.plan==$plan and .phase=="recovery-required"' "$directory/recovery-transaction.$previous.json" >/dev/null || fail 'Previous failure record lost'
[[ -f "$directory/rehearsals/archive/result.json" && -f "$directory/backups/archive/state.tar.gz" ]] || fail 'Recovery evidence lost'
for corruption in data mode config empty-directory format receipt compose phase schema-journal result archive plan agent running downgrade; do
  failed_rehearsal; previous=$plan; new_plan
  case $corruption in
    data) printf 'later-write\n' >> "$directory/data/alpha/state.txt";;
    mode) chmod 644 "$directory/data/alpha/state.txt";;
    config) printf 'changed\n' > "$directory/config/changed";;
    empty-directory) mkdir "$directory/data/alpha/unrecorded";;
    format) printf '{}' > "$directory/data-formats.json";;
    receipt) printf '{}' > "$directory/receipt.json";;
    compose) printf '{}' > "$directory/compose.json";;
    phase) jq '.phase="migration-started"' "$directory/transaction.json" > "$temporary/edit"; mv "$temporary/edit" "$directory/transaction.json";;
    schema-journal) printf '{"phase":"claimed"}' > "$directory/schema-upgrade.$previous.json";;
    result) jq '.result="passed"' "$directory/rehearsals/archive/result.json" > "$temporary/edit"; mv "$temporary/edit" "$directory/rehearsals/archive/result.json";;
    archive) printf 'tampered' >> "$directory/backups/archive/state.tar.gz";;
    plan) jq '.candidatePlan=("9"*64)' "$directory/rehearsals/archive/result.json" > "$temporary/edit"; mv "$temporary/edit" "$directory/rehearsals/archive/result.json";;
    agent) mkdir -p "$directory/agents/example"; printf 'staged' > "$directory/agents/example/candidate.json";;
    running) export RUNNING_STORAGE=true;;
    downgrade) version=0.1.0;;
  esac
  before=$(sha256sum "$directory/transaction.json")
  if host prepare; then fail "Unsafe recovery handoff accepted: $corruption"; fi
  [[ $(sha256sum "$directory/transaction.json") == "$before" && ! -e "$directory/recovery-supersession.$plan.json" ]] || fail 'Refused recovery changed its transaction'
  unset RUNNING_STORAGE
done
printf 'Passed: isolated stdin runs every storage migration; uncertain outcomes never replay; unchanged failed rehearsals hand off with evidence and unsafe recovery fails closed.\n'

# ---- Restored copies: the rehearse step releases earlier passed copies before it extracts; a
# released rehearsal stays restorable, for this controller and for the 3.9.3 and 3.9.4 ones. ----
plan=$(printf '%064d' 7); version=0.2.0
reset
host backup || { cat "$temporary/host.log" >&2; fail 'First backup failed'; }
host rehearse || { cat "$temporary/host.log" >&2; fail 'First rehearsal failed'; }
[[ -f "$directory/rehearsals/archive/data/alpha/state.txt" ]] || fail 'The first rehearsal has no full copy'
before=$(cd "$directory/rehearsals/archive" && sha256sum result.json isolated.json resources-released.json compose.json receipt.json installation.json data-formats.json)
rm -f "$temporary/migrated"
ARCHIVE=second host backup || { cat "$temporary/host.log" >&2; fail 'Second backup failed'; }
ARCHIVE=second host rehearse || { cat "$temporary/host.log" >&2; fail 'Second rehearsal failed'; }
grep -q 'released 1 earlier restored rehearsal copies' "$temporary/host.log" || { cat "$temporary/host.log" >&2; fail 'The rehearse step did not report the released copy'; }
for member in data config releases; do [[ ! -e "$directory/rehearsals/archive/$member" ]] || fail "The earlier rehearsal kept $member"; done
[[ -f "$directory/rehearsals/second/data/alpha/state.txt" ]] || fail 'The new rehearsal is not a full copy'
[[ $(cd "$directory/rehearsals/archive" && sha256sum result.json isolated.json resources-released.json compose.json receipt.json installation.json data-formats.json) == "$before" ]] || fail 'Releasing the copy changed its evidence'
jq -e '.trigger=="rehearse" and .release=="0.2.0" and (.released|index("data")!=null)' "$directory/rehearsals/archive/copy-released.json" >/dev/null || fail 'The rehearse release record is wrong'
host complete || fail 'The rehearsal transaction could not complete'
compatible_script() { # VERSION: that release's host files
  local file out=''
  for file in ownership-host.sh public-runtime.sh integrity-host.sh input-artifacts-host.sh native-initialization-host.sh adapters-host.sh inference-registration.sh initialize-migrations-host.sh host-runtime.sh; do
    out+=$(git -C "$ROOT" show "v$1:scripts/suite/$file")$'\n'
  done
  printf '%s' "$out"
}
reconcile() {
  jq -nc --arg sha "$(jq -r .sha256 "$directory/backups/archive/receipt.json")" --arg data "$(cd "$directory/data" && find . -type f -print0 | sort -z | xargs -0 -r sha256sum --zero | sha256sum | cut -d ' ' -f1)" \
    '{hosts:{control:{installationUUID:"fixture",archiveSHA256:$sha,currentDataSHA256:$data,subsequentWritesReconciled:true}}}' > "$directory/reconciliation.$plan.json"
}
# Stage housekeeping and the restore check of 3.9.3 and 3.9.4, which run on rollback to them.
compatible=()
for release in 3.9.3 3.9.4; do
  if ! git -C "$ROOT" rev-parse -q --verify "v$release^{commit}" >/dev/null; then printf 'Skipped: the %s controller is not in this checkout\n' "$release"; continue; fi
  compatible+=("$release")
  (
    source <(git -C "$ROOT" show "v$release:scripts/suite/host-runtime.sh" | sed -n '/^# Rehearsal resources /,/^# End rehearsal resources\./p')
    digest() { sha256sum -- "$1" | cut -d ' ' -f1; }; atomic_json() { jq . > "$1"; }; die() { printf '%s\n' "$*" >&2; exit 1; }
    identity=fixture installation=example-suite host=control
    hive_cleanup_completed_rehearsals
  ) || fail "The $release stage housekeeping refused a released copy"
  reconcile
  OPERATION=restore HOST_SCRIPT=$(compatible_script "$release") host restore-check || { cat "$temporary/host.log" >&2; fail "The $release restore check refused a released copy"; }
done
# This controller restores the released rehearsal's backup.
reconcile
OPERATION=restore host restore-check || { cat "$temporary/host.log" >&2; fail 'The restore check refused a released copy'; }
OPERATION=restore host prepare || { cat "$temporary/host.log" >&2; fail 'Restore prepare failed'; }
OPERATION=restore host quiesce || { cat "$temporary/host.log" >&2; fail 'Restore quiesce failed'; }
printf 'later-write\n' >> "$directory/data/alpha/state.txt"; reconcile
OPERATION=restore host restore || { cat "$temporary/host.log" >&2; fail 'Restoring a released rehearsal'"'"'s backup failed'; }
[[ $(cat "$directory/data/alpha/state.txt") == retained ]] || fail 'The restore did not bring back the archived data'
printf 'Passed: the rehearse step releases earlier restored copies with their evidence byte-exact; their backups restore, and the %s controllers accept them.\n' "${compatible[*]:-(none available)}"
