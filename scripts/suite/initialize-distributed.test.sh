#!/usr/bin/env bash
set -Eeuo pipefail
ROOT=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)
temporary=$(mktemp -d)
trap 'rm -rf -- "$temporary"' EXIT
fail() { printf 'FAIL: %s\n' "$*" >&2; exit 1; }
reject() { if ( "$@" ) > "$temporary/rejection.log" 2>&1; then fail 'Unsafe distributed bootstrap was accepted'; fi; }
openssl req -x509 -newkey rsa:2048 -nodes -keyout "$temporary/server.key" -out "$temporary/server.crt" -subj '/CN=localhost' -addext 'subjectAltName=DNS:localhost,IP:127.0.0.1' -days 2 >/dev/null 2>&1
chmod 600 "$temporary/server.key"
openssl genpkey -algorithm ED25519 -out "$temporary/publisher.key" >/dev/null 2>&1
openssl pkey -in "$temporary/publisher.key" -pubout -out "$temporary/publisher.pub" >/dev/null 2>&1
jq --arg root "$temporary" '.origin="https://localhost:65420" | .hosts={identity:{target:"local",directory:($root+"/identity")},console:{target:"local",directory:($root+"/console")}} |
  .console={host:"console",bindAddress:"127.0.0.1",httpsPort:65420,runtimeFile:($root+"/console/config/runtime.json")} |
  .components|=with_entries(.key as $name | (if ($name|IN("oathweave","oathweave-redis")) then "identity" else "console" end) as $host |
    .value=({host:$host} + (if $name=="hivexui" then {} else {configDirectory:($root+"/"+$host+"/config/"+$name)} + (if ($name|IN("oathweave-redis","hivemem-qdrant")) then {} else {envFile:($root+"/"+$host+"/config/"+$name+".env")} end) end))) |
  .bootstrap.certificateFile=($root+"/server.crt") | .bootstrap.privateKeyFile=($root+"/server.key") | .bootstrap.trustBundleFile=($root+"/server.crt") |
  .bootstrap.productEndpoints=(["oathweave","emberpath","hivemem","hiveskills"]|to_entries|map(.key as $index|.value as $name|{key:$name,value:({origin:("https://127.0.0.1:"+((65421+$index)|tostring)),bindAddress:"127.0.0.1",certificateFile:($root+"/server.crt"),privateKeyFile:($root+"/server.key")} + (if $name=="emberpath" then {inferenceOrigin:"https://127.0.0.1:65425"} else {} end))})|from_entries)' "$ROOT/examples/installation.json" > "$temporary/config.json"
jq -n --slurpfile c "$temporary/config.json" --arg user "$(id -u):$(id -g)" '{schema:1,version:"0.1.0",profiles:{core:($c[0].components|keys),full:($c[0].components|keys)},components:($c[0].components|map_values({image:("example.com/synthetic@sha256:"+("0"*64)),service:{user:$user,healthcheck:{test:["CMD","true"]}}}))} | .components.hivexui.kind="static-ui" | .components.hivexui.service.user="101:101" | .components.ingress.kind="ingress"' > "$temporary/release.json"
source "$ROOT/scripts/suite/test-catalog.sh"; hive_test_catalog "$temporary/release.json"
openssl pkeyutl -sign -inkey "$temporary/publisher.key" -rawin -in "$temporary/release.json" -out "$temporary/release.json.sig"
mkdir -m 700 "$temporary/bin"
cat > "$temporary/bin/docker" <<'DOCKER'
#!/usr/bin/env bash
if [[ "$*" == info || "$*" == ps\ -aq\ --filter\ label=com.docker.compose.project=example-suite-* ]]; then exit 0; fi
exit 99
DOCKER
chmod 700 "$temporary/bin/docker"
export PATH="$temporary/bin:$PATH"
run_init() { "$ROOT/hive.sh" init --config "$temporary/config.json" --manifest "$temporary/release.json" --trust-key "$temporary/publisher.pub" --non-interactive --yes; }
run_init > "$temporary/initialization.log"
[[ -f "$temporary/identity/config/initial-credentials.env" && ! -e "$temporary/console/config/initial-credentials.env" ]] || fail 'Identity credentials reached another host'
[[ ! -e "$temporary/identity/config/hivemem.env" && ! -e "$temporary/console/config/oathweave.env" ]] || fail 'Product configuration crossed its owning host'
[[ ! -e "$temporary/identity/config/.initializer/secrets/router-key" && ! -e "$temporary/console/config/.initializer/secrets/oath-cookie" ]] || fail 'Product secrets crossed their owning host'
rg -q '^IAM_ENROLLMENT_INSTALLATION_ID=example-suite$' "$temporary/identity/config/oathweave.env" || fail 'Enrollment coordinator lacks installation ownership'
rg -q 'https://127.0.0.1:65422/api' "$temporary/identity/config/oathweave.env" || fail 'Enrollment coordinator uses local Compose DNS across hosts'
subject=$(cat "$temporary/identity/config/.initializer/secrets/identity-id")
[[ $(jq -r .adminId "$temporary/identity/config/oathweave/suite-bootstrap.json") == "$subject" ]] || fail 'Identity account changed'
for name in identity model memory; do cmp -s "$temporary/identity/config/.initializer/secrets/$name-id" "$temporary/console/config/.initializer/secrets/$name-id" || fail 'Account coordination IDs differ'; done
rg -q '^OATHWEAVE_JWKS_URL=https://127.0.0.1:65421/api/v1/oauth/jwks$' "$temporary/console/config/emberpath.env" || fail 'Cross-host identity endpoint used local Compose DNS'
rg -q '^OATHWEAVE_ENDPOINT=https://127.0.0.1:65421$' "$temporary/console/config/ingress.env" || fail 'Cross-host ingress used local Compose DNS'
find "$temporary/identity/config" "$temporary/console/config" -type f -exec sha256sum {} + | sort > "$temporary/before"
run_init > "$temporary/repeat.log"
find "$temporary/identity/config" "$temporary/console/config" -type f -exec sha256sum {} + | sort > "$temporary/after"
cmp -s "$temporary/before" "$temporary/after" || fail 'Repeated distributed setup changed identities or credentials'
cp "$temporary/config.json" "$temporary/valid.json"
for patch in 'del(.bootstrap.trustBundleFile)' '.bootstrap.productEndpoints.oathweave.origin="http://identity.example.com"' '.bootstrap.productEndpoints.emberpath.inferenceOrigin=.bootstrap.productEndpoints.emberpath.origin' '.bootstrap.productEndpoints.hivemem.origin=.bootstrap.productEndpoints.hiveskills.origin' '.components["oathweave-redis"].host="console"'; do
  jq "$patch" "$temporary/valid.json" > "$temporary/config.json"; reject run_init
done
cp "$temporary/valid.json" "$temporary/config.json"
printf 'changed' >> "$temporary/server.crt"
reject run_init
printf 'Passed: fresh distributed configuration, exact account coordination, product-owned secrets, explicit HTTPS origins, repeat stability and invalid topology/trust refusal.\n'
