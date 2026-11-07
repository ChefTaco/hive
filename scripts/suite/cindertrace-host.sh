#!/usr/bin/env bash
# Cindertrace collector credentials, on the host that runs Cindertrace. Transported verbatim by
# the controller; the request is data in the JSON input, never shell code.
#   add ID SOURCES  generate a credential once into an owner-only file, allowed only SOURCES
#   list            collector IDs, their sources and credential files; never a secret
#   remove ID       revoke one
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
    jq -e 'type=="array" and length>0 and length==(unique|length) and all(.[]; IN("unifi_dns","unifi_ids","netflow","wazuh","tailscale","magnus","hive","chattermost"))' <<< "$sources" >/dev/null ||
      die 'Sources are one or more of unifi_dns, unifi_ids, netflow, wazuh, tailscale, magnus, hive and chattermost'
    record="$store/$id.json" secret=$(secret_file "$id")
    [[ ! -L "$record" && ! -L "$secret" && ! -L "$secret.pending" ]] || die 'Unsafe collector path'
    if [[ -f "$record" ]]; then
      jq -e --argjson sources "$sources" '(.allowedSources|sort)==($sources|sort)' "$record" >/dev/null ||
        die "Collector $id already exists with other sources; remove it first, which revokes its credential"
    fi
    if [[ ! -f "$secret" ]]; then
      [[ -f "$secret.pending" ]] || openssl rand -hex 32 > "$secret.pending"
      sync -f "$secret.pending"; mv -T -- "$secret.pending" "$secret"
    fi
    [[ $(stat -c %a "$secret") == 600 ]] || chmod 600 -- "$secret"
    jq -n --arg id "$id" --argjson sources "$sources" '{schema:1,id:$id,allowedSources:($sources|sort)}' > "$record.new"
    mv -T -- "$record.new" "$record";;
  remove)
    id=$(jq -er .cindertrace.id <<< "$input")
    [[ "$id" =~ ^[a-z][a-z0-9-]{0,47}$ ]] || die 'Invalid collector ID'
    [[ -f "$store/$id.json" ]] || die "No collector $id"
    rm -f -- "$store/$id.json" "$(secret_file "$id")";;
  list)
    records | jq --arg store "$store" 'map({id,allowedSources,credentialFile:($store+"/"+.id)})'
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
origin=$(jq -r '.origin // ""' <<< "$input")
case "$action" in
  add)
    printf 'Collector %s may send %s. Its credential is in %s (owner-only); it is never printed.\n' "$id" "$(jq -r 'join(", ")' <<< "$sources")" "$(secret_file "$id")"
    printf 'Point the collector at %s with SECURITY_FUSION_COLLECTOR_ID=%s and SECURITY_FUSION_INGEST_SECRET set from that file. Cindertrace ingestion is on.\n' "${origin:-the console origin}" "$id";;
  remove)
    if [[ "$enabled" == true ]]; then printf 'Collector %s is revoked.\n' "$id"; else printf 'Collector %s is revoked. No collector is left, so Cindertrace ingestion is off.\n' "$id"; fi;;
esac
