#!/usr/bin/env bash
# Suite audit collection: which products the controller configures for each placement and pinned
# release, what the host steps write on install and upgrade, that a repeat changes nothing and
# never rotates a secret, and that no secret is printed. No containers are started.
set -Eeuo pipefail
ROOT=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)
export HIVE_ROOT=$ROOT
temporary=$(mktemp -d)
trap 'rm -rf -- "$temporary"' EXIT
fail() { printf 'FAIL: %s\n' "$*" >&2; exit 1; }
hive_die() { printf 'Hive: %s\n' "$*" >&2; exit 1; }
source "$ROOT/scripts/suite/audit-collection.sh"
value() { # FILE KEY: the effective value, quotes removed
  sed -n "s/^$2=//p" "$1" | tail -1 | sed "s/^'\(.*\)'$/\1/"
}
refused() { # MESSAGE COMMAND...
  local message=$1; shift
  if "$@" > "$temporary/result" 2>&1; then fail "Accepted: $*"; fi
  grep -q -- "$message" "$temporary/result" || { cat "$temporary/result" >&2; fail "Expected refusal '$message'"; }
}

# Each product is configured only from the release that ships its export: a version, or null
# until it is published.
jq -e '(keys==["ardentstudio","cindertrace","embermend","hivemem","hiveskills"]) and all(.[]; .==null or (type=="string" and test("^[0-9]+(\\.[0-9]+)*$")))' <<< "$(hive_audit_collection_releases)" >/dev/null ||
  fail 'The audit collection releases must name a version or null for each product'
released='{"cindertrace":"0.7.0","hivemem":"1.6.0","hiveskills":"1.7.0","ardentstudio":"0.4.0","embermend":"0.3.0"}'

# ---- The plan. ----
directory="$temporary/hosts/control"
config="$temporary/installation.json"
jq --arg d "$directory" '.profile="full" | .hosts.control.directory=$d |
  .components |= with_entries(if .value.envFile then .value.envFile=($d+"/config/"+.key+".env") else . end | if .value.configDirectory then .value.configDirectory=($d+"/config/"+.key) else . end) |
  .components += {cindertrace:{host:"control",envFile:($d+"/config/cindertrace.env"),configDirectory:($d+"/config/cindertrace")},
    "cindertrace-postgres":{host:"control",configDirectory:($d+"/config/cindertrace-postgres")},"cindertrace-redis":{host:"control",configDirectory:($d+"/config/cindertrace-redis")},
    ardentstudio:{host:"control",envFile:($d+"/config/ardentstudio.env"),configDirectory:($d+"/config/ardentstudio")},
    embermend:{host:"control",envFile:($d+"/config/embermend.env"),configDirectory:($d+"/config/embermend")},
    "embermend-worker":{host:"control",envFile:($d+"/config/embermend-worker.env"),configDirectory:($d+"/config/embermend-worker")}}' \
  "$ROOT/examples/installation.json" > "$config"
release="$temporary/release.json"
jq -n --slurpfile catalog "$ROOT/scripts/suite/suite-catalog.json" '{schema:1,version:"3.6.0",components:(
  {oathweave:"1.9.0",hivemem:"1.6.0",hiveskills:"1.7.0",cindertrace:"0.7.0",ardentstudio:"0.4.0",embermend:"0.3.0",emberpath:"1.0.0"}|
  with_entries(.key as $name|.value={version:.value,catalog:($catalog[0][$name]|del(.capabilities))}))}' > "$release"
export HIVE_CONFIG=$config HIVE_MANIFEST=$release HIVE_ID=example-suite
plan() { hive_audit_collection_plan; }
with_releases() { local table=$1; shift; (hive_audit_collection_releases() { printf '%s\n' "$table"; }; "$@"); }

