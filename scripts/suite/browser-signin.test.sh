#!/usr/bin/env bash
# hive.sh console-clients: the browser sign-in settings step (browser-signin-host.sh), on
# installations set up three ways: migrated without Oathweave's browser issuer (and with
# Oathweave reading another environment file than config/oathweave.env), already configured as
# fresh setup writes it, and configured by hand with values the operator chose. Only missing
# settings are added, operator keys are kept, check never writes, the changed services are
# recreated and the active plan's pin follows the change. Docker and Oathweave's store are
# stand-ins; no container is started.
set -Eeuo pipefail
ROOT=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)
temporary=$(mktemp -d)
trap 'rm -rf -- "$temporary"' EXIT
fail() { printf 'FAIL: %s\n' "$*" >&2; exit 1; }
refused() { # MESSAGE COMMAND...
  local message=$1; shift
  if "$@" > "$temporary/result" 2>&1; then cat "$temporary/result" >&2; fail "Accepted: $*"; fi
  grep -q -- "$message" "$temporary/result" || { cat "$temporary/result" >&2; fail "Expected refusal '$message'"; }
}
source "$ROOT/scripts/suite/input-artifacts-host.sh"
directory="$temporary/install"
config="$directory/config"
mkdir -p "$temporary/bin"
# Oathweave's Prisma client, in memory, saved to a file between runs.
cat > "$temporary/prisma.mjs" <<'JS'
import { readFileSync, writeFileSync } from 'node:fs';
const file = process.env.HIVE_TEST_STORE;
let state = JSON.parse(readFileSync(file, 'utf8'));
const table = (name, key = 'id') => ({
  findMany: async () => structuredClone(state[name]),
  findUnique: async ({ where }) => structuredClone(state[name].find((row) => Object.entries(where).every(([k, v]) => row[k] === v)) ?? null),
  create: async ({ data }) => { state[name].push(structuredClone(data)); return data; },
  update: async ({ where, data }) => { const row = state[name].find((item) => item[key] === where[key]); Object.assign(row, data); return row; },
});
const client = () => ({ user: table('users'), role: table('roles'), client: table('clients'), userRoleAssignment: table('assignments') });
export const prisma = {
  ...client(),
  $transaction: async (work) => { const saved = structuredClone(state); try { const result = await work(client()); writeFileSync(file, JSON.stringify(state)); return result; } catch (error) { state = saved; throw error; } },
  $disconnect: async () => {},
};
JS
# Docker: a recreated Oathweave runs with the policies of its environment file at that moment.
cat > "$temporary/bin/docker" <<'SH'
#!/usr/bin/env bash
set -Eeuo pipefail
printf '%s\n' "$*" >> "$HIVE_TEST_DOCKER_LOG"
if [[ "$1" == compose && "$4" == up && "${@: -1}" == oathweave ]]; then
  env=$(jq -r '.services.oathweave.env_file[0]' "$3")
  sed -n "s/^IAM_BROWSER_CLIENT_POLICIES='\(.*\)'$/\1/p;s/^IAM_BROWSER_CLIENT_POLICIES=\([^']*\)$/\1/p" "$env" | tail -1 > "$HIVE_TEST_RUNNING"
  exit 0
