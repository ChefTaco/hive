#!/usr/bin/env bash
set -Eeuo pipefail
ROOT=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)
temporary=$(mktemp -d)
trap 'rm -rf -- "$temporary"' EXIT
export HIVE_ROOT=$ROOT
source "$ROOT/scripts/suite/controller.sh"
source "$ROOT/scripts/suite/test-catalog.sh"
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
hive_test_catalog "$temporary/release.json"
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
jq --slurpfile c "$temporary/suite.json" '{schema:1,version:"0.1.0",profiles:{core:["hive-registry"],full:["hive-registry"]},components:($c[0].components|map_values({image:("example.com/synthetic@sha256:"+("0"*64)),service:{user:"1000:1000",healthcheck:{test:["CMD","true"]},environment:{SYNTHETIC:"kept"}}}))} | .components.hivexui.kind="static-ui" | .components.ingress.kind="ingress" | .components["oathweave-redis"].kind="datastore"|.components["hivemem-qdrant"].kind="datastore"|.components.hivexui.service.environment={}' -n > "$temporary/suite-release.json"
hive_test_catalog "$temporary/suite-release.json"
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
# Permission to mutate a pending schema is visible and bound to its exact plan.
"$ROOT/hive.sh" plan "${suite_arguments[@]}" --allow-migrations > "$temporary/schema-approved.plan"
jq -e '.upgradeSchemaMigrations.writesAllowed==true and .upgradeSchemaMigrations.products==[]' "$temporary/schema-approved.plan" >/dev/null || fail 'Schema approval was absent from the plan'
[[ $(jq -er .planDigest "$temporary/schema-approved.plan") != "$default_digest" ]] || fail 'Schema migration consent did not change the plan digest'
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
# Setup reaches each SSH host before the plan and checks its installation directory.
mkdir -p "$temporary/ssh-bin" "$temporary/remote-parent"
printf '#!/usr/bin/env bash\nexec bash -c "${@: -1}"\n' > "$temporary/ssh-bin/ssh"; chmod 700 "$temporary/ssh-bin/ssh"
jq --arg d "$temporary/remote-parent/hive" '.hosts.control.target="deploy@hive.example.com" | .hosts.control.directory=$d' "$temporary/installation.json" > "$temporary/remote.json"
( set -u; unset HIVE_ID; PATH=$temporary/ssh-bin:$PATH HIVE_CONFIG=$temporary/remote.json hive_setup_hosts_ready ) || fail 'A reachable SSH host with a writable directory was refused'
chmod 500 "$temporary/remote-parent"
if ( set -u; unset HIVE_ID; PATH=$temporary/ssh-bin:$PATH HIVE_CONFIG=$temporary/remote.json hive_setup_hosts_ready ) > "$temporary/ready.log" 2>&1; then
  [[ $(id -u) == 0 ]] || fail 'An unwritable SSH host directory was accepted'
else grep -q "$temporary/remote-parent/hive on .* cannot be created" "$temporary/ready.log" || fail 'The unwritable SSH host directory was not named'; fi
chmod 700 "$temporary/remote-parent"
# A finished install names the console, the initial sign-in file and the next commands.
jq --arg key /opt/certificates/console.key '.bootstrap={adminUsername:"admin",adminEmail:"alice@example.com",certificateFile:"/opt/certificates/console.crt",privateKeyFile:$key}' "$temporary/installation.json" > "$temporary/fresh.json"
summary=$(source "$ROOT/scripts/suite/initialize.sh"; HIVE_CONFIG=$temporary/fresh.json HIVE_ID=example-suite hive_install_summary)
for expected in 'Installed Hive 0.1.0 as installation example-suite' "Console:  $(jq -r .origin "$temporary/fresh.json")/" \
  'SEED_ADMIN_PASSWORD from /opt/hive/config/initial-credentials.env' "./hive.sh status --config $temporary/fresh.json" "./hive.sh tls-refresh --config $temporary/fresh.json"; do
  grep -qF -- "$expected" <<< "$summary" || fail "The install summary lacks: $expected"
