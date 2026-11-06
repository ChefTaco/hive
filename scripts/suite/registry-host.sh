#!/usr/bin/env bash
# Hive Registry host operations, transported verbatim by the controller. Only JSON
# crosses the SSH boundary. Writes go through the client inside the registry container,
# so the host needs no Node runtime and the credential stays in its protected file.
set -Eeuo pipefail
umask 077
read -r input
directory=$(jq -er .directory <<< "$input")
host=$(jq -er .host <<< "$input")
plan=$(jq -r '.plan // empty' <<< "$input")
action=$(jq -er .action <<< "$input")
component=hive-registry
die() { printf 'Hive Registry: %s\n' "$*" >&2; exit 1; }
[[ "$directory" =~ ^/[A-Za-z0-9_./-]+$ && "$directory" != *'/../'* && "$directory" != */.. && ! -L "$directory" ]] || die 'Invalid installation path'
placed() { jq -e --arg name "$component" '.placements[$name]!=null' <<< "$input" >/dev/null; }
lock() {
  [[ ! -L "$directory/controller.lock" ]] || die 'Unsafe controller lock'
  exec 9>"$directory/controller.lock"
  flock -n 9 || die 'Another controller holds this host'
}
# The active definition, or the staged candidate before activation records it.
definition() {
  if [[ -n "$plan" && -f "$directory/candidate.$plan.json" ]]; then printf '%s\n' "$directory/candidate.$plan.json"; else printf '%s\n' "$directory/compose.json"; fi
}
client() {
  local method=$1 path=$2 level=$3
  docker compose -f "$(definition)" exec -T "$component" node /app/dist/cli.js request "$method" "$path" "$level"
}
credential() {
  local path=$1 pending="$1.pending" owner=$2 value
  [[ ! -L "$path" && ! -L "$pending" ]] || die 'Unsafe registry credential path'
  if [[ ! -e "$path" ]]; then
    if [[ ! -e "$pending" ]]; then openssl rand -hex 32 > "$pending"; chown "$owner" "$pending"; sync -f "$pending"; fi
    value=$(cat "$pending")
    [[ "$value" =~ ^[a-f0-9]{64}$ ]] || die 'Interrupted credential generation needs recovery; existing bytes are retained'
    mv -T -- "$pending" "$path"
  fi
  [[ -f "$path" && $(cat "$path") =~ ^[a-f0-9]{64}$ ]] || die 'Invalid protected registry credential'
  permissions=$(stat -c %a "$path"); (( (8#$permissions & 077)==0 )) || die 'Registry credential must be owner-only'
}
provision() {
  local owner uid gid installation environment temporary config
  owner=$(jq -er .registry.serviceUser <<< "$input"); uid=${owner%:*}; gid=${owner#*:}
  installation=$(jq -er .installation <<< "$input")
  config="$directory/config/$component"; environment="$directory/config/$component.env"
  install -d -m 700 "$directory" "$directory/config"
  [[ ! -L "$config" && ! -L "$environment" ]] || die 'Unsafe registry configuration path'
  [[ -d "$config" ]] || install -d -m 700 -o "$uid" -g "$gid" "$config"
  credential "$config/read-token" "$owner"
  credential "$config/write-token" "$owner"
  temporary=$(mktemp "$directory/config/.$component.XXXXXX")
  printf 'NODE_ENV=production\nHIVE_REGISTRY_INSTALLATION=%s\nHIVE_REGISTRY_DATA_DIR=/data\nHIVE_REGISTRY_PORT=8095\nHIVE_REGISTRY_READ_TOKEN_FILE=/config/read-token\nHIVE_REGISTRY_WRITE_TOKEN_FILE=/config/write-token\n' "$installation" > "$temporary"
  if [[ -e "$environment" ]]; then
    cmp -s "$temporary" "$environment" || { rm -f -- "$temporary"; die 'Existing registry environment differs; it will not be overwritten'; }
    rm -f -- "$temporary"
  else chown "$owner" "$temporary"; chmod 600 "$temporary"; sync -f "$temporary"; mv -T -- "$temporary" "$environment"; fi
  case "$(jq -r .operation <<< "$input")" in
    upgrade|rollback|adopt|rehearse)
      # An existing installation gains an empty store before its pre-change backup.
      install -d -m 700 "$directory/data"
      [[ ! -L "$directory/data/$component" ]] || die 'Data directory cannot be a symlink'
      [[ -d "$directory/data/$component" ]] || install -d -m 700 -o "$uid" -g "$gid" "$directory/data/$component"
      ;;
  esac
}
# The ingress configuration belongs to the release: an upgrade, rollback or adoption installs
# this controller's Caddyfile wherever it differs, such as a release that adds the registry
# route or changes an upstream transport. Fresh installs publish it already. The previous file
# is retained beside it (Caddyfile.pre-registry when it had no registry route, otherwise
# Caddyfile.previous). The ingress reads it when it next starts.
refresh_ingress() {
  local caddyfile="$directory/config/ingress/Caddyfile" template receipt="$directory/config/.initializer/receipt.json" previous
  [[ -f "$caddyfile" && ! -L "$caddyfile" ]] || return 0
  template=$(jq -er .ingressTemplate <<< "$input" | base64 -d)
  grep -q 'hive-registry:8095' <<< "$template" || die 'Controller ingress template has no registry route'
  # The Magnus host agent port imports its route set from the Caddyfile.
  if [[ -f "$directory/config/ingress/native-listeners-magnus-agents.caddy" ]] && ! grep -q '^(magnus_agent_listener) {' <<< "$template"; then
    die 'This installation publishes a Magnus host agent port, which this controller cannot serve; use the controller of the release that installed it'
  fi
  ! cmp -s -- "$caddyfile" <(printf '%s\n' "$template") || return 0
  previous="$caddyfile.previous"; grep -q 'hive-registry:8095' "$caddyfile" || previous="$caddyfile.pre-registry"
  cp -p -- "$caddyfile" "$previous"
  printf '%s\n' "$template" > "$caddyfile.new"
  chown --reference="$caddyfile" "$caddyfile.new"; chmod --reference="$caddyfile" "$caddyfile.new"
  sync -f "$caddyfile.new"; mv -T -- "$caddyfile.new" "$caddyfile"
  if [[ -f "$receipt" && ! -L "$receipt" ]] && jq -e --arg path "$caddyfile" '.files[$path]!=null' "$receipt" >/dev/null; then
    jq --arg path "$caddyfile" --arg sha "$(sha256sum "$caddyfile" | cut -d ' ' -f1)" '.files[$path]=$sha' "$receipt" > "$receipt.new"
    chmod 600 "$receipt.new"; mv -T -- "$receipt.new" "$receipt"
  fi
}
# Reports what this host actually runs. Never fails on an absent or stopped service.
observe() {
  local compose="$directory/compose.json" services='[]' service image container state health running matches reference active=false receipt=null phase=null catalog=null version
  if [[ -f "$directory/receipt.json" && -f "$compose" ]] && jq -e '.services|type=="object"' "$compose" >/dev/null 2>&1; then
    active=true
    receipt=$(jq -c '{version,digest,plan}' "$directory/receipt.json")
    phase=$(jq -c '.phase // null' "$directory/transaction.json" 2>/dev/null || printf 'null\n')
    version=$(jq -r .version <<< "$receipt")
    [[ ! -f "$directory/releases/$version/manifest" ]] || catalog=$(jq -c '.components|to_entries|map({id:.key,image:.value.image,storageFormat:(.value.storageFormat // null),version:(.value.version // null),catalog:(.value.catalog!=null)})' "$directory/releases/$version/manifest")
    while IFS= read -r service; do
      image=$(jq -r --arg name "$service" '.services[$name].image' "$compose")
      container=$(docker compose -f "$compose" ps -aq "$service" 2>/dev/null | head -n 1 || true)
      state=missing health='' running='' matches=false
      if [[ -n "$container" ]] && reference=$(docker inspect -f '{{.State.Status}}|{{if .State.Health}}{{.State.Health.Status}}{{end}}|{{.Config.Image}}|{{.Image}}' "$container" 2>/dev/null); then
        IFS='|' read -r state health running container <<< "$reference"
        [[ "$running" == "$image" && "$container" == "$(docker image inspect -f '{{.Id}}' "$image" 2>/dev/null || true)" ]] && matches=true
      fi
      services=$(jq -c --arg service "$service" --arg image "$image" --arg state "$state" --arg health "$health" --argjson matches "$matches" '.+[{service:$service,image:$image,state:$state,health:$health,imageMatches:$matches}]' <<< "$services")
    done < <(jq -r '.services|keys[]' "$compose")
  fi
  jq -n --arg host "$host" --argjson active "$active" --argjson receipt "$receipt" --argjson phase "$phase" --argjson catalog "$catalog" --argjson services "$services" '{host:$host,active:$active,receipt:$receipt,transactionPhase:$phase,catalog:$catalog,services:$services}'
}
case "$action" in
  registry-provision) placed || exit 0; install -d -m 700 "$directory"; lock; provision;;
  registry-refresh-ingress) placed || exit 0; lock; refresh_ingress;;
  registry-start)
    # Starts before the products it records, on this host only.
    placed || exit 0
    lock
    install -d -m 700 "$directory/data"
    owner=$(jq -er .registry.serviceUser <<< "$input")
    [[ -d "$directory/data/$component" ]] || install -d -m 700 -o "${owner%:*}" -g "${owner#*:}" "$directory/data/$component"
    docker compose -f "$(definition)" up -d --no-deps --wait --wait-timeout 120 "$component"
    ;;
  registry-observe) observe;;
  registry-write)
    placed || die 'The registry is not placed on this host'
    lock
    jq -c .registry.body <<< "$input" | client "$(jq -er .registry.method <<< "$input")" "$(jq -er .registry.path <<< "$input")" write
    ;;
  registry-read)
    placed || die 'The registry is not placed on this host'
    client GET "$(jq -er .registry.path <<< "$input")" "$(jq -er '.registry.level // "read"' <<< "$input")"
    ;;
  *) die 'Unknown registry action';;
esac
