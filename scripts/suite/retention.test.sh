#!/usr/bin/env bash
# Backup and rehearsal retention: the selection rules, every protected item, the controller lock,
# the dry run, removal of pairs together with an audit record, the installation settings, and the
# prune after a successful upgrade. No containers are started.
set -Eeuo pipefail
umask 077
ROOT=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)
temporary=$(mktemp -d)
trap 'rm -rf -- "$temporary"' EXIT
fail() { printf 'FAIL: %s\n' "$*" >&2; exit 1; }
directory="$temporary/install"
plan_of() { printf '%064d' "$1"; }
current_plan=$(plan_of 7)

# Fake Docker: reports a leftover container for one rehearsal project only.
mkdir -m 700 "$temporary/bin"
cat > "$temporary/bin/docker" <<'DOCKER'
#!/usr/bin/env bash
[[ "$*" == 'ps -aq --filter label=com.docker.compose.project=rehearsal-example-suite-control-pre-leftover' ]] && printf 'fixture-container\n'
exit 0
DOCKER
chmod 700 "$temporary/bin/docker"
export PATH="$temporary/bin:$PATH"

jq --arg base "$directory" '.hosts.control.directory=$base | .console.runtimeFile=($base+"/config/runtime.json") | .components|=with_entries(.key as $name|if .value.envFile then .value.envFile=($base+"/config/"+$name+".env") else . end|if .value.configDirectory then .value.configDirectory=($base+"/config/"+$name) else . end)' "$ROOT/examples/installation.json" > "$temporary/config.json"

ago() { date -d "@$(( $(date +%s) - $1 * 86400 - 600 ))" '+%Y-%m-%d %H:%M:%S'; }
backup() { # NAME DAYS
  mkdir -p "$directory/backups/$1"
  printf 'archive %s\n' "$1" > "$directory/backups/$1/state.tar.gz"
  jq -n --arg sha "$(sha256sum "$directory/backups/$1/state.tar.gz" | cut -d ' ' -f1)" '{schema:1,uuid:"fixture-uuid",installation:"example-suite",host:"control",sha256:$sha,verified:true}' > "$directory/backups/$1/receipt.json"
  touch -d "$(ago "$2")" "$directory/backups/$1/receipt.json"
}
rehearsal() { # NAME DAYS RESULT PLAN
  local restored="$directory/rehearsals/$1" sha
  mkdir -p "$restored/data/store"
  head -c 4096 /dev/zero > "$restored/data/store/file"
  sha=$(jq -r '.sha256 // empty' "$directory/backups/$1/receipt.json" 2>/dev/null || true)
  jq -n --arg result "$3" --arg sha "${sha:-$(printf '%064d' 0)}" --arg plan "$4" '{schema:1,result:$result,archiveSHA256:$sha,installationUUID:"fixture-uuid",candidatePlan:$plan,isolated:true,portsPublished:false}' > "$restored/result.json"
  jq -n --arg name "rehearsal-example-suite-control-$1" '{name:$name,services:{}}' > "$restored/isolated.json"
  printf '{"resourcesReleased":true}\n' > "$restored/resources-released.json"
  touch -d "$(ago "$2")" "$restored/result.json"
}
pair() { backup "$1" "$2"; rehearsal "$1" "$2" "${3:-passed}" "${4:-$(plan_of "$2")}"; }

fixture() {
  rm -rf -- "$directory"; mkdir -p "$directory/backups" "$directory/rehearsals" "$directory/rehearsal-history"
  printf '{"schema":1,"installation":"example-suite","host":"control","uuid":"fixture-uuid"}\n' > "$directory/installation.json"
  jq -n --arg plan "$current_plan" '{schema:1,installation:"example-suite",host:"control",version:"0.1.0",plan:$plan}' > "$directory/receipt.json"
  jq -n --arg plan "$current_plan" '{schema:1,plan:$plan,phase:"complete",version:"0.1.0",operation:"upgrade"}' > "$directory/transaction.json"
  # Every schema-upgrade record names its own plan; that alone protects nothing.
  for days in 26 27 28; do jq -n --arg plan "$(plan_of "$days")" '{schema:1,plan:$plan}' > "$directory/schema-upgrade.$(plan_of "$days").json"; done
  for days in 20 23 24 25 26 27 28 29 30; do pair "pre-$days" "$days"; done
  pair pre-recent 3
  pair pre-installed 41 passed "$current_plan"
  pair pre-reconciled 42
  pair pre-leftover 43
  pair pre-failed 35 failed
  pair pre-superseded 36 failed "$(plan_of 99)"
  jq -n --arg plan "$(plan_of 98)" '{schema:1,previousPlan:"x",nextPlan:$plan,archive:"pre-superseded",liveStateUnchanged:true,failedIsolatedRehearsal:true}' > "$directory/recovery-supersession.$(plan_of 98).json"
  jq -n --arg sha "$(jq -r .sha256 "$directory/backups/pre-reconciled/receipt.json")" '{hosts:{control:{archiveSHA256:$sha}}}' > "$directory/reconciliation.$(plan_of 97).json"
  pair pre-recovery 37 failed "$(plan_of 96)"
  jq -n --arg plan "$(plan_of 96)" '{schema:1,plan:$plan,phase:"recovery-required",version:"0.0.9",operation:"upgrade"}' > "$directory/recovery-transaction.$(plan_of 96).json"
  # A passed rehearsal of other bytes does not make its backup restorable.
  pair pre-mismatch 38; jq '.archiveSHA256=("f"*64)' "$directory/rehearsals/pre-mismatch/result.json" > "$temporary/result"; cp "$temporary/result" "$directory/rehearsals/pre-mismatch/result.json"; touch -d "$(ago 38)" "$directory/rehearsals/pre-mismatch/result.json"
  rehearsal orphan-old 33 passed "$(plan_of 33)"
  rehearsal orphan-new 2 passed "$(plan_of 2)"
  backup daily-old 50
  backup pre-incomplete 40; mkdir -p "$directory/rehearsals/pre-incomplete/data"
  mkdir -p "$directory/rehearsal-history/pre-30/attempt.fixture" "$directory/rehearsal-history/gone-old/attempt.fixture"
  touch -d "$(ago 60)" "$directory/rehearsal-history/gone-old"
}
snapshot() { (cd "$directory" && find backups rehearsals rehearsal-history -print | sort | sha256sum); }
hive() { "$ROOT/hive.sh" backups "$@" --config "$temporary/config.json" --non-interactive; }
refused() { # MESSAGE COMMAND...
  local message=$1; shift
  if "$@" > "$temporary/result" 2>&1; then cat "$temporary/result" >&2; fail "Accepted: $*"; fi
  grep -qF -- "$message" "$temporary/result" || { cat "$temporary/result" >&2; fail "Expected refusal '$message'"; }
}
removals() { awk '$1=="remove" {print $2}' "$1" | sort | paste -sd' '; }
reason() { # NAME TEXT FILE
  grep -E "^  keep +$1 " "$3" | grep -qF -- "$2" || { cat "$3" >&2; fail "$1 is not kept because: $2"; }
}