unreleased='{"cindertrace":null,"hivemem":null,"hiveskills":null,"ardentstudio":null,"embermend":null}'
jq -e '.sources==[] and .notes==[]' <<< "$(with_releases "$unreleased" plan)" >/dev/null || fail 'An unreleased export is configured'
jq -e '.sources==[] and .notes==[]' <<< "$(with_releases '{"cindertrace":null,"hivemem":"1.6.0","hiveskills":"1.7.0","ardentstudio":null,"embermend":null}' plan)" >/dev/null || fail 'Configured without a collecting Cindertrace'
result=$(with_releases "$released" plan)
jq -e '.identityHost=="control" and .tokenOrigin=="https://oathweave:4200" and .apiUrl=="https://cindertrace:4101" and
  .sources==[{product:"hivemem",host:"control",clientId:"cindertrace-audit-hivemem",audience:"hivemem",url:"https://hivemem:18790/v1/audit/export"},
             {product:"hiveskills",host:"control",clientId:"cindertrace-audit-hiveskills",audience:"hiveskills",url:"https://hiveskills:4030/v1/audit/export"}]' <<< "$result" >/dev/null ||
  fail "Unexpected plan: $result"
# Studio and Embermend serve plain HTTP on the private network; the collector reads only HTTPS.
jq -e '(.notes|length)==2 and all(.notes[]; test("plain HTTP")) and (.notes[0]|startswith("ardentstudio")) and (.notes[1]|startswith("embermend"))' <<< "$result" >/dev/null || fail "Studio and Embermend are not explained: $result"
# A product pinned before its first exporting release, and a Cindertrace without the collector.
jq -e '.sources|map(.product)==["hivemem"]' <<< "$(with_releases '{"cindertrace":"0.7.0","hivemem":"1.6.0","hiveskills":"1.7.1","ardentstudio":null,"embermend":null}' plan)" >/dev/null || fail 'An older HiveSkills is configured'
jq -e '.sources==[] and .notes==[]' <<< "$(with_releases '{"cindertrace":"0.10.0","hivemem":"1.6.0","hiveskills":"1.7.0","ardentstudio":null,"embermend":null}' plan)" >/dev/null || fail 'A Cindertrace without the collector is configured'
jq '.components.hivemem.version="1.10.0"|.components.cindertrace.version="1.0.0"' "$release" > "$temporary/newer.json"
jq -e '.sources|map(.product)==["hivemem","hiveskills"]' <<< "$(HIVE_MANIFEST=$temporary/newer.json with_releases "$released" plan)" >/dev/null || fail 'Versions are not compared numerically'
# Without Cindertrace, or with none of the products, nothing is configured.
jq 'del(.components.cindertrace)' "$config" > "$temporary/none.json"
jq -e '.sources==[] and .notes==[]' <<< "$(HIVE_CONFIG=$temporary/none.json with_releases "$released" plan)" >/dev/null || fail 'Configured without Cindertrace'
jq 'del(.components.hivemem,.components.hiveskills,.components.ardentstudio,.components.embermend)' "$config" > "$temporary/none.json"
jq -e '.sources==[] and .notes==[]' <<< "$(HIVE_CONFIG=$temporary/none.json with_releases "$released" plan)" >/dev/null || fail 'Configured without products'
# The client secrets stay on the Oathweave host: a Cindertrace elsewhere is not configured.
jq '.hosts.security={target:"deploy@security.example.com",directory:"/opt/hive"} | .components.cindertrace.host="security"' "$config" > "$temporary/split.json"
jq -e '.sources==[] and (.notes|length)==1 and (.notes[0]|test("different hosts"))' <<< "$(HIVE_CONFIG=$temporary/split.json with_releases "$released" plan)" >/dev/null || fail 'A split Cindertrace is configured'
# Across hosts, a product is reached on its distributed HTTPS endpoint.
jq '.hosts.memory={target:"deploy@memory.example.com",directory:"/opt/hive"} | .components.hivemem.host="memory" | .components["hivemem-qdrant"].host="memory" |
  .bootstrap.productEndpoints={oathweave:{origin:"https://identity.example.com:4200"},hivemem:{origin:"https://memory.example.com:18790"},hiveskills:{origin:"https://hive.example.com:4030"},cindertrace:{origin:"https://hive.example.com:4101"}}' "$config" > "$temporary/distributed.json"
