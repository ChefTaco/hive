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
[[ $1 == compose && $2 == -f ]]
file=$3; shift 3
case $1 in
  run)
    [[ "$1 $2 $3 $4" == 'run --no-deps --rm -T' ]]
    component=$5
    cat > "$STORAGE_FIXTURE/consumed-$component"
    printf '%s\n' "$component" >> "$STORAGE_FIXTURE/migrated"
    [[ "$component" != "${FAIL_STORAGE_COMPONENT:-}" ]];;
  ps) [[ "${RUNNING_STORAGE:-false}" != true || "$*" != 'ps --status running -q' ]] || printf 'running-fixture\n';;
  config|up|stop|logs|down) exit 0;;
  *) exit 1;;
esac
DOCKER
chmod 700 "$temporary/bin/docker"
export PATH="$temporary/bin:$PATH"
script=''
for file in ownership-host.sh public-runtime.sh integrity-host.sh input-artifacts-host.sh native-initialization-host.sh adapters-host.sh inference-registration.sh initialize-migrations-host.sh host-runtime.sh; do
  script+=$(cat "$ROOT/scripts/suite/$file")$'\n'
done
plan=$(printf '%064d' 7)
version=0.2.0
host() {
  jq -nc --arg directory "$directory" --arg action "$1" --arg plan "$plan" --arg version "$version" --arg digest "$(printf '%064d' 2)" \
    '{directory:$directory,installation:"example-suite",host:"control",action:$action,plan:$plan,version:$version,digest:$digest,archive:"archive",operation:"upgrade",allowMigrations:true,integrityScript:"ZXhwb3J0IHt9",agents:[],inference:[],placements:{}}' |
    bash -c "$script" > "$temporary/host.log" 2>&1
}
reset() {
  rm -rf -- "$directory"; rm -f "$temporary/migrated" "$temporary/consumed-"*
  mkdir -p "$directory/data" "$directory/config" "$directory/releases"
  printf '{"installation":"example-suite","host":"control","uuid":"fixture"}' > "$directory/installation.json"
  printf '{"version":"0.1.0","digest":"%064d","plan":"%064d"}' 1 1 > "$directory/receipt.json"
  jq -n --arg base "$directory" --arg user "$(id -u):$(id -g)" '
    {name:"example-suite-control",services:(["alpha","bravo","charlie"]|map(. as $name|{key:$name,value:{image:("example.com/"+$name+"@sha256:"+("0"*64)),user:$user,volumes:[{type:"bind",source:($base+"/data/"+$name),target:"/data"}]}})|from_entries)}
  ' > "$directory/compose.json"
  cp "$directory/compose.json" "$directory/candidate.$plan.json"
  jq -n '{schema:1,version:"0.2.0",components:(["alpha","bravo","charlie"]|map({key:.,value:{kind:"datastore",storageFormat:"store-v2",migration:{from:"store-v1",command:["migrate-fixture"]}}})|from_entries)}' > "$directory/manifest.$plan.json"
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
