#!/usr/bin/env bash
# Controller orchestration only: fake owning API, private receipts, no host changes.
set -Eeuo pipefail
umask 077
ROOT=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)
temporary=$(mktemp -d)
trap 'rm -rf -- "$temporary"' EXIT
fail() { printf 'FAIL: %s\n' "$*" >&2; exit 1; }
cat > "$temporary/fixture.sh" <<'FIXTURE'
#!/usr/bin/env bash
set -Eeuo pipefail
source "$TEST_ROOT/scripts/suite/magnus-agent.sh"
source "$TEST_ROOT/scripts/suite/ardent-setup.sh"
HIVE_CONFIG=$TEST_CASE/installation.json
HIVE_ROOT=$TEST_ROOT HIVE_CONFIRMED=${TEST_CONFIRMED:-true}
HIVE_ARDENT_PROFILE=${TEST_PROFILE:-assistant}
model_url_default='' model_default=''
if [[ ${1:-setup} == setup ]]; then model_url_default=https://models.example.com/v1; model_default=fixture-model; fi
HIVE_ARDENT_MODEL_URL=${TEST_URL-$model_url_default}
HIVE_ARDENT_MODEL=${TEST_MODEL-$model_default}
HIVE_ARDENT_INTERACTIVE=${TEST_INTERACTIVE:-true}
hive_die() { printf '%s\n' "$*" >&2; exit 1; }
hive_magnus_agent_target() { HIVE_MAGNUS_HOST=control; }
hive_magnus_agent_node_record() { printf '{"id":"fixture-node","status":"ONLINE"}\n'; }
hive_magnus_agent_confirm() {
  printf 'confirm\n' >> "$TEST_CASE/confirm.calls"
  [[ ${TEST_DECLINE:-false} != true ]]
}
hive_prompt() { hive_die 'Unexpected prompt: fixture should provide model settings'; }
# Magnus's agent dependency report, read from its host: TEST_DEPENDENCIES, or no answer.
hive_magnus_ardent_dependencies() {
  printf 'dependencies\n' >> "$TEST_CASE/dependencies.calls"
  [[ -n ${TEST_DEPENDENCIES:-} ]] || { printf 'Magnus refused the agent dependencies: HTTP 500 INTERNAL\n' >&2; return 1; }
  printf '%s\n' "$TEST_DEPENDENCIES"
}
sleep() { :; }
sync() {
  local kind=file
  [[ ! -d ${2:-} ]] || kind=directory
  printf 'sync:%s\n' "$kind" >> "$TEST_CASE/durability.calls"
  [[ ${TEST_SYNC_FAILURE:-} != "$kind" ]] || return 1
  command sync "$@"
}
hive_ardent_api() {
  printf '%s %s\n' "$1" "${2:-}" >> "$TEST_CASE/api.calls"
  printf 'api:%s\n' "$1" >> "$TEST_CASE/durability.calls"
  local count=0 installed=false profiles='[]' owners='[]'
  [[ ! -e "$TEST_CASE/installed" ]] || installed=true
  [[ ! -e "$TEST_CASE/profile-exists" ]] || profiles='[{"id":"assistant"}]'
  [[ ${TEST_HELD:-false} != true ]] || owners='[{"commandId":"fixture-unknown","state":"unknown"}]'
  case "$1" in
    inspect) jq -nc --argjson installed "$installed" --argjson profiles "$profiles" --argjson owners "$owners" \
      '{reachable:true,installed:$installed,profiles:$profiles,commandOwners:$owners}';;
    plan)
      [[ ${TEST_PLAN_REFUSED:-false} != true ]] || return 1
      printf '{"requestSHA256":"%064d"}\n' 0;;
    package-install)
      [[ ${TEST_INSTALL_INTERRUPTED:-false} != true ]] || return 1
      touch "$TEST_CASE/installed"; printf '{"installed":true}\n';;
    create)
      [[ ${TEST_CREATE_INTERRUPTED:-false} != true ]] || return 1
      printf '{"operationId":"00000000-0000-4000-8000-000000000001","requestSHA256":"%064d"}\n' 0;;
    operation)
      [[ ${2:-} == 00000000-0000-4000-8000-000000000001 ]] || return 1
      [[ ${TEST_OPERATION_REFUSED:-false} != true ]] || return 1
      if [[ ${TEST_OPERATION_FAILED:-false} == true ]]; then printf '{"operationId":"%s","kind":"deploy","status":"failed","failedStep":"identity"}\n' "$2"; return; fi
      if [[ -n ${TEST_OPERATION_STATE:-} ]]; then
        jq -nc --arg id "${TEST_OPERATION_ID:-$2}" --arg kind "${TEST_OPERATION_KIND:-deploy}" --arg status "$TEST_OPERATION_STATE" '{operationId:$id,kind:$kind,status:$status}'
        return
      fi
      [[ ! -e "$TEST_CASE/polls" ]] || count=$(cat "$TEST_CASE/polls")
      count=$((count+1)); printf '%s\n' "$count" > "$TEST_CASE/polls"
      if ((count<2)); then printf '{"operationId":"%s","kind":"deploy","status":"running"}\n' "$2"; else touch "$TEST_CASE/profile-exists"; printf '{"operationId":"%s","kind":"deploy","status":"succeeded"}\n' "$2"; fi;;
    resume)
      [[ ${2:-} == 00000000-0000-4000-8000-000000000001 ]] || return 1
      printf '{"operationId":"%s"}\n' "$2";;
    check)
      [[ ${TEST_CHECK_INTERRUPTED:-false} != true ]] || return 1
      printf '{"ready":true,"profile":"assistant"}\n';;
    *) hive_die 'Unexpected API request';;
  esac
}
hive_ardent "$@"
FIXTURE
fixture() {
  case_directory=$temporary/$1
  mkdir -m 700 "$case_directory"
  printf '{"installation":"example-suite","origin":"https://console.example.com","hosts":{"control":{"directory":"/opt/example-suite"}},"console":{"host":"control"},"components":{"magnus":{"host":"control"},"hivemem":{"host":"control"},"oathweave":{"host":"control"}}}\n' > "$case_directory/installation.json"
}
run() { # EXPECTED_EXIT [ENV=VALUE ...] -- ARGS...
  local expected=$1; shift
  local -a settings=()
  while [[ ${1:-} != -- ]]; do settings+=("$1"); shift; done; shift
  local result=0
  # The standard output alone is in result.json; result holds both.
  timeout 10 env TEST_ROOT="$ROOT" TEST_CASE="$case_directory" "${settings[@]}" bash "$temporary/fixture.sh" "$@" > "$case_directory/result.json" 2> "$case_directory/result.err" || result=$?
  cat "$case_directory/result.json" "$case_directory/result.err" > "$case_directory/result"
  if [[ "$result" != "$expected" ]]; then cat "$case_directory/result" >&2; fail "Expected exit $expected, got $result"; fi
}
refused() { local pattern=$1; shift; run 1 "$@"; grep -qi -- "$pattern" "$case_directory/result" || { cat "$case_directory/result" >&2; fail "Missing refusal: $pattern"; }; }
sequence() { diff -u <(printf '%s\n' "$@") <(sed 's/ *$//' "$case_directory/api.calls") || fail 'Unexpected owning API sequence'; }
no_calls() { [[ ! -s "$case_directory/api.calls" ]] || fail 'Unsafe input reached the owning API'; }
receipt() { jq -er "$1" "$case_directory/ardent-setup/assistant.json"; }
operation=00000000-0000-4000-8000-000000000001
seed_receipt() {
  mkdir -m 700 "$case_directory/ardent-setup"
  jq -nc --arg phase "$1" --arg operation "$operation" \
    '{schema:1,installation:"example-suite",nodeId:"fixture-node",profile:"assistant",model:{base_url:"https://models.example.com/v1",model:"fixture-model"},requestSHA256:("0"*64),phase:$phase,operationId:$operation}' > "$case_directory/ardent-setup/assistant.json"
  touch "$case_directory/installed" "$case_directory/profile-exists"
}