# The dry run is the default: it lists exactly what the rules remove and changes nothing.
fixture; before=$(snapshot)
hive prune > "$temporary/dry" 2>&1 || { cat "$temporary/dry" >&2; fail 'The dry run failed'; }
expected='gone-old orphan-old pre-26 pre-27 pre-28 pre-29 pre-30 pre-failed pre-mismatch'
[[ $(removals "$temporary/dry") == "$expected" ]] || { cat "$temporary/dry" >&2; fail "The dry run removes $(removals "$temporary/dry")"; }
grep -q '^Dry run: 9 entries would be removed, freeing ' "$temporary/dry" && grep -q 'Nothing was removed' "$temporary/dry" || { cat "$temporary/dry" >&2; fail 'The dry run does not say what it frees'; }
[[ $(snapshot) == "$before" ]] || fail 'The dry run changed the host'

# backups list shows every entry and why it stays.
hive list > "$temporary/list" 2>&1 || { cat "$temporary/list" >&2; fail 'backups list failed'; }
[[ $(removals "$temporary/list") == "$expected" ]] || fail 'list and prune disagree'
reason pre-recent 'newest restorable pair' "$temporary/list"
reason pre-recent 'newer than 14 days' "$temporary/list"
reason pre-20 'one of the newest 5 restorable pairs' "$temporary/list"
reason pre-25 'one of the newest 5 restorable pairs' "$temporary/list"
reason pre-installed 'the upgrade archive of the installed release' "$temporary/list"
reason pre-reconciled "named by reconciliation.$(plan_of 97).json" "$temporary/list"
reason pre-superseded "named by recovery-supersession.$(plan_of 98).json" "$temporary/list"
reason pre-recovery "its plan is named by recovery-transaction.$(plan_of 96).json" "$temporary/list"
reason pre-leftover 'rehearsal containers still exist' "$temporary/list"
grep -qE '^  remove +pre-mismatch +mismatched ' "$temporary/list" || fail 'A mismatched rehearsal is not shown as such'
reason daily-old 'not rehearsed' "$temporary/list"
reason pre-incomplete 'rehearsal has no result' "$temporary/list"
reason orphan-new 'newer than 14 days' "$temporary/list"
! grep -E '^  keep +pre-2[678] ' "$temporary/list" >/dev/null || fail 'A schema-upgrade record protected its plan'
[[ $(snapshot) == "$before" ]] || fail 'backups list changed the host'

# The command line overrides the installation's settings; the newest restorable pair always stays.
hive prune --keep 2 --keep-days 0 > "$temporary/tight" 2>&1 || { cat "$temporary/tight" >&2; fail 'The tight dry run failed'; }
[[ $(removals "$temporary/tight") == 'gone-old orphan-new orphan-old pre-23 pre-24 pre-25 pre-26 pre-27 pre-28 pre-29 pre-30 pre-failed pre-mismatch' ]] || { cat "$temporary/tight" >&2; fail 'keep 2 and keep-days 0 remove the wrong entries'; }
jq '.retention={keep:3,keepDays:30}' "$temporary/config.json" > "$temporary/configured.json"
"$ROOT/hive.sh" backups prune --config "$temporary/configured.json" --non-interactive > "$temporary/configured" 2>&1 || { cat "$temporary/configured" >&2; fail 'The configured dry run failed'; }
[[ $(removals "$temporary/configured") == 'gone-old orphan-old pre-30 pre-failed pre-mismatch' ]] || { cat "$temporary/configured" >&2; fail 'The installation settings were not used'; }

