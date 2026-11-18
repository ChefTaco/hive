#!/usr/bin/env bash
# Cindertrace collector credentials, on the host that runs Cindertrace. Transported verbatim by
# the controller; the request is data in the JSON input, never shell code.
#   add ID SOURCES  generate a credential once into an owner-only file, allowed only SOURCES
#   add ... run     also make ID the collector the installation runs (component
#                   cindertrace-collector): its environment is written from the generated settings,
#                   its credential and the source settings in ID.sources.env beside the credential
#   list            collector IDs, their sources and credential files; never a secret
#   remove ID       revoke one (not the one the installation runs)
# Cindertrace ingests while at least one collector exists. Its environment is updated in place,
# with the initializer's record of the file and this plan's pinned deployment inputs moved to
# the new bytes, and only Cindertrace is recreated. A secret is never printed.
set -Eeuo pipefail
umask 077
read -r input
directory=$(jq -er .directory <<< "$input")
plan=$(jq -r '.plan // ""' <<< "$input")
action=$(jq -er .cindertrace.action <<< "$input")
die() { printf 'Cindertrace collectors: %s\n' "$*" >&2; exit 1; }
trap restore_installation_owner EXIT
[[ "$directory" =~ ^/[A-Za-z0-9_./-]+$ && "$directory" != *'/../'* && "$directory" != */.. && ! -L "$directory" ]] || die 'Invalid installation path'
jq -e '.placements.cindertrace!=null' <<< "$input" >/dev/null || die 'Cindertrace is not placed on this host'
config="$directory/config"
environment="$config/cindertrace.env"
store="$config/.credentials/cindertrace-collectors"
receipt="$config/.initializer/receipt.json"
compose="$directory/compose.json"
[[ -f "$environment" && ! -L "$environment" ]] || die 'The Cindertrace environment is missing; install the suite first'
(( (8#$(stat -c %a "$environment") & 077)==0 )) || die 'The Cindertrace environment must be owner-only'
[[ ! -L "$directory/controller.lock" ]] || die 'Unsafe controller lock'
exec 9>"$directory/controller.lock"
flock -n 9 || die 'Another controller holds this host'
for path in "$config/.credentials" "$store"; do
  [[ ! -L "$path" ]] || die 'Unsafe credential directory'
  install -d -m 700 -- "$path"
done
# Compose semantics: the last assignment wins; one pair of quotes is removed.
get() {
  jq -Rrs --arg key "$1" --arg sq "'" 'split("\n")|map(select(startswith($key+"="))|.[($key|length)+1:]|
    if length>1 and ((startswith("\"") and endswith("\"")) or (startswith($sq) and endswith($sq))) then .[1:-1] else . end)|last // empty' "$environment"
}
records() {
  local file
  for file in "$store"/*.json; do
    [[ -e "$file" ]] || continue
    [[ -f "$file" && ! -L "$file" ]] || die 'Unsafe collector record'
    jq -ce 'select(.schema==1 and (.id|type=="string") and (.allowedSources|type=="array"))' "$file" || die "Invalid collector record $file"
  done | jq -s 'sort_by(.id)'
}
secret_file() { printf '%s/%s\n' "$store" "$1"; }

case "$action" in
  add)
    id=$(jq -er .cindertrace.id <<< "$input")
    sources=$(jq -ce .cindertrace.sources <<< "$input")
    [[ "$id" =~ ^[a-z][a-z0-9-]{0,47}$ ]] || die 'A collector ID is lowercase letters, digits and hyphens, starting with a letter'
    jq -e 'type=="array" and length>0 and length==(unique|length) and all(.[]; IN("unifi_dns","unifi_ids","netflow","wazuh","tailscale","magnus","magnus_ui","hive","chattermost"))' <<< "$sources" >/dev/null ||
      die 'Sources are one or more of unifi_dns, unifi_ids, netflow, wazuh, tailscale, magnus, magnus_ui, hive and chattermost'
    record="$store/$id.json" secret=$(secret_file "$id")
    [[ ! -L "$record" && ! -L "$secret" && ! -L "$secret.pending" ]] || die 'Unsafe collector path'
    runs=false
    if [[ -f "$record" ]]; then
      jq -e --argjson sources "$sources" '(.allowedSources|sort)==($sources|sort)' "$record" >/dev/null ||
        die "Collector $id already exists with other sources; remove it first, which revokes its credential"
      runs=$(jq -r '.runs==true' "$record")
    fi
    if [[ $(jq -r '.cindertrace.run==true' <<< "$input") == true ]]; then
      other=$(records | jq -r --arg id "$id" '[.[]|select(.runs==true and .id!=$id)|.id][0] // empty')
      [[ -z "$other" ]] || die "Collector $other already runs in this installation; only one does"
      [[ -f "$store/$id.sources.env" && ! -L "$store/$id.sources.env" ]] || die "Write the source settings to $store/$id.sources.env (owner-only) first; see deployment/FULL.md#events-from-a-separate-logging-host"
      runs=true
    fi
    if [[ ! -f "$secret" ]]; then
      [[ -f "$secret.pending" ]] || openssl rand -hex 32 > "$secret.pending"
      sync -f "$secret.pending"; mv -T -- "$secret.pending" "$secret"
    fi
    [[ $(stat -c %a "$secret") == 600 ]] || chmod 600 -- "$secret"
    jq -n --arg id "$id" --argjson sources "$sources" --argjson runs "$runs" '{schema:1,id:$id,allowedSources:($sources|sort)} + (if $runs then {runs:true} else {} end)' > "$record.new"
    mv -T -- "$record.new" "$record";;
  remove)
    id=$(jq -er .cindertrace.id <<< "$input")
    [[ "$id" =~ ^[a-z][a-z0-9-]{0,47}$ ]] || die 'Invalid collector ID'
    [[ -f "$store/$id.json" ]] || die "No collector $id"
    ! jq -e '.runs==true' "$store/$id.json" >/dev/null || die "Collector $id runs in this installation (component cindertrace-collector); it keeps its credential while it runs"
    rm -f -- "$store/$id.json" "$(secret_file "$id")";;
  list)
    records | jq --arg store "$store" 'map({id,allowedSources,credentialFile:($store+"/"+.id)} + (if .runs==true then {runs:true,sourcesFile:($store+"/"+.id+".sources.env")} else {} end))'
    exit 0;;
  *) die 'Use: cindertrace-collector add ID --sources SOURCE[,SOURCE] | list | remove ID';;
esac

# The environment Cindertrace should have: its credential registry, and ingestion on while any
# collector exists.
all=$(records)
credentials=$(jq -c 'map({key:.id,value:{secret:"",allowedSources,displayName:.id}})|from_entries' <<< "$all")
while IFS= read -r collector; do
  value=$(cat -- "$(secret_file "$collector")")
  [[ "$value" =~ ^[0-9a-f]{64}$ ]] || die "The credential file of $collector is invalid; remove and add the collector again"
  credentials=$(jq -c --arg id "$collector" --rawfile secret "$(secret_file "$collector")" '.[$id].secret=($secret|rtrimstr("\n"))' <<< "$credentials")
done < <(jq -r '.[].id' <<< "$all")
enabled=false; [[ $(jq length <<< "$all") == 0 ]] || enabled=true
wanted=$(jq -c --arg enabled "$enabled" '{SECURITY_INGEST_ENABLED:$enabled,SECURITY_FUSION_COLLECTOR_CREDENTIALS_JSON:tojson}' <<< "$credentials")
changes='{}'
for key in SECURITY_INGEST_ENABLED SECURITY_FUSION_COLLECTOR_CREDENTIALS_JSON; do
  current=$(get "$key")
  [[ "$current" == "$(jq -r --arg key "$key" '.[$key]' <<< "$wanted")" ]] || changes=$(jq -nc --arg key "$key" 'input as $changes | input as $wanted | $changes+{($key):$wanted[$key]}' <<< "$changes"$'\n'"$wanted")
done
if [[ "$changes" != '{}' ]]; then
  # The plan's pinned deployment inputs include this environment. Move the pin only when nothing
  # else changed since it was taken.
  inputs="$directory/deployment-inputs.$plan.json" definition="$directory/candidate.$plan.json" repin=false
  [[ -f "$definition" ]] || definition=$compose
  if [[ -n "$plan" && -f "$inputs" && -f "$definition" ]] && [[ $(deployment_inputs_digest "$definition") == "$(jq -r .sha256 "$inputs")" ]]; then repin=true; fi
  keys=$(jq -r 'keys|join("|")' <<< "$changes")
  temporary=$(mktemp "$config/.cindertrace.XXXXXX")
  { grep -vE "^($keys)=" -- "$environment" || true; jq -r --arg sq "'" 'to_entries[]|.key+"="+$sq+.value+$sq' <<< "$changes"; } > "$temporary"
  chown --reference="$environment" -- "$temporary"; chmod 600 -- "$temporary"; sync -f "$temporary"; mv -T -- "$temporary" "$environment"
  if [[ -f "$receipt" && ! -L "$receipt" ]] && jq -e --arg path "$environment" '.files[$path]!=null' "$receipt" >/dev/null; then
    jq --arg path "$environment" --arg sha "$(sha256sum -- "$environment" | cut -d ' ' -f1)" '.files[$path]=$sha' "$receipt" > "$receipt.new"
    chmod 600 -- "$receipt.new"; mv -T -- "$receipt.new" "$receipt"
  fi
  if [[ "$repin" == true ]]; then
    temporary=$(mktemp "$directory/.deployment-inputs.XXXXXX")
    jq -n --arg sha "$(deployment_inputs_digest "$definition")" '{schema:1,sha256:$sha}' > "$temporary"; chmod 600 -- "$temporary"; sync -f "$temporary"; mv -T -- "$temporary" "$inputs"
  fi
  if [[ -f "$compose" ]] && jq -e '.services.cindertrace!=null' "$compose" >/dev/null; then
    docker compose -f "$compose" up -d --no-deps --force-recreate cindertrace >/dev/null 2>&1 || die 'The environment is updated, but Cindertrace did not restart; run hive.sh doctor'
    container=$(docker compose -f "$compose" ps -q cindertrace)
    for _ in $(seq 1 90); do
      [[ $(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{end}}' "$container" 2>/dev/null) == healthy ]] && break
      sleep 2
    done
    [[ $(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{end}}' "$container" 2>/dev/null) == healthy ]] || die 'Cindertrace did not become healthy with the new collectors'
  fi
fi
# The collector the installation runs (component cindertrace-collector): its environment is the
# generated settings, its credential and the reviewed source settings. Rewritten only when a value
# changes; when the component runs, only it is recreated.
running=$(records | jq -r '[.[]|select(.runs==true)|.id][0] // empty')
collector_note=''
if [[ -n "$running" ]]; then
  sources_file="$store/$running.sources.env" collector_env="$config/cindertrace-collector.env" collector_config="$config/cindertrace-collector"
  [[ -f "$sources_file" && ! -L "$sources_file" ]] || die "The source settings of $running are missing: $sources_file"
  (( (8#$(stat -c %a "$sources_file") & 077)==0 )) || die "$sources_file must be owner-only"
  settings=$(jq -Rn --arg sq "'" '[inputs|select(test("^[ \t]*(#|$)")|not)|
      if test("^[A-Z][A-Z0-9_]*=") then {key:.[:index("=")],value:.[index("=")+1:]} else error("Lines are KEY=VALUE") end|
      .value |= (if length>1 and ((startswith("\"") and endswith("\"")) or (startswith($sq) and endswith($sq))) then .[1:-1] else . end)]|from_entries' < "$sources_file") ||
    die "$sources_file has a line that is not KEY=VALUE"
  # Only source settings: the identity, credential, API and state of the collector are generated.
  jq -e 'keys-["LOKI_URL","LOKI_QUERY","LOKI_LIMIT","LOKI_READ_TOKEN","UI_SECURITY_SOURCES_JSON","CHATTERMOST_SECURITY_EXPORT_URL","CHATTERMOST_SECURITY_EXPORT_TOKEN","TAILSCALE_SECURITY_TOKEN","TAILSCALE_TAILNET","SECURITY_FUSION_MAX_RESPONSE_BYTES","SECURITY_FUSION_QUIET_AFTER_HOURS","SECURITY_FUSION_QUIET_SOURCES"]|length==0' <<< "$settings" >/dev/null ||
    die "$sources_file sets $(jq -r 'keys-["LOKI_URL","LOKI_QUERY","LOKI_LIMIT","LOKI_READ_TOKEN","UI_SECURITY_SOURCES_JSON","CHATTERMOST_SECURITY_EXPORT_URL","CHATTERMOST_SECURITY_EXPORT_TOKEN","TAILSCALE_SECURITY_TOKEN","TAILSCALE_TAILNET","SECURITY_FUSION_MAX_RESPONSE_BYTES","SECURITY_FUSION_QUIET_AFTER_HOURS","SECURITY_FUSION_QUIET_SOURCES"]|join(", ")' <<< "$settings"), which are not source settings"
  jq -e --arg sq "'" 'all(.[]; (contains($sq)|not) and length>0) and
    (if .LOKI_URL then (.LOKI_URL|test("^https://[^ ?#@]+$")) and (.LOKI_QUERY|type=="string") and ((.LOKI_READ_TOKEN // "")|length>=40) else (has("LOKI_QUERY") or has("LOKI_READ_TOKEN")|not) end) and
    (if .CHATTERMOST_SECURITY_EXPORT_URL then (.CHATTERMOST_SECURITY_EXPORT_URL|test("^https://[^ ?#@]+$")) and has("CHATTERMOST_SECURITY_EXPORT_TOKEN") else true end) and
    (if .UI_SECURITY_SOURCES_JSON then (.UI_SECURITY_SOURCES_JSON|fromjson|type=="object") and has("LOKI_URL") else true end) and
    (if .SECURITY_FUSION_QUIET_AFTER_HOURS then (.SECURITY_FUSION_QUIET_AFTER_HOURS|test("^[0-9]{1,3}(\\.[0-9]+)?$") and tonumber<=720) else true end) and
    (if .SECURITY_FUSION_QUIET_SOURCES then (.SECURITY_FUSION_QUIET_SOURCES|test("^[a-z][a-z0-9_]*(,[a-z][a-z0-9_]*)*$")) else true end)' <<< "$settings" >/dev/null 2>&1 ||
    die "$sources_file: LOKI_URL and CHATTERMOST_SECURITY_EXPORT_URL are HTTPS URLs without credentials, Loki also needs LOKI_QUERY and a LOKI_READ_TOKEN of at least 40 characters, UI_SECURITY_SOURCES_JSON is a JSON object read through Loki, SECURITY_FUSION_QUIET_AFTER_HOURS is a number of hours from 0 to 720, SECURITY_FUSION_QUIET_SOURCES is a comma-separated list of source names, and no value is empty or contains a single quote"
  [[ -d "$config/cindertrace" && -f "$config/cindertrace/authority.pem" ]] || die 'The Cindertrace configuration is missing its authority'
  wanted=$(jq -c --arg id "$running" --rawfile secret "$(secret_file "$running")" '. as $settings | {
    NODE_ENV:"production",NODE_EXTRA_CA_CERTS:"/config/authority.pem",CINDERTRACE_API_URL:"https://cindertrace:4101",
    SECURITY_FUSION_COLLECTOR_ID:$id,SECURITY_FUSION_INGEST_SECRET:($secret|rtrimstr("\n")),SECURITY_FUSION_STATE_DIR:"/data",
    SECURITY_FUSION_UDP_ENABLED:"false",TAILSCALE_LOCAL_ENABLED:"false"} + $settings' <<< "$settings")
  temporary=$(mktemp "$config/.cindertrace-collector.XXXXXX")
  jq -r --arg sq "'" 'to_entries[]|.key+"="+$sq+.value+$sq' <<< "$wanted" > "$temporary"
  collector_changed=false
  [[ ! -L "$collector_env" ]] || die 'Unsafe collector environment'
  if [[ -f "$collector_env" ]] && cmp -s -- "$temporary" "$collector_env"; then rm -f -- "$temporary"; else collector_changed=true; fi
  [[ ! -L "$collector_config" ]] || die 'Unsafe collector configuration directory'
  if [[ ! -d "$collector_config" ]]; then install -d -m 700 -- "$collector_config"; chown --reference="$config/cindertrace" -- "$collector_config"; fi
  if ! cmp -s -- "$config/cindertrace/authority.pem" "$collector_config/authority.pem"; then
    authority=$(mktemp "$collector_config/.authority.XXXXXX"); cat -- "$config/cindertrace/authority.pem" > "$authority"
    chown --reference="$config/cindertrace/authority.pem" -- "$authority"; chmod 600 -- "$authority"; mv -T -- "$authority" "$collector_config/authority.pem"
    collector_changed=true
  fi
  if [[ "$collector_changed" == true ]]; then
    inputs="$directory/deployment-inputs.$plan.json" definition="$directory/candidate.$plan.json" repin=false
    [[ -f "$definition" ]] || definition=$compose
    if [[ -n "$plan" && -f "$inputs" && -f "$definition" ]] && [[ $(deployment_inputs_digest "$definition") == "$(jq -r .sha256 "$inputs")" ]]; then repin=true; fi
    if [[ -f "$temporary" ]]; then
      chown --reference="$environment" -- "$temporary"; chmod 600 -- "$temporary"; sync -f "$temporary"; mv -T -- "$temporary" "$collector_env"
    fi
    if [[ "$repin" == true ]]; then
      temporary=$(mktemp "$directory/.deployment-inputs.XXXXXX")
      jq -n --arg sha "$(deployment_inputs_digest "$definition")" '{schema:1,sha256:$sha}' > "$temporary"; chmod 600 -- "$temporary"; sync -f "$temporary"; mv -T -- "$temporary" "$inputs"
    fi
    if [[ -f "$compose" ]] && jq -e '.services["cindertrace-collector"]!=null' "$compose" >/dev/null; then
      docker compose -f "$compose" up -d --no-deps --force-recreate cindertrace-collector >/dev/null 2>&1 || die 'The collector settings are updated, but the collector did not restart; run hive.sh doctor'
      container=$(docker compose -f "$compose" ps -q cindertrace-collector)
      for _ in $(seq 1 90); do
        [[ $(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{end}}' "$container" 2>/dev/null) == healthy ]] && break
        sleep 2
      done
      [[ $(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{end}}' "$container" 2>/dev/null) == healthy ]] || die 'The collector did not become healthy with its new settings; see docker logs of cindertrace-collector'
      collector_note="Collector $running runs in this installation with these settings."
    fi
  fi
  if [[ -z "$collector_note" ]]; then
    if [[ -f "$compose" ]] && jq -e '.services["cindertrace-collector"]!=null' "$compose" >/dev/null; then collector_note="Collector $running runs in this installation; its settings are unchanged."
    else collector_note="Collector $running is ready to run in this installation: start it with ./hive.sh add cindertrace-collector."; fi
  fi
fi
origin=$(jq -r '.origin // ""' <<< "$input")
case "$action" in
  add)
    printf 'Collector %s may send %s. Its credential is in %s (owner-only); it is never printed.\n' "$id" "$(jq -r 'join(", ")' <<< "$sources")" "$(secret_file "$id")"
    if [[ "$runs" == true ]]; then printf '%s Cindertrace ingestion is on.\n' "$collector_note"
    else printf 'Point the collector at %s with SECURITY_FUSION_COLLECTOR_ID=%s and SECURITY_FUSION_INGEST_SECRET set from that file. Cindertrace ingestion is on.\n' "${origin:-the console origin}" "$id"; fi;;
  remove)
    if [[ "$enabled" == true ]]; then printf 'Collector %s is revoked.\n' "$id"; else printf 'Collector %s is revoked. No collector is left, so Cindertrace ingestion is off.\n' "$id"; fi;;
esac
