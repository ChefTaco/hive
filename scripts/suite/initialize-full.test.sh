#!/usr/bin/env bash
set -Eeuo pipefail
umask 077
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
jq -n --slurpfile c "$temporary/config.json" --arg user "$(id -u):$(id -g)" '{schema:1,version:"0.1.0",profiles:{core:($c[0].components|keys),full:($c[0].components|keys)},components:($c[0].components|map_values({image:("example.com/synthetic@sha256:"+("0"*64)),service:{user:$user,healthcheck:{test:["CMD","true"]}}}))} | .components.hivexui.kind="static-ui" | .components.hivexui.service.user="101:101" | .components.ingress.kind="ingress" | reduce ["magnus","cindertrace","chattermost"][] as $name (.;.components[$name].initialization={image:("example.com/migrator@sha256:"+("1"*64)),command:["apply"],verificationCommand:["verify-current"]}) | .components["magnus-gateway"]={image:("example.com/gateway@sha256:"+("2"*64)),kind:"application",requiresLocal:["magnus"],service:{user:$user,healthcheck:{test:["CMD","true"]}}} | .components.ardentstudio={image:("example.com/studio@sha256:"+("3"*64)),kind:"application",storageFormat:"ardentstudio-v1",service:{user:$user,healthcheck:{test:["CMD","true"]}}}' > "$temporary/release.json"
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
# Intercept external commands during initialization, with no credential in the observer's argv.
# Keep the synthetic observations owner-only. Wrapping bash also checks explicitly traced hosts.
export HIVE_TEST_REAL_PATH="$PATH"
for tool in jq openssl cat sed sha256sum docker bash; do
  [[ "$tool" != docker ]] || mv "$temporary/bin/docker" "$temporary/bin/docker-fixture"
  cat > "$temporary/bin/$tool" <<'OBSERVER'
#!/usr/bin/python3
import json, os, pathlib, shutil, sys
name = pathlib.Path(sys.argv[0]).name
if os.environ.get('HIVE_TEST_ARGV_LOG'):
    with open(os.environ['HIVE_TEST_ARGV_LOG'], 'a') as log:
        log.write(json.dumps([name, *sys.argv[1:]]) + '\n')
real = str(pathlib.Path(sys.argv[0]).with_name('docker-fixture')) if name == 'docker' else shutil.which(name, path=os.environ['HIVE_TEST_REAL_PATH'])
args = sys.argv[1:]
if name == 'bash' and os.environ.get('HIVE_TEST_ARGV_LOG') and args[:1] == ['-c'] and 'Fresh configuration only.' in args[1]:
    args.insert(0, '-xv')
if name == 'jq' and os.environ.get('HIVE_TEST_FAIL_SECRET_JQ') and '--rawfile' in args:
    sys.stderr.write('Synthetic protected-file read failure\n')
    sys.exit(1)
os.execv(real, [real, *args])
OBSERVER
  chmod +x "$temporary/bin/$tool"
done
export PATH="$temporary/bin:$PATH"
run_init() { "$ROOT/hive.sh" init --config "$temporary/config.json" --manifest "$temporary/release.json" --trust-key "$temporary/publisher.pub" --non-interactive --yes; }
HIVE_TEST_ARGV_LOG="$temporary/initializer-argv.jsonl" run_init > "$temporary/initialization.log" 2>&1
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
# Magnus enrolls Ardent agents in HiveMem as its own Oathweave service identity: one machine
# client with the scopes it grants agents plus admin:agents and workspaces:write, the matching
# HiveMem service link on the native issuer, and the client in Magnus's environment only.
install="$temporary/install/config"
value() { sed -n "s/^$2=//p" "$1" | tail -1; }
magnus_memory_secret=$(cat "$install/.initializer/secrets/magnus-hivemem-client")
[[ "$magnus_memory_secret" =~ ^[a-f0-9]{64}$ ]] || fail 'The Magnus HiveMem client secret is not a generated value'
memory_scopes='["admin:agents","workspaces:write","memories:read","memories:write","sessions:read","sessions:write"]'
value "$install/oathweave.env" IAM_MACHINE_CLIENT_POLICIES | jq -e --argjson scopes "$memory_scopes" '.=={"magnus-hivemem":{audience:"hivemem",permissions:($scopes|map("hivemem:"+.)),lifetimeSeconds:300,rotationOwner:"hive-suite"}}' >/dev/null || fail 'The Magnus HiveMem machine client is not the reviewed grant'
value "$install/oathweave.env" IAM_MACHINE_CLIENT_SECRETS | jq -e --arg secret "$magnus_memory_secret" '.=={"magnus-hivemem":$secret}' >/dev/null || fail 'Oathweave lacks the Magnus HiveMem client secret'
native_issuer=$(value "$install/oathweave.env" JWT_ISSUER)
value "$install/hivemem.env" HIVEMEM_OATHWEAVE_SERVICES_JSON | jq -e --arg issuer "$native_issuer" --argjson scopes "$memory_scopes" '.==[{issuer:$issuer,clientId:"magnus-hivemem",localId:"magnus-ardent",scopes:$scopes}]' >/dev/null || fail 'HiveMem lacks the Magnus service link on the native issuer'
for setting in MAGNUS_ARDENT_HIVEMEM_URL=https://hivemem:18790 MAGNUS_ARDENT_HIVEMEM_AGENT_URL=https://localhost:65426/memory/ \
  MAGNUS_ARDENT_HIVEMEM_TOKEN_URL=https://oathweave:4200/api/v1/oauth/token MAGNUS_ARDENT_HIVEMEM_CLIENT_ID=magnus-hivemem \
  MAGNUS_ARDENT_HIVEMEM_CLIENT_SECRET="$magnus_memory_secret" MAGNUS_ARDENT_HIVEMEM_WORKSPACE_ID=ardent-agents; do
  rg -q -F -x -- "$setting" "$install/magnus.env" || fail "Magnus environment lacks ${setting%%=*}"
