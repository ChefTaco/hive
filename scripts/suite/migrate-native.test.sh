#!/usr/bin/env bash
# hive.sh migrate-native controller paths with fake data and stubbed containers. Nothing is
# started. The real flow is rehearsed by scripts/suite/native-migration-rehearsal.mjs.
set -Eeuo pipefail
ROOT=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)
source "$ROOT/scripts/suite/test-catalog.sh"
temporary=$(mktemp -d)
trap 'rm -rf -- "$temporary"' EXIT
fail() { printf 'FAIL: %s\n' "$*" >&2; exit 1; }
command -v sqlite3 >/dev/null || { printf 'migrate-native tests skipped: sqlite3 is not installed\n'; exit 0; }
user="$(id -u):$(id -g)"
source_root="$temporary/restored/state"
directory="$temporary/suite"
fqdn=hive.example.com
mkdir -m 700 "$temporary/bin" "$temporary/restored" "$temporary/restored/recovery"

# ---- A fake native installation. ----
mkdir -p "$source_root"/{opt/hive-iam/certs,opt/hive-iam/prisma,opt/hive-iam/audit-logs,opt/hive-router/shared/certs,opt/hive-router/shared/data,opt/hivemem/certs,opt/hive-skills/shared/data/archives,var/opt/hivemem/models,var/lib/hive-iam-keyring/releases/r1/previous}
ln -s releases/r1 "$source_root/var/lib/hive-iam-keyring/current"
certificate() { # NAME SAN
  openssl req -x509 -newkey rsa:2048 -nodes -days 30 -subj "/CN=$1" -addext "subjectAltName=$2" -keyout "$3.key" -out "$3.crt" >/dev/null 2>&1
}
certificate "$fqdn" "DNS:$fqdn" "$source_root/opt/hive-router/shared/certs/server"
mkdir -p "$source_root/var/lib/hive-iam-pki"
openssl req -x509 -newkey rsa:2048 -nodes -days 365 -subj '/CN=fake identity authority' -addext 'basicConstraints=critical,CA:TRUE' -keyout "$source_root/var/lib/hive-iam-pki/ca.key" -out "$source_root/var/lib/hive-iam-pki/ca.crt" >/dev/null 2>&1
cp "$source_root/var/lib/hive-iam-pki/ca.crt" "$source_root/opt/hive-iam/certs/ca.crt"
openssl req -new -newkey rsa:2048 -nodes -subj /CN=hive -keyout "$source_root/opt/hive-iam/certs/server.key" -out "$temporary/leaf.csr" >/dev/null 2>&1
printf 'subjectAltName=DNS:hive,DNS:%s,DNS:localhost,IP:127.0.0.1\n' "$fqdn" > "$temporary/leaf.ext"
openssl x509 -req -in "$temporary/leaf.csr" -CA "$source_root/var/lib/hive-iam-pki/ca.crt" -CAkey "$source_root/var/lib/hive-iam-pki/ca.key" -CAcreateserial -days 1 -extfile "$temporary/leaf.ext" -out "$source_root/opt/hive-iam/certs/server.crt" >/dev/null 2>&1
certificate hive 'DNS:hive,DNS:localhost' "$source_root/opt/hivemem/certs/server"
openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:2048 -out "$source_root/var/lib/hive-iam-keyring/current/active-private.pem" >/dev/null 2>&1
openssl pkey -in "$source_root/var/lib/hive-iam-keyring/current/active-private.pem" -pubout -out "$source_root/var/lib/hive-iam-keyring/current/active-public.pem" >/dev/null 2>&1
printf 'JWT_PRIVATE_KEY_PATH=/var/lib/hive-iam-keyring/current/active-private.pem\nJWT_PUBLIC_KEY_PATH=/var/lib/hive-iam-keyring/current/active-public.pem\nJWT_PREVIOUS_PUBLIC_KEY_PATHS=\n' > "$source_root/var/lib/hive-iam-keyring/current/keyring.env"
policies='{"portal":{"audience":"portal","permissions":["portal:read"],"lifetimeSeconds":3600,"rotationOwner":"portal"},"exporter":{"audience":"hive-router","permissions":["iam:audit:read"],"lifetimeSeconds":3600,"rotationOwner":"security-exporter"}}'
cat > "$source_root/opt/hive-iam/.env" <<ENV
DATABASE_URL=file:./prisma/iam.db
REDIS_URL=redis://localhost:6379
REDIS_PREFIX=hive-iam
JWT_ISSUER=hive-iam
COOKIE_SECRET=fake-cookie-secret
IAM_AGENT_SECRET=example-agent-value
TLS_CERT_PATH=certs/server.crt
TLS_KEY_PATH=certs/server.key
PORT=4200
AUDIT_LOG_DIR=./audit-logs
TRUSTED_PROXY_IPS=192.0.2.10
SEED_ADMIN_PASSWORD=fake-seed-password-must-not-copy
IAM_MACHINE_CLIENT_POLICIES='$policies'
ENV
cat > "$source_root/opt/hive-router/shared/.env" <<'ENV'
API_PORT=4020
ADMIN_PORT=443
PUBLIC_API_URL=https://hive:4020
DATABASE_URL=file:/opt/hive-router/shared/data/router.db
TLS_CERT_PATH=/opt/hive-router/shared/certs/server.crt
TLS_KEY_PATH=/opt/hive-router/shared/certs/server.key
HIVE_ROUTER_SECRET=fake-router-secret
HIVE_ROUTER_IAM_ISSUER=hive-iam
HIVE_ROUTER_IAM_CLIENT_ID=hive-router
HIVE_ROUTER_IAM_CLIENT_SECRET=fake-client-secret
HIVE_ROUTER_OS_AUTH_COMMAND=/must/not/copy
HIVE_ROUTER_SECURITY_EXPORT_TOKEN_HASH=$argon2id$v=19$m=65536$fakesalt$fakehash
HIVE_ROUTER_SECURITY_EXPORTER_CLIENT_ID=legacy-exporter-name
ENV
cat > "$source_root/opt/hivemem/.env" <<'ENV'
HIVEMEM_JWT_SECRET=superseded-fake-secret
HIVEMEM_JWT_SECRET=effective-fake-secret
HIVEMEM_WEB_PORT=18443
HIVEMEM_RENEWAL_SECRET=fake-renewal-secret
HIVEMEM_ADMIN_TOKEN=fake-admin-token
HIVEMEM_EMBEDDING_MODEL_PATH=/var/opt/hivemem/models/fake.gguf
HIVEMEM_ADMIN_OS_LOGIN_ENABLED=true
ENV
cat > "$source_root/opt/hive-skills/shared/.env" <<ENV
HIVE_SKILLS_PORT=4030
HIVE_SKILLS_PUBLIC_URL=https://$fqdn:4030
HIVE_SKILLS_DATA_DIR=/opt/hive-skills/shared/data
HIVE_SKILLS_ADMIN_USERS=operator
HIVE_SKILLS_TLS_CERT_FILE=/opt/hive-router/shared/certs/server.crt
HIVE_SKILLS_TLS_KEY_FILE=/opt/hive-router/shared/certs/server.key
HIVE_SKILLS_SESSION_SECRET=fake-skills-secret
ENV
sqlite3 "$source_root/opt/hive-iam/prisma/iam.db" "PRAGMA journal_mode=WAL;
  CREATE TABLE users (id TEXT PRIMARY KEY, username TEXT, email TEXT, active INTEGER, mfaEnabled INTEGER, lastLoginAt TEXT, passwordChangedAt TEXT, lockedUntil TEXT, passwordHash TEXT);
  CREATE TABLE roles (id TEXT PRIMARY KEY, name TEXT); CREATE TABLE user_role_assignments (userId TEXT, roleId TEXT);
  CREATE TABLE webauthn_credentials (userId TEXT); CREATE TABLE password_policies (maxAgeDays INTEGER, isDefault INTEGER);
  INSERT INTO users VALUES ('subject-admin','admin','same@example.com',1,0,'2026-01-01T00:00:00.000+00:00','2020-01-01T00:00:00.000+00:00',NULL,'fake-hash-admin');
  INSERT INTO users VALUES ('subject-other','other','same@example.com',1,0,NULL,'2030-01-01T00:00:00.000+00:00',NULL,'fake-hash-other');
  INSERT INTO roles VALUES ('r1','SUPER_ADMIN'); INSERT INTO user_role_assignments VALUES ('subject-admin','r1'); INSERT INTO password_policies VALUES (90,1);" >/dev/null
