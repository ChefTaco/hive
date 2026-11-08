#!/usr/bin/env bash
# hive.sh console-clients: the HiveXUI browser clients of products added to an existing
# installation, in Oathweave's store. Fresh setup seeds them when it creates the store; an
# existing store (an upgraded or migrated installation) gets them here: Magnus (the component or
# an external Magnus) and Ardent Project Studio. Each client's policy must already be in the
# running Oathweave's IAM_BROWSER_CLIENT_POLICIES with exactly these permissions. The command
# creates the missing public clients and adds their permissions to the SUITE_ADMIN role, in one
# transaction inside the Oathweave container; any other identity record that would change
# aborts it. No token or credential is needed, read or printed.

# The reviewed browser clients, as fresh setup declares them.
hive_console_clients_wanted() {
  jq -c --arg redirect "$(jq -r .origin "$HIVE_CONFIG")/auth/callback" '
    (if .components.magnus or .external.magnus then [{id:"hivexui-magnus",audience:"magnus",permissions:["magnus:view","magnus:operate","magnus:admin"]}] else [] end) +
    (if .components.ardentstudio then [{id:"hivexui-ardentstudio",audience:"ardentstudio",permissions:["ardentstudio:projects:read","ardentstudio:projects:write","ardentstudio:templates:read","ardentstudio:templates:write","ardentstudio:review:write","ardentstudio:agents:admin"]}] else [] end) |
    map(.+{redirectUris:[$redirect],firstParty:true})' "$HIVE_CONFIG"
}

hive_console_clients() {
  local subcommand=${1:-} clients host result
  [[ "$subcommand" == add ]] || hive_die 'Use: console-clients add [--yes]'
  jq -e '.components.oathweave!=null and .console!=null' "$HIVE_CONFIG" >/dev/null || hive_die 'console-clients needs Oathweave and the console in this installation'
  # With the gateway's terminal grant, Magnus's client carries magnus:terminal; that stays with fresh setup.
  ! jq -e '.bootstrap.magnusGateway.grantTerminalToInitialOperator==true' "$HIVE_CONFIG" >/dev/null || hive_die 'This installation grants the web terminal; its Magnus client is managed by fresh setup'
  clients=$(hive_console_clients_wanted)
  [[ "$clients" != '[]' ]] || hive_die 'No product here needs a console client from this command: it covers Magnus (the component or external) and Ardent Project Studio'
  host=$(jq -r .components.oathweave.host "$HIVE_CONFIG")
  printf 'Oathweave on %s: create any missing public browser client among %s, and add their permissions to the SUITE_ADMIN role.\n' "$host" "$(jq -r 'map(.id)|join(", ")' <<< "$clients")"
  if [[ "${HIVE_CONFIRMED:-false}" != true ]]; then
    local answer=''
    [[ -t 0 ]] && read -r -p 'Apply this identity change? [y/N] ' answer
    [[ "$answer" == y || "$answer" == yes ]] || hive_die 'Cancelled; nothing was changed. Unattended use needs --yes'
  fi
  result=$(HIVE_HOST_ACTION=console-clients HIVE_CONSOLE_CLIENTS_INPUT=$clients hive_host "$host" "$(cat "$HIVE_ROOT/scripts/suite/console-clients-host.sh")") ||
    hive_die 'Oathweave was not changed; see the reason above'
  jq -e '.existingRecordsUnchanged==true' <<< "$result" >/dev/null || hive_die 'Oathweave did not confirm the change'
  printf 'Created clients: %s. Added to SUITE_ADMIN: %s. Sign out of the console and in again to use them.\n' \
    "$(jq -r '.createdClients|if length==0 then "none" else join(", ") end' <<< "$result")" "$(jq -r '.addedPermissions|if length==0 then "none" else join(", ") end' <<< "$result")"
}
