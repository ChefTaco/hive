#!/usr/bin/env bash
# Native profile coverage. Hive backs up only the Magnus agent that its own installer created and
# recorded (ROOT.native-owner.json), and only where the installation places Magnus. A host without
# that component, or a Magnus agent installed any other way (a fleet agent owned by an ordinary
# account), is "not included": backups, upgrades and restore checks continue, say so and record
# it in the receipt. An installer-owned root that fails its checks still fails.
set -Eeuo pipefail
umask 077
ROOT=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)
temporary=$(mktemp -d)
trap 'rm -rf -- "$temporary"' EXIT
fail() { printf 'FAIL: %s\n' "$*" >&2; exit 1; }
mkdir -p "$temporary/bin"
# systemd reports the agent's working directory; every query is logged.
cat > "$temporary/bin/systemctl" <<'SYSTEMCTL'
#!/usr/bin/env bash
printf '%s\n' "$*" >> "$FIXTURE_SYSTEMCTL"
case "$*" in
  *WorkingDirectory*) printf '%s\n' "$FIXTURE_AGENT";;
  *LoadState*) if [[ -n "${FIXTURE_UNIT_GONE:-}" ]]; then printf 'not-found\n'; else printf 'loaded\n'; fi;;
esac
SYSTEMCTL
cat > "$temporary/bin/docker" <<'DOCKER'
#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$*" >> "$FIXTURE_DOCKER"
[[ "$1" == compose && "$2" == -f ]] || exit 1
shift 3
case "$1" in
  stop) touch "$FIXTURE_STOPPED";;
  up) rm -f -- "$FIXTURE_STOPPED";;
  ps) [[ -f "$FIXTURE_STOPPED" ]] || printf 'fixture-running-container\n';;
  *) exit 1;;
esac
DOCKER
chmod 700 "$temporary/bin/systemctl" "$temporary/bin/docker"
export PATH="$temporary/bin:$PATH" FIXTURE_SYSTEMCTL="$temporary/systemctl-calls" FIXTURE_DOCKER="$temporary/docker-calls"

# A fleet agent: owned by an ordinary account, private, with an environment file and no
# installer ownership record. This is how agents installed by other tooling look.
fleet_agent() {
  rm -rf -- "$1" "$1.native-owner.json"; mkdir -m 700 "$1"
  printf 'CONTROL_API_URL=https://magnus.example.com:7443\nHOST_FQDN=node-1.example.com\n' > "$1/.env"; chmod 600 "$1/.env"
}

# An installer-owned agent needs root-owned files and the installer's account; this fixture
# runs unprivileged, so ownership, the account and the agent CLI are simulated, keyed by the
# FIXTURE_* variables, and otherwise behave as usual.
cat > "$temporary/installer-stubs.sh" <<'STUBS'
native_backup_storage_root() { printf '%s\n' "${FIXTURE_STORAGE:-$FIXTURE_TEMPORARY/storage}"; }
stat() {
  if [[ -n "${FIXTURE_ROOT_OWNED:-}" && "$1" == -c && "$2" == %u && "$3" == "$FIXTURE_ROOT_OWNED"* ]]; then printf '0\n'; else command stat "$@"; fi
}
getent() {
  if [[ "$1" == passwd && -n "${FIXTURE_HOME:-}" ]]; then printf '%s:x:%s:%s::%s:/bin/sh\n' "$2" "$(id -u)" "$(id -g)" "$FIXTURE_HOME"; else command getent "$@"; fi
}
# FIXTURE_CLI: old (Magnus 3.0.3: no native-snapshot), snapshot (has it, but its inspect fails), broken.
native_backup_cli() {
  shift
  [[ "${FIXTURE_CLI:-old}" != broken ]] || return 1
  case "$1" in
    --help) printf 'Usage:\n  magnus-agent [start] [--env-file <path>]\n  magnus-agent check\n'
      [[ "${FIXTURE_CLI:-old}" != snapshot ]] || printf '  magnus-agent native-snapshot inspect --json\n';;
    --version) printf '3.0.3\n';;
    identity) printf '{"state":"bound","nodeId":"node-one"}\n';;
    native-snapshot) printf 'Unknown command or failed snapshot\n' >&2; return 1;;
    *) return 1;;
  esac
}
STUBS
export FIXTURE_TEMPORARY=$temporary
# An agent the Hive installer created and recorded, with one Ardent profile.
installer_agent() {
  fleet_agent "$1"
  local home="$temporary/owner-home"
  rm -rf -- "$home"; mkdir -p "$home/.ardent/profiles/one"
  printf 'ARDENT_OWNER_USER=%s\nCONTROL_API_URL=https://hive.example.com:7443\nHOST_FQDN=node-1.example.com\n' "$(id -un)" > "$1/.env"
  jq -n --arg user "$(id -un)" --argjson uid "$(id -u)" '{schema:1,phase:"complete",username:$user,uid:$uid}' > "$1.native-owner.json"
  chmod 600 "$1.native-owner.json"
  export FIXTURE_ROOT_OWNED=$1 FIXTURE_HOME=$home
}

