#!/usr/bin/env bash
# Fresh configuration only. Invoked over the pinned controller transport.
set -Eeuo pipefail
umask 077
read -r input
directory=$(jq -er .directory <<< "$input")
installation=$(jq -er .installation <<< "$input")
host=$(jq -er .host <<< "$input")
plan=$(jq -er .plan <<< "$input")
action=$(jq -er .action <<< "$input")
origin=$(jq -er .origin <<< "$input")
state="$directory/config/.initializer"
die() { printf 'Hive initialization: %s\n' "$*" >&2; exit 1; }
[[ "$directory" == "$(realpath -m -- "$directory")" && ! -L "$directory" ]] || die 'Installation path must be canonical without symlinks'
for tool in openssl jq docker flock sha256sum cmp base64 stat find; do command -v "$tool" >/dev/null || die 'Required initialization tool is missing'; done
docker info >/dev/null
certificate=$(jq -er .bootstrap.certificateFile <<< "$input")
private_key=$(jq -er .bootstrap.privateKeyFile <<< "$input")
for path in "$certificate" "$private_key"; do
  [[ -f "$path" && ! -L "$path" && -r "$path" && "$path" == "$(realpath -m -- "$path")" ]] || die 'Console certificate/key reference is invalid'
done
permissions=$(stat -c %a "$private_key"); (( (8#$permissions & 077)==0 )) || die 'Console private key must be owner-only'
console_hostname=${origin#https://}; console_hostname=${console_hostname%%:*}
openssl x509 -in "$certificate" -noout -checkhost "$console_hostname" >/dev/null || die 'Console certificate hostname does not match the configured origin'
openssl x509 -in "$certificate" -noout -checkend 86400 >/dev/null || die 'Console certificate expires within one day'
[[ $(openssl x509 -in "$certificate" -pubkey -noout | openssl pkey -pubin -outform DER | sha256sum) == "$(openssl pkey -in "$private_key" -pubout -outform DER 2>/dev/null | sha256sum)" ]] || die 'Console certificate and private key do not match'
while IFS= read -r user; do
  uid=${user%:*}; gid=${user#*:}
  [[ $(id -u) == 0 || ( $(id -u) == "$uid" && $(id -g) == "$gid" ) ]] || die 'Run fresh setup as the configured service owner or a host administrator; application containers remain non-root'
done < <(jq -r '.bootstrapServiceUsers|to_entries[]|select(.key!="hivexui")|.value' <<< "$input")
input_sha=$( { printf '%s\n' "$plan"; sha256sum "$certificate" "$private_key" | cut -d ' ' -f1; } | sha256sum | cut -d ' ' -f1)
receipt="$state/receipt.json"
if [[ -e "$receipt" || -L "$receipt" ]]; then
  [[ -f "$receipt" && ! -L "$receipt" && $(stat -c %u "$receipt") == "$(id -u)" ]] || die 'Unsafe initialization receipt'
  permissions=$(stat -c %a "$receipt"); (( (8#$permissions & 077)==0 )) || die 'Initialization receipt is not protected'
  jq -e --arg id "$installation" --arg host "$host" --arg sha "$input_sha" '.schema==1 and .installation==$id and .host==$host and .inputsSHA256==$sha' "$receipt" >/dev/null || die 'Initialization inputs changed; preserve existing configuration and recover its original inputs'
  while IFS=$'\t' read -r path sha; do
    [[ "$path" == "$directory/config/"* && -f "$path" && ! -L "$path" && $(sha256sum "$path" | cut -d ' ' -f1) == "$sha" ]] || die 'A generated configuration artifact changed; no existing file will be overwritten'
    permissions=$(stat -c %a "$path")
    if [[ "$path" != "$directory/config/runtime.json" ]]; then (( (8#$permissions & 077)==0 )) || die 'Protected initialization artifact permissions changed'; fi
  done < <(jq -r '.files|to_entries[]|[.key,.value]|@tsv' "$receipt")
  if [[ $(jq -r .phase "$receipt") == complete ]]; then exit 0; fi
else
  [[ ! -e "$directory/installation.json" && ! -e "$directory/compose.json" && ! -e "$directory/receipt.json" ]] || die 'Existing installations require explicit adoption, never fresh initialization'
  [[ ! -d "$directory/data" || -z $(find "$directory/data" -mindepth 1 -print -quit) ]] || die 'Existing data and model resources are retained; fresh setup requires an empty deployment directory'
  [[ ! -d "$directory/config" || -z $(find "$directory/config" -mindepth 1 -print -quit) ]] || die 'Configuration already exists; preserve it and use explicit adoption'
fi
[[ -z $(docker ps -aq --filter "label=com.docker.compose.project=$installation-$host") ]] || die 'Compose resources already exist; fresh setup does not adopt them'
case $(uname -m) in x86_64|aarch64) ;; *) die 'Unsupported service host architecture';; esac
parent=$directory
while [[ ! -d "$parent" && "$parent" != / ]]; do parent=$(dirname -- "$parent"); done
[[ -w "$parent" ]] || die 'Installation parent is not writable'
available=$(df -Pm -- "$parent" | awk 'NR==2 {print $4}')
required=$(jq -r '.minimumFreeMiB // 2048' <<< "$input")
(( available>=required )) || die 'Insufficient disk space for initialization'
command -v ss >/dev/null || die 'Console preflight requires ss from iproute2'
port=$(jq -er .console.httpsPort <<< "$input")
[[ -z $(ss -H -lnt "sport = :$port") ]] || die 'Requested HTTPS port is already occupied'
[[ "$action" == initialize ]] || exit 0
install -d -m 700 "$directory" "$directory/config" "$state" "$state/secrets" "$state/keys" "$state/certificates"
exec 8>"$state/controller.lock"
flock -n 8 || die 'Another initializer holds this installation'
atomic_receipt() { local pending; pending=$(mktemp "$state/receipt.XXXXXX"); cat > "$pending"; chmod 600 "$pending"; sync -f "$pending"; mv -T -- "$pending" "$receipt"; sync -f "$state"; }
if [[ ! -f "$receipt" ]]; then
  jq -n --arg id "$installation" --arg host "$host" --arg sha "$input_sha" '{schema:1,installation:$id,host:$host,inputsSHA256:$sha,phase:"preparing",files:{}}' | atomic_receipt
fi
record_file() {
  local path=$1 sha
  sha=$(sha256sum "$path" | cut -d ' ' -f1)
  jq --arg path "$path" --arg sha "$sha" '.files[$path]=$sha' "$receipt" | atomic_receipt
}
ensure_secret() {
  local name=$1 path="$state/secrets/$1" pending="$state/secrets/$1.pending" length=${2:-64} value
  if [[ ! -e "$path" ]]; then
    if [[ ! -e "$pending" ]]; then openssl rand -hex "$((length/2))" > "$pending"; sync -f "$pending"; fi
    [[ -f "$pending" && ! -L "$pending" ]] || die 'Unsafe pending initialization secret'
    value=$(cat "$pending")
    [[ "$value" =~ ^[a-f0-9]+$ && ${#value} == "$length" ]] || die 'Interrupted entropy generation needs recovery; existing bytes are retained'
    mv -T -- "$pending" "$path"
  fi
  [[ -f "$path" && ! -L "$path" ]] || die 'Invalid protected initialization secret'
  value=$(cat "$path")
  [[ "$value" =~ ^[a-f0-9]+$ && ${#value} == "$length" ]] || die 'Invalid protected initialization secret'
  record_file "$path"
}
for name in identity-id model-id admin-password oath-cookie oath-agent router-key memory-key memory-renewal skills-session redis-password qdrant-key native-hive-client native-router-client; do ensure_secret "$name"; done
ensure_secret memory-id 32
secret() { cat "$state/secrets/$1"; }
ensure_key() {
  local path="$state/keys/$1.pem" pending="$state/keys/$1.pending"
  if [[ ! -e "$path" ]]; then
    [[ -e "$pending" ]] || openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:3072 -out "$pending" >/dev/null 2>&1
    [[ ! -L "$pending" ]] && openssl pkey -in "$pending" -noout >/dev/null 2>&1 || die 'Incomplete private key retained for recovery'
    sync -f "$pending"; mv -T -- "$pending" "$path"
  fi
  [[ ! -L "$path" ]] && openssl pkey -in "$path" -noout >/dev/null 2>&1 || die 'Invalid initialization private key'
  record_file "$path"
}
ensure_key authority
ca="$state/certificates/authority.pem"
if [[ ! -e "$ca" ]]; then
  openssl req -new -x509 -key "$state/keys/authority.pem" -out "$ca.pending" -days 3650 -subj "/CN=$installation-internal-authority" -addext 'basicConstraints=critical,CA:TRUE' -addext 'keyUsage=critical,keyCertSign,cRLSign' >/dev/null 2>&1
  sync -f "$ca.pending"; mv -T -- "$ca.pending" "$ca"
fi
openssl verify -CAfile "$ca" "$ca" >/dev/null || die 'Initialization authority verification failed'
record_file "$ca"
for component in oathweave emberpath hivemem hiveskills; do
  ensure_key "$component"
  leaf="$state/certificates/$component.pem"
  if [[ ! -e "$leaf" ]]; then
    printf 'subjectAltName=DNS:%s,DNS:localhost\nbasicConstraints=critical,CA:FALSE\nextendedKeyUsage=serverAuth\nkeyUsage=critical,digitalSignature,keyEncipherment\n' "$component" > "$state/$component.extensions"
    openssl req -new -key "$state/keys/$component.pem" -out "$state/$component.csr" -subj "/CN=$component" >/dev/null 2>&1
    openssl x509 -req -in "$state/$component.csr" -CA "$ca" -CAkey "$state/keys/authority.pem" -set_serial "0x$(openssl rand -hex 16)" -days 365 -extfile "$state/$component.extensions" -out "$leaf.pending" >/dev/null 2>&1
    sync -f "$leaf.pending"; mv -T -- "$leaf.pending" "$leaf"
  fi
  openssl verify -CAfile "$ca" -verify_hostname "$component" "$leaf" >/dev/null || die 'Internal product certificate verification failed'
  record_file "$leaf"
done
publish_file() {
  local component=$1 path=$2 mode=${3:-600} temporary user uid gid
  user=$(jq -er --arg name "$component" '.bootstrapServiceUsers[$name]' <<< "$input"); uid=${user%:*}; gid=${user#*:}
  if [[ "$component" == hivexui ]]; then uid=$(id -u); gid=$(id -g); fi
  if [[ $(dirname "$path") == "$directory/config" ]]; then
    [[ -d "$directory/config" && ! -L "$directory/config" ]] || die 'Configuration root changed'
  else install -d -m 700 -o "$uid" -g "$gid" "$(dirname "$path")"; fi
  temporary=$(mktemp "$state/publish.XXXXXX"); cat > "$temporary"; chmod "$mode" "$temporary"
  if [[ -e "$path" || -L "$path" ]]; then
    [[ -f "$path" && ! -L "$path" ]] && cmp -s "$temporary" "$path" || die 'Existing configuration differs; it will not be overwritten'
    rm -- "$temporary"
  else chown "$uid:$gid" "$temporary"; sync -f "$temporary"; mv -T -- "$temporary" "$path"; fi
  record_file "$path"
}
for component in oathweave emberpath hivemem hiveskills; do
  publish_file "$component" "$directory/config/$component/tls.key" < "$state/keys/$component.pem"
  publish_file "$component" "$directory/config/$component/tls.crt" < "$state/certificates/$component.pem"
  publish_file "$component" "$directory/config/$component/authority.pem" < "$ca"
done
publish_file ingress "$directory/config/ingress/console.crt" < "$certificate"
publish_file ingress "$directory/config/ingress/console.key" < "$private_key"
publish_file ingress "$directory/config/ingress/backend-ca.pem" < "$ca"
jq -r .ingressTemplate <<< "$input" | base64 -d | publish_file ingress "$directory/config/ingress/Caddyfile"
username=$(jq -er .bootstrap.adminUsername <<< "$input")
email=$(jq -er .bootstrap.adminEmail <<< "$input")
subject=$(secret identity-id); model_id=$(secret model-id); memory_id=$(secret memory-id)
issuer="$origin/api/oathweave"
jq -n --arg id "$subject" --arg redirect "$origin/auth/callback" '{schema:1,adminId:$id,clients:[
 {id:"hivexui-oathweave",audience:"oathweave",permissions:["iam:users:read","iam:users:write","iam:users:delete","iam:roles:read","iam:roles:write","iam:sa:read","iam:sa:write","iam:sa:delete","iam:clients:read","iam:clients:write","iam:sessions:revoke","iam:audit:read","iam:system:login","iam:policy:write"],redirectUris:[$redirect],firstParty:true},
 {id:"hivexui-emberpath",audience:"emberpath",permissions:["router:providers:read","router:providers:write","router:routing:read","router:routing:write","router:testing:read","router:testing:write","router:keys:read","router:keys:write","router:settings:read","router:settings:write","router:admin:read","router:admin:write"],redirectUris:[$redirect],firstParty:true},
 {id:"hivexui-hivemem",audience:"hivemem",permissions:["hivemem:admin:all"],redirectUris:[$redirect],firstParty:true},
 {id:"hivexui-hiveskills",audience:"hiveskills",permissions:["hiveskills:admin"],redirectUris:[$redirect],firstParty:true}]}' | publish_file oathweave "$directory/config/oathweave/suite-bootstrap.json"
policies=$(jq -c '.clients|map({key:.id,value:{audience,permissions}})|from_entries' "$directory/config/oathweave/suite-bootstrap.json")
jq -n --arg id "$memory_id" --arg label "$username" '{schema:1,id:$id,displayName:$label}' | publish_file hivemem "$directory/config/hivemem/initial-account.json"
line() { printf '%s=%s\n' "$1" "$2"; }
common_environment() {
  line NODE_ENV production; line HIVE_HOME /data; line HIVE_AUTO_MIGRATE false; line HIVE_AUTO_UPGRADE false; line HIVE_UPDATE_CHECK false; line NODE_EXTRA_CA_CERTS /config/authority.pem
}
resource_identity() {
  line OATHWEAVE_ISSUER "$issuer"; line OATHWEAVE_JWKS_URL https://oathweave:4200/api/v1/oauth/jwks; line OATHWEAVE_USERINFO_URL https://oathweave:4200/api/v1/oauth/userinfo
}
{
  common_environment; line HOST 0.0.0.0; line PORT 4200; line DATABASE_URL file:/data/iam/iam.db
  line REDIS_URL "redis://:$(secret redis-password)@oathweave-redis:6379"
  line JWT_ISSUER "oathweave-$installation"; line IAM_BROWSER_ISSUER "$issuer"; line IAM_BROWSER_CLIENT_POLICIES "$policies"
  line COOKIE_SECRET "$(secret oath-cookie)"; line IAM_AGENT_SECRET "$(secret oath-agent)"
  line SEED_ADMIN_USERNAME "$username"; line SEED_ADMIN_EMAIL "$email"; line SEED_ADMIN_PASSWORD "$(secret admin-password)"
  line SEED_HIVE_CLIENT_SECRET "$(secret native-hive-client)"; line SEED_HIVE_ROUTER_CLIENT_SECRET "$(secret native-router-client)"
  line OATHWEAVE_SUITE_BOOTSTRAP_FILE /config/suite-bootstrap.json
  line TLS_CERT_PATH /config/tls.crt; line TLS_KEY_PATH /config/tls.key; line CORS_ORIGIN "$origin"
  line WEBAUTHN_RP_ID "$console_hostname"; line WEBAUTHN_RP_ORIGIN "$origin"; line WEBAUTHN_RP_NAME Oathweave
  line IAM_RECOVERY_OUTBOX_DIRECTORY /data/iam/recovery-outbox
} | publish_file oathweave "$directory/config/oathweave.env"
{
  common_environment; resource_identity; line HOST 0.0.0.0; line API_PORT 4020; line ADMIN_PORT 9443
  line DATABASE_URL file:/data/router/router.db; line HIVE_ROUTER_SECRET "$(secret router-key)"; line HIVE_ROUTER_ADMIN_USERS "$username"
  line EMBERPATH_INITIAL_ADMIN_IDENTITIES_JSON "$(jq -nc --arg username "$username" --arg id "$model_id" '[{username:$username,localId:$id}]')"
  line EMBERPATH_OATHWEAVE_IDENTITIES_JSON "$(jq -nc --arg issuer "$issuer" --arg subject "$subject" --arg id "$model_id" '[{issuer:$issuer,subject:$subject,localId:$id}]')"
  line TLS_CERT_PATH /config/tls.crt; line TLS_KEY_PATH /config/tls.key; line PUBLIC_API_URL "$origin"; line PUBLIC_ADMIN_URL "$origin"
} | publish_file emberpath "$directory/config/emberpath.env"
{
  common_environment; resource_identity; line HIVEMEM_TS_CORE_HOST 0.0.0.0; line HIVEMEM_TS_CORE_PORT 18790
  line HIVEMEM_STORAGE_PATH /data/memory; line HIVEMEM_TS_PERSISTENCE qdrant; line HIVEMEM_QDRANT_URL http://hivemem-qdrant:6333
  line QDRANT_API_KEY "$(secret qdrant-key)"; line HIVEMEM_JWT_SECRET "$(secret memory-key)"; line HIVEMEM_RENEWAL_SECRET "$(secret memory-renewal)"
  line HIVEMEM_TS_TLS_CERT_FILE /config/tls.crt; line HIVEMEM_TS_TLS_KEY_FILE /config/tls.key
  line HIVEMEM_INITIAL_ACCOUNT_FILE /config/initial-account.json
  line HIVEMEM_OATHWEAVE_IDENTITIES_JSON "$(jq -nc --arg issuer "$issuer" --arg subject "$subject" --arg id "$memory_id" '[{issuer:$issuer,subject:$subject,localId:$id,credentialGeneration:0}]')"
} | publish_file hivemem "$directory/config/hivemem.env"
{
  common_environment; resource_identity; line HIVE_SKILLS_HOST 0.0.0.0; line HIVE_SKILLS_PORT 4030; line HIVE_SKILLS_DATA_DIR /data/skills
  line HIVE_SKILLS_SESSION_SECRET "$(secret skills-session)"; line HIVE_SKILLS_ADMIN_USERS "$username"; line HIVE_SKILLS_PUBLIC_URL "$origin/api/hiveskills"
  line HIVE_SKILLS_TLS_CERT_FILE /config/tls.crt; line HIVE_SKILLS_TLS_KEY_FILE /config/tls.key
  line HIVESKILLS_OATHWEAVE_IDENTITIES_JSON "$(jq -nc --arg issuer "$issuer" --arg subject "$subject" --arg id "$username" '[{issuer:$issuer,subject:$subject,localId:$id}]')"
} | publish_file hiveskills "$directory/config/hiveskills.env"
{
  printf 'bind 0.0.0.0\nprotected-mode yes\ndir /data\nappendonly yes\nappendfsync everysec\nrequirepass %s\n' "$(secret redis-password)"
} | publish_file oathweave-redis "$directory/config/oathweave-redis/redis.conf"
{
  printf 'log_level: WARN\ntelemetry_disabled: true\nstorage:\n  storage_path: /data/storage\n  snapshots_path: /data/snapshots\nservice:\n  host: 0.0.0.0\n  http_port: 6333\n  api_key: %s\n' "$(secret qdrant-key)"
} | publish_file hivemem-qdrant "$directory/config/hivemem-qdrant/qdrant.yaml"
{
  line HIVE_CONSOLE_HOST "$console_hostname"; line XDG_CONFIG_HOME /data/config; line XDG_DATA_HOME /data
  line OATHWEAVE_ENDPOINT https://oathweave:4200; line OATHWEAVE_TLS_NAME oathweave
  line EMBERPATH_ENDPOINT https://emberpath:9443; line EMBERPATH_TLS_NAME emberpath; line EMBERPATH_API_ENDPOINT https://emberpath:4020; line EMBERPATH_API_TLS_NAME emberpath
  line HIVEMEM_ENDPOINT https://hivemem:18790; line HIVEMEM_TLS_NAME hivemem; line HIVESKILLS_ENDPOINT https://hiveskills:4030; line HIVESKILLS_TLS_NAME hiveskills
} | publish_file ingress "$directory/config/ingress.env"
jq -n --arg issuer "$issuer" '{schema:1,mode:"suite",products:{oathweave:"/api/oathweave",emberpath:"/api/emberpath",hivemem:"/api/hivemem",hiveskills:"/api/hiveskills"},identity:{issuer:$issuer,apiPrefix:"/api/oathweave",clients:{oathweave:"hivexui-oathweave",emberpath:"hivexui-emberpath",hivemem:"hivexui-hivemem",hiveskills:"hivexui-hiveskills"}}}' | publish_file hivexui "$directory/config/runtime.json" 644
{
  line SEED_ADMIN_USERNAME "$username"; line SEED_ADMIN_EMAIL "$email"; line SEED_ADMIN_PASSWORD "$(secret admin-password)"
} | publish_file oathweave "$directory/config/initial-credentials.env"
jq '.phase="complete"' "$receipt" | atomic_receipt
printf 'Fresh configuration artifacts verified; credentials remain in protected files.\n'
