#!/usr/bin/env bash
# Guided administrator access. Hosts own durable publication and product-owned account APIs.
hive_admin_access_action() {
  local host=$1 mode=$2 body=${3:-'{}'} target script request
  request=$(jq -c --arg mode "$mode" --arg identityScript "$(base64 -w0 "$HIVE_ROOT/scripts/suite/admin-access-identity.mjs")" \
    --arg dataScript "$(base64 -w0 "$HIVE_ROOT/scripts/suite/admin-access-data.mjs")" --arg nativeScript "$(base64 -w0 "$HIVE_ROOT/scripts/suite/admin-access-native.mjs")" \
    --argjson expected "$(jq -c '.components|map_values(.image)' "$HIVE_MANIFEST")" \
    '.+{mode:$mode,scripts:{identity:$identityScript,data:$dataScript,native:$nativeScript},expectedImages:$expected}' <<< "$body") || hive_die 'Could not prepare the administrator request'
  script=$(cat "$HIVE_ROOT/scripts/suite/ownership-host.sh" "$HIVE_ROOT/scripts/suite/input-artifacts-host.sh" "$HIVE_ROOT/scripts/suite/admin-access-files-host.sh" "$HIVE_ROOT/scripts/suite/admin-access-host.sh")
  target=$(jq -r --arg host "$host" '.hosts[$host].target' "$HIVE_CONFIG")
  local HIVE_HOST_SUDO_FILE=${HIVE_ADMIN_ACCESS_SUDO_FILE:-${HIVE_HOST_SUDO_FILE:-}}
  if [[ "$target" == local && $(id -u) != 0 ]]; then
    HIVE_HOST_LOCAL_SUDO=true HIVE_HOST_ACTION=admin-access HIVE_ADMIN_ACCESS_INPUT=$request hive_host "$host" "$script"
  else
    HIVE_HOST_REMOTE_SUDO=true HIVE_HOST_ACTION=admin-access HIVE_ADMIN_ACCESS_INPUT=$request hive_host "$host" "$script"
  fi
}
hive_admin_access_uuid() {
  local random
  random=$(openssl rand -hex 16)
  printf '%s-%s-4%s-8%s-%s\n' "${random:0:8}" "${random:8:4}" "${random:13:3}" "${random:17:3}" "${random:20:12}"
}
hive_admin_access() (
  set -Eeuo pipefail
  umask 077
  local command=${1:-setup} username=${2:-} identity_host account administrators index=1 choice identity request inspection state environments='{}' host result plan native_receipts='{}' host_identities='{}' component local_ids='{}' operation_id expected_subject terminal_included resolve_mode=resolve
  local -a hosts=() products=()
  (($#<=2)) || hive_die 'Use: admin-access setup|status USERNAME | list'
  case "$command" in setup|status|list) ;; *) hive_die 'Use: admin-access setup|status USERNAME | list';; esac
  jq -e '.components.oathweave!=null and .console!=null and .bootstrap!=null' "$HIVE_CONFIG" >/dev/null || hive_die 'Guided administrator access needs a suite-managed Oathweave console and its installation records'
  jq -e '.external.magnus==null' "$HIVE_CONFIG" >/dev/null || hive_die 'Guided access cannot change an external Magnus without its owning host; use a suite-managed Magnus for this flow'
  identity_host=$(jq -er .components.oathweave.host "$HIVE_CONFIG")
  if [[ "$command" == list || -z "$username" ]]; then
    administrators=$(hive_admin_access_action "$identity_host" list)
    if [[ "$command" == list ]]; then jq -r '.administrators[]|[.username,.email,.subject]|@tsv' <<< "$administrators"; return; fi
    [[ "$command" == setup && "${HIVE_ADMIN_ACCESS_INTERACTIVE:-true}" == true && -t 0 ]] || hive_die 'Choose an exact account with admin-access setup USERNAME, or list administrators with admin-access list'
    administrators=$(jq -c --arg initial "$(jq -r .bootstrap.adminUsername "$HIVE_CONFIG")" '.administrators|map(select(.username!=$initial))' <<< "$administrators")
    [[ $(jq length <<< "$administrators") != 0 ]] || hive_die 'Create your administrator in Oathweave > Users first, then run ./hive.sh admin-access setup'
    printf 'Administrators:\n'
    while IFS= read -r account; do printf '  %d) %s (%s)\n' "$index" "$(jq -r .username <<< "$account")" "$(jq -r .email <<< "$account")"; index=$((index+1)); done < <(jq -c '.[]' <<< "$administrators")
    read -r -p 'Administrator number: ' choice
    [[ "$choice" =~ ^[1-9][0-9]*$ ]] && ((choice<index)) || hive_die 'No administrator selected'
    username=$(jq -er --argjson index "$((choice-1))" '.[$index].username' <<< "$administrators")
  fi
  [[ "$username" != "$(jq -r .bootstrap.adminUsername "$HIVE_CONFIG")" ]] || hive_die 'The initial operator already has product access. Choose your new administrator'
  request=$(jq -nc --arg username "$username" '{username:$username}')
  [[ "$command" != status ]] || resolve_mode=status
  account=$(hive_admin_access_action "$identity_host" "$resolve_mode" "$request") || hive_die 'The exact administrator account could not be resolved; setup needs an active, unlocked account. Retained receipts are preserved'
  identity=$(jq -ce .identity <<< "$account"); terminal_included=$(jq -r '.terminalPermissionAfterSetup // false' <<< "$account")
  request=$(jq -nc --arg username "$username" --argjson identity "$identity" '{username:$username,identity:$identity}')
  mapfile -t products < <(jq -r '.components|keys[]|select(IN("emberpath","hivemem","hiveskills","magnus","magnus-gateway","cindertrace","chattermost","embermend","embermend-worker","ardentstudio"))' "$HIVE_CONFIG")
  ((${#products[@]})) || hive_die 'This installation has no product access to configure'
  mapfile -t hosts < <(jq -r '[.components|to_entries[]|select(.key|IN("oathweave","emberpath","hivemem","hiveskills","magnus","magnus-gateway","cindertrace","chattermost","embermend","embermend-worker","ardentstudio"))|.value.host]|unique[]' "$HIVE_CONFIG")
  inspection=$(hive_admin_access_action "$identity_host" inspect "$request")
  state=$(jq -c .state <<< "$inspection")
  if [[ "$command" == status ]]; then
    jq -n --argjson identity "$identity" --argjson state "$state" --argjson eligible "$(jq -c 'if has("eligible") then .eligible else true end' <<< "$account")" '{identity:$identity,setup:$state,eligible:$eligible}'
    return
  fi
  if [[ "$state" != null ]]; then
    jq -e --argjson identity "$identity" '.identity==$identity' <<< "$state" >/dev/null || hive_die 'The account changed since its retained operation; preserve the receipt and review the identity change'
    request=$(jq -c --argjson state "$state" '.+{state:$state}' <<< "$request")
    printf 'Following retained access operation %s.\n' "$(jq -r .operationId <<< "$state")"
    for host in "${hosts[@]}"; do hive_admin_access_action "$host" recover "$request" >/dev/null; done
  else
    operation_id=$(hive_admin_access_uuid)
    for component in emberpath hivemem hiveskills magnus cindertrace chattermost ardentstudio; do
      if jq -e --arg component "$component" '.components[$component]!=null' "$HIVE_CONFIG" >/dev/null; then local_ids=$(jq -c --arg component "$component" --arg id "$(openssl rand -hex 13)" '.+{($component):$id}' <<< "$local_ids"); fi
    done
    state=$(jq -nc --arg installation "$HIVE_ID" --argjson identity "$identity" --arg operation "$operation_id" --argjson ids "$local_ids" '{schema:1,installation:$installation,identity:$identity,operationId:$operation,localIds:$ids,phase:"planned"}')
    request=$(jq -c --argjson state "$state" '.+{state:$state}' <<< "$request")
  fi
  for host in "${hosts[@]}"; do
    result=$(hive_admin_access_action "$host" inspect "$request")
    host_identities=$(jq -c --arg host "$host" --arg uuid "$(jq -er .installationUUID <<< "$result")" '.+{($host):$uuid}' <<< "$host_identities")
    environments=$(jq -c --argjson next "$(jq -c .environments <<< "$result")" '.+$next' <<< "$environments")
  done
  if jq -e '.hostIdentities!=null' <<< "$state" >/dev/null; then
    jq -e --argjson hosts "$host_identities" '.hostIdentities==$hosts' <<< "$state" >/dev/null || hive_die 'An installation host identity changed; preserve the retained access operation'
  else state=$(jq -c --argjson hosts "$host_identities" '.hostIdentities=$hosts' <<< "$state"); request=$(jq -c --argjson state "$state" '.state=$state' <<< "$request"); fi
  plan=$(jq -nc --argjson state "$state" --arg installation "$HIVE_ID" --argjson components "$(printf '%s\n' "${products[@]}" | jq -Rsc 'split("\n")[:-1]')" --argjson environments "$environments" \
    '{identity:$state.identity,installation:$installation,localIds:$state.localIds,components:$components,environments:$environments}')
  result=$(hive_admin_access_action "$identity_host" preview "$(jq -c --argjson plan "$plan" '.+{plan:$plan}' <<< "$request")") || hive_die 'Existing product policy conflicts with this administrator; no account or grant was created'
  printf '\nAdministrator: %s (%s)\nIdentity: %s / %s\nProducts: %s\n' "$username" "$(jq -r .email <<< "$identity")" "$(jq -r .issuer <<< "$identity")" "$(jq -r .subject <<< "$identity")" "$(printf '%s ' "${products[@]}")"
  if [[ "$terminal_included" == true ]]; then printf "WEB TERMINAL: this installation's existing administrator roles include terminal access; the Magnus administrator link will enable it for this account, with the usual recent-authentication requirement.\n"; fi
  printf 'Set up separate product accounts and administrator grants, add the Suite Administrator role, and reconnect affected product services. Existing accounts and service scopes are preserved.\n'
  if [[ "${HIVE_CONFIRMED:-false}" != true ]]; then
    [[ "${HIVE_ADMIN_ACCESS_INTERACTIVE:-true}" == true && -t 0 ]] && hive_confirm 'Set up this administrator?' || hive_die 'Cancelled; unattended changes need --yes'
  fi
  state=$(hive_admin_access_action "$identity_host" init "$request")
  request=$(jq -c --argjson state "$state" '.state=$state' <<< "$request")
  printf 'Preparing protected product access...\n'
  for host in "${hosts[@]}"; do hive_admin_access_action "$host" secrets "$request" >/dev/null; done
  for component in hivemem chattermost; do
    jq -e --arg component "$component" '.components[$component]!=null' "$HIVE_CONFIG" >/dev/null || continue
    host=$(jq -er --arg component "$component" '.components[$component].host' "$HIVE_CONFIG")
    server_name=$(jq -r --arg component "$component" '.bootstrap.productEndpoints[$component].origin // ("https://"+$component)' "$HIVE_CONFIG"); server_name=${server_name#https://}; server_name=${server_name%%:*}
    printf 'Setting up the %s account...\n' "$component"
    result=$(hive_admin_access_action "$host" native "$(jq -c --arg component "$component" --arg serverName "$server_name" '.+{component:$component,serverName:$serverName}' <<< "$request")")
    native_receipts=$(jq -c --arg component "$component" --argjson receipt "$(jq -c .normalized <<< "$result")" '.+{($component):$receipt}' <<< "$native_receipts")
  done
  plan=$(jq -c --argjson receipts "$native_receipts" '.nativeReceipts=$receipts' <<< "$plan")
  result=$(hive_admin_access_action "$identity_host" merge "$(jq -c --argjson plan "$plan" '.+{plan:$plan}' <<< "$request")")
  jq -e '.nativeProvisioningVerified==true' <<< "$result" >/dev/null || hive_die 'The native product proof is incomplete'
  request=$(jq -c --argjson plan "$result" '.+{plan:$plan}' <<< "$request")
  printf 'Connecting the administrator to installed products...\n'
  for host in "${hosts[@]}"; do
    account=$(hive_admin_access_action "$identity_host" resolve "$request" | jq -ce .identity)
    [[ "$account" == "$identity" ]] || hive_die 'The administrator changed during setup; the operation is retained for review'
    hive_admin_access_action "$host" apply "$request" >/dev/null
  done
  hive_admin_access_action "$identity_host" grant "$request" >/dev/null
  hive_admin_access_action "$identity_host" complete "$request" >/dev/null
  local checklist
  if checklist=$(hive_checklist_recorded 2>/dev/null); then
    hive_checklist_settle "$checklist" first-admin done
    hive_checklist_settle "$checklist" administrator-product-access done
  fi
  printf 'Administrator %s is ready. Sign out of HiveXUI and sign in with that account.\n' "$username"
)

# Older entry points already know upgrade --release latest. Offer the new flow from that
# signed controller, so an upgrade can guide access without hand-editing or replacing the launcher.
hive_admin_access_offer() {
  [[ "$1" == true && -t 0 && -t 1 ]] || return 0
  jq -e '.bootstrap!=null and .components.oathweave!=null and .console!=null and .external.magnus==null' "$HIVE_CONFIG" >/dev/null || return 0
  local items
  items=$(hive_checklist_recorded 2>/dev/null) || return 0
  jq -e 'any(.[]; .id=="administrator-product-access" and .status=="pending")' <<< "$items" >/dev/null || return 0
  printf '\nYour administrator may still need product access. Hive can set this up with sudo.\n'
  if hive_confirm 'Set up administrator product access now?'; then
    # The optional follow-up has its own strict shell. Its failure must not turn a completed
    # suite upgrade into an ambiguous lifecycle outcome, or suppress errexit inside the wizard.
    if ! bash "$HIVE_ROOT/hive.sh" admin-access setup --config "$HIVE_OPERATOR_CONFIG" --release "$HIVE_VERSION" \
      --manifest "$HIVE_MANIFEST" --signature "$HIVE_SIGNATURE" --trust-key "$HIVE_TRUST_KEY"; then
      printf 'The suite upgrade completed. Administrator access needs attention; keep its receipts and repeat %s/hive.sh admin-access setup --release %s.\n' "$HIVE_ROOT" "$HIVE_VERSION" >&2
    fi
  fi
}