# ---- Discovery itself, with the real definitions. ----
(
  source "$ROOT/scripts/suite/native-backup-host.sh"
  native_backup_guard() { :; }
  installation=example-suite host=control plan=$(printf 'a%.0s' {1..64}) archive=first directory="$temporary/unused"
  native_backup_storage_root() { printf '%s/storage\n' "$temporary"; }
  export FIXTURE_AGENT="$temporary/fleet-agent"; fleet_agent "$FIXTURE_AGENT"

  # Without this installation's Magnus on the host, discovery does not run at all.
  input='{"operation":"backup","placements":{},"agents":[]}'
  : > "$FIXTURE_SYSTEMCTL"
  found=$(native_backup_discover) || fail 'A host without Magnus failed native discovery'
  jq -e '.available==false and .present==false and .included==false and .reason=="no-magnus-component"' <<< "$found" >/dev/null || fail "Unexpected discovery without Magnus: $found"
  [[ ! -s "$FIXTURE_SYSTEMCTL" ]] || fail 'Discovery inspected native services on a host without Magnus'
  jq -e '.included==false and .reason=="no-magnus-component"' <<< "$(native_backup_coverage)" >/dev/null || fail 'Coverage without Magnus is wrong'
  native_backup_begin 2> "$temporary/notice" || fail 'Backup preparation failed on a host without Magnus'
  grep -q 'native profiles not included: this host runs no Magnus component' "$temporary/notice" || fail 'Missing native coverage was silent'
  grep -q 'Agents installed outside the Hive installer are not part of Hive backups' "$temporary/notice" || fail 'The notice does not explain what is left out'
  if native_backup_discover true > /dev/null 2> "$temporary/refused"; then fail 'A native archive was accepted on a host without Magnus'; fi
  grep -q 'runs no Magnus component' "$temporary/refused" || fail 'A required discovery without Magnus was not explained'

  # A fleet agent beside this installation's Magnus is not the installer's: not included.
  input='{"operation":"backup","placements":{"magnus":{"host":"control"}},"origin":"https://hive.example.com","console":{"nativeListeners":[{"component":"magnus","port":7443}]},"agents":[]}'
  : > "$FIXTURE_SYSTEMCTL"
  found=$(native_backup_discover) || fail 'A fleet agent failed native discovery'
  jq -e --arg root "$FIXTURE_AGENT" '.available==false and .present==false and .included==false and .reason=="not-installer-owned" and .root==$root' <<< "$found" >/dev/null || fail "Unexpected fleet discovery: $found"
  [[ -s "$FIXTURE_SYSTEMCTL" ]] || fail 'Discovery did not read the native service'
  native_backup_begin 2> "$temporary/notice" || fail 'Backup preparation failed beside a fleet agent'
  grep -qF "the Magnus agent at $FIXTURE_AGENT was installed outside the Hive installer" "$temporary/notice" || fail 'An excluded fleet agent was silent'
  [[ ! -e "$temporary/storage" ]] || fail 'A fleet agent got a native backup session'
  [[ $(native_backup_space_kib) == 0 ]] || fail 'A fleet agent was counted in backup space'
  if native_backup_discover true > /dev/null 2> "$temporary/refused"; then fail 'A native archive was restored onto a fleet agent'; fi
  grep -q 'installed outside the Hive installer' "$temporary/refused" || fail 'A required fleet discovery was not explained'

  # An installer ownership record makes the root the installer's: every check applies and fails loudly.
  printf '{"schema":1,"phase":"complete","username":"nobody","uid":65534}\n' > "$FIXTURE_AGENT.native-owner.json"; chmod 600 "$FIXTURE_AGENT.native-owner.json"
  if native_backup_discover > /dev/null 2> "$temporary/refused"; then fail 'An installer-owned root that is not root-owned was accepted'; fi
  grep -q 'must be a root-owned directory with mode 700' "$temporary/refused" || fail 'A broken installer-owned root failed silently'
  if native_backup_begin 2> "$temporary/refused"; then fail 'Backup preparation accepted a broken installer-owned root'; fi
  # magnus-agent remove keeps the record while the account holds profiles. With the agent gone
  # (no directory, no unit) its profiles are not included, and an archive that holds them is refused.
  mv -- "$FIXTURE_AGENT" "$temporary/removed-agent"
  found=$(FIXTURE_UNIT_GONE=1 native_backup_discover) || fail 'A removed agent with its kept record failed discovery'
  jq -e --arg root "$FIXTURE_AGENT" '.included==false and .reason=="agent-removed" and .root==$root and .owner=="nobody"' <<< "$found" >/dev/null || fail "Unexpected discovery of a removed agent: $found"
  FIXTURE_UNIT_GONE=1 native_backup_begin 2> "$temporary/notice" || fail 'Backup preparation failed after the agent was removed'
  grep -qF "the Magnus agent at $FIXTURE_AGENT was removed" "$temporary/notice" || fail 'The removed agent was silent'
  if FIXTURE_UNIT_GONE=1 native_backup_discover true > /dev/null 2> "$temporary/refused"; then fail 'A native archive was restored without its agent'; fi
  grep -q 'install it again first' "$temporary/refused" || fail 'A required discovery without the agent was not explained'
  # A unit that is still loaded is not a removed agent: the missing root still fails.
  if native_backup_discover > /dev/null 2>&1; then fail 'A missing root with a loaded unit was accepted'; fi
  mv -- "$temporary/removed-agent" "$FIXTURE_AGENT"
  rm -- "$FIXTURE_AGENT.native-owner.json"; ln -s "$temporary/elsewhere" "$FIXTURE_AGENT.native-owner.json"
  if native_backup_discover > /dev/null 2>&1; then fail 'A symlinked ownership record was treated as absent'; fi
  rm -- "$FIXTURE_AGENT.native-owner.json"

  # No agent at all is not an exclusion: nothing to report.
  export FIXTURE_AGENT="$temporary/no-agent"
  found=$(native_backup_discover) || fail 'A host without a native agent failed discovery'
  jq -e '.included==false and .reason=="no-native-agent"' <<< "$found" >/dev/null || fail "Unexpected discovery without an agent: $found"
  native_backup_begin 2> "$temporary/notice" || fail 'Backup preparation failed without a native agent'
  [[ ! -s "$temporary/notice" ]] || fail 'A host without any native agent printed an exclusion notice'
) || exit 1
printf 'Passed: native discovery skips hosts without Magnus, excludes non-installer agents visibly, and still refuses broken installer-owned roots.\n'