done
# tls-refresh without --release runs the one release that pins this exact controller.
checkout=$temporary/checkout
while IFS= read -r file; do mkdir -p "$checkout/$(dirname "$file")"; cp "$ROOT/$file" "$checkout/$file"; done < <(hive_runtime_files)
mkdir -p "$checkout/releases"
digest=$(HIVE_ROOT=$checkout hive_controller_digest)
jq -n --arg digest "$digest" '{version:"9.9.1",controllerSHA256:$digest}' > "$checkout/releases/9.9.1.json"
jq -n '{version:"9.9.0",controllerSHA256:("0"*64)}' > "$checkout/releases/9.9.0.json"
[[ $(HIVE_ROOT=$checkout hive_checkout_release) == 9.9.1 ]] || fail 'The checkout release was not found'
cp "$checkout/releases/9.9.1.json" "$checkout/releases/9.9.2.json"
[[ -z $(HIVE_ROOT=$checkout hive_checkout_release) ]] || fail 'An ambiguous checkout release was chosen'
# A tagged product-only release can share its controller with a prior release. Renewal
# must use the exact tagged release rather than falling back to the old configuration.
jq '.version="9.9.2"' "$checkout/releases/9.9.1.json" > "$checkout/releases/9.9.2.json"
git -C "$checkout" init -q
git -C "$checkout" add .
git -C "$checkout" -c user.name='Synthetic Test' -c user.email=test@example.com commit -qm 'Synthetic shared controller fixture'
git -C "$checkout" tag v9.9.2
[[ $(HIVE_ROOT=$checkout hive_checkout_release) == 9.9.2 ]] || fail 'A tagged shared controller did not select its release for certificate renewal'
git -C "$checkout" tag v9.9.1
[[ -z $(HIVE_ROOT=$checkout hive_checkout_release) ]] || fail 'Multiple matching release tags were silently resolved'
git -C "$checkout" tag -d v9.9.1 v9.9.2 >/dev/null
git -C "$checkout" tag v9.9.0
[[ -z $(HIVE_ROOT=$checkout hive_checkout_release) ]] || fail 'An incompatible tag selected a shared controller release'
git -C "$checkout" tag -d v9.9.0 >/dev/null
[[ -z $(HIVE_ROOT=$checkout hive_checkout_release) ]] || fail 'An untagged shared controller release was chosen'
rm "$checkout/releases/9.9.2.json"
# After an upgrade the installation file still names the earlier release: the checkout's own
# release is used, and said so, without rewriting the file.
jq '.release="9.9.0"' "$temporary/installation.json" > "$temporary/upgraded.json"; before=$(sha256sum "$temporary/upgraded.json")
[[ $(HIVE_ROOT=$checkout HIVE_MANIFEST= HIVE_CONFIG=$temporary/upgraded.json hive_default_release 2> "$temporary/default.log") == 9.9.1 ]] || fail 'The checkout release was not the default after an upgrade'
grep -qF 'using release 9.9.1' "$temporary/default.log" && grep -qF 'names 9.9.0' "$temporary/default.log" || fail 'The release choice was not reported'
[[ $(sha256sum "$temporary/upgraded.json") == "$before" ]] || fail 'The installation file was changed'
# A file naming the release this controller pins, an unknown checkout, or an explicit manifest wins.
jq '.release="9.9.1"' "$temporary/installation.json" > "$temporary/current.json"
[[ $(HIVE_ROOT=$checkout HIVE_MANIFEST= HIVE_CONFIG=$temporary/current.json hive_default_release 2>&1) == 9.9.1 ]] || fail 'A matching release was reported or replaced'
[[ $(HIVE_ROOT=$temporary/none HIVE_MANIFEST= HIVE_CONFIG=$temporary/upgraded.json hive_default_release 2>/dev/null) == 9.9.0 ]] || fail 'A release was chosen without a checkout release'
[[ $(HIVE_ROOT=$checkout HIVE_CONFIG=$temporary/upgraded.json HIVE_MANIFEST=$checkout/releases/9.9.1.json hive_default_release 2>/dev/null) == 9.9.1 ]] || fail 'The given manifest did not name its version'
# An external Magnus: an HTTPS URL with a fully qualified DNS name and an optional port, nothing
# else, in place of the magnus component and beside the console. The plan shows it.
external_config() { jq --argjson external "$1" '.external=$external' "$temporary/installation.json" > "$temporary/external.json"; }
for url in https://magnus.example.com https://magnus.example.com:4000 https://Magnus.Example.com:443 https://fleet-1.magnus.example.com:65535; do
  external_config "$(jq -nc --arg url "$url" '{magnus:{url:$url}}')"
  "$ROOT/hive.sh" plan --config "$temporary/external.json" > "$temporary/external.plan" 2> "$temporary/result" || { cat "$temporary/result" >&2; fail "A valid external Magnus was refused: $url"; }
  jq -e --arg url "$url" '.external=={magnus:{url:$url}} and (.components|has("magnus")|not)' "$temporary/external.plan" >/dev/null || fail "The plan does not show the external Magnus $url"
