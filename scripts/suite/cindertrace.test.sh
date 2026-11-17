#!/usr/bin/env bash
# hive.sh cindertrace-collector against a synthetic installed Cindertrace and a stubbed Docker.
set -Eeuo pipefail
ROOT=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)
temporary=$(mktemp -d)
trap 'rm -rf -- "$temporary"' EXIT
fail() { printf 'FAIL: %s\n' "$*" >&2; exit 1; }
reject() { if ( "$@" ) > "$temporary/rejection.log" 2>&1; then fail "Accepted: $*"; fi; }
install="$temporary/install"
jq --arg root "$install" '.profile="full" | .hosts.control.directory=$root |
  .components += (["magnus","magnus-postgres","magnus-redis","cindertrace","cindertrace-postgres","cindertrace-redis"]|map({key:.,value:{host:"control"}})|from_entries) |
  .components|=with_entries(.key as $name|.value=({host:"control"}+(if $name=="hivexui" then {} elif ($name|test("-(redis|postgres|qdrant)$")) then {configDirectory:($root+"/config/"+$name)} else {envFile:($root+"/config/"+$name+".env"),configDirectory:($root+"/config/"+$name)} end))) |
  .console.runtimeFile=($root+"/config/runtime.json")' "$ROOT/examples/installation.json" > "$temporary/config.json"
openssl genpkey -algorithm ED25519 -out "$temporary/publisher.key" >/dev/null 2>&1
openssl pkey -in "$temporary/publisher.key" -pubout -out "$temporary/publisher.pub" >/dev/null 2>&1
jq -n --slurpfile c "$temporary/config.json" '{schema:1,version:"0.1.0",profiles:{core:($c[0].components|keys),full:($c[0].components|keys)},components:($c[0].components|map_values({image:("example.com/synthetic@sha256:"+("0"*64)),service:{user:"1000:1000",healthcheck:{test:["CMD","true"]}}}))} | .components.hivexui.kind="static-ui" | .components.ingress.kind="ingress" | reduce ("magnus","cindertrace") as $n (.;.components[$n].initialization={image:("example.com/migrator@sha256:"+("1"*64)),command:["apply"],verificationCommand:["verify-current"]})' > "$temporary/release.json"
source "$ROOT/scripts/suite/test-catalog.sh"; hive_test_catalog "$temporary/release.json"
openssl pkeyutl -sign -inkey "$temporary/publisher.key" -rawin -in "$temporary/release.json" -out "$temporary/release.json.sig"
hive() { "$ROOT/hive.sh" "$@" --config "$temporary/config.json" --manifest "$temporary/release.json" --trust-key "$temporary/publisher.pub" --non-interactive; }

# An installed Cindertrace: its owner-only environment, recorded by the initializer and pinned
# with the plan's deployment inputs.
mkdir -p "$install/config/.initializer" "$temporary/bin"
printf "NODE_ENV=production\nSECURITY_WRITES_ENABLED=true\nSECURITY_INGEST_ENABLED=false\nSECURITY_DISPATCH_ENABLED=false\n" > "$install/config/cindertrace.env"
chmod 600 "$install/config/cindertrace.env"
jq -n --arg env "$install/config/cindertrace.env" '{services:{cindertrace:{env_file:[$env]}}}' > "$install/compose.json"
jq -n --arg path "$install/config/cindertrace.env" --arg sha "$(sha256sum "$install/config/cindertrace.env" | cut -d ' ' -f1)" '{schema:1,phase:"complete",files:{($path):$sha}}' > "$install/config/.initializer/receipt.json"
chmod 600 "$install/config/.initializer/receipt.json"
plan=$(hive plan | jq -r .planDigest)
digest() { (source "$ROOT/scripts/suite/input-artifacts-host.sh"; deployment_inputs_digest "$install/compose.json"); }
jq -n --arg sha "$(digest)" '{schema:1,sha256:$sha}' > "$install/deployment-inputs.$plan.json"
cat > "$temporary/bin/docker" <<SH
#!/usr/bin/env bash
case "\$*" in
  'compose -f $install/compose.json up -d --no-deps --force-recreate cindertrace') printf 'recreated\n' >> '$temporary/docker.log';;
  'compose -f $install/compose.json ps -q cindertrace') printf 'cindertrace-container\n';;
  'inspect -f '*' cindertrace-container') printf 'healthy\n';;
  'compose -f $install/compose.json up -d --no-deps --force-recreate cindertrace-collector') printf 'collector recreated\n' >> '$temporary/docker.log';;
  'compose -f $install/compose.json ps -q cindertrace-collector') printf 'collector-container\n';;
  'inspect -f '*' collector-container') printf 'healthy\n';;
  *) exit 99;;
