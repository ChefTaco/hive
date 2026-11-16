#!/usr/bin/env bash
# Guided Ardent provisioning composes Magnus's owning API operations. The small
# protected receipt belongs to this controller, not to the native profile: it
# prevents an interrupted POST from becoming a second deployment on a retry.

hive_ardent_private_file() {
  [[ -f "$1" && ! -L "$1" && -O "$1" && $(stat -c %a -- "$1") == 600 && $(stat -c %h -- "$1") == 1 ]]
}

hive_ardent_api() { # MODE [OPERATION_ID]
  local mode=$1 operation=${2:-} setup payload
  setup=$(jq -nc --arg mode "$mode" --arg node "$HIVE_ARDENT_NODE" --arg profile "$HIVE_ARDENT_PROFILE" \
    --arg operation "$operation" --argjson model "${HIVE_ARDENT_MODEL_JSON:-null}" \
    '{mode:$mode,nodeId:$node,profile:$profile} +
      (if $mode=="plan" or $mode=="create" then {model:$model} else {} end) +
      (if $operation!="" then {operationId:$operation} else {} end)')
  payload=$(jq -nc --arg compose "$HIVE_ARDENT_COMPOSE" --arg script "$(base64 -w0 "$HIVE_ROOT/scripts/suite/ardent-setup.mjs")" \
    --argjson setup "$setup" '{compose:$compose,setupScript:$script,setup:$setup}')
  hive_magnus_agent_action "$HIVE_MAGNUS_HOST" magnus-agent-ardent-setup "$payload"
}

hive_ardent_write_state() { # JSON
  local temporary
  temporary=$(mktemp "$HIVE_ARDENT_STATE_DIRECTORY/.receipt.XXXXXX") || hive_die 'Could not stage the Ardent setup receipt'
  printf '%s\n' "$1" > "$temporary"
  chmod 600 "$temporary"
  sync -f "$temporary" || hive_die 'The setup receipt could not be flushed. Keep its files and inspect Magnus before continuing'
  mv -T -- "$temporary" "$HIVE_ARDENT_STATE_FILE"
  sync -f "$HIVE_ARDENT_STATE_DIRECTORY" || hive_die 'The setup receipt directory could not be flushed. Keep its files and inspect Magnus before continuing'
  HIVE_ARDENT_STATE=$1
}

hive_ardent_load_state() {
  local installation=$1
  HIVE_ARDENT_STATE=''
  if [[ -e "$HIVE_ARDENT_STATE_FILE" || -L "$HIVE_ARDENT_STATE_FILE" ]]; then
    hive_ardent_private_file "$HIVE_ARDENT_STATE_FILE" || hive_die 'The Ardent setup receipt must be an operator-owned private regular file without links'
    HIVE_ARDENT_STATE=$(jq -ce --arg installation "$installation" --arg node "$HIVE_ARDENT_NODE" --arg profile "$HIVE_ARDENT_PROFILE" \
      'select(.schema==1 and .installation==$installation and .nodeId==$node and .profile==$profile)' "$HIVE_ARDENT_STATE_FILE") || hive_die 'The Ardent setup receipt belongs to a different installation or node'
  fi
}

hive_ardent_confirm() {
  [[ "$HIVE_CONFIRMED" != true ]] || return 0
  [[ ${HIVE_ARDENT_INTERACTIVE:-true} == true ]] || hive_die 'Unattended Ardent changes need --yes after reviewing their settings'
  hive_magnus_agent_confirm false "$1"
}

hive_ardent_phase() { # PHASE [OPERATION_ID]
  hive_ardent_write_state "$(jq -c --arg phase "$1" --arg operation "${2:-}" \
    '.phase=$phase | if $operation!="" then .operationId=$operation else . end' <<< "$HIVE_ARDENT_STATE")"
}

hive_ardent_wait() { # OPERATION_ID
  local operation=$1 result status previous='' attempts
  for ((attempts=0; attempts<120; attempts++)); do
    result=$(hive_ardent_api operation "$operation") || hive_die "Could not read retained operation $operation. Run ./hive.sh ardent status; do not create it again"
    status=$(jq -er .status <<< "$result")
    if [[ "$result" != "$previous" ]]; then printf '%s\n' "$result" | jq .; previous=$result; fi
    case "$status" in
      succeeded) hive_ardent_phase profile-ready; return;;
      failed)
        hive_ardent_phase failed
        hive_die "Ardent setup stopped at $(jq -r '.failedStep // "an unfinished step"' <<< "$result"). Its receipts are retained. Review it in Magnus, then use ./hive.sh ardent resume $operation --profile $HIVE_ARDENT_PROFILE";;
      running) sleep 2;;
      *) hive_die 'Magnus returned an unrecognized Ardent operation state; the receipt was retained';;
    esac
  done
  hive_die "Operation $operation is still running. Run ./hive.sh ardent setup --profile $HIVE_ARDENT_PROFILE again to follow the same operation"
}