done
if rg -q 'MAGNUS_ARDENT_HIVEMEM_ENROLLMENT_TOKEN' "$install/magnus.env"; then fail 'Magnus got a static HiveMem token beside its service identity'; fi
# Ardent skill installs read the HiveSkills catalog at its internal HTTPS address, which the suite
# authority Magnus trusts has certified; the registry needs no credential from Magnus.
rg -q -F -x 'MAGNUS_ARDENT_HIVESKILLS_URL=https://hiveskills:4030' "$install/magnus.env" || fail 'Magnus lacks the HiveSkills registry for Ardent skill installs'
rg -q -F -x 'NODE_EXTRA_CA_CERTS=/config/authority.pem' "$install/magnus.env" || fail 'Magnus does not trust the suite authority'
openssl verify -CAfile "$install/magnus/authority.pem" -verify_hostname hiveskills "$install/hiveskills/tls.crt" >/dev/null || fail 'Magnus cannot verify the HiveSkills certificate'
# Ardent command reconciliation: an independent generated key on the server, which the node agents copy.
reconcile_secret=$(cat "$install/.initializer/secrets/magnus-reconcile")
[[ "$reconcile_secret" =~ ^[a-f0-9]{64}$ ]] || fail 'The command reconciliation key is not a generated value'
rg -q -F -x -- "COMMAND_RECONCILIATION_SECRET=$reconcile_secret" "$install/magnus.env" || fail 'Magnus lacks the command reconciliation key'
for name in magnus-api magnus-jwt magnus-manager magnus-audit magnus-result magnus-log magnus-rotation magnus-metrics magnus-webhook; do
  [[ $(cat "$install/.initializer/secrets/$name") != "$reconcile_secret" ]] || fail "The command reconciliation key repeats $name"
done
for path in "$install/runtime.json" "$install/ingress.env" "$install/hivemem.env" "$install/oathweave.env" "$install/hiveskills.env"; do
  if rg -F -q -- "$reconcile_secret" "$path"; then fail 'The command reconciliation key reached another product'; fi
done
for path in "$install/runtime.json" "$install/ingress.env" "$install/hivemem.env" "$install/oathweave/suite-bootstrap.json"; do
  if rg -F -q -- "$magnus_memory_secret" "$path"; then fail 'The Magnus HiveMem client secret reached browser, ingress or HiveMem configuration'; fi
done
# Ardent Project Studio is offered by this release but not selected: nothing about it is configured.
if rg -q 'ardentstudio' "$install/oathweave.env" "$install/oathweave/suite-bootstrap.json" "$install/runtime.json" "$install/magnus.env" "$install/hivemem.env"; then fail 'An unselected Studio got identity, console, Magnus or HiveMem configuration'; fi
if rg -q 'ARDENTSTUDIO' "$temporary/install/config/ingress.env"; then fail 'Ingress was given a Studio nobody selected'; fi
[[ ! -e "$temporary/install/config/ardentstudio.env" && ! -e "$temporary/install/config/ardentstudio" && ! -e "$temporary/install/config/.initializer/secrets/studio-magnus-client" ]] || fail 'An unselected Studio got configuration'
find "$temporary/install/config" -type f -exec sha256sum {} + | sort > "$temporary/before"
run_init > "$temporary/repeated.log"
find "$temporary/install/config" -type f -exec sha256sum {} + | sort > "$temporary/after"
cmp -s "$temporary/before" "$temporary/after" || fail 'Repeated full setup changed existing credentials, IDs or password hash'
# Ardent Project Studio, when selected: a browser client, two machine clients with generated
# secrets, their Magnus and HiveMem links, and its own environment and ingress route.
studio_config() {
  jq --arg old "$temporary/install" --arg new "$temporary/$1" '
    walk(if type=="string" then (split($old)|join($new)) else . end) | .installation=("synthetic-"+($new|split("/")|last)) |
    .components.ardentstudio={host:"control",envFile:($new+"/config/ardentstudio.env"),configDirectory:($new+"/config/ardentstudio")}
  ' "$temporary/config.json" > "$temporary/$1.json"
}
studio_config studio
HIVE_TEST_ARGV_LOG="$temporary/studio-argv.jsonl" "$ROOT/hive.sh" init --config "$temporary/studio.json" --manifest "$temporary/release.json" --trust-key "$temporary/publisher.pub" --non-interactive --yes > "$temporary/studio.log" 2>&1
studio="$temporary/studio/config"
# Exercise the failure path too; it must retain the protected files for an identical retry.
studio_config secret-failure
if HIVE_TEST_FAIL_SECRET_JQ=1 HIVE_TEST_ARGV_LOG="$temporary/failure-argv.jsonl" "$ROOT/hive.sh" init --config "$temporary/secret-failure.json" --manifest "$temporary/release.json" --trust-key "$temporary/publisher.pub" --non-interactive --yes > "$temporary/secret-failure.log" 2>&1; then
  fail 'The synthetic secret-file read failure was ignored'
