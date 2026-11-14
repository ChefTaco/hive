#!/usr/bin/env bash
# The first-run setup checklist: steps after an install or upgrade that still need a person.
# The controller decides the items from the installation configuration and records them in the
# Hive Registry with the install or upgrade sync. hive.sh post-upgrade marks the items it
# completes, hive.sh setup done|skip ID settles one by hand, and hive.sh status lists what is
# pending. HiveXUI shows the list to administrators and never writes it.
#
# Item ids are fixed. Each has a scope: a "release" item is due again after every upgrade to
# another release once it was done (a skipped one stays skipped); an "installation" item is
# settled once. Registries before 1.3.0 do not know the checklist, so nothing is sent to them.

hive_checklist_certificate_unit=${HIVE_CERTIFICATE_UNIT:-/etc/systemd/system/hive-console-certificate.service}

# The release's registry records the checklist from version 1.3.0.
hive_checklist_supported() {
  jq -e '(.components["hive-registry"].version // "0") | split("-")[0] | split(".") | map(tonumber? // 0) | (.[0] // 0) > 1 or ((.[0] // 0) == 1 and (.[1] // 0) >= 3)' "$HIVE_MANIFEST" >/dev/null 2>&1
}

# The certificate renewal timer can be seen only on the console host, where this controller runs
# for a local console. Prints true, false, or null when it cannot tell.
hive_checklist_certificate_scheduled() {
  if jq -e '.bootstrap!=null and .console!=null and .hosts[.console.host].target=="local"' "$HIVE_CONFIG" >/dev/null; then
    if [[ -e "$hive_checklist_certificate_unit" || -L "$hive_checklist_certificate_unit" ]]; then printf 'true\n'; else printf 'false\n'; fi
  else printf 'null\n'; fi
}

# Magnus node keys after an upgrade: absent (the release pins a Magnus before 3.0.0, or the
# installation runs no Magnus of its own), ready (Magnus's fleet summary has no blockers), blocked,
# or unknown (Magnus did not answer).
hive_checklist_node_keys() {
  local summary
  if ! jq -e '.components.magnus!=null' "$HIVE_CONFIG" >/dev/null || ! hive_magnus_node_keys_only; then printf 'absent\n'; return; fi
  if ! summary=$(hive_magnus_node_summary 2>/dev/null) || ! jq -e '.supported==true' <<< "$summary" >/dev/null 2>&1; then printf 'unknown\n'; return; fi
  if jq -e '.enforceReady==true' <<< "$summary" >/dev/null; then printf 'ready\n'; else printf 'blocked\n'; fi
}