result=$(HIVE_CONFIG=$temporary/distributed.json with_releases "$released" plan)
jq -e '.tokenOrigin=="https://identity.example.com:4200" and .apiUrl=="https://hive.example.com:4101" and
  (.sources|map([.product,.host,.url]))==[["hivemem","memory","https://memory.example.com:18790/v1/audit/export"],["hiveskills","control","https://hive.example.com:4030/v1/audit/export"]]' <<< "$result" >/dev/null ||
  fail "Distributed endpoints are not used: $result"
# Another host and no HTTPS endpoint: unreachable from Cindertrace's network.
jq '.hosts.memory={target:"deploy@memory.example.com",directory:"/opt/hive"} | .components.hivemem.host="memory"' "$config" > "$temporary/unreachable.json"
jq -e '(.sources|map(.product))==["hiveskills"] and any(.notes[]; startswith("hivemem runs on another host"))' <<< "$(HIVE_CONFIG=$temporary/unreachable.json with_releases "$released" plan)" >/dev/null || fail 'An unreachable product is configured'

# ---- Install and upgrade: the host steps, through the controller, on one host. ----
# A release whose Studio and Embermend serve HTTPS inside the installation, so every product's
# acceptance is exercised.
jq '.components.ardentstudio.catalog.connection.internalEndpoints.api="https://ardentstudio:8097" | .components.embermend.catalog.connection.internalEndpoints.api="https://embermend:4180"' "$release" > "$temporary/https.json"
export HIVE_MANIFEST=$temporary/https.json
hive_host() { # HOST SCRIPT, as the controller sends it: the program, and the JSON request on stdin
  jq -c --arg host "$1" --arg action "$HIVE_HOST_ACTION" --argjson auditCollection "${HIVE_AUDIT_COLLECTION_INPUT:-null}" \
    '{directory:.hosts[$host].directory,host:$host,installation:.installation,action:$action,auditCollection:$auditCollection,placements:(.components|with_entries(select(.value.host==$host)))}' "$HIVE_CONFIG" |
    bash -c "$2"
}
mkdir -p -m 700 "$directory/config/.initializer" "$directory/config/cindertrace" "$directory/config/.credentials/cindertrace-collectors"
cfg="$directory/config"
cat > "$cfg/oathweave.env" <<'ENV'
JWT_ISSUER=oathweave-example-suite
IAM_MACHINE_CLIENT_POLICIES={"ardentstudio-hivemem":{"audience":"hivemem","permissions":["hivemem:memories:write"],"lifetimeSeconds":300,"rotationOwner":"hive-suite"}}
IAM_MACHINE_CLIENT_SECRETS={"ardentstudio-hivemem":"fake-studio-client-secret-0123456789abcdef"}
ENV
cat > "$cfg/hivemem.env" <<'ENV'
OATHWEAVE_JWKS_URL=https://oathweave:4200/api/v1/oauth/jwks
HIVEMEM_OATHWEAVE_SERVICES_JSON=[{"issuer":"oathweave-example-suite","clientId":"ardentstudio-hivemem","localId":"ardentstudio","scopes":["workspaces:write","memories:write"]}]
ENV
printf "OATHWEAVE_NATIVE_ISSUERS='fake-other-issuer'\nHIVE_SKILLS_PORT=4030\n" > "$cfg/hiveskills.env"
printf 'ARDENT_STUDIO_PORT=8097\n' > "$cfg/ardentstudio.env"
grants='[{"subject":"fake-operator","kind":"operator","permissions":["read"],"scope":{"installationId":"example-suite","applicationIds":[],"targetIds":[]}}]'
printf 'EMBERMEND_PORT=4180\nEMBERMEND_IDENTITY_GRANTS=%s\n' "$grants" > "$cfg/embermend.env"; cp "$cfg/embermend.env" "$cfg/embermend-worker.env"
printf 'SECURITY_INGEST_ENABLED=false\nSECURITY_FUSION_STATE_DIR=/data/collector\n' > "$cfg/cindertrace.env"
printf 'fake-unrelated\n' > "$cfg/emberpath.env"
chmod 600 "$cfg/"*.env
# A collector the operator added with hive.sh cindertrace-collector stays.
openssl rand -hex 32 > "$cfg/.credentials/cindertrace-collectors/edge"; chmod 600 "$cfg/.credentials/cindertrace-collectors/edge"
jq -n '{schema:1,id:"edge",allowedSources:["tailscale"]}' > "$cfg/.credentials/cindertrace-collectors/edge.json"
jq -n --arg d "$cfg" '{schema:1,phase:"complete",files:{($d+"/oathweave.env"):"stale",($d+"/cindertrace.env"):"stale",($d+"/hivemem.env"):"stale"}}' > "$cfg/.initializer/receipt.json"
cp "$cfg/emberpath.env" "$temporary/emberpath.before"