sqlite3 "$source_root/opt/hive-router/shared/data/router.db" "CREATE TABLE AdminUser (id TEXT, username TEXT); INSERT INTO AdminUser VALUES ('local-admin','admin');"
sqlite3 "$source_root/opt/hive-skills/shared/data/registry.sqlite" "CREATE TABLE releases (id TEXT);"
machine=$(printf 'fake-machine-id' | sha256sum | cut -d ' ' -f1)
printf '{"schemaVersion":2,"host":"hive","machineId":"fake-machine-id"}\n' > "$temporary/restored/recovery/manifest.json"

# ---- A signed release and an installation configuration. ----
openssl genpkey -algorithm ED25519 -out "$temporary/publisher.key" >/dev/null 2>&1
openssl pkey -in "$temporary/publisher.key" -pubout -out "$temporary/publisher.pub" >/dev/null 2>&1
component() { jq -nc --arg user "$user" --arg kind "$1" --arg image "example.com/$2@sha256:$(printf '%064d' 1)" --arg format "$2-v1" '{image:$image,kind:$kind,storageFormat:$format,service:{user:$user,healthcheck:{test:["CMD","true"]}}}'; }
jq -n --arg user "$user" --argjson app "$(component application fixture)" --argjson data "$(component datastore fixture)" --argjson ui "$(component static-ui ui)" --argjson ingress "$(component ingress ingress)" '
  {schema:1,version:"0.1.0",networks:{"identity-data":{driver:"bridge",internal:true}},profiles:{core:["hive-registry"],full:["hive-registry"]},
   components:{"hive-registry":$app,oathweave:$app,"oathweave-redis":$data,emberpath:$app,hivemem:$app,"hivemem-qdrant":$data,hiveskills:$app,hivexui:$ui,ingress:$ingress}}' > "$temporary/release.json"
