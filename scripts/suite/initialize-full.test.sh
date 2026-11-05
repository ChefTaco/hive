#!/usr/bin/env bash
set -Eeuo pipefail
ROOT=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)
temporary=$(mktemp -d)
trap 'rm -rf -- "$temporary"' EXIT
fail() { printf 'FAIL: %s\n' "$*" >&2; exit 1; }
reject() { if ( "$@" ) > "$temporary/rejection.log" 2>&1; then fail 'Unsafe fresh full initialization was accepted'; fi; }
openssl req -x509 -newkey rsa:2048 -nodes -keyout "$temporary/server.key" -out "$temporary/server.crt" -subj '/CN=localhost' -addext 'subjectAltName=DNS:localhost' -days 2 >/dev/null 2>&1
chmod 600 "$temporary/server.key"
openssl genpkey -algorithm ED25519 -out "$temporary/publisher.key" >/dev/null 2>&1
openssl pkey -in "$temporary/publisher.key" -pubout -out "$temporary/publisher.pub" >/dev/null 2>&1
jq --arg root "$temporary" '.profile="full" | .origin="https://localhost:65426" | .hosts.control.directory=($root+"/install") |
 .components += (["magnus","magnus-postgres","magnus-redis","cindertrace","cindertrace-postgres","cindertrace-redis","chattermost","chattermost-postgres","emberfold"]|map({key:.,value:({host:"control",configDirectory:("/config/"+.)}+(if test("-(redis|postgres)$") then {} else {envFile:("/config/"+.+".env")} end))})|from_entries) |
 .components|=with_entries(.key as $name|.value.configDirectory=(if $name=="hivexui" then null else $root+"/install/config/"+$name end)|.value|=with_entries(select(.value!=null))|if .value.envFile then .value.envFile=($root+"/install/config/"+$name+".env") else . end) |
 .console.httpsPort=65426 | .console.runtimeFile=($root+"/install/config/runtime.json") | .bootstrap.certificateFile=($root+"/server.crt") | .bootstrap.privateKeyFile=($root+"/server.key")' "$ROOT/examples/installation.json" > "$temporary/config.json"
