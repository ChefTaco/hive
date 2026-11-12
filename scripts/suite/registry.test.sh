#!/usr/bin/env bash
# Hive Registry controller behaviour: mandatory placement, release checks, credential
# provisioning, write-failure handling and drift reporting. No containers are started.
set -Eeuo pipefail
ROOT=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)
source "$ROOT/scripts/suite/test-catalog.sh"
temporary=$(mktemp -d)
trap 'rm -rf -- "$temporary"' EXIT
fail() { printf 'FAIL: %s\n' "$*" >&2; exit 1; }
mkdir -m 700 "$temporary/bin"
directory="$temporary/install"
user="$(id -u):$(id -g)"
openssl genpkey -algorithm ED25519 -out "$temporary/publisher.key" >/dev/null 2>&1
openssl pkey -in "$temporary/publisher.key" -pubout -out "$temporary/publisher.pub" >/dev/null 2>&1
sign() { openssl pkeyutl -sign -inkey "$temporary/publisher.key" -rawin -in "$1" -out "$1.sig"; }
jq --arg base "$directory" '.hosts.control.directory=$base | .console.runtimeFile=($base+"/config/runtime.json") | .components|=with_entries(.key as $name|if .value.envFile then .value.envFile=($base+"/config/"+$name+".env") else . end|if .value.configDirectory then .value.configDirectory=($base+"/config/"+$name) else . end)' "$ROOT/examples/installation.json" > "$temporary/config.json"
jq -n --slurpfile c "$temporary/config.json" --arg user "$user" '{schema:1,version:"0.1.0",profiles:{core:($c[0].components|keys),full:($c[0].components|keys)},components:($c[0].components|with_entries(.value={image:("example.com/"+.key+"@sha256:"+("a"*64)),storageFormat:(.key+"-v1"),version:"2.0.0",service:{user:$user,healthcheck:{test:["CMD","true"]}}}))} | .components.hivexui.kind="static-ui" | .components.hivexui.service.user="101:101" | .components.ingress.kind="ingress" | .components["oathweave-redis"].kind="datastore" | .components["hivemem-qdrant"].kind="datastore"' > "$temporary/release.json"
hive_test_catalog "$temporary/release.json"
sign "$temporary/release.json"
hive() { local command=$1 config=$2 manifest=${3:-$temporary/release.json}; "$ROOT/hive.sh" "$command" --config "$config" --manifest "$manifest" --trust-key "$temporary/publisher.pub" --non-interactive; }
refused() { # MESSAGE COMMAND...
  local message=$1; shift
  if "$@" > "$temporary/result" 2>&1; then fail "Accepted: $*"; fi
  grep -q -- "$message" "$temporary/result" || { cat "$temporary/result" >&2; fail "Expected refusal '$message'"; }
}

# Mandatory in every configuration, with a clear message.
jq 'del(.components["hive-registry"])' "$temporary/config.json" > "$temporary/legacy.json"
for command in init install plan; do refused 'The Hive Registry is mandatory' hive "$command" "$temporary/legacy.json"; done
jq '.profile="custom"|del(.components["hive-registry"])' "$temporary/config.json" > "$temporary/custom.json"
refused 'The Hive Registry is mandatory' hive install "$temporary/custom.json"
# Same host as the console and standard protected paths.
jq '.hosts.other={target:"local",directory:($d+"-other")}|.components["hive-registry"].host="other"' --arg d "$directory" "$temporary/config.json" > "$temporary/bad.json"
refused 'same host as the console' hive plan "$temporary/bad.json"
jq '.components["hive-registry"].envFile="/opt/elsewhere/registry.env"' "$temporary/config.json" > "$temporary/bad.json"
refused 'same host as the console' hive plan "$temporary/bad.json"

# Mandatory in every signed release that deploys anything.
jq 'del(.components["hive-registry"])|.profiles|=map_values(map(select(.!="hive-registry")))' "$temporary/release.json" > "$temporary/legacy-release.json"; sign "$temporary/legacy-release.json"
for command in install plan init upgrade adopt; do refused 'This release has no Hive Registry' hive "$command" "$temporary/config.json" "$temporary/legacy-release.json"; done
for patch in '.profiles.core-=["hive-registry"]' '.profiles.full-=["hive-registry"]' 'del(.components["hive-registry"].storageFormat)' '.components["hive-registry"].kind="datastore"'; do
  jq "$patch" "$temporary/release.json" > "$temporary/bad-release.json"; sign "$temporary/bad-release.json"
  refused 'mandatory in every release profile' hive plan "$temporary/config.json" "$temporary/bad-release.json"
