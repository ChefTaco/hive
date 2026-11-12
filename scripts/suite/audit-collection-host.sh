#!/usr/bin/env bash
# Suite audit collection, transported verbatim by the controller (scripts/suite/audit-collection.sh).
#   identity host:   one Oathweave machine client per product, cindertrace-audit-<product>, with
#                    only <product>:audit:read and a secret generated once into an owner-only file
#   product host:    the setting with which the product accepts that client's service tokens
#   Cindertrace host (the identity host): the collector's settings, a read-only copy of each client
#                    secret in Cindertrace's configuration and the suite-audit collector credential
# A secret is never printed. Every step is idempotent, and a file is rewritten only when a value
# changes. Services are not restarted: install and upgrade start them with the new settings.
set -Eeuo pipefail
umask 077
read -r input
directory=$(jq -er .directory <<< "$input")
action=$(jq -er .action <<< "$input")
products='["hivemem","hiveskills","ardentstudio","embermend"]'
collector_id=suite-audit
die() { printf 'Audit collection: %s\n' "$*" >&2; exit 1; }
[[ "$directory" =~ ^/[A-Za-z0-9_./-]+$ && "$directory" != *'/../'* && "$directory" != */.. && ! -L "$directory" ]] || die 'Invalid installation path'
config="$directory/config"
request=$(jq -ce '.auditCollection|objects' <<< "$input") || die 'Missing audit collection request'
placed() { jq -e --arg name "$1" '.placements[$name]!=null' <<< "$input" >/dev/null; }
lock() {
  [[ ! -L "$directory/controller.lock" ]] || die 'Unsafe controller lock'
  exec 9>"$directory/controller.lock"
  flock -n 9 || die 'Another controller holds this host'
}
env_file() {
  local file="$config/$1.env"
  [[ -f "$file" && ! -L "$file" ]] || die "The $1 environment is missing; configure the installation first"
  (( (8#$(stat -c %a "$file") & 077)==0 )) || die "The $1 environment must be owner-only"
  printf '%s\n' "$file"
}
product() {
  jq -e --argjson products "$products" 'type=="string" and (. as $name|$products|index($name))' <<< "$1" >/dev/null || die 'Unknown audit product'
}
https_origin() { [[ "$1" =~ ^https://[A-Za-z0-9.-]+(:[0-9]+)?$ ]] || die 'Endpoints must be HTTPS origins'; }
# Compose and systemd semantics: the last assignment wins; one pair of quotes is removed.
get() {
  jq -Rrs --arg key "$2" --arg sq "'" 'split("\n")|map(select(startswith($key+"="))|.[($key|length)+1:]|
    if length>1 and ((startswith("\"") and endswith("\"")) or (startswith($sq) and endswith($sq))) then .[1:-1] else . end)|last // empty' "$1"
}
# Replaces or appends KEY='VALUE' lines for the changed keys only, keeping every other line, the
# owner and the mode, and the initializer's record of the file.
changed=()
update() {
  local file=$1 wanted=$2 current='{}' key changes keys temporary receipt="$config/.initializer/receipt.json"
  while IFS= read -r key; do
    current=$(jq -c --arg key "$key" --arg value "$(get "$file" "$key")" '.+{($key):$value}' <<< "$current")
  done < <(jq -r 'keys[]' <<< "$wanted")
  changes=$(jq -c --argjson current "$current" 'with_entries(select(.value!=$current[.key]))' <<< "$wanted")
  [[ "$changes" != '{}' ]] || return 0
  jq -e --arg sq "'" 'all(to_entries[]; (.key|test("^[A-Z][A-Z0-9_]*$")) and (.value|type)=="string" and (.value|contains($sq)|not) and (.value|test("[\n\r]")|not))' <<< "$changes" >/dev/null || die 'A value cannot be represented in an environment file'
  keys=$(jq -r 'keys|join("|")' <<< "$changes")
  temporary=$(mktemp "$config/.audit-collection.XXXXXX")
  { grep -vE "^($keys)=" -- "$file" || true; jq -r --arg sq "'" 'to_entries[]|.key+"="+$sq+.value+$sq' <<< "$changes"; } > "$temporary"
  chown --reference="$file" -- "$temporary"; chmod 600 -- "$temporary"; sync -f "$temporary"; mv -T -- "$temporary" "$file"
  if [[ -f "$receipt" && ! -L "$receipt" ]] && jq -e --arg path "$file" '.files[$path]!=null' "$receipt" >/dev/null; then
    jq --arg path "$file" --arg sha "$(sha256sum -- "$file" | cut -d ' ' -f1)" '.files[$path]=$sha' "$receipt" > "$receipt.new"
    chmod 600 -- "$receipt.new"; mv -T -- "$receipt.new" "$receipt"
  fi
  changed+=("${file##*/}")
}
credentials() {
  [[ ! -L "$config/.credentials" ]] || die 'Unsafe credential directory'
  install -d -m 700 -- "$config/.credentials"
}
# A secret generated once. An existing one is kept, so a repeat never rotates it.
generate_once() {
  local file=$1
  [[ ! -L "$file" && ! -L "$file.pending" ]] || die 'Unsafe credential path'
  if [[ ! -f "$file" ]]; then
    [[ -f "$file.pending" ]] || openssl rand -hex 32 > "$file.pending"
    sync -f "$file.pending"; mv -T -- "$file.pending" "$file"
  fi
  [[ $(stat -c %a "$file") == 600 ]] || chmod 600 -- "$file"
  [[ $(cat -- "$file") =~ ^[0-9a-f]{64}$ ]] || die "Invalid protected secret ${file##*/}; recover it or remove it to generate a new one"
}

# The Oathweave clients, beside every other machine client. Tokens use Oathweave's native issuer.
identity() {
  placed oathweave || die 'Oathweave is not placed on this host'
  local oath list name client policies secrets issuer
  list=$(jq -ce '.products|arrays' <<< "$request") || die 'Missing products'
  jq -e 'length>0 and length==(unique|length)' <<< "$list" >/dev/null || die 'Products must be listed once'
  oath=$(env_file oathweave)
  credentials
  policies=$(get "$oath" IAM_MACHINE_CLIENT_POLICIES); [[ -n "$policies" ]] || policies='{}'
  secrets=$(get "$oath" IAM_MACHINE_CLIENT_SECRETS); [[ -n "$secrets" ]] || secrets='{}'
  jq -e 'type=="object"' <<< "$policies" >/dev/null 2>&1 || die 'IAM_MACHINE_CLIENT_POLICIES is not a JSON object'
  jq -e 'type=="object"' <<< "$secrets" >/dev/null 2>&1 || die 'IAM_MACHINE_CLIENT_SECRETS is not a JSON object'
  while IFS= read -r name; do
    product "$(jq -c --arg name "$name" -n '$name')"
    client="cindertrace-audit-$name"
    generate_once "$config/.credentials/$client"
    policies=$(jq -c --arg client "$client" --arg name "$name" '.+{($client):{audience:$name,permissions:[$name+":audit:read"],lifetimeSeconds:300,rotationOwner:"hive-suite"}}' <<< "$policies")
    secrets=$(jq -c --arg client "$client" --rawfile secret "$config/.credentials/$client" '.+{($client):($secret|rtrimstr("\n"))}' <<< "$secrets")
  done < <(jq -r '.[]' <<< "$list")
  update "$oath" "$(jq -nc --argjson policies "$policies" --argjson secrets "$secrets" '{IAM_MACHINE_CLIENT_POLICIES:($policies|tojson),IAM_MACHINE_CLIENT_SECRETS:($secrets|tojson)}')"
  issuer=$(get "$oath" JWT_ISSUER); [[ -n "$issuer" ]] || issuer=hive-iam
  jq -nc --arg issuer "$issuer" '{issuer:$issuer,changed:$ARGS.positional}' --args "${changed[@]}"
}

# The comma-separated native issuers a product accepts service tokens from, with this one added.
native_issuers() { # FILE ISSUER
  jq -nc --arg current "$(get "$1" OATHWEAVE_NATIVE_ISSUERS)" --arg issuer "$2" \
    '{OATHWEAVE_NATIVE_ISSUERS:(($current|split(",")|map(gsub("^ +| +$";""))|map(select(.!=""))) as $kept|if ($kept|index($issuer)) then $kept else $kept+[$issuer] end|join(","))}'
}
# The product accepts exactly that client, for its audit export only.
accept() {
  local name client issuer installation file services grants worker
  name=$(jq -er .product <<< "$request"); product "$(jq -c .product <<< "$request")"
  placed "$name" || die "$name is not placed on this host"
  client="cindertrace-audit-$name"
  issuer=$(jq -er .issuer <<< "$request"); installation=$(jq -er .installation <<< "$request")
  [[ "$issuer" =~ ^[A-Za-z0-9][A-Za-z0-9._:/-]{0,511}$ ]] || die 'Invalid issuer'
  [[ "$installation" =~ ^[a-z][a-z0-9-]{0,47}$ ]] || die 'Invalid installation'
  file=$(env_file "$name")
  case "$name" in
    hivemem)
      # HiveMem links a service on its native issuer, with only the scope the export needs.
      [[ -n $(get "$file" OATHWEAVE_JWKS_URL) ]] || die 'HiveMem has no OATHWEAVE_JWKS_URL to verify service tokens'
      services=$(get "$file" HIVEMEM_OATHWEAVE_SERVICES_JSON); [[ -n "$services" ]] || services='[]'
      jq -e 'type=="array"' <<< "$services" >/dev/null 2>&1 || die 'HIVEMEM_OATHWEAVE_SERVICES_JSON is not a JSON array'
      update "$file" "$(jq -nc --argjson services "$services" --arg issuer "$issuer" --arg client "$client" '{
        HIVEMEM_OATHWEAVE_SERVICES_JSON:([$services[]|select(.clientId!=$client)]+[{issuer:$issuer,clientId:$client,localId:"cindertrace-audit",scopes:["audit:read"]}]|tojson)}')";;
    hiveskills|ardentstudio)
      update "$file" "$(native_issuers "$file" "$issuer")";;
    embermend)
      # An integration grant with only audit:read, scoped to this installation. The worker reads
      # the same environment.
      grants=$(get "$file" EMBERMEND_IDENTITY_GRANTS); [[ -n "$grants" ]] || grants='[]'
      jq -e 'type=="array"' <<< "$grants" >/dev/null 2>&1 || die 'EMBERMEND_IDENTITY_GRANTS is not a JSON array'
      update "$file" "$(jq -nc --argjson grants "$grants" --arg client "$client" --arg installation "$installation" --argjson issuers "$(native_issuers "$file" "$issuer")" '$issuers+{
        EMBERMEND_IDENTITY_GRANTS:([$grants[]|select(.subject!=$client)]+[{subject:$client,kind:"integration",permissions:["audit:read"],scope:{installationId:$installation,applicationIds:[],targetIds:[]}}]|tojson)}')"
      worker="$config/embermend-worker.env"
      if placed embermend-worker && [[ -f "$worker" ]]; then
        worker=$(env_file embermend-worker)
        update "$worker" "$(jq -nc --arg grants "$(get "$file" EMBERMEND_IDENTITY_GRANTS)" --arg issuers "$(get "$file" OATHWEAVE_NATIVE_ISSUERS)" '{EMBERMEND_IDENTITY_GRANTS:$grants,OATHWEAVE_NATIVE_ISSUERS:$issuers}')"
      fi;;
  esac
  jq -nc '{changed:$ARGS.positional}' --args "${changed[@]}"
}