jq -n --slurpfile c "$temporary/config.json" --arg user "$(id -u):$(id -g)" '{schema:1,version:"0.1.0",profiles:{core:($c[0].components|keys),full:($c[0].components|keys)},components:($c[0].components|map_values({image:("example.com/synthetic@sha256:"+("0"*64)),service:{user:$user,healthcheck:{test:["CMD","true"]}}}))} | .components.hivexui.kind="static-ui" | .components.hivexui.service.user="101:101" | .components.ingress.kind="ingress" | reduce ["magnus","cindertrace","chattermost"][] as $name (.;.components[$name].initialization={image:("example.com/migrator@sha256:"+("1"*64)),command:["apply"],verificationCommand:["verify-current"]}) | .components["magnus-gateway"]={image:("example.com/gateway@sha256:"+("2"*64)),kind:"application",requiresLocal:["magnus"],service:{user:$user,healthcheck:{test:["CMD","true"]}}}' > "$temporary/release.json"
source "$ROOT/scripts/suite/test-catalog.sh"; hive_test_catalog "$temporary/release.json"
openssl pkeyutl -sign -inkey "$temporary/publisher.key" -rawin -in "$temporary/release.json" -out "$temporary/release.json.sig"
mkdir "$temporary/bin"
cat > "$temporary/bin/docker" <<'DOCKER'
#!/usr/bin/env bash
set -Eeuo pipefail
case "$1" in info|ps|pull) exit 0;; compose) printf '%s\n' "$*" >> "${HIVE_TEST_COMPOSE_LOG:?}"; exit 0;; esac
[[ "$1" == run ]] || exit 99
output=''
while (($#)); do
 if [[ "$1" == --mount && "$2" == type=bind,source=*,target=/data ]]; then output=${2#type=bind,source=}; output=${output%,target=/data}; fi
 shift
done
[[ -n "$output" && "$output" == */config/.initializer/cindertrace-browser ]]
umask 077
# This protocol fixture verifies installer ownership and retry behavior only.
# It is not a substitute for the real product Argon2 CLI/browser proof.
if [[ ! -f "$output/browser-admin.json" ]]; then jq -n '{schema:1,username:"admin",passwordHash:"$argon2id$synthetic-non-authenticating-test-hash",sourceSha256:("0"*64)}' > "$output/browser-admin.json"; fi
DOCKER
chmod +x "$temporary/bin/docker"
export PATH="$temporary/bin:$PATH"
run_init() { "$ROOT/hive.sh" init --config "$temporary/config.json" --manifest "$temporary/release.json" --trust-key "$temporary/publisher.pub" --non-interactive --yes; }
run_init > "$temporary/initialization.log"
jq -e '.clients|length==7' "$temporary/install/config/oathweave/suite-bootstrap.json" >/dev/null
# The terminal is off in a fresh install. Oathweave gives its initial administrator every
# permission a client lists, so listing magnus:terminal would grant it to the operator.
jq -e '(.clients[]|select(.id=="hivexui-magnus")|.audience=="magnus" and .permissions==["magnus:view","magnus:operate","magnus:admin"])' "$temporary/install/config/oathweave/suite-bootstrap.json" >/dev/null || fail 'Magnus browser client is not the reviewed resource grant'
if rg -q 'magnus:terminal' "$temporary/install/config/oathweave.env" "$temporary/install/config/oathweave/suite-bootstrap.json"; then fail 'A fresh install granted the terminal by default'; fi
rg -q '^RESOURCE_ENROLLMENT_DASHBOARD_PARTICIPANT=absent$' "$temporary/install/config/magnus.env" || fail 'Magnus without a gateway waits for a console drain participant'
if rg -q 'FLEET_GATEWAY|RESOURCE_ENROLLMENT_DASHBOARD_SECRET' "$temporary/install/config/magnus.env"; then fail 'Magnus was configured for a gateway nobody selected'; fi
if rg -q 'MAGNUS_GATEWAY' "$temporary/install/config/ingress.env"; then fail 'Ingress was given a gateway nobody selected'; fi
[[ ! -e "$temporary/install/config/magnus-gateway.env" && ! -e "$temporary/install/config/magnus-gateway" && ! -e "$temporary/install/config/.initializer/secrets/magnus-gateway-api" ]] || fail 'An unselected gateway got configuration'
"$ROOT/hive.sh" plan --config "$temporary/config.json" --manifest "$temporary/release.json" --trust-key "$temporary/publisher.pub" --non-interactive | jq -e '.magnusTerminal=={gatewaySelected:false,grantedToInitialOperator:false}' >/dev/null || fail 'The plan does not show the terminal as off'
reject "$ROOT/hive.sh" magnus-trust list --config "$temporary/config.json" --non-interactive
grep -q 'no magnus-gateway component' "$temporary/rejection.log" || fail 'Host-key approval without a gateway lacks a clear refusal'
jq -e 'has("links")|not' "$temporary/install/config/runtime.json" >/dev/null || fail 'Fresh runtime still links an external Magnus console'
jq -e '.products.magnus=="/api/magnus" and .identity.clients.magnus=="hivexui-magnus" and (.products|length)==7 and .identity.clients.chattermost=="hivexui-chattermost" and .identity.clients.cindertrace=="hivexui-cindertrace"' "$temporary/install/config/runtime.json" >/dev/null
source "$ROOT/scripts/suite/public-runtime.sh"; hive_check_public_runtime "$temporary/install/config/runtime.json" || fail 'Magnus runtime failed the public browser allowlist'
[[ $(cat "$temporary/install/config/.initializer/secrets/chat-id" | tr -d '\n' | wc -c) == 26 ]] || fail 'Chat product identity is not a native public ID'
[[ $(cat "$temporary/install/config/.initializer/secrets/admin-password") != "$(cat "$temporary/install/config/.initializer/secrets/chat-admin-password")" ]] || fail 'Native product and identity passwords were shared'
[[ $(cat "$temporary/install/config/.initializer/secrets/security-admin-password") != "$(cat "$temporary/install/config/.initializer/secrets/chat-admin-password")" ]] || fail 'Native product passwords were shared'
rg -q '^MAGNUS_AUTO_MIGRATE=false$' "$temporary/install/config/magnus.env" || fail 'Magnus startup auto migrations enabled'
rg -q '^OATHWEAVE_ISSUER=https://localhost:65426/api/oathweave$' "$temporary/install/config/magnus.env" || fail 'Magnus does not verify the suite issuer'
rg -q '^OATHWEAVE_JWKS_URL=https://oathweave:4200/api/v1/oauth/jwks$' "$temporary/install/config/magnus.env" || fail 'Magnus lacks the verified key set'
rg -q '^OATHWEAVE_USERINFO_URL=https://oathweave:4200/api/v1/oauth/userinfo$' "$temporary/install/config/magnus.env" || fail 'Magnus lacks online revocation'
rg -q '^MAGNUS_CONSOLE_BASE_PATH=/fleet$' "$temporary/install/config/magnus.env" || fail 'Magnus console links lack the HiveXUI base path'
rg -q '^MAGNUS_HERMES_ENABLED=true$' "$temporary/install/config/magnus.env" || fail 'Magnus does not report its Hermes capability'
sed -n 's/^MAGNUS_OATHWEAVE_IDENTITIES_JSON=//p' "$temporary/install/config/magnus.env" | jq -e --arg subject "$(cat "$temporary/install/config/.initializer/secrets/identity-id")" --arg id "$(cat "$temporary/install/config/.initializer/secrets/magnus-id")" '.==[{issuer:"https://localhost:65426/api/oathweave",subject:$subject,localUserId:$id,role:"ADMIN"}]' >/dev/null || fail 'Fresh operator is not an explicit Magnus ADMIN link'
rg -q '^MAGNUS_ENDPOINT=https://magnus:4000$' "$temporary/install/config/ingress.env" || fail 'Ingress lacks the verified Magnus endpoint'
rg -q '^MAGNUS_TLS_NAME=magnus$' "$temporary/install/config/ingress.env" || fail 'Ingress lacks the Magnus certificate name'
rg -q '^SECURITY_DISPATCH_ENABLED=false$' "$temporary/install/config/cindertrace.env" || fail 'Security dispatch enabled without approved integration'
rg -F -q "DASHBOARD_ADMIN_PASSWORD_HASH='\$argon2id\$" "$temporary/install/config/cindertrace.env" || fail 'Argon2 hash is vulnerable to Compose environment interpolation'
rg -q '^ADMIN_FORCE_PASSWORD_RESET=false$' "$temporary/install/config/chattermost.env" || fail 'Native chat password reset enabled'
rg -q '^TLS_PROBE_CA_PATH=/config/authority.pem$' "$temporary/install/config/chattermost.env" || fail 'Native TLS probe lacks explicit authority trust'
for component in magnus cindertrace chattermost; do [[ -f "$temporary/install/config/$component-postgres/password" ]] || fail 'Product datastore credential missing'; done
for path in "$temporary/install/config/runtime.json" "$temporary/install/config/ingress.env"; do
 while IFS= read -r secret; do if rg -F -q -- "$(cat "$secret")" "$path"; then fail 'Infrastructure credential reached browser/ingress configuration'; fi; done < <(find "$temporary/install/config/.initializer/secrets" -type f ! -name '*-id')
done
find "$temporary/install/config" -type f -exec sha256sum {} + | sort > "$temporary/before"
run_init > "$temporary/repeated.log"
find "$temporary/install/config" -type f -exec sha256sum {} + | sort > "$temporary/after"
cmp -s "$temporary/before" "$temporary/after" || fail 'Repeated full setup changed existing credentials, IDs or password hash'
# Opt-in: selecting the gateway deploys it and wires Magnus, and only the separate flag grants.
ssh-keygen -q -t ed25519 -N '' -C fleet-gateway-fixture -f "$temporary/fleet-key"
gateway_config() {
  local name=$1 grant=$2
  jq --arg old "$temporary/install" --arg new "$temporary/$name" --arg key "$temporary/fleet-key" --argjson grant "$grant" '
    walk(if type=="string" then (split($old)|join($new)) else . end) |
    .installation=$new_installation |
    .components["magnus-gateway"]={host:"control",envFile:($new+"/config/magnus-gateway.env"),configDirectory:($new+"/config/magnus-gateway")} |
    .bootstrap.magnusGateway=({sshUsername:"deploy",sshPrivateKeyFile:$key}+(if $grant then {grantTerminalToInitialOperator:true} else {} end))
  ' --arg new_installation "synthetic-$name" "$temporary/config.json" > "$temporary/$name.json"
}
gateway_init() { "$ROOT/hive.sh" init --config "$temporary/$1.json" --manifest "$temporary/release.json" --trust-key "$temporary/publisher.pub" --non-interactive --yes; }
gateway_config deployed false
gateway_init deployed > "$temporary/deployed.log"
deployed="$temporary/deployed/config"
jq -e '(.clients[]|select(.id=="hivexui-magnus")|.permissions==["magnus:view","magnus:operate","magnus:admin"])' "$deployed/oathweave/suite-bootstrap.json" >/dev/null || fail 'Deploying the gateway granted the terminal without the flag'
gateway_config granted true
gateway_init granted > "$temporary/granted.log"
granted="$temporary/granted/config"
jq -e '(.clients[]|select(.id=="hivexui-magnus")|.permissions==["magnus:view","magnus:operate","magnus:admin","magnus:terminal"])' "$granted/oathweave/suite-bootstrap.json" >/dev/null || fail 'The explicit opt-in did not reach the browser client'
sed -n 's/^IAM_BROWSER_CLIENT_POLICIES=//p' "$granted/oathweave.env" | jq -e '."hivexui-magnus".permissions|index("magnus:terminal")!=null' >/dev/null || fail 'The browser ceiling differs from the bootstrap client, which Oathweave refuses'
"$ROOT/hive.sh" plan --config "$temporary/granted.json" --manifest "$temporary/release.json" --trust-key "$temporary/publisher.pub" --non-interactive > "$temporary/granted.plan"
jq -e '.magnusTerminal=={gatewaySelected:true,grantedToInitialOperator:true}' "$temporary/granted.plan" >/dev/null || fail 'The plan does not show the grant'
if rg -q 'fleet-key' "$temporary/granted.plan"; then fail 'The plan exposed the SSH key path'; fi
env_value() { sed -n "s/^$2=//p" "$1"; }
api_token=$(cat "$granted/.initializer/secrets/magnus-gateway-api"); drain=$(cat "$granted/.initializer/secrets/magnus-gateway-drain")
[[ ${#api_token} == 64 && ${#drain} == 64 && "$api_token" != "$drain" ]] || fail 'Gateway secrets are not distinct generated values'
[[ $(env_value "$granted/magnus.env" FLEET_GATEWAY_URL) == https://magnus-gateway:4310 ]] || fail 'Magnus lacks the gateway origin'
[[ $(env_value "$granted/magnus.env" FLEET_GATEWAY_TOKEN_SHA256) == "$(printf '%s' "$api_token" | sha256sum | cut -d ' ' -f1)" ]] || fail 'Magnus lacks the digest of the gateway credential'
[[ $(env_value "$granted/magnus.env" RESOURCE_ENROLLMENT_DASHBOARD_SECRET) == "$drain" ]] || fail 'Magnus lacks the drain credential'
[[ $(env_value "$granted/magnus.env" NODE_EXTRA_CA_CERTS) == /config/authority.pem ]] || fail 'Magnus does not trust the gateway certificate authority'
if rg -q 'RESOURCE_ENROLLMENT_DASHBOARD_PARTICIPANT|FLEET_GATEWAY_API_TOKEN' "$granted/magnus.env"; then fail 'Magnus declares the gateway absent, which it refuses to start with, or holds its token'; fi
openssl verify -CAfile "$granted/magnus/authority.pem" -verify_hostname magnus-gateway "$granted/magnus-gateway/tls.crt" >/dev/null || fail 'Magnus cannot verify the gateway certificate'
cmp -s "$temporary/fleet-key" "$granted/magnus-gateway/ssh-key" || fail 'The gateway did not get the operator key'
[[ $(stat -c %a "$granted/magnus-gateway/ssh-key") == 600 && $(stat -c %a "$granted/magnus-gateway.env") == 600 ]] || fail 'Gateway key or environment is not owner-only'
for setting in FLEET_GATEWAY_API_TOKEN="$api_token" RESOURCE_ENROLLMENT_DASHBOARD_SECRET="$drain" FLEET_GATEWAY_TRUST_FORWARDED_FOR=true FLEET_GATEWAY_PORT=4310 FLEET_GATEWAY_PUBLIC_ORIGIN=https://localhost:65426 FLEET_GATEWAY_TLS_NAME=magnus-gateway CONTROL_API_URL=https://magnus:4000 FLEET_GATEWAY_SSH_USERNAME=deploy FLEET_GATEWAY_SSH_PRIVATE_KEY_PATH=/config/ssh-key FLEET_GATEWAY_KNOWN_HOSTS_FILE=/data/known-hosts/known-hosts.json TLS_CERT_PATH=/config/tls.crt OATHWEAVE_ISSUER=https://localhost:65426/api/oathweave; do
  rg -q -F -x -- "$setting" "$granted/magnus-gateway.env" || fail "Gateway environment lacks ${setting%%=*}"
done
[[ $(env_value "$granted/magnus-gateway.env" MAGNUS_OATHWEAVE_IDENTITIES_JSON) == "$(env_value "$granted/magnus.env" MAGNUS_OATHWEAVE_IDENTITIES_JSON)" ]] || fail 'Gateway and server identity links differ'
[[ $(env_value "$granted/ingress.env" MAGNUS_GATEWAY_ENDPOINT) == https://magnus-gateway:4310 && $(env_value "$granted/ingress.env" MAGNUS_GATEWAY_TLS_NAME) == magnus-gateway ]] || fail 'Ingress lacks the verified gateway endpoint'
for path in "$granted/runtime.json" "$granted/ingress.env" "$granted/oathweave.env"; do
  for value in "$api_token" "$drain"; do if rg -F -q -- "$value" "$path"; then fail 'A gateway credential reached browser, ingress or identity configuration'; fi; done
done
if rg -q 'magnus-gateway' "$granted/runtime.json"; then fail 'The browser configuration names the gateway'; fi
source "$ROOT/scripts/suite/public-runtime.sh"; hive_check_public_runtime "$granted/runtime.json" || fail 'Gateway selection broke the public browser allowlist'
find "$granted" -type f -exec sha256sum {} + | sort > "$temporary/gateway.before"
gateway_init granted > "$temporary/granted-repeat.log"
find "$granted" -type f -exec sha256sum {} + | sort > "$temporary/gateway.after"
cmp -s "$temporary/gateway.before" "$temporary/gateway.after" || fail 'A repeated setup changed gateway secrets or configuration'
# Unsafe or inconsistent opt-in configurations.
chmod 640 "$temporary/fleet-key"; reject gateway_init granted; chmod 600 "$temporary/fleet-key"
grep -q 'must be owner-only' "$temporary/rejection.log" || fail 'An exposed SSH key was accepted'
jq 'del(.components["magnus-gateway"])' "$temporary/granted.json" > "$temporary/bad.json"
reject "$ROOT/hive.sh" plan --config "$temporary/bad.json" --non-interactive
grep -q 'bootstrap.magnusGateway belongs with' "$temporary/rejection.log" || fail 'A grant without a gateway was accepted'
jq '.bootstrap.magnusGateway.grantTerminalToInitialOperator="yes"' "$temporary/granted.json" > "$temporary/bad.json"
reject "$ROOT/hive.sh" plan --config "$temporary/bad.json" --non-interactive
jq 'del(.bootstrap.magnusGateway)' "$temporary/granted.json" > "$temporary/bad.json"
reject "$ROOT/hive.sh" plan --config "$temporary/bad.json" --non-interactive
cp "$temporary/release.json" "$temporary/release.valid.json"
jq '.profiles.full+=["magnus-gateway"]' "$temporary/release.valid.json" > "$temporary/release.json"
openssl pkeyutl -sign -inkey "$temporary/publisher.key" -rawin -in "$temporary/release.json" -out "$temporary/release.json.sig"
reject run_init
grep -q 'a release profile cannot select it' "$temporary/rejection.log" || fail 'A release profile selected the web terminal'
mv "$temporary/release.valid.json" "$temporary/release.json"
openssl pkeyutl -sign -inkey "$temporary/publisher.key" -rawin -in "$temporary/release.json" -out "$temporary/release.json.sig"
# Host-key approval reaches only the gateway's own CLI, as data, and needs a deployed gateway.
export HIVE_TEST_COMPOSE_LOG="$temporary/compose.log"
reject "$ROOT/hive.sh" magnus-trust list --config "$temporary/granted.json" --non-interactive
grep -q 'not deployed on this host' "$temporary/rejection.log" || fail 'Host-key approval ran before the gateway was deployed'
jq -n '{services:{"magnus-gateway":{}}}' > "$temporary/granted/compose.json"
fingerprint=SHA256:$(printf 'A%.0s' {1..43})
"$ROOT/hive.sh" magnus-trust add --config "$temporary/granted.json" --non-interactive --node-id node-1 --host node-1.example.com --fingerprint "$fingerprint" --approved-by alice --approval-ref change-1234
"$ROOT/hive.sh" magnus-trust --config "$temporary/granted.json" --non-interactive list
[[ $(cat "$temporary/compose.log") == "compose -f $temporary/granted/compose.json exec -T magnus-gateway magnus-fleet-gateway trust add --node-id node-1 --host node-1.example.com --fingerprint $fingerprint --approved-by alice --approval-ref change-1234
compose -f $temporary/granted/compose.json exec -T magnus-gateway magnus-fleet-gateway trust list" ]] || fail 'Host-key approval did not call the gateway CLI exactly'
for arguments in 'shell' 'add --node-id bad;value' 'add --unknown value'; do
  # shellcheck disable=SC2086
  reject "$ROOT/hive.sh" magnus-trust $arguments --config "$temporary/granted.json" --non-interactive
done
reject "$ROOT/hive.sh" plan --node-id node-1 --config "$temporary/granted.json" --non-interactive
[[ $(wc -l < "$temporary/compose.log") == 2 ]] || fail 'A refused host-key request reached the gateway'
# Configurations that still carry the removed external console link get a clear refusal.
jq '.bootstrap.magnusConsoleOrigin="https://fleet.example.com"' "$temporary/config.json" > "$temporary/config.valid.json.pending"
cp "$temporary/config.json" "$temporary/config.valid.json"; mv "$temporary/config.valid.json.pending" "$temporary/config.json"
reject run_init
grep -q 'magnusConsoleOrigin is no longer supported' "$temporary/rejection.log" || fail 'Removed Magnus console link lacks a clear refusal'
mv "$temporary/config.valid.json" "$temporary/config.json"
cp "$temporary/release.json" "$temporary/release.valid.json"
jq 'del(.components.chattermost.initialization)' "$temporary/release.valid.json" > "$temporary/release.json"
openssl pkeyutl -sign -inkey "$temporary/publisher.key" -rawin -in "$temporary/release.json" -out "$temporary/release.json.sig"
reject run_init
printf 'Passed: full fresh configuration, independent native credentials and datastores, seven browser products with HiveXUI as the Magnus console, the fleet gateway and its terminal grant off by default and each a separate explicit opt-in, protected product-owned hash preparation, disabled automatic dispatch/migrations, stable repeat and required migration artifact refusal.\n'