# ---- The real host lifecycle on such hosts: upgrade preparation, stopped backup and restore check. ----
script=$(cat "$ROOT/scripts/suite/ownership-host.sh" "$ROOT/scripts/suite/integrity-host.sh" "$ROOT/scripts/suite/adapters-host.sh" "$ROOT/scripts/suite/native-backup-host.sh")
# Root transport is the production setting; this fixture runs unprivileged.
script+=$'\nnative_backup_guard() { :; }\n'
script+=$(cat "$temporary/installer-stubs.sh")$'\n'
script+=$(cat "$ROOT/scripts/suite/restore-recovery-host.sh" "$ROOT/scripts/suite/host-runtime.sh")
printf '%s\n' "$script" > "$temporary/host-script.sh"
plan=$(printf '%064d' 1)
fixture() { # NAME OPERATION
  directory="$temporary/$1"
  rm -rf -- "$directory"; mkdir -p "$directory"/{data/probe,config,releases,backups,rehearsals}
  export FIXTURE_STOPPED="$directory/stopped"
  : > "$FIXTURE_DOCKER"
  printf 'fixture suite state\n' > "$directory/data/probe/state"
  printf '{"services":{"probe":{"image":"example.com/probe:1","volumes":[]}}}\n' > "$directory/compose.json"
  printf '{"version":"0.1.0"}\n' > "$directory/receipt.json"
  printf '{"installation":"example","host":"control","uuid":"fixture-uuid"}\n' > "$directory/installation.json"
  jq -nc --arg plan "$plan" --arg operation "$2" '{schema:1,plan:$plan,operation:$operation,phase:"prepared"}' > "$directory/transaction.json"
}
run() { # ACTION OPERATION PLACEMENTS
  jq -nc --arg directory "$directory" --arg plan "$plan" --arg action "$1" --arg operation "$2" --argjson placements "$3" \
    '{directory:$directory,installation:"example",host:"control",plan:$plan,operation:$operation,action:$action,version:"0.1.0",archive:"fixture",
      origin:"https://hive.example.com",placements:$placements,console:null,agents:[],inference:[],nativeBackupTool:"ZmFrZQ=="}' |
    bash "$temporary/host-script.sh" > "$temporary/result" 2> "$temporary/error"
}
export FIXTURE_AGENT="$temporary/fleet-agent"
for placements in '{}' '{"magnus":{"host":"control"}}'; do
  fleet_agent "$FIXTURE_AGENT"
  reason=no-magnus-component; [[ "$placements" == '{}' ]] || reason=not-installer-owned
  fixture "$reason" upgrade
  # The upgrade's first host step after staging: it used to fail here, and the controller then
  # held (stopped) the whole suite.
  run native-backup-begin upgrade "$placements" || { cat "$temporary/error" >&2; fail "native-backup-begin failed beside a fleet agent ($reason)"; }
  [[ $(jq -r .phase "$directory/transaction.json") == prepared ]] || fail 'Native preparation changed the upgrade transaction'
  ! grep -q ' stop' "$FIXTURE_DOCKER" || fail 'Native preparation stopped the suite'
  grep -q 'native profiles not included' "$temporary/error" || fail "The upgrade did not say native profiles are not included ($reason)"
  [[ ! -e "$directory/native-capture.$plan.fixture/native-profiles" ]] || fail 'A fleet agent was captured'
  run quiesce upgrade "$placements" || { cat "$temporary/error" >&2; fail 'quiesce failed'; }
  run backup upgrade "$placements" || { cat "$temporary/error" >&2; fail "The stopped backup failed beside a fleet agent ($reason)"; }
  receipt="$directory/backups/fixture/receipt.json"
  jq -e --arg reason "$reason" '.verified==true and .nativeProfiles.included==false and .nativeProfiles.reason==$reason' "$receipt" >/dev/null || { cat "$receipt" >&2; fail 'The receipt does not record that native profiles are not included'; }
  ! tar -tzf "$directory/backups/fixture/state.tar.gz" | grep -q '^native-profiles/' || fail 'A fleet agent was archived'
  [[ $(stat -c %a "$FIXTURE_AGENT") == 700 && -f "$FIXTURE_AGENT/.env" ]] || fail 'The fleet agent was changed'
  run resume-current upgrade "$placements" || { cat "$temporary/error" >&2; fail 'resume-current failed'; }
  # A restore check of that archive: native coverage is established, not assumed.
  sha=$(jq -r .sha256 "$receipt")
  mkdir -p "$directory/rehearsals/fixture"
  jq -nc --arg sha "$sha" '{schema:1,result:"passed",archiveSHA256:$sha,installationUUID:"fixture-uuid",isolated:true,portsPublished:false}' > "$directory/rehearsals/fixture/result.json"
  jq -nc --arg sha "$sha" '{hosts:{control:{installationUUID:"fixture-uuid",archiveSHA256:$sha,currentDataSHA256:("0"*64),subsequentWritesReconciled:true}}}' > "$directory/reconciliation.$plan.json"
  run restore-check restore "$placements" || { cat "$temporary/error" >&2; fail "restore-check failed beside a fleet agent ($reason)"; }
  grep -q 'native profiles not included' "$temporary/error" || fail 'restore-check did not report native coverage'