( hive_audit_collection_releases() { printf '%s\n' "$released"; }; hive_audit_collection_provision ) > "$temporary/provision.log" 2>&1 || { cat "$temporary/provision.log" >&2; fail 'Provisioning failed'; }
for product in hivemem hiveskills ardentstudio embermend; do
  secret_file="$cfg/.credentials/cindertrace-audit-$product"
  [[ $(cat "$secret_file") =~ ^[0-9a-f]{64}$ && $(stat -c %a "$secret_file") == 600 ]] || fail "The $product client secret is not a protected strong secret"
  ! grep -q "$(cat "$secret_file")" "$temporary/provision.log" || fail 'A secret was printed'
  cmp -s "$secret_file" "$cfg/cindertrace/audit-clients/cindertrace-audit-$product" || fail "Cindertrace lacks the $product client secret"
  [[ $(stat -c %a "$cfg/cindertrace/audit-clients/cindertrace-audit-$product") == 600 ]] || fail 'The collector copy is not owner-only'
done
[[ $(stat -c %a "$cfg/cindertrace/audit-clients") == 700 ]] || fail 'The collector secret directory is not owner-only'
jq -e 'keys==["ardentstudio-hivemem","cindertrace-audit-ardentstudio","cindertrace-audit-embermend","cindertrace-audit-hivemem","cindertrace-audit-hiveskills"] and
  .["cindertrace-audit-hivemem"]=={audience:"hivemem",permissions:["hivemem:audit:read"],lifetimeSeconds:300,rotationOwner:"hive-suite"} and
  .["cindertrace-audit-embermend"]=={audience:"embermend",permissions:["embermend:audit:read"],lifetimeSeconds:300,rotationOwner:"hive-suite"} and
  .["ardentstudio-hivemem"].permissions==["hivemem:memories:write"]' <<< "$(value "$cfg/oathweave.env" IAM_MACHINE_CLIENT_POLICIES)" >/dev/null || fail 'Oathweave lacks the audit client policies'
value "$cfg/oathweave.env" IAM_MACHINE_CLIENT_SECRETS | jq -e --rawfile memory "$cfg/.credentials/cindertrace-audit-hivemem" '.["cindertrace-audit-hivemem"]==($memory|rtrimstr("\n")) and .["ardentstudio-hivemem"]=="fake-studio-client-secret-0123456789abcdef" and length==5' >/dev/null || fail 'Oathweave lacks the audit client secrets'
value "$cfg/hivemem.env" HIVEMEM_OATHWEAVE_SERVICES_JSON | jq -e '.==[{issuer:"oathweave-example-suite",clientId:"ardentstudio-hivemem",localId:"ardentstudio",scopes:["workspaces:write","memories:write"]},
  {issuer:"oathweave-example-suite",clientId:"cindertrace-audit-hivemem",localId:"cindertrace-audit",scopes:["audit:read"]}]' >/dev/null || fail 'HiveMem does not link the audit client on the native issuer'
