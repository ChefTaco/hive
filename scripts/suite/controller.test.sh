#!/usr/bin/env bash
set -Eeuo pipefail
ROOT=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)
temporary=$(mktemp -d)
trap 'rm -rf -- "$temporary"' EXIT
export HIVE_ROOT=$ROOT
source "$ROOT/scripts/suite/controller.sh"
cp "$ROOT/examples/installation.json" "$temporary/installation.json"
fail() { printf 'FAIL: %s\n' "$*" >&2; exit 1; }
reject() { if ( "$@" ) > "$temporary/result" 2>&1; then fail 'Unsafe input was accepted'; fi; }
"$ROOT/hive.sh" plan --config "$temporary/installation.json" > "$temporary/plan"
jq -e '.components.emberpath.environmentConfigured and (.components.emberpath|has("envFile")|not)' "$temporary/plan" >/dev/null
reject "$ROOT/hive.sh" install --config "$temporary/installation.json" --non-interactive
reject "$ROOT/hive.sh" install --config "$temporary/installation.json" --non-interactive --yes
reject "$ROOT/hive.sh" plan --non-interactive
reject "$ROOT/hive.sh" plan --config
jq '.hosts.control.target="-oProxyCommand=example"' "$temporary/installation.json" > "$temporary/bad.json"
reject "$ROOT/hive.sh" plan --config "$temporary/bad.json"
jq '.hosts.control.directory="/opt/../../"' "$temporary/installation.json" > "$temporary/bad.json"
reject "$ROOT/hive.sh" plan --config "$temporary/bad.json"
openssl genpkey -algorithm ED25519 -out "$temporary/private" >/dev/null 2>&1
openssl pkey -in "$temporary/private" -pubout -out "$temporary/public" >/dev/null 2>&1
jq -n --slurpfile c "$temporary/installation.json" '{schema:1,version:"0.1.0",profiles:{core:($c[0].components|keys),full:($c[0].components|keys)},components:($c[0].components|map_values({image:("example.com/synthetic@sha256:"+("0"*64)),service:{user:"1000:1000",healthcheck:{test:["CMD","true"]}}}))}' > "$temporary/release.json"
openssl pkeyutl -sign -inkey "$temporary/private" -rawin -in "$temporary/release.json" -out "$temporary/release.sig"
HIVE_CONFIG=$temporary/installation.json HIVE_VERSION=0.1.0
HIVE_MANIFEST=$temporary/release.json HIVE_SIGNATURE=$temporary/release.sig HIVE_TRUST_KEY=$temporary/public
hive_validate
hive_manifest
hive_render control > "$temporary/compose.json"
jq -e '.services.emberpath.env_file[0]=="/opt/hive/config/emberpath.env" and .services.emberpath.cap_drop==["ALL"] and (.services.emberpath|has("privileged")|not)' "$temporary/compose.json" >/dev/null
cp "$temporary/release.json" "$temporary/valid.json"
printf '\n' >> "$temporary/release.json"
reject hive_manifest
# A correctly signed manifest cannot smuggle a Docker socket or host networking.
jq '.components.emberpath.service.volumes=["/var/run/docker.sock:/var/run/docker.sock"]' "$temporary/release.json" > "$temporary/unsafe.json"
mv "$temporary/unsafe.json" "$temporary/release.json"
openssl pkeyutl -sign -inkey "$temporary/private" -rawin -in "$temporary/release.json" -out "$temporary/release.sig"
reject hive_manifest
for patch in '.components.emberpath.service.user="0:0"' '.components.emberpath.service.cap_add=["SYS_ADMIN"]' '.components.emberpath.service.healthcheck=null' '.components.emberpath.service.post_start=[{command:"true",user:"root",privileged:true}]' '.components.emberpath.service.healthcheck.disable=true' '.networks={unsafe:{driver:"host"}}'; do
  jq "$patch" "$temporary/valid.json" > "$temporary/release.json"
  openssl pkeyutl -sign -inkey "$temporary/private" -rawin -in "$temporary/release.json" -out "$temporary/release.sig"
  reject hive_manifest
done
printf 'Passed: planning, unattended guards, input injection, signature tampering, pinned rendering and privileged-mount rejection.\n'