hive_test_catalog "$temporary/release.json"
openssl pkeyutl -sign -inkey "$temporary/publisher.key" -rawin -in "$temporary/release.json" -out "$temporary/release.json.sig"
printf '{"schema":1,"installation":"primary","links":[{"product":"emberpath","subject":"subject-admin","localId":"local-admin","approved":true}],"grants":[{"subject":"subject-admin","role":"SUITE_ADMIN","approved":true}]}\n' > "$temporary/links.json"
chmod 600 "$temporary/links.json"
jq -n --arg base "$directory" --arg root "$source_root" --arg control "$temporary/bin/native-control" --arg machine "$machine" --arg links "$temporary/links.json" --arg token "$temporary/admin-token" --arg origin "https://$fqdn" '
  def placed($name): {host:"control",envFile:($base+"/config/"+$name+".env"),configDirectory:($base+"/config/"+$name)};
  {schema:1,installation:"primary",release:"0.1.0",profile:"custom",origin:$origin,hosts:{control:{target:"local",directory:$base,minimumFreeMiB:0}},
   components:{"hive-registry":placed("hive-registry"),oathweave:placed("oathweave"),"oathweave-redis":{host:"control",configDirectory:($base+"/config/oathweave-redis")},emberpath:placed("emberpath"),hivemem:placed("hivemem"),"hivemem-qdrant":{host:"control",configDirectory:($base+"/config/hivemem-qdrant")},hiveskills:placed("hiveskills"),hivexui:{host:"control"},ingress:placed("ingress")},
   agents:[],inference:[],
   console:{host:"control",bindAddress:"0.0.0.0",httpsPort:443,runtimeFile:($base+"/config/runtime.json"),nativeListeners:[{port:4020,component:"emberpath"},{port:4200,component:"oathweave"},{port:18443,component:"hivemem"},{port:4030,component:"hiveskills"}],networkSubnet:"10.200.0.0/24"},
   nativeMigration:{schema:1,rehearsal:true,expectedHost:"hive",machineIdSHA256:$machine,browserIssuer:($origin+"/api/oathweave"),reviewedLinksFile:$links,dataAliases:{hiveskills:"/opt/hive-skills/shared/data"},
     adminAccount:{subject:"subject-admin",username:"admin",tokenFile:$token},
     source:{root:$root,serviceManager:"command",controlCommand:$control,qdrantUrl:"http://192.0.2.1:6333",redisUrl:"redis://192.0.2.1:6379",dataNetwork:"fake"}}}' > "$temporary/config.json"
chmod 600 "$temporary/config.json"
# Records every call. Native control is a stub; nothing ever really starts or stops.
cat > "$temporary/bin/docker" <<STUB
#!/usr/bin/env bash
printf '%s\n' "\$*" >> "$temporary/docker.calls"
case "\$1 \$2" in 'compose -f') if [[ "\$*" == *issue-reset-token* ]]; then printf '{"account":"subject-admin","expiresAt":"2030-01-01T00:00:00.000Z"}\n'; fi;; esac
exit 0
STUB
cat > "$temporary/bin/native-control" <<STUB
#!/usr/bin/env bash
printf '%s\n' "\$*" >> "$temporary/native.calls"
[[ "\$1" != is-active ]] || [[ -f "$temporary/native-running" ]]
STUB
chmod 700 "$temporary/bin/docker" "$temporary/bin/native-control"
touch "$temporary/native-running"
hive() {
  local subcommand=$1 config=$2; shift 2
  PATH="$temporary/bin:$PATH" "$ROOT/hive.sh" migrate-native "$subcommand" --config "$config" --manifest "$temporary/release.json" --trust-key "$temporary/publisher.pub" --non-interactive "$@"
}
refused() { # MESSAGE COMMAND...
  local message=$1; shift
  if "$@" > "$temporary/result" 2>&1; then fail "Accepted: $*"; fi
  grep -q -- "$message" "$temporary/result" || { cat "$temporary/result" >&2; fail "Expected refusal '$message'"; }
}