# --apply removes the same entries, each backup together with its rehearsal and history, and
# records them; every other entry is untouched.
hive prune --apply > "$temporary/apply" 2>&1 || { cat "$temporary/apply" >&2; fail 'prune --apply failed'; }
for name in pre-26 pre-27 pre-28 pre-29 pre-30 pre-failed pre-mismatch orphan-old gone-old; do
  [[ ! -e "$directory/backups/$name" && ! -e "$directory/rehearsals/$name" && ! -e "$directory/rehearsal-history/$name" ]] || fail "$name was not removed completely"
  grep -q "removed $name on control" "$temporary/apply" || { cat "$temporary/apply" >&2; fail "$name was not reported"; }
done
for name in pre-20 pre-23 pre-24 pre-25 pre-recent pre-installed pre-reconciled pre-leftover pre-superseded pre-recovery; do
  [[ -f "$directory/backups/$name/state.tar.gz" && -f "$directory/rehearsals/$name/result.json" ]] || fail "$name lost its backup or rehearsal"
done
[[ -d "$directory/backups/daily-old" && -d "$directory/rehearsals/orphan-new" && -d "$directory/rehearsals/pre-incomplete" ]] || fail 'A protected entry was removed'
grep -q 'copies kept on other machines were not touched' "$temporary/apply" || fail 'The off-host copies note is missing'
records=("$directory"/retention/prune-*.json)
((${#records[@]} == 1)) || fail 'Exactly one audit record is expected'
jq -e '.schema==1 and .trigger=="prune" and .keep==5 and .keepDays==14 and .release=="0.1.0" and (.removed|map(.name)|sort)==["gone-old","orphan-old","pre-26","pre-27","pre-28","pre-29","pre-30","pre-failed","pre-mismatch"] and .freedBytes>0 and (.removed|all(.bytes>0 and (.createdAt|test("^20[0-9-]+T"))))' "${records[0]}" >/dev/null || { cat "${records[0]}" >&2; fail 'The audit record is incomplete'; }
[[ $(stat -c %a "${records[0]}") == 600 && $(stat -c %a "$directory/retention") == 700 ]] || fail 'The audit record is not owner-only'
jq -e '.archive=="pre-superseded"' "$directory/recovery-supersession.$(plan_of 98).json" >/dev/null || fail 'A state file was changed'
hive prune --apply > "$temporary/again" 2>&1 || { cat "$temporary/again" >&2; fail 'A repeated prune failed'; }
grep -q '^Nothing to remove' "$temporary/again" || { cat "$temporary/again" >&2; fail 'A repeated prune found more to remove'; }
hive prune > "$temporary/empty" 2>&1 && grep -q '^Dry run: nothing would be removed' "$temporary/empty" || { cat "$temporary/empty" >&2; fail 'An empty dry run is not reported'; }
((${#records[@]} == $(find "$directory/retention" -name 'prune-*.json' | wc -l))) || fail 'A prune that removed nothing wrote an audit record'

# The controller lock: nothing is listed or removed while another command holds the host.
fixture; before=$(snapshot)
exec 8>"$directory/controller.lock"; flock -n 8
refused 'Another controller holds this host' hive prune --apply
refused 'Another controller holds this host' hive list
exec 8>&-
[[ $(snapshot) == "$before" ]] || fail 'A locked host was changed'
# An open transaction, between the host steps of an upgrade, restore or rehearsal, stops it too.
for phase in prepared quiesced backed-up recovery-required; do
  jq --arg phase "$phase" '.phase=$phase' "$directory/transaction.json" > "$temporary/transaction"; cp "$temporary/transaction" "$directory/transaction.json"
  refused "The transaction is in phase $phase" hive prune --apply
done
[[ $(snapshot) == "$before" ]] || fail 'A host with an open transaction was changed'
jq '.phase="aborted"' "$directory/transaction.json" > "$temporary/transaction"; cp "$temporary/transaction" "$directory/transaction.json"
hive prune > /dev/null 2>&1 || fail 'An aborted transaction blocked the dry run'

# The installation settings and options, with sane bounds.
for patch in '.retention={keep:1}' '.retention={keep:2.5}' '.retention={keepDays:-1}' '.retention={keepDays:4000}' '.retention={auto:"yes"}' '.retention={keep:5,extra:true}' '.retention=5'; do
  jq "$patch" "$temporary/config.json" > "$temporary/bad.json"
  refused 'retention is {"keep":N' "$ROOT/hive.sh" backups list --config "$temporary/bad.json" --non-interactive
done
jq '.retention={keep:2,keepDays:0,auto:false}' "$temporary/config.json" > "$temporary/good.json"
"$ROOT/hive.sh" backups list --config "$temporary/good.json" --non-interactive > /dev/null 2>&1 || fail 'Valid retention settings were refused'
refused '--keep is the number' hive prune --keep 1
refused '--keep is the number' hive prune --keep many
refused '--keep-days is a number' hive prune --keep-days 9999
refused '--apply applies only to backups prune' hive list --apply
refused '--keep applies only to backups prune' "$ROOT/hive.sh" status --keep 3 --config "$temporary/config.json"
refused 'Usage: hive.sh backups' hive remove

# Hosts agree on each restore point: a name another host keeps stays everywhere.
export HIVE_ROOT=$ROOT
(
  source "$ROOT/scripts/suite/controller.sh"; source "$ROOT/scripts/suite/retention.sh"
  merged=$(hive_retention_merge '[{"host":"a","entries":[{"name":"x","remove":true,"reasons":[]},{"name":"y","remove":true,"reasons":[]}]},{"host":"b","entries":[{"name":"x","remove":false,"reasons":["newer than 14 days"]},{"name":"y","remove":true,"reasons":[]}]}]')
  jq -e '.[0].entries[0].remove==false and .[0].entries[0].reasons==["kept on host b"] and .[0].entries[1].remove==true and .[1].entries[1].remove==true' <<< "$merged" >/dev/null
) || fail 'A name kept on one host was removed on another'

# A plan is only a snapshot. Another controller can protect a restore point after
# all hosts were planned, on either the first or the last host in apply order.
# Until selection and deletion share coordinated locks, refuse multi-host writes.
multi_host_change() (
  source "$ROOT/scripts/suite/controller.sh"; source "$ROOT/scripts/suite/retention.sh"
  local changed=$1 change=$2 host base name days input plans status=0 lock_pid=''
  local multi="$temporary/multi-$changed-$change"
  trap 'if [[ -n "$lock_pid" ]]; then touch "$multi/release"; wait "$lock_pid" || true; fi' EXIT
  mkdir -p "$multi"
  HIVE_CONFIG=$multi/config.json HIVE_ROOT=$ROOT HIVE_VERSION=0.1.0 HIVE_ID=example-suite
  jq -nc --arg base "$multi" '{origin:"https://hive.example.com",hosts:{a:{target:"local",directory:($base+"/a")},b:{target:"local",directory:($base+"/b")}},components:{},agents:[],inference:[]}' > "$HIVE_CONFIG"
  for host in a b; do
    base="$multi/$host"; mkdir -p "$base"
    jq -nc --arg host "$host" '{installation:"example-suite",host:$host,uuid:"fixture-uuid"}' > "$base/installation.json"
    printf '{"version":"0.1.0"}\n' > "$base/receipt.json"
    printf '{"phase":"complete"}\n' > "$base/transaction.json"
    for name in old middle newest; do
      case "$name" in old) days=30;; middle) days=20;; newest) days=10;; esac
      mkdir -p "$base/backups/$name" "$base/rehearsals/$name"
      printf 'synthetic archive\n' > "$base/backups/$name/state.tar.gz"
      jq -nc --arg host "$host" '{installation:"example-suite",host:$host,uuid:"fixture-uuid",verified:true,sha256:("a"*64)}' > "$base/backups/$name/receipt.json"
      jq -nc '{result:"passed",archiveSHA256:("a"*64),installationUUID:"fixture-uuid",isolated:true}' > "$base/rehearsals/$name/result.json"
      touch -d "$(ago "$days")" "$base/backups/$name/receipt.json"
    done
  done
  input=$(hive_retention_input 2 0)
  plans=$(hive_retention_plans "$input") || exit 1
  jq -e 'length==2 and all(.[]; [.entries[]|select(.remove)|.name]==["old"])' <<< "$plans" >/dev/null || exit 1
  if [[ "$changed:$change" == a:lock ]]; then
    for command in list prune; do
      hive_backups_command "$command" > "$multi/preview-$command" || exit 1
      grep -q 'Multi-host preview:.*Destructive pruning is disabled' "$multi/preview-$command" || exit 1
    done
  fi
  hive_retention_action() {
    printf '%s %s\n' "$1" "$2" >> "$multi/actions"
    HIVE_HOST_ACTION=$2 HIVE_RETENTION_INPUT=$3 hive_host "$1" "$(cat "$ROOT/scripts/suite/ownership-host.sh" "$ROOT/scripts/suite/retention-host.sh")"
  }
  # These changes happen in an independent process after the merged selection.
  case "$change" in
    lock)
      (exec 8>"$multi/$changed/controller.lock"; flock -x 8; touch "$multi/ready"; while [[ ! -f "$multi/release" ]]; do sleep 0.05; done) &
      lock_pid=$!
      for _ in {1..100}; do [[ ! -f "$multi/ready" ]] || break; sleep 0.05; done
      [[ -f "$multi/ready" ]] || exit 1;;
    transaction) (printf '{"phase":"recovery-required"}\n' > "$multi/$changed/transaction.json");;
    reference) (printf '{"archive":"old"}\n' > "$multi/$changed/reconciliation.fixture.json");;
  esac
  hive_retention_apply "$input" "$plans" prune > "$multi/result" 2> "$multi/error" || status=$?
  [[ "$status" != 0 ]] && grep -q 'Multi-host backup pruning is disabled' "$multi/error" || exit 1
  [[ ! -e "$multi/actions" ]] || { printf 'Multi-host apply contacted a host\n' >&2; exit 1; }
  if HIVE_RETENTION_APPLY=true hive_backups_command prune > "$multi/command" 2>&1; then exit 1; fi
  grep -q 'Multi-host backup pruning is disabled' "$multi/command" || exit 1
  jq '.retention={auto:true}' "$HIVE_CONFIG" > "$multi/next.json"; mv "$multi/next.json" "$HIVE_CONFIG"
  hive_retention_after_upgrade > "$multi/upgrade" 2>&1 || exit 1
  grep -q 'Multi-host backup pruning is disabled' "$multi/upgrade" || exit 1
  # A multi-host prune --apply reads each host and may release restored copies; it never asks a
  # host to remove a pair.
  ! grep -q 'retention-apply' "$multi/actions" 2>/dev/null || { printf 'Multi-host manual or automatic pruning asked a host to remove a pair\n' >&2; exit 1; }
  for host in a b; do
    if [[ ! -f "$multi/$host/backups/old/state.tar.gz" || ! -f "$multi/$host/rehearsals/old/result.json" ]]; then
      printf 'Unsafe retention: %s on host %s after %s changed on host %s\n' old "$host" "$change" "$changed" >&2
      exit 1
    fi
  done
  return 0
)
for changed in a b; do
  for change in lock transaction reference; do
    multi_host_change "$changed" "$change" || fail "Cross-host retention was not held after $change on $changed"
  done
