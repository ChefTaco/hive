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
jq -n --slurpfile c "$temporary/installation.json" '{schema:1,version:"0.1.0",profiles:{core:($c[0].components|keys),full:($c[0].components|keys)},components:($c[0].components|map_values({image:("example.com/synthetic@sha256:"+("0"*64)),service:{user:"1000:1000",healthcheck:{test:["CMD","true"]}}}))} | .components.hivexui.kind="static-ui" | .components.ingress.kind="ingress"' > "$temporary/release.json"
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
for patch in '.controllerSHA256=("0"*64)' '.components.emberpath.service.user="0:0"' '.components.emberpath.service.cap_add=["SYS_ADMIN"]' '.components.emberpath.service.healthcheck=null' '.components.emberpath.service.post_start=[{command:"true",user:"root",privileged:true}]' '.components.emberpath.service.healthcheck.disable=true' '.components.emberpath.service.tmpfs=["/etc"]' '.components.emberpath.service.tmpfs=["/run/docker.sock:rw"]' '.components.emberpath.service.tmpfs=["/var/run/../secrets"]' '.components.emberpath.service.tmpfs=["/run/product","/run/product"]' '.networks={unsafe:{driver:"host"}}' '.components.emberpath.initialization={image:"example.com/migrator:latest",command:["apply"],verificationCommand:["verify"]}' '.components.emberpath.initialization={image:("example.com/migrator@sha256:"+("0"*64)),command:["apply"]}' '.components.emberpath.initialization={image:("example.com/migrator@sha256:"+("0"*64)),command:["apply"],verificationCommand:[]}'; do
  jq "$patch" "$temporary/valid.json" > "$temporary/release.json"
  openssl pkeyutl -sign -inkey "$temporary/private" -rawin -in "$temporary/release.json" -out "$temporary/release.sig"
  reject hive_manifest
done
jq '.components.emberpath.service.tmpfs=["/var/run/product"]' "$temporary/valid.json" > "$temporary/release.json"
openssl pkeyutl -sign -inkey "$temporary/private" -rawin -in "$temporary/release.json" -out "$temporary/release.sig"
hive_manifest
hive_render control > "$temporary/tmpfs.compose.json"
jq -e '.services.emberpath.tmpfs==["/tmp:mode=1777","/var/run/product:uid=1000,gid=1000,mode=700"]' "$temporary/tmpfs.compose.json" >/dev/null
# Relaxed authentication limits are an explicit, digest-bound plan change.
reject "$ROOT/hive.sh" plan --config "$temporary/installation.json" --relax-auth-limits --unknown
for command in status doctor rollback backup adopt restore rehearse agents-accept skills-prepare init; do
  if "$ROOT/hive.sh" "$command" --config "$temporary/installation.json" --relax-auth-limits --non-interactive > "$temporary/result" 2>&1; then fail "--relax-auth-limits was accepted by $command"; fi
  grep -q 'applies only to plan, install and upgrade' "$temporary/result" || fail "--relax-auth-limits was not refused first by $command"