done
for patch in 'del(.components.emberpath.catalog)' '.components.emberpath.catalog.displayName=""' '.components.emberpath.catalog.documentation="http://example.com/docs"' '.components.emberpath.catalog.repository="https://user:fake@example.com/x"' '.components.emberpath.catalog.apiKey="fake"' '.components.emberpath.catalog.connection.internalEndpoints.api="https://user:fake@example.com"'; do
  jq "$patch" "$temporary/release.json" > "$temporary/bad-release.json"; sign "$temporary/bad-release.json"
  refused 'valid catalog metadata' hive plan "$temporary/config.json" "$temporary/bad-release.json"
done
# Optional capabilities: a name and a path under the product's browser prefix, nothing else.
for patch in '.components.emberpath.catalog.capabilities={}' '.components.emberpath.catalog.capabilities={"Events":{path:"/v1/hive/events"}}' \
  '.components.emberpath.catalog.capabilities={"events.v1":{path:"v1/hive/events"}}' '.components.emberpath.catalog.capabilities={"events.v1":{path:"/a/../b"}}' \
  '.components.emberpath.catalog.capabilities={"events.v1":{path:"/v1/hive/events",since:"1.0.0"}}' '.components.emberpath.catalog.capabilities={"events.v1":"/v1/hive/events"}' \
  '.components.hivexui.catalog.capabilities={"events.v1":{path:"/v1/hive/events"}}'; do
  jq "$patch" "$temporary/release.json" > "$temporary/bad-release.json"; sign "$temporary/bad-release.json"
  refused 'valid catalog metadata' hive plan "$temporary/config.json" "$temporary/bad-release.json"
done
jq '.components.emberpath.catalog.capabilities={"events.v1":{path:"/v1/hive/events"},"future-thing.v2":{path:"/v2/x"}}' "$temporary/release.json" > "$temporary/capabilities-release.json"; sign "$temporary/capabilities-release.json"
hive plan "$temporary/config.json" "$temporary/capabilities-release.json" > /dev/null 2>&1 || fail 'A release with valid capabilities was refused'

# Upgrading a configuration from before the registry adds it without rewriting the file.
legacy_before=$(sha256sum "$temporary/legacy.json")
for attempt in 1 2; do
  if hive upgrade "$temporary/legacy.json" > "$temporary/upgrade-$attempt.plan" 2> "$temporary/upgrade-$attempt.err"; then fail 'Upgrade applied without confirmation'; fi
  grep -q 'no hive-registry component' "$temporary/upgrade-$attempt.err" || fail 'Upgrade did not announce the added registry'
done
jq -e '.components["hive-registry"].host=="control" and .components["hive-registry"].environmentConfigured' "$temporary/upgrade-1.plan" >/dev/null || fail 'Upgrade plan does not add the registry'
[[ $(jq -r .planDigest "$temporary/upgrade-1.plan") == "$(jq -r .planDigest "$temporary/upgrade-2.plan")" ]] || fail 'Derived upgrade plan is not stable'
[[ $(sha256sum "$temporary/legacy.json") == "$legacy_before" ]] || fail 'The operator configuration was rewritten'
# A rollback may return to a release from before the registry, and drops it from the plan.
if hive rollback "$temporary/config.json" "$temporary/legacy-release.json" > "$temporary/rollback.plan" 2>/dev/null; then fail 'Rollback applied without confirmation'; fi
jq -e '.components|has("hive-registry")|not' "$temporary/rollback.plan" >/dev/null || fail 'Legacy rollback plan still includes the registry'