fi
python3 - "$temporary" <<'PRIVACY'
import json, pathlib, stat, sys
root = pathlib.Path(sys.argv[1])
for name, logs in [('install', ['initializer-argv.jsonl', 'initialization.log']), ('studio', ['studio-argv.jsonl', 'studio.log']), ('secret-failure', ['failure-argv.jsonl', 'secret-failure.log'])]:
    config = root / name / 'config'
    # Account IDs are not credentials; all generated passwords/keys must be absent from argv/output.
    secrets = {p.name: p.read_text().strip() for p in (config / '.initializer/secrets').iterdir() if not p.name.endswith('-id')}
    captured = ''.join((root / log).read_text() for log in logs)
    for key, value in secrets.items():
        assert value and value not in captured, 'Generated credential exposed in subprocess arguments or output'
        assert stat.S_IMODE((config / '.initializer/secrets' / key).stat().st_mode) == 0o600, 'Credential file mode changed'
    if name != 'secret-failure':
        values = dict(line.split('=', 1) for line in (config / 'oathweave.env').read_text().splitlines())
        clients = json.loads(values['IAM_MACHINE_CLIENT_SECRETS'])
        assert clients['magnus-hivemem'] == secrets['magnus-hivemem-client'], 'Magnus client configuration changed'
        if name == 'studio':
            assert clients['ardentstudio-magnus'] == secrets['studio-magnus-client'], 'Studio client configuration changed'
            assert clients['ardentstudio-hivemem'] == secrets['studio-hivemem-client'], 'Studio memory configuration changed'
        account = json.loads((config / 'cindertrace/initial-browser-account.json').read_text())
        assert account['password'] == secrets['security-admin-password'], 'Security account configuration changed'
        for file in ['oathweave.env', 'cindertrace/initial-browser-account.json']:
            assert stat.S_IMODE((config / file).stat().st_mode) == 0o600, 'Published configuration is exposed'
PRIVACY
# Subsequent configuration assertions do not need the process observer.
python3 - "$temporary/bin" <<'UNWRAP'
import pathlib, sys
root = pathlib.Path(sys.argv[1])
for name in ['jq', 'openssl', 'cat', 'sed', 'sha256sum', 'bash', 'docker']:
    (root / name).unlink()
(root / 'docker-fixture').rename(root / 'docker')
UNWRAP
hash -r
magnus_secret=$(cat "$studio/.initializer/secrets/studio-magnus-client"); memory_secret=$(cat "$studio/.initializer/secrets/studio-hivemem-client")
[[ "$magnus_secret" =~ ^[a-f0-9]{64}$ && "$memory_secret" =~ ^[a-f0-9]{64}$ && "$magnus_secret" != "$memory_secret" ]] || fail 'Studio client secrets are not distinct generated values'
permissions='["ardentstudio:projects:read","ardentstudio:projects:write","ardentstudio:templates:read","ardentstudio:templates:write","ardentstudio:review:write","ardentstudio:agents:admin"]'
jq -e --argjson permissions "$permissions" '(.clients|length)==8 and (.clients[]|select(.id=="hivexui-ardentstudio")|.audience=="ardentstudio" and .permissions==$permissions and .firstParty==true)' "$studio/oathweave/suite-bootstrap.json" >/dev/null || fail 'Studio browser client is not the reviewed resource grant'
value "$studio/oathweave.env" IAM_BROWSER_CLIENT_POLICIES | jq -e --argjson permissions "$permissions" '."hivexui-ardentstudio"=={audience:"ardentstudio",permissions:$permissions}' >/dev/null || fail 'The Studio browser ceiling differs from its bootstrap client'
studio_fleet_secret=$(cat "$studio/.initializer/secrets/magnus-hivemem-client")
[[ "$studio_fleet_secret" != "$magnus_secret" && "$studio_fleet_secret" != "$memory_secret" ]] || fail 'Magnus and Studio share a client secret'
value "$studio/oathweave.env" IAM_MACHINE_CLIENT_POLICIES | jq -e --argjson scopes "$memory_scopes" '.=={
  "ardentstudio-magnus":{audience:"magnus",permissions:["magnus:ardent"],lifetimeSeconds:300,rotationOwner:"hive-suite",issuer:"browser"},
  "ardentstudio-hivemem":{audience:"hivemem",permissions:["hivemem:workspaces:write","hivemem:memories:write"],lifetimeSeconds:300,rotationOwner:"hive-suite"},
  "magnus-hivemem":{audience:"hivemem",permissions:($scopes|map("hivemem:"+.)),lifetimeSeconds:300,rotationOwner:"hive-suite"}}' >/dev/null || fail 'Studio and Magnus machine client policies are not the reviewed grants'