done

# Editing the operator's file while the first host action runs must not redirect
# subsequent actions or expand the run to a newly added host. All phases and the
# final transport read the same private configuration snapshot.
(
  source "$ROOT/scripts/suite/controller.sh"; source "$ROOT/scripts/suite/retention.sh"
  original=$temporary/config-mutation.json
  jq -nc '{hosts:{a:{target:"deploy@node.example.com",directory:"/opt/original"}}}' > "$original"
  HIVE_CONFIG=$original
  mkdir -p "$temporary/config-snapshots"
  export TMPDIR=$temporary/config-snapshots
  previous_trap=$(trap -p EXIT)
  hive_retention_action() {
    local selected
    selected=$(jq -r --arg host "$1" '.hosts[$host] | .target+" "+.directory' "$HIVE_CONFIG")
    printf '%s %s %s\n' "$1" "$2" "$selected" >> "$temporary/config-actions"
    case "$2" in
      retention-plan)
        jq '.hosts.a={target:"deploy@other.example.com",directory:"/opt/changed"} | .hosts.b={target:"deploy@extra.example.com",directory:"/opt/extra"}' "$original" > "$temporary/changed-config"
        mv "$temporary/changed-config" "$original"
        printf '{"host":"a","directory":"/opt/original","keep":5,"keepDays":14,"entries":[{"name":"old","remove":true,"kind":"restorable","createdAt":1,"backupKiB":1,"rehearsalKiB":1,"historyKiB":0,"reasons":[]}]}\n';;
      retention-apply) printf '{"host":"a","removed":[]}\n';;
      *) return 1;;
    esac
  }
  HIVE_RETENTION_APPLY=true hive_backups_command prune > "$temporary/config-mutation-result"
  [[ $(cat "$temporary/config-actions") == $'a retention-plan deploy@node.example.com /opt/original\na retention-apply deploy@node.example.com /opt/original' ]] || exit 1
  jq -e '(.hosts|length)==2 and .hosts.a.directory=="/opt/changed"' "$original" >/dev/null || exit 1
  [[ $(trap -p EXIT) == "$previous_trap" && -z $(find "$TMPDIR" -type f -print -quit) ]] || exit 1

  # A directly supplied plan must still match the frozen placement before writes.
  jq -nc '{hosts:{a:{target:"deploy@node.example.com",directory:"/opt/changed"}}}' > "$original"
  : > "$temporary/config-actions"
  if hive_retention_apply '{"keep":5,"keepDays":14}' '[{"host":"a","directory":"/opt/original","entries":[]}]' prune > "$temporary/config-mismatch" 2>&1; then exit 1; fi
  grep -q 'host placement differs' "$temporary/config-mismatch" && [[ ! -s "$temporary/config-actions" ]] || exit 1
  [[ -z $(find "$TMPDIR" -type f -print -quit) ]] || exit 1
) || fail 'Retention used an edited configuration or changed its caller cleanup trap'

