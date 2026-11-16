#!/usr/bin/env bash
# Exercise the real credential-generation host branch and environment codec.
# Only privilege, publication commit and container restart boundaries are fixtures.
set -Eeuo pipefail
umask 077
ROOT=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)
temporary=$(mktemp -d)
trap 'rm -rf -- "$temporary"' EXIT
fail() { printf 'FAIL: %s\n' "$*" >&2; exit 1; }
export ADMIN_ACCESS_TEST_ROOT=$ROOT ADMIN_ACCESS_TEST_TEMP=$temporary
export ADMIN_ACCESS_HOST_SOURCE=${ADMIN_ACCESS_HOST_SOURCE:-$ROOT/scripts/suite/admin-access-host.sh}
export ADMIN_ACCESS_REAL_JQ
ADMIN_ACCESS_REAL_JQ=$(command -v jq)
export ADMIN_ACCESS_MEMORY_FIXTURE ADMIN_ACCESS_CHAT_FIXTURE
ADMIN_ACCESS_MEMORY_FIXTURE=$(printf 'a%.0s' {1..64})
ADMIN_ACCESS_CHAT_FIXTURE=$(printf 'b%.0s' {1..64})
mkdir "$temporary/bin"

# Inspect every actual jq/docker argv, including a serialized update map. This
# deterministically detects the leak without racing short-lived /proc entries.
cat > "$temporary/bin/jq" <<'JQ'
#!/usr/bin/env bash
set -Eeuo pipefail
for argument in "$@"; do
  if [[ "$argument" == *"$ADMIN_ACCESS_MEMORY_FIXTURE"* || "$argument" == *"$ADMIN_ACCESS_CHAT_FIXTURE"* ]]; then
    printf 'Credential entered external process arguments\n' >&2; exit 97
  fi
done
printf 'jq\n' >> "$ADMIN_ACCESS_CASE/observed-execs"
exec "$ADMIN_ACCESS_REAL_JQ" "$@"
JQ
cat > "$temporary/bin/openssl" <<'OPENSSL'
#!/usr/bin/env bash
set -Eeuo pipefail
[[ "$*" == 'rand -hex 32' ]]
count=0; [[ ! -f "$ADMIN_ACCESS_CASE/generated" ]] || count=$(cat "$ADMIN_ACCESS_CASE/generated")
count=$((count+1)); printf '%s\n' "$count" > "$ADMIN_ACCESS_CASE/generated"
case $count in
  1) printf '%s\n' "$ADMIN_ACCESS_MEMORY_FIXTURE";;
  2) printf '%s\n' "$ADMIN_ACCESS_CHAT_FIXTURE";;
  *) printf 'Unexpected credential rotation\n' >&2; exit 1;;
esac
OPENSSL
cat > "$temporary/bin/docker" <<'DOCKER'
#!/usr/bin/env bash
set -Eeuo pipefail
for argument in "$@"; do
  [[ "$argument" != *"$ADMIN_ACCESS_MEMORY_FIXTURE"* && "$argument" != *"$ADMIN_ACCESS_CHAT_FIXTURE"* ]] || { printf 'Credential entered Docker arguments\n' >&2; exit 97; }
done
printf 'docker\n' >> "$ADMIN_ACCESS_CASE/observed-execs"
if [[ "$1" == inspect ]]; then printf 'healthy\n'; exit 0; fi
[[ "$1" == compose && "$2" == -f ]]; shift 3
case "$1" in
  up) printf '%s\n' "${@: -1}" >> "$ADMIN_ACCESS_CASE/restarts";;
  ps) printf 'fixture-%s\n' "${@: -1}";;
  *) exit 1;;
