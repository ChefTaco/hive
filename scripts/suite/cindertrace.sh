#!/usr/bin/env bash
# hive.sh cindertrace-collector add ID --sources SOURCE[,SOURCE] | list | remove ID
# Provisions the credentials Cindertrace collectors sign their events with, on the host that
# runs Cindertrace. A credential is generated there into an owner-only file and never printed
# or passed as an argument. Cindertrace ingests while at least one collector exists.
hive_cindertrace_collector() {
  local subcommand=${1:-} id=${2:-} request host
  jq -e '.components.cindertrace!=null' "$HIVE_CONFIG" >/dev/null || hive_die 'This installation has no Cindertrace'
  case "$subcommand" in
    add)
      (($# == 2)) && [[ -n "$HIVE_CINDERTRACE_SOURCES" ]] || hive_die 'Use: cindertrace-collector add ID --sources SOURCE[,SOURCE] --config FILE'
      request=$(jq -nc --arg id "$id" --arg sources "$HIVE_CINDERTRACE_SOURCES" '{action:"add",id:$id,sources:($sources|split(",")|map(gsub("^ +| +$";"")))}');;
    remove)
      (($# == 2)) && [[ -z "$HIVE_CINDERTRACE_SOURCES" ]] || hive_die 'Use: cindertrace-collector remove ID --config FILE'
      request=$(jq -nc --arg id "$id" '{action:"remove",id:$id}');;
    list)
      (($# == 1)) && [[ -z "$HIVE_CINDERTRACE_SOURCES" ]] || hive_die 'Use: cindertrace-collector list --config FILE'
      request='{"action":"list"}';;
    *) hive_die 'Use: cindertrace-collector add ID --sources SOURCE[,SOURCE] | list | remove ID';;
  esac
  [[ "$subcommand" == list || "$id" =~ ^[a-z][a-z0-9-]{0,47}$ ]] || hive_die 'A collector ID is lowercase letters, digits and hyphens, starting with a letter'
  host=$(jq -r .components.cindertrace.host "$HIVE_CONFIG")
  HIVE_HOST_ACTION=cindertrace-collector HIVE_CINDERTRACE_INPUT=$request \
    hive_host "$host" "$(cat "$HIVE_ROOT/scripts/suite/input-artifacts-host.sh" "$HIVE_ROOT/scripts/suite/cindertrace-host.sh")" ||
    hive_die 'The Cindertrace collector change failed; see the reason above'
}