done
# The installer's own root that fails its checks still stops the upgrade before any change.
fleet_agent "$FIXTURE_AGENT"
printf '{"schema":1,"phase":"complete","username":"nobody","uid":65534}\n' > "$FIXTURE_AGENT.native-owner.json"
fixture installer-broken upgrade
if run native-backup-begin upgrade '{"magnus":{"host":"control"}}'; then fail 'A broken installer-owned root was accepted by the upgrade'; fi
grep -q 'must be a root-owned directory' "$temporary/error" || fail 'A broken installer-owned root failed silently in the upgrade'
printf 'Passed: upgrade preparation, stopped backup and restore check continue beside non-installer agents, record "not included", and still stop on a broken installer-owned root.\n'

# ---- An installer-owned agent without the native-snapshot contract (Magnus 3.0.3 and earlier). ----
(
  source "$ROOT/scripts/suite/native-backup-host.sh"
  native_backup_guard() { :; }
  source "$temporary/installer-stubs.sh"
  installation=example-suite host=control plan=$(printf 'a%.0s' {1..64}) archive=first directory="$temporary/unused"
  input='{"operation":"backup","placements":{"magnus":{"host":"control"}},"origin":"https://hive.example.com","console":{"nativeListeners":[{"component":"magnus","port":7443}]},"agents":[]}'
  export FIXTURE_AGENT="$temporary/installer-agent"; installer_agent "$FIXTURE_AGENT"
  export FIXTURE_CLI=old
  found=$(native_backup_discover) || fail 'An agent without native-snapshot failed discovery'
  jq -e '.included==false and .present==false and .reason=="no-native-snapshot" and .agentVersion=="3.0.3" and .profilesFound==true' <<< "$found" >/dev/null || fail "Unexpected discovery without native-snapshot: $found"
  jq -e '.included==false and .reason=="no-native-snapshot" and .agentVersion=="3.0.3"' <<< "$(native_backup_coverage)" >/dev/null || fail 'Coverage without native-snapshot is wrong'
  native_backup_begin 2> "$temporary/notice" || fail 'Backup preparation failed with an agent without native-snapshot'
  grep -q 'the installed Magnus agent 3.0.3 has no native-snapshot; upgrade Magnus to include agent profiles in backups' "$temporary/notice" || fail 'A missing native-snapshot was silent'
  [[ $(native_backup_space_kib) == 0 && ! -e "$temporary/storage" ]] || fail 'An agent without native-snapshot got a session'
  if native_backup_discover true > /dev/null 2> "$temporary/refused"; then fail 'A native archive was accepted by an agent without native-snapshot'; fi
  grep -q 'has no native-snapshot; upgrade Magnus first' "$temporary/refused" || fail 'A required discovery without native-snapshot was not explained'
  # The contract is there, and fails: that stops the backup.
  export FIXTURE_CLI=snapshot
  jq -e '.included==true and .present==true and .nodeId=="node-one"' <<< "$(native_backup_discover)" >/dev/null || fail 'An agent with native-snapshot was not included'
  if native_backup_begin 2> "$temporary/refused"; then fail 'A failing native snapshot was accepted'; fi
  grep -q 'native-snapshot CLI' "$temporary/refused" || fail 'A failing native snapshot was silent'
  export FIXTURE_CLI=broken
  if native_backup_discover > /dev/null 2> "$temporary/refused"; then fail 'An agent that does not run was accepted'; fi
  grep -q 'did not run' "$temporary/refused" || fail 'An agent that does not run failed silently'
) || exit 1
export FIXTURE_AGENT="$temporary/installer-agent"; installer_agent "$FIXTURE_AGENT"
export FIXTURE_CLI=old
magnus='{"magnus":{"host":"control"}}'
fixture installer-old upgrade
run native-backup-begin upgrade "$magnus" || { cat "$temporary/error" >&2; fail 'The upgrade failed with an agent without native-snapshot'; }
grep -q 'has no native-snapshot' "$temporary/error" || fail 'The upgrade did not say profiles are not included'
run quiesce upgrade "$magnus" && run backup upgrade "$magnus" || { cat "$temporary/error" >&2; fail 'The backup failed with an agent without native-snapshot'; }
jq -e '.nativeProfiles.included==false and .nativeProfiles.reason=="no-native-snapshot" and .nativeProfiles.agentVersion=="3.0.3"' "$directory/backups/fixture/receipt.json" >/dev/null || fail 'The receipt does not record the missing native-snapshot'
run resume-current upgrade "$magnus" || fail 'resume-current failed'
sha=$(jq -r .sha256 "$directory/backups/fixture/receipt.json"); mkdir -p "$directory/rehearsals/fixture"
jq -nc --arg sha "$sha" '{schema:1,result:"passed",archiveSHA256:$sha,installationUUID:"fixture-uuid",isolated:true,portsPublished:false}' > "$directory/rehearsals/fixture/result.json"
jq -nc --arg sha "$sha" '{hosts:{control:{installationUUID:"fixture-uuid",archiveSHA256:$sha,currentDataSHA256:("0"*64),subsequentWritesReconciled:true}}}' > "$directory/reconciliation.$plan.json"
run restore-check restore "$magnus" || { cat "$temporary/error" >&2; fail 'restore-check failed with an agent without native-snapshot'; }
grep -q 'has no native-snapshot' "$temporary/error" || fail 'restore-check did not report native coverage'
printf 'Passed: an installer-owned agent without native-snapshot is listed as not included; one whose snapshot fails, or that does not run, still stops the backup.\n'

