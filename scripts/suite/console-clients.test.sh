#!/usr/bin/env bash
# hive.sh console-clients: the transaction it runs in the Oathweave container, against an
# in-memory stand-in for Oathweave's store. It creates only the missing reviewed public clients,
# adds only their permissions to SUITE_ADMIN, repeats as a no-op, and refuses without the
# running policy, without SUITE_ADMIN or with a conflicting client. No containers are started.
set -Eeuo pipefail
ROOT=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)
temporary=$(mktemp -d)
trap 'rm -rf -- "$temporary"' EXIT
fail() { printf 'FAIL: %s\n' "$*" >&2; exit 1; }
refused() { # MESSAGE COMMAND...
  local message=$1; shift
  if "$@" > "$temporary/result" 2>&1; then fail "Accepted: $*"; fi
  grep -q -- "$message" "$temporary/result" || { cat "$temporary/result" >&2; fail "Expected refusal '$message'"; }
}
directory="$temporary/install"
mkdir -p "$directory/config" "$temporary/bin"
printf '{"services":{"oathweave":{}}}\n' > "$directory/compose.json"
# Oathweave's Prisma client, in memory, saved to a file between runs; a failed transaction is not saved.
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
# docker compose exec runs the transaction locally, against the stand-in, with the container's policies.
cat > "$temporary/bin/docker" <<'SH'
#!/usr/bin/env bash
printf '%s\n' "$1 $2 $3 $4 $5 $6 $7" >> "$HIVE_TEST_DOCKER_LOG"
[[ "$1 $2 $4 $5 $6 $7 $8" == "compose -f exec -T oathweave node --input-type=module" && "$9" == -e ]] || exit 99
code=${10//\/app\/apps\/iam-core\/dist\/db\/client.js/$HIVE_TEST_PRISMA}
IAM_BROWSER_CLIENT_POLICIES=$HIVE_TEST_POLICIES exec node --input-type=module -e "$code" "${11}"
SH
chmod 700 "$temporary/bin/docker"
export PATH="$temporary/bin:$PATH" HIVE_TEST_PRISMA="$temporary/prisma.mjs" HIVE_TEST_STORE="$temporary/store.json" HIVE_TEST_DOCKER_LOG="$temporary/docker.log"
magnus='{"audience":"magnus","permissions":["magnus:view","magnus:operate","magnus:admin"]}'
studio='{"audience":"ardentstudio","permissions":["ardentstudio:projects:read","ardentstudio:projects:write","ardentstudio:templates:read","ardentstudio:templates:write","ardentstudio:review:write","ardentstudio:agents:admin"]}'
export HIVE_TEST_POLICIES="{\"hivexui-oathweave\":{\"audience\":\"oathweave\",\"permissions\":[\"iam:users:read\"]},\"hivexui-magnus\":$magnus,\"hivexui-ardentstudio\":$studio}"
store() {
  jq -n '{users:[{id:"operator",username:"admin"},{id:"other",username:"alice"}],
    roles:[{id:"r1",name:"SUPER_ADMIN",permissions:"[]"},{id:"r2",name:"SUITE_ADMIN",permissions:"[\"iam:users:read\"]"}],
    clients:[{id:"hivexui-oathweave",name:"hivexui-oathweave",clientType:"public",redirectUris:"[\"https://console.example.com/auth/callback\"]"}],
    assignments:[{userId:"operator",roleId:"r1"},{userId:"operator",roleId:"r2"}]}' > "$HIVE_TEST_STORE"
}
# An existing installation with an external Magnus and Ardent Project Studio.
jq -n --arg directory "$directory" '{schema:1,installation:"example-suite",release:"0.1.0",profile:"custom",origin:"https://console.example.com",
  hosts:{control:{target:"local",directory:$directory}},
  components:{"hive-registry":{host:"control",envFile:($directory+"/config/hive-registry.env"),configDirectory:($directory+"/config/hive-registry")},oathweave:{host:"control",envFile:($directory+"/config/oathweave.env"),configDirectory:($directory+"/config/oathweave")},"oathweave-redis":{host:"control",configDirectory:($directory+"/config/oathweave-redis")},hivexui:{host:"control"},ingress:{host:"control",envFile:($directory+"/config/ingress.env"),configDirectory:($directory+"/config/ingress")},
    hivemem:{host:"control",envFile:($directory+"/config/hivemem.env"),configDirectory:($directory+"/config/hivemem")},"hivemem-qdrant":{host:"control",configDirectory:($directory+"/config/hivemem-qdrant")},ardentstudio:{host:"control",envFile:($directory+"/config/ardentstudio.env"),configDirectory:($directory+"/config/ardentstudio")}},
  console:{host:"control",bindAddress:"127.0.0.1",httpsPort:8443,runtimeFile:($directory+"/config/runtime.json")},agents:[],inference:[],external:{magnus:{url:"https://magnus.example.com:4000"}}}' > "$temporary/config.json"