# After a successful upgrade, and only then, retention runs with the installation's settings.
lifecycle() { # OPERATION [FAILING_STEP]
  (
    source "$ROOT/scripts/suite/controller.sh"; source "$ROOT/scripts/suite/lifecycle.sh"; source "$ROOT/scripts/suite/retention.sh"
    HIVE_CONFIG=$temporary/config.json HIVE_ARCHIVE=fixture
    for stub in hive_registry_provision hive_memory_credential_provision hive_audit_collection_provision hive_registry_refresh_ingress hive_doctor hive_stage hive_registry_begin hive_registry_complete hive_checklist_report hive_install_summary hive_initialize; do eval "$stub() { :; }"; done
    hive_all() { printf '%s\n' "$1" >> "$steps"; [[ "$1" != "$failing" ]]; }
    hive_hold() { hive_die 'held'; }
    hive_retention_after_upgrade() { printf 'retention\n' >> "$steps"; }
    steps=$temporary/steps failing=${2:-}
    hive_lifecycle "$1"
  ) > "$temporary/lifecycle.log" 2>&1
}
: > "$temporary/steps"; lifecycle upgrade || { cat "$temporary/lifecycle.log" >&2; fail 'The stubbed upgrade failed'; }
[[ $(tail -2 "$temporary/steps" | paste -sd' ') == 'complete retention' ]] || { cat "$temporary/steps" >&2; fail 'Retention did not run right after the upgrade completed'; }
for step in rehearse activate adapters-accept complete; do
  : > "$temporary/steps"; if lifecycle upgrade "$step"; then fail "An upgrade with a failed $step passed"; fi
  ! grep -q retention "$temporary/steps" || fail "Retention ran after a failed $step"
done
for operation in rollback install; do
  : > "$temporary/steps"; lifecycle "$operation" || { cat "$temporary/lifecycle.log" >&2; fail "The stubbed $operation failed"; }
  ! grep -q retention "$temporary/steps" || fail "Retention ran after $operation"
done