# The registry starts first on its host. Datastores and other hosts are not tied to it.
export HIVE_ROOT=$ROOT
source "$ROOT/scripts/suite/controller.sh"; source "$ROOT/scripts/suite/registry.sh"; source "$ROOT/scripts/suite/lifecycle.sh"
HIVE_CONFIG=$temporary/config.json HIVE_MANIFEST=$temporary/release.json HIVE_SIGNATURE=$temporary/release.json.sig HIVE_TRUST_KEY=$temporary/publisher.pub HIVE_VERSION=0.1.0 HIVE_OPERATION=install HIVE_ID=example-suite
hive_validate; hive_manifest
hive_render control > "$temporary/compose.json"
jq -e '
  (.services.emberpath.depends_on["hive-registry"].condition=="service_healthy") and (.services.ingress.depends_on["hive-registry"]!=null) and
  (.services["oathweave-redis"]|has("depends_on")|not) and (.services["hive-registry"]|has("depends_on")|not) and
  (.services["hive-registry"].read_only==true) and (.services["hive-registry"].cap_drop==["ALL"]) and (.services["hive-registry"]|has("ports")|not) and
  (.services["hive-registry"].environment.HIVE_AUTO_MIGRATE=="false")' "$temporary/compose.json" >/dev/null || fail 'Registry start ordering or hardening is wrong'

# The record comes from the signed manifest and this configuration. No credential field exists.
hive_registry_body complete installed > "$temporary/body.json"
jq -e --arg origin "$(jq -r .origin "$temporary/config.json")" '
  (.release.version=="0.1.0") and (.catalog|length==9) and (.installed|length==9) and
  (.catalog|map(select(.id=="emberpath"))[0]|.displayName=="Emberpath" and .required==false and .consoleSection=="models" and .version.version=="2.0.0" and .version.imageDigest==("sha256:"+("a"*64)) and .version.storageFormat=="emberpath-v1" and (.dependencies|index("oathweave")!=null)) and
  (.catalog|map(select(.id=="hive-registry"))[0].required==true) and
  (.installed|map(select(.id=="emberpath"))[0]|.status=="installed" and .inventoryHost=="control" and .connection.browserPrefix=="/api/emberpath" and .connection.nativeApis.model==($origin+"/v1") and .connection.internalEndpoints.admin=="https://emberpath:9443")
' "$temporary/body.json" >/dev/null || fail 'Registry record does not reflect the manifest'
if jq -r '[paths|map(tostring)|join(".")]|join("\n")' "$temporary/body.json" | grep -Eiq 'password|secret|token|private'; then fail 'Registry record has a credential field'; fi
jq --arg base "$directory" '.bootstrap.productEndpoints={emberpath:{origin:"https://models.example.com:9443",inferenceOrigin:"https://models.example.com:4020",bindAddress:"127.0.0.1",certificateFile:"/opt/x",privateKeyFile:"/opt/y"}}' "$temporary/config.json" > "$temporary/distributed.json"
HIVE_CONFIG=$temporary/distributed.json hive_registry_body complete installed | jq -e '.installed|map(select(.id=="emberpath"))[0].connection.internalEndpoints=={admin:"https://models.example.com:9443",model:"https://models.example.com:4020"}' >/dev/null || fail 'Distributed endpoints are not recorded'
# Capabilities are recorded with the connection of the product that offers them, and only there.
HIVE_MANIFEST=$temporary/capabilities-release.json hive_registry_body complete installed | jq -e '
  (.installed|map(select(.id=="emberpath"))[0].connection.capabilities=={"events.v1":{path:"/v1/hive/events"},"future-thing.v2":{path:"/v2/x"}}) and
  ([.installed[]|select(.id!="emberpath")|.connection|has("capabilities")]|all|not) and ([.catalog[]|has("capabilities")]|any|not)' >/dev/null || fail 'Capabilities are not recorded with the connection'
jq -e '[.installed[].connection|has("capabilities")]|any|not' "$temporary/body.json" >/dev/null || fail 'A release without capabilities recorded some'
jq '.components.magnus=(.components.emberpath|.catalog.connection.browserPrefix="/api/magnus"|.catalog.capabilities={"events.v1":{path:"/api/v1/hive/events"}})' "$temporary/release.json" > "$temporary/magnus-release.json"
jq '.external={magnus:{url:"https://magnus.example.com:4000"}}' "$temporary/config.json" > "$temporary/external-capabilities.json"
HIVE_CONFIG=$temporary/external-capabilities.json HIVE_MANIFEST=$temporary/magnus-release.json hive_registry_body complete installed | jq -e '
  .installed|map(select(.id=="magnus"))[0]|.status=="external" and .connection.capabilities=={"events.v1":{path:"/api/v1/hive/events"}} and .connection.internalEndpoints=={api:"https://magnus.example.com:4000"}' >/dev/null || fail 'An external product lost its capabilities'

