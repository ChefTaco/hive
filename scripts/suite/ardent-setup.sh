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

# Magnus admits the package installation and New Agent only on a node enrolled for managed Ardent
# actions (its Ardent scope active, the whole node draining for enrollment or enrolled) whose
# admission is open. Check that before anything is sent, so the refusal never becomes a receipt.
hive_ardent_require_enrolled() { # INVENTORY
  local enrollment
  enrollment=$(jq -c '.enrollment // null' <<< "$1")
  [[ "$enrollment" != null ]] || hive_die 'Magnus did not report whether this node is enrolled for managed Ardent actions; no setup request was sent. Check Magnus and the host agent, then run ardent setup again'
  if ! jq -e '.ardentScope=="active" and (.wholeNode=="draining" or .wholeNode=="enrolled")' <<< "$enrollment" >/dev/null; then
    hive_die "$(jq -r '"This node is not enrolled for managed Ardent actions in Magnus (Ardent scope \(.ardentScope), node enrollment \(.wholeNode)), so Magnus would refuse the package installation."' <<< "$enrollment") Enroll it first: ./hive.sh magnus-agent enroll, or magnus-agent prepare-ardent on a fresh single-host installation (deployment/FULL.md#magnus-host-agents). No setup request was sent"
  fi
  if jq -e '.admissionClosed==true' <<< "$enrollment" >/dev/null; then
    hive_die 'Magnus has closed admission on this node for maintenance (an enrollment, upgrade or release in progress), so it would refuse the package installation. Run ardent setup again once it has finished; no setup request was sent'
  fi
}

# Receipt phases written before any profile was requested: planned (nothing sent), install-refused
# (Magnus refused the package installation and then held no command and no package) and installing
# (the package installation was sent and returned no result). With no command held on the node and
# no such profile, setup starts again after the first two by itself, and after installing only with
# --retry-install, once the operator has reviewed it. Creating and later phases stay held.
hive_ardent_retryable_phase() { [[ "$1" == planned || "$1" == installing || "$1" == install-refused ]]; }