[[ $(value "$cfg/hiveskills.env" OATHWEAVE_NATIVE_ISSUERS) == fake-other-issuer,oathweave-example-suite ]] || fail 'HiveSkills does not accept the native issuer'
[[ $(value "$cfg/ardentstudio.env" OATHWEAVE_NATIVE_ISSUERS) == oathweave-example-suite ]] || fail 'Studio does not accept the native issuer'
[[ $(value "$cfg/embermend.env" OATHWEAVE_NATIVE_ISSUERS) == oathweave-example-suite ]] || fail 'Embermend does not accept the native issuer'
value "$cfg/embermend.env" EMBERMEND_IDENTITY_GRANTS | jq -e '.[0].subject=="fake-operator" and .[1]=={subject:"cindertrace-audit-embermend",kind:"integration",permissions:["audit:read"],scope:{installationId:"example-suite",applicationIds:[],targetIds:[]}} and length==2' >/dev/null || fail 'Embermend lacks the audit grant'
for key in EMBERMEND_IDENTITY_GRANTS OATHWEAVE_NATIVE_ISSUERS; do [[ $(value "$cfg/embermend-worker.env" "$key") == "$(value "$cfg/embermend.env" "$key")" ]] || fail "The Embermend worker differs in $key"; done
value "$cfg/cindertrace.env" SECURITY_COLLECTOR_AUDIT_SOURCES_JSON | jq -e '.==[
  {source:"ardentstudio",url:"https://ardentstudio:8097/api/ardentstudio/v1/audit/export",audience:"ardentstudio",scope:"ardentstudio:audit:read",clientId:"cindertrace-audit-ardentstudio",clientSecretFile:"/config/audit-clients/cindertrace-audit-ardentstudio"},
  {source:"embermend",url:"https://embermend:4180/api/v1/audit/export",audience:"embermend",scope:"embermend:audit:read",clientId:"cindertrace-audit-embermend",clientSecretFile:"/config/audit-clients/cindertrace-audit-embermend"},
  {source:"hivemem",url:"https://hivemem:18790/v1/audit/export",audience:"hivemem",scope:"hivemem:audit:read",clientId:"cindertrace-audit-hivemem",clientSecretFile:"/config/audit-clients/cindertrace-audit-hivemem"},
  {source:"hiveskills",url:"https://hiveskills:4030/v1/audit/export",audience:"hiveskills",scope:"hiveskills:audit:read",clientId:"cindertrace-audit-hiveskills",clientSecretFile:"/config/audit-clients/cindertrace-audit-hiveskills"}]' >/dev/null || fail 'The collector sources are wrong'
[[ $(value "$cfg/cindertrace.env" SECURITY_COLLECTOR_AUDIT_OATHWEAVE_URL) == https://oathweave:4200 && $(value "$cfg/cindertrace.env" CINDERTRACE_API_URL) == https://cindertrace:4101 &&
   $(value "$cfg/cindertrace.env" SECURITY_FUSION_COLLECTOR_ID) == suite-audit && $(value "$cfg/cindertrace.env" SECURITY_INGEST_ENABLED) == true ]] || fail 'The collector settings are wrong'