# Writes a file only when its content differs, as the owner of Cindertrace's configuration.
place() { # SOURCE TARGET
  local temporary
  [[ ! -L "$2" ]] || die 'Unsafe collector secret path'
  if [[ -f "$2" ]] && cmp -s -- "$1" "$2"; then return 0; fi
  temporary=$(mktemp "${2%/*}/.audit-collection.XXXXXX")
  cat -- "$1" > "$temporary"
  chown --reference="$config/cindertrace" -- "$temporary"; chmod 600 -- "$temporary"; sync -f "$temporary"; mv -T -- "$temporary" "$2"
  changed+=("${2#"$config"/}")
}
# Cindertrace's collector settings, its copy of each client secret, and the collector credential
# that may send exactly these sources, kept in the store hive.sh cindertrace-collector manages.
collector() {
  placed cindertrace && placed oathweave || die 'Cindertrace and Oathweave must share this host'
  local environment sources token api mount clients store record all credentials collector value name enabled settings
  sources=$(jq -ce '.sources|arrays' <<< "$request") || die 'Missing sources'
  jq -e --argjson products "$products" 'length>0 and (map(.source)|length==(unique|length)) and all(.[];
      (keys==["source","url"]) and (.source as $name|$products|index($name)) and
      (.url|type=="string" and test("^https://[A-Za-z0-9.-]+(:[0-9]+)?/[A-Za-z0-9._~/-]*$") and length<=2000))' <<< "$sources" >/dev/null ||
    die 'Sources are HTTPS export URLs of hivemem, hiveskills, ardentstudio and embermend, each listed once'
  token=$(jq -er .tokenOrigin <<< "$request"); https_origin "$token"
  api=$(jq -er .apiUrl <<< "$request"); https_origin "$api"
  environment=$(env_file cindertrace)
  mount="$config/cindertrace"
  [[ -d "$mount" && ! -L "$mount" ]] || die 'The Cindertrace configuration directory is missing'
  clients="$mount/audit-clients"
  [[ ! -L "$clients" ]] || die 'Unsafe collector secret directory'
  if [[ ! -d "$clients" ]]; then install -d -m 700 -- "$clients"; chown --reference="$mount" -- "$clients"; fi
  while IFS= read -r name; do
    [[ -f "$config/.credentials/cindertrace-audit-$name" && ! -L "$config/.credentials/cindertrace-audit-$name" ]] || die "The $name audit client has no secret; run the identity step first"
    [[ $(cat -- "$config/.credentials/cindertrace-audit-$name") =~ ^[0-9a-f]{64}$ ]] || die "Invalid protected secret cindertrace-audit-$name"
    place "$config/.credentials/cindertrace-audit-$name" "$clients/cindertrace-audit-$name"
  done < <(jq -r '.[].source' <<< "$sources")
  credentials
  store="$config/.credentials/cindertrace-collectors"
  [[ ! -L "$store" ]] || die 'Unsafe credential directory'
  install -d -m 700 -- "$store"
  record="$store/$collector_id.json"
  [[ ! -L "$record" ]] || die 'Unsafe collector path'
  generate_once "$store/$collector_id"
  jq -n --arg id "$collector_id" --argjson sources "$(jq -c 'map(.source)|sort' <<< "$sources")" '{schema:1,id:$id,allowedSources:$sources}' > "$record.new"
  if [[ -f "$record" ]] && cmp -s -- "$record.new" "$record"; then rm -f -- "$record.new"; else mv -T -- "$record.new" "$record"; fi
  # The credential registry over every collector, as hive.sh cindertrace-collector writes it.
  all=$(for collector in "$store"/*.json; do
      [[ -e "$collector" ]] || continue
      [[ -f "$collector" && ! -L "$collector" ]] || die 'Unsafe collector record'
      jq -ce 'select(.schema==1 and (.id|type=="string") and (.allowedSources|type=="array"))' "$collector" || die "Invalid collector record $collector"
    done | jq -s 'sort_by(.id)')
  credentials=$(jq -c 'map({key:.id,value:{secret:"",allowedSources,displayName:.id}})|from_entries' <<< "$all")
  while IFS= read -r collector; do
    value=$(cat -- "$store/$collector")
    [[ "$value" =~ ^[0-9a-f]{64}$ ]] || die "The credential file of $collector is invalid; remove and add the collector again"
    credentials=$(jq -c --arg id "$collector" --rawfile secret "$store/$collector" '.[$id].secret=($secret|rtrimstr("\n"))' <<< "$credentials")
  done < <(jq -r '.[].id' <<< "$all")
  enabled=false; [[ $(jq length <<< "$all") == 0 ]] || enabled=true
  settings=$(jq -c --arg token "$token" --arg api "$api" --arg id "$collector_id" --arg enabled "$enabled" --argjson credentials "$credentials" '{
    SECURITY_INGEST_ENABLED:$enabled,SECURITY_FUSION_COLLECTOR_CREDENTIALS_JSON:($credentials|tojson),
    CINDERTRACE_API_URL:$api,SECURITY_FUSION_COLLECTOR_ID:$id,SECURITY_COLLECTOR_AUDIT_OATHWEAVE_URL:$token,
    SECURITY_COLLECTOR_AUDIT_SOURCES_JSON:(map({source,url,audience:.source,scope:(.source+":audit:read"),clientId:("cindertrace-audit-"+.source),clientSecretFile:("/config/audit-clients/cindertrace-audit-"+.source)})|tojson)}' <<< "$sources")
  update "$environment" "$settings"
  jq -nc '{changed:$ARGS.positional}' --args "${changed[@]}"
}
lock
case "$action" in
  audit-collection-identity) identity;;
  audit-collection-accept) accept;;
  audit-collection-collector) collector;;
  *) die 'Unknown audit collection action';;
esac
