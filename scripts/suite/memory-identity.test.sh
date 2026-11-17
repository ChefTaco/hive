#!/usr/bin/env bash
# After HiveMem's verified identity rename (hive-router -> emberpath) on the stopped live store, the
# memory credential follows the data before any service starts: the rename record, HiveMem's
# service links, Emberpath's credential record and its static fallback token, re-issued by HiveMem.
# Deployment inputs stay pinned. No containers are started; docker is a fixture.
set -Eeuo pipefail
ROOT=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)
temporary=$(mktemp -d)
trap 'rm -rf -- "$temporary"' EXIT
fail() { printf 'FAIL: %s\n' "$*" >&2; exit 1; }
die() { printf 'Held: %s\n' "$*" >&2; exit 1; }
source "$ROOT/scripts/suite/input-artifacts-host.sh"
source "$ROOT/scripts/suite/initialize-migrations-host.sh"
eval "$(sed -n '/^atomic_json() {/,/^}/p' "$ROOT/scripts/suite/host-runtime.sh")"
b64url() { printf '%s' "$1" | base64 -w0 | tr '+/' '-_' | tr -d '='; }
value() { sed -n "s/^$2=//p" "$1" | tail -1 | sed "s/^'\(.*\)'$/\1/"; }
claims() { cut -d . -f2 <<< "$1" | tr '_-' '/+' | { read -r part; printf '%s%s' "$part" "$(printf '=%.0s' $(seq 1 $(( (4 - ${#part} % 4) % 4 ))))"; } | base64 -d; }