esac
DOCKER
chmod 700 "$temporary/bin/"*
export PATH="$temporary/bin:$PATH"
cat > "$temporary/host.sh" <<'HOST'
set -Eeuo pipefail
source "$ADMIN_ACCESS_TEST_ROOT/scripts/suite/admin-access-files-host.sh"
restore_installation_owner() { :; }
# Ordinary CI cannot create root-owned records. Model only that boundary; paths,
# mode checks, creation, locks, bytes and the production host branch remain real.
id() { if [[ "$*" == -u ]]; then printf '0\n'; else command id "$@"; fi; }
stat() {
  case "$*" in
    '-c %u:%a '*|'-c %u:%a:%h '*)
      local result; result=$(command stat "$@")
      printf '0:%s\n' "${result#*:}";;
    *) command stat "$@";;
  esac
}
install() {
  local -a arguments=()
  while (($#)); do
    case "$1" in -o|-g) shift 2;; *) arguments+=("$1"); shift;; esac
  done
  command install "${arguments[@]}"
}
admin_access_publish() (
  local updates=$1 path keys rendered
  printf '%s\n' "$updates" > "$ADMIN_ACCESS_CASE/last-publication.json"
  [[ ! -f "$ADMIN_ACCESS_CASE/fail-publication" ]] || return 1
  while IFS= read -r path; do
    keys=$(mktemp "$ADMIN_ACCESS_CASE/keys.XXXXXX")
    jq --arg path "$path" '.[$path]' <<< "$updates" > "$keys"
    rendered=$(mktemp "$ADMIN_ACCESS_CASE/rendered.XXXXXX")
    admin_access_files_render "$path" "$keys" > "$rendered"
    mv -T -- "$rendered" "$path"; rm -- "$keys"
  done < <(jq -r 'keys[]' <<< "$updates")
)
source "$ADMIN_ACCESS_HOST_SOURCE"
HOST

fixture() {
  export ADMIN_ACCESS_CASE="$temporary/$1"
  mkdir -p "$ADMIN_ACCESS_CASE/config/chattermost"
  printf '{"schema":1,"phase":"complete"}\n' > "$ADMIN_ACCESS_CASE/transaction.json"
  printf '{"installation":"fixture","uuid":"fixture-installation"}\n' > "$ADMIN_ACCESS_CASE/installation.json"
  printf '{"services":{"hivemem":{"image":"example.com/memory:1"},"chattermost":{"image":"example.com/chat:1"}}}\n' > "$ADMIN_ACCESS_CASE/compose.json"
  for path in config/hivemem.env config/chattermost.env config/chattermost/runtime.env; do
    printf '# retained fixture comment\nUNCHANGED=fixture-value\n' > "$ADMIN_ACCESS_CASE/$path"
  done
  jq -nc --arg directory "$ADMIN_ACCESS_CASE" '{directory:$directory,origin:"https://hive.example.com",installation:"fixture",host:"control",placements:{hivemem:{},chattermost:{}},adminAccess:{mode:"secrets",identity:{issuer:"https://hive.example.com/api/oathweave",subject:"fixture-human"},state:{schema:1,installation:"fixture",identity:{issuer:"https://hive.example.com/api/oathweave",subject:"fixture-human"},hostIdentities:{control:"fixture-installation"},operationId:"11111111-2222-4333-8444-555555555555",localIds:{hivemem:"fixture-memory",chattermost:"fixture-chat"}},expectedImages:{hivemem:"example.com/memory:1",chattermost:"example.com/chat:1"}}}' > "$ADMIN_ACCESS_CASE/input.json"
}
run_host() { bash "$temporary/host.sh" < "$ADMIN_ACCESS_CASE/input.json" > "$ADMIN_ACCESS_CASE/result.json" 2> "$ADMIN_ACCESS_CASE/error.log"; }
verify_credentials() {
  local path expected found
  for path in config/hivemem.env config/chattermost.env config/chattermost/runtime.env; do
    expected=$ADMIN_ACCESS_CHAT_FIXTURE; [[ "$path" != config/hivemem.env ]] || expected=$ADMIN_ACCESS_MEMORY_FIXTURE
    found=$(admin_access_env_value "$ADMIN_ACCESS_CASE/$path" HIVE_ADMIN_PROVISIONING_SECRET)
    [[ "$found" == "$expected" ]] || fail 'Published credential bytes changed'
    [[ $(stat -c %a "$ADMIN_ACCESS_CASE/$path") == 600 ]] || fail 'Published environment is not private'
    grep -qx '# retained fixture comment' "$ADMIN_ACCESS_CASE/$path" && grep -qx 'UNCHANGED=fixture-value' "$ADMIN_ACCESS_CASE/$path" || fail 'Unselected bytes changed'
  done
  jq -e '.purposeCredentialsReady==true' "$ADMIN_ACCESS_CASE/result.json" >/dev/null || fail 'Host did not report readiness'
}
source "$ROOT/scripts/suite/admin-access-files-host.sh"
fixture first
run_host || { cat "$ADMIN_ACCESS_CASE/error.log" >&2; fail 'First credential creation failed'; }
verify_credentials
[[ $(cat "$ADMIN_ACCESS_CASE/generated") == 2 && $(wc -l < "$ADMIN_ACCESS_CASE/restarts") == 2 ]] || fail 'First setup did not create/restart exactly both owners'
grep -qx jq "$ADMIN_ACCESS_CASE/observed-execs" && grep -qx docker "$ADMIN_ACCESS_CASE/observed-execs" || fail 'Argument observers were not exercised'
before=$(sha256sum "$ADMIN_ACCESS_CASE/config/"*.env "$ADMIN_ACCESS_CASE/config/chattermost/runtime.env")
run_host || fail 'Idempotent setup failed'
verify_credentials
[[ "$before" == "$(sha256sum "$ADMIN_ACCESS_CASE/config/"*.env "$ADMIN_ACCESS_CASE/config/chattermost/runtime.env")" && $(cat "$ADMIN_ACCESS_CASE/generated") == 2 && $(wc -l < "$ADMIN_ACCESS_CASE/restarts") == 2 ]] || fail 'Retry rotated credentials, rewrote environments or repeated recreation'