# The prune after an upgrade: the installation's settings, an audit record marked upgrade, and a
# problem only warns, because the upgrade itself has completed.
after_upgrade() { # CONFIG
  (
    source "$ROOT/scripts/suite/controller.sh"; source "$ROOT/scripts/suite/retention.sh"
    HIVE_CONFIG=$1 HIVE_VERSION=0.1.0 HIVE_ID=example-suite
    hive_retention_after_upgrade; printf 'continued\n'
  ) > "$temporary/after.log" 2>&1
}
fixture; before=$(snapshot)
after_upgrade "$temporary/config.json" || fail 'Default retention failed the upgrade'
grep -q 'off by default' "$temporary/after.log" && [[ $(snapshot) == "$before" ]] || { cat "$temporary/after.log" >&2; fail 'Automatic retention was enabled by default'; }
after_upgrade "$temporary/configured.json" || fail 'Configured rules enabled automatic retention'
grep -q 'off by default' "$temporary/after.log" && [[ $(snapshot) == "$before" ]] || fail 'Retention rules implicitly enabled automatic pruning'
jq '.retention={auto:false}' "$temporary/config.json" > "$temporary/off.json"
after_upgrade "$temporary/off.json" || fail 'Retention switched off failed the upgrade'
grep -q 'retention.auto' "$temporary/after.log" && [[ $(snapshot) == "$before" ]] || { cat "$temporary/after.log" >&2; fail 'Retention ran although retention.auto is false'; }
exec 8>"$directory/controller.lock"; flock -n 8
jq '.retention={auto:true}' "$temporary/config.json" > "$temporary/auto.json"
after_upgrade "$temporary/auto.json" || fail 'A retention problem failed the completed upgrade'
exec 8>&-
grep -q 'the upgrade is complete; backup retention did not run' "$temporary/after.log" && grep -q '^continued$' "$temporary/after.log" && [[ $(snapshot) == "$before" ]] || { cat "$temporary/after.log" >&2; fail 'A locked host was not reported as a warning'; }
jq '.retention.auto=true' "$temporary/configured.json" > "$temporary/configured-auto.json"
after_upgrade "$temporary/configured-auto.json" || { cat "$temporary/after.log" >&2; fail 'Retention after the upgrade failed'; }
grep -q 'Removed 5 entries' "$temporary/after.log" || { cat "$temporary/after.log" >&2; fail 'Retention after the upgrade did not use the installation settings'; }
[[ ! -e "$directory/backups/pre-failed" && ! -e "$directory/rehearsals/pre-30" && -d "$directory/backups/pre-29" ]] || fail 'Retention after the upgrade removed the wrong entries'
jq -e '.trigger=="upgrade" and .keep==3 and .keepDays==30' "$directory"/retention/prune-*.json >/dev/null || fail 'The upgrade audit record is wrong'
printf 'Passed: retention preserves protected archives, removes single-host pairs only with explicit apply or automatic opt-in, records each prune, and refuses every multi-host write before contacting a host despite late protection changes.\n'

