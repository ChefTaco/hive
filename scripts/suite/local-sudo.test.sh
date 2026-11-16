#!/usr/bin/env bash
set -Eeuo pipefail
ROOT=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)
source "$ROOT/scripts/suite/controller.sh"
source "$ROOT/scripts/suite/magnus-agent.sh"
source "$ROOT/scripts/suite/lifecycle.sh"
temporary=$(mktemp -d); trap 'rm -rf -- "$temporary"' EXIT
fail() { printf 'FAIL: %s\n' "$*" >&2; exit 1; }
mkdir -p "$temporary/bin" "$temporary/scripts/suite"
printf '%s' 'obviously-fake-sudo-password' > "$temporary/password"; chmod 600 "$temporary/password"
export HIVE_SUDO_FIXTURE=$temporary
cat > "$temporary/bin/sudo" <<'SUDO'
#!/usr/bin/env bash
set -Eeuo pipefail
printf '%s\n' "$*" >> "$HIVE_SUDO_FIXTURE/arguments"
case "$1" in
  -v) [[ ${FIXTURE_SUDO_REFUSE:-false} != true ]]; exit $?;;
  -n) shift;;
  -k)
    [[ "$1 $2 $3" == '-k -S -p' && "$4" == '' ]]
    IFS= read -r supplied
    [[ "$supplied" == obviously-fake-sudo-password ]]
    shift 4;;
  *) exit 1;;
esac
export FIXTURE_ROOT_TRANSPORT=true
exec "$@"
SUDO
chmod +x "$temporary/bin/sudo"
cat > "$temporary/scripts/suite/magnus-agent-host.sh" <<'HOST'
read -r packet
jq -e '.magnusAgent.probe==true' <<< "$packet" >/dev/null
printf 'ROOT_ACTION_OK\n'
HOST
printf 'export {};\n' > "$temporary/scripts/suite/check-data.mjs"
export PATH="$temporary/bin:$PATH"
HIVE_ROOT=$temporary HIVE_CONFIG=$temporary/config.json HIVE_VERSION=0.1.0 HIVE_ID=example-suite
HIVE_AGENT_HOST=control HIVE_AGENT_SUDO_FILE=$temporary/password
jq -nc '{origin:"https://hive.example.com",hosts:{control:{target:"local",directory:"/opt/example"}},components:{},agents:[],inference:[]}' > "$HIVE_CONFIG"
HIVE_HOST_LOCAL_SUDO=true hive_magnus_agent_action control fixture '{"probe":true}' true > "$temporary/result"
grep -qx ROOT_ACTION_OK "$temporary/result" || fail 'The explicit file did not reach the local root action'
! grep -q obviously-fake-sudo-password "$temporary/arguments" || fail 'Sudo password entered command arguments'
HIVE_AGENT_SUDO_FILE=''
printf '\n' >> "$temporary/password"
jq --arg file "$temporary/password" '.hosts.control.sudoPasswordFile=$file' "$HIVE_CONFIG" > "$temporary/next.json"; mv "$temporary/next.json" "$HIVE_CONFIG"
HIVE_HOST_LOCAL_SUDO=true hive_magnus_agent_action control fixture '{"probe":true}' true > "$temporary/result"
grep -qx ROOT_ACTION_OK "$temporary/result" || fail 'The configured host file was ignored'
chmod 644 "$temporary/password"
if ( HIVE_HOST_LOCAL_SUDO=true hive_magnus_agent_action control fixture '{"probe":true}' true ) > "$temporary/refused" 2>&1; then fail 'An exposed password file was accepted'; fi
grep -q owner-only "$temporary/refused" || fail 'The permission refusal was unclear'
! grep -q obviously-fake-sudo-password "$temporary/refused" || fail 'A refusal printed the password'
# Enrollment's nested pinned runtime repair must carry the same protected file option.
cat > "$temporary/hive.sh" <<'CHILD'
[[ "$HIVE_FULL_NODE_ENROLLMENT" == true ]]
printf '%s\n' "$@" > "$HIVE_SUDO_FIXTURE/nested-arguments"
CHILD
HIVE_AGENT_SUDO_FILE=$temporary/password
HIVE_MANIFEST=$temporary/manifest HIVE_SIGNATURE=$temporary/signature HIVE_TRUST_KEY=$temporary/trust
hive_magnus_agent_enrollment_runtime
grep -qx -- --sudo-password-file "$temporary/nested-arguments" || fail 'Nested runtime repair dropped the credential file option'
grep -qx -- "$temporary/password" "$temporary/nested-arguments" || fail 'Nested runtime repair changed the file path'
! grep -q obviously-fake-sudo-password "$temporary/nested-arguments" || fail 'Nested repair put a password in arguments'
printf 'Passed: local agent sudo accepts explicit and configured protected files on stdin, preserves its JSON payload, and refuses exposed credentials.\n'