hive_ardent_check() {
  local result operation phase
  if [[ -n "${HIVE_ARDENT_STATE:-}" ]]; then
    phase=$(jq -r .phase <<< "$HIVE_ARDENT_STATE")
    case "$phase" in profile-ready|complete|checking) ;; *) hive_die 'The retained deployment needs review before a model check. Use ardent status, setup or explicit resume; its intent was preserved';; esac
    operation=$(jq -er '.operationId|select(type=="string" and length>0)' <<< "$HIVE_ARDENT_STATE") || hive_die 'The setup receipt has no owning deployment operation'
    result=$(hive_ardent_api operation "$operation") || hive_die 'The owning deployment could not be verified; its intent was preserved'
    jq -e --arg operation "$operation" '.operationId==$operation and .kind=="deploy" and .status=="succeeded"' <<< "$result" >/dev/null || hive_die 'The owning deployment has not succeeded; its intent was preserved'
    hive_ardent_phase checking
  fi
  result=$(hive_ardent_api check) || hive_die 'The profile was retained, but its model check did not complete. Inspect Magnus before running ardent check again'
  printf '%s\n' "$result" | jq .
  if ! jq -e '.ready==true' <<< "$result" >/dev/null; then
    [[ -z "${HIVE_ARDENT_STATE:-}" ]] || hive_ardent_phase profile-ready
    hive_die 'The profile needs attention: check its model connection and HiveMem in Magnus, then run ./hive.sh ardent check'
  fi
  [[ -z "${HIVE_ARDENT_STATE:-}" ]] || hive_ardent_phase complete
}