run() { "$ROOT/hive.sh" console-clients add --config "$temporary/config.json" --non-interactive "$@"; }

store
refused 'Unattended use needs --yes' run
jq -e '.clients|length==1' "$HIVE_TEST_STORE" >/dev/null || fail 'An unconfirmed run changed the store'
run --yes > "$temporary/first.log" 2>&1 || { cat "$temporary/first.log" >&2; fail 'console-clients failed'; }
grep -q 'Created clients: hivexui-magnus, hivexui-ardentstudio' "$temporary/first.log" || { cat "$temporary/first.log" >&2; fail 'The run does not name the created clients'; }
jq -e '[.clients[]|select(.id=="hivexui-magnus" or .id=="hivexui-ardentstudio")|.clientType=="public" and .firstParty==true and .grantTypes=="[\"authorization_code\"]" and .redirectUris=="[\"https://console.example.com/auth/callback\"]" and .name==.id]|length==2 and all' "$HIVE_TEST_STORE" >/dev/null || fail 'The clients are not the reviewed public clients'
jq -e --argjson magnus "$magnus" --argjson studio "$studio" '(.roles[]|select(.name=="SUITE_ADMIN")|.permissions|fromjson)==(["iam:users:read"]+$magnus.permissions+$studio.permissions)' "$HIVE_TEST_STORE" >/dev/null || fail 'SUITE_ADMIN did not gain exactly the client permissions'
jq -e '(.users|length)==2 and (.assignments|length)==2 and (.roles[]|select(.name=="SUITE_ADMIN").id)=="r2" and (.roles[]|select(.name=="SUPER_ADMIN").permissions)=="[]"' "$HIVE_TEST_STORE" >/dev/null || fail 'Other identity records changed'
cp "$HIVE_TEST_STORE" "$temporary/after-first.json"
run --yes > "$temporary/second.log" 2>&1 || fail 'A repeated run failed'
grep -q 'Created clients: none. Added to SUITE_ADMIN: none' "$temporary/second.log" || fail 'A repeated run was not a no-op'
cmp -s <(jq -S . "$HIVE_TEST_STORE") <(jq -S . "$temporary/after-first.json") || fail 'A repeated run changed the store'
# Without the external Magnus or Studio there is nothing for it to do.
jq 'del(.external,.components.ardentstudio)' "$temporary/config.json" > "$temporary/none.json"
refused 'No product here needs a console client' "$ROOT/hive.sh" console-clients add --config "$temporary/none.json" --non-interactive --yes
# Oathweave still running without the new policy: refused, nothing changed.
store
HIVE_TEST_POLICIES='{}' refused 'Oathweave runs without the reviewed browser policy for hivexui-magnus' run --yes
jq -e '.clients|length==1' "$HIVE_TEST_STORE" >/dev/null || fail 'A refused run changed the store'
# A store without SUITE_ADMIN, or a conflicting client, is refused and left as it was.
jq '.roles|=map(select(.name!="SUITE_ADMIN"))|.assignments|=map(select(.roleId!="r2"))' "$HIVE_TEST_STORE" > "$temporary/next.json"; mv "$temporary/next.json" "$HIVE_TEST_STORE"
refused 'no SUITE_ADMIN role' run --yes
store
jq '.clients+=[{id:"hivexui-magnus",name:"hivexui-magnus",clientType:"confidential",redirectUris:"[]"}]' "$HIVE_TEST_STORE" > "$temporary/next.json"; mv "$temporary/next.json" "$HIVE_TEST_STORE"
cp "$HIVE_TEST_STORE" "$temporary/conflict.json"
refused 'hivexui-magnus exists and is not a public client' run --yes
cmp -s "$HIVE_TEST_STORE" "$temporary/conflict.json" || fail 'A refused run changed the store'
# Unknown subcommands are refused before any host is contacted.
: > "$HIVE_TEST_DOCKER_LOG"
refused 'Use: console-clients add' "$ROOT/hive.sh" console-clients remove --config "$temporary/config.json" --non-interactive --yes
[[ ! -s "$HIVE_TEST_DOCKER_LOG" ]] || fail 'A refused subcommand reached the host'
printf 'Passed: console clients created once with the reviewed grants, SUITE_ADMIN extended by exactly their permissions, a no-op repeat, and refusals that leave the store unchanged.\n'