fi
if [[ "$1" == compose && "$4" == up ]]; then exit 0; fi
if [[ "$1" == compose && "$4" == ps ]]; then printf 'container-%s\n' "${@: -1}"; exit 0; fi
if [[ "$1" == inspect ]]; then printf '%s\n' "${HIVE_TEST_HEALTH:-healthy}"; exit 0; fi
[[ "$1 $2 $4 $5 $6 $7 $8" == "compose -f exec -T oathweave node --input-type=module" && "$9" == -e ]] || exit 99
code=${10//\/app\/apps\/iam-core\/dist\/db\/client.js/$HIVE_TEST_PRISMA}
IAM_BROWSER_CLIENT_POLICIES=$(cat "$HIVE_TEST_RUNNING") exec node --input-type=module -e "$code" "${@:11}"
SH
chmod 700 "$temporary/bin/docker"
# Health is polled; the stand-in answers at once, so waiting is skipped.
printf '#!/bin/sh\nexit 0\n' > "$temporary/bin/sleep"; chmod 700 "$temporary/bin/sleep"
export PATH="$temporary/bin:$PATH" HIVE_TEST_PRISMA="$temporary/prisma.mjs" HIVE_TEST_STORE="$temporary/store.json" HIVE_TEST_DOCKER_LOG="$temporary/docker.log" HIVE_TEST_RUNNING="$temporary/running-policies.json"
origin=https://console.example.com
issuer=$origin/api/oathweave

# An installation with Oathweave, Emberpath, HiveMem, the console and the Hive Registry. OATHWEAVE_ENV
# names the environment file Oathweave reads, in Compose and in the installation file.
setup() { # OATHWEAVE_ENV
  rm -rf -- "$directory"; mkdir -p "$config/oathweave" "$config/emberpath" "$config/hivemem"
  local oathweave_env=$1
  jq -n --arg directory "$directory" --arg oath "$oathweave_env" --arg origin "$origin" '{schema:1,installation:"example-suite",release:"0.1.0",profile:"custom",origin:$origin,
    hosts:{control:{target:"local",directory:$directory}},
    components:{"hive-registry":{host:"control",envFile:($directory+"/config/hive-registry.env"),configDirectory:($directory+"/config/hive-registry")},
      oathweave:{host:"control",envFile:$oath,configDirectory:($directory+"/config/oathweave")},"oathweave-redis":{host:"control",configDirectory:($directory+"/config/oathweave-redis")},
      emberpath:{host:"control",envFile:($directory+"/config/emberpath.env"),configDirectory:($directory+"/config/emberpath")},
      hivemem:{host:"control",envFile:($directory+"/config/hivemem.env"),configDirectory:($directory+"/config/hivemem")},"hivemem-qdrant":{host:"control",configDirectory:($directory+"/config/hivemem-qdrant")},
      hivexui:{host:"control"},ingress:{host:"control",envFile:($directory+"/config/ingress.env"),configDirectory:($directory+"/config/ingress")}},
    console:{host:"control",bindAddress:"127.0.0.1",httpsPort:8443,runtimeFile:($directory+"/config/runtime.json")},agents:[],inference:[]}' > "$temporary/config.json"
  jq -n --arg directory "$directory" --arg oath "$oathweave_env" '{services:{
    oathweave:{env_file:[$oath],volumes:[{type:"bind",source:($directory+"/config/oathweave"),target:"/config",read_only:true}]},
    emberpath:{env_file:[($directory+"/config/emberpath.env")]},hivemem:{env_file:[($directory+"/config/hivemem.env")]},
    hivexui:{volumes:[{type:"bind",source:($directory+"/config/runtime.json"),target:"/usr/share/nginx/html/runtime.json",read_only:true}]}}}' > "$directory/compose.json"
  jq -n --arg issuer "$issuer" '{schema:1,mode:"suite",products:{oathweave:"/api/oathweave",emberpath:"/api/emberpath",hivemem:"/api/hivemem"},identity:{issuer:$issuer,apiPrefix:"/api/oathweave",clients:{oathweave:"hivexui-oathweave",emberpath:"hivexui-emberpath",hivemem:"hivexui-hivemem"}}}' > "$config/runtime.json"
  chmod 644 "$config/runtime.json"
  printf "OATHWEAVE_ISSUER='%s'\nOPERATOR_SETTING='kept'\n" "$issuer" > "$config/emberpath.env"
  printf "OATHWEAVE_ISSUER='%s'\n" "$issuer" > "$config/hivemem.env"
  printf '{"schema":1,"transaction":"t1","phase":"complete"}\n' > "$directory/transaction.json"
  jq -n '{users:[{id:"operator",username:"admin"}],roles:[{id:"r2",name:"SUITE_ADMIN",permissions:"[]"}],
    clients:[{id:"hivexui-oathweave",name:"hivexui-oathweave",clientType:"public",firstParty:true,redirectUris:"[\"https://console.example.com/auth/callback\"]"}],
    assignments:[{userId:"operator",roleId:"r2"}]}' > "$HIVE_TEST_STORE"
  : > "$HIVE_TEST_DOCKER_LOG"
}
# The receipt and the pin of the active plan, taken over the files as they are now.
pin() {
  local sha
  sha=$(directory=$directory deployment_inputs_digest "$directory/compose.json")
  jq -n --arg sha "$sha" '{schema:1,plan:("a"*64),deploymentInputSHA256:$sha}' > "$directory/receipt.json"
  jq -n --arg sha "$sha" '{schema:1,sha256:$sha}' > "$directory/deployment-inputs.$(printf 'a%.0s' {1..64}).json"
}
pin_file() { printf '%s/deployment-inputs.%s.json\n' "$directory" "$(printf 'a%.0s' {1..64})"; }
reviewed() { HIVE_CONFIG="$temporary/config.json" bash -c 'source "$0/scripts/suite/console-clients.sh"; hive_console_clients_reviewed' "$ROOT" | jq -c 'map({key:.id,value:{audience,permissions}})|from_entries'; }
value() { sed -n "s/^$2='\(.*\)'$/\1/p;s/^$2=\([^']*\)$/\1/p" "$1" | tail -1; }
hive() { "$ROOT/hive.sh" console-clients "$1" --config "$temporary/config.json" --non-interactive "${@:2}"; }
snapshot() { (cd "$directory" && find . -type f ! -name controller.lock -print0 | sort -z | xargs -0 sha256sum) > "$1"; }