# ---- Configuration validation and installation binding. ----
variant() { jq "$1" "$temporary/config.json" > "$temporary/variant.json"; chmod 600 "$temporary/variant.json"; }
variant '.nativeMigration.source.serviceManager="command"|.nativeMigration.rehearsal=false'
refused 'Invalid nativeMigration' hive plan "$temporary/variant.json"
variant '.nativeMigration.browserIssuer="http://insecure.example.com"'
refused 'Invalid nativeMigration' hive plan "$temporary/variant.json"
variant '.bootstrap={adminUsername:"a"}'
refused 'Invalid' hive plan "$temporary/variant.json"
variant '.nativeMigration.expectedHost="other"'
refused 'independent installations are never mixed' hive plan "$temporary/variant.json"
variant '.nativeMigration.machineIdSHA256=("0"*64)'
refused 'independent installations are never mixed' hive plan "$temporary/variant.json"
printf '{"schema":1,"installation":"secondary","links":[],"grants":[]}\n' > "$temporary/other-links.json"; chmod 600 "$temporary/other-links.json"
jq --arg links "$temporary/other-links.json" '.nativeMigration.reviewedLinksFile=$links' "$temporary/config.json" > "$temporary/variant.json"; chmod 600 "$temporary/variant.json"
refused 'belongs to another installation' hive plan "$temporary/variant.json"
tar -C "$temporary/restored" -czf "$temporary/this.tar.gz" recovery
mkdir -p "$temporary/other/recovery"; printf '{"schemaVersion":2,"host":"secondary","machineId":"other"}\n' > "$temporary/other/recovery/manifest.json"
tar -C "$temporary/other" -czf "$temporary/other.tar.gz" recovery
jq --arg archive "$temporary/other.tar.gz" '.nativeMigration.source.archive=$archive' "$temporary/config.json" > "$temporary/variant.json"; chmod 600 "$temporary/variant.json"
refused 'This archive belongs to another installation' hive plan "$temporary/variant.json"
jq --arg archive "$temporary/this.tar.gz" '.nativeMigration.source.archive=$archive' "$temporary/config.json" > "$temporary/variant.json"; chmod 600 "$temporary/variant.json"
hive plan "$temporary/variant.json" > /dev/null || fail 'The right archive was refused'

# ---- plan reads only. ----
hive plan "$temporary/config.json" > "$temporary/plan.json"
[[ ! -e "$directory" ]] || fail 'plan created the installation directory'
[[ ! -s "$temporary/native.calls" ]] || ! grep -qE '^(stop|start) ' "$temporary/native.calls" || fail 'plan controlled a native service'
jq -e '.bindingVerified==true and .modelFilesCopied==false and ([.nativeListeners[].port]|sort)==[443,4020,4030,4200,18443]' "$temporary/plan.json" >/dev/null || fail 'plan inventory'
jq -e '.administrator.found==true and (.administrator.candidates|length)==2 and (.administrator.candidates[]|select(.username=="admin")|.passwordExpired==true and .roles=="SUPER_ADMIN")' "$temporary/plan.json" >/dev/null || fail 'plan administrator candidates'
# Same email on two accounts links nothing: only the reviewed entry applies.
jq -e '.identity.links.applied==[{product:"emberpath",subject:"subject-admin",localId:"local-admin"}] and .identity.links.grants==[{subject:"subject-admin",role:"SUITE_ADMIN"}]' "$temporary/plan.json" >/dev/null || fail 'plan links'
jq -e '[.decisions[]]|any(test("hivemem")) and any(test("hiveskills"))' "$temporary/plan.json" >/dev/null || fail 'plan must list missing links'
variant '.nativeMigration.adminAccount=null'
hive plan "$temporary/variant.json" | jq -e '[.decisions[]]|any(test("Confirm the administrator"))' >/dev/null || fail 'An unconfirmed administrator must be a decision, never a guess'

# Links are never guessed: an unknown subject or local account is refused, an unapproved one stays pending.
printf '{"schema":1,"installation":"primary","links":[{"product":"emberpath","subject":"subject-from-other-installation","localId":"local-admin","approved":true},{"product":"emberpath","subject":"subject-admin","localId":"no-such-account","approved":true},{"product":"hivemem","subject":"subject-admin","localId":"agent-one","approved":false}],"grants":[]}\n' > "$temporary/bad-links.json"; chmod 600 "$temporary/bad-links.json"
jq --arg links "$temporary/bad-links.json" '.nativeMigration.reviewedLinksFile=$links' "$temporary/config.json" > "$temporary/variant.json"; chmod 600 "$temporary/variant.json"
hive plan "$temporary/variant.json" > "$temporary/bad-plan.json"
jq -e '(.identity.links.applied|length)==0 and (.identity.links.refused|length)==2 and (.identity.links.pending|length)==1' "$temporary/bad-plan.json" >/dev/null || fail 'Link review'