fixture status-without-state
run 0 -- status
sequence inspect
[[ $(jq -r '.setup' "$case_directory/result.json") == null && ! -e "$case_directory/ardent-setup" ]] || fail 'Read-only status created local state'
# Status adds the agent dependencies Magnus resolved: in its JSON, and as a section for the operator.
[[ $(jq -c '.dependencies' "$case_directory/result.json") == null ]] || fail 'Status invented dependencies Magnus did not report'
grep -qx 'WARNING: Agent dependencies: Magnus did not answer.' "$case_directory/result.err" || fail 'Status did not report a Magnus that did not answer'
fixture status-dependencies
report='{"supported":true,"dependencies":[{"name":"hivemem","status":"usable","source":"registry","endpoint":"https://hivemem:18790","capabilities":["memory.v1"],"reason":null},{"name":"emberpath","status":"missing","source":"override","endpoint":"https://models.example.com:9443","capabilities":[],"reason":"Emberpath did not answer"}]}'
run 0 TEST_DEPENDENCIES="$report" -- status
sequence inspect
[[ $(jq -c '.dependencies' "$case_directory/result.json") == "$(jq -c . <<< "$report")" ]] || fail 'Status JSON lacks the dependency report'
diff -u <(printf '%s\n' 'Agent dependencies:' '  hivemem: usable (source: registry)' '  emberpath: missing (source: override) - Emberpath did not answer') "$case_directory/result.err" || fail 'Status printed the dependencies wrongly'
fixture status-dependencies-old-magnus
run 0 TEST_DEPENDENCIES='{"supported":false}' -- status
[[ $(jq -c '.dependencies' "$case_directory/result.json") == '{"supported":false}' ]] || fail 'Status JSON lost an unsupported report'
grep -qx '  Magnus is too old to report agent dependencies (needs 3.3.0)' "$case_directory/result.err" || fail 'Status did not name the Magnus version that reports dependencies'
fixture status-concurrent-lock
seed_receipt creating
exec {status_lock}> "$case_directory/ardent-setup/assistant.lock"
flock "$status_lock"
cp "$case_directory/ardent-setup/assistant.json" "$case_directory/receipt.before"
run 0 -- status
sequence inspect
cmp -s "$case_directory/receipt.before" "$case_directory/ardent-setup/assistant.json" || fail 'Concurrent status changed a receipt'
exec {status_lock}>&-