done
jq 'del(.components.oathweave,.components["oathweave-redis"])' "$temporary/installation.json" > "$temporary/none.json"
if "$ROOT/hive.sh" plan --config "$temporary/none.json" --relax-auth-limits > "$temporary/result" 2>&1; then fail 'A plan with no limited product accepted --relax-auth-limits'; fi
jq '.profile="custom"|.components+={cindertrace:{host:"control",envFile:"/opt/hive/config/cindertrace.env",configDirectory:"/opt/hive/config/cindertrace"},chattermost:{host:"control",envFile:"/opt/hive/config/chattermost.env",configDirectory:"/opt/hive/config/chattermost"}}' "$temporary/installation.json" > "$temporary/suite.json"
jq --slurpfile c "$temporary/suite.json" '{schema:1,version:"0.1.0",profiles:{core:[],full:[]},components:($c[0].components|map_values({image:("example.com/synthetic@sha256:"+("0"*64)),service:{user:"1000:1000",healthcheck:{test:["CMD","true"]},environment:{SYNTHETIC:"kept"}}}))} | .components.hivexui.kind="static-ui" | .components.ingress.kind="ingress" | .components["oathweave-redis"].kind="datastore"|.components["hivemem-qdrant"].kind="datastore"|.components.hivexui.service.environment={}' -n > "$temporary/suite-release.json"
openssl pkeyutl -sign -inkey "$temporary/private" -rawin -in "$temporary/suite-release.json" -out "$temporary/suite-release.sig"
suite_arguments=(--config "$temporary/suite.json" --release 0.1.0 --manifest "$temporary/suite-release.json" --signature "$temporary/suite-release.sig" --trust-key "$temporary/public")
"$ROOT/hive.sh" plan "${suite_arguments[@]}" > "$temporary/default.plan" 2> "$temporary/default.warning"
"$ROOT/hive.sh" plan "${suite_arguments[@]}" --relax-auth-limits > "$temporary/relaxed.plan" 2> "$temporary/relaxed.warning"
"$ROOT/hive.sh" plan "${suite_arguments[@]}" --relax-auth-limits > "$temporary/relaxed-again.plan" 2>/dev/null
jq -e '.authLimits=={relaxed:false,products:[]}' "$temporary/default.plan" >/dev/null || fail 'Default plan claimed relaxed limits'
jq -e '.authLimits=={relaxed:true,products:["chattermost","cindertrace","oathweave"]}' "$temporary/relaxed.plan" >/dev/null || fail 'Relaxed plan did not report its products'
[[ ! -s "$temporary/default.warning" ]] || fail 'Default plan printed a warning'
grep -q 'WARNING: this plan relaxes' "$temporary/relaxed.warning" || fail 'Relaxed plan did not warn'
default_digest=$(jq -er .planDigest "$temporary/default.plan")
relaxed_digest=$(jq -er .planDigest "$temporary/relaxed.plan")
[[ "$default_digest" =~ ^[a-f0-9]{64}$ && "$relaxed_digest" =~ ^[a-f0-9]{64}$ && "$default_digest" != "$relaxed_digest" ]] || fail 'Toggling relaxed limits did not change the plan digest'
[[ "$relaxed_digest" == "$(jq -er .planDigest "$temporary/relaxed-again.plan")" ]] || fail 'Relaxed plan digest is not stable'
expected_default=$( { sha256sum "$temporary/suite.json" | cut -d ' ' -f1; printf '%s\n' "$(jq -er .manifestDigest "$temporary/default.plan")" "$(jq -er .controllerSourceSHA256 "$temporary/default.plan")"; } | sha256sum | cut -d ' ' -f1)
[[ "$default_digest" == "$expected_default" ]] || fail 'Omitting the flag changed the existing plan digest'
# Applying displays the same plan before asking for confirmation.
if "$ROOT/hive.sh" upgrade "${suite_arguments[@]}" --relax-auth-limits --non-interactive > "$temporary/upgrade.plan" 2>/dev/null; then fail 'Upgrade applied without confirmation'; fi
[[ $(jq -er .planDigest "$temporary/upgrade.plan") == "$relaxed_digest" ]] || fail 'Upgrade displayed a different relaxed plan'
jq -e '.authLimits.relaxed==true' "$temporary/upgrade.plan" >/dev/null || fail 'Upgrade plan did not say limits are relaxed'
HIVE_CONFIG=$temporary/suite.json HIVE_MANIFEST=$temporary/suite-release.json HIVE_SIGNATURE=$temporary/suite-release.sig
hive_validate
hive_manifest
hive_render control > "$temporary/suite-default.compose.json"
HIVE_RELAX_AUTH_LIMITS=true hive_render control > "$temporary/suite-relaxed.compose.json"
jq -e 'all(.services[]; ((.environment // {})|has("RELAX_AUTH_LIMITS") or has("RATE_LIMIT_LOGIN_SOURCE_MAX") or has("RATE_LIMIT_LOGIN_ACCOUNT_MAX"))|not)' "$temporary/suite-default.compose.json" >/dev/null || fail 'Default render relaxed limits'
jq -e '
  (.services.oathweave.environment|.RELAX_AUTH_LIMITS=="true" and .SYNTHETIC=="kept") and
  (.services.cindertrace.environment|.RELAX_AUTH_LIMITS=="true" and .SYNTHETIC=="kept") and
  (.services.chattermost.environment|.RELAX_AUTH_LIMITS=="true" and .RATE_LIMIT_LOGIN_SOURCE_MAX=="10000" and .RATE_LIMIT_LOGIN_ACCOUNT_MAX=="10000" and .SYNTHETIC=="kept") and
  (.services.emberpath.environment|has("RELAX_AUTH_LIMITS")|not)
' "$temporary/suite-relaxed.compose.json" >/dev/null || fail 'Relaxed render did not reach each selected product'
# Only the product environment differs: env files and mounted inputs stay pinned as they are.
[[ $(jq -Sc 'del(.services[].environment)' "$temporary/suite-default.compose.json") == "$(jq -Sc 'del(.services[].environment)' "$temporary/suite-relaxed.compose.json")" ]] || fail 'Relaxed limits changed more than the product environment'
printf 'Passed: planning, unattended guards, input injection, signature tampering, pinned rendering, privileged-mount rejection and digest-bound relaxed authentication limits.\n'