hive_ardent_check() {
  local result operation phase
  if [[ -n "${HIVE_ARDENT_STATE:-}" ]]; then
    phase=$(jq -r .phase <<< "$HIVE_ARDENT_STATE")
    if hive_ardent_retryable_phase "$phase"; then
      hive_die "Setup of this profile stopped before its profile was requested (receipt phase $phase). Run ./hive.sh ardent setup --profile $HIVE_ARDENT_PROFILE to continue it"
    fi
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
  local subcommand=${1:-setup} requested_operation=${2:-} record inventory existing original parent lock phase plan operation result installation dependencies code
  case "$subcommand" in setup|status|check|resume) ;; *) hive_die 'Use: ardent setup|status|check|resume OPERATION_ID [--profile NAME] [--model-url URL --model MODEL] [--retry-install]';; esac
  [[ "$subcommand" == setup || ( -z "$HIVE_ARDENT_MODEL_URL" && -z "$HIVE_ARDENT_MODEL" ) ]] || hive_die 'Model settings apply only to ardent setup'
  [[ "$subcommand" == setup || "${HIVE_ARDENT_RETRY_INSTALL:-false}" != true ]] || hive_die '--retry-install applies only to ardent setup'
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
    # The agent dependencies Magnus resolved; null when it did not answer. The JSON stays
    # machine-readable and the section is for the operator, as with status.
    if dependencies=$(hive_magnus_ardent_dependencies 2>/dev/null) && jq -e 'type=="object" and (.supported==false or (.dependencies|type=="array"))' <<< "$dependencies" >/dev/null 2>&1; then
      hive_agent_dependencies_print "$dependencies" >&2
    else
      dependencies=null
      printf 'WARNING: Agent dependencies: Magnus did not answer.\n' >&2
    fi
    jq -n --argjson inventory "$inventory" --argjson receipt "${HIVE_ARDENT_STATE:-null}" --argjson dependencies "$dependencies" '{inventory:$inventory,setup:$receipt,dependencies:$dependencies}'
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

  # A receipt left before any profile was requested does not block the profile for good. The node
  # holds no command (checked above), so nothing of the earlier run is running: setup starts again,
  # reusing the retained model settings unless new ones are given. An installing receipt (earlier
  # releases also left one when Magnus refused the installation) needs --retry-install.
  if [[ -n "$HIVE_ARDENT_STATE" ]]; then phase=$(jq -r .phase <<< "$HIVE_ARDENT_STATE"); else phase=''; fi
  if [[ "${HIVE_ARDENT_RETRY_INSTALL:-false}" == true && -n "$phase" ]] && ! hive_ardent_retryable_phase "$phase"; then
    hive_die "--retry-install applies only to a setup that stopped at its package installation; this profile's receipt is at $phase"
  fi
  if [[ "$subcommand" == setup && -n "$phase" ]] && hive_ardent_retryable_phase "$phase"; then
    if [[ "$phase" == installing && "${HIVE_ARDENT_RETRY_INSTALL:-false}" != true ]]; then
      hive_die "An earlier setup run sent the package installation and got no result back (receipt phase installing); no request was repeated. Magnus holds no command on this node now, so it is not running. Review the installation in Magnus > Ardent > Installations, then run ./hive.sh ardent setup --profile $HIVE_ARDENT_PROFILE --retry-install to install the package again and continue"
    fi
    jq -e --arg profile "$HIVE_ARDENT_PROFILE" 'all(.profiles[]; .id!=$profile)' <<< "$inventory" >/dev/null ||
      hive_die 'This profile exists although its setup receipt shows that none was requested; it is preserved. Inspect it in Magnus and its receipt with ./hive.sh ardent status'
    printf 'Setup of profile %s stopped earlier at %s, before the profile was requested, and Magnus holds no command on this node: starting it again.\n' \
      "$HIVE_ARDENT_PROFILE" "$(jq -r 'if .phase=="install-refused" then "a refused package installation (\(.refusal.code // "refused"))" elif .phase=="installing" then "its package installation" else "its plan" end' <<< "$HIVE_ARDENT_STATE")"
    if [[ -z "$HIVE_ARDENT_MODEL_URL" && -z "$HIVE_ARDENT_MODEL" ]]; then
      HIVE_ARDENT_MODEL_URL=$(jq -r '.model.base_url // ""' <<< "$HIVE_ARDENT_STATE")
      HIVE_ARDENT_MODEL=$(jq -r '.model.model // ""' <<< "$HIVE_ARDENT_STATE")
    fi
    HIVE_ARDENT_STATE=''
  fi

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
    hive_ardent_require_enrolled "$inventory"
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
      if ! result=$(hive_ardent_api package-install); then
        # Refused, with the node then holding no command and no package: nothing was installed or is
        # running. The receipt records the refusal, and the next setup run starts again.
        if code=$(jq -er 'select(.success==false and .error.ambiguous==false) | .error.code | select(test("^ARDENT_SETUP_[A-Z_]{1,64}$"))' <<< "$result" 2>/dev/null); then
          hive_ardent_write_state "$(jq -c --argjson error "$(jq -c '.error' <<< "$result")" \
            '.phase="install-refused" | .refusal=(($error|{code,httpStatus,apiCode}|with_entries(select(.value!=null)))+{at:(now|todate)})' <<< "$HIVE_ARDENT_STATE")"
          case "$code" in
            ARDENT_SETUP_PACKAGE_REFUSED) hive_die "Magnus refused the package installation ($code$(jq -r '.error | if .httpStatus then ", HTTP \(.httpStatus)" else "" end + if .apiCode then " \(.apiCode)" else "" end' <<< "$result")), and the node then held no command and no installed package: nothing was installed or created. The receipt records the refusal. Resolve its reason in Magnus (Ardent > Installations), then run ./hive.sh ardent setup --profile $HIVE_ARDENT_PROFILE again";;
            ARDENT_SETUP_NODE_NOT_ENROLLED) hive_die 'The package installation was not sent: Magnus reports that this node is not enrolled for managed Ardent actions. Enroll it (./hive.sh magnus-agent enroll), then run ardent setup again; nothing was installed or created';;
            ARDENT_SETUP_ADMISSION_CLOSED) hive_die 'The package installation was not sent: Magnus has closed admission on this node for maintenance. Run ardent setup again once it has finished; nothing was installed or created';;
            ARDENT_SETUP_NODE_NOT_READY) hive_die 'The package installation was not sent: the node holds a command that has not settled. Review its owners in Magnus (Ardent > Installations), then run ardent setup again; nothing was installed or created';;
          esac
          hive_die "The package installation was not sent ($code); nothing was installed or created, and the receipt records the refusal. Check Magnus and the host agent, then run ./hive.sh ardent setup --profile $HIVE_ARDENT_PROFILE again"
        fi
        hive_die 'Package installation did not return a completed receipt. Inspect its command in Magnus before continuing'
      fi
      jq -e '.installed==true' <<< "$result" >/dev/null || hive_die 'Magnus did not verify the installed package; the setup receipt was retained'
    fi
    hive_ardent_phase creating
    if ! result=$(hive_ardent_api create); then
      # Refused before any POST was sent (for example the node still settling another command):
      # nothing was created, so the receipt is dropped and setup can simply run again.
      if code=$(jq -er 'select(.success==false and .error.ambiguous==false) | .error.code | select(test("^ARDENT_SETUP_[A-Z_]{1,64}$"))' <<< "$result" 2>/dev/null); then
        rm -f -- "$HIVE_ARDENT_STATE_FILE"
        sync -f "$HIVE_ARDENT_STATE_DIRECTORY" || hive_die 'The setup receipt directory could not be flushed. Keep its files and inspect Magnus before continuing'
        hive_die "Magnus refused the profile before any request was sent ($code); nothing was created. Run ./hive.sh ardent setup again once the node is ready"
      fi
      hive_die 'Profile creation did not return an operation ID. Keep the setup receipt and inspect Magnus; do not create it again'
    fi
    operation=$(jq -er '.operationId|select(type=="string" and length>0)' <<< "$result") || hive_die 'Magnus returned no operation ID; inspect the retained setup before retrying'
    [[ $(jq -r .requestSHA256 <<< "$result") == "$(jq -r .requestSHA256 <<< "$plan")" ]] || hive_die 'Magnus setup request changed; inspect the retained operation before continuing'
    hive_ardent_phase operation "$operation"
    hive_ardent_wait "$operation"
  fi
  hive_ardent_check
  printf 'Ardent profile %s is ready, with HiveMem and a verified model connection. Manage it in Magnus > Ardent.\n' "$HIVE_ARDENT_PROFILE"
)