fixture interrupted
touch "$ADMIN_ACCESS_CASE/fail-publication"
if run_host; then fail 'Simulated pre-publication interruption succeeded'; fi
[[ $(cat "$ADMIN_ACCESS_CASE/generated") == 2 && ! -e "$ADMIN_ACCESS_CASE/restarts" ]] || fail 'Interruption failed at the wrong boundary'
for path in "$ADMIN_ACCESS_CASE/config/"*.env; do ! grep -q HIVE_ADMIN_PROVISIONING_SECRET "$path" || fail 'Interrupted publication changed an environment'; done
# Match Bash command substitution's handling of either zero or multiple trailing
# newlines in an already retained credential; neither can change its actual value.
while IFS= read -r path; do
  case "$path" in
    */hivemem-provisioning-secret) printf '%s' "$ADMIN_ACCESS_MEMORY_FIXTURE" > "$path";;
    */chattermost-provisioning-secret) printf '\n\n' >> "$path";;
  esac
done < <(find "$ADMIN_ACCESS_CASE/config/.admin-access" -name '*-provisioning-secret' -type f)
rm -- "$ADMIN_ACCESS_CASE/fail-publication"
run_host || fail 'Retained credential recovery failed'
verify_credentials
[[ $(cat "$ADMIN_ACCESS_CASE/generated") == 2 && $(wc -l < "$ADMIN_ACCESS_CASE/restarts") == 2 ]] || fail 'Recovery regenerated credentials or skipped an owner'

fixture existing
printf 'HIVE_ADMIN_PROVISIONING_SECRET=%s\n' "$ADMIN_ACCESS_MEMORY_FIXTURE" >> "$ADMIN_ACCESS_CASE/config/hivemem.env"
for path in config/chattermost.env config/chattermost/runtime.env; do printf 'HIVE_ADMIN_PROVISIONING_SECRET=%s\n' "$ADMIN_ACCESS_CHAT_FIXTURE" >> "$ADMIN_ACCESS_CASE/$path"; done
run_host || fail 'Existing credential reuse failed'
verify_credentials
[[ ! -e "$ADMIN_ACCESS_CASE/generated" && ! -e "$ADMIN_ACCESS_CASE/restarts" ]] || fail 'Existing credentials were regenerated or restarted'
printf 'Passed: actual administrator host credential creation, interrupted recovery and existing-credential reuse keep exact private bytes and never expose secrets in jq/Docker argv.\n'