done
"$ROOT/hive.sh" plan --config "$temporary/installation.json" | jq -e 'has("external")|not' >/dev/null || fail 'A plan without an external Magnus names one'
for url in http://magnus.example.com https://magnus.example.com/ https://magnus.example.com/api https://user:fake@magnus.example.com 'https://magnus.example.com?q=1' 'https://magnus.example.com#x' \
  https://magnus.example.com:0 https://magnus.example.com:65536 https://magnus.example.com:04000 https://magnus.example.com: https://203.0.113.10 https://203.0.113.10:4000 'https://[2001:db8::1]:4000' \
  https://magnus https://localhost:4000 https://-magnus.example.com https://magnus-.example.com https://magnus..example.com https://magnus.example.com. https://magnus_1.example.com ' https://magnus.example.com' ''; do
  external_config "$(jq -nc --arg url "$url" '{magnus:{url:$url}}')"
  reject "$ROOT/hive.sh" plan --config "$temporary/external.json"
  grep -q 'external.magnus is {"url":"https://HOST\[:PORT\]"}' "$temporary/result" || fail "An invalid external Magnus URL lacks a clear refusal: '$url'"
done
for external in '{}' '[]' '{"magnus":"https://magnus.example.com"}' '{"magnus":{}}' '{"magnus":{"url":"https://magnus.example.com","caFile":"/opt/ca.pem"}}' \
  '{"magnus":{"url":"https://magnus.example.com"},"emberpath":{"url":"https://models.example.com"}}' '{"cindertrace":{"url":"https://security.example.com"}}'; do
  external_config "$external"
  reject "$ROOT/hive.sh" plan --config "$temporary/external.json"
  grep -q 'external.magnus is' "$temporary/result" || fail "An invalid external configuration lacks a clear refusal: $external"
done
for patch in '.components.magnus={host:"control",envFile:"/opt/hive/config/magnus.env",configDirectory:"/opt/hive/config/magnus"}' \
  '.components["magnus-gateway"]={host:"control",envFile:"/opt/hive/config/magnus-gateway.env",configDirectory:"/opt/hive/config/magnus-gateway"} | .bootstrap.magnusGateway={sshUsername:"deploy",sshPrivateKeyFile:"/opt/credentials/fleet-key"}' \
  '.components["magnus-postgres"]={host:"control",configDirectory:"/opt/hive/config/magnus-postgres"}' \
  'del(.console) | del(.components.hivexui, .components.ingress)' '.external.magnus.url=.origin' '.external.magnus.url=(.origin+":443")' '.external.magnus.url=(.origin|ascii_upcase|sub("^HTTPS";"https"))'; do
  jq --arg patch "$patch" '.external={magnus:{url:"https://magnus.example.com:4000"}}' "$temporary/installation.json" | jq "$patch" > "$temporary/external.json"
  reject "$ROOT/hive.sh" plan --config "$temporary/external.json"
  grep -q 'An external Magnus takes the place of the magnus component' "$temporary/result" || { cat "$temporary/result" >&2; fail "An external Magnus beside $patch lacks a clear refusal"; }
done
# The release must offer Magnus: the registry records the external Magnus against its catalog.
external_config '{"magnus":{"url":"https://magnus.example.com:4000"}}'
(HIVE_CONFIG=$temporary/external.json; hive_validate; hive_manifest) > "$temporary/result" 2>&1 && fail 'An external Magnus was accepted by a release without Magnus'
grep -q 'needs a release that offers Magnus' "$temporary/result" || fail 'A release without Magnus lacks a clear refusal'
printf 'Passed: planning, unattended guards, input injection, signature tampering, pinned rendering, privileged-mount rejection and digest-bound relaxed authentication limits and checkout release lookup.\n'