# ---- Native names map to product names; values stay byte-exact. ----
input() { jq -nc --arg action "$1" --slurpfile c "$temporary/config.json" --slurpfile links "$temporary/links.json" --slurpfile r "$temporary/release.json" --arg template "$(base64 -w0 "$ROOT/deployment/Caddyfile")" --arg script "$(base64 -w0 "$ROOT/scripts/suite/set-admin-password.sh")" --arg tool "$(base64 -w0 "$ROOT/scripts/suite/migrate-native-data.mjs")" '
  $c[0] as $config | {directory:$config.hosts.control.directory,installation:$config.installation,host:"control",action:$action,plan:("a"*64),origin:$config.origin,version:"0.1.0",operation:"install",
  placements:$config.components,console:$config.console,nativeMigration:$config.nativeMigration,reviewedLinks:$links[0],ingressTemplate:$template,adminScript:$script,dataTool:$tool,
  bootstrapServiceUsers:($r[0].components|map_values(.service.user)),bootstrapImages:($r[0].components|map_values(.image))}'; }
host_action() { input "$1" | PATH="$temporary/bin:$PATH" bash "$ROOT/scripts/suite/migrate-native-host.sh"; }
host_action native-configure 2> "$temporary/configure.log" || { cat "$temporary/configure.log" >&2; fail 'configure'; }
env_of() { sed -n "s/^$2='\(.*\)'$/\1/p" "$directory/config/$1.env"; }
[[ $(env_of oathweave IAM_MACHINE_CLIENT_POLICIES) == "$policies" ]] || fail 'The machine-client policy must stay byte-identical'
[[ $(env_of oathweave JWT_ISSUER) == hive-iam ]] || fail 'The native issuer must stay'
[[ $(env_of oathweave COOKIE_SECRET) == fake-cookie-secret ]] || fail 'Native secrets carry over'
[[ $(env_of oathweave TRUSTED_PROXY_IPS) == 192.0.2.10,10.200.0.0/24 ]] || fail 'The ingress subnet must be a trusted proxy, added to the native list'
[[ $(env_of oathweave IAM_BROWSER_ISSUER) == "https://$fqdn/api/oathweave" ]] || fail 'Browser issuer'
! grep -q SEED_ "$directory/config/oathweave.env" || fail 'Seed values must not reach the suite'
[[ $(env_of emberpath HIVE_ROUTER_SECURITY_EXPORT_TOKEN_HASH) == '$argon2id$v=19$m=65536$fakesalt$fakehash' ]] || fail 'A dollar sign must survive literally'
[[ $(env_of emberpath HIVE_ROUTER_SECURITY_EXPORTER_CLIENT_ID) == legacy-exporter-name ]] || fail 'The kept client name must carry over'
! grep -q OS_AUTH_COMMAND "$directory/config/emberpath.env" || fail 'The host authentication helper must not carry over'
[[ $(env_of emberpath EMBERPATH_OATHWEAVE_IDENTITIES_JSON) == "[{\"issuer\":\"https://$fqdn/api/oathweave\",\"subject\":\"subject-admin\",\"localId\":\"local-admin\"}]" ]] || fail 'Reviewed link'
[[ $(env_of hivemem HIVEMEM_JWT_SECRET) == effective-fake-secret ]] || fail 'The last assignment wins, as in systemd'
[[ $(env_of hivemem HIVEMEM_ADMIN_OS_LOGIN_ENABLED) == false ]] || fail 'Containers have no PAM'
! grep -q MODEL_PATH "$directory/config/hivemem.env" || fail 'No model path carries over'
[[ $(env_of hiveskills HIVE_SKILLS_DATA_DIR) == /opt/hive-skills/shared/data ]] || fail 'Stored archive paths must keep resolving'
[[ $(env_of hiveskills HIVESKILLS_OATHWEAVE_IDENTITIES_JSON) == '[]' ]] || fail 'No unreviewed link'

# ---- Native listeners keep their ports and certificates. ----
config="$directory/config/ingress"
for port in 443 4020 4200 18443 4030; do [[ -f "$config/native/$port.crt" && -f "$config/native/$port.key" ]] || fail "Listener $port has no certificate"; done
cmp -s "$config/native/4200.crt" "$source_root/opt/hive-iam/certs/server.crt" || fail 'The identity port keeps its native certificate'
cmp -s "$config/native/18443.crt" "$source_root/opt/hivemem/certs/server.crt" || fail 'The memory port keeps its native certificate'
cmp -s "$config/console.crt" "$source_root/opt/hive-router/shared/certs/server.crt" || fail 'The console keeps its native certificate'
grep -q '^:4200 {' "$config/native-listeners.caddy" && grep -q 'reverse_proxy https://oathweave:4200' "$config/native-listeners.caddy" || fail 'Identity listener'
grep -q 'reverse_proxy https://hivemem:18790' "$config/native-listeners.caddy" || fail 'Memory listener'
grep -q '^:4030 {' "$config/native-listeners.caddy" || fail 'Skills listener'
! grep -qE '^:(4100|9090) ' "$config/native-listeners.caddy" || fail 'Ports owned by other services are never taken'
grep -q 'handle /v1/\*' "$config/native-routes.caddy" && grep -A1 'handle /v1/\*' "$config/native-routes.caddy" | grep -q HIVEMEM_ENDPOINT || fail '/v1 on the console port is the memory API on a migrated installation'
grep -q 'import /config/native-routes\*.caddy' "$ROOT/deployment/Caddyfile" && grep -q 'import /config/native-listeners\*.caddy' "$ROOT/deployment/Caddyfile" || fail 'Fresh installs import nothing extra; migrated ones import these'
[[ $(stat -c %a "$config/native/4200.key") == 600 ]] || fail 'Private keys stay owner-only'
source "$ROOT/scripts/suite/controller.sh"
HIVE_CONFIG="$temporary/config.json" HIVE_MANIFEST="$temporary/release.json" HIVE_RELAX_AUTH_LIMITS=false hive_render control > "$temporary/compose.json"
jq -e '.services.ingress.ports|map(.published)|sort==["18443","4020","4030","4200","443"]' "$temporary/compose.json" >/dev/null || fail 'Renderer ports'
jq -e '.services.ingress.ports|all(.host_ip=="0.0.0.0")' "$temporary/compose.json" >/dev/null || fail 'Listener address'
jq -e '[.services[]|select(has("ports"))]|length==1' "$temporary/compose.json" >/dev/null || fail 'Only the ingress publishes ports'
jq -e '.networks.default.ipam.config[0].subnet=="10.200.0.0/24"' "$temporary/compose.json" >/dev/null || fail 'Known proxy subnet'
jq -e '.services.hiveskills.volumes|any(.target=="/opt/hive-skills/shared/data")' "$temporary/compose.json" >/dev/null || fail 'Skills path alias'

# Native secrets and suite credentials never reach a command line on the host.
! grep -nE -- "--arg (redis|qdrant|password|key)\b|apiKey:|--arg token" "$ROOT/scripts/suite/migrate-native-host.sh" || fail 'A credential is passed as a process argument'

# ---- A near-expiry identity leaf is renewed from the native CA for the suite copy only. ----
native_leaf=$(sha256sum "$source_root/opt/hive-iam/certs/server.crt")
touch "$directory/compose.json"
: > "$temporary/docker.calls"
host_action native-tls-refresh 2>/dev/null || fail 'tls-refresh'
[[ $(sha256sum "$source_root/opt/hive-iam/certs/server.crt") == "$native_leaf" ]] || fail 'The native leaf must stay as it was'
openssl x509 -in "$config/native/4200.crt" -noout -checkend 2000000 >/dev/null || fail 'The suite copy must be renewed'
openssl verify -CAfile "$source_root/var/lib/hive-iam-pki/ca.crt" -verify_hostname "$fqdn" "$config/native/4200.crt" >/dev/null || fail 'The renewed leaf keeps its authority and names'
grep -q 'restart ingress' "$temporary/docker.calls" || fail 'The ingress must load the renewed certificate'
rm -f "$directory/compose.json"

# ---- Systemd mode closes and reopens every native start path, and restores unit bytes. ----
cat > "$temporary/bin/systemctl" <<STUB
#!/usr/bin/env bash
printf '%s\n' "\$*" >> "$temporary/systemctl.calls"
case "\$1" in is-active) exit 1;; is-enabled) exit 0;; esac
exit 0
STUB
chmod 700 "$temporary/bin/systemctl"
mkdir -p "$source_root/etc/systemd/system/hive-iam.service.d"
systemd_input() { input "$1" | jq -c '.nativeMigration.source.serviceManager="systemd"|.nativeMigration.source.qdrantContainer="fake-qdrant"|.directory+="-systemd"'; }
mkdir -p "$directory-systemd/migration/steps"
printf '{}' > "$directory-systemd/migration/steps/dry-run.json"; printf '{}' > "$directory-systemd/candidate.$(printf 'a%.0s' {1..64}).json"
systemd_input native-stop | PATH="$temporary/bin:$PATH" bash "$ROOT/scripts/suite/migrate-native-host.sh" 2>"$temporary/stop.log" || { cat "$temporary/stop.log" >&2; fail "Systemd stop"; }
for unit in hive-router hive-iam hivemem hive-skills; do
  grep -q 'ConditionPathExists=!/etc/hive/native-retired-to-suite' "$source_root/etc/systemd/system/$unit.service.d/90-retired-to-suite.conf" || fail "$unit start path stays open"
  grep -q "^disable --quiet $unit" "$temporary/systemctl.calls" || fail "$unit stays enabled"
  grep -q "^stop $unit" "$temporary/systemctl.calls" || fail "$unit stays running"