for boundary in file directory; do
  fixture "sync-failure-$boundary"
  refused 'could not be flushed' TEST_SYNC_FAILURE="$boundary" -- setup
  sequence inspect plan
  [[ ! -e "$case_directory/installed" && ! -e "$case_directory/profile-exists" ]] || fail 'A request ran before its intent was durable'
done

fixture first
run 0 -- setup
sequence inspect plan package-install create "operation $operation" "operation $operation" "operation $operation" check
[[ $(receipt .phase) == complete && $(receipt .operationId) == "$operation" ]] || fail 'Completed operation receipt was not retained'
[[ $(stat -c %a "$case_directory/ardent-setup") == 700 && $(stat -c %a "$case_directory/ardent-setup/assistant.json") == 600 && $(stat -c %a "$case_directory/ardent-setup/assistant.lock") == 600 ]] || fail 'Setup state is not private'
python3 - "$case_directory/durability.calls" <<'DURABILITY'
import pathlib, sys
calls = pathlib.Path(sys.argv[1]).read_text().splitlines()
for index, call in enumerate(calls):
    if call in ['api:package-install', 'api:create', 'api:check']:
        assert calls[index - 2:index] == ['sync:file', 'sync:directory'], calls
DURABILITY
cp "$case_directory/ardent-setup/assistant.json" "$case_directory/receipt.before"
: > "$case_directory/api.calls"
run 0 -- setup
sequence inspect
cmp -s "$case_directory/receipt.before" "$case_directory/ardent-setup/assistant.json" || fail 'Repeated setup changed its completed receipt'
run 0 -- status
[[ $(jq -r '.setup.phase' "$case_directory/result.json") == complete ]] || fail 'Status did not expose the retained receipt'