# ---- 1. Migrated without the browser issuer, Oathweave reading another file than oathweave.env ----
setup "$config/oathweave-embermend-v2.env"
partner='{"audience":"partner","permissions":["partner:read"]}'
printf "JWT_ISSUER='oathweave-example-suite'\nIAM_BROWSER_CLIENT_POLICIES='%s'\nCOOKIE_SECRET='%s'\n" \
  "$(jq -nc --argjson partner "$partner" '{"hivexui-oathweave":{audience:"oathweave",permissions:["iam:users:read"]},"partner-portal":$partner}')" "$(printf 'c%.0s' {1..48})" > "$config/oathweave-embermend-v2.env"
chmod 600 "$config"/*.env
cp "$config/oathweave-embermend-v2.env" "$temporary/oathweave-before.env"; cp "$config/emberpath.env" "$temporary/emberpath-before.env"
value "$config/oathweave-embermend-v2.env" IAM_BROWSER_CLIENT_POLICIES > "$HIVE_TEST_RUNNING"
# Fresh setup's record of the files it wrote: a changed file is recorded again, the old record kept.
mkdir -p "$config/.initializer"
jq -n --arg oath "$config/oathweave-embermend-v2.env" --arg ember "$config/emberpath.env" --arg other "$config/hivemem.env" \
  --arg o "$(sha256sum "$config/oathweave-embermend-v2.env" | cut -d ' ' -f1)" --arg e "$(sha256sum "$config/emberpath.env" | cut -d ' ' -f1)" --arg h "$(sha256sum "$config/hivemem.env" | cut -d ' ' -f1)" \
  '{schema:1,phase:"complete",files:{($oath):$o,($ember):$e,($other):$h}}' > "$config/.initializer/receipt.json"
chmod 600 "$config/.initializer/receipt.json"
cp -p "$config/.initializer/receipt.json" "$temporary/initializer-before.json"
pin
cp "$directory/receipt.json" "$temporary/receipt-before.json"
snapshot "$temporary/before.sums"
# check reads only, names what is missing in the file Oathweave really reads, and fails.
refused 'Browser sign-in settings are missing; run console-clients add' hive check
grep -q "To add in $config/oathweave-embermend-v2.env on control: IAM_BROWSER_API_BASE_URL, IAM_BROWSER_AUTHORIZATION_URL, IAM_BROWSER_CLIENT_POLICIES, IAM_BROWSER_ISSUER (policies hivexui-emberpath, hivexui-hivemem, hivexui-registry)" "$temporary/result" ||
  { cat "$temporary/result" >&2; fail 'check did not name the missing Oathweave settings'; }
grep -q "To add in $config/emberpath.env on control: EMBERPATH_PASSWORD_RELAY" "$temporary/result" || fail 'check did not name the Emberpath relay setting'
grep -q 'The hivexui-oathweave policy in IAM_BROWSER_CLIENT_POLICIES is kept as it is' "$temporary/result" || fail 'check did not name the kept policy'
[[ ! -e "$config/oathweave.env" ]] || fail 'check created config/oathweave.env'
snapshot "$temporary/after-check.sums"; cmp -s "$temporary/before.sums" "$temporary/after-check.sums" || fail 'check changed a file'
! grep -q ' up ' "$HIVE_TEST_DOCKER_LOG" || fail 'check recreated a service'
# add needs confirmation for a change.
refused 'Unattended use needs --yes' hive add
snapshot "$temporary/after-refusal.sums"; cmp -s "$temporary/before.sums" "$temporary/after-refusal.sums" || fail 'An unconfirmed add changed a file'
hive add --yes > "$temporary/apply.log" 2>&1 || { cat "$temporary/apply.log" >&2; fail 'add --yes failed'; }
oath="$config/oathweave-embermend-v2.env"
[[ $(value "$oath" IAM_BROWSER_ISSUER) == "$issuer" ]] || fail 'The browser issuer is not the console runtime issuer'
[[ $(value "$oath" IAM_BROWSER_AUTHORIZATION_URL) == "$origin/auth/authorize" && $(value "$oath" IAM_BROWSER_API_BASE_URL) == "$origin/api/oathweave" ]] || fail 'Browser discovery was not configured'
value "$oath" IAM_BROWSER_CLIENT_POLICIES | jq -e --argjson reviewed "$(reviewed)" --argjson partner "$partner" '
  ."partner-portal"==$partner and ."hivexui-oathweave"=={audience:"oathweave",permissions:["iam:users:read"]} and
  (del(."partner-portal",."hivexui-oathweave"))==($reviewed|del(."hivexui-oathweave"))' >/dev/null || fail 'The policies are not the existing ones plus the missing reviewed ones'
[[ $(value "$oath" JWT_ISSUER) == oathweave-example-suite && $(value "$oath" COOKIE_SECRET) == "$(printf 'c%.0s' {1..48})" ]] || fail 'An operator key changed'
[[ $(stat -c %a "$oath") == 600 && $(value "$config/emberpath.env" EMBERPATH_PASSWORD_RELAY) == false && $(value "$config/emberpath.env" OPERATOR_SETTING) == kept ]] || fail 'Emberpath relay not off, or a mode or key changed'
[[ ! -e "$config/oathweave.env" ]] || fail 'add wrote config/oathweave.env instead of the file Oathweave reads'
backup=$(find "$config/.browser-signin" -mindepth 1 -maxdepth 1 -type d)
cmp -s "$backup/oathweave.env" "$temporary/oathweave-before.env" && cmp -s "$backup/emberpath.env" "$temporary/emberpath-before.env" || fail 'The previous files were not kept'
grep -q 'compose -f .* up -d --no-deps --force-recreate oathweave' "$HIVE_TEST_DOCKER_LOG" && grep -q 'force-recreate emberpath' "$HIVE_TEST_DOCKER_LOG" || fail 'The changed services were not recreated'
! grep -q 'force-recreate hivemem' "$HIVE_TEST_DOCKER_LOG" || fail 'An unchanged service was recreated'
now=$(directory=$directory deployment_inputs_digest "$directory/compose.json")
[[ $(jq -r .sha256 "$(pin_file)") == "$now" && $(jq -r .deploymentInputSHA256 "$directory/receipt.json") == "$now" ]] || fail 'The active plan pin did not follow the change'
cmp -s "$backup/receipt.json" "$temporary/receipt-before.json" && jq -e '.pinned|length==2' "$backup/changes.json" >/dev/null || fail 'The previous receipt and pin were not kept for an undo'
jq -e --arg oath "$oath" --arg ember "$config/emberpath.env" --arg other "$config/hivemem.env" --arg o "$(sha256sum "$oath" | cut -d ' ' -f1)" --arg e "$(sha256sum "$config/emberpath.env" | cut -d ' ' -f1)" --arg h "$(sha256sum "$config/hivemem.env" | cut -d ' ' -f1)" \
  '.files[$oath]==$o and .files[$ember]==$e and .files[$other]==$h' "$config/.initializer/receipt.json" >/dev/null || fail 'The initialization record does not name the new bytes'
cmp -s "$backup/initializer-receipt.json" "$temporary/initializer-before.json" && jq -e --arg path "$config/.initializer/receipt.json" '.initializer==$path' "$backup/changes.json" >/dev/null ||
  fail 'The previous initialization record was not kept for an undo'
# The recreated Oathweave has the new policies, so the clients step created the missing clients.
grep -q 'Created clients: hivexui-emberpath, hivexui-hivemem, hivexui-registry' "$temporary/apply.log" || { cat "$temporary/apply.log" >&2; fail 'The missing clients were not created after the settings'; }
grep -q 'Left as it is: hivexui-oathweave' "$temporary/apply.log" || fail 'The hand-set Oathweave client policy was not named'
# A repeat is a no-op that needs no confirmation, and check now passes.
snapshot "$temporary/applied.sums"; : > "$HIVE_TEST_DOCKER_LOG"
hive add > "$temporary/repeat.log" 2>&1 || { cat "$temporary/repeat.log" >&2; fail 'A repeat needed confirmation'; }
grep -q 'Browser sign-in settings: nothing to add' "$temporary/repeat.log" && grep -q 'Nothing to add: every client exists' "$temporary/repeat.log" || fail 'A repeat was not a no-op'
hive check > "$temporary/check.log" 2>&1 || { cat "$temporary/check.log" >&2; fail 'check failed on a complete installation'; }
snapshot "$temporary/repeated.sums"; cmp -s "$temporary/applied.sums" "$temporary/repeated.sums" || fail 'A repeat changed a file'
! grep -q ' up ' "$HIVE_TEST_DOCKER_LOG" || fail 'A repeat recreated a service'

# ---- 2. Already configured, as fresh setup writes it: nothing to add, nothing recreated ----
setup "$config/oathweave.env"
{ printf "IAM_BROWSER_ISSUER=%s\nIAM_BROWSER_CLIENT_POLICIES=%s\n" "$issuer" "$(reviewed)"
  printf "IAM_BROWSER_AUTHORIZATION_URL=%s/auth/authorize\nIAM_BROWSER_API_BASE_URL=%s/api/oathweave\n" "$origin" "$origin"; } > "$config/oathweave.env"
printf 'EMBERPATH_PASSWORD_RELAY=false\n' >> "$config/emberpath.env"
chmod 600 "$config"/*.env
reviewed > "$HIVE_TEST_RUNNING"
jq '.clients=[{id:"hivexui-oathweave"},{id:"hivexui-emberpath"},{id:"hivexui-hivemem"},{id:"hivexui-registry"}]|.clients|=map(.+{name:.id,clientType:"public",firstParty:true,redirectUris:"[\"https://console.example.com/auth/callback\"]"})' "$HIVE_TEST_STORE" > "$temporary/next.json"; mv "$temporary/next.json" "$HIVE_TEST_STORE"
jq --argjson reviewed "$(reviewed)" '.roles[0].permissions=([$reviewed[].permissions[]]|tojson)' "$HIVE_TEST_STORE" > "$temporary/next.json"; mv "$temporary/next.json" "$HIVE_TEST_STORE"
pin; snapshot "$temporary/fresh.sums"
hive check > "$temporary/fresh-check.log" 2>&1 || { cat "$temporary/fresh-check.log" >&2; fail 'check failed on a freshly configured installation'; }
hive add > "$temporary/fresh-add.log" 2>&1 || { cat "$temporary/fresh-add.log" >&2; fail 'add needed confirmation on a freshly configured installation'; }
grep -q 'Browser sign-in settings: nothing to add' "$temporary/fresh-add.log" || fail 'A configured installation got settings'
snapshot "$temporary/fresh-after.sums"; cmp -s "$temporary/fresh.sums" "$temporary/fresh-after.sums" || fail 'A configured installation changed'
[[ ! -e "$config/.browser-signin" ]] && ! grep -q ' up ' "$HIVE_TEST_DOCKER_LOG" || fail 'A configured installation was backed up or recreated'

# ---- 3. Values the operator chose are kept and named ----
printf 'EMBERPATH_PASSWORD_RELAY=true\n' >> "$config/emberpath.env"
sed -i "s#^IAM_BROWSER_AUTHORIZATION_URL=.*#IAM_BROWSER_AUTHORIZATION_URL=$origin/custom/authorize#" "$config/oathweave.env"
pin; snapshot "$temporary/operator.sums"
hive check > "$temporary/operator.log" 2>&1 || { cat "$temporary/operator.log" >&2; fail 'Operator values made check fail'; }
grep -q 'EMBERPATH_PASSWORD_RELAY=true is kept' "$temporary/operator.log" && grep -q "IAM_BROWSER_AUTHORIZATION_URL is kept: $origin/custom/authorize" "$temporary/operator.log" || { cat "$temporary/operator.log" >&2; fail 'Kept operator values were not named'; }
snapshot "$temporary/operator-after.sums"; cmp -s "$temporary/operator.sums" "$temporary/operator-after.sums" || fail 'Operator values were changed'

# ---- 4. Inconsistent installations are named, never "fixed" ----
# The installation file and Compose disagree about Oathweave's environment file.
jq --arg file "$config/oathweave-other.env" '.components.oathweave.envFile=$file' "$temporary/config.json" > "$temporary/next.json"; cp "$temporary/config.json" "$temporary/config.saved"; mv "$temporary/next.json" "$temporary/config.json"
refused 'reconcile them first' hive add --yes
mv "$temporary/config.saved" "$temporary/config.json"
# HiveXUI expects another issuer than Oathweave's: named, check fails, nothing written.
jq '.identity.issuer="https://other.example.com/api/oathweave"' "$config/runtime.json" > "$temporary/next.json"; cat "$temporary/next.json" > "$config/runtime.json"
pin; snapshot "$temporary/mismatch.sums"
refused 'Browser sign-in needs attention' hive check
grep -q 'runtime.json signs in with issuer https://other.example.com/api/oathweave' "$temporary/result" || fail 'The issuer mismatch was not named'
snapshot "$temporary/mismatch-after.sums"; cmp -s "$temporary/mismatch.sums" "$temporary/mismatch-after.sums" || fail 'An issuer mismatch changed a file'

# ---- 5. A pin that already differs stays as it is; an unhealthy service stops with the backup ----
setup "$config/oathweave.env"
printf "IAM_BROWSER_ISSUER=%s\nIAM_BROWSER_CLIENT_POLICIES=%s\n" "$issuer" "$(reviewed)" > "$config/oathweave.env"
chmod 600 "$config"/*.env
reviewed > "$HIVE_TEST_RUNNING"
pin; jq '.sha256=("b"*64)' "$(pin_file)" > "$temporary/next.json"; mv "$temporary/next.json" "$(pin_file)"
HIVE_TEST_HEALTH=unhealthy refused 'oathweave did not become healthy with the new settings; the previous files are in' hive add --yes
[[ $(jq -r .sha256 "$(pin_file)") == "$(printf 'b%.0s' {1..64})" ]] || fail 'A pin that already differed was moved'
[[ $(value "$config/oathweave.env" IAM_BROWSER_API_BASE_URL) == "$origin/api/oathweave" ]] || fail 'The discovery URL was not added before the restart'
backup=$(find "$config/.browser-signin" -mindepth 1 -maxdepth 1 -type d)
[[ -f "$backup/oathweave.env" && -f "$backup/changes.json" ]] || fail 'The unhealthy restart left no backup'
# Without an initialization record (a migrated installation) none is kept or named.
[[ ! -e "$backup/initializer-receipt.json" ]] && jq -e 'has("initializer")|not' "$backup/changes.json" >/dev/null || fail 'An initialization record was named where none exists'
printf 'Passed: browser sign-in settings added only where missing, in the file Oathweave reads, with operator keys kept, check read-only, changed services recreated, the active pin moved only when unchanged, and inconsistencies named.\n'