value "$studio/oathweave.env" IAM_MACHINE_CLIENT_SECRETS | jq -e --arg magnus "$magnus_secret" --arg memory "$memory_secret" --arg fleet "$studio_fleet_secret" '.=={"ardentstudio-magnus":$magnus,"ardentstudio-hivemem":$memory,"magnus-hivemem":$fleet}' >/dev/null || fail 'Oathweave lacks the Studio and Magnus client secrets'
rg -q -F -x -- "MAGNUS_ARDENT_HIVEMEM_CLIENT_SECRET=$studio_fleet_secret" "$studio/magnus.env" || fail 'Magnus lacks its HiveMem client secret beside Studio'
rg -q -F -x 'MAGNUS_ARDENT_HIVESKILLS_URL=https://hiveskills:4030' "$studio/magnus.env" || fail 'Magnus lacks the HiveSkills registry beside Studio'
[[ $(value "$studio/oathweave.env" JWT_ISSUER) == oathweave-synthetic-studio ]] || fail 'Unexpected native issuer'
value "$studio/magnus.env" MAGNUS_OATHWEAVE_IDENTITIES_JSON | jq -e --arg subject "$(cat "$studio/.initializer/secrets/identity-id")" '.[0].subject==$subject and .[0].role=="ADMIN" and .[1]=={issuer:"https://localhost:65426/api/oathweave",subject:"ardentstudio-magnus",localUserId:"ardentstudio",role:"ARDENT_SERVICE"} and length==2' >/dev/null || fail 'Magnus lacks the Studio service link on the browser issuer'
value "$studio/hivemem.env" HIVEMEM_OATHWEAVE_SERVICES_JSON | jq -e --argjson scopes "$memory_scopes" '.==[{issuer:"oathweave-synthetic-studio",clientId:"ardentstudio-hivemem",localId:"ardentstudio",scopes:["workspaces:write","memories:write"]},{issuer:"oathweave-synthetic-studio",clientId:"magnus-hivemem",localId:"magnus-ardent",scopes:$scopes}]' >/dev/null || fail 'HiveMem lacks the Studio and Magnus service links on the native issuer'
for setting in NODE_EXTRA_CA_CERTS=/config/authority.pem ARDENT_STUDIO_HOST=0.0.0.0 ARDENT_STUDIO_PORT=8097 ARDENT_STUDIO_DATA=/data \
  OATHWEAVE_ISSUER=https://localhost:65426/api/oathweave OATHWEAVE_JWKS_URL=https://oathweave:4200/api/v1/oauth/jwks OATHWEAVE_USERINFO_URL=https://oathweave:4200/api/v1/oauth/userinfo \
  ARDENT_STUDIO_OATHWEAVE_TOKEN_URL=https://oathweave:4200/api/v1/oauth/token ARDENT_STUDIO_MAGNUS_URL=https://magnus:4000 ARDENT_STUDIO_MAGNUS_CLIENT_ID=ardentstudio-magnus \
  ARDENT_STUDIO_MAGNUS_CLIENT_SECRET="$magnus_secret" ARDENT_STUDIO_MAGNUS_SCOPE=magnus:ardent ARDENT_STUDIO_HIVEMEM_URL=https://hivemem:18790 ARDENT_STUDIO_HIVEMEM_CLIENT_ID=ardentstudio-hivemem \
  ARDENT_STUDIO_HIVEMEM_CLIENT_SECRET="$memory_secret" "ARDENT_STUDIO_HIVEMEM_SCOPE='hivemem:workspaces:write hivemem:memories:write'"; do
  rg -q -F -x -- "$setting" "$studio/ardentstudio.env" || fail "Studio environment lacks ${setting%%=*}"