fixture already-installed
touch "$case_directory/installed"
run 0 -- setup
sequence inspect plan create "operation $operation" "operation $operation" "operation $operation" check

fixture unowned-profile
touch "$case_directory/profile-exists"
refused 'already exists' -- setup
sequence inspect
[[ ! -e "$case_directory/ardent-setup/assistant.json" ]] || fail 'Existing profile was adopted'

fixture held-owner
refused 'held by existing work' TEST_HELD=true -- setup
sequence inspect
[[ ! -e "$case_directory/ardent-setup/assistant.json" ]] || fail 'Held work created a setup plan'

fixture invalid-profile
refused 'profile ID' TEST_PROFILE='../escape' -- setup
no_calls
fixture invalid-model-url
refused 'model settings are invalid' TEST_URL='file:///etc/example' TEST_PLAN_REFUSED=true -- setup
sequence inspect plan
[[ ! -e "$case_directory/ardent-setup/assistant.json" ]] || fail 'Rejected model plan was persisted'
fixture missing-unattended-model
refused 'Supply --model-url' TEST_URL= TEST_MODEL= TEST_INTERACTIVE=false -- setup
sequence inspect
[[ ! -e "$case_directory/ardent-setup/assistant.json" ]] || fail 'Missing unattended settings created a plan'
for command in status check resume; do
  fixture "model-flags-$command"
  arguments=("$command"); [[ $command != resume ]] || arguments+=("$operation")
  refused 'Model settings apply only' TEST_URL=https://models.example.com/v1 -- "${arguments[@]}"
  no_calls
done
fixture noninteractive-no-consent
refused 'yes\|confirmation\|non-interactive\|unattended' TEST_INTERACTIVE=false TEST_CONFIRMED=false -- setup
sequence inspect plan
[[ ! -e "$case_directory/ardent-setup/assistant.json" && ! -e "$case_directory/confirm.calls" ]] || fail 'Unattended setup solicited consent or persisted work'

fixture noninteractive-no-consent-pty
python3 - "$case_directory" "$ROOT" "$temporary/fixture.sh" <<'PTY'
import json, pathlib, subprocess, sys
case, root, fixture = map(pathlib.Path, sys.argv[1:])
request = {'command': ['/usr/bin/env', 'TEST_ROOT=' + str(root), 'TEST_CASE=' + str(case),
                       'TEST_INTERACTIVE=false', 'TEST_CONFIRMED=false', '/bin/bash', str(fixture), 'setup'],
           'questions': [], 'transcriptFile': str(case / 'pty.transcript'), 'timeoutSeconds': 10}
p = case / 'pty.request.json'
p.write_text(json.dumps(request))
r = subprocess.run(['python3', str(root / 'scripts/suite/interactive-driver.py'), str(p)], capture_output=True, text=True)
assert r.returncode == 1, r.stderr + (case / 'pty.transcript').read_text()
PTY
sequence inspect plan
[[ ! -e "$case_directory/ardent-setup/assistant.json" && ! -e "$case_directory/confirm.calls" ]] || fail 'Unattended setup with a PTY bypassed explicit consent'

fixture declined
refused 'Cancelled' TEST_DECLINE=true TEST_CONFIRMED=false -- setup
sequence inspect plan
[[ ! -e "$case_directory/ardent-setup/assistant.json" ]] || fail 'Declined setup was persisted'