! grep -q '^SECURITY_FUSION_INGEST_SECRET=' "$cfg/cindertrace.env" || fail 'The API environment must not carry a collector ingest secret'
value "$cfg/cindertrace.env" SECURITY_FUSION_COLLECTOR_CREDENTIALS_JSON | jq -e --rawfile edge "$cfg/.credentials/cindertrace-collectors/edge" --rawfile audit "$cfg/.credentials/cindertrace-collectors/suite-audit" '
  .==({edge:{secret:($edge|rtrimstr("\n")),allowedSources:["tailscale"],displayName:"edge"},
       "suite-audit":{secret:($audit|rtrimstr("\n")),allowedSources:["ardentstudio","embermend","hivemem","hiveskills"],displayName:"suite-audit"}})' >/dev/null || fail 'The collector credentials are wrong'
jq -e '.==({schema:1,id:"suite-audit",allowedSources:["ardentstudio","embermend","hivemem","hiveskills"]})' "$cfg/.credentials/cindertrace-collectors/suite-audit.json" >/dev/null || fail 'The collector record is wrong'
cmp -s "$cfg/emberpath.env" "$temporary/emberpath.before" || fail 'An unrelated environment changed'
grep -q '^SECURITY_FUSION_STATE_DIR=/data/collector$' "$cfg/cindertrace.env" || fail 'Other Cindertrace settings changed'
for file in oathweave cindertrace hivemem; do
  [[ $(jq -r --arg path "$cfg/$file.env" '.files[$path]' "$cfg/.initializer/receipt.json") == "$(sha256sum "$cfg/$file.env" | cut -d ' ' -f1)" ]] || fail "The initializer receipt does not record the new $file.env"
  [[ $(stat -c %a "$cfg/$file.env") == 600 ]] || fail "$file.env is not owner-only"
done
grep -q '^Note:' "$temporary/provision.log" && fail 'A reachable product was reported as skipped'
grep -q '^Suite audit collection is configured for ardentstudio, embermend, hivemem, hiveskills\. The suite does not run the Cindertrace collector' "$temporary/provision.log" || fail 'The result is not reported'

# A repeat, as on every later upgrade, changes nothing and rotates nothing.
snapshot() { find "$cfg" -type f ! -name '*.lock' -print0 | sort -z | xargs -0 sha256sum; }
before=$(snapshot)
( hive_audit_collection_releases() { printf '%s\n' "$released"; }; hive_audit_collection_provision ) > /dev/null 2>&1 || fail 'A repeat failed'
[[ $(snapshot) == "$before" ]] || fail 'A repeat rewrote a file'
# A configuration whose Oathweave secrets were rewritten gets the same secrets back.
secret=$(cat "$cfg/.credentials/cindertrace-audit-hivemem")
sed -i '/^IAM_MACHINE_CLIENT_SECRETS=/d' "$cfg/oathweave.env"
( hive_audit_collection_releases() { printf '%s\n' "$released"; }; hive_audit_collection_provision ) > /dev/null 2>&1 || fail 'Restoring failed'
value "$cfg/oathweave.env" IAM_MACHINE_CLIENT_SECRETS | jq -e --arg secret "$secret" '.["cindertrace-audit-hivemem"]==$secret and (has("ardentstudio-hivemem")|not)' >/dev/null || fail 'A secret was rotated'
# An upgrade on which Studio and Embermend are no longer collected narrows the collector.
( hive_audit_collection_releases() { printf '%s\n' "$released"; }; HIVE_MANIFEST=$release; hive_audit_collection_provision ) > "$temporary/narrow.log" 2>&1 || fail 'Narrowing failed'
value "$cfg/cindertrace.env" SECURITY_COLLECTOR_AUDIT_SOURCES_JSON | jq -e 'map(.source)==["hivemem","hiveskills"]' >/dev/null || fail 'The collector still lists unreachable products'
jq -e '.allowedSources==["hivemem","hiveskills"]' "$cfg/.credentials/cindertrace-collectors/suite-audit.json" >/dev/null || fail 'The collector credential still admits them'
[[ $(grep -c 'plain HTTP' "$temporary/narrow.log") == 2 ]] || fail 'The skipped products are not explained'