# Credentials are generated once, protected, and stable across retries.
provision() { HIVE_OPERATION=$1 hive_registry_provision; }
HIVE_CONFIG=$temporary/config.json
provision install
config="$directory/config/hive-registry"
read_token=$(cat "$config/read-token"); write_token=$(cat "$config/write-token")
[[ "$read_token" =~ ^[a-f0-9]{64}$ && "$write_token" =~ ^[a-f0-9]{64}$ && "$read_token" != "$write_token" ]] || fail 'Weak or shared registry credentials'
[[ $(stat -c %a "$config/read-token") == 600 && $(stat -c %a "$config/write-token") == 600 && $(stat -c %a "$directory/config/hive-registry.env") == 600 && $(stat -c %a "$config") == 700 ]] || fail 'Registry credential permissions'
if grep -q "$write_token\|$read_token" "$directory/config/hive-registry.env"; then fail 'Credential reached the environment file'; fi
[[ ! -d "$directory/data" ]] || fail 'A fresh install created registry data before initialization'
find "$directory/config" -type f -exec sha256sum {} + | sort > "$temporary/provision.before"
provision install
find "$directory/config" -type f -exec sha256sum {} + | sort > "$temporary/provision.after"
cmp -s "$temporary/provision.before" "$temporary/provision.after" || fail 'Provisioning changed existing artifacts'
# An interrupted generation resumes with the bytes already on disk.
mv "$config/read-token" "$config/read-token.pending"
provision install
[[ $(cat "$config/read-token") == "$read_token" && ! -e "$config/read-token.pending" ]] || fail 'Interrupted credential generation changed the credential'
printf 'OPERATOR_OWNED=retained\n' > "$directory/config/hive-registry.env"
if (provision install) > "$temporary/result" 2>&1; then fail 'Provisioning overwrote a changed environment'; fi
[[ $(cat "$directory/config/hive-registry.env") == OPERATOR_OWNED=retained ]] || fail 'The registry environment was overwritten'
rm "$directory/config/hive-registry.env"; provision install

# An upgrade gains an empty store and the ingress route, keeping the previous Caddyfile.
install -d -m 700 "$directory/config/ingress" "$directory/config/.initializer"
printf 'previous-route-file\n' > "$directory/config/ingress/Caddyfile"; chmod 600 "$directory/config/ingress/Caddyfile"
jq -n --arg path "$directory/config/ingress/Caddyfile" --arg sha "$(sha256sum "$directory/config/ingress/Caddyfile"|cut -d ' ' -f1)" '{files:{($path):$sha}}' > "$directory/config/.initializer/receipt.json"
HIVE_OPERATION=upgrade hive_registry_provision; HIVE_OPERATION=upgrade hive_registry_refresh_ingress
[[ -d "$directory/data/hive-registry" ]] || fail 'Upgrade did not create the registry store'
cmp -s "$directory/config/ingress/Caddyfile" "$ROOT/deployment/Caddyfile" || fail 'Upgrade did not install the ingress route'
[[ $(cat "$directory/config/ingress/Caddyfile.pre-registry") == previous-route-file ]] || fail 'The previous Caddyfile was not retained'
[[ $(jq -r --arg path "$directory/config/ingress/Caddyfile" '.files[$path]' "$directory/config/.initializer/receipt.json") == $(sha256sum "$directory/config/ingress/Caddyfile"|cut -d ' ' -f1) ]] || fail 'The initializer receipt does not record the new Caddyfile'
sha_before=$(sha256sum "$directory/config/ingress/Caddyfile"); printf 'altered\n' > "$directory/config/ingress/Caddyfile.pre-registry"
HIVE_OPERATION=upgrade hive_registry_refresh_ingress
[[ $(sha256sum "$directory/config/ingress/Caddyfile") == "$sha_before" && $(cat "$directory/config/ingress/Caddyfile.pre-registry") == altered ]] || fail 'A current Caddyfile was replaced again'
# A Caddyfile from an earlier release that already routes the registry is replaced too, so a
# changed upstream transport reaches existing installations; the previous file is retained.
printf '# earlier release\nreverse_proxy http://hive-registry:8095\n' > "$directory/config/ingress/Caddyfile"
HIVE_OPERATION=upgrade hive_registry_refresh_ingress
cmp -s "$directory/config/ingress/Caddyfile" "$ROOT/deployment/Caddyfile" || fail 'Upgrade did not install the current Caddyfile'
[[ $(head -n 1 "$directory/config/ingress/Caddyfile.previous") == '# earlier release' && $(cat "$directory/config/ingress/Caddyfile.pre-registry") == altered ]] || fail 'The earlier Caddyfile was not retained as Caddyfile.previous'
[[ $(jq -r --arg path "$directory/config/ingress/Caddyfile" '.files[$path]' "$directory/config/.initializer/receipt.json") == $(sha256sum "$directory/config/ingress/Caddyfile"|cut -d ' ' -f1) ]] || fail 'The initializer receipt does not record the replaced Caddyfile'

