#!/usr/bin/env bash
# hive.sh add, on the host that runs the console and Oathweave. Transported after public-runtime.sh and
# initialize-full-host.sh, whose product configuration it reuses: one product, with its private
# datastores, joins an existing installation. It generates the product's secrets, internal
# certificate and environment exactly as fresh setup does, links the operator's existing Oathweave
# account to a new product account, and adds the product to Oathweave's browser policies, the
# ingress and the console's runtime.json. Every step is journaled in config/.additions/PRODUCT and
# idempotent: an interrupted run continues, a file it wrote is never overwritten with other bytes,
# and a secret is never printed. No service is started or restarted here: the controller applies
# the change as an upgrade to the installed release.
# Even an explicitly traced invocation must stop tracing before reading credentials.
set +x +v
set -Eeuo pipefail
umask 077
read -r input
directory=$(jq -er .directory <<< "$input")
installation=$(jq -er .installation <<< "$input")
host=$(jq -er .host <<< "$input")
origin=$(jq -er .origin <<< "$input")
version=$(jq -er .version <<< "$input")
request=$(jq -ce '.addProduct|objects' <<< "$input") || { printf 'Hive add: missing request\n' >&2; exit 1; }
product=$(jq -er .product <<< "$request")
die() { printf 'Hive add: %s\n' "$*" >&2; exit 1; }
[[ "$directory" =~ ^/[A-Za-z0-9_./-]+$ && "$directory" == "$(realpath -m -- "$directory")" && ! -L "$directory" ]] || die 'Installation path must be canonical without symlinks'
# Only the products whose configuration initialize-full-host.sh owns, one at a time.
[[ "$product" == cindertrace ]] || die "add does not support $product"
mapfile -t components < <(jq -r '.components[]' <<< "$request")
[[ "${components[*]}" == "cindertrace cindertrace-postgres cindertrace-redis" ]] || die 'Unexpected component set'
for tool in openssl jq docker flock sha256sum cmp stat find; do command -v "$tool" >/dev/null || die "Required tool missing on this host: $tool"; done
docker info >/dev/null 2>&1 || die "Docker is not reachable by $(id -un) on this host"
config="$directory/config"
state="$config/.additions/$product"
journal="$state/receipt.json"
has_component() { local name; for name in "${components[@]}"; do [[ "$name" != "$1" ]] || return 0; done; return 1; }
selected() { has_component "$1"; }
placed() { jq -e --arg name "$1" '.placements[$name]!=null' <<< "$input" >/dev/null; }
for name in oathweave ingress hivexui "${components[@]}"; do placed "$name" || die "$name is not placed on this host"; done
[[ $(jq -r '.bootstrap.productEndpoints // empty' <<< "$input") == '' ]] || die 'A distributed installation is not supported by add'

# The installation is complete, runs the selected release, and has none of these components yet.
[[ -f "$directory/compose.json" && -f "$directory/receipt.json" ]] || die 'This host has no installed suite; install it first'
jq -e --arg version "$version" --arg digest "$(jq -er .digest <<< "$input")" '.version==$version and .digest==$digest' "$directory/receipt.json" >/dev/null ||
  die "This host runs release $(jq -r .version "$directory/receipt.json"), not $version: add a product with the installed release, or upgrade first"
[[ ! -f "$directory/transaction.json" ]] || jq -e '.phase=="complete" or .phase=="aborted"' "$directory/transaction.json" >/dev/null || die 'A suite transaction is open on this host; repeat the command that opened it first'
for name in "${components[@]}"; do
  ! jq -e --arg name "$name" '.services[$name]!=null' "$directory/compose.json" >/dev/null || die "$name already runs in this installation"
  [[ ! -e "$directory/data/$name" ]] || [[ -d "$directory/data/$name" && ! -L "$directory/data/$name" && -z $(find "$directory/data/$name" -mindepth 1 -print -quit) ]] ||
    die "data/$name already holds data; add never adopts an existing store"
done
while IFS= read -r user; do
  [[ $(id -u) == 0 || "$(id -u):$(id -g)" == "$user" ]] || die 'Run add as the configured service owner or with sudo; application containers stay non-root'
done < <(jq -r --argjson names "$(jq -c .components <<< "$request")" '.bootstrapServiceUsers|to_entries[]|select(.key as $name|$names|index($name))|.value' <<< "$input")