done
value "$studio/ardentstudio.env" ARDENT_STUDIO_OATHWEAVE_IDENTITIES_JSON | jq -e --arg subject "$(cat "$studio/.initializer/secrets/identity-id")" --arg id "$(cat "$studio/.initializer/secrets/studio-id")" '.==[{issuer:"https://localhost:65426/api/oathweave",subject:$subject,localUserId:$id,displayName:"admin"}]' >/dev/null || fail 'The operator is not an explicit Studio link'
[[ $(stat -c %a "$studio/ardentstudio.env") == 600 ]] || fail 'Studio environment is not owner-only'
openssl verify -CAfile "$studio/ardentstudio/authority.pem" -verify_hostname magnus "$studio/magnus/tls.crt" >/dev/null || fail 'Studio cannot verify Magnus'
openssl verify -CAfile "$studio/ardentstudio/authority.pem" -verify_hostname hivemem "$studio/hivemem/tls.crt" >/dev/null || fail 'Studio cannot verify HiveMem'
[[ ! -e "$studio/ardentstudio/tls.key" ]] || fail 'Studio got a TLS key it does not serve'
[[ $(value "$studio/ingress.env" ARDENTSTUDIO_ENDPOINT) == http://ardentstudio:8097 ]] || fail 'Ingress lacks the Studio route'
jq -e '.products.ardentstudio=="/api/ardentstudio" and .identity.clients.ardentstudio=="hivexui-ardentstudio" and (.products|length)==8' "$studio/runtime.json" >/dev/null || fail 'The console does not know Studio'
source "$ROOT/scripts/suite/public-runtime.sh"; hive_check_public_runtime "$studio/runtime.json" || fail 'Studio broke the public browser allowlist'
for path in "$studio/runtime.json" "$studio/ingress.env" "$studio/magnus.env" "$studio/hivemem.env"; do
  for secret in "$magnus_secret" "$memory_secret"; do if rg -F -q -- "$secret" "$path"; then fail 'A Studio client secret reached browser, ingress, Magnus or HiveMem configuration'; fi; done
done
for path in "$studio/runtime.json" "$studio/ingress.env" "$studio/hivemem.env" "$studio/ardentstudio.env"; do
  if rg -F -q -- "$studio_fleet_secret" "$path"; then fail 'The Magnus HiveMem client secret reached browser, ingress, HiveMem or Studio configuration'; fi
done
rendered=$(source "$ROOT/scripts/suite/controller.sh"; HIVE_ROOT=$ROOT HIVE_CONFIG=$temporary/studio.json HIVE_MANIFEST=$temporary/release.json HIVE_SIGNATURE=$temporary/release.json.sig HIVE_TRUST_KEY=$temporary/publisher.pub HIVE_VERSION=0.1.0; hive_validate; hive_manifest >/dev/null; hive_render control)
jq -e --arg data "$temporary/studio/data/ardentstudio" --arg env "$studio/ardentstudio.env" '.services.ardentstudio as $s | $s.env_file==[$env] and ($s.volumes|any(.source==$data and .target=="/data")) and ($s.volumes|any(.target=="/config" and .read_only==true)) and $s.ports==null and $s.read_only==true and $s.cap_drop==["ALL"]' <<< "$rendered" >/dev/null || fail 'Studio is not rendered as a private, read-only service with its data volume'
find "$studio" -type f -exec sha256sum {} + | sort > "$temporary/studio.before"
"$ROOT/hive.sh" init --config "$temporary/studio.json" --manifest "$temporary/release.json" --trust-key "$temporary/publisher.pub" --non-interactive --yes > "$temporary/studio-repeat.log"
find "$studio" -type f -exec sha256sum {} + | sort > "$temporary/studio.after"
cmp -s "$temporary/studio.before" "$temporary/studio.after" || fail 'A repeated setup changed Studio secrets or configuration'
# Studio needs Magnus and HiveMem, and runs with Oathweave on the console host.
jq '.profile="custom" | del(.components.hivemem, .components["hivemem-qdrant"])' "$temporary/studio.json" > "$temporary/studio-refused.json"
reject "$ROOT/hive.sh" init --config "$temporary/studio-refused.json" --manifest "$temporary/release.json" --trust-key "$temporary/publisher.pub" --non-interactive --yes
grep -q 'Ardent Project Studio needs Magnus and HiveMem' "$temporary/rejection.log" || fail 'Studio without HiveMem lacks a clear refusal'
jq '.profile="custom" | del(.components.magnus, .components["magnus-postgres"], .components["magnus-redis"])' "$temporary/studio.json" > "$temporary/studio-refused.json"
reject "$ROOT/hive.sh" init --config "$temporary/studio-refused.json" --manifest "$temporary/release.json" --trust-key "$temporary/publisher.pub" --non-interactive --yes
grep -q 'Ardent Project Studio needs Magnus and HiveMem' "$temporary/rejection.log" || fail 'Studio without Magnus lacks a clear refusal'
# An external Magnus in place of the magnus component: the console and Studio use it, the ingress
# verifies it on its own name against the system trust store, and the entries that Magnus needs
# are written for the operator. Nothing configures a Magnus HiveMem identity for it.
external_url=https://magnus.example.com:4000
jq --arg old "$temporary/install" --arg new "$temporary/external" --arg url "$external_url" '
  walk(if type=="string" then (split($old)|join($new)) else . end) | .installation="synthetic-external" | .profile="custom" |
  del(.components.magnus, .components["magnus-postgres"], .components["magnus-redis"]) |
  .components.ardentstudio={host:"control",envFile:($new+"/config/ardentstudio.env"),configDirectory:($new+"/config/ardentstudio")} |
  .external={magnus:{url:$url}}' "$temporary/config.json" > "$temporary/external.json"
external_init() { "$ROOT/hive.sh" init --config "$temporary/external.json" --manifest "$temporary/release.json" --trust-key "$temporary/publisher.pub" --non-interactive --yes; }
external_init > "$temporary/external.log" 2>&1 || { cat "$temporary/external.log" >&2; fail 'Setup with an external Magnus failed'; }
external="$temporary/external/config"
grep -qF "External Magnus: add the entries in $external/.initializer/external-magnus.env to the environment of the Magnus at $external_url" "$temporary/external.log" || fail 'The operator is not told where the external Magnus entries are'
while IFS= read -r secret; do if rg -F -q -- "$(cat "$secret")" "$temporary/external.log" "$external/.initializer/external-magnus.env"; then fail 'A generated credential was printed or written for the external Magnus'; fi; done < <(find "$external/.initializer/secrets" -type f ! -name '*-id')
# The console signs in to it with the same reviewed browser client as for the component.
jq -e '(.clients|length)==8 and (.clients[]|select(.id=="hivexui-magnus")|.audience=="magnus" and .permissions==["magnus:view","magnus:operate","magnus:admin"] and .firstParty==true)' "$external/oathweave/suite-bootstrap.json" >/dev/null || fail 'The external Magnus has no reviewed browser client'
value "$external/oathweave.env" IAM_BROWSER_CLIENT_POLICIES | jq -e '."hivexui-magnus"=={audience:"magnus",permissions:["magnus:view","magnus:operate","magnus:admin"]}' >/dev/null || fail 'The Magnus browser ceiling differs from its bootstrap client'
jq -e '.products.magnus=="/api/magnus" and .identity.clients.magnus=="hivexui-magnus" and .products.ardentstudio=="/api/ardentstudio" and (.products|length)==8' "$external/runtime.json" >/dev/null || fail 'The console does not show the external Magnus'
hive_check_public_runtime "$external/runtime.json" || fail 'The external Magnus broke the public browser allowlist'
# The ingress reaches it on its own name with system trust, and nothing else about Magnus.
[[ $(value "$external/ingress.env" MAGNUS_ENDPOINT) == "$external_url" && $(value "$external/ingress.env" MAGNUS_TLS_NAME) == magnus.example.com &&
   $(value "$external/ingress.env" MAGNUS_TRUST_FILE) == /etc/ssl/certs/ca-certificates.crt ]] || fail 'The ingress does not verify the external Magnus against the system trust store'
[[ $(rg -c '^MAGNUS_TRUST_FILE=' "$temporary/install/config/ingress.env" "$studio/ingress.env" | wc -l) == 0 ]] || fail 'An internal Magnus lost the suite authority'
if rg -q 'MAGNUS_GATEWAY' "$external/ingress.env"; then fail 'The ingress was given a gateway for an external Magnus'; fi
[[ ! -e "$external/ingress/native-listeners-magnus-agents.caddy" ]] || fail 'An agent port was published for an external Magnus'
# Studio uses it, with its own Magnus client on the browser issuer, and its HiveMem link only.
rg -q -F -x "ARDENT_STUDIO_MAGNUS_URL=$external_url" "$external/ardentstudio.env" || fail 'Studio does not use the external Magnus'
rg -q -F -x 'ARDENT_STUDIO_MAGNUS_CLIENT_ID=ardentstudio-magnus' "$external/ardentstudio.env" && rg -q -F -x 'NODE_EXTRA_CA_CERTS=/config/authority.pem' "$external/ardentstudio.env" || fail 'Studio lacks its Magnus client or trust'
value "$external/oathweave.env" IAM_MACHINE_CLIENT_POLICIES | jq -e '.=={
  "ardentstudio-magnus":{audience:"magnus",permissions:["magnus:ardent"],lifetimeSeconds:300,rotationOwner:"hive-suite",issuer:"browser"},
  "ardentstudio-hivemem":{audience:"hivemem",permissions:["hivemem:workspaces:write","hivemem:memories:write"],lifetimeSeconds:300,rotationOwner:"hive-suite"}}' >/dev/null || fail 'The machine clients beside an external Magnus are not the reviewed Studio grants'
value "$external/hivemem.env" HIVEMEM_OATHWEAVE_SERVICES_JSON | jq -e '.==[{issuer:"oathweave-synthetic-external",clientId:"ardentstudio-hivemem",localId:"ardentstudio",scopes:["workspaces:write","memories:write"]}]' >/dev/null || fail 'HiveMem got another service link beside Studio'
if rg -q 'magnus-hivemem|MAGNUS_ARDENT' "$external"; then fail 'A Magnus HiveMem identity was configured for an external Magnus'; fi
[[ ! -e "$external/magnus.env" && ! -e "$external/magnus" && ! -e "$external/magnus-postgres" && ! -e "$external/.initializer/secrets/magnus-api" && ! -e "$external/.initializer/secrets/magnus-hivemem-client" ]] || fail 'An external Magnus got local Magnus configuration'
# The entries the external Magnus needs, for the operator: the browser issuer, its key set and
# userinfo through the console origin, and the operator ADMIN and Studio service links.
external_file="$external/.initializer/external-magnus.env"
[[ -f "$external_file" && $(stat -c %a "$external_file") == 600 ]] || fail 'The external Magnus entries are not owner-only'
[[ $(jq -r --arg path "$external_file" '.files[$path]' "$external/.initializer/receipt.json") == $(sha256sum "$external_file" | cut -d ' ' -f1) ]] || fail 'The initializer does not record the external Magnus entries'
rg -q -F -x 'OATHWEAVE_ISSUER=https://localhost:65426/api/oathweave' "$external_file" &&
  rg -q -F -x 'OATHWEAVE_JWKS_URL=https://localhost:65426/api/oathweave/oauth/jwks' "$external_file" &&
  rg -q -F -x 'OATHWEAVE_USERINFO_URL=https://localhost:65426/api/oathweave/oauth/userinfo' "$external_file" || fail 'The external Magnus entries do not name the browser issuer through the console'
[[ $(rg -v '^#' "$external_file" | cut -d= -f1 | tr '\n' ' ') == 'OATHWEAVE_ISSUER OATHWEAVE_JWKS_URL OATHWEAVE_USERINFO_URL MAGNUS_OATHWEAVE_IDENTITIES_JSON ' ]] || fail 'The external Magnus entries are not exactly the four it needs'
value "$external_file" MAGNUS_OATHWEAVE_IDENTITIES_JSON | sed "s/^'//; s/'\$//" | jq -e --arg subject "$(cat "$external/.initializer/secrets/identity-id")" --arg id "$(cat "$external/.initializer/secrets/magnus-id")" '.==[
  {issuer:"https://localhost:65426/api/oathweave",subject:$subject,localUserId:$id,role:"ADMIN"},
  {issuer:"https://localhost:65426/api/oathweave",subject:"ardentstudio-magnus",localUserId:"ardentstudio",role:"ARDENT_SERVICE"}]' >/dev/null || fail 'The external Magnus links are not the operator ADMIN and the Studio service'
