#!/usr/bin/env bash
set -Eeuo pipefail
ROOT=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)
HIVE_ROOT=$ROOT
source "$ROOT/scripts/suite/controller.sh"
source "$ROOT/scripts/suite/public-runtime.sh"
temporary=$(mktemp -d)
trap 'rm -rf -- "$temporary"' EXIT
fail() { printf 'FAIL: %s\n' "$*" >&2; exit 1; }
reject() { if ( "$@" ) > "$temporary/result" 2>&1; then fail 'Unsafe console configuration was accepted'; fi; }
HIVE_CONFIG=$temporary/installation.json HIVE_VERSION=0.1.0
HIVE_MANIFEST=$temporary/release.json HIVE_SIGNATURE=$temporary/release.sig HIVE_TRUST_KEY=$temporary/public
jq '.components.ingress={host:"control",envFile:"/opt/hive/config/ingress.env",configDirectory:"/opt/hive/config/ingress"} | .console={host:"control",bindAddress:"127.0.0.1",httpsPort:8443,runtimeFile:"/opt/hive/config/runtime.json"}' "$ROOT/examples/installation.json" > "$HIVE_CONFIG"
cp "$HIVE_CONFIG" "$temporary/valid-config.json"
openssl genpkey -algorithm ED25519 -out "$temporary/private" >/dev/null 2>&1
openssl pkey -in "$temporary/private" -pubout -out "$temporary/public" >/dev/null 2>&1
jq -n --slurpfile c "$HIVE_CONFIG" '{schema:1,version:"0.1.0",profiles:{core:($c[0].components|keys),full:($c[0].components|keys)},components:($c[0].components|map_values({image:("example.com/synthetic@sha256:"+("0"*64)),service:{user:"1000:1000",healthcheck:{test:["CMD","true"]}}}))} | .components.hivexui.kind="static-ui" | .components.hivexui.service.user="101:101" | .components.ingress.kind="ingress"' > "$HIVE_MANIFEST"
sign() { openssl pkeyutl -sign -inkey "$temporary/private" -rawin -in "$HIVE_MANIFEST" -out "$HIVE_SIGNATURE"; }
sign
hive_validate
hive_manifest
hive_render control > "$temporary/compose.json"
jq -e '.services.ingress.ports==[{target:8443,published:"8443",host_ip:"127.0.0.1",protocol:"tcp"}] and .services.hivexui.volumes==[{type:"bind",source:"/opt/hive/config/runtime.json",target:"/usr/share/nginx/html/runtime.json",read_only:true}] and (.services.hivexui|has("env_file")|not) and (.services.hivexui.tmpfs|index("/var/run:uid=101,gid=101,mode=700")!=null) and ([.services|to_entries[]|select(.key!="ingress")|.value|has("ports")]|all(.==false))' "$temporary/compose.json" >/dev/null
cp "$HIVE_MANIFEST" "$temporary/valid-release.json"
for patch in '.components.hivexui.envFile="/opt/hive/config/backend.env"' '.components.hivexui.configDirectory="/opt/hive/config/identity"' '.console.host="missing"' '.console.runtimeFile="/etc/passwd"' '.console.bindAddress="999.0.0.1"' '.console.httpsPort=0' '.console.httpsPort=443.5' '.components.ingress.host="missing"'; do
  jq "$patch" "$temporary/valid-config.json" > "$HIVE_CONFIG"
  reject hive_validate
done
cp "$temporary/valid-config.json" "$HIVE_CONFIG"
for patch in '.components.hivexui.service.environment={SIGNING_KEY:"obviously-fake"}' '.components.hivexui.kind="application"' '.components.ingress.kind="application"' '.components.oathweave.kind="static-ui"'; do
  jq "$patch" "$temporary/valid-release.json" > "$HIVE_MANIFEST"
  sign
  reject hive_manifest
done
cat > "$temporary/runtime.json" <<'JSON'
{"schema":1,"products":{"oathweave":"/api/oathweave","emberpath":"/api/emberpath"},"identity":{"issuer":"https://identity.example.com","apiPrefix":"/api/oathweave","clients":{"oathweave":"hivexui-oathweave","emberpath":"hivexui-emberpath"}}}
JSON
cp "$temporary/runtime.json" "$temporary/valid-runtime.json"
hive_check_public_runtime "$temporary/runtime.json"
for patch in '.secrets={key:"obviously-fake"}' '.identity.password="obviously-fake"' '.products.emberpath="https://external.example.com"' '.identity.issuer="https://user:obviously-fake@identity.example.com"' '.identity.clients|=del(.emberpath)' '.mode="legacy"'; do
  jq "$patch" "$temporary/valid-runtime.json" > "$temporary/runtime.json"
  reject hive_check_public_runtime "$temporary/runtime.json"
done
printf 'Passed: console assembly, static credential isolation, listener placement, signed service kinds and public runtime allowlist.\n'
