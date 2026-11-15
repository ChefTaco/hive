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
  *LoadState*) printf 'loaded\n';;
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