done
[[ -f "$source_root/etc/hive/native-retired-to-suite" ]] || fail 'Marker'
grep -q '^disable --now --quiet hive-iam-tls.timer' "$temporary/systemctl.calls" || fail 'The renewal timer would restart native IAM'
: > "$temporary/systemctl.calls"
sed -i 's/is-active) exit 1/is-active) exit 0/' "$temporary/bin/systemctl"
curl_stub_dir="$temporary/bin"; printf '#!/usr/bin/env bash\nexit 0\n' > "$curl_stub_dir/curl"; chmod 700 "$curl_stub_dir/curl"
systemd_input native-rollback | PATH="$temporary/bin:$PATH" bash "$ROOT/scripts/suite/migrate-native-host.sh" >/dev/null 2>"$temporary/rollback.log" || { cat "$temporary/rollback.log" >&2; fail 'Systemd rollback'; }
[[ ! -e "$source_root/etc/hive/native-retired-to-suite" ]] || fail 'Marker left behind'
[[ -z $(find "$source_root/etc/systemd/system" -name '90-retired-to-suite.conf') ]] || fail 'Drop-in left behind'
[[ $(grep -E '^start ' "$temporary/systemctl.calls" | cut -d ' ' -f2 | tr '\n' ' ') == 'hivemem hive-iam hive-router hive-skills ' ]] || fail 'Native start order'
grep -q '^enable --now --quiet hive-iam-tls.timer' "$temporary/systemctl.calls" || fail 'The renewal timer must return'
grep -q '^start fake-qdrant' "$temporary/docker.calls" || fail 'The native Qdrant must return'
jq -e '.writesMadeAfterCutover.statement|test("not copied back")' "$directory-systemd/migration/last-rollback.json" >/dev/null || fail 'Rollback must state what happens to later writes'
rm -f "$curl_stub_dir/curl"