# ---- Restored copies: a passed rehearsal keeps its evidence and gives up its copy; only the newest
# --keep-full keep theirs. The pair stays, and stays restorable. ----
copy_rehearsal() { # BASE HOST NAME DAYS
  local base=$1 host=$2 name=$3 restored="$1/rehearsals/$3" sha
  mkdir -p "$base/backups/$name" "$restored/data/store" "$restored/config"
  printf 'archive %s\n' "$name" > "$base/backups/$name/state.tar.gz"
  sha=$(sha256sum "$base/backups/$name/state.tar.gz" | cut -d ' ' -f1)
  jq -n --arg sha "$sha" --arg host "$host" '{schema:1,uuid:"fixture-uuid",installation:"example-suite",host:$host,sha256:$sha,verified:true}' > "$base/backups/$name/receipt.json"
  head -c 262144 /dev/zero > "$restored/data/store/file"; printf 'SECRET=fixture-only\n' > "$restored/config/store.env"
  jq -n --arg sha "$sha" '{schema:1,result:"passed",archiveSHA256:$sha,installationUUID:"fixture-uuid",candidatePlan:("c"*64),isolated:true,portsPublished:false}' > "$restored/result.json"
  jq -n --arg base "$restored" --arg name "rehearsal-example-suite-$host-$name" '{name:$name,services:{store:{image:"example.com/store:1",environment:{HIVE_REHEARSAL:"true"},volumes:[{type:"bind",source:($base+"/data/store"),target:"/data"}],env_file:[($base+"/config/store.env")]}},networks:{default:{internal:true,driver:"bridge"}}}' > "$restored/isolated.json"
  jq -n --arg sha "$sha" --arg spec "$(sha256sum "$restored/isolated.json" | cut -d ' ' -f1)" '{schema:1,installationUUID:"fixture-uuid",archiveSHA256:$sha,composeSHA256:$spec,resourcesReleased:true,releasedAt:"2026-01-01T00:00:00Z",evidenceDirectory:"resource-evidence.fixture"}' > "$restored/resources-released.json"
  mkdir -p "$restored/resource-evidence.fixture"; printf 'log\n' > "$restored/resource-evidence.fixture/container-output.log"
  touch -d "$(ago "$4")" "$base/backups/$name/receipt.json" "$restored/result.json"
}
copies_fixture() {
  rm -rf -- "$directory"; mkdir -p "$directory/backups" "$directory/rehearsals" "$directory/rehearsal-history"
  printf '{"schema":1,"installation":"example-suite","host":"control","uuid":"fixture-uuid"}\n' > "$directory/installation.json"
  jq -n --arg plan "$current_plan" '{schema:1,installation:"example-suite",host:"control",version:"0.1.0",plan:$plan}' > "$directory/receipt.json"
  jq -n --arg plan "$current_plan" '{schema:1,plan:$plan,phase:"complete",version:"0.1.0",operation:"upgrade"}' > "$directory/transaction.json"
  for item in c1:3 c2:2 c3:1; do copy_rehearsal "$directory" control "${item%:*}" "${item#*:}"; done
}
releases() { awk '$1=="release" {print $2}' "$1" | sort | paste -sd' '; }
copies_fixture; before=$(snapshot)
hive prune > "$temporary/copies-dry" 2>&1 || { cat "$temporary/copies-dry" >&2; fail 'The copy dry run failed'; }
[[ $(releases "$temporary/copies-dry") == 'c1 c2' && -z $(removals "$temporary/copies-dry") ]] || { cat "$temporary/copies-dry" >&2; fail 'The dry run releases the wrong copies'; }
grep -E '^  release +c1 +restorable ' "$temporary/copies-dry" | grep -qE 'release copy, frees [0-9]+ KiB; evidence and backup kept; pair kept: ' || { cat "$temporary/copies-dry" >&2; fail 'A release line does not say what it frees'; }
grep -q '^Dry run: 2 restored copies would be released, freeing .*Nothing was released' "$temporary/copies-dry" || { cat "$temporary/copies-dry" >&2; fail 'The dry run does not total the copies'; }
[[ $(snapshot) == "$before" ]] && [[ -f "$directory/rehearsals/c1/data/store/file" ]] || fail 'The copy dry run changed the host'
hive list > "$temporary/copies-list" 2>&1 || fail 'backups list failed'
reason c3 'newest full restored copy' "$temporary/copies-list"
grep -q 'They also release 2 restored copies' "$temporary/copies-list" || fail 'backups list does not mention the copies'
hive prune --keep-full 2 > "$temporary/copies-two" 2>&1 || fail 'keep-full 2 failed'
[[ $(releases "$temporary/copies-two") == c1 ]] || { cat "$temporary/copies-two" >&2; fail 'keep-full 2 releases the wrong copies'; }
grep -q 'prune --keep-full 2 --apply' "$temporary/copies-two" || fail 'The apply hint drops --keep-full'
refused '--keep-full is the number' hive prune --keep-full 0
refused '--keep-full applies only to backups prune' "$ROOT/hive.sh" status --keep-full 2 --config "$temporary/config.json"
refused '--keep-full and --apply apply only to backups prune' hive schedule status --keep-full 2
hive prune --apply > "$temporary/copies-apply" 2>&1 || { cat "$temporary/copies-apply" >&2; fail 'Releasing copies failed'; }
grep -q '^Released 2 restored copies, freeing ' "$temporary/copies-apply" || { cat "$temporary/copies-apply" >&2; fail 'The release was not reported'; }
for name in c1 c2; do
  [[ ! -e "$directory/rehearsals/$name/data" && ! -e "$directory/rehearsals/$name/config" && -f "$directory/rehearsals/$name/result.json" && -f "$directory/backups/$name/state.tar.gz" ]] || fail "$name was not released to its evidence"
  jq -e '.trigger=="prune" and (.released|sort)==["config","data"] and (.controllerSourceSHA256|test("^[a-f0-9]{64}$"))' "$directory/rehearsals/$name/copy-released.json" >/dev/null || { cat "$directory/rehearsals/$name/copy-released.json" >&2; fail "$name record is wrong"; }
