#!/usr/bin/env bash
# Runs the fleet gateway's trust CLI in its own container, transported verbatim by the
# controller. Only JSON crosses the SSH boundary, and the key store is only written here.
set -Eeuo pipefail
read -r input
directory=$(jq -er .directory <<< "$input")
die() { printf 'Magnus gateway: %s\n' "$*" >&2; exit 1; }
[[ "$directory" =~ ^/[A-Za-z0-9_./-]+$ && "$directory" != *'/../'* && "$directory" != */.. && ! -L "$directory" ]] || die 'Invalid installation path'
[[ -f "$directory/compose.json" ]] && jq -e '.services["magnus-gateway"]!=null' "$directory/compose.json" >/dev/null || die 'The fleet gateway is not deployed on this host yet; run install first'
mapfile -t arguments < <(jq -er '.magnusTrust[]' <<< "$input")
docker compose -f "$directory/compose.json" exec -T magnus-gateway magnus-fleet-gateway trust "${arguments[@]}" < /dev/null