esac
SH
# Record every jq argv, including short-lived processes, without relying on timing ps.
cat > "$temporary/bin/jq" <<SH
#!/usr/bin/env bash
printf '%s\\0' "\$@" >> '$temporary/jq-arguments'
exec /usr/bin/jq "\$@"
SH
chmod 700 "$temporary/bin/jq"
chmod 700 "$temporary/bin/docker"
export PATH="$temporary/bin:$PATH"
env_value() { sed -n "s/^$1='\(.*\)'\$/\1/p" "$install/config/cindertrace.env"; }

hive cindertrace-collector add edge --sources tailscale,hive > "$temporary/add.log" || { cat "$temporary/add.log" >&2; fail 'add failed'; }
secret="$install/config/.credentials/cindertrace-collectors/edge"
[[ -f "$secret" && $(stat -c %a "$secret") == 600 && $(stat -c %a "$(dirname "$secret")") == 700 ]] || fail 'The credential is not in an owner-only file'
[[ $(cat "$secret") =~ ^[0-9a-f]{64}$ ]] || fail 'The credential is not a generated secret'
! grep -qF "$(cat "$secret")" "$temporary/add.log" || fail 'add printed the credential'
grep -qF "$secret" "$temporary/add.log" || { cat "$temporary/add.log" >&2; fail "add did not name the credential file"; }
[[ $(env_value SECURITY_INGEST_ENABLED) == true ]] || fail 'Ingestion is not on'
env_value SECURITY_FUSION_COLLECTOR_CREDENTIALS_JSON | jq -e --rawfile secret "$secret" '.edge=={secret:($secret|rtrimstr("\n")),allowedSources:["hive","tailscale"],displayName:"edge"} and length==1' >/dev/null || fail 'The collector registry is wrong'
[[ $(grep -c '^SECURITY_INGEST_ENABLED=' "$install/config/cindertrace.env") == 1 ]] && grep -qx 'SECURITY_WRITES_ENABLED=true' "$install/config/cindertrace.env" || fail 'Other settings changed'
[[ $(stat -c %a "$install/config/cindertrace.env") == 600 ]] || fail 'The environment is no longer owner-only'
jq -e --arg path "$install/config/cindertrace.env" --arg sha "$(sha256sum "$install/config/cindertrace.env" | cut -d ' ' -f1)" '.files[$path]==$sha' "$install/config/.initializer/receipt.json" >/dev/null || fail 'The initializer record was not moved'
[[ $(jq -r .sha256 "$install/deployment-inputs.$plan.json") == "$(digest)" ]] || fail 'The deployment inputs were not re-pinned'
[[ $(wc -l < "$temporary/docker.log") == 1 ]] || fail 'Cindertrace was not recreated once'

# Repeating the same request changes nothing; other sources for the same ID are refused.
before=$(sha256sum "$install/config/cindertrace.env" "$secret")
hive cindertrace-collector add edge --sources hive,tailscale > /dev/null || fail 'An identical add failed'
[[ $(sha256sum "$install/config/cindertrace.env" "$secret") == "$before" && $(wc -l < "$temporary/docker.log") == 1 ]] || fail 'An identical add changed something'
reject hive cindertrace-collector add edge --sources wazuh
grep -q 'already exists with other sources' "$temporary/rejection.log" || fail 'A source change was not refused clearly'

hive cindertrace-collector add lab --sources wazuh > /dev/null
# Neither an individual secret nor the combined registry may reach process arguments.
python3 - "$install/config/.credentials/cindertrace-collectors" "$temporary/jq-arguments" <<'CHECK'
import pathlib, sys
store, arguments = pathlib.Path(sys.argv[1]), pathlib.Path(sys.argv[2]).read_bytes()
for name in ('edge', 'lab'):
    assert store.joinpath(name).read_bytes().strip() not in arguments, 'Collector secret reached process arguments'