# Exercise lifecycle dispatch and the real transport, without invoking a privileged
# product or Docker. Only the host/product boundary is replaced. The actual native
# guard must see root; an ordinary operator cannot silently omit native custody.
for file in ownership-host.sh public-runtime.sh integrity-host.sh input-artifacts-host.sh native-initialization-host.sh adapters-host.sh restore-recovery-host.sh inference-registration.sh initialize-migrations-host.sh rehearsal-copy-host.sh snapshot-host.sh; do
  : > "$temporary/scripts/suite/$file"
done
cp "$ROOT/scripts/suite/native-backup-host.sh" "$temporary/scripts/suite/native-backup-host.sh"
printf 'export {};\n' > "$temporary/scripts/suite/native-backup-coordinator.mjs"
printf 'export {};\n' > "$temporary/scripts/suite/snapshot-data.mjs"
cat > "$temporary/bin/id" <<'ID'
#!/usr/bin/env bash
if [[ "$*" == '-u' ]]; then
  if [[ ${FIXTURE_ROOT_TRANSPORT:-false} == true ]]; then printf '0\n'; else printf '1000\n'; fi
else exec /usr/bin/id "$@"; fi
ID
cat > "$temporary/bin/stat" <<'STAT'
#!/usr/bin/env bash
# Simulate the operator's ownership for the protected fixture credential, so the
# transport regression also runs when the test harness itself is root.
if [[ "$*" == "-c %u $HIVE_SUDO_FIXTURE/password" ]]; then printf '1000\n'; else exec /usr/bin/stat "$@"; fi
STAT
cat > "$temporary/bin/ssh" <<'SSH'
#!/usr/bin/env bash
set -Eeuo pipefail
printf '%s\n' "$*" >> "$HIVE_SUDO_FIXTURE/ssh-arguments"
exec bash -c "${@: -1}"
SSH
chmod +x "$temporary/bin/id" "$temporary/bin/stat" "$temporary/bin/ssh"
cat > "$temporary/scripts/suite/host-runtime.sh" <<'HOST'
set -Eeuo pipefail
IFS= read -r packet
action=$(jq -r .action <<< "$packet")
case "$action" in
  snapshot|native-backup-begin|backup|rehearse|restore-check|restore-preview-check|restore-preview|restore|resume-current|complete|abort|native-backup-recover|restore-recovery-*)
    native_backup_guard;;