# The checklist for OPERATION (install or upgrade), merged with the recorded items PREVIOUS
# (a JSON array, or null) that the registry kept for release PREVIOUS_RELEASE. Pure: it reads
# only the configuration. Prints the items as a JSON array. NODE_KEYS is what
# hive_checklist_node_keys found (absent when not given).
hive_checklist_items() {
  local operation=$1 previous=${2:-null} previous_release=${3:-} certificate=${4:-null} node_keys=${5:-absent}
  jq -c --arg operation "$operation" --argjson previous "$previous" --arg previousRelease "$previous_release" --arg release "${HIVE_VERSION:-}" \
    --argjson certificate "$certificate" --arg nodeKeys "$node_keys" '
    . as $c |
    def item($id; $title; $command; $docs; $extra; $scope; $when): {item:({id:$id,title:$title,status:"pending",command:$command,docs:$docs}+$extra),scope:$scope,when:$when,detected:null};
    ($c.components.magnus!=null) as $magnus |
    ([$c.console.nativeListeners // [] | .[] | select(.component=="magnus")]|length>0) as $agentPort |
    ($c.components.oathweave!=null and $c.console!=null) as $identity |
    ($c.bootstrap!=null and $c.console!=null and $c.hosts[$c.console.host].target=="local") as $localConsole |
    [
      # The Magnus host agent: post-upgrade installs or upgrades it to the release pin.
      (if $magnus and $agentPort then item("magnus-agent-enrolled"; "Install the Magnus agent on the Magnus host"; "./hive.sh magnus-agent install";
        "deployment/FULL.md#installing-the-agent"; {product:"magnus",check:"magnus.agent"}; "release"; ["install","upgrade"]) else empty end),
      # Magnus 3.0.0 or later accepts node keys only: its fleet summary must list no blockers.
      (if $nodeKeys!="absent" then item("magnus-node-keys"; "Give every Magnus agent its own node key (no blockers in the Magnus fleet summary)"; "./hive.sh post-upgrade";
        "UPGRADING.md#magnus-300-node-keys-only"; {product:"magnus"}; "release"; ["upgrade"]) + {detected:(if $nodeKeys=="ready" then true elif $nodeKeys=="blocked" then false else null end)} else empty end),
      # HiveXUI browser clients of products added to an existing Oathweave store. Fresh setup seeds them.
      (if $identity and ($c.bootstrap.magnusGateway.grantTerminalToInitialOperator != true) and ($magnus or $c.external.magnus!=null or $c.components.embermend!=null or $c.components.ardentstudio!=null)
        then item("oathweave-console-clients"; "Add the HiveXUI browser clients to Oathweave"; "./hive.sh console-clients add";
        "deployment/QUICKSTART.md#8-upgrade"; {product:"oathweave",check:"oathweave.console-client"}; "release"; ["upgrade"]) else empty end),
      # Ardent packages are updated in HiveXUI; the operator confirms it.
      (if $magnus or $c.external.magnus!=null then item("ardent-packages-updated"; "Update the Ardent packages in HiveXUI (Magnus > Ardent > Installations)";
        "./hive.sh setup done ardent-packages-updated"; "deployment/QUICKSTART.md#8-upgrade"; {product:"magnus"}; "release"; ["upgrade"]) else empty end),
      # A certificate renewal timer on a local console host.
      (if $localConsole then item("certificate-renewal"; "Schedule the HTTPS certificate renewal"; "sudo ./scripts/console-certificate.sh schedule --config FILE";
        "deployment/QUICKSTART.md#9-keep-the-certificate-current"; {product:"ingress"}; "installation"; ["install","upgrade"]) + {detected:$certificate} else empty end),
      # Fresh setup signs in as the generated initial operator; a person creates their own administrator.
      (if $c.bootstrap!=null and $c.components.oathweave!=null then item("first-admin"; "Create your own administrator account and stop using the initial operator";
        "./hive.sh setup done first-admin"; "deployment/QUICKSTART.md#6-sign-in"; {product:"oathweave",check:"iam.first-admin"}; "installation"; ["install"]) else empty end)
    ] as $candidates |
    ["magnus-agent-enrolled","magnus-node-keys","oathweave-console-clients","ardent-packages-updated","certificate-renewal","first-admin"] as $known |
    (($previous // [])|map({key:.id,value:.})|from_entries) as $old |
    ($previousRelease != "" and $previousRelease != $release) as $newRelease |
    [ $candidates[] | . as $candidate | $old[$candidate.item.id] as $recorded |
      (if $recorded then
         (if $candidate.scope=="release" and $newRelease and $recorded.status=="done" then "pending" else $recorded.status end)
       elif ($candidate.when|index($operation)) then "pending"
       else null end) as $status |
      select($status!=null) |
      $candidate.item + {status:(if $status=="pending" and $candidate.detected==true then "done" else $status end)} ] +
    # Items a newer controller recorded stay as they are.
    [ ($previous // [])[] | select(.id as $id | $known|index($id)|not) ]' "$HIVE_CONFIG"
}

# Before the install or upgrade sync: reads what the registry recorded and decides the new list
# into HIVE_CHECKLIST. Left empty, the sync carries no checklist and the recorded one is kept.
hive_checklist_prepare() {
  HIVE_CHECKLIST=''
  case "${HIVE_OPERATION:-}" in install|upgrade) ;; *) return 0;; esac
  hive_checklist_supported || return 0
  local current
  if ! current=$(hive_registry_action "$(hive_registry_host)" registry-read '{"path":"/v1/installation"}' 2>/dev/null) || ! jq -e 'type=="object"' <<< "$current" >/dev/null 2>&1; then
    printf 'Hive: the setup checklist was not updated, because the registry did not answer; run post-upgrade later to record it.\n' >&2
    return 0
  fi
  HIVE_CHECKLIST=$(hive_checklist_items "$HIVE_OPERATION" "$(jq -c '.setup.items // null' <<< "$current")" "$(jq -r '.release.version // ""' <<< "$current")" "$(hive_checklist_certificate_scheduled)" "$(if [[ "$HIVE_OPERATION" == upgrade ]]; then hive_checklist_node_keys; else printf 'absent\n'; fi)")
}

# The recorded checklist items as a JSON array, or nothing when the registry has none or did not answer.
hive_checklist_recorded() {
  local current
  hive_registry_placed || return 1
  current=$(hive_registry_action "$(hive_registry_host)" registry-read '{"path":"/v1/installation"}' 2>/dev/null) || return 1
  jq -ce '.setup.items // empty' <<< "$current" 2>/dev/null
}

# Records STATUS for item ID when RECORDED (a JSON array) holds it with another status.
hive_checklist_settle() {
  local recorded=$1 id=$2 status=$3
  jq -e --arg id "$id" --arg status "$status" 'any(.[]; .id==$id and .status!=$status)' <<< "$recorded" >/dev/null 2>&1 || return 0
  hive_registry_write PUT "/v1/setup/items/$id" "$(jq -nc --arg status "$status" '{status:$status}')" >/dev/null ||
    { printf 'Hive: could not record %s as %s in the setup checklist\n' "$id" "$status" >&2; return 1; }
}

# Prints the pending items of ITEMS (a JSON array) for the operator.
hive_checklist_print_pending() {
  local items=${1:-[]}
  jq -e 'map(select(.status=="pending"))|length>0' <<< "$items" >/dev/null 2>&1 || return 0
  jq -r 'map(select(.status=="pending")) as $pending |
    "Setup checklist: \($pending|length) pending (settle one by hand with ./hive.sh setup done ID or ./hive.sh setup skip ID):",
    ($pending[]|"  - \(.id): \(.title)\n      \(.command)\n      See \(.docs)")' <<< "$items"
}

# After an install or upgrade: what is left, from the list this command recorded.
hive_checklist_report() {
  [[ -n "${HIVE_CHECKLIST:-}" ]] || return 0
  printf '\n'
  hive_checklist_print_pending "$HIVE_CHECKLIST"
}

# hive.sh setup [list] | setup done ID | setup skip ID
hive_checklist_command() {
  local subcommand=${1:-list} id=${2:-} recorded status
  hive_registry_placed || hive_die "$hive_registry_missing_message"
  case "$subcommand" in
    list)
      recorded=$(hive_checklist_recorded) || hive_die 'This installation has no setup checklist: its Hive Registry is older than 1.3.0, or did not answer. Check hive.sh status'
      jq -r '.[]|"\(.status)\t\(.id)\t\(.title)\t\(.command)"' <<< "$recorded"
      return;;
    done) status=done;;
    skip) status=skipped;;
    *) hive_die 'Use: setup [list] | setup done ID | setup skip ID';;
  esac
  [[ "$id" =~ ^[a-z][a-z0-9-]{0,63}$ ]] || hive_die "setup $subcommand needs an item ID; hive.sh setup list shows them"
  recorded=$(hive_checklist_recorded) || hive_die 'This installation has no setup checklist: its Hive Registry is older than 1.3.0, or did not answer. Check hive.sh status'
  jq -e --arg id "$id" 'any(.[]; .id==$id)' <<< "$recorded" >/dev/null || hive_die "No setup item $id is recorded; hive.sh setup list shows them"
  hive_registry_write PUT "/v1/setup/items/$id" "$(jq -nc --arg status "$status" '{status:$status}')" >/dev/null || hive_die 'The registry did not record the change; check hive.sh status'
  printf 'Recorded setup item %s as %s.\n' "$id" "$status"
}
