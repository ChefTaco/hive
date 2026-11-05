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
has_component() { jq -e --arg name "$1" '.placements[$name]!=null' <<< "$input" >/dev/null; }
distributed=$(jq -r '.bootstrap.productEndpoints!=null' <<< "$input")
console_hostname=${origin#https://}; console_hostname=${console_hostname%%:*}
certificate_references=()
check_certificate() {
  local certificate=$1 private_key=$2 hostname=$3 permissions hostname_option=-checkhost
  [[ ! "$hostname" =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]] || hostname_option=-checkip
  for path in "$certificate" "$private_key"; do
    [[ -f "$path" && ! -L "$path" && -r "$path" && "$path" == "$(realpath -m -- "$path")" ]] || die 'Product certificate/key reference is invalid'
  done
  permissions=$(stat -c %a "$private_key"); (( (8#$permissions & 077)==0 )) || die 'Product private key must be owner-only'
  openssl x509 -in "$certificate" -noout "$hostname_option" "$hostname" >/dev/null || die 'Product certificate hostname does not match its configured endpoint'
  openssl x509 -in "$certificate" -noout -checkend 86400 >/dev/null || die 'Product certificate expires within one day'
  [[ $(openssl x509 -in "$certificate" -pubkey -noout | openssl pkey -pubin -outform DER | sha256sum) == "$(openssl pkey -in "$private_key" -pubout -outform DER 2>/dev/null | sha256sum)" ]] || die 'Product certificate and private key do not match'
  certificate_references+=("$certificate" "$private_key")
}
if has_component ingress; then
  certificate=$(jq -er .bootstrap.certificateFile <<< "$input")
  private_key=$(jq -er .bootstrap.privateKeyFile <<< "$input")
  check_certificate "$certificate" "$private_key" "$console_hostname"
fi
if [[ "$distributed" == true ]]; then
  trust_bundle=$(jq -er .bootstrap.trustBundleFile <<< "$input")
  [[ -f "$trust_bundle" && ! -L "$trust_bundle" && -r "$trust_bundle" && "$trust_bundle" == "$(realpath -m -- "$trust_bundle")" ]] || die 'Distributed trust bundle must exist as a regular file on every host'
  openssl crl2pkcs7 -nocrl -certfile "$trust_bundle" | openssl pkcs7 -print_certs -noout >/dev/null || die 'Invalid distributed trust bundle'
  certificate_references+=("$trust_bundle")
  while IFS= read -r component; do
    certificate=$(jq -er --arg name "$component" '.bootstrap.productEndpoints[$name].certificateFile' <<< "$input")
    private_key=$(jq -er --arg name "$component" '.bootstrap.productEndpoints[$name].privateKeyFile' <<< "$input")
    endpoint=$(jq -er --arg name "$component" '.bootstrap.productEndpoints[$name].origin' <<< "$input")
    hostname=${endpoint#https://}; hostname=${hostname%%:*}
    check_certificate "$certificate" "$private_key" "$hostname"
    hostname_option=-verify_hostname; [[ ! "$hostname" =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]] || hostname_option=-verify_ip
    openssl verify -CAfile "$trust_bundle" "$hostname_option" "$hostname" "$certificate" >/dev/null || die 'Product certificate is not trusted by the configured bundle'
  done < <(jq -r '.placements|keys[]|select(IN("oathweave","emberpath","hivemem","hiveskills","magnus","cindertrace","chattermost"))' <<< "$input")
fi
while IFS= read -r user; do
  uid=${user%:*}; gid=${user#*:}
  [[ $(id -u) == 0 || ( $(id -u) == "$uid" && $(id -g) == "$gid" ) ]] || die 'Run fresh setup as the configured service owner or a host administrator; application containers remain non-root'
done < <(jq -r '. as $input|.bootstrapServiceUsers|to_entries[]|select(.key!="hivexui" and $input.placements[.key]!=null)|.value' <<< "$input")
input_sha=$( { printf '%s\n' "$plan"; if (( ${#certificate_references[@]} )); then sha256sum "${certificate_references[@]}" | cut -d ' ' -f1; fi; } | sha256sum | cut -d ' ' -f1)
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
while IFS= read -r port; do
  [[ -z $(ss -H -lnt "sport = :$port") ]] || die 'Requested HTTPS port is already occupied'
done < <(jq -r '. as $input | (.console.httpsPort // empty), (.placements|keys[]|. as $name|$input.bootstrap.productEndpoints[$name]|select(.!=null)|(.origin,.inferenceOrigin // empty)|capture("^https://[^:]+(?::(?<port>[0-9]+))?$")|.port // "443")' <<< "$input")
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
identity_names=(identity-id model-id memory-id)
jq -e '.bootstrapServiceUsers.cindertrace!=null' <<< "$input" >/dev/null && identity_names+=(security-id)
jq -e '.bootstrapServiceUsers.chattermost!=null' <<< "$input" >/dev/null && identity_names+=(chat-id)
for name in "${identity_names[@]}"; do
  length=64; [[ "$name" != memory-id ]] || length=32; [[ "$name" != chat-id ]] || length=26
  shared_name=${name%-id}
  shared_id=$(jq -r --arg name "$shared_name" '.bootstrapIdentityIds[$name] // empty' <<< "$input")
  if [[ -n "$shared_id" ]]; then
    [[ "$shared_id" =~ ^[a-f0-9]+$ && ${#shared_id} == "$length" ]] || die 'Invalid shared fresh account identity'
    [[ ! -L "$state/secrets/$name" && ! -L "$state/secrets/$name.pending" ]] || die 'Unsafe shared identity artifact'
    if [[ ! -e "$state/secrets/$name" ]]; then
      if [[ ! -e "$state/secrets/$name.pending" ]]; then (set -o noclobber; printf '%s\n' "$shared_id" > "$state/secrets/$name.pending"); fi
      [[ -f "$state/secrets/$name.pending" && $(cat "$state/secrets/$name.pending") == "$shared_id" ]] || die 'Interrupted shared identity artifact needs reviewed recovery'
      sync -f "$state/secrets/$name.pending"; mv -T -- "$state/secrets/$name.pending" "$state/secrets/$name"
    fi
    [[ $(cat "$state/secrets/$name") == "$shared_id" ]] || die 'Fresh identity coordination changed; existing account IDs are retained'
    record_file "$state/secrets/$name"
  else ensure_secret "$name" "$length"; fi
done
if has_component oathweave; then for name in admin-password oath-cookie oath-agent redis-password native-hive-client native-router-client; do ensure_secret "$name"; done; fi
if has_component emberpath; then ensure_secret router-key; fi
if has_component hivemem; then for name in memory-key memory-renewal qdrant-key; do ensure_secret "$name"; done; fi
if has_component hiveskills; then ensure_secret skills-session; fi
if has_component magnus; then for name in magnus-db magnus-redis magnus-api magnus-jwt magnus-manager magnus-audit magnus-result magnus-log magnus-rotation magnus-metrics magnus-webhook; do ensure_secret "$name"; done; fi
if has_component cindertrace; then for name in security-db security-redis security-admin-password security-session security-console security-audit security-receipt security-backup security-rate; do ensure_secret "$name"; done; fi
if has_component chattermost; then for name in chat-db chat-cookie chat-token chat-admin-password chat-bot; do ensure_secret "$name"; done; fi
if has_component emberfold; then ensure_secret context-api; fi
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
if [[ "$distributed" != true ]]; then
ensure_key authority
ca="$state/certificates/authority.pem"
if [[ ! -e "$ca" ]]; then
  openssl req -new -x509 -key "$state/keys/authority.pem" -out "$ca.pending" -days 3650 -subj "/CN=$installation-internal-authority" -addext 'basicConstraints=critical,CA:TRUE' -addext 'keyUsage=critical,keyCertSign,cRLSign' >/dev/null 2>&1
  sync -f "$ca.pending"; mv -T -- "$ca.pending" "$ca"
fi
openssl verify -CAfile "$ca" "$ca" >/dev/null || die 'Initialization authority verification failed'
record_file "$ca"
for component in oathweave emberpath hivemem hiveskills magnus cindertrace chattermost; do
  has_component "$component" || continue
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
else ca=$trust_bundle; fi
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
for component in oathweave emberpath hivemem hiveskills magnus cindertrace chattermost; do
  has_component "$component" || continue
  if [[ "$distributed" == true ]]; then
    key_reference=$(jq -er --arg name "$component" '.bootstrap.productEndpoints[$name].privateKeyFile' <<< "$input")
    certificate_reference=$(jq -er --arg name "$component" '.bootstrap.productEndpoints[$name].certificateFile' <<< "$input")
  else key_reference="$state/keys/$component.pem"; certificate_reference="$state/certificates/$component.pem"; fi
  publish_file "$component" "$directory/config/$component/tls.key" < "$key_reference"
  publish_file "$component" "$directory/config/$component/tls.crt" < "$certificate_reference"
  publish_file "$component" "$directory/config/$component/authority.pem" < "$ca"
done
if has_component ingress; then
  publish_file ingress "$directory/config/ingress/console.crt" < "$(jq -er .bootstrap.certificateFile <<< "$input")"
  publish_file ingress "$directory/config/ingress/console.key" < "$(jq -er .bootstrap.privateKeyFile <<< "$input")"
  publish_file ingress "$directory/config/ingress/backend-ca.pem" < "$ca"
  jq -r .ingressTemplate <<< "$input" | base64 -d | publish_file ingress "$directory/config/ingress/Caddyfile"
fi
username=$(jq -er .bootstrap.adminUsername <<< "$input")
email=$(jq -er .bootstrap.adminEmail <<< "$input")
subject=$(secret identity-id); model_id=$(secret model-id); memory_id=$(secret memory-id)
issuer="$origin/api/oathweave"
if has_component oathweave; then
jq -n --arg id "$subject" --arg redirect "$origin/auth/callback" --argjson selection "$(jq -c .bootstrapServiceUsers <<< "$input")" '{schema:1,adminId:$id,clients:[
 {id:"hivexui-oathweave",audience:"oathweave",permissions:["iam:users:read","iam:users:write","iam:users:delete","iam:roles:read","iam:roles:write","iam:sa:read","iam:sa:write","iam:sa:delete","iam:clients:read","iam:clients:write","iam:sessions:revoke","iam:audit:read","iam:system:login","iam:policy:write"],redirectUris:[$redirect],firstParty:true},
 {id:"hivexui-emberpath",audience:"emberpath",permissions:["router:providers:read","router:providers:write","router:routing:read","router:routing:write","router:testing:read","router:testing:write","router:keys:read","router:keys:write","router:settings:read","router:settings:write","router:admin:read","router:admin:write"],redirectUris:[$redirect],firstParty:true},
 {id:"hivexui-hivemem",audience:"hivemem",permissions:["hivemem:admin:all"],redirectUris:[$redirect],firstParty:true},
 {id:"hivexui-hiveskills",audience:"hiveskills",permissions:["hiveskills:admin"],redirectUris:[$redirect],firstParty:true}]} |
 .clients += ((if $selection.cindertrace then [{id:"hivexui-cindertrace",audience:"cindertrace",permissions:["cindertrace:view","cindertrace:investigate","cindertrace:admin"],redirectUris:[$redirect],firstParty:true}] else [] end) +
 (if $selection.chattermost then [{id:"hivexui-chattermost",audience:"chattermost",permissions:["chattermost:session"],redirectUris:[$redirect],firstParty:true}] else [] end))' | publish_file oathweave "$directory/config/oathweave/suite-bootstrap.json"
policies=$(jq -c '.clients|map({key:.id,value:{audience,permissions}})|from_entries' "$directory/config/oathweave/suite-bootstrap.json")
fi
if has_component hivemem; then
jq -n --arg id "$memory_id" --arg label "$username" '{schema:1,id:$id,displayName:$label}' | publish_file hivemem "$directory/config/hivemem/initial-account.json"
fi
line() { printf '%s=%s\n' "$1" "$2"; }
common_environment() {
  line NODE_ENV production; line HIVE_HOME /data; line HIVE_AUTO_MIGRATE false; line HIVE_AUTO_UPGRADE false; line HIVE_UPDATE_CHECK false; line NODE_EXTRA_CA_CERTS /config/authority.pem
}
product_endpoint() {
  local component=$1 fallback=$2 field=${3:-origin}
  jq -r --arg name "$component" --arg field "$field" --arg fallback "$fallback" '.bootstrap.productEndpoints[$name][$field] // $fallback' <<< "$input"
}
resource_identity() {
  local identity_endpoint
  identity_endpoint=$(product_endpoint oathweave https://oathweave:4200)
  line OATHWEAVE_ISSUER "$issuer"; line OATHWEAVE_JWKS_URL "$identity_endpoint/api/v1/oauth/jwks"; line OATHWEAVE_USERINFO_URL "$identity_endpoint/api/v1/oauth/userinfo"
}
if has_component oathweave; then
{
  common_environment; line HOST 0.0.0.0; line PORT 4200; line DATABASE_URL file:/data/iam/iam.db
  line REDIS_URL "redis://:$(secret redis-password)@oathweave-redis:6379"
  line JWT_ISSUER "oathweave-$installation"; line IAM_BROWSER_ISSUER "$issuer"; line IAM_BROWSER_CLIENT_POLICIES "$policies"
  line COOKIE_SECRET "$(secret oath-cookie)"; line IAM_AGENT_SECRET "$(secret oath-agent)"
  line SEED_ADMIN_USERNAME "$username"; line SEED_ADMIN_EMAIL "$email"; line SEED_ADMIN_PASSWORD "$(secret admin-password)"
  line SEED_HIVE_CLIENT_SECRET "$(secret native-hive-client)"; line SEED_HIVE_ROUTER_CLIENT_SECRET "$(secret native-router-client)"
  line OATHWEAVE_SUITE_BOOTSTRAP_FILE /config/suite-bootstrap.json
  line IAM_ENROLLMENT_INSTALLATION_ID "$installation"
  line IAM_ENROLLMENT_PRODUCTS_JSON "$(jq -nc --arg models "$(product_endpoint emberpath https://emberpath:9443)/api" --arg memory "$(product_endpoint hivemem https://hivemem:18790)/v1" '{emberpath:{url:$models,caFile:"/config/authority.pem"},hivemem:{url:$memory,caFile:"/config/authority.pem"}}')"
  line TLS_CERT_PATH /config/tls.crt; line TLS_KEY_PATH /config/tls.key; line CORS_ORIGIN "$origin"
  line WEBAUTHN_RP_ID "$console_hostname"; line WEBAUTHN_RP_ORIGIN "$origin"; line WEBAUTHN_RP_NAME Oathweave
  line IAM_RECOVERY_OUTBOX_DIRECTORY /data/iam/recovery-outbox
} | publish_file oathweave "$directory/config/oathweave.env"
fi
if has_component emberpath; then
{
  common_environment; resource_identity; line HOST 0.0.0.0; line API_PORT 4020; line ADMIN_PORT 9443
  line DATABASE_URL file:/data/router/router.db; line HIVE_ROUTER_SECRET "$(secret router-key)"; line HIVE_ROUTER_ADMIN_USERS "$username"
  line EMBERPATH_INITIAL_ADMIN_IDENTITIES_JSON "$(jq -nc --arg username "$username" --arg id "$model_id" '[{username:$username,localId:$id}]')"
  line EMBERPATH_OATHWEAVE_IDENTITIES_JSON "$(jq -nc --arg issuer "$issuer" --arg subject "$subject" --arg id "$model_id" '[{issuer:$issuer,subject:$subject,localId:$id}]')"
  line TLS_CERT_PATH /config/tls.crt; line TLS_KEY_PATH /config/tls.key; line PUBLIC_API_URL "$origin"; line PUBLIC_ADMIN_URL "$origin"
} | publish_file emberpath "$directory/config/emberpath.env"
fi
if has_component hivemem; then
{
  common_environment; resource_identity; line HIVEMEM_TS_CORE_HOST 0.0.0.0; line HIVEMEM_TS_CORE_PORT 18790
  line HIVEMEM_STORAGE_PATH /data/memory; line HIVEMEM_TS_PERSISTENCE qdrant; line HIVEMEM_QDRANT_URL http://hivemem-qdrant:6333
  line QDRANT_API_KEY "$(secret qdrant-key)"; line HIVEMEM_JWT_SECRET "$(secret memory-key)"; line HIVEMEM_RENEWAL_SECRET "$(secret memory-renewal)"
  line HIVEMEM_TS_TLS_CERT_FILE /config/tls.crt; line HIVEMEM_TS_TLS_KEY_FILE /config/tls.key
  line HIVEMEM_INITIAL_ACCOUNT_FILE /config/initial-account.json
  line HIVEMEM_OATHWEAVE_IDENTITIES_JSON "$(jq -nc --arg issuer "$issuer" --arg subject "$subject" --arg id "$memory_id" '[{issuer:$issuer,subject:$subject,localId:$id,credentialGeneration:0}]')"
} | publish_file hivemem "$directory/config/hivemem.env"
fi
if has_component hiveskills; then
{
  common_environment; resource_identity; line HIVE_SKILLS_HOST 0.0.0.0; line HIVE_SKILLS_PORT 4030; line HIVE_SKILLS_DATA_DIR /data/skills
  line HIVE_SKILLS_SESSION_SECRET "$(secret skills-session)"; line HIVE_SKILLS_ADMIN_USERS "$username"; line HIVE_SKILLS_PUBLIC_URL "$origin/api/hiveskills"
  line HIVE_SKILLS_TLS_CERT_FILE /config/tls.crt; line HIVE_SKILLS_TLS_KEY_FILE /config/tls.key
  line HIVESKILLS_OATHWEAVE_IDENTITIES_JSON "$(jq -nc --arg issuer "$issuer" --arg subject "$subject" --arg id "$username" '[{issuer:$issuer,subject:$subject,localId:$id}]')"
} | publish_file hiveskills "$directory/config/hiveskills.env"
fi
if has_component oathweave-redis; then
{
  printf 'bind 0.0.0.0\nprotected-mode yes\ndir /data\nappendonly yes\nappendfsync everysec\nrequirepass %s\n' "$(secret redis-password)"
} | publish_file oathweave-redis "$directory/config/oathweave-redis/redis.conf"
fi
if has_component hivemem-qdrant; then
{
  printf 'log_level: WARN\ntelemetry_disabled: true\nstorage:\n  storage_path: /data/storage\n  snapshots_path: /data/snapshots\nservice:\n  host: 0.0.0.0\n  http_port: 6333\n  api_key: %s\n' "$(secret qdrant-key)"
} | publish_file hivemem-qdrant "$directory/config/hivemem-qdrant/qdrant.yaml"
fi
if has_component ingress; then
{
  line HIVE_CONSOLE_HOST "$console_hostname"; line XDG_CONFIG_HOME /data/config; line XDG_DATA_HOME /data
  for mapping in oathweave:OATHWEAVE:4200 emberpath:EMBERPATH:9443 hivemem:HIVEMEM:18790 hiveskills:HIVESKILLS:4030; do
    component=${mapping%%:*}; tail=${mapping#*:}; label=${tail%%:*}; port=${tail##*:}
    endpoint=$(product_endpoint "$component" "https://$component:$port")
    hostname=${endpoint#https://}; hostname=${hostname%%:*}
    line "${label}_ENDPOINT" "$endpoint"; line "${label}_TLS_NAME" "$hostname"
  done
  for mapping in cindertrace:CINDERTRACE:4101 chattermost:CHATTERMOST:8065; do
    component=${mapping%%:*}; tail=${mapping#*:}; label=${tail%%:*}; port=${tail##*:}
    jq -e --arg name "$component" '.bootstrapServiceUsers[$name]!=null' <<< "$input" >/dev/null || continue
    endpoint=$(product_endpoint "$component" "https://$component:$port"); hostname=${endpoint#https://}; hostname=${hostname%%:*}
    line "${label}_ENDPOINT" "$endpoint"; line "${label}_TLS_NAME" "$hostname"
  done
  endpoint=$(product_endpoint emberpath https://emberpath:4020 inferenceOrigin)
  hostname=${endpoint#https://}; hostname=${hostname%%:*}
  line EMBERPATH_API_ENDPOINT "$endpoint"; line EMBERPATH_API_TLS_NAME "$hostname"
} | publish_file ingress "$directory/config/ingress.env"
fi
hive_full_configuration
if has_component hivexui; then
jq -n --arg issuer "$issuer" --arg installation "$installation" --arg magnusConsole "$(jq -r '.bootstrap.magnusConsoleOrigin // empty' <<< "$input")" --argjson selection "$(jq -c .bootstrapServiceUsers <<< "$input")" '{schema:1,mode:"suite",enrollmentInstallationId:$installation,products:{oathweave:"/api/oathweave",emberpath:"/api/emberpath",hivemem:"/api/hivemem",hiveskills:"/api/hiveskills"},identity:{issuer:$issuer,apiPrefix:"/api/oathweave",clients:{oathweave:"hivexui-oathweave",emberpath:"hivexui-emberpath",hivemem:"hivexui-hivemem",hiveskills:"hivexui-hiveskills"}}} |
 if $selection.cindertrace then .products.cindertrace="/api/cindertrace" | .identity.clients.cindertrace="hivexui-cindertrace" else . end |
 if $selection.chattermost then .products.chattermost="/api/chattermost" | .identity.clients.chattermost="hivexui-chattermost" else . end |
 if $magnusConsole!="" then .links.magnus=$magnusConsole else . end' | publish_file hivexui "$directory/config/runtime.json" 644
fi
if has_component oathweave; then
{
  line SEED_ADMIN_USERNAME "$username"; line SEED_ADMIN_EMAIL "$email"; line SEED_ADMIN_PASSWORD "$(secret admin-password)"
} | publish_file oathweave "$directory/config/initial-credentials.env"
fi
jq '.phase="complete"' "$receipt" | atomic_receipt
printf 'Fresh configuration artifacts verified; credentials remain in protected files.\n'