CHECK
hive cindertrace-collector list > "$temporary/list.json"
jq -e 'map(.id)==["edge","lab"] and all(.[]; has("credentialFile") and (has("secret")|not))' "$temporary/list.json" >/dev/null || fail 'list is wrong or shows a secret'
! grep -qF "$(cat "$secret")" "$temporary/list.json" || fail 'list printed a credential'

# Refused before anything reaches the host.
for arguments in 'add Bad --sources tailscale' 'add edge' 'add x --sources tailscale,unknown' 'add x --sources cindertrace_ui' 'remove' 'list extra' 'rotate edge' 'add x --sources tailscale --secret abc'; do
  # shellcheck disable=SC2086
  reject hive cindertrace-collector $arguments
done
reject "$ROOT/hive.sh" plan --sources tailscale --config "$temporary/config.json" --non-interactive

# Removing revokes; removing the last turns ingestion off.
hive cindertrace-collector remove lab > /dev/null
[[ ! -e "$install/config/.credentials/cindertrace-collectors/lab" ]] || fail 'remove kept the credential'
env_value SECURITY_FUSION_COLLECTOR_CREDENTIALS_JSON | jq -e 'keys==["edge"]' >/dev/null || fail 'remove did not revoke'
hive cindertrace-collector remove edge > "$temporary/remove.log"
[[ $(env_value SECURITY_INGEST_ENABLED) == false ]] && [[ $(env_value SECURITY_FUSION_COLLECTOR_CREDENTIALS_JSON) == '{}' ]] || fail 'Removing the last collector left ingestion on'
grep -q 'ingestion is off' "$temporary/remove.log" || fail 'remove did not say ingestion is off'
reject hive cindertrace-collector remove edge