hive_ardent() (
  umask 077
  local subcommand=${1:-setup} requested_operation=${2:-} record inventory existing original parent lock phase plan operation result installation
  case "$subcommand" in setup|status|check|resume) ;; *) hive_die 'Use: ardent setup|status|check|resume OPERATION_ID [--profile NAME] [--model-url URL --model MODEL]';; esac
  [[ "$subcommand" == setup || ( -z "$HIVE_ARDENT_MODEL_URL" && -z "$HIVE_ARDENT_MODEL" ) ]] || hive_die 'Model settings apply only to ardent setup'
  [[ $# -le 2 && ( "$subcommand" == resume || -z "$requested_operation" ) ]] || hive_die 'Unexpected Ardent arguments'
  [[ "$subcommand" != resume || -n "$requested_operation" ]] || hive_die 'ardent resume needs the retained operation ID'
  [[ "$HIVE_ARDENT_PROFILE" =~ ^[a-z][a-z0-9_-]{0,47}$ ]] || hive_die 'Use a profile ID of 1-48 lowercase letters, digits, underscores or hyphens, starting with a letter'
  jq -e '.components.magnus!=null and .components.hivemem!=null and .components.oathweave!=null and .console.host==.components.magnus.host' "$HIVE_CONFIG" >/dev/null ||
    hive_die 'Ardent setup needs Magnus, HiveMem and Oathweave, with Magnus on the console host'
  hive_magnus_agent_target ''
  HIVE_ARDENT_COMPOSE="$(jq -r --arg host "$HIVE_MAGNUS_HOST" '.hosts[$host].directory' "$HIVE_CONFIG")/compose.json"
  record=$(hive_magnus_agent_node_record "$(jq -r '.origin|sub("^https://";"")|split(":")[0]' "$HIVE_CONFIG")") || hive_die 'The Magnus host agent could not be found'
  HIVE_ARDENT_NODE=$(jq -er '.id|select(type=="string" and length>0)' <<< "$record") || hive_die 'Install the Magnus host agent first: ./hive.sh magnus-agent install --install-node'
  [[ $(jq -r .status <<< "$record") == ONLINE ]] || hive_die 'The Magnus host agent must be online before Ardent setup'

  original=${HIVE_REGISTRY_ORIGINAL_CONFIG:-${HIVE_OPERATOR_CONFIG:-$HIVE_CONFIG}}
  original=$(realpath -e -- "$original") || hive_die 'The owning installation file is unavailable'
  parent=$(dirname -- "$original")
  HIVE_ARDENT_STATE_DIRECTORY=$parent/ardent-setup
  HIVE_ARDENT_STATE_FILE=$HIVE_ARDENT_STATE_DIRECTORY/$HIVE_ARDENT_PROFILE.json
  installation=$(jq -r .installation "$HIVE_CONFIG")
  [[ ! -L "$HIVE_ARDENT_STATE_DIRECTORY" ]] || hive_die 'Unsafe Ardent setup receipt directory'
  # Atomic receipt replacement permits status during the writer's long-running
  # deployment without taking its lock or creating state on an untouched install.
  if [[ "$subcommand" == status ]]; then
    if [[ -e "$HIVE_ARDENT_STATE_DIRECTORY" ]]; then
      [[ -d "$HIVE_ARDENT_STATE_DIRECTORY" && -O "$HIVE_ARDENT_STATE_DIRECTORY" && $(stat -c %a -- "$HIVE_ARDENT_STATE_DIRECTORY") == 700 ]] || hive_die 'Unsafe Ardent setup receipt directory'
    fi
    hive_ardent_load_state "$installation"
    inventory=$(hive_ardent_api inspect) || hive_die 'Ardent could not be inspected'
    jq -n --argjson inventory "$inventory" --argjson receipt "${HIVE_ARDENT_STATE:-null}" '{inventory:$inventory,setup:$receipt}'
    return
  fi
  if [[ ! -e "$HIVE_ARDENT_STATE_DIRECTORY" ]]; then mkdir -m 700 -- "$HIVE_ARDENT_STATE_DIRECTORY"; fi
  [[ -d "$HIVE_ARDENT_STATE_DIRECTORY" && -O "$HIVE_ARDENT_STATE_DIRECTORY" ]] || hive_die 'Ardent setup receipts must belong to the current operator'
  chmod 700 "$HIVE_ARDENT_STATE_DIRECTORY"
  HIVE_ARDENT_STATE_FILE=$HIVE_ARDENT_STATE_DIRECTORY/$HIVE_ARDENT_PROFILE.json
  [[ ! -L "$HIVE_ARDENT_STATE_FILE" && ! -L "$HIVE_ARDENT_STATE_DIRECTORY/$HIVE_ARDENT_PROFILE.lock" ]] || hive_die 'Unsafe Ardent setup receipt or lock'
  if [[ -e "$HIVE_ARDENT_STATE_DIRECTORY/$HIVE_ARDENT_PROFILE.lock" ]]; then
    hive_ardent_private_file "$HIVE_ARDENT_STATE_DIRECTORY/$HIVE_ARDENT_PROFILE.lock" || hive_die 'The Ardent setup lock must be an operator-owned private regular file without links'
  else
    (set -o noclobber; : > "$HIVE_ARDENT_STATE_DIRECTORY/$HIVE_ARDENT_PROFILE.lock") || hive_die 'The Ardent setup lock changed; inspect it before continuing'
  fi
  exec {lock}<> "$HIVE_ARDENT_STATE_DIRECTORY/$HIVE_ARDENT_PROFILE.lock"
  flock -n "$lock" || hive_die 'Another setup command is using this profile; use ardent status later'
  hive_ardent_load_state "$installation"
  inventory=$(hive_ardent_api inspect) || hive_die 'Ardent could not be inspected; no setup request was sent'
  jq -e '.reachable==true and (.commandOwners|length==0)' <<< "$inventory" >/dev/null || hive_die 'This node is unavailable or held by existing work. Review its owners in Magnus; no work was replayed'
  if [[ "$subcommand" == check ]]; then hive_ardent_check; return; fi

  if [[ -n "$HIVE_ARDENT_STATE" ]]; then
    HIVE_ARDENT_MODEL_JSON=$(jq -c .model <<< "$HIVE_ARDENT_STATE")
    if [[ -n "$HIVE_ARDENT_MODEL_URL" || -n "$HIVE_ARDENT_MODEL" ]]; then
      jq -e --arg url "$HIVE_ARDENT_MODEL_URL" --arg model "$HIVE_ARDENT_MODEL" \
        '($url=="" or .model.base_url==$url) and ($model=="" or .model.model==$model)' <<< "$HIVE_ARDENT_STATE" >/dev/null ||
        hive_die 'This profile has a different retained setup plan. Change an existing profile through Magnus'
    fi
    phase=$(jq -r .phase <<< "$HIVE_ARDENT_STATE")
    operation=$(jq -r '.operationId // ""' <<< "$HIVE_ARDENT_STATE")
    if [[ "$subcommand" == resume ]]; then
      [[ -n "$operation" && "$operation" == "$requested_operation" ]] || hive_die 'Resume must name the retained operation for this profile; do not adopt or replay unrelated work'
      hive_ardent_confirm "Resume retained Ardent operation $operation, keeping its completed steps?" || hive_die 'Cancelled'
      result=$(hive_ardent_api resume "$operation") || hive_die 'Magnus refused resume; keep the original operation and inspect its held work'
      hive_ardent_phase operation "$operation"
      hive_ardent_wait "$operation"
    else
      case "$phase" in
        complete)
          jq -e --arg profile "$HIVE_ARDENT_PROFILE" 'any(.profiles[]; .id==$profile)' <<< "$inventory" >/dev/null || hive_die 'The completed profile is missing. Inspect Magnus and the retained setup receipt'
          printf 'Ardent profile %s is already set up. Use ./hive.sh ardent check --profile %s to test it again.\n' "$HIVE_ARDENT_PROFILE" "$HIVE_ARDENT_PROFILE"
          return;;
        operation) hive_ardent_wait "$operation";;
        profile-ready) ;;
        failed) hive_die "The retained operation failed. Review Magnus, then use ./hive.sh ardent resume $operation --profile $HIVE_ARDENT_PROFILE";;
        *) hive_die 'Setup was interrupted around a request whose outcome needs review. Keep its receipt and inspect Magnus; no request was repeated';;
      esac
    fi
  else
    [[ "$subcommand" != resume ]] || hive_die 'No retained Ardent operation belongs to this profile'
    jq -e --arg profile "$HIVE_ARDENT_PROFILE" 'all(.profiles[]; .id!=$profile)' <<< "$inventory" >/dev/null || hive_die 'This profile already exists and is preserved. Choose another --profile, or manage it through Magnus'
    if [[ -z "$HIVE_ARDENT_MODEL_URL" || -z "$HIVE_ARDENT_MODEL" ]]; then
      [[ ${HIVE_ARDENT_INTERACTIVE:-true} == true && -t 0 ]] || hive_die 'Supply --model-url URL and --model NAME for unattended Ardent setup'
    fi
    if [[ -z "$HIVE_ARDENT_MODEL_URL" ]]; then hive_prompt HIVE_ARDENT_MODEL_URL 'OpenAI-compatible model API base URL, including /v1'; fi
    if [[ -z "$HIVE_ARDENT_MODEL" ]]; then hive_prompt HIVE_ARDENT_MODEL 'Model name advertised by that endpoint'; fi
    HIVE_ARDENT_MODEL_JSON=$(jq -nc --arg url "$HIVE_ARDENT_MODEL_URL" --arg model "$HIVE_ARDENT_MODEL" '{base_url:$url,model:$model}')
    plan=$(hive_ardent_api plan) || hive_die 'The model settings are invalid; no setup request was sent'
    printf 'Ardent setup on %s: profile %s, HiveMem enabled, default identity and skills.\n' "$HIVE_MAGNUS_HOST" "$HIVE_ARDENT_PROFILE"
    printf '%s\n' "$plan" | jq .
    hive_ardent_confirm 'Install the staged Ardent package if needed, create this profile and test its model connection?' || hive_die 'Cancelled; no setup request was sent'
    hive_ardent_write_state "$(jq -nc --arg installation "$installation" --arg node "$HIVE_ARDENT_NODE" --arg profile "$HIVE_ARDENT_PROFILE" --argjson model "$HIVE_ARDENT_MODEL_JSON" \
      --arg digest "$(jq -er .requestSHA256 <<< "$plan")" '{schema:1,installation:$installation,nodeId:$node,profile:$profile,model:$model,requestSHA256:$digest,phase:"planned"}')"
    if ! jq -e '.installed==true' <<< "$inventory" >/dev/null; then
      hive_ardent_phase installing
      result=$(hive_ardent_api package-install) || hive_die 'Package installation did not return a completed receipt. Inspect its command in Magnus before continuing'
      jq -e '.installed==true' <<< "$result" >/dev/null || hive_die 'Magnus did not verify the installed package; the setup receipt was retained'
    fi
    hive_ardent_phase creating
    result=$(hive_ardent_api create) || hive_die 'Profile creation did not return an operation ID. Keep the setup receipt and inspect Magnus; do not create it again'
    operation=$(jq -er '.operationId|select(type=="string" and length>0)' <<< "$result") || hive_die 'Magnus returned no operation ID; inspect the retained setup before retrying'
    [[ $(jq -r .requestSHA256 <<< "$result") == "$(jq -r .requestSHA256 <<< "$plan")" ]] || hive_die 'Magnus setup request changed; inspect the retained operation before continuing'
    hive_ardent_phase operation "$operation"
    hive_ardent_wait "$operation"
  fi
  hive_ardent_check
  printf 'Ardent profile %s is ready, with HiveMem and a verified model connection. Manage it in Magnus > Ardent.\n' "$HIVE_ARDENT_PROFILE"
)