# A lost POST reply must remain a hold, even if the user retries the same command.
for boundary in INSTALL CREATE; do
  fixture "interrupted-${boundary,,}"
  refused 'receipt\|setup receipt' "TEST_${boundary}_INTERRUPTED=true" -- setup
  expected_phase=installing; [[ $boundary != CREATE ]] || expected_phase=creating
  [[ $(receipt .phase) == "$expected_phase" ]] || fail 'Ambiguous request phase was lost'
  cp "$case_directory/api.calls" "$case_directory/before.calls"
  refused 'interrupted around a request' -- setup
  diff -u <(cat "$case_directory/before.calls"; printf 'inspect \n') "$case_directory/api.calls" || fail 'An uncertain POST was repeated'
done

fixture interrupted-check
refused 'model check did not complete' TEST_CHECK_INTERRUPTED=true -- setup
[[ $(receipt .phase) == checking && $(receipt .operationId) == "$operation" ]] || fail 'Ambiguous inference outcome was lost'
cp "$case_directory/api.calls" "$case_directory/before.calls"
refused 'interrupted around a request' -- setup
diff -u <(cat "$case_directory/before.calls"; printf 'inspect \n') "$case_directory/api.calls" || fail 'An uncertain model check was repeated'

fixture failed-operation
refused 'retained operation failed\|setup stopped' TEST_OPERATION_FAILED=true -- setup
[[ $(receipt .phase) == failed && $(receipt .operationId) == "$operation" ]] || fail 'Failed operation identity was lost'
: > "$case_directory/api.calls"
refused 'retained operation failed' -- setup
sequence inspect
: > "$case_directory/api.calls"
refused 'retained operation' -- resume 00000000-0000-4000-8000-000000000002
sequence inspect
: > "$case_directory/api.calls"
run 0 -- resume "$operation"
sequence inspect "resume $operation" "operation $operation" "operation $operation" "operation $operation" check
[[ $(receipt .phase) == complete && $(receipt .operationId) == "$operation" ]] || fail 'Resume replaced its original operation'
: > "$case_directory/api.calls"
refused 'different retained setup plan' TEST_MODEL='different-model' -- setup
sequence inspect
: > "$case_directory/api.calls"
refused 'different retained setup plan' TEST_URL='https://other.example.com/v1' -- setup
sequence inspect

# The operation phase may be followed again; only explicit resume may POST resume.
fixture follow-retained-operation
run 0 -- setup
jq '.phase="operation"' "$case_directory/ardent-setup/assistant.json" > "$case_directory/next"
mv "$case_directory/next" "$case_directory/ardent-setup/assistant.json"
: > "$case_directory/api.calls"
run 0 -- setup
sequence inspect "operation $operation" "operation $operation" check

fixture check-held-owner
seed_receipt checking
cp "$case_directory/ardent-setup/assistant.json" "$case_directory/receipt.before"
refused 'held by existing work' TEST_HELD=true -- check
sequence inspect
cmp -s "$case_directory/receipt.before" "$case_directory/ardent-setup/assistant.json" || fail 'Held check changed its receipt'
fixture check-missing-operation
seed_receipt checking
jq 'del(.operationId)' "$case_directory/ardent-setup/assistant.json" > "$case_directory/next"
mv "$case_directory/next" "$case_directory/ardent-setup/assistant.json"
cp "$case_directory/ardent-setup/assistant.json" "$case_directory/receipt.before"
refused 'owning deployment operation' -- check
sequence inspect
cmp -s "$case_directory/receipt.before" "$case_directory/ardent-setup/assistant.json" || fail 'Check invented missing deployment ownership'

# A provider probe cannot turn uncertain deployment intent into success.
for phase in planned installing creating operation failed unknown-phase; do
  fixture "check-held-$phase"
  seed_receipt "$phase"
  cp "$case_directory/ardent-setup/assistant.json" "$case_directory/receipt.before"
  refused 'retained\|operation\|receipt\|phase' -- check
  sequence inspect
  cmp -s "$case_directory/receipt.before" "$case_directory/ardent-setup/assistant.json" || fail 'Check erased an unfinished deployment intent'