# ---- A native preparation that fails before its session record aborts; after it, it holds. ----
export FIXTURE_CLI=snapshot FIXTURE_STORAGE="$temporary/storage-abort"
fixture abort-before upgrade
if run native-backup-begin upgrade "$magnus"; then fail 'A failing native snapshot passed native preparation'; fi
jq -nc --arg directory "$directory" --arg plan "$plan" '{directory:$directory,installation:"example",host:"control",plan:$plan,operation:"upgrade",action:"abort",abortStep:"native-backup-begin",version:"0.1.0",archive:"fixture",placements:{magnus:{}},agents:[],inference:[]}' |
  bash "$temporary/host-script.sh" > "$temporary/result" 2> "$temporary/error" || { cat "$temporary/error" >&2; fail 'A pre-reservation native failure could not abort'; }
[[ $(jq -r .phase "$directory/transaction.json") == aborted && -f "$directory/aborted-transaction.$plan.json" ]] || fail 'The transaction was not closed as aborted'
! grep -q ' stop' "$FIXTURE_DOCKER" || fail 'Aborting stopped the suite'
fixture abort-after upgrade
session=$(cd "$temporary" && bash -c 'installation=example host=control plan=$1 archive=fixture input="{\"operation\":\"upgrade\"}"; source "$2"; source "$3"; native_backup_context; printf "%s" "$NATIVE_BACKUP_SESSION"' _ "$plan" "$ROOT/scripts/suite/native-backup-host.sh" "$temporary/installer-stubs.sh")
mkdir -p "$session"; printf '{"phase":"reserved"}\n' > "$session/coordinator.json"
if jq -nc --arg directory "$directory" --arg plan "$plan" '{directory:$directory,installation:"example",host:"control",plan:$plan,operation:"upgrade",action:"abort",abortStep:"native-backup-begin",version:"0.1.0",archive:"fixture",placements:{magnus:{}},agents:[],inference:[]}' |
  bash "$temporary/host-script.sh" > "$temporary/result" 2> "$temporary/error"; then fail 'A reserved native session was aborted'; fi
