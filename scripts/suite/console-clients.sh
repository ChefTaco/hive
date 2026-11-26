#!/usr/bin/env bash
# hive.sh console-clients: browser sign-in for the console on an existing installation, whatever
# set it up (fresh setup, migrate-native, add, or edits by hand). Two steps, both idempotent:
#   1. The settings (browser-signin-host.sh, on each host that runs Oathweave, Emberpath or the
#      console): Oathweave's browser issuer and discovery URLs and a reviewed policy for every
#      HiveXUI browser client in IAM_BROWSER_CLIENT_POLICIES, and EMBERPATH_PASSWORD_RELAY=false.
#      Only missing settings are added; keys the operator set are kept. Oathweave and Emberpath are
#      recreated when their environment changed.
#   2. The clients (console-clients-host.sh): the missing public clients in Oathweave's store, the
#      suite's existing ones marked first-party (no consent prompt) when they are not, and their
#      permissions added to the SUITE_ADMIN role, in one transaction inside the Oathweave
#      container; any other identity record that would change aborts it.
# check only reads, and exits non-zero while something is missing. add reads first and asks for
# confirmation only when something is missing. No token or credential is needed, read or printed.

# Every HiveXUI browser client of this installation's products, as fresh setup declares it. With
# the gateway's terminal grant, Magnus's client carries magnus:terminal.
hive_console_clients_reviewed() {
  jq -c '(.components["magnus-gateway"]!=null and .bootstrap.magnusGateway.grantTerminalToInitialOperator==true) as $terminal |
    (if .components.oathweave then [{id:"hivexui-oathweave",audience:"oathweave",permissions:["iam:users:read","iam:users:write","iam:users:delete","iam:roles:read","iam:roles:write","iam:sa:read","iam:sa:write","iam:sa:delete","iam:clients:read","iam:clients:write","iam:sessions:revoke","iam:audit:read","iam:system:login","iam:policy:write"],core:true}] else [] end) +
    (if .components.emberpath then [{id:"hivexui-emberpath",audience:"emberpath",permissions:["router:providers:read","router:providers:write","router:routing:read","router:routing:write","router:testing:read","router:testing:write","router:keys:read","router:keys:write","router:settings:read","router:settings:write","router:admin:read","router:admin:write"],core:true}] else [] end) +
    (if .components.hivemem then [{id:"hivexui-hivemem",audience:"hivemem",permissions:["hivemem:admin:all"],core:true}] else [] end) +
    (if .components.hiveskills then [{id:"hivexui-hiveskills",audience:"hiveskills",permissions:["hiveskills:admin"],core:true}] else [] end) +
    (if .components.chattermost then [{id:"hivexui-chattermost",audience:"chattermost",permissions:["chattermost:session"],core:true}] else [] end) +
    (if .components.magnus or .external.magnus then [{id:"hivexui-magnus",audience:"magnus",permissions:(["magnus:view","magnus:operate","magnus:admin"]+(if $terminal then ["magnus:terminal"] else [] end))}] else [] end) +
    (if .components.embermend then [{id:"hivexui-embermend",audience:"embermend",permissions:["embermend:read","embermend:evidence","embermend:assess","embermend:prepare","embermend:propose","embermend:publish-explanation","embermend:ingest","embermend:policy"]}] else [] end) +
    (if .components.cindertrace then [{id:"hivexui-cindertrace",audience:"cindertrace",permissions:["cindertrace:view","cindertrace:investigate","cindertrace:admin"]}] else [] end) +
    (if .components.ardentstudio then [{id:"hivexui-ardentstudio",audience:"ardentstudio",permissions:["ardentstudio:projects:read","ardentstudio:projects:write","ardentstudio:templates:read","ardentstudio:templates:write","ardentstudio:review:write","ardentstudio:agents:admin"]}] else [] end) +
    # The Hive Registry inventory view (Registry 1.4.0).
    (if .components["hive-registry"] then [{id:"hivexui-registry",audience:"hive-registry",permissions:["registry:inventory"],core:true}] else [] end)' "$HIVE_CONFIG"
}

# The clients step 2 creates. Fresh setup and migrate-native create the core ones (and add creates
# ChatterMost's), so those are optional here: created only while their running policy is the
# reviewed one, and otherwise skipped and named. With the gateway's terminal grant, fresh setup
# manages hivexui-magnus, which is left out.
hive_console_clients_wanted() {
  jq -c --arg redirect "$(jq -r .origin "$HIVE_CONFIG")/auth/callback" --argjson terminal "$(jq '.bootstrap.magnusGateway.grantTerminalToInitialOperator==true' "$HIVE_CONFIG")" '
    map(select(($terminal|not) or .id!="hivexui-magnus") | {id,audience,permissions} + (if .core then {optional:true} else {} end) + {redirectUris:[$redirect],firstParty:true})' <<< "$(hive_console_clients_reviewed)"
}