esac
printf '%s:%s\n' "$action" "$(id -u)" >> "$HIVE_SUDO_FIXTURE/lifecycle-actions"
HOST
hive_registry_preflight() { :; }
hive_registry_provision() { :; }
hive_doctor() { :; }
hive_stage() { hive_action control prepare; }
HIVE_AGENT_SUDO_FILE='' HIVE_HOST_SUDO_FILE='' HIVE_HOST_LOCAL_SUDO=false
HIVE_PLAN_DIGEST=fixture
chmod 600 "$temporary/password"
HIVE_MANIFEST="$temporary/manifest.json" HIVE_ARCHIVE=fixture HIVE_RECONCILIATION="$temporary/approval.json"
HIVE_PREPARE_RECONCILIATION=false HIVE_ALLOW_MIGRATIONS=false HIVE_RELAX_AUTH_LIMITS=false
printf '{}\n' > "$HIVE_MANIFEST"
printf '{}\n' > "$HIVE_RECONCILIATION"
config() {
  jq -nc --arg target "$1" --arg password "${2:-}" --arg directory "$temporary" \
    '{origin:"https://hive.example.com",hosts:{control:({target:$target,directory:$directory}+(if $password=="" then {} else {sudoPasswordFile:$password} end))},components:{magnus:{host:"control"}},agents:[],inference:[]}' > "$HIVE_CONFIG"
}
config local
for scenario in backup stopped-backup password-backup rehearse restore restore-preview; do
  operation=$scenario
  HIVE_BACKUP_STOPPED=false HIVE_PREPARE_RECONCILIATION=false
  config local
  case "$scenario" in
    stopped-backup) operation=backup; HIVE_BACKUP_STOPPED=true;;
    password-backup) operation=backup; config local "$temporary/password";;
    restore-preview) operation=restore; HIVE_PREPARE_RECONCILIATION=true;;
  esac
  : > "$temporary/arguments"; : > "$temporary/lifecycle-actions"
  ( HIVE_OPERATION=$operation hive_lifecycle "$operation" ) > "$temporary/result" 2>&1 || { cat "$temporary/result" >&2; fail "Local $scenario did not obtain root transport"; }
  if [[ "$scenario" == password-backup ]]; then
    grep -q '^-k -S -p ' "$temporary/arguments" || fail 'Configured lifecycle sudo password was ignored'
  else
    grep -qx -- '-v' "$temporary/arguments" || fail "Local $scenario did not request ordinary sudo authorization"
    grep -qx -- '-n bash -c set -euo pipefail' "$temporary/arguments" || fail "Local $scenario did not use the cached stdin transport"
  fi
  grep -Eq '^(snapshot|backup|rehearse|restore|restore-preview):0$' "$temporary/lifecycle-actions" || fail "Local $scenario did not reach its native boundary as root"
  [[ "$HIVE_HOST_LOCAL_SUDO" == false ]] || fail 'Lifecycle sudo leaked into other commands'
done
HIVE_BACKUP_STOPPED=false HIVE_PREPARE_RECONCILIATION=false
config local
: > "$temporary/arguments"; : > "$temporary/lifecycle-actions"
if ( FIXTURE_SUDO_REFUSE=true HIVE_OPERATION=backup hive_lifecycle backup ) > "$temporary/refused" 2>&1; then fail 'Backup continued after sudo authorization was refused'; fi
! grep -q '^snapshot:' "$temporary/lifecycle-actions" || fail 'Native capture ran after refused sudo'
grep -q 'needs root through sudo' "$temporary/refused" || fail 'Sudo refusal did not explain its cause'

# Scope stays narrow: unrelated action/operation/host and already-root calls do
# not gain a new sudo request. Remote sudo remains explicitly configured.
for mode in unrelated-action unrelated-operation no-magnus already-root remote-plain remote-password; do
  config local; action=prepare; operation=backup; refusal=false
  case "$mode" in
    unrelated-operation) operation=install; action=snapshot; refusal=true;;
    no-magnus) jq '.components={}' "$HIVE_CONFIG" > "$temporary/next.json"; mv "$temporary/next.json" "$HIVE_CONFIG"; action=snapshot; refusal=true;;
    already-root) export FIXTURE_ROOT_TRANSPORT=true; action=snapshot;;
    remote-plain) config deploy@node.example.com; action=snapshot; refusal=true;;
    remote-password) config deploy@node.example.com "$temporary/password"; action=snapshot;;
  esac
  : > "$temporary/arguments"; : > "$temporary/lifecycle-actions"
  if ( HIVE_OPERATION=$operation hive_action control "$action" ) > "$temporary/result" 2>&1; then
    [[ "$refusal" != true ]] || fail "Unprivileged native guard unexpectedly passed: $mode"
  else
    [[ "$refusal" == true ]] || fail "Transport scope failed: $mode"
    grep -q 'Root transport is required' "$temporary/result" || fail "Unexpected transport refusal: $mode"
  fi
  unset FIXTURE_ROOT_TRANSPORT
  if [[ "$mode" == remote-password ]]; then
    grep -q '^-k -S -p ' "$temporary/arguments" || fail 'Remote configured sudo was dropped'
    grep -qx 'snapshot:0' "$temporary/lifecycle-actions" || fail 'Remote native action lost root transport'
  else
    [[ ! -s "$temporary/arguments" ]] || fail "Unrelated transport unexpectedly invoked sudo: $mode"
  fi
done
! grep -q obviously-fake-sudo-password "$temporary/arguments" "$temporary/ssh-arguments" || fail 'Lifecycle exposed its sudo password in argv'
printf 'Passed: local native backup, rehearsal and restore request ordinary sudo, refuse denied authorization and preserve scoped local/remote privilege boundaries.\n'