# The operator account fresh setup linked, or the one a migration names.
oathweave_environment=$(jq -er .placements.oathweave.envFile <<< "$input")
ingress_environment=$(jq -er .placements.ingress.envFile <<< "$input")
runtime=$(jq -er .console.runtimeFile <<< "$input")
for file in "$oathweave_environment" "$ingress_environment"; do
  [[ -f "$file" && ! -L "$file" ]] || die "$file is missing"
  (( (8#$(stat -c %a "$file") & 077)==0 )) || die "$file must be owner-only"
done
[[ -f "$runtime" && ! -L "$runtime" ]] || die 'The console runtime.json is missing'
# Compose semantics: the last assignment wins; one pair of quotes is removed.
get() {
  jq -Rrs --arg key "$2" --arg sq "'" 'split("\n")|map(select(startswith($key+"="))|.[($key|length)+1:]|
    if length>1 and ((startswith("\"") and endswith("\"")) or (startswith($sq) and endswith($sq))) then .[1:-1] else . end)|last // empty' "$1"
}
issuer=$(get "$oathweave_environment" IAM_BROWSER_ISSUER)
[[ "$issuer" =~ ^https://[A-Za-z0-9.-]+(:[0-9]+)?(/[A-Za-z0-9._/-]*)?$ ]] || die 'Oathweave has no HTTPS IAM_BROWSER_ISSUER'
if jq -e '.bootstrap!=null' <<< "$input" >/dev/null; then
  username=$(jq -er .bootstrap.adminUsername <<< "$input")
  [[ -f "$config/.initializer/secrets/identity-id" ]] || die 'The fresh setup record of the operator account is missing'
  subject=$(cat "$config/.initializer/secrets/identity-id")
elif jq -e '.nativeMigration.adminAccount!=null' <<< "$input" >/dev/null; then
  username=$(jq -er .nativeMigration.adminAccount.username <<< "$input")
  subject=$(jq -er .nativeMigration.adminAccount.subject <<< "$input")
  [[ "$issuer" == "$(jq -er .nativeMigration.browserIssuer <<< "$input")" ]] || die 'Oathweave browser issuer differs from nativeMigration.browserIssuer'
else die 'The installation names no operator account: a fresh installation has bootstrap, a migrated one nativeMigration.adminAccount'; fi
[[ "$subject" =~ ^[A-Za-z0-9._:@-]{1,128}$ && "$username" =~ ^[a-zA-Z_][a-zA-Z0-9_.-]{0,63}$ ]] || die 'Invalid operator account'

# The installation's internal authority: the one the ingress verifies products with.
if [[ -f "$config/.initializer/keys/authority.pem" ]]; then ca_key="$config/.initializer/keys/authority.pem"; ca="$config/.initializer/certificates/authority.pem"
elif [[ -f "$config/.migration/ca.key" ]]; then ca_key="$config/.migration/ca.key"; ca="$config/.migration/ca.pem"
else die 'This installation has no internal certificate authority (a distributed installation uses its own trust bundle)'; fi
for path in "$ca_key" "$ca"; do [[ -f "$path" && ! -L "$path" ]] || die 'Unsafe internal authority'; done
cmp -s "$ca" "$config/ingress/backend-ca.pem" || die 'The internal authority is not the one the ingress trusts'

[[ ! -L "$directory/controller.lock" ]] || die 'Unsafe controller lock'
exec 9>"$directory/controller.lock"
flock -n 9 || die 'Another controller holds this host'
for path in "$config/.additions" "$state" "$state/secrets" "$state/keys" "$state/certificates"; do
  [[ ! -L "$path" ]] || die 'Unsafe journal directory'
  install -d -m 700 -- "$path"
done
atomic_receipt() { local pending; pending=$(mktemp "$state/receipt.XXXXXX"); cat > "$pending"; chmod 600 "$pending"; sync -f "$pending"; mv -T -- "$pending" "$journal"; sync -f "$state"; }
image=$(jq -er --arg name "$product" '.bootstrapImages[$name]' <<< "$input")
inputs=$(jq -nc --arg issuer "$issuer" --arg subject "$subject" --arg username "$username" --arg image "$image" --arg version "$version" '{issuer:$issuer,subject:$subject,username:$username,image:$image,release:$version}')
if [[ -e "$journal" || -L "$journal" ]]; then
  [[ -f "$journal" && ! -L "$journal" && $(stat -c %u "$journal") == "$(id -u)" ]] || die 'Unsafe journal'
  jq -e --arg id "$installation" --arg host "$host" --arg product "$product" --argjson inputs "$inputs" '.schema==1 and .installation==$id and .host==$host and .product==$product and .inputs==$inputs' "$journal" >/dev/null ||
    die "An earlier add of $product used other inputs (operator account, release or image); its journal $journal is kept"
  if [[ $(jq -r .phase "$journal") == complete ]]; then
    jq -c '{phase,changed:[],username:.inputs.username,passwordFile}' "$journal"
    exit 0
  fi
  while IFS=$'\t' read -r path sha; do
    [[ "$path" == "$config/"* && -f "$path" && ! -L "$path" && $(sha256sum "$path" | cut -d ' ' -f1) == "$sha" ]] || die "$path changed since an earlier attempt wrote it; nothing is overwritten"
  done < <(jq -r '.files|to_entries[]|[.key,.value]|@tsv' "$journal")
else
  jq -n --arg id "$installation" --arg host "$host" --arg product "$product" --argjson inputs "$inputs" '{schema:1,installation:$id,host:$host,product:$product,inputs:$inputs,phase:"preparing",files:{}}' | atomic_receipt
fi
record_file() {
  local path=$1 sha
  sha=$(sha256sum "$path" | cut -d ' ' -f1)
  jq --arg path "$path" --arg sha "$sha" '.files[$path]=$sha' "$journal" | atomic_receipt
}
# As the fresh initializer: generated once through a pending file, never rotated by a repeat.
ensure_secret() {
  local path="$state/secrets/$1" pending="$state/secrets/$1.pending" value
  [[ ! -L "$path" && ! -L "$pending" ]] || die 'Unsafe secret path'
  if [[ ! -e "$path" ]]; then
    if [[ ! -e "$pending" ]]; then openssl rand -hex 32 > "$pending"; sync -f "$pending"; fi
    value=$(cat "$pending"); [[ "$value" =~ ^[a-f0-9]{64}$ ]] || die 'Interrupted entropy generation needs recovery; existing bytes are retained'
    mv -T -- "$pending" "$path"
  fi
  value=$(cat "$path"); [[ "$value" =~ ^[a-f0-9]{64}$ ]] || die 'Invalid protected secret'
  record_file "$path"
}
secret() { cat "$state/secrets/$1"; }
ensure_secret security-id
while IFS= read -r name; do ensure_secret "$name"; done < <(hive_full_secret_names "$product")

# The product's internal certificate, from the installation authority, as fresh setup issues it.
key="$state/keys/$product.pem" leaf="$state/certificates/$product.pem"
[[ ! -L "$key" && ! -L "$key.pending" && ! -L "$leaf" && ! -L "$leaf.pending" ]] || die 'Unsafe certificate path'
if [[ ! -e "$key" ]]; then
  [[ -e "$key.pending" ]] || openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:3072 -out "$key.pending" >/dev/null 2>&1
  openssl pkey -in "$key.pending" -noout >/dev/null 2>&1 || die 'Incomplete private key retained for recovery'
  sync -f "$key.pending"; mv -T -- "$key.pending" "$key"
fi
openssl pkey -in "$key" -noout >/dev/null 2>&1 || die 'Invalid product private key'
record_file "$key"
if [[ ! -e "$leaf" ]]; then
  printf 'subjectAltName=DNS:%s,DNS:localhost\nbasicConstraints=critical,CA:FALSE\nextendedKeyUsage=serverAuth\nkeyUsage=critical,digitalSignature,keyEncipherment\n' "$product" > "$state/$product.extensions"
  openssl req -new -key "$key" -out "$state/$product.csr" -subj "/CN=$product" >/dev/null 2>&1
  openssl x509 -req -in "$state/$product.csr" -CA "$ca" -CAkey "$ca_key" -set_serial "0x$(openssl rand -hex 16)" -days 825 -extfile "$state/$product.extensions" -out "$leaf.pending" >/dev/null 2>&1
  sync -f "$leaf.pending"; mv -T -- "$leaf.pending" "$leaf"
fi
openssl verify -CAfile "$ca" -verify_hostname "$product" "$leaf" >/dev/null || die 'Product certificate verification failed'
record_file "$leaf"

# Fresh setup's helpers, for initialize-full-host.sh.
publish_file() {
  local component=$1 path=$2 mode=${3:-600} temporary user uid gid
  user=$(jq -er --arg name "$component" '.bootstrapServiceUsers[$name]' <<< "$input"); uid=${user%:*}; gid=${user#*:}
  if [[ $(dirname "$path") == "$config" ]]; then
    [[ -d "$config" && ! -L "$config" ]] || die 'Configuration root changed'
  else install -d -m 700 -o "$uid" -g "$gid" "$(dirname "$path")"; fi
  temporary=$(mktemp "$state/publish.XXXXXX"); cat > "$temporary"; chmod "$mode" "$temporary"
  if [[ -e "$path" || -L "$path" ]]; then
    [[ -f "$path" && ! -L "$path" ]] && cmp -s "$temporary" "$path" || die "$path exists with other content; it will not be overwritten"
    rm -- "$temporary"
  else chown "$uid:$gid" "$temporary"; sync -f "$temporary"; mv -T -- "$temporary" "$path"; fi
  record_file "$path"
}
line() { printf '%s=%s\n' "$1" "$2"; }
common_environment() {
  line NODE_ENV production; line HIVE_HOME /data; line HIVE_AUTO_MIGRATE false; line HIVE_AUTO_UPGRADE false; line HIVE_UPDATE_CHECK false; line NODE_EXTRA_CA_CERTS /config/authority.pem
}
product_endpoint() { printf '%s\n' "$2"; }
resource_identity() {
  line OATHWEAVE_ISSUER "$issuer"; line OATHWEAVE_JWKS_URL https://oathweave:4200/api/v1/oauth/jwks; line OATHWEAVE_USERINFO_URL https://oathweave:4200/api/v1/oauth/userinfo
}
external_magnus=''
publish_file "$product" "$config/$product/tls.key" < "$key"
publish_file "$product" "$config/$product/tls.crt" < "$leaf"
publish_file "$product" "$config/$product/authority.pem" < "$ca"
hive_full_configuration

# Existing files gain only their new entries; every other line, the owner and the mode stay, and
# fresh setup's record of a file follows its new bytes, so tls-refresh keeps accepting it.
changed=()
update() { # FILE JSON-OBJECT
  local file=$1 wanted=$2 changes keys temporary key
  changes='{}'
  while IFS= read -r key; do
    [[ "$(get "$file" "$key")" == "$(jq -r --arg key "$key" '.[$key]' <<< "$wanted")" ]] || changes=$(jq -c --arg key "$key" --argjson wanted "$wanted" '.+{($key):$wanted[$key]}' <<< "$changes")
  done < <(jq -r 'keys[]' <<< "$wanted")
  [[ "$changes" != '{}' ]] || return 0
  jq -e --arg sq "'" 'all(.[]; (contains($sq)|not) and (test("[\n\r]")|not))' <<< "$changes" >/dev/null || die 'A value cannot be represented in an environment file'
  keys=$(jq -r 'keys|join("|")' <<< "$changes")
  temporary=$(mktemp "$config/.add.XXXXXX")
  { grep -vE "^($keys)=" -- "$file" || true; jq -r --arg sq "'" 'to_entries[]|.key+"="+$sq+.value+$sq' <<< "$changes"; } > "$temporary"
  chown --reference="$file" -- "$temporary"; chmod --reference="$file" -- "$temporary"; sync -f "$temporary"; mv -T -- "$temporary" "$file"
  rerecord "$file"
  changed+=("${file#"$config"/}")
}
rerecord() {
  local receipt="$config/.initializer/receipt.json"
  if [[ -f "$receipt" && ! -L "$receipt" ]] && jq -e --arg path "$1" '.files[$path]!=null' "$receipt" >/dev/null; then
    jq --arg path "$1" --arg sha "$(sha256sum -- "$1" | cut -d ' ' -f1)" '.files[$path]=$sha' "$receipt" > "$receipt.new"
    chmod 600 -- "$receipt.new"; mv -T -- "$receipt.new" "$receipt"
  fi
}
client=$(jq -ce '.browserClient|objects' <<< "$request") || die 'Missing browser client'
client_id=$(jq -er .id <<< "$client")
policies=$(get "$oathweave_environment" IAM_BROWSER_CLIENT_POLICIES); [[ -n "$policies" ]] || policies='{}'
jq -e 'type=="object"' <<< "$policies" >/dev/null 2>&1 || die 'IAM_BROWSER_CLIENT_POLICIES is not a JSON object'
jq -e --arg id "$client_id" --argjson client "$client" '.[$id]==null or .[$id]=={audience:$client.audience,permissions:$client.permissions}' <<< "$policies" >/dev/null ||
  die "Oathweave already has another policy for $client_id"
update "$oathweave_environment" "$(jq -nc --argjson policies "$policies" --arg id "$client_id" --argjson client "$client" '{IAM_BROWSER_CLIENT_POLICIES:($policies+{($id):{audience:$client.audience,permissions:$client.permissions}}|tojson)}')"
# The internal endpoint, as fresh setup writes it for a product on the console host.
wanted='{"CINDERTRACE_ENDPOINT":"https://cindertrace:4101","CINDERTRACE_TLS_NAME":"cindertrace"}'
while IFS=$'\t' read -r name value; do
  current=$(get "$ingress_environment" "$name")
  [[ -z "$current" || "$current" == "$value" ]] || die "The ingress already routes $product elsewhere ($name)"
done < <(jq -r 'to_entries[]|[.key,.value]|@tsv' <<< "$wanted")
update "$ingress_environment" "$wanted"
# HiveXUI mounts this one file: it is rewritten in place, readable by the console.
jq -e --arg product "$product" --arg id "$client_id" '(.products[$product]==null or .products[$product]==("/api/"+$product)) and (.identity.clients[$product]==null or .identity.clients[$product]==$id)' "$runtime" >/dev/null ||
  die "runtime.json already names another $product console path or client"
if ! jq -e --arg product "$product" --arg id "$client_id" '.products[$product]==("/api/"+$product) and .identity.clients[$product]==$id' "$runtime" >/dev/null; then
  jq --arg product "$product" --arg id "$client_id" '.products[$product]=("/api/"+$product) | .identity.clients[$product]=$id' "$runtime" > "$state/runtime.json"
  hive_check_public_runtime "$state/runtime.json" || die 'The new runtime.json would not be a valid public console configuration'
  cat -- "$state/runtime.json" > "$runtime"; sync -f "$runtime"; rm -f -- "$state/runtime.json"
  rerecord "$runtime"
  changed+=("${runtime#"$config"/}")
fi
# A fresh installation records a storage format for every component of its release, selected or
# not, and a later release may have renamed those formats. None of these components has a store
# here (checked above), so such an entry describes no data: removing it lets the upgrade treat
# them as new, start them at the release's formats and initialize their schema, instead of asking
# for a migration of data that does not exist. The removed entries are kept in the journal.
formats="$directory/data-formats.json"
if [[ -f "$formats" && ! -L "$formats" ]] && jq -e --argjson names "$(jq -c .components <<< "$request")" 'any(keys[]; . as $key|$names|index($key))' "$formats" >/dev/null; then
  jq --argjson names "$(jq -c .components <<< "$request")" --slurpfile formats "$formats" '.staleFormats=((.staleFormats // {})+($formats[0]|with_entries(select(.key as $key|$names|index($key)))))' "$journal" | atomic_receipt
  temporary=$(mktemp "$directory/.data-formats.XXXXXX")
  jq --argjson names "$(jq -c .components <<< "$request")" 'with_entries(select(.key as $key|$names|index($key)|not))' "$formats" > "$temporary"
  chown --reference="$formats" -- "$temporary"; chmod --reference="$formats" -- "$temporary"; sync -f "$temporary"; mv -T -- "$temporary" "$formats"
  changed+=(data-formats.json)
fi
jq --arg password "$state/secrets/security-admin-password" '.phase="complete" | .passwordFile=$password' "$journal" | atomic_receipt
printf 'Cindertrace configuration prepared on %s; secrets stay in %s.\n' "$host" "$state/secrets" >&2
jq -nc --arg username "$username" --arg password "$state/secrets/security-admin-password" '{phase:"complete",changed:$ARGS.positional,username:$username,passwordFile:$password}' --args "${changed[@]}"