# ---- Host step refusals. ----
script="$ROOT/scripts/suite/audit-collection-host.sh"
placements='{"oathweave":{},"cindertrace":{},"hivemem":{},"hiveskills":{}}'
step() { # ACTION REQUEST [PLACEMENTS]
  jq -nc --arg d "$directory" --arg action "$1" --argjson request "$2" --argjson placements "${3:-$placements}" \
    '{directory:$d,action:$action,auditCollection:$request,placements:$placements}' | bash "$script"
}
https='{"tokenOrigin":"https://oathweave:4200","apiUrl":"https://cindertrace:4101"}'
refused 'Unknown audit product' step audit-collection-identity '{"products":["emberpath"]}'
refused 'listed once' step audit-collection-identity '{"products":["hivemem","hivemem"]}'
refused 'Unknown audit product' step audit-collection-accept '{"product":"magnus","issuer":"oathweave-example-suite","installation":"example-suite"}'
refused 'Invalid issuer' step audit-collection-accept '{"product":"hivemem","issuer":"bad issuer","installation":"example-suite"}'
refused 'is not placed' step audit-collection-accept '{"product":"embermend","issuer":"oathweave-example-suite","installation":"example-suite"}'
refused 'HTTPS export URLs' step audit-collection-collector "$(jq -c '.+{sources:[{source:"ardentstudio",url:"http://ardentstudio:8097/api/ardentstudio/v1/audit/export"}]}' <<< "$https")"
refused 'HTTPS export URLs' step audit-collection-collector "$(jq -c '.+{sources:[{source:"hivemem",url:"https://user:fake@hivemem:18790/v1/audit/export"}]}' <<< "$https")"
refused 'Endpoints must be HTTPS' step audit-collection-collector '{"sources":[{"source":"hivemem","url":"https://hivemem:18790/v1/audit/export"}],"tokenOrigin":"http://oathweave:4200","apiUrl":"https://cindertrace:4101"}'
refused 'must share this host' step audit-collection-collector "$(jq -c '.+{sources:[{source:"hivemem",url:"https://hivemem:18790/v1/audit/export"}]}' <<< "$https")" '{"cindertrace":{}}'
printf 'x\n' > "$cfg/.credentials/cindertrace-audit-hiveskills"
refused 'Invalid protected secret' step audit-collection-identity '{"products":["hiveskills"]}'
chmod 644 "$cfg/hivemem.env"
refused 'must be owner-only' step audit-collection-accept '{"product":"hivemem","issuer":"oathweave-example-suite","installation":"example-suite"}'
chmod 600 "$cfg/hivemem.env"; sed -i '/^OATHWEAVE_JWKS_URL=/d' "$cfg/hivemem.env"
refused 'no OATHWEAVE_JWKS_URL' step audit-collection-accept '{"product":"hivemem","issuer":"oathweave-example-suite","installation":"example-suite"}'
mv "$cfg/cindertrace.env" "$temporary/real.env"; ln -s "$temporary/real.env" "$cfg/cindertrace.env"
refused 'environment is missing' step audit-collection-collector "$(jq -c '.+{sources:[{source:"hivemem",url:"https://hivemem:18790/v1/audit/export"}]}' <<< "$https")"

# ---- The controller runs it on install and upgrade and ships the host step. ----
grep -q 'install|upgrade) hive_audit_collection_provision' "$ROOT/scripts/suite/lifecycle.sh" || fail 'Install and upgrade do not configure audit collection'
grep -q 'scripts/suite/audit-collection.sh scripts/suite/audit-collection-host.sh' "$ROOT/scripts/suite/controller.sh" || fail 'The steps are not part of the controller bundle'
grep -q 'auditCollection:\$auditCollection' "$ROOT/scripts/suite/controller.sh" || fail 'The host request is not transported'
grep -q 'source "$HIVE_ROOT/scripts/suite/audit-collection.sh"' "$ROOT/hive.sh" || fail 'hive.sh does not load the step'
printf 'audit collection tests passed\n'