done
[[ -f "$directory/rehearsals/c3/data/store/file" ]] || fail 'The newest full copy was released'
records=("$directory"/retention/release-*.json)
((${#records[@]} == 1)) && jq -e '.trigger=="prune" and .keepFull==1 and (.releasedCopies|map(.name)|sort)==["c1","c2"] and .freedBytes>0 and .backupsKept' "${records[0]}" >/dev/null || fail 'The release audit record is wrong'
[[ ! -e "$directory/retention" || -z $(find "$directory/retention" -name 'prune-*.json' -print -quit) ]] || fail 'A copy release wrote a removal record'
hive list > "$temporary/copies-after" 2>&1 || fail 'backups list after release failed'
grep -E '^  keep +c1 +restorable ' "$temporary/copies-after" | grep -q "restored copy released $(date -u +%F); evidence kept" || { cat "$temporary/copies-after" >&2; fail 'backups list does not show the released copy'; }
(
  source "$ROOT/scripts/suite/controller.sh"; source "$ROOT/scripts/suite/retention.sh"
  HIVE_CONFIG=$temporary/config.json HIVE_ROOT=$ROOT HIVE_VERSION=0.1.0 HIVE_ID=example-suite
  plans=$(hive_retention_plans "$(hive_retention_input 5 14 1)")
  jq -e '.[0].entries | (map(select(.name=="c1"))[0] | .kind=="restorable" and .copyReleased==true and (.copyReleasedAt|test("^20")) and .rehearsalKiB<200) and (map(select(.name=="c3"))[0] | .copyReleased==false and .copyReleasedAt==null)' <<< "$plans" >/dev/null
) || fail 'The inventory does not report copyReleased'
hive prune --apply > "$temporary/copies-again" 2>&1 && grep -q '^Nothing to remove' "$temporary/copies-again" || { cat "$temporary/copies-again" >&2; fail 'A repeated release found more'; }
# The scheduled run is backups prune --apply with the installation's settings.
copies_fixture
( source "$ROOT/scripts/suite/controller.sh"; source "$ROOT/scripts/suite/retention.sh"; source "$ROOT/scripts/suite/retention-schedule.sh"
  HIVE_CONFIG=$temporary/config.json HIVE_ROOT=$ROOT HIVE_VERSION=0.1.0 HIVE_ID=example-suite HIVE_RETENTION_APPLY=true HIVE_RETENTION_TRIGGER=schedule hive_backups_command prune ) > "$temporary/copies-schedule" 2>&1 || { cat "$temporary/copies-schedule" >&2; fail 'The scheduled release failed'; }
jq -e '.trigger=="schedule"' "$directory/rehearsals/c1/copy-released.json" >/dev/null || fail 'The scheduled release was not recorded as such'
# A copy whose containers were never released, or that still has containers, keeps its copy.
copies_fixture; rm "$directory/rehearsals/c1/resources-released.json"
hive prune > "$temporary/copies-held" 2>&1 || fail 'The held dry run failed'
[[ $(releases "$temporary/copies-held") == c2 ]] || { cat "$temporary/copies-held" >&2; fail 'A rehearsal without released resources was planned for release'; }
hive list > "$temporary/copies-held" 2>&1; reason c1 'resources-released.json is missing' "$temporary/copies-held"

# Several hosts: --apply releases copies on each host, and still removes no pair.
multi_copies() (
  source "$ROOT/scripts/suite/controller.sh"; source "$ROOT/scripts/suite/retention.sh"
  local copies_dir="$temporary/multi-copies" host status=0
  rm -rf -- "$copies_dir"; mkdir -p "$copies_dir"
  HIVE_CONFIG=$copies_dir/config.json HIVE_ROOT=$ROOT HIVE_VERSION=0.1.0 HIVE_ID=example-suite
  jq -nc --arg base "$copies_dir" '{origin:"https://hive.example.com",hosts:{a:{target:"local",directory:($base+"/a")},b:{target:"local",directory:($base+"/b")}},components:{},agents:[],inference:[]}' > "$HIVE_CONFIG"
  for host in a b; do
    mkdir -p "$copies_dir/$host"
    jq -nc --arg host "$host" '{installation:"example-suite",host:$host,uuid:"fixture-uuid"}' > "$copies_dir/$host/installation.json"
    printf '{"version":"0.1.0"}\n' > "$copies_dir/$host/receipt.json"; printf '{"phase":"complete"}\n' > "$copies_dir/$host/transaction.json"
    copy_rehearsal "$copies_dir/$host" "$host" old 30; copy_rehearsal "$copies_dir/$host" "$host" middle 20; copy_rehearsal "$copies_dir/$host" "$host" newest 10
  done
  hive_retention_action() {
    printf '%s %s\n' "$1" "$2" >> "$copies_dir/actions"
    HIVE_HOST_ACTION=$2 HIVE_RETENTION_INPUT=$3 hive_host "$1" "$(cat "$ROOT/scripts/suite/ownership-host.sh" "$ROOT/scripts/suite/rehearsal-copy-host.sh" "$ROOT/scripts/suite/retention-host.sh")"
  }
  HIVE_RETENTION_KEEP=2 HIVE_RETENTION_KEEP_DAYS=0 hive_backups_command prune > "$copies_dir/preview" 2>&1 || exit 1
  grep -q 'Multi-host preview: 2 entries match' "$copies_dir/preview" && grep -q '4 restored copies, .* can be released' "$copies_dir/preview" || { cat "$copies_dir/preview" >&2; exit 1; }
  if HIVE_RETENTION_KEEP=2 HIVE_RETENTION_KEEP_DAYS=0 HIVE_RETENTION_APPLY=true hive_backups_command prune > "$copies_dir/apply" 2>&1; then cat "$copies_dir/apply" >&2; exit 1; fi
  grep -q 'Multi-host backup pruning is disabled' "$copies_dir/apply" && grep -q '^Released 4 restored copies' "$copies_dir/apply" || { cat "$copies_dir/apply" >&2; exit 1; }
  grep -q 'retention-release' "$copies_dir/actions" && ! grep -q 'retention-apply' "$copies_dir/actions" || { printf 'A multi-host prune asked a host to remove a pair\n' >&2; exit 1; }
  for host in a b; do
    for name in old middle; do [[ -f "$copies_dir/$host/rehearsals/$name/copy-released.json" && ! -e "$copies_dir/$host/rehearsals/$name/data" ]] || { printf '%s on %s kept its copy\n' "$name" "$host" >&2; exit 1; }; done
    [[ -f "$copies_dir/$host/rehearsals/newest/data/store/file" ]] || exit 1
    [[ -f "$copies_dir/$host/backups/old/state.tar.gz" && -f "$copies_dir/$host/rehearsals/old/result.json" ]] || { printf 'A multi-host pair was removed\n' >&2; exit 1; }
  done
)
multi_copies || fail 'A multi-host prune did not release copies only'
printf 'Passed: restored copies are listed with what they free, released only with --apply or the schedule, keep the newest --keep-full, are recorded, and are released on multi-host installations while pair removal stays refused.\n'

# The daily prune (backups schedule) has its own fixture: fake crontab and ssh.
bash "$ROOT/scripts/suite/retention-schedule.test.sh"
