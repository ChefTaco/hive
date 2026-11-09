#!/usr/bin/env bash
set -Eeuo pipefail
ROOT=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)
source "$ROOT/scripts/suite/controller.sh"
source "$ROOT/scripts/suite/magnus-agent.sh"
temporary=$(mktemp -d); trap 'rm -rf -- "$temporary"' EXIT
fail() { printf 'FAIL: %s\n' "$*" >&2; exit 1; }
mkdir -p "$temporary/bin" "$temporary/scripts/suite"
printf '%s\n' 'obviously-fake-sudo-password' > "$temporary/password"; chmod 600 "$temporary/password"
export HIVE_SUDO_FIXTURE=$temporary
cat > "$temporary/bin/sudo" <<'SUDO'
#!/usr/bin/env bash
set -Eeuo pipefail
printf '%s\n' "$*" >> "$HIVE_SUDO_FIXTURE/arguments"
[[ "$1 $2 $3" == '-k -S -p' && "$4" == '' ]]
IFS= read -r supplied
[[ "$supplied" == obviously-fake-sudo-password ]]
shift 4
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