[[ $(cat "$external/.initializer/secrets/magnus-id") =~ ^[a-f0-9]{64}$ ]] || fail 'The operator has no Magnus account ID for the external Magnus'
# The deployment runs no Magnus; the plan and the registry record name the external one.
rendered=$(source "$ROOT/scripts/suite/controller.sh"; HIVE_ROOT=$ROOT HIVE_CONFIG=$temporary/external.json HIVE_MANIFEST=$temporary/release.json HIVE_SIGNATURE=$temporary/release.json.sig HIVE_TRUST_KEY=$temporary/publisher.pub HIVE_VERSION=0.1.0; hive_validate; hive_manifest >/dev/null; hive_render control)
jq -e '(.services|has("magnus") or has("magnus-postgres") or has("magnus-redis") or has("magnus-gateway")|not) and .services.ardentstudio!=null and (.services.ingress.ports|length)==1' <<< "$rendered" >/dev/null || fail 'The deployment runs a Magnus beside the external one'
"$ROOT/hive.sh" plan --config "$temporary/external.json" --manifest "$temporary/release.json" --trust-key "$temporary/publisher.pub" --non-interactive | jq -e --arg url "$external_url" '.external=={magnus:{url:$url}} and (.components|has("magnus")|not)' >/dev/null || fail 'The plan does not show the external Magnus'
record=$(source "$ROOT/scripts/suite/controller.sh"; source "$ROOT/scripts/suite/registry.sh"; HIVE_ROOT=$ROOT HIVE_CONFIG=$temporary/external.json HIVE_MANIFEST=$temporary/release.json HIVE_SIGNATURE=$temporary/release.json.sig HIVE_TRUST_KEY=$temporary/publisher.pub HIVE_VERSION=0.1.0; hive_validate; hive_manifest >/dev/null; hive_registry_body complete installed)
jq -e --arg url "$external_url" '(.installed|map(select(.id=="magnus")))==[{id:"magnus",status:"external",connection:{consolePath:"/fleet",browserPrefix:"/api/magnus",nativeApis:{},internalEndpoints:{api:$url}}}] and (.catalog|any(.id=="magnus"))' <<< "$record" >/dev/null || fail 'The registry does not record the external Magnus'
find "$external" -type f -exec sha256sum {} + | sort > "$temporary/external.before"
external_init > "$temporary/external-repeat.log" 2>&1
find "$external" -type f -exec sha256sum {} + | sort > "$temporary/external.after"
cmp -s "$temporary/external.before" "$temporary/external.after" || fail 'A repeated setup changed the external Magnus configuration'
# Studio still needs HiveMem beside an external Magnus.
jq 'del(.components.hivemem, .components["hivemem-qdrant"])' "$temporary/external.json" > "$temporary/studio-refused.json"
reject "$ROOT/hive.sh" init --config "$temporary/studio-refused.json" --manifest "$temporary/release.json" --trust-key "$temporary/publisher.pub" --non-interactive --yes
grep -q 'Ardent Project Studio needs Magnus and HiveMem' "$temporary/rejection.log" || fail 'Studio beside an external Magnus without HiveMem lacks a clear refusal'
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
# A Magnus host agent port: one agent-only listener, published on the console bind address with
# the console certificate, and nothing else accepted in console.nativeListeners.
agent_config() {
  jq --arg old "$temporary/install" --arg new "$temporary/$1" --argjson listeners "$2" '
    walk(if type=="string" then (split($old)|join($new)) else . end) | .installation=("synthetic-"+($new|split("/")|last)) | .console.nativeListeners=$listeners
  ' "$temporary/config.json" > "$temporary/$1.json"
}
agent_config agents '[{"port":4000,"component":"magnus"}]'
gateway_init agents > "$temporary/agents.log"
fragment="$temporary/agents/config/ingress/native-listeners-magnus-agents.caddy"
[[ -f "$fragment" && $(stat -c %a "$fragment") == 600 ]] || fail 'The Magnus agent listener was not written owner-only'
grep -qx ':4000 {' "$fragment" && grep -qx $'\ttls /config/console.crt /config/console.key' "$fragment" && grep -qx $'\timport magnus_agent_listener' "$fragment" || fail 'The Magnus agent listener is not the reviewed route set'
grep -q '^(magnus_agent_listener) {' "$temporary/agents/config/ingress/Caddyfile" || fail 'The installed Caddyfile lacks the agent route set'
[[ ! -e "$temporary/install/config/ingress/native-listeners-magnus-agents.caddy" ]] || fail 'An agent port was published without being asked for'
"$ROOT/hive.sh" plan --config "$temporary/agents.json" --manifest "$temporary/release.json" --trust-key "$temporary/publisher.pub" --non-interactive | jq -e '.console.magnusAgentPort==4000' >/dev/null || fail 'The plan does not show the agent port'
rendered=$(source "$ROOT/scripts/suite/controller.sh"; HIVE_ROOT=$ROOT HIVE_CONFIG=$temporary/agents.json HIVE_MANIFEST=$temporary/release.json HIVE_SIGNATURE=$temporary/release.json.sig HIVE_TRUST_KEY=$temporary/publisher.pub HIVE_VERSION=0.1.0; hive_validate; hive_manifest >/dev/null; hive_render control)
jq -e --arg bind "$(jq -r .console.bindAddress "$temporary/agents.json")" '.services.ingress.ports|any(.target==4000 and .published=="4000" and .host_ip==$bind)' <<< "$rendered" >/dev/null || fail 'The agent port is not published on the console bind address'
jq -e '.services.magnus.ports==null' <<< "$rendered" >/dev/null || fail 'Magnus itself was published'
for listeners in '[{"port":4000,"component":"cindertrace"}]' '[{"port":65426,"component":"magnus"}]' '[{"port":80,"component":"magnus"}]' \
  '[{"port":4000,"component":"magnus"},{"port":4001,"component":"magnus"}]' '[{"port":4000,"component":"magnus","upstream":"magnus:4000"}]'; do
  agent_config refused "$listeners"
  reject "$ROOT/hive.sh" plan --config "$temporary/refused.json" --manifest "$temporary/release.json" --trust-key "$temporary/publisher.pub" --non-interactive
  grep -q 'console.nativeListeners on a fresh installation' "$temporary/rejection.log" || fail "An invalid agent listener was not refused: $listeners"
