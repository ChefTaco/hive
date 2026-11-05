#!/usr/bin/env bash
# Product-owned native profile initialization. A previous mutation claim can only
# be reconciled by the exact signed read-only verifier, never by rerunning init.
adapter_initialize_native() {
  local item=$1 artifact=$2 target=$3 executable=$4 id profile environment sha state specification phase
  local environment_sha configuration_sha profile_sha artifact_tree log_prefix permissions verified=false
  jq -e 'has("initializationArguments")' <<< "$artifact" >/dev/null || return 0
  jq -e 'all([.initializationArguments,.verificationArguments][];type=="array" and length>0 and all(.[];type=="string" and length>0 and (contains("\u0000")|not) and (test("[\\r\\n]")|not)))' <<< "$artifact" >/dev/null || die 'Native initialization requires exact signed initialization and read-only verification arguments'
  id=$(jq -er .id <<< "$item"); profile=$(jq -er .profileDirectory <<< "$item"); environment=$(jq -er .environmentFile <<< "$item")
  if [[ $(jq -r .authorized <<< "$item") != true ]]; then
    printf 'Agent %s: native profile initialization pending explicit operator authorization\n' "$id"
    return 0
  fi
  sha=$(jq -er .sha256 <<< "$artifact")
  state="$directory/agents/$id/initialization.$sha.json"; log_prefix="$directory/agents/$id/initialization.$plan"
  specification=$(jq -nc --arg sha "$sha" --arg profile "$profile" --arg executable "$(jq -er .executable <<< "$artifact")" --argjson initialize "$(jq -c .initializationArguments <<< "$artifact")" --argjson verify "$(jq -c .verificationArguments <<< "$artifact")" '{artifactSHA256:$sha,profileDirectory:$profile,executable:$executable,initializationArguments:$initialize,verificationArguments:$verify}') || die 'Native initialization specification is invalid'
  environment_sha=$(digest "$environment") || die 'Native initialization environment cannot be verified'
  configuration_sha=$(jq -Sc . <<< "$item" | sha256sum | cut -d ' ' -f1) || die 'Native initialization configuration cannot be verified'
  profile_sha=$(adapter_profile_digest "$profile") || die 'Native profile cannot be fingerprinted before initialization'
  artifact_tree=$(tree_digest "$target") || die 'Native artifact cannot be fingerprinted before initialization'
  if [[ -e "$state" || -L "$state" ]]; then
    [[ -f "$state" && ! -L "$state" && $(stat -c %u "$state") == "$(id -u)" ]] || die 'Native initialization receipt is unsafe'
    permissions=$(stat -c %a "$state"); (( (8#$permissions & 077)==0 )) || die 'Native initialization receipt is not protected'
    jq -e --argjson specification "$specification" '.schema==1 and .specification==$specification and (.phase|IN("prepared","claimed","verified"))' "$state" >/dev/null || die 'Native initialization specification changed; preserve its receipt and use product-owned recovery'
    phase=$(jq -er .phase "$state")
    if [[ "$phase" != verified ]]; then
      jq -e --arg environment "$environment_sha" --arg configuration "$configuration_sha" --arg profile "$profile_sha" --arg artifact "$artifact_tree" '.environmentSHA256==$environment and .configurationSHA256==$configuration and .profileSHA256==$profile and .artifactTreeSHA256==$artifact' "$state" >/dev/null || die 'Unknown native initialization inputs changed; no initialization will be replayed'
    fi
  else
    jq -n --argjson specification "$specification" --arg environment "$environment_sha" --arg configuration "$configuration_sha" --arg profile "$profile_sha" --arg artifact "$artifact_tree" '{schema:1,phase:"prepared",specification:$specification,environmentSHA256:$environment,configurationSHA256:$configuration,profileSHA256:$profile,artifactTreeSHA256:$artifact}' | atomic_json "$state" || die 'Native initialization preparation receipt could not be preserved'
    phase=prepared
  fi
  adapter_arguments "$(jq -c .verificationArguments <<< "$artifact")" "$profile" "$environment" "$target"
  if adapter_native_command "$profile" timeout --kill-after 5s 60 "$executable" "${HIVE_AGENT_ARGUMENTS[@]}" < /dev/null > "$log_prefix.verify.log" 2>&1; then
    verified=true
  fi
  [[ $(digest "$environment") == "$environment_sha" && $(adapter_profile_digest "$profile") == "$profile_sha" && $(tree_digest "$target") == "$artifact_tree" ]] || die 'Native read-only verification changed protected files; initialization remains held'
  if [[ "$verified" == true ]]; then
    : # Already initialized, or an interrupted mutation completed successfully.
  elif [[ "$phase" == prepared ]]; then
    # No mutation has been attempted for a prepared journal. Persist the claim
    # before invoking the product, including the immutable pre-init file state.
    jq '.phase="claimed"' "$state" | atomic_json "$state" || die 'Native initialization mutation claim could not be preserved'
    adapter_arguments "$(jq -c .initializationArguments <<< "$artifact")" "$profile" "$environment" "$target"
    adapter_native_command "$profile" timeout --kill-after 5s 60 "$executable" "${HIVE_AGENT_ARGUMENTS[@]}" < /dev/null > "$log_prefix.apply.log" 2>&1 || die 'Native initialization failed or has an unknown outcome; preserve its journal for exact verification, never replay it'
    adapter_arguments "$(jq -c .verificationArguments <<< "$artifact")" "$profile" "$environment" "$target"
    adapter_native_command "$profile" timeout --kill-after 5s 60 "$executable" "${HIVE_AGENT_ARGUMENTS[@]}" < /dev/null > "$log_prefix.verify.log" 2>&1 || die 'Native initialization did not pass its product-owned verifier; initialization remains claimed for recovery'
  else
    die 'Native initialization needs product-owned recovery; exact verification failed and no initialization was replayed'
  fi
  [[ $(digest "$environment") == "$environment_sha" && $(adapter_profile_digest "$profile") == "$profile_sha" && $(tree_digest "$target") == "$artifact_tree" ]] || die 'Native initialization or verification changed protected existing profile files, credentials or artifact bytes; preserve the claimed journal for recovery'
  [[ $(stat -c %s "$log_prefix.verify.log") -le 65536 ]] || die 'Native initialization verification output exceeds its evidence bound'
  jq --arg proof "$(digest "$log_prefix.verify.log")" '.phase="verified"|.verificationLogSHA256=$proof' "$state" | atomic_json "$state" || die 'Native initialization completion receipt could not be preserved'
}