done
for state in running failed; do
  fixture "check-own-operation-$state"
  seed_receipt checking
  cp "$case_directory/ardent-setup/assistant.json" "$case_directory/receipt.before"
  refused 'retained\|operation\|succeeded' TEST_OPERATION_STATE="$state" -- check
  sequence inspect "operation $operation"
  cmp -s "$case_directory/receipt.before" "$case_directory/ardent-setup/assistant.json" || fail 'Unsettled operation changed its receipt'
done
fixture check-wrong-operation-kind
seed_receipt checking
cp "$case_directory/ardent-setup/assistant.json" "$case_directory/receipt.before"
refused 'retained\|operation\|deploy' TEST_OPERATION_STATE=succeeded TEST_OPERATION_KIND=upgrade -- check
sequence inspect "operation $operation"
cmp -s "$case_directory/receipt.before" "$case_directory/ardent-setup/assistant.json" || fail 'Wrong owning operation changed its receipt'
for phase in profile-ready complete checking; do
  fixture "check-allowed-$phase"
  seed_receipt "$phase"
  run 0 TEST_OPERATION_STATE=succeeded -- check
  sequence inspect "operation $operation" check
  [[ $(receipt .phase) == complete && $(receipt .operationId) == "$operation" ]] || fail 'Verified check lost its operation ownership'
done

# Neither symlinks nor hard links may redirect receipt/lock operations.
for target in directory receipt lock; do
  fixture "symlink-$target"
  mkdir -m 700 "$case_directory/ardent-setup" "$case_directory/foreign"
  printf 'unchanged fixture\n' > "$case_directory/foreign/file"
  case "$target" in
    directory) rmdir "$case_directory/ardent-setup"; ln -s "$case_directory/foreign" "$case_directory/ardent-setup";;
    receipt) ln -s "$case_directory/foreign/file" "$case_directory/ardent-setup/assistant.json";;
    lock) ln -s "$case_directory/foreign/file" "$case_directory/ardent-setup/assistant.lock";;
  esac
  refused 'Unsafe' -- setup
  no_calls
  [[ $(cat "$case_directory/foreign/file") == 'unchanged fixture' ]] || fail 'Symlink target changed'
done
for target in receipt lock; do
  fixture "hardlink-$target"
  mkdir -m 700 "$case_directory/ardent-setup"
  printf 'unchanged fixture\n' > "$case_directory/foreign"
  suffix=json; [[ $target != lock ]] || suffix=lock
  ln "$case_directory/foreign" "$case_directory/ardent-setup/assistant.$suffix"
  refused 'Unsafe\|private\|single' -- setup
  no_calls
  [[ $(cat "$case_directory/foreign") == 'unchanged fixture' ]] || fail 'Hardlinked state target was truncated'
done
fixture private-mode
# Test a permissive caller umask: fresh lock/receipt must still be private.
(umask 022; run 0 -- setup)
[[ $(stat -c %a "$case_directory/ardent-setup/assistant.lock") == 600 ]] || fail 'Caller umask exposed the lock'
chmod 644 "$case_directory/ardent-setup/assistant.json"
: > "$case_directory/api.calls"
refused 'Unsafe\|private' -- setup
no_calls
fixture locked
mkdir -m 700 "$case_directory/ardent-setup"
exec {held_lock}> "$case_directory/ardent-setup/assistant.lock"
flock "$held_lock"
refused 'Another setup command' -- setup
no_calls
exec {held_lock}>&-
# Real controller request builder -> real host action -> container stdin CLI.
# Fake Docker is the only boundary: it checks all argv/data, supplies the secret
# solely inside its child environment and makes any fetch call fail this test.
fixture transport
mkdir -m 700 "$case_directory/bin"
cat > "$case_directory/bin/docker" <<'DOCKER'
#!/usr/bin/env bash
set -Eeuo pipefail
printf '%s\n' "$@" > "$TEST_CASE/docker.argv"
cat > "$TEST_CASE/docker.stdin"
python3 - "$@" <<'VERIFY'
import json, os, pathlib, sys
case = pathlib.Path(os.environ['TEST_CASE'])
args = sys.argv[1:]
assert args[:6] == ['compose', '-f', '/opt/example suite/compose.json', 'exec', '-T', '-e']
assert args[7:] == ['magnus', 'node', '--input-type=module']
assert args[6].startswith('HIVE_ARDENT_SETUP=')
setup = json.loads(args[6].split('=', 1)[1])
assert setup == {'mode': 'plan', 'nodeId': 'fixture-node', 'profile': 'assistant',
                 'model': {'base_url': 'https://models.example.com/v1', 'model': 'fixture-model'}}