done
# Without HiveSkills, Magnus has no registry for Ardent skill installs.
jq --arg old "$temporary/install" --arg new "$temporary/noskills" 'walk(if type=="string" then (split($old)|join($new)) else . end) | .installation="synthetic-noskills" | .profile="custom" | del(.components.hiveskills)' "$temporary/config.json" > "$temporary/noskills.json"
"$ROOT/hive.sh" init --config "$temporary/noskills.json" --manifest "$temporary/release.json" --trust-key "$temporary/publisher.pub" --non-interactive --yes > "$temporary/noskills.log" 2>&1 || { cat "$temporary/noskills.log" >&2; fail 'Setup without HiveSkills failed'; }
[[ -f "$temporary/noskills/config/magnus.env" ]] || fail 'Magnus was not configured without HiveSkills'
if rg -q 'MAGNUS_ARDENT_HIVESKILLS_URL' "$temporary/noskills/config/magnus.env"; then fail 'Magnus was given a HiveSkills registry nobody selected'; fi
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
printf 'Passed: full fresh configuration, independent native credentials and datastores, seven browser products with HiveXUI as the Magnus console, the fleet gateway and its terminal grant off by default and each a separate explicit opt-in, protected product-owned hash preparation, disabled automatic dispatch/migrations, stable repeat, required migration artifact refusal, the opt-in Magnus host agent listener, opt-in Ardent Project Studio with its service identities, an external Magnus in place of the component with its operator entries, the HiveSkills registry for Ardent skill installs and the command reconciliation key.\n'
