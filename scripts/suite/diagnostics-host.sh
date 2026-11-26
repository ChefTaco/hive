#!/usr/bin/env bash
# Host side of hive.sh logs and support-bundle. Reads only, as the SSH account, after the host
# proves it holds this installation, as status does.
set -euo pipefail
read -r input
refuse() { printf '%s\n' "$*" >&2; exit 1; }
directory=$(jq -r .directory <<< "$input")
[[ -f "$directory/installation.json" && ! -L "$directory/installation.json" ]] || refuse "No installation in $directory on this host"
[[ "$(jq -r .installation "$directory/installation.json")" == "$(jq -r .installation <<< "$input")" && "$(jq -r .host "$directory/installation.json")" == "$(jq -r .host <<< "$input")" ]] ||
  refuse "$directory on this host belongs to another installation or host"
request=$(jq -c '.diagnostics // {}' <<< "$input")
compose="$directory/compose.json"
case "$(jq -r '.action // empty' <<< "$request")" in
  logs)
    service=$(jq -r .service <<< "$request")
    [[ "$service" =~ ^[a-z][a-z0-9-]{0,47}$ ]] || refuse 'Invalid component name'
    [[ -f "$compose" && ! -L "$compose" ]] || refuse 'Nothing is deployed on this host yet'
    jq -e --arg service "$service" '.services[$service]!=null' "$compose" >/dev/null || refuse "$service is not deployed on this host"
    arguments=(logs --no-color --timestamps)
    since=$(jq -r '.since // ""' <<< "$request"); tail=$(jq -r '.tail // "200"' <<< "$request")
    [[ -z "$since" || "$since" =~ ^[0-9]+[smh]$ || "$since" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}([0-9T:Z+-]*)$ ]] || refuse 'Invalid --since'
    [[ "$tail" == all || "$tail" =~ ^[1-9][0-9]{0,5}$ ]] || refuse 'Invalid --tail'
    [[ -z "$since" ]] || arguments+=(--since "$since")
    arguments+=(--tail "$tail")
    docker compose -f "$compose" "${arguments[@]}" "$service"
    ;;
  summary)
    # Names, phases and digests only: never environment, configuration or data.
    deployed=false containers='[]' services='[]' transaction=null receipt=null formats=null
    if [[ -f "$compose" && ! -L "$compose" ]]; then
      deployed=true
      services=$(jq -c '.services|keys' "$compose")
      containers=$(docker compose -f "$compose" ps --all --format json 2>/dev/null | jq -s 'flatten|map({Service,Name,Image,State,Status,Health,ExitCode,CreatedAt,RunningFor})' 2>/dev/null) || containers='[]'
    fi
    if [[ -f "$directory/transaction.json" && ! -L "$directory/transaction.json" ]]; then
      transaction=$(jq -c '{phase,operation,version,plan,abortedStep,abortedAt}|with_entries(select(.value!=null))' "$directory/transaction.json" 2>/dev/null) || transaction='{"unreadable":true}'
    fi
    if [[ -f "$directory/receipt.json" && ! -L "$directory/receipt.json" ]]; then
      receipt=$(jq -c '{version,digest,plan,controllerSourceSHA256,controllerArchiveSHA256,deploymentInputSHA256}|with_entries(select(.value!=null))' "$directory/receipt.json" 2>/dev/null) || receipt='{"unreadable":true}'
    fi
    if [[ -f "$directory/data-formats.json" && ! -L "$directory/data-formats.json" ]]; then
      formats=$(jq -c . "$directory/data-formats.json" 2>/dev/null) || formats='{"unreadable":true}'
    fi
    backups=0
    [[ ! -d "$directory/backups" ]] || backups=$(find "$directory/backups" -mindepth 1 -maxdepth 1 -type d 2>/dev/null | wc -l)
    jq -n --arg host "$(jq -r .host <<< "$input")" --argjson deployed "$deployed" --argjson services "$services" --argjson containers "$containers" \
      --argjson transaction "$transaction" --argjson receipt "$receipt" --argjson formats "$formats" --argjson backups "$backups" \
      --arg docker "$(docker version --format '{{.Server.Version}}' 2>/dev/null || true)" --arg compose "$(docker compose version --short 2>/dev/null || true)" \
      --arg kernel "$(uname -sr)" --arg architecture "$(uname -m)" \
      --arg free "$(df -Pk -- "$directory" 2>/dev/null | awk 'NR==2 {print $4}')" \
      '{schema:1,host:$host,deployed:$deployed,services:$services,containers:$containers,transaction:$transaction,receipt:$receipt,
        dataFormats:$formats,backupDirectories:$backups,docker:$docker,compose:$compose,kernel:$kernel,architecture:$architecture,
        freeKiB:($free|tonumber? // null)}'
    ;;
  *) refuse 'Unknown diagnostics action';;
esac
