#!/usr/bin/env bash
# Host side of hive.sh uninstall and remove, transported verbatim by the controller
# (scripts/suite/uninstall.sh). Each action runs under the controller lock, with no transaction
# open, after the host proves it holds this installation.
#   uninstall-stop     stops and removes the installation's containers (docker compose down);
#                      data, configuration and backups stay, and uninstalled.json records it
#   uninstall-purge    the same, then deletes the installation directory with everything in it
#   remove-component   stops and removes the containers of the named components; their data stays
set -Eeuo pipefail
read -r input
die() { printf 'Hive host: %s\n' "$*" >&2; exit 1; }
directory=$(jq -er .directory <<< "$input")
installation=$(jq -er .installation <<< "$input")
host=$(jq -er .host <<< "$input")
action=$(jq -er .action <<< "$input")
[[ "$directory" =~ ^/[A-Za-z0-9_./-]+$ && "$directory" != *'/../'* && "$directory" != */.. && ${#directory} -gt 4 && ! -L "$directory" && "$directory" == "$(realpath -m -- "$directory")" ]] || die 'Invalid installation path'
[[ "$installation" =~ ^[a-z][a-z0-9-]{0,47}$ && "$host" =~ ^[a-z][a-z0-9-]{0,47}$ ]] || die 'Invalid installation identity'
if [[ ! -e "$directory" ]]; then
  [[ "$action" != remove-component ]] || die "There is no installation directory $directory on this host"
  jq -nc --arg host "$host" '{host:$host,absent:true}'; exit 0
fi
[[ -f "$directory/installation.json" && ! -L "$directory/installation.json" ]] || die "$directory holds no installation; nothing was changed"
jq -e --arg id "$installation" --arg host "$host" '.installation==$id and .host==$host' "$directory/installation.json" >/dev/null || die "$directory belongs to another installation or host; nothing was changed"
[[ ! -L "$directory/controller.lock" ]] || die 'Unsafe controller lock'
exec 9>"$directory/controller.lock"
flock -n 9 || die 'Another controller holds this host; nothing was changed'
if [[ -f "$directory/transaction.json" ]]; then
  phase=$(jq -r '.phase // "none"' "$directory/transaction.json" 2>/dev/null || printf 'unreadable\n')
  [[ "$phase" == complete || "$phase" == aborted ]] || die "The transaction is in phase $phase: finish or recover it first; nothing was changed"
fi
compose="$directory/compose.json"
down() { # [EXTRA ARGUMENTS...]
  [[ -f "$compose" && ! -L "$compose" ]] || return 0
  docker compose -f "$compose" down --remove-orphans "$@"
}
case "$action" in
  uninstall-stop)
    down
    jq -n --arg at "$(date -u +%FT%TZ)" --arg release "$(jq -r '.version // ""' "$directory/receipt.json" 2>/dev/null || true)" \
      '{schema:1,at:$at,release:$release,containersRemoved:true,dataKept:true}' > "$directory/uninstalled.json.tmp"
    chmod 600 "$directory/uninstalled.json.tmp"; mv -T -- "$directory/uninstalled.json.tmp" "$directory/uninstalled.json"
    jq -nc --arg host "$host" '{host:$host,stopped:true}'
    ;;
  uninstall-purge)
    [[ $(jq -r '.uninstall.confirmed // ""' <<< "$input") == "$installation" ]] || die 'The purge was not confirmed with the installation name; nothing was deleted'
    down --volumes
    exec 9>&-
    rm -rf --one-file-system -- "$directory"
    [[ ! -e "$directory" ]] || die "$directory could not be deleted completely; review it"
    jq -nc --arg host "$host" '{host:$host,purged:true}'
    ;;
  remove-component)
    [[ -f "$compose" && ! -L "$compose" ]] || die 'Nothing is deployed on this host'
    mapfile -t services < <(jq -r '.uninstall.components[]?' <<< "$input")
    ((${#services[@]})) || die 'No component to remove'
    for service in "${services[@]}"; do
      [[ "$service" =~ ^[a-z][a-z0-9-]{0,47}$ ]] || die 'Invalid component name'
      jq -e --arg service "$service" '.services[$service]!=null' "$compose" >/dev/null || continue
      docker compose -f "$compose" rm --stop --force -- "$service"
    done
    jq -nc --arg host "$host" --argjson services "$(printf '%s\n' "${services[@]}" | jq -R . | jq -sc .)" '{host:$host,removed:$services}'
    ;;
  *) die 'Unknown uninstall action';;
esac