(case / 'transport.setup.json').write_text(json.dumps(setup))
source = pathlib.Path(os.environ['TEST_ROOT'], 'scripts/suite/ardent-setup.mjs').read_bytes()
assert (case / 'docker.stdin').read_bytes() == source + b'\nawait ardentSetupCLI();\n'
payload = json.loads((case / 'transport.payload.json').read_text())
import base64
assert base64.b64decode(payload['setupScript'], validate=True) == source
assert payload['compose'] == '/opt/example suite/compose.json'
assert payload['setup'] == setup
VERIFY
export HIVE_ARDENT_SETUP=${7#HIVE_ARDENT_SETUP=}
export API_SECRET=fixture-api-secret-never-transported
{ printf '%s\n' 'globalThis.fetch = () => { throw new Error("Unexpected transport test fetch"); };'; cat "$TEST_CASE/docker.stdin"; } | node --input-type=module
DOCKER
chmod 700 "$case_directory/bin/docker"
TEST_ROOT=$ROOT TEST_CASE=$case_directory PATH="$case_directory/bin:$PATH" bash > "$case_directory/transport.result" <<'TRANSPORT'
  set -Eeuo pipefail
  source "$TEST_ROOT/scripts/suite/ardent-setup.sh"
  HIVE_ROOT=$TEST_ROOT HIVE_ARDENT_NODE=fixture-node HIVE_ARDENT_PROFILE=assistant
  HIVE_ARDENT_COMPOSE="/opt/example suite/compose.json" HIVE_MAGNUS_HOST=control
  HIVE_ARDENT_MODEL_JSON='{"base_url":"https://models.example.com/v1","model":"fixture-model"}'
  hive_magnus_agent_action() {
    [[ $1 == control && $2 == magnus-agent-ardent-setup ]]
    printf "%s\n" "$3" > "$TEST_CASE/transport.payload.json"
    jq -nc --arg action "$2" --argjson payload "$3" '{action:$action,magnusAgent:$payload}' |
      bash "$TEST_ROOT/scripts/suite/magnus-agent-host.sh"
  }
  hive_ardent_api plan
TRANSPORT
[[ $(wc -l < "$case_directory/transport.result") == 1 ]] || fail 'Container stdin invoked the CLI more than once'
jq -e '.schema==1 and .mode=="plan" and .nodeId=="fixture-node" and .profile=="assistant" and (.requestSHA256|test("^[a-f0-9]{64}$"))' "$case_directory/transport.result" > /dev/null || fail 'Real container CLI did not return its model plan'
! grep -qF 'fixture-api-secret-never-transported' "$case_directory/docker.argv" "$case_directory/transport.result" "$case_directory/transport.payload.json" || fail 'Container-only API secret escaped its environment'
printf 'Passed: real Ardent request transport preserves the bundled source and JSON, invokes the stdin CLI once, and keeps API credentials out of argv/output.\n'
printf 'Passed: Ardent setup owns one retained operation, follows/resumes without replay, validates plans, preserves profiles and held work, and protects receipts/locks.\n'