# The HiveXUI browser clients this suite creates for the products of this installation, fresh setup
# and this command together. They are first-party: Oathweave asks no consent for them. An owned
# client from before (a public client with this console callback) is marked first-party here.
hive_console_clients_owned() {
  hive_console_clients_reviewed | jq -c 'map(.id)'
}

# The hosts step 1 visits: Oathweave's first, whose browser issuer the others are checked against.
hive_console_clients_settings_hosts() {
  jq -r '[.components.oathweave.host, .components.emberpath.host, .console.host]|map(select(.!=null))|unique as $all|[.[0]]+($all-[.[0]])|.[]' "$HIVE_CONFIG"
}

# Step 1 on every host, in MODE (check or apply). Prints the hosts' results as one JSON array.
hive_console_clients_settings() { # MODE
  local mode=$1 host issuer request result results='[]' policies
  issuer=$(jq -r '.nativeMigration.browserIssuer // (.origin+"/api/oathweave")' "$HIVE_CONFIG")
  policies=$(hive_console_clients_reviewed | jq -c 'map({key:.id,value:{audience,permissions}})|from_entries')
  while IFS= read -r host; do
    request=$(jq -nc --arg mode "$mode" --arg issuer "$issuer" --argjson policies "$policies" '{mode:$mode,issuer:$issuer,policies:$policies}')
    result=$(HIVE_HOST_ACTION=browser-signin HIVE_BROWSER_SIGNIN_INPUT=$request hive_host "$host" "$(cat "$HIVE_ROOT/scripts/suite/ownership-host.sh" "$HIVE_ROOT/scripts/suite/input-artifacts-host.sh" "$HIVE_ROOT/scripts/suite/browser-signin-host.sh")" | grep '^{' | tail -1) ||
      { printf 'The browser sign-in settings on %s could not be %s; see the reason above.\n' "$host" "$([[ "$mode" == check ]] && printf read || printf applied)" >&2; return 1; }
    jq -e '(.changes|type=="array") and (.problems|type=="array") and (.kept|type=="array")' <<< "$result" >/dev/null 2>&1 || { printf '%s did not report its browser sign-in settings.\n' "$host" >&2; return 1; }
    issuer=$(jq -r --arg issuer "$issuer" '.issuer // $issuer' <<< "$result")
    results=$(jq -c --argjson result "$result" '.+[$result]' <<< "$results")
  done < <(hive_console_clients_settings_hosts)
  printf '%s\n' "$results"
}

# What step 1 found or did, one line each.
hive_console_clients_settings_report() { # RESULTS VERB
  jq -r --arg verb "$2" '.[] as $host | ($host.changes[] | "\($verb) in \(.file) on \($host.host): \(.keys|join(", "))" +
      (if (.policies|length)>0 then " (policies \(.policies|join(", ")))" else "" end)),
    ($host.kept[] | "Kept on \($host.host): \(.)"),
    ($host.problems[] | "Needs attention on \($host.host): \(.)")' <<< "$1"
}