# ---- Cutover and rollback refuse the wrong order, and native stores must be untouched. ----
refused 'Prepare has not passed' host_action native-stop
refused 'There is no cutover to roll back' host_action native-rollback
grep -qE '^(stop|start) ' "$temporary/native.calls" 2>/dev/null && fail 'A refused command controlled a native service'
mkdir -p "$directory/migration/steps"; printf '{}' > "$directory/migration/steps/dry-run.json"; printf '{}' > "$directory/candidate.$(printf 'a%.0s' {1..64}).json"
rm -f "$temporary/native-running"
host_action native-stop 2>/dev/null || fail 'Stopping native services'
[[ $(grep -E '^stop ' "$temporary/native.calls" | cut -d ' ' -f2 | tr '\n' ' ') == 'hive-router hive-skills hive-iam hivemem ' ]] || fail 'Native writers stop consumers first'
jq -e 'has("/opt/hive-iam/prisma/iam.db")' "$directory/migration/native-stopped.json" >/dev/null || fail 'Stopped-state hashes'
: > "$temporary/native.calls"
host_action native-stop 2>/dev/null || fail 'A repeated stop must continue'
! grep -qE '^stop ' "$temporary/native.calls" || fail 'A repeated stop must not act again'
sqlite3 "$source_root/opt/hive-iam/prisma/iam.db" "INSERT INTO roles VALUES ('r2','WRITTEN_AFTER_STOP');" >/dev/null
refused 'Native stores changed while the suite was active' host_action native-rollback
grep -qE '^start ' "$temporary/native.calls" && fail 'A refused rollback must start nothing'

# ---- The administrator token: controller side. ----
: > "$temporary/docker.calls"
touch "$directory/compose.json"
hive issue-admin-token "$temporary/config.json" 2> "$temporary/issue.log" || { cat "$temporary/issue.log" >&2; fail 'Token issue'; }
[[ $(stat -c %a "$temporary/admin-token") == 600 ]] || fail 'The token file must be owner-only'
token=$(cat "$temporary/admin-token")
[[ "$token" =~ ^hive-reset\.primary\.[a-f0-9]{64}$ ]] || fail 'Token format'
grep -q "issue-reset-token --account subject-admin --username admin --token-sha256 $(printf '%s' "$token" | sha256sum | cut -d ' ' -f1) --installation primary --ttl-seconds 86400" "$temporary/docker.calls" || fail 'Only the digest crosses to the host'
! grep -q "$token" "$temporary/docker.calls" || fail 'The raw token must never reach the host'
! grep -q "$token" "$temporary/issue.log" || fail 'The raw token must never be printed'
refused 'A token file already exists' hive issue-admin-token "$temporary/config.json"
jq '.nativeMigration.adminAccount=null' "$temporary/config.json" > "$temporary/variant.json"; chmod 600 "$temporary/variant.json"
refused 'Confirm the administrator first' hive issue-admin-token "$temporary/variant.json"