# A registry failure never reaches completion. A failed start holds; a failed record does not stop services.
(
  calls=()
  hive_doctor() { :; }; hive_stage() { :; }; hive_registry_provision() { :; }; hive_registry_refresh_ingress() { :; }
  hive_all() { printf '%s\n' "$1" >> "$temporary/calls"; }
  hive_hold() { printf 'hold\n' >> "$temporary/calls"; exit 7; }
  : > "$temporary/calls"
  hive_registry_begin() { return 1; }
  (hive_lifecycle upgrade) >/dev/null 2>&1 && fail 'Failed registry start succeeded'
  grep -qx hold "$temporary/calls" || fail 'Failed registry start did not hold'
  if grep -qx activate "$temporary/calls"; then fail 'Products activated without the registry'; fi
  : > "$temporary/calls"
  hive_registry_begin() { :; }
  hive_registry_complete() { return 1; }
  (hive_lifecycle upgrade) > "$temporary/failed.log" 2>&1 && fail 'Failed registry record reported success'
  grep -qx activate "$temporary/calls" || fail 'Expected activation before the record'
  if grep -qx complete "$temporary/calls"; then fail 'A failed registry record completed the transaction'; fi
  if grep -qx hold "$temporary/calls"; then fail 'A failed registry record stopped running services'; fi
  grep -q 'could not record this upgrade' "$temporary/failed.log" || fail 'No clear message for a failed registry record'
  : > "$temporary/calls"
  hive_registry_complete() { :; }
  (hive_lifecycle upgrade) >/dev/null 2>&1 || fail 'Retry after a registry failure did not complete'
  [[ $(tail -1 "$temporary/calls") == complete ]] || fail 'Retry did not complete the transaction'
) || exit 1

# Status and doctor compare the registry to what actually runs.
cat > "$temporary/bin/docker" <<'SH'
#!/usr/bin/env bash
# Fixture host: state comes from files named by HIVE_FIXTURE.
state=$HIVE_FIXTURE
if [[ "$1" == inspect ]]; then jq -r --arg id "$4" '.[$id]' "$state/containers.json"; exit 0; fi
if [[ "$1 $2" == 'image inspect' ]]; then jq -r --arg image "$5" '.images[$image] // empty' "$state/images.json"; exit 0; fi
if [[ "$1" == compose ]]; then
  if [[ " $* " == *' ps -aq '* ]]; then printf '%s\n' "${!#}"; exit 0; fi
  if [[ " $* " == *' ps '* ]]; then printf '[]\n'; exit 0; fi
  if [[ " $* " == *' exec '* ]]; then
    [[ ! -e "$state/unavailable" ]] || exit 1
    case " $* " in
      *' GET /v1/installation '*) cat "$state/installation.json";;
      *' GET /v1/products '*) cat "$state/products.json";;
      *) exit 1;;
    esac
    exit 0
  fi
