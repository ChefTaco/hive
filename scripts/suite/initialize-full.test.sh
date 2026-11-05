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
jq -n --slurpfile c "$temporary/config.json" --arg user "$(id -u):$(id -g)" '{schema:1,version:"0.1.0",profiles:{core:($c[0].components|keys),full:($c[0].components|keys)},components:($c[0].components|map_values({image:("example.com/synthetic@sha256:"+("0"*64)),service:{user:$user,healthcheck:{test:["CMD","true"]}}}))} | .components.hivexui.kind="static-ui" | .components.hivexui.service.user="101:101" | .components.ingress.kind="ingress" | reduce ["magnus","cindertrace","chattermost"][] as $name (.;.components[$name].initialization={image:("example.com/migrator@sha256:"+("1"*64)),command:["apply"],verificationCommand:["verify-current"]})' > "$temporary/release.json"
source "$ROOT/scripts/suite/test-catalog.sh"; hive_test_catalog "$temporary/release.json"
openssl pkeyutl -sign -inkey "$temporary/publisher.key" -rawin -in "$temporary/release.json" -out "$temporary/release.json.sig"
mkdir "$temporary/bin"
cat > "$temporary/bin/docker" <<'DOCKER'
#!/usr/bin/env bash
set -Eeuo pipefail
case "$1" in info|ps|pull) exit 0;; esac
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
jq -e '(.clients[]|select(.id=="hivexui-magnus")|.audience=="magnus" and .permissions==["magnus:view","magnus:operate","magnus:admin","magnus:terminal"])' "$temporary/install/config/oathweave/suite-bootstrap.json" >/dev/null || fail 'Magnus browser client is not the reviewed resource grant'
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
printf 'Passed: full fresh configuration, independent native credentials and datastores, seven browser products with HiveXUI as the Magnus console, protected product-owned hash preparation, disabled automatic dispatch/migrations, stable repeat and required migration artifact refusal.\n'