grep -q 'reserved its session; it needs recovery' "$temporary/error" && [[ $(jq -r .phase "$directory/transaction.json") == prepared ]] || fail 'A reserved native session did not stay open for recovery'
# The controller: abort when the first host fails before reserving, hold otherwise.
lifecycle_begin() { # FAILING_HOST ABORT_RESULT
  (
    source "$ROOT/scripts/suite/controller.sh"; source "$ROOT/scripts/suite/lifecycle.sh"
    HIVE_CONFIG=$temporary/two-hosts.json
    hive_action() {
      printf '%s %s\n' "$1" "$2" >> "$temporary/actions"
      case "$2" in
        native-backup-begin) [[ "$1" != "$FAILING" ]];;
        abort) [[ "$ABORTS" == true ]];;
        hold) return 0;;
      esac
    }
    FAILING=$1 ABORTS=$2 hive_native_begin_all
  ) > "$temporary/lifecycle.log" 2>&1
}
printf '{"hosts":{"a":{},"b":{}},"components":{},"agents":[],"inference":[]}\n' > "$temporary/two-hosts.json"
: > "$temporary/actions"; if lifecycle_begin a true; then fail 'A failed native preparation passed'; fi
[[ $(cat "$temporary/actions") == $'a native-backup-begin\na abort\nb abort' ]] || { cat "$temporary/actions" >&2; fail 'A pre-reservation failure did not abort every host'; }
grep -q 'closed as aborted and the suite keeps serving' "$temporary/lifecycle.log" || fail 'The abort was not explained'
: > "$temporary/actions"; if lifecycle_begin a false; then fail 'A reserved failure passed'; fi
grep -q 'a hold' "$temporary/actions" && grep -q 'b hold' "$temporary/actions" || { cat "$temporary/actions" >&2; fail 'A post-reservation failure did not hold the suite'; }
: > "$temporary/actions"; if lifecycle_begin b true; then fail 'A second-host failure passed'; fi
! grep -q abort "$temporary/actions" && grep -q 'a hold' "$temporary/actions" || { cat "$temporary/actions" >&2; fail 'A failure after another host reserved did not hold'; }
printf 'Passed: native preparation that fails before reserving aborts and keeps the suite serving; after a reservation, or on a later host, it holds.\n'