fi
exit 1
SH
chmod 700 "$temporary/bin/docker"
export PATH="$temporary/bin:$PATH" HIVE_FIXTURE="$temporary/fixture"
mkdir "$HIVE_FIXTURE"
reset_fixture() {
  rm -f "$HIVE_FIXTURE/unavailable"
  jq . "$temporary/compose.json" > "$directory/compose.json"
  printf '{"installation":"example-suite","host":"control","uuid":"fixture"}' > "$directory/installation.json"
  jq -n --arg digest "$(sha256sum "$temporary/release.json"|cut -d ' ' -f1)" '{version:"0.1.0",digest:$digest,plan:"p"}' > "$directory/receipt.json"
  printf '{"phase":"complete"}' > "$directory/transaction.json"
  install -d -m 700 "$directory/releases/0.1.0"; cp "$temporary/release.json" "$directory/releases/0.1.0/manifest"
  jq '.services|with_entries(.value="running|healthy|"+.value.image+"|id-same")' "$directory/compose.json" > "$HIVE_FIXTURE/containers.json"
  jq '{images:(.services|map({key:.image,value:"id-same"})|from_entries)}' "$directory/compose.json" > "$HIVE_FIXTURE/images.json"
  jq --arg digest "$(jq -r '.release.manifestDigest' "$temporary/body.json")" '{schema:1,id:"example-suite",release:{version:"0.1.0",manifestDigest:$digest,planDigest:.release.planDigest},phase:"complete"}' "$temporary/body.json" > "$HIVE_FIXTURE/installation.json"
  jq '{schema:1,products:[.catalog[] as $entry|(.installed|map(select(.id==$entry.id))|first) as $placed|{id:$entry.id,source:"release",offered:true,installed:true,versions:[{version:$entry.version.version,image:$entry.version.image,storageFormat:$entry.version.storageFormat}],installation:{inventoryHost:$placed.inventoryHost,version:$placed.version,imageDigest:$placed.imageDigest,status:"installed"}}]}' "$temporary/body.json" > "$HIVE_FIXTURE/products.json"
}
status() { "$ROOT/hive.sh" status --config "$temporary/config.json" | jq -c .registry; }
HIVE_MANIFEST_DIGEST=$(sha256sum "$temporary/release.json"|cut -d ' ' -f1)
hive_registry_body complete installed > "$temporary/body.json"
expect_drift() { # CODE
  local report
  report=$(status)
  jq -e --arg code "$1" '.state=="drift" and any(.drift[];.code==$code)' <<< "$report" >/dev/null || { printf '%s\n' "$report" >&2; fail "Expected drift $1"; }
}
reset_fixture
[[ $(status | jq -r .state) == in-sync ]] || { status >&2; fail 'A matching registry reported drift'; }
# Each difference is reported by name.
jq '.emberpath|="exited||"+(.|split("|")[2])+"|id-same"' "$HIVE_FIXTURE/containers.json" > "$HIVE_FIXTURE/next"; mv "$HIVE_FIXTURE/next" "$HIVE_FIXTURE/containers.json"; expect_drift not-running; reset_fixture
jq '.emberpath|="running|unhealthy|"+(.|split("|")[2])+"|id-same"' "$HIVE_FIXTURE/containers.json" > "$HIVE_FIXTURE/next"; mv "$HIVE_FIXTURE/next" "$HIVE_FIXTURE/containers.json"; expect_drift unhealthy; reset_fixture
jq '.emberpath="running|healthy|example.com/other@sha256:'"$(printf 'b%.0s' {1..64})"'|id-other"' "$HIVE_FIXTURE/containers.json" > "$HIVE_FIXTURE/next"; mv "$HIVE_FIXTURE/next" "$HIVE_FIXTURE/containers.json"; expect_drift image-mismatch; reset_fixture
jq '(.products[]|select(.id=="emberpath")|.installation.imageDigest)=("sha256:"+("b"*64))' "$HIVE_FIXTURE/products.json" > "$HIVE_FIXTURE/next"; mv "$HIVE_FIXTURE/next" "$HIVE_FIXTURE/products.json"; expect_drift digest-mismatch; reset_fixture
jq '(.products[]|select(.id=="emberpath")|.installation.status)="activating"' "$HIVE_FIXTURE/products.json" > "$HIVE_FIXTURE/next"; mv "$HIVE_FIXTURE/next" "$HIVE_FIXTURE/products.json"; expect_drift not-installed; reset_fixture
jq '.products|=map(select(.id!="emberpath"))' "$HIVE_FIXTURE/products.json" > "$HIVE_FIXTURE/next"; mv "$HIVE_FIXTURE/next" "$HIVE_FIXTURE/products.json"; expect_drift unrecorded; expect_drift catalog-mismatch; reset_fixture
jq 'del(.services.emberpath)' "$directory/compose.json" > "$HIVE_FIXTURE/next"; mv "$HIVE_FIXTURE/next" "$directory/compose.json"; expect_drift not-deployed; reset_fixture
jq '.release.version="9.9.9"' "$HIVE_FIXTURE/installation.json" > "$HIVE_FIXTURE/next"; mv "$HIVE_FIXTURE/next" "$HIVE_FIXTURE/installation.json"; expect_drift release-mismatch; reset_fixture
jq '(.products[]|select(.id=="emberpath")|.versions[0].image)="example.com/wrong@sha256:'"$(printf 'c%.0s' {1..64})"'"' "$HIVE_FIXTURE/products.json" > "$HIVE_FIXTURE/next"; mv "$HIVE_FIXTURE/next" "$HIVE_FIXTURE/products.json"; expect_drift catalog-mismatch; reset_fixture
printf '{"phase":"ready"}' > "$directory/transaction.json"; expect_drift incomplete-transaction; reset_fixture
# A transaction aborted in its read-only checks changed nothing: it is not drift, but a prepared one is.
printf '{"phase":"prepared"}' > "$directory/transaction.json"; expect_drift incomplete-transaction; reset_fixture
printf '{"phase":"aborted","abortedStep":"compatibility"}' > "$directory/transaction.json"
[[ $(status | jq -r .state) == in-sync ]] || { status >&2; fail 'An aborted transaction was reported as drift'; }
hive_registry_doctor > "$temporary/doctor.log" || fail 'Doctor failed on an aborted transaction'
grep -q 'in sync' "$temporary/doctor.log" || fail 'Doctor did not report an aborted transaction as in sync'
reset_fixture
touch "$HIVE_FIXTURE/unavailable"
[[ $(status | jq -r .state) == unavailable ]] || fail 'An unreachable registry was not reported'
reset_fixture
# An externally managed entry is not drift.
jq '.products+=[{id:"external-api",source:"external",offered:false,installed:true,versions:[],installation:{inventoryHost:null,version:null,imageDigest:null,status:"external"}}]' "$HIVE_FIXTURE/products.json" > "$HIVE_FIXTURE/next"; mv "$HIVE_FIXTURE/next" "$HIVE_FIXTURE/products.json"
report=$(status); jq -e '.state=="in-sync" and .externallyManaged==["external-api"]' <<< "$report" >/dev/null || { printf '%s\n' "$report" >&2; fail 'An external product caused drift'; }
reset_fixture
# An external Magnus is a release product recorded as external: nothing is deployed to compare,
# and the record must match the configuration both ways.
jq '.external={magnus:{url:"https://magnus.example.com:4000"}}' "$temporary/config.json" > "$temporary/external.json"
external_status() { "$ROOT/hive.sh" status --config "$temporary/external.json" | jq -c .registry; }
used_externally() { jq '.products+=[{id:"magnus",source:"release",offered:true,installed:true,versions:[],installation:{inventoryHost:null,version:null,imageDigest:null,status:"external"}}]' "$HIVE_FIXTURE/products.json" > "$HIVE_FIXTURE/next"; mv "$HIVE_FIXTURE/next" "$HIVE_FIXTURE/products.json"; }
used_externally
report=$(external_status); jq -e '.state=="in-sync" and .externallyManaged==["magnus"]' <<< "$report" >/dev/null || { printf '%s\n' "$report" >&2; fail 'An external Magnus caused drift'; }
report=$(status); jq -e '.state=="drift" and any(.drift[];.code=="external-not-configured")' <<< "$report" >/dev/null || { printf '%s\n' "$report" >&2; fail 'An external record the configuration does not name was not reported'; }
reset_fixture
report=$(external_status); jq -e '.state=="drift" and any(.drift[];.code=="external-not-recorded")' <<< "$report" >/dev/null || { printf '%s\n' "$report" >&2; fail 'A configured external Magnus missing from the record was not reported'; }
reset_fixture
# Completion compares only what runs here: the external entry has no host to observe.
(
  hive_registry_write() { printf '%s\n' "$3" > "$temporary/external-sync.json"; }
  HIVE_CONFIG=$temporary/external.json HIVE_MANIFEST_DIGEST=$(sha256sum "$temporary/release.json"|cut -d ' ' -f1) HIVE_PLAN_DIGEST=$(printf 'p%.0s' {1..64})
  hive_registry_body() { jq '.installed+=[{id:"magnus",status:"external",connection:{consolePath:"/fleet",browserPrefix:"/api/magnus",nativeApis:{},internalEndpoints:{api:"https://magnus.example.com:4000"}}}]' "$temporary/body.json"; }
  hive_registry_complete || fail 'Completion refused an external entry it cannot observe'
) || exit 1
jq -e '.installed|any(.id=="magnus" and .status=="external")' "$temporary/external-sync.json" >/dev/null || fail 'Completion did not record the external entry'
hive_registry_doctor > "$temporary/doctor.log"; grep -q 'in sync' "$temporary/doctor.log" || fail 'Doctor did not report sync'
printf '{"phase":"ready"}' > "$directory/transaction.json"
if (hive_registry_doctor) > "$temporary/doctor.log" 2>&1; then fail 'Doctor passed with drift'; fi
grep -q 'incomplete-transaction' "$temporary/doctor.log" || fail 'Doctor did not name the drift'
reset_fixture
# An installation from before the registry is reported, not refused, until an upgrade adds it.
"$ROOT/hive.sh" status --config "$temporary/legacy.json" 2>/dev/null | jq -e '.registry.state=="in-sync"' >/dev/null || fail 'An unedited configuration lost sight of a running registry'
jq 'del(.services["hive-registry"])' "$directory/compose.json" > "$HIVE_FIXTURE/next"; mv "$HIVE_FIXTURE/next" "$directory/compose.json"
"$ROOT/hive.sh" status --config "$temporary/legacy.json" 2>/dev/null | jq -e '.registry.state=="missing"' >/dev/null || fail 'A missing registry was not reported by status'
if (hive_registry_doctor) > "$temporary/doctor.log" 2>&1; then fail 'Doctor passed without a registry'; fi
grep -q 'upgrade or adopt adds it' "$temporary/doctor.log" || fail 'Doctor did not explain the missing registry'
reset_fixture
# Doctor refuses a configuration without it when nothing has been installed yet.
rm "$directory/receipt.json"
if (HIVE_REGISTRY_ORIGINAL_CONFIG=$temporary/legacy.json hive_registry_doctor) > "$temporary/doctor.log" 2>&1; then fail 'Doctor accepted a configuration without the registry'; fi
grep -q 'The Hive Registry is mandatory' "$temporary/doctor.log" || fail 'Doctor did not refuse clearly'
reset_fixture