# A Cindertrace environment that is not owner-only, or an installation without Cindertrace, is refused.
chmod 640 "$install/config/cindertrace.env"
reject hive cindertrace-collector add edge --sources tailscale
chmod 600 "$install/config/cindertrace.env"
jq '.profile="custom" | del(.components.cindertrace,.components["cindertrace-postgres"],.components["cindertrace-redis"])' "$temporary/config.json" > "$temporary/core.json"
if "$ROOT/hive.sh" cindertrace-collector list --config "$temporary/core.json" --manifest "$temporary/release.json" --trust-key "$temporary/publisher.pub" --non-interactive > "$temporary/core.log" 2>&1; then fail 'An installation without Cindertrace was accepted'; fi
grep -q "no Cindertrace" "$temporary/core.log" || { cat "$temporary/core.log" >&2; fail "The missing Cindertrace refusal is unclear"; }
# --run: the collector the installation runs (component cindertrace-collector), from its owner-only
# source settings beside the credential. No secret reaches an argument or the output.
store="$install/config/.credentials/cindertrace-collectors"
mkdir -p "$install/config/cindertrace"; printf 'example authority\n' > "$install/config/cindertrace/authority.pem"
reject hive cindertrace-collector add logs --sources unifi_ids,unifi_dns,netflow --run
grep -q 'Write the source settings' "$temporary/rejection.log" || { cat "$temporary/rejection.log" >&2; fail 'A missing sources file was not explained'; }
[[ ! -e "$install/config/cindertrace-collector.env" ]] || fail 'A refused --run wrote the collector environment'
token=$(openssl rand -hex 32)
printf '# Loki on the logging host\nLOKI_URL=https://logs.example.com:3443\nLOKI_QUERY='"'"'{syslog_hostname="FIREWALL"}'"'"'\nLOKI_READ_TOKEN=%s\nUI_SECURITY_SOURCES_JSON={"magnus_ui":["{job=\\"magnus\\"}"]}\n' "$token" > "$store/logs.sources.env"
chmod 600 "$store/logs.sources.env"
: > "$temporary/jq-arguments"
hive cindertrace-collector add logs --sources unifi_ids,unifi_dns,netflow,magnus_ui --run > "$temporary/run.log" || { cat "$temporary/run.log" >&2; fail 'add --run failed'; }
collector_env="$install/config/cindertrace-collector.env"
cvalue() { sed -n "s/^$1='\(.*\)'\$/\1/p" "$collector_env"; }
[[ $(stat -c %a "$collector_env") == 600 && $(cvalue SECURITY_FUSION_COLLECTOR_ID) == logs && $(cvalue SECURITY_FUSION_INGEST_SECRET) == "$(cat "$store/logs")" ]] || fail 'The collector identity or credential is wrong'
[[ $(cvalue CINDERTRACE_API_URL) == https://cindertrace:4101 && $(cvalue SECURITY_FUSION_STATE_DIR) == /data && $(cvalue NODE_EXTRA_CA_CERTS) == /config/authority.pem && $(cvalue SECURITY_FUSION_UDP_ENABLED) == false ]] || fail 'The generated collector settings are wrong'
[[ $(cvalue LOKI_READ_TOKEN) == "$token" && $(cvalue LOKI_QUERY) == '{syslog_hostname="FIREWALL"}' && $(cvalue UI_SECURITY_SOURCES_JSON) == '{"magnus_ui":["{job=\"magnus\"}"]}' ]] || fail 'The source settings were not carried over'
cmp -s "$install/config/cindertrace/authority.pem" "$install/config/cindertrace-collector/authority.pem" && [[ $(stat -c %a "$install/config/cindertrace-collector") == 700 ]] || fail 'The collector does not trust the installation authority'
grep -q 'start it with ./hive.sh add cindertrace-collector' "$temporary/run.log" || { cat "$temporary/run.log" >&2; fail 'The next step was not named'; }
! grep -qF "$token" "$temporary/run.log" && ! grep -qF "$(cat "$store/logs")" "$temporary/run.log" || fail '--run printed a secret'
python3 - "$temporary/jq-arguments" "$token" "$(cat "$store/logs")" <<'CHECK'
import pathlib, sys
arguments = pathlib.Path(sys.argv[1]).read_bytes()
for secret in sys.argv[2:]:
    assert secret.encode() not in arguments, 'A collector secret reached process arguments'
CHECK
hive cindertrace-collector list | jq -e '.[]|select(.id=="logs")|.runs==true and (.sourcesFile|endswith("/logs.sources.env"))' >/dev/null || fail 'list does not show the running collector'
reject hive cindertrace-collector remove logs
grep -q 'runs in this installation' "$temporary/rejection.log" || fail 'Removing the running collector was not refused clearly'
reject hive cindertrace-collector add other --sources wazuh --run
grep -q 'Collector logs already runs' "$temporary/rejection.log" || fail 'A second running collector was not refused'
# Only source settings are accepted, and the URLs are verified HTTPS.
cp "$store/logs.sources.env" "$temporary/sources.good"
for line in 'SECURITY_FUSION_COLLECTOR_ID=edge' 'CINDERTRACE_API_URL=https://elsewhere.example.com' 'LOKI_URL=http://logs.example.com:3100' 'not a setting'; do
  { grep -v '^LOKI_URL=' "$temporary/sources.good"; [[ "$line" == LOKI_URL=* ]] || grep '^LOKI_URL=' "$temporary/sources.good"; printf '%s\n' "$line"; } > "$store/logs.sources.env"
  before=$(sha256sum "$collector_env")
  reject hive cindertrace-collector add logs --sources unifi_ids,unifi_dns,netflow,magnus_ui --run
  [[ $(sha256sum "$collector_env") == "$before" ]] || fail "Refused sources ($line) changed the collector environment"
done
cp "$temporary/sources.good" "$store/logs.sources.env"
# Once the component runs, changed settings recreate only the collector.
jq --arg env "$collector_env" '.services["cindertrace-collector"]={env_file:[$env]}' "$install/compose.json" > "$install/compose.next"; mv "$install/compose.next" "$install/compose.json"
hive cindertrace-collector add logs --sources unifi_ids,unifi_dns,netflow,magnus_ui --run > "$temporary/run.log"
grep -q 'settings are unchanged' "$temporary/run.log" && ! grep -q 'collector recreated' "$temporary/docker.log" || fail 'Unchanged settings recreated the collector'
printf 'LOKI_LIMIT=500\n' >> "$store/logs.sources.env"
hive cindertrace-collector add logs --sources unifi_ids,unifi_dns,netflow,magnus_ui --run > "$temporary/run.log"
[[ $(cvalue LOKI_LIMIT) == 500 && $(grep -c 'collector recreated' "$temporary/docker.log") == 1 ]] || fail 'Changed settings did not recreate the collector once'
printf 'Passed: Cindertrace collector credentials generated into owner-only files and never printed, ingestion on while a collector exists, idempotent add, revocation, recorded and re-pinned environment, input refusal, and the collector the installation runs from owner-only source settings.\n'