# ---- The password script: secrets never reach an argument or the environment. ----
script_dir="$temporary/owner/bin"; mkdir -p "$script_dir" "$temporary/owner/migration"
cp "$ROOT/scripts/suite/set-admin-password.sh" "$script_dir/set"
jq -n --arg ca "$temporary/owner/ca.pem" '{installation:"primary",username:"admin",url:"https://hive.example.com:4200/api/v1/auth/reset-password",resolve:"hive.example.com:4200:127.0.0.1",caFile:$ca}' > "$temporary/owner/migration/reset-target.json"
cat > "$temporary/bin/curl" <<STUB
#!/usr/bin/env bash
printf '%s\n' "\$*" > "$temporary/curl.args"
env > "$temporary/curl.env"
cat > "$temporary/curl.body"
printf '%s' "\${CURL_REPLY:-{\"message\":\"Password has been reset.\"}}"
printf '\n%s' "\${CURL_STATUS:-200}"
STUB
chmod 700 "$temporary/bin/curl"
secret_password='fake-Throwaway-Password-1'
owner() { PATH="$temporary/bin:$PATH" bash "$script_dir/set" "$@"; }
printf '%s\n%s\n%s\n' "$token" "$secret_password" "$secret_password" | owner > "$temporary/owner.out" 2>&1 || { cat "$temporary/owner.out" >&2; fail 'Password script'; }
jq -e --arg token "$token" --arg password "$secret_password" '.token==$token and .newPassword==$password' "$temporary/curl.body" >/dev/null || fail 'The request carries the token and the password'
! grep -qF -e "$secret_password" -e "$token" "$temporary/curl.args" || fail 'A secret reached a command-line argument'
! grep -qF -e "$secret_password" -e "$token" "$temporary/curl.env" || fail 'A secret reached the environment'
! grep -qF -e "$secret_password" -e "$token" "$temporary/owner.out" || fail 'A secret was printed'
grep -q -- '--cacert' "$temporary/curl.args" && ! grep -q -- '--insecure\| -k ' "$temporary/curl.args" || fail 'The identity certificate is verified'
refused 'never command-line values' owner "$token"
refused 'never command-line values' owner --token "$token"
refused 'That is not a reset token' owner <<< $'not-a-token\nx\nx'
refused 'another installation' owner <<< "hive-reset.secondary.$(printf 'a%.0s' {1..64})"$'\nx\nx'
refused 'passwords differ' owner <<< "$token"$'\none\ntwo'
printf '%s\n' "$token" > "$temporary/token-file"; chmod 644 "$temporary/token-file"
refused 'must be owner-only' owner --token-file "$temporary/token-file"
chmod 600 "$temporary/token-file"
printf '%s\n%s\n' "$secret_password" "$secret_password" | owner --token-file "$temporary/token-file" > /dev/null 2>&1 || fail 'A protected token file is accepted'
CURL_STATUS=429 CURL_REPLY='{}' refused 'Too many attempts' owner <<< "$token"$'\none\none'
export CURL_STATUS=400 CURL_REPLY='{"message":"Invalid or expired reset token"}'
refused 'Invalid or expired' owner <<< "$token"$'\none\none'
unset CURL_STATUS CURL_REPLY

# A production-shaped configuration is bound to the real host and machine.
variant '.nativeMigration.source={root:"/",serviceManager:"systemd"}|.nativeMigration.rehearsal=false|.nativeMigration.expectedHost="not-this-host"'
refused 'independent installations are never mixed' hive plan "$temporary/variant.json"

# ---- sudo credentials travel on standard input from a protected file, never as an argument. ----
printf 'fake-sudo-password\n' > "$temporary/sudo"; chmod 600 "$temporary/sudo"
jq --arg sudo "$temporary/sudo" '.hosts.control.target="deploy@hive.example.com"|.hosts.control.sudoPasswordFile=$sudo' "$temporary/config.json" > "$temporary/remote.json"; chmod 600 "$temporary/remote.json"
cat > "$temporary/bin/ssh" <<STUB
#!/usr/bin/env bash
printf '%s\n' "\$*" > "$temporary/ssh.args"
IFS= read -r first; printf '%s\n' "\$first" > "$temporary/ssh.first"
cat > "$temporary/ssh.rest"
exit 0
STUB
chmod 700 "$temporary/bin/ssh"
hive status "$temporary/remote.json" > /dev/null 2>&1 || true
[[ $(cat "$temporary/ssh.first") == fake-sudo-password ]] || fail 'sudo reads its password first'
jq -e '.installation=="primary"' "$temporary/ssh.rest" >/dev/null || fail 'The payload follows the password'
grep -q "sudo -k -S -p ''" "$temporary/ssh.args" || fail 'The remote command must read the password from standard input'
! grep -q fake-sudo-password "$temporary/ssh.args" || fail 'The sudo password reached a command line'
chmod 644 "$temporary/sudo"
refused 'must be owner-only' hive status "$temporary/remote.json"

# The runtime bundle carries everything the host needs.
for file in scripts/suite/migrate-native.sh scripts/suite/migrate-native-host.sh scripts/suite/migrate-native-data.mjs scripts/suite/set-admin-password.sh; do
  grep -q "$file" "$ROOT/scripts/suite/controller.sh" || fail "$file is not bundled"
done
printf 'migrate-native controller checks passed\n'
