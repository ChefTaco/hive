#!/usr/bin/env bash
set -Eeuo pipefail
umask 077
ROOT=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)
source "$ROOT/scripts/suite/controller.sh"
temporary=$(mktemp -d)
trap 'rm -rf -- "$temporary"' EXIT
fail() { printf 'FAIL: %s\n' "$*" >&2; exit 1; }
export HOST_TRANSPORT_FIXTURE="$temporary"
mkdir -p "$temporary/bin" "$temporary/scripts/suite"
cat > "$temporary/bin/sudo" <<'SUDO'
#!/usr/bin/env bash
set -Eeuo pipefail
printf '%s\n' "$@" >> "$HOST_TRANSPORT_FIXTURE/arguments"
case $1 in
  -v) exit 0;;
  -n) shift;;
  -k)
    [[ "$1 $2 $3" == '-k -S -p' && "$4" == '' ]]
    IFS= read -r password
    [[ "$password" == obviously-fake-sudo-password ]]
    shift 4;;
  *) exit 1;;
esac
exec "$@"
SUDO
cat > "$temporary/bin/ssh" <<'SSH'
#!/usr/bin/env bash
set -Eeuo pipefail
printf '%s\n' "$@" >> "$HOST_TRANSPORT_FIXTURE/arguments"
if [[ ${CORRUPT_HOST_FRAME:-false} == true ]]; then
  { IFS= read -r discarded; printf '*invalid-base64*\n'; cat; } | bash -c "${@: -1}"
else exec bash -c "${@: -1}"; fi
SSH
chmod 700 "$temporary/bin/ssh" "$temporary/bin/sudo"
export PATH="$temporary/bin:$PATH"
printf 'obviously-fake-sudo-password\n' > "$temporary/password"
printf '{"token":"obviously-fake-token"}\n' > "$temporary/secret.json"
printf 'export {};\n' > "$temporary/scripts/suite/check-data.mjs"
HIVE_ROOT=$temporary HIVE_CONFIG=$temporary/config.json HIVE_VERSION=0.1.0 HIVE_ID=example-suite
HIVE_HOST_SECRET_FILE=$temporary/secret.json
script=$(printf '# HOST_CODE_MUST_STAY_ON_STDIN\n#'; head -c 524288 /dev/zero | tr '\0' x; printf '\nIFS= read -r packet\njq -e '\''.secret.token=="obviously-fake-token" and .installation=="example-suite"'\'' <<< "$packet" >/dev/null\nprintf "LARGE_HOST_OK\\n"\n')
for mode in local local-password local-cached remote remote-password; do
  target=local; password=''; HIVE_HOST_LOCAL_SUDO=false
  case $mode in
    local-password) HIVE_HOST_LOCAL_SUDO=true; password=$temporary/password;;
    local-cached) HIVE_HOST_LOCAL_SUDO=true;;
    remote) target=deploy@node.example.com;;
    remote-password) target=deploy@node.example.com; password=$temporary/password;;
  esac
  jq -nc --arg target "$target" --arg password "$password" '{origin:"https://hive.example.com",hosts:{control:({target:$target,directory:"/opt/example"}+(if $password=="" then {} else {sudoPasswordFile:$password} end))},components:{},agents:[],inference:[]}' > "$HIVE_CONFIG"
  hive_host control "$script" > "$temporary/result" || fail "Large program failed: $mode"
  grep -qx LARGE_HOST_OK "$temporary/result" || fail "JSON input was lost: $mode"
done
! grep -Eq 'HOST_CODE_MUST_STAY_ON_STDIN|obviously-fake-(sudo-password|token)' "$temporary/arguments" || fail 'Program or secret appeared in process arguments'
[[ $(wc -L < "$temporary/arguments") -lt 4096 ]] || fail 'Transport still places a large value in argv'
# A refused password file stops the action in a conditional context too, where errexit is off:
# it must never continue as the SSH account without sudo.
jq --arg password "$temporary/password" '.hosts.control.sudoPasswordFile=$password' "$HIVE_CONFIG" > "$temporary/exposed.json"; mv "$temporary/exposed.json" "$HIVE_CONFIG"
chmod 644 "$temporary/password"
if ( hive_host control "$script" ) > "$temporary/refused" 2>&1; then fail 'An exposed sudo password file was accepted'; fi
grep -q owner-only "$temporary/refused" || fail 'The password file refusal was unclear'
! grep -q LARGE_HOST_OK "$temporary/refused" || fail 'The host program ran without sudo after its password file was refused'
printf 'payload\n' > "$temporary/payload"
if ( hive_transfer control "$temporary/payload" payload ) > "$temporary/refused" 2>&1; then fail 'A transfer continued after its password file was refused'; fi
chmod 600 "$temporary/password"
export CORRUPT_HOST_FRAME=true
jq 'del(.hosts.control.sudoPasswordFile)' "$HIVE_CONFIG" > "$temporary/plain.json"; mv "$temporary/plain.json" "$HIVE_CONFIG"
if hive_host control "$script" > "$temporary/corruption" 2>&1; then fail 'Corrupt transport frame was accepted'; fi
! grep -q LARGE_HOST_OK "$temporary/corruption" || fail 'Corrupt program executed'
printf 'Passed: large host programs and JSON stream through local/SSH and protected/cached sudo without argv exposure; corrupted frames fail closed.\n'