# hive.sh registry: lookups and edits run on the registry host through the container client.
cat > "$temporary/bin/docker" <<'SH'
#!/usr/bin/env bash
if [[ " $* " == *' exec '* ]]; then
  printf '%s\n' "$*" >> "$HIVE_FIXTURE/client.log"
  if [[ " $* " == *' write '* ]]; then cat >> "$HIVE_FIXTURE/client.log"; printf '{"schema":1,"changes":1,"revision":2}\n'; else printf '{"schema":1}\n'; fi
  exit 0
fi
exit 1
SH
registry() { "$ROOT/hive.sh" registry --config "$temporary/config.json" "$@"; }
registry list > "$temporary/list.json"; jq -e .schema "$temporary/list.json" >/dev/null || fail 'Registry list output'
grep -q 'exec -T hive-registry node /app/dist/cli.js request GET /v1/products read' "$HIVE_FIXTURE/client.log" || fail 'List did not use the read credential through the container client'
registry connection emberpath >/dev/null; grep -q 'GET /v1/products/emberpath/connection read' "$HIVE_FIXTURE/client.log" || fail 'Connection lookup'
registry installed >/dev/null; grep -qF 'GET /v1/products?installed=true read' "$HIVE_FIXTURE/client.log" || fail 'Installed lookup'
registry summary >/dev/null; registry history >/dev/null; registry get emberpath >/dev/null
printf '{"displayName":"External API","connection":{"nativeApis":{"model":"https://models.example.com/v1"}}}\n' > "$temporary/entry.json"
registry add external-api --file "$temporary/entry.json" >/dev/null
grep -q 'PUT /v1/products/external-api write' "$HIVE_FIXTURE/client.log" || fail 'Add did not use the write credential'
grep -qF '"displayName":"External API"' "$HIVE_FIXTURE/client.log" || fail 'Add did not send the entry'
registry remove external-api >/dev/null; grep -q 'DELETE /v1/products/external-api write' "$HIVE_FIXTURE/client.log" || fail 'Remove'
refused 'needs --file' registry add external-api
refused 'needs a product ID' registry get
refused 'lowercase' registry get 'Not;Valid'
refused 'Use: registry' registry unknown
printf '[]' > "$temporary/entry.json"; refused 'JSON object' registry add external-api --file "$temporary/entry.json"
refused 'applies only to registry' "$ROOT/hive.sh" plan --config "$temporary/config.json" --file "$temporary/entry.json"
printf 'Passed: mandatory registry refusal, release metadata checks, upgrade and rollback plans, start ordering, generated record, stable protected credentials, failed-write handling, drift reporting and registry commands.\n'
