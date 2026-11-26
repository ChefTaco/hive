#!/usr/bin/env bash
# hive.sh console-clients: the HiveXUI browser clients of products added to an existing
# installation, in Oathweave's store. Fresh setup seeds them when it creates the store; an
# existing store (an upgraded or migrated installation) gets them here: Magnus (the component or
# an external Magnus), Cindertrace, Embermend and Ardent Project Studio. Each client's policy must already be in the
# running Oathweave's IAM_BROWSER_CLIENT_POLICIES with exactly these permissions. The command
# creates the missing public clients, marks the suite's existing ones first-party (no consent
# prompt) when they are not, and adds their permissions to the SUITE_ADMIN role, in one
# transaction inside the Oathweave container; any other identity record that would change
# aborts it. No token or credential is needed, read or printed.

# The reviewed browser clients, as fresh setup declares them.
hive_console_clients_wanted() {
  jq -c --arg redirect "$(jq -r .origin "$HIVE_CONFIG")/auth/callback" '
    (if .components.magnus or .external.magnus then [{id:"hivexui-magnus",audience:"magnus",permissions:["magnus:view","magnus:operate","magnus:admin"]}] else [] end) +
    (if .components.embermend then [{id:"hivexui-embermend",audience:"embermend",permissions:["embermend:read","embermend:evidence","embermend:assess","embermend:prepare","embermend:propose","embermend:publish-explanation","embermend:ingest","embermend:policy"]}] else [] end) +
    (if .components.cindertrace then [{id:"hivexui-cindertrace",audience:"cindertrace",permissions:["cindertrace:view","cindertrace:investigate","cindertrace:admin"]}] else [] end) +
    (if .components.ardentstudio then [{id:"hivexui-ardentstudio",audience:"ardentstudio",permissions:["ardentstudio:projects:read","ardentstudio:projects:write","ardentstudio:templates:read","ardentstudio:templates:write","ardentstudio:review:write","ardentstudio:agents:admin"]}] else [] end) +
    # The Hive Registry inventory view (Registry 1.4.0). Optional: an Oathweave set up before it
    # has no policy for this client, which the command then skips and names instead of failing.
    (if .components["hive-registry"] then [{id:"hivexui-registry",audience:"hive-registry",permissions:["registry:inventory"],optional:true}] else [] end) |
    map(.+{redirectUris:[$redirect],firstParty:true})' "$HIVE_CONFIG"
}

# The HiveXUI browser clients this suite creates for the products of this installation, fresh setup
# and this command together. They are first-party: Oathweave asks no consent for them. An owned
# client from before (a public client with this console callback) is marked first-party here.
hive_console_clients_owned() {
  jq -c '[(if .components.oathweave then "hivexui-oathweave" else empty end),
    (if .components.emberpath then "hivexui-emberpath" else empty end),
    (if .components.hivemem then "hivexui-hivemem" else empty end),
    (if .components.hiveskills then "hivexui-hiveskills" else empty end),
    (if .components["hive-registry"] then "hivexui-registry" else empty end),
    (if .components.cindertrace then "hivexui-cindertrace" else empty end),
    (if .components.chattermost then "hivexui-chattermost" else empty end),
    (if .components.magnus or .external.magnus then "hivexui-magnus" else empty end),
    (if .components.embermend then "hivexui-embermend" else empty end),
    (if .components.ardentstudio then "hivexui-ardentstudio" else empty end)]' "$HIVE_CONFIG"
}