hive_console_clients() {
  local subcommand=${1:-} clients host result settings settings_pending=false owned
  [[ "$subcommand" == add || "$subcommand" == check ]] || hive_die 'Use: console-clients add [--yes] | check'
  jq -e '.components.oathweave!=null and .console!=null' "$HIVE_CONFIG" >/dev/null || hive_die 'console-clients needs Oathweave and the console in this installation'
  settings=$(hive_console_clients_settings check) || hive_die 'Nothing was changed; see the reason above'
  hive_console_clients_settings_report "$settings" 'To add'
  if jq -e 'any(.[]; (.changes|length)>0)' <<< "$settings" >/dev/null; then settings_pending=true
  else printf 'Browser sign-in settings: nothing to add.\n'; fi
  if [[ "$settings_pending" == true && "$subcommand" == add ]]; then
    printf 'Hosts whose Oathweave or Emberpath settings change recreate that service; each changed file is copied to config/.browser-signin first.\n'
    if [[ "${HIVE_CONFIRMED:-false}" != true ]]; then
      [[ -t 0 ]] && hive_confirm 'Apply these settings, then add any missing browser clients?' || hive_die 'Cancelled; nothing was changed. Unattended use needs --yes'
      HIVE_CONFIRMED=true
    fi
    settings=$(hive_console_clients_settings apply) || hive_die 'The settings were not all applied; see the reason above. Repeat the command to continue'
    hive_console_clients_settings_report "$settings" 'Added' | grep '^Added' || true
    jq -r '.[]|select((.recreated|length)>0)|"Recreated on \(.host): \(.recreated|join(", ")). Previous files: \(.backup)"' <<< "$settings"
    settings_pending=false
  fi

  clients=$(hive_console_clients_wanted)
  if jq -e '.bootstrap.magnusGateway.grantTerminalToInitialOperator==true' "$HIVE_CONFIG" >/dev/null; then
    printf 'This installation grants the web terminal, so fresh setup manages hivexui-magnus; it is left as it is.\n'
  fi
  host=$(jq -r .components.oathweave.host "$HIVE_CONFIG")
  owned=$(hive_console_clients_owned)
  printf 'Oathweave on %s: create any missing public browser client among %s, and add their permissions to the SUITE_ADMIN role.\n' "$host" "$(jq -r 'map(.id)|join(", ")' <<< "$clients")"
  # Read first, so that a store that already has everything needs no confirmation: an unattended
  # post-upgrade then records the checklist item as done instead of being cancelled.
  if ! result=$(HIVE_HOST_ACTION=console-clients HIVE_CONSOLE_CLIENTS_INPUT=$clients HIVE_CONSOLE_CLIENTS_OWNED=$owned HIVE_CONSOLE_CLIENTS_CHECK=true hive_host "$host" "$(cat "$HIVE_ROOT/scripts/suite/console-clients-host.sh")"); then
    [[ "$settings_pending" != true ]] || hive_die 'The clients cannot be checked before the settings above are applied: run console-clients add'
    hive_die 'Oathweave could not be checked and was not changed; see the reason above'
  fi
  jq -e '.check==true and (.missingClients|type=="array") and (.missingPermissions|type=="array")' <<< "$result" >/dev/null || hive_die 'Oathweave did not report its browser clients'
  if jq -e '(.missingClients|length)==0 and (.missingPermissions|length)==0 and ((.notFirstParty // [])|length)==0' <<< "$result" >/dev/null; then
    printf 'Nothing to add: every client exists and SUITE_ADMIN has their permissions. Oathweave was not changed.\n'
    if [[ "$subcommand" == check ]]; then
      hive_console_clients_skipped "$result"
      ! jq -e 'any(.[]; (.problems|length)>0)' <<< "$settings" >/dev/null || hive_die 'Browser sign-in needs attention; see above'
      [[ "$settings_pending" != true ]] || hive_die 'Browser sign-in settings are missing; run console-clients add'
      return 0
    fi
    hive_console_clients_finish "$result"
    return 0
  fi
  printf 'To create: %s. To add to SUITE_ADMIN: %s.\n' \
    "$(jq -r '.missingClients|if length==0 then "none" else join(", ") end' <<< "$result")" "$(jq -r '.missingPermissions|if length==0 then "none" else join(", ") end' <<< "$result")"
  if jq -e '((.notFirstParty // [])|length)>0' <<< "$result" >/dev/null; then
    printf 'To mark first-party, so that Oathweave asks no consent for them: %s.\n' "$(jq -r '.notFirstParty|join(", ")' <<< "$result")"
  fi
  if [[ "$subcommand" == check ]]; then hive_console_clients_skipped "$result"; hive_die 'Browser clients are missing; run console-clients add'; fi
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

# Names the optional clients that were not created: without a policy in the running Oathweave, or
# with another policy than the reviewed one.
hive_console_clients_skipped() { # RESULT
  if jq -e '(.skippedClients // [])|length>0' <<< "$1" >/dev/null; then
    printf 'Skipped %s: the running Oathweave has no browser policy for it. Run console-clients add, which adds the policy to Oathweave'"'"'s environment and recreates Oathweave, then sign out of the console and in again.\n' \
      "$(jq -r '.skippedClients|join(", ")' <<< "$1")" >&2
  fi
  if jq -e '(.differentClients // [])|length>0' <<< "$1" >/dev/null; then
    printf 'Left as it is: %s, whose browser policy in the running Oathweave differs from the reviewed one (IAM_BROWSER_CLIENT_POLICIES); see deployment/FULL.md, "Browser sign-in settings".\n' \
      "$(jq -r '.differentClients|join(", ")' <<< "$1")" >&2
  fi
}

# Since every wanted client now exists, records the setup checklist item as done. Without a
# recorded checklist (a registry before 1.3.0) nothing is recorded.
hive_console_clients_finish() { # RESULT
  local checklist
  hive_console_clients_skipped "$1"
  if checklist=$(hive_checklist_recorded 2>/dev/null); then hive_checklist_settle "$checklist" oathweave-console-clients done || true; fi
}