export HIVE_IDENTITY_FIXTURE=$temporary
mkdir "$temporary/bin"
cat > "$temporary/bin/docker" <<'DOCKER'
#!/usr/bin/env bash
# Plays HiveMem's issue-token: prints a token whose claims echo the requested subject, role, scope and lifetime.
set -Eeuo pipefail
[[ "$1 $2" == 'compose -f' && "$4 $5 $6 $7 $8 $9" == 'run --no-deps --rm -T hivemem issue-token' ]] || exit 9
printf '%s\n' "$*" >> "$HIVE_IDENTITY_FIXTURE/docker.calls"
# Failure injection: the next issuance fails once, as a HiveMem that cannot start would.
if [[ -e "$HIVE_IDENTITY_FIXTURE/fail-issue-once" ]]; then rm -f -- "$HIVE_IDENTITY_FIXTURE/fail-issue-once"; exit 1; fi
shift 9
subject='' role='' scope='' ttl=''
while (($#)); do case "$1" in --subject) subject=$2;; --role) role=$2;; --scope) scope=$2;; --ttl) ttl=$2;; esac; shift 2; done
b64url() { printf '%s' "$1" | base64 -w0 | tr '+/' '-_' | tr -d '='; }
printf '%s.%s.fake-signature\n' "$(b64url '{"alg":"HS256","typ":"JWT"}')" "$(b64url "$(jq -nc --arg s "$subject" --arg r "$role" --arg c "$scope" --argjson t "$ttl" '{sub:$s,role:$r,scope:$c,exp:(now+$t|floor)}')")"
DOCKER
chmod +x "$temporary/bin/docker"
# Crash injection: after the first file moved over hivemem.env, the controller dies without cleanup.
cat > "$temporary/bin/mv" <<'MV'
#!/usr/bin/env bash
/bin/mv "$@" || exit
if [[ -e "$HIVE_IDENTITY_FIXTURE/crash-after-hivemem" && "${!#}" == */config/hivemem.env ]]; then
  rm -f -- "$HIVE_IDENTITY_FIXTURE/crash-after-hivemem"; kill -KILL "$PPID"
fi
MV
chmod +x "$temporary/bin/mv"
export PATH="$temporary/bin:$PATH"

plan=$(printf 'a%.0s' {1..64})
spec='{"image":"example.com/hivemem@sha256:'"$plan"'","command":["rename-agent","--from","hive-router","--to","emberpath"],"verificationCommand":["rename-agent","--from","hive-router","--to","emberpath","--verify"]}'
setup() { # DIRECTORY
  directory=$1; mkdir -p -m 700 "$directory/config/.credentials" "$directory/config/.initializer"
  config=$directory/config
  exp=$(( $(date +%s) + 86400 ))
  legacy="$(b64url '{"alg":"HS256","typ":"JWT"}').$(b64url '{"sub":"hive-router","role":"admin","scope":"admin:all","exp":'"$exp"'}').fake-signature"
  printf "HIVEMEM_JWT_SECRET='fake-memory-secret-0123456789abcdef0123'\nHIVEMEM_OATHWEAVE_SERVICES_JSON='[{\"issuer\":\"hive-iam\",\"clientId\":\"emberpath-hivemem\",\"localId\":\"hive-router\",\"scopes\":[\"admin:all\"]},{\"issuer\":\"hive-iam\",\"clientId\":\"fake-service\",\"localId\":\"fake-service\",\"scopes\":[\"memories:read\"]}]'\n" > "$config/hivemem.env"
  printf "HIVEMEM_INTERNAL_URL='https://hivemem:18790'\nHIVE_ROUTER_MEMORY_PROXY_TOKEN='%s'\nHIVE_ROUTER_SECRET='fake-router-secret-0123456789abcdef0123'\n" "$legacy" > "$config/emberpath.env"
  chmod 600 "$config/"*.env
  printf '{"schema":1,"clientId":"emberpath-hivemem","localId":"hive-router"}\n' > "$config/.credentials/emberpath-hivemem.json"
  jq -n --arg m "$config/hivemem.env" --arg e "$config/emberpath.env" '{schema:1,phase:"complete",files:{($m):"stale",($e):"stale"}}' > "$config/.initializer/receipt.json"
  jq -n --arg m "$config/hivemem.env" --arg e "$config/emberpath.env" '{services:{hivemem:{env_file:[$m]},emberpath:{env_file:[$e]}}}' > "$directory/candidate.json"
  jq -n --argjson spec "$spec" '{components:{hivemem:{initialization:$spec}}}' > "$directory/manifest.json"
  jq -n --argjson spec "$spec" '{schema:1,phase:"ready",initializations:{hivemem:{phase:"verified",specification:$spec}}}' > "$directory/schema-upgrade.$plan.json"
  pin_deployment_inputs "$directory/candidate.json"
}
relink() { ( hive_memory_identity_relink "$directory/candidate.json" "$directory/manifest.json" ) 2> "$directory/relink.log"; }

# ---- One host runs HiveMem and Emberpath (the full-stack installation). ----
input='{"placements":{"hivemem":{},"emberpath":{},"oathweave":{}}}'
setup "$temporary/full"
before=$(value "$config/emberpath.env" HIVE_ROUTER_MEMORY_PROXY_TOKEN)
relink || { cat "$directory/relink.log" >&2; fail 'The relink failed'; }
jq -e '.==[{issuer:"hive-iam",clientId:"emberpath-hivemem",localId:"emberpath",scopes:["admin:all"]},{issuer:"hive-iam",clientId:"fake-service",localId:"fake-service",scopes:["memories:read"]}]' <<< "$(value "$config/hivemem.env" HIVEMEM_OATHWEAVE_SERVICES_JSON)" >/dev/null || fail 'HiveMem links still name the old principal'
jq -e '.schema==1 and .renames=={"hive-router":"emberpath"}' "$config/.memory-identity-renames.json" >/dev/null || fail 'The rename is not recorded'
jq -e '.localId=="emberpath"' "$config/.credentials/emberpath-hivemem.json" >/dev/null || fail 'The credential record names the old principal'
token=$(value "$config/emberpath.env" HIVE_ROUTER_MEMORY_PROXY_TOKEN)
[[ "$token" != "$before" ]] || fail 'The static token was not re-issued'
claims "$token" | jq -e --argjson exp "$exp" '.sub=="emberpath" and .role=="admin" and .scope=="admin:all" and (.exp<=$exp) and (.exp>=$exp-30)' >/dev/null || fail "The re-issued token is not the old one's role, scope and lifetime: $(claims "$token")"
grep -q -- '--ttl' "$temporary/docker.calls" || fail 'No lifetime was passed'
grep -q "^HIVE_ROUTER_SECRET='fake-router-secret-0123456789abcdef0123'$" "$config/emberpath.env" || fail 'Other Emberpath settings changed'
for file in hivemem emberpath; do
  [[ $(stat -c %a "$config/$file.env") == 600 ]] || fail "$file.env lost its mode"
  [[ $(jq -r --arg path "$config/$file.env" '.files[$path]' "$config/.initializer/receipt.json") == "$(sha256sum "$config/$file.env" | cut -d ' ' -f1)" ]] || fail "The initializer receipt does not record the new $file.env"
done
assert_deployment_inputs "$directory/candidate.json" || fail 'The changed inputs are not pinned for activation'
! grep -q "$token" "$directory/relink.log" || fail 'The token was printed'
# A repeat changes nothing and issues nothing.
sums=$(sha256sum "$config/"*.env "$config/.credentials/emberpath-hivemem.json" "$directory/deployment-inputs.$plan.json"); calls=$(wc -l < "$temporary/docker.calls")
relink || fail 'A repeat failed'
[[ $(sha256sum "$config/"*.env "$config/.credentials/emberpath-hivemem.json" "$directory/deployment-inputs.$plan.json") == "$sums" && $(wc -l < "$temporary/docker.calls") == "$calls" ]] || fail 'A repeat changed something'
# Any other edit since staging still stops it.
printf 'EXTRA=1\n' >> "$config/hivemem.env"
if relink; then fail 'An unpinned edit was accepted'; fi
grep -q 'Pinned deployment inputs changed' "$directory/relink.log" || fail 'The unpinned edit was not named'

# ---- A failed token issuance changes no pinned input, and the rerun completes. ----
setup "$temporary/issue-fails"
sums=$(sha256sum "$config/"*.env "$directory/deployment-inputs.$plan.json")
touch "$temporary/fail-issue-once"
if relink; then fail 'A failed issuance was accepted'; fi
grep -q 'could not re-issue the static memory token' "$directory/relink.log" || fail 'The failed issuance was not named'
[[ $(sha256sum "$config/"*.env "$directory/deployment-inputs.$plan.json") == "$sums" ]] || fail 'A failed issuance left a pinned input changed'
assert_deployment_inputs "$directory/candidate.json" || fail 'A failed issuance broke the pin'
relink || { cat "$directory/relink.log" >&2; fail 'The rerun after a failed issuance did not complete'; }
[[ $(jq -r '.[0].localId' <<< "$(value "$config/hivemem.env" HIVEMEM_OATHWEAVE_SERVICES_JSON)") == emberpath ]] || fail 'The rerun did not move the links'
claims "$(value "$config/emberpath.env" HIVE_ROUTER_MEMORY_PROXY_TOKEN)" | jq -e '.sub=="emberpath"' >/dev/null || fail 'The rerun did not re-issue the token'
assert_deployment_inputs "$directory/candidate.json" || fail 'The rerun did not pin its change'
[[ -z $(find "$config" "$directory" -maxdepth 1 -name '*memory-identity*staged*' -o -maxdepth 1 -name "memory-identity.$plan.json") ]] || fail 'Staged files or the journal were left behind'

# ---- A crash between moving the files and pinning them resumes from the journal. ----
setup "$temporary/crash"
touch "$temporary/crash-after-hivemem"
if relink; then fail 'The crash was not simulated'; fi
[[ -f "$directory/memory-identity.$plan.json" ]] || fail 'No journal survived the crash'
if ( assert_deployment_inputs "$directory/candidate.json" ) 2>/dev/null; then fail 'The crash fixture did not interrupt between move and pin'; fi
relink || { cat "$directory/relink.log" >&2; fail 'The rerun after a crash did not complete'; }
[[ $(jq -r '.[0].localId' <<< "$(value "$config/hivemem.env" HIVEMEM_OATHWEAVE_SERVICES_JSON)") == emberpath ]] || fail 'The links did not move after the crash'
claims "$(value "$config/emberpath.env" HIVE_ROUTER_MEMORY_PROXY_TOKEN)" | jq -e '.sub=="emberpath"' >/dev/null || fail 'The token was not re-issued after the crash'
assert_deployment_inputs "$directory/candidate.json" || fail 'The resumed change is not pinned'
[[ ! -e "$directory/memory-identity.$plan.json" ]] || fail 'The journal was left behind'
for file in hivemem emberpath; do
  [[ $(jq -r --arg path "$config/$file.env" '.files[$path]' "$config/.initializer/receipt.json") == "$(sha256sum "$config/$file.env" | cut -d ' ' -f1)" ]] || fail "The initializer receipt does not record the resumed $file.env"
done

# ---- An unrelated edit while a crashed change is pending is still refused. ----
setup "$temporary/crash-edit"
touch "$temporary/crash-after-hivemem"
if relink; then fail 'The crash was not simulated'; fi
printf 'EXTRA=1\n' >> "$config/emberpath.env"
if relink; then fail 'An unrelated edit was accepted during recovery'; fi
grep -q 'changed outside' "$directory/relink.log" || grep -q 'Pinned deployment inputs changed' "$directory/relink.log" || fail 'The unrelated edit was not named'
setup "$temporary/crash-other"
touch "$temporary/crash-after-hivemem"
if relink; then fail 'The crash was not simulated'; fi
printf 'EXTRA=1\n' >> "$config/hivemem.env"
if relink; then fail 'An edit to a journaled file was accepted during recovery'; fi

# ---- The digest with a staged override equals the digest of the same content in place. ----
setup "$temporary/override"
cp -p "$config/hivemem.env" "$directory/same.env"
declare -gA HIVE_INPUT_OVERRIDES=(["$config/hivemem.env"]="$directory/same.env")
[[ $(deployment_inputs_digest "$directory/candidate.json") == "$(jq -r .sha256 "$directory/deployment-inputs.$plan.json")" ]] || fail 'An override with identical content changes the digest'
HIVE_INPUT_OVERRIDES=()

# ---- Without a verified rename receipt nothing is re-linked. ----
setup "$temporary/unverified"
jq '.initializations.hivemem.phase="claimed"' "$directory/schema-upgrade.$plan.json" > "$directory/next.json"; mv "$directory/next.json" "$directory/schema-upgrade.$plan.json"
sums=$(sha256sum "$config/"*.env)
if relink; then fail 'An unverified rename was re-linked'; fi
grep -q 'no verified completion receipt' "$directory/relink.log" || fail 'The missing receipt was not named'
[[ $(sha256sum "$config/"*.env) == "$sums" && ! -e "$config/.memory-identity-renames.json" ]] || fail 'An unverified rename changed a file'

# ---- A release whose HiveMem renames nothing, and a host without HiveMem, change nothing. ----
setup "$temporary/plain"
jq 'del(.components.hivemem.initialization)' "$directory/manifest.json" > "$directory/next.json"; mv "$directory/next.json" "$directory/manifest.json"
sums=$(sha256sum "$config/"*.env)
relink || fail 'A release without a rename failed'
input='{"placements":{"emberpath":{}}}'
relink || fail 'A host without HiveMem failed'
[[ $(sha256sum "$config/"*.env) == "$sums" && ! -e "$config/.memory-identity-renames.json" ]] || fail 'Nothing to rename changed a file'

# ---- Emberpath on another host: the links move, its token there is named for re-issue. ----
input='{"placements":{"hivemem":{}}}'
setup "$temporary/split"
before=$(value "$config/emberpath.env" HIVE_ROUTER_MEMORY_PROXY_TOKEN); calls=$(wc -l < "$temporary/docker.calls")
relink || fail 'The relink failed with Emberpath elsewhere'
[[ $(jq -r '.[0].localId' <<< "$(value "$config/hivemem.env" HIVEMEM_OATHWEAVE_SERVICES_JSON)") == emberpath ]] || fail 'The links did not move'
[[ $(value "$config/emberpath.env" HIVE_ROUTER_MEMORY_PROXY_TOKEN) == "$before" && $(wc -l < "$temporary/docker.calls") == "$calls" ]] || fail 'A token was issued for another host'
grep -q 're-issue it with hivemem-server issue-token --subject emberpath' "$directory/relink.log" || fail 'The operator was not told to re-issue the remote token'

# ---- An expired static token is left as it is; a token for another subject too. ----
input='{"placements":{"hivemem":{},"emberpath":{}}}'
setup "$temporary/expired"
expired="$(b64url '{"alg":"HS256"}').$(b64url '{"sub":"hive-router","role":"admin","exp":1}').fake-signature"
sed -i "s/^HIVE_ROUTER_MEMORY_PROXY_TOKEN=.*/HIVE_ROUTER_MEMORY_PROXY_TOKEN='$expired'/" "$config/emberpath.env"; pin_deployment_inputs_again() { rm "$directory/deployment-inputs.$plan.json"; pin_deployment_inputs "$directory/candidate.json"; }; pin_deployment_inputs_again
calls=$(wc -l < "$temporary/docker.calls")
relink || fail 'The relink failed with an expired token'
[[ $(value "$config/emberpath.env" HIVE_ROUTER_MEMORY_PROXY_TOKEN) == "$expired" && $(wc -l < "$temporary/docker.calls") == "$calls" ]] || fail 'An expired token was re-armed'
grep -q 'expired HIVE_ROUTER_MEMORY_PROXY_TOKEN' "$directory/relink.log" || fail 'The expired token was not reported'
other="$(b64url '{"alg":"HS256"}').$(b64url '{"sub":"operator","role":"admin","exp":4102444800}').fake-signature"
sed -i "s/^HIVE_ROUTER_MEMORY_PROXY_TOKEN=.*/HIVE_ROUTER_MEMORY_PROXY_TOKEN='$other'/" "$config/emberpath.env"; pin_deployment_inputs_again
relink || fail 'The relink failed with another subject'
[[ $(value "$config/emberpath.env" HIVE_ROUTER_MEMORY_PROXY_TOKEN) == "$other" ]] || fail 'A token for another subject was replaced'

# ---- The controller runs it right after the live schema migrations of an upgrade. ----
grep -A3 'hive_upgrade_schema_migrations "$directory/candidate.$plan.json" "$manifest"' "$ROOT/scripts/suite/host-runtime.sh" | grep -q 'hive_memory_identity_relink' || fail 'The upgrade does not re-link after the rename'
printf 'memory identity tests passed\n'