hive_console_clients() {
  local subcommand=${1:-} clients host result
  [[ "$subcommand" == add ]] || hive_die 'Use: console-clients add [--yes]'
  jq -e '.components.oathweave!=null and .console!=null' "$HIVE_CONFIG" >/dev/null || hive_die 'console-clients needs Oathweave and the console in this installation'
  clients=$(hive_console_clients_wanted)
  # With the gateway's terminal grant, Magnus's client carries magnus:terminal; that one stays with
  # fresh setup, and this command adds only the others.
  if jq -e '.bootstrap.magnusGateway.grantTerminalToInitialOperator==true' "$HIVE_CONFIG" >/dev/null; then
    clients=$(jq -c 'map(select(.id!="hivexui-magnus"))' <<< "$clients")
    printf 'This installation grants the web terminal, so fresh setup manages hivexui-magnus; it is left as it is.\n'
  fi
  [[ "$clients" != '[]' ]] || hive_die 'No product here needs a console client from this command: it covers Magnus (the component or external), Cindertrace, Embermend, Ardent Project Studio and the Hive Registry inventory'
  host=$(jq -r .components.oathweave.host "$HIVE_CONFIG")
  printf 'Oathweave on %s: create any missing public browser client among %s, and add their permissions to the SUITE_ADMIN role.\n' "$host" "$(jq -r 'map(.id)|join(", ")' <<< "$clients")"
  # Read first, so that a store that already has everything needs no confirmation: an unattended
  # post-upgrade then records the checklist item as done instead of being cancelled.
  local owned
  owned=$(hive_console_clients_owned)
  result=$(HIVE_HOST_ACTION=console-clients HIVE_CONSOLE_CLIENTS_INPUT=$clients HIVE_CONSOLE_CLIENTS_OWNED=$owned HIVE_CONSOLE_CLIENTS_CHECK=true hive_host "$host" "$(cat "$HIVE_ROOT/scripts/suite/console-clients-host.sh")") ||
    hive_die 'Oathweave could not be checked and was not changed; see the reason above'
  jq -e '.check==true and (.missingClients|type=="array") and (.missingPermissions|type=="array")' <<< "$result" >/dev/null || hive_die 'Oathweave did not report its browser clients'
  if jq -e '(.missingClients|length)==0 and (.missingPermissions|length)==0 and ((.notFirstParty // [])|length)==0' <<< "$result" >/dev/null; then
    printf 'Nothing to add: every client exists and SUITE_ADMIN has their permissions. Oathweave was not changed.\n'
    hive_console_clients_finish "$result"
    return 0
  fi
  printf 'To create: %s. To add to SUITE_ADMIN: %s.\n' \
    "$(jq -r '.missingClients|if length==0 then "none" else join(", ") end' <<< "$result")" "$(jq -r '.missingPermissions|if length==0 then "none" else join(", ") end' <<< "$result")"
  if jq -e '((.notFirstParty // [])|length)>0' <<< "$result" >/dev/null; then
    printf 'To mark first-party, so that Oathweave asks no consent for them: %s.\n' "$(jq -r '.notFirstParty|join(", ")' <<< "$result")"
  fi
  if [[ "${HIVE_CONFIRMED:-false}" != true ]]; then
    [[ -t 0 ]] && hive_confirm 'Apply this identity change?' || hive_die 'Cancelled; nothing was changed. Unattended use needs --yes'
  fi
  result=$(HIVE_HOST_ACTION=console-clients HIVE_CONSOLE_CLIENTS_INPUT=$clients HIVE_CONSOLE_CLIENTS_OWNED=$owned hive_host "$host" "$(cat "$HIVE_ROOT/scripts/suite/console-clients-host.sh")") ||
    hive_die 'Oathweave was not changed; see the reason above'
  jq -e '.existingRecordsUnchanged==true' <<< "$result" >/dev/null || hive_die 'Oathweave did not confirm the change'
  printf 'Created clients: %s. Added to SUITE_ADMIN: %s. Marked first-party: %s. Sign out of the console and in again to use them.\n' \
    "$(jq -r '.createdClients|if length==0 then "none" else join(", ") end' <<< "$result")" "$(jq -r '.addedPermissions|if length==0 then "none" else join(", ") end' <<< "$result")" \
    "$(jq -r '(.firstPartyClients // [])|if length==0 then "none" else join(", ") end' <<< "$result")"
  hive_console_clients_finish "$result"
}

# Names the optional clients that were skipped and, since every wanted client now exists, records
# the setup checklist item as done. Without a recorded checklist (a registry before 1.3.0) nothing
# is recorded.
hive_console_clients_finish() { # RESULT
  local checklist
  if jq -e '(.skippedClients // [])|length>0' <<< "$1" >/dev/null; then
    printf 'Skipped %s: the running Oathweave has no browser policy for it. To use the Installed software view, add it to IAM_BROWSER_CLIENT_POLICIES in config/oathweave.env, recreate Oathweave and run this command again; see deployment/FULL.md, "Hive Registry inventory".\n' \
      "$(jq -r '.skippedClients|join(", ")' <<< "$1")" >&2
  fi
  if checklist=$(hive_checklist_recorded 2>/dev/null); then hive_checklist_settle "$checklist" oathweave-console-clients done || true; fi
}
