#!/usr/bin/env bash
set -Eeuo pipefail
ROOT=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)
temporary=$(mktemp -d)
trap 'rm -rf -- "$temporary"' EXIT
fail() { printf 'FAIL: %s\n' "$*" >&2; exit 1; }
openssl req -x509 -newkey rsa:2048 -nodes -keyout "$temporary/server.key" -out "$temporary/server.crt" -subj '/CN=localhost' -addext 'subjectAltName=DNS:localhost' -days 2 >/dev/null 2>&1
chmod 600 "$temporary/server.key"
openssl genpkey -algorithm ED25519 -out "$temporary/publisher.key" >/dev/null 2>&1
openssl pkey -in "$temporary/publisher.key" -pubout -out "$temporary/publisher.pub" >/dev/null 2>&1
node --input-type=module - "$ROOT" "$temporary/release.json" <<'JS'
import{writeFileSync}from'node:fs';import{pathToFileURL}from'node:url';const root=process.argv[2];const{coreRelease,addFullComponents,CORE_PRODUCTS,FULL_PRODUCTS}=await import(pathToFileURL(root+'/scripts/suite/release-contracts.mjs'));const{applySuiteCatalog}=await import(pathToFileURL(root+'/scripts/suite/suite-catalog.mjs'));const images=Object.fromEntries([...CORE_PRODUCTS,...FULL_PRODUCTS,'embermend'].map(name=>[name,'example.com/'+name+'@sha256:'+'a'.repeat(64)]));const manifest=applySuiteCatalog(addFullComponents(coreRelease({version:'2.4.0',images,user:process.getuid()+':'+process.getgid()}),{images,user:process.getuid()+':'+process.getgid()}));manifest.components.magnus.version='2.4.0';manifest.components.magnus.embermendProtocol=1;writeFileSync(process.argv[3],JSON.stringify(manifest));
JS
openssl pkeyutl -sign -inkey "$temporary/publisher.key" -rawin -in "$temporary/release.json" -out "$temporary/release.json.sig"
mkdir "$temporary/bin"
printf '#!/usr/bin/env bash\n[[ "$1" == info || "$1" == ps ]]\n' > "$temporary/bin/docker"
chmod +x "$temporary/bin/docker"
export PATH="$temporary/bin:$PATH"
jq --arg root "$temporary/install" --arg cert "$temporary/server.crt" --arg key "$temporary/server.key" '
 .profile="custom" | .release="2.4.0" | .installation="embermend-proof" | .origin="https://localhost:65429" | .hosts.control.directory=$root |
 .components|=with_entries(select(.key as $name|["hive-registry","oathweave","oathweave-redis","hivexui","ingress"]|index($name)!=null)) |
 .components+={magnus:{host:"control"},"magnus-postgres":{host:"control"},"magnus-redis":{host:"control"},embermend:{host:"control"},"embermend-worker":{host:"control"},"embermend-postgres":{host:"control"}} |
 .components|=with_entries(.key as $name|if $name!="hivexui" then .value.configDirectory=($root+"/config/"+$name)|.value.envFile=($root+"/config/"+$name+".env") else . end) |
 .console.httpsPort=65429 | .console.runtimeFile=($root+"/config/runtime.json") | .bootstrap.certificateFile=$cert | .bootstrap.privateKeyFile=$key
' "$ROOT/examples/installation.json" > "$temporary/config.json"
run_init() { "$ROOT/hive.sh" init --config "$temporary/config.json" --manifest "$temporary/release.json" --trust-key "$temporary/publisher.pub" --non-interactive --yes; }
run_init > "$temporary/initialization.log"
config="$temporary/install/config"
cmp "$config/embermend.env" "$config/embermend-worker.env" || fail 'API and worker disagree on authoritative datastore or grants'
[[ -s "$config/embermend/authority.pem" && -s "$config/embermend-worker/authority.pem" && -s "$config/embermend-postgres/password" ]] || fail 'Product trust or datastore credential missing'
jq -e '.products.embermend=="/api/embermend" and .identity.clients.embermend=="hivexui-embermend"' "$config/runtime.json" >/dev/null
node --input-type=module - "$config" <<'JS'
import{readFileSync}from'node:fs';import{parseEnv}from'node:util';import assert from'node:assert/strict';const root=process.argv[2];const env=parseEnv(readFileSync(root+'/embermend.env','utf8'));assert.equal(env.MAGNUS_URL,'https://magnus:4000');assert.equal(env.OATHWEAVE_JWKS_URL,'https://oathweave:4200/api/v1/oauth/jwks');const grants=JSON.parse(env.EMBERMEND_IDENTITY_GRANTS);for(const grant of grants){assert.deepEqual(grant.scope.targetIds,[]);assert.deepEqual(grant.scope.applicationIds,[]);for(const permission of ['execute','approve','recover','merge','deploy','artifact-publish','exception'])assert(!grant.permissions.includes(permission));}const magnus=parseEnv(readFileSync(root+'/magnus.env','utf8'));const machine=JSON.parse(magnus.MAGNUS_EMBERMEND_GRANTS_JSON).embermend;assert.deepEqual(machine.targets,{});assert.deepEqual(machine.applicationIds,[]);assert.notEqual(machine.tokenSha256,env.MAGNUS_EMBERMEND_TOKEN);const bootstrap=JSON.parse(readFileSync(root+'/oathweave/suite-bootstrap.json'));assert(bootstrap.clients.some(client=>client.id==='hivexui-embermend'&&client.audience==='embermend'));assert(env.DATABASE_URL.includes('@embermend-postgres:5432/embermend'));
JS
find "$config" -type f -exec sha256sum {} + | sort > "$temporary/before"
run_init > "$temporary/repeat.log"
find "$config" -type f -exec sha256sum {} + | sort > "$temporary/after"
cmp "$temporary/before" "$temporary/after" || fail 'Repeated initialization changed product authority'
# A signed older Magnus still cannot be selected for Embermend.
jq '.components.magnus.version="2.3.4"' "$temporary/release.json" > "$temporary/old.json"
openssl pkeyutl -sign -inkey "$temporary/publisher.key" -rawin -in "$temporary/old.json" -out "$temporary/old.json.sig"
if "$ROOT/hive.sh" plan --config "$temporary/config.json" --manifest "$temporary/old.json" --trust-key "$temporary/publisher.pub" > "$temporary/rejection.log" 2>&1; then fail 'Incompatible Magnus was accepted'; fi
grep -q 'compatible Magnus' "$temporary/rejection.log" || fail 'Older Magnus did not fail at the compatibility boundary'
# A published version number without the bridge declaration is insufficient.
for change in 'del(.components.magnus.embermendProtocol) | .components.magnus.version="2.4.2"' '.components.magnus.embermendProtocol=2'; do
  jq "$change" "$temporary/release.json" > "$temporary/no-bridge.json"
  openssl pkeyutl -sign -inkey "$temporary/publisher.key" -rawin -in "$temporary/no-bridge.json" -out "$temporary/no-bridge.json.sig"
  if "$ROOT/hive.sh" plan --config "$temporary/config.json" --manifest "$temporary/no-bridge.json" --trust-key "$temporary/publisher.pub" > "$temporary/no-bridge.log" 2>&1; then fail 'Missing/unsupported bridge declaration passed'; fi
  grep -q 'compatible Magnus' "$temporary/no-bridge.log" || fail 'Bridge mismatch did not fail at compatibility admission'
done
printf 'Embermend initialization, idempotence and compatibility checks passed.\n'
