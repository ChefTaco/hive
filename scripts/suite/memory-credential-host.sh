#!/usr/bin/env bash
# Emberpath's self-renewing HiveMem credential, transported verbatim by the controller.
# Emberpath calls HiveMem with short-lived Oathweave client_credentials tokens that it
# fetches and renews itself. This step only declares that client once:
#   identity host: the client secret, in the Oathweave and Emberpath environments
#   memory host:   the public link from that Oathweave client to a HiveMem principal
# The secret never leaves the identity host and is never printed. Every step is
# idempotent, and a file is rewritten only when a value changes.
set -Eeuo pipefail
umask 077
read -r input
directory=$(jq -er .directory <<< "$input")
action=$(jq -er .action <<< "$input")
client=emberpath-hivemem
die() { printf 'Memory credential: %s\n' "$*" >&2; exit 1; }
[[ "$directory" =~ ^/[A-Za-z0-9_./-]+$ && "$directory" != *'/../'* && "$directory" != */.. && ! -L "$directory" ]] || die 'Invalid installation path'
config="$directory/config"
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
# Compose and systemd semantics: the last assignment wins; one pair of quotes is removed.
get() {
  jq -Rrs --arg key "$2" --arg sq "'" 'split("\n")|map(select(startswith($key+"="))|.[($key|length)+1:]|
    if length>1 and ((startswith("\"") and endswith("\"")) or (startswith($sq) and endswith($sq))) then .[1:-1] else . end)|last // empty' "$1"
}
# Replaces or appends KEY='VALUE' lines for the changed keys only, keeping every other
# line, the owner and the mode, and the initializer's record of the file.
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
  temporary=$(mktemp "$config/.memory-credential.XXXXXX")
  { grep -vE "^($keys)=" -- "$file" || true; jq -r --arg sq "'" 'to_entries[]|.key+"="+$sq+.value+$sq' <<< "$changes"; } > "$temporary"
  chown --reference="$file" -- "$temporary"; chmod 600 -- "$temporary"; sync -f "$temporary"; mv -T -- "$temporary" "$file"
  if [[ -f "$receipt" && ! -L "$receipt" ]] && jq -e --arg path "$file" '.files[$path]!=null' "$receipt" >/dev/null; then
    jq --arg path "$file" --arg sha "$(sha256sum -- "$file" | cut -d ' ' -f1)" '.files[$path]=$sha' "$receipt" > "$receipt.new"
    chmod 600 -- "$receipt.new"; mv -T -- "$receipt.new" "$receipt"
  fi
  changed+=("${file##*/}")
}
https_origin() { [[ "$1" =~ ^https://[A-Za-z0-9.-]+(:[0-9]+)?$ ]] || die 'Product endpoints must be HTTPS origins'; }
# The Oathweave client the identity host declares, with its HiveMem principal and issuer.
identity() {
  placed oathweave && placed emberpath || die 'Oathweave and Emberpath must share this host'
  local oath ember record="$config/.credentials/$client.json" secret_file="$config/.credentials/$client" secret issuer local_id legacy subject policies secrets
  local identity_origin memory_origin
  identity_origin=$(jq -er .memoryCredential.identityOrigin <<< "$input"); https_origin "$identity_origin"
  memory_origin=$(jq -er .memoryCredential.memoryOrigin <<< "$input"); https_origin "$memory_origin"
  oath=$(env_file oathweave); ember=$(env_file emberpath)
  # Least privilege: only an Emberpath that serves HiveMem-backed endpoints gets a HiveMem
  # identity. That is a migrated installation, whose native clients use the Router's memory
  # and actor endpoints, or one an operator configured with a static memory token. A fresh
  # suite never exposes those endpoints: the console uses HiveMem and Oathweave directly.
  if [[ -z $(get "$ember" HIVE_ROUTER_MEMORY_PROXY_TOKEN) && -z $(get "$ember" EMBERPATH_HIVEMEM_CLIENT_ID) && $(jq -r '.nativeMigration!=null' <<< "$input") != true ]]; then
    jq -nc '{skipped:true,reason:"Emberpath serves no HiveMem-backed endpoints here"}'; return
  fi
  [[ ! -L "$config/.credentials" ]] || die 'Unsafe credential directory'
  install -d -m 700 -- "$config/.credentials"
  [[ ! -L "$secret_file" && ! -L "$secret_file.pending" && ! -L "$record" ]] || die 'Unsafe credential path'
  if [[ ! -f "$secret_file" ]]; then
    # An existing configured secret is kept; otherwise one is generated once.
    secret=$(get "$ember" EMBERPATH_HIVEMEM_CLIENT_SECRET)
    [[ -f "$secret_file.pending" ]] || { if [[ -n "$secret" ]]; then printf '%s\n' "$secret"; else openssl rand -hex 32; fi; } > "$secret_file.pending"
    sync -f "$secret_file.pending"; mv -T -- "$secret_file.pending" "$secret_file"
  fi
  secret=$(cat -- "$secret_file")
  [[ "$secret" =~ ^[A-Za-z0-9._~-]{32,512}$ ]] || die 'Invalid protected client secret; recover it or remove it to generate a new one'
  issuer=$(get "$oath" JWT_ISSUER); [[ -n "$issuer" ]] || issuer=hive-iam
  if [[ -f "$record" ]]; then
    local_id=$(jq -er --arg client "$client" 'select(.schema==1 and .clientId==$client)|.localId' "$record") || die 'Invalid credential record'
  else
    # A migrated Router acted as the subject of its static admin token; keep that principal so
    # its HiveMem audit trail and ownership continue. A fresh installation uses emberpath.
    legacy=$(get "$ember" HIVE_ROUTER_MEMORY_PROXY_TOKEN)
    subject=$(jq -Rr 'split(".")[1] // ""|gsub("-";"+")|gsub("_";"/")|.+("="*((4-length%4)%4))|@base64d|fromjson?|.sub // empty|strings' <<< "$legacy" 2>/dev/null || true)
    if [[ "$subject" =~ ^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$ ]]; then local_id=$subject; else local_id=emberpath; fi
    jq -n --arg client "$client" --arg id "$local_id" '{schema:1,clientId:$client,localId:$id}' > "$record.new"; mv -T -- "$record.new" "$record"
  fi
  policies=$(get "$oath" IAM_MACHINE_CLIENT_POLICIES); [[ -n "$policies" ]] || policies='{}'
  secrets=$(get "$oath" IAM_MACHINE_CLIENT_SECRETS); [[ -n "$secrets" ]] || secrets='{}'
  jq -e 'type=="object"' <<< "$policies" >/dev/null 2>&1 || die 'IAM_MACHINE_CLIENT_POLICIES is not a JSON object'
  jq -e 'type=="object"' <<< "$secrets" >/dev/null 2>&1 || die 'IAM_MACHINE_CLIENT_SECRETS is not a JSON object'
  # HiveMem has no narrower role that can list agents across workspaces, register them and issue
  # their tokens; the link on the memory host keeps the same ceiling.
  update "$oath" "$(jq -c --arg client "$client" --argjson policies "$policies" --argjson secrets "$secrets" --rawfile secret "$secret_file" -n '{
      IAM_MACHINE_CLIENT_POLICIES:($policies+{($client):{audience:"hivemem",permissions:["hivemem:admin:all"],lifetimeSeconds:300,rotationOwner:"hive-suite"}}|tojson),
      IAM_MACHINE_CLIENT_SECRETS:($secrets+{($client):($secret|rtrimstr("\n"))}|tojson)}')"
  update "$ember" "$(jq -nc --arg client "$client" --rawfile secret "$secret_file" --arg identity "$identity_origin" --arg memory "$memory_origin" \
      --arg internal "$(get "$ember" HIVEMEM_INTERNAL_URL)" --arg ca "$(get "$ember" HIVEMEM_CA_CERT_PATH)" '{
      EMBERPATH_HIVEMEM_CLIENT_ID:$client,EMBERPATH_HIVEMEM_CLIENT_SECRET:($secret|rtrimstr("\n")),
      EMBERPATH_HIVEMEM_TOKEN_URL:($identity+"/api/v1/oauth/token"),
      HIVEMEM_INTERNAL_URL:(if $internal=="" then $memory else $internal end),
      HIVEMEM_CA_CERT_PATH:(if $ca=="" then "/config/authority.pem" else $ca end)}')"
  jq -nc --arg client "$client" --arg issuer "$issuer" --arg id "$local_id" '{clientId:$client,issuer:$issuer,localId:$id,changed:$ARGS.positional}' --args "${changed[@]}"
}
# The memory host accepts exactly that client, as that principal, with the same ceiling.
link() {
  placed hivemem || die 'HiveMem is not placed on this host'
  local memory services issuer local_id
  issuer=$(jq -er .memoryCredential.issuer <<< "$input"); local_id=$(jq -er .memoryCredential.localId <<< "$input")
  [[ $(jq -er .memoryCredential.clientId <<< "$input") == "$client" ]] || die 'Unexpected client'
  [[ "$local_id" =~ ^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$ && -n "$issuer" && ${#issuer} -le 512 ]] || die 'Invalid credential link'
  memory=$(env_file hivemem)
  [[ -n $(get "$memory" OATHWEAVE_JWKS_URL) ]] || die 'HiveMem has no OATHWEAVE_JWKS_URL to verify service tokens'
  services=$(get "$memory" HIVEMEM_OATHWEAVE_SERVICES_JSON); [[ -n "$services" ]] || services='[]'
  jq -e 'type=="array"' <<< "$services" >/dev/null 2>&1 || die 'HIVEMEM_OATHWEAVE_SERVICES_JSON is not a JSON array'
  update "$memory" "$(jq -nc --argjson services "$services" --arg issuer "$issuer" --arg client "$client" --arg id "$local_id" '{
    HIVEMEM_OATHWEAVE_SERVICES_JSON:([$services[]|select(.clientId!=$client)]+[{issuer:$issuer,clientId:$client,localId:$id,scopes:["admin:all"]}]|tojson)}')"
  jq -nc '{changed:$ARGS.positional}' --args "${changed[@]}"
}
lock
case "$action" in
  memory-credential-identity) identity;;
  memory-credential-link) link;;
  *) die 'Unknown memory credential action';;
esac
