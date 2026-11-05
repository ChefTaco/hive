#!/usr/bin/env bash
# Definitions are transported with host-runtime.sh, never sourced from user input.
adapter_curl() { curl --fail --silent --show-error --proto '=https' --connect-timeout 10 --max-time 1800 --max-redirs 0 "$@"; }
adapter_download() { curl --fail --silent --show-error --proto '=https' --proto-redir '=https' --location --max-redirs 5 --connect-timeout 10 --max-time 7200 "$@"; }
adapter_atomic() { printf '%s\n' "$2" | atomic_json "$1"; }
adapter_profile_boundary() {
  local profile=$1 found
  found=$(find "$profile" \( -type f \( -iname '*.gguf' -o -iname '*.ggml' -o -iname '*.safetensors' \) -o -type d \( -path '*/.ollama/models' -o -path '*/.cache/huggingface/hub' \) \) -print -quit) || die 'Native profile cannot be reviewed safely before installation or backup'
  [[ -z "$found" ]] || die 'Native profile includes externally owned model assets or caches; preserve them in place and review a suite-only profile backup contract. Hive will not install or archive inference resources.'
}
adapter_arguments() {
  local values=$1 profile=$2 environment=$3 target=$4 argument
  HIVE_AGENT_ARGUMENTS=()
  while IFS= read -r argument; do
    case "$argument" in '@PROFILE@') argument=$profile;; '@ENV_FILE@') argument=$environment;; '@ARTIFACT@/'*) argument="$target/${argument#@ARTIFACT@/}";; esac
    HIVE_AGENT_ARGUMENTS+=("$argument")
  done < <(jq -r '.[]' <<< "$values")
}
adapter_native_command() {
  local profile=$1; shift
  (cd "$profile"; env -i PATH="$PATH" HOME="${HOME:-$profile}" LANG="${LANG:-C.UTF-8}" LC_ALL="${LC_ALL:-C.UTF-8}" \
    XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/run/user/$(id -u)}" "$@")
}
adapter_assert_agent_inputs() {
  local item=$1 candidate=$2 target=$3 environment permissions spec unsupported current_tree
  spec=$(jq -Sc . <<< "$item" | sha256sum | cut -d ' ' -f1)
  [[ $(jq -er .configurationSHA256 "$candidate") == "$spec" ]] || die 'Native agent configuration differs from its staged candidate'
  environment=$(jq -er .environmentFile <<< "$item")
  [[ -f "$environment" && ! -L "$environment" && $(stat -c %u "$environment") == "$(id -u)" ]] || die 'Native agent environment is not a protected owned file'
  permissions=$(stat -c %a "$environment"); (( (8#$permissions & 077)==0 )) || die 'Native agent environment permissions changed'
  [[ ! -L "$target" && ! -L "$target.verification.json" ]] || die 'Native artifact contains unsupported links'
  unsupported=$(find "$target" ! -type f ! -type d -print -quit) || die 'Native artifact inventory cannot be read'
  [[ -z "$unsupported" ]] || die 'Native artifact contains unsupported file types'
  current_tree=$(tree_digest "$target") || die 'Native artifact fingerprint cannot be read'
  [[ $(digest "$environment") == "$(jq -er .environmentSHA256 "$candidate")" && "$current_tree" == "$(jq -er .treeSHA256 "$target.verification.json")" ]] || die 'Native agent inputs changed since staging'
  if [[ $(jq -r '.nativeInitializationRequired // false' "$candidate") == true ]]; then
    local initialization="$directory/agents/$(jq -er .id <<< "$item")/initialization.$(jq -er .artifactSHA256 "$candidate").json"
    [[ -f "$initialization" && ! -L "$initialization" && $(stat -c %u "$initialization") == "$(id -u)" ]] || die 'Native initialization completion receipt is missing or unsafe'
    permissions=$(stat -c %a "$initialization"); (( (8#$permissions & 077)==0 )) || die 'Native initialization receipt permissions changed'
    jq -e '.phase=="verified"' "$initialization" >/dev/null || die 'Native initialization is not verified; launch and acceptance remain held'
    [[ $(jq -Sc .specification "$initialization" | sha256sum | cut -d ' ' -f1) == "$(jq -er .nativeInitializationSpecificationSHA256 "$candidate")" ]] || die 'Native initialization specification differs from the staged artifact'
  fi

}
adapter_preflight() {
  local item id runtime profile environment artifact architecture path permissions
  architecture=$(uname -m); case "$architecture" in x86_64) architecture=amd64;; aarch64) architecture=arm64;; *) die 'Unsupported host architecture';; esac
  while IFS= read -r item; do
    id=$(jq -er .id <<< "$item"); runtime=$(jq -er .runtime <<< "$item")
    profile=$(jq -er .profileDirectory <<< "$item"); environment=$(jq -er .environmentFile <<< "$item")
    [[ -d "$profile" && ! -L "$profile" && -f "$environment" && ! -L "$environment" ]] || die 'Agent profile or protected environment is missing'
    adapter_profile_boundary "$profile"
    [[ $(stat -c %u "$profile") == "$(id -u)" && $(stat -c %u "$environment") == "$(id -u)" ]] || die 'Agent profiles must belong to the selected native account'
    local permissions; permissions=$(stat -c %a "$environment"); (( (8#$permissions & 077)==0 )) || die 'Agent environment must be owner-only'
    [[ $(id -u) != 0 ]] || die 'Native agents must be installed through their existing unprivileged account'
    if [[ $(jq -r .service <<< "$item") == user ]]; then systemctl --user show-environment >/dev/null || die 'User service manager is unavailable; configure the selected account explicitly'; fi
    jq -e --arg runtime "$runtime" --arg version "$(jq -er .version <<< "$item")" --arg arch "$architecture" '.agentArtifacts[$runtime][$version][$arch]!=null' "$directory/manifest.$plan.json" >/dev/null || die 'No native artifact for this host architecture'
  done < <(jq -c '.agents[]' <<< "$input")
  # Read-only checks of protected references precede activation or provider calls.
  while IFS= read -r path; do
    [[ -f "$path" && ! -L "$path" && -r "$path" ]] || die 'External provider credential or CA reference is missing'
    [[ $(stat -c %u "$path") == "$(id -u)" ]] || die 'External provider references must belong to the selected operator'
    permissions=$(stat -c %a "$path"); (( (8#$permissions & 077)==0 )) || die 'External provider references must be owner-only'
  done < <(jq -r '.inference[]|.authHeaderFile,.caFile,.registration.credentialFile,.registration.caFile|select(.!=null)' <<< "$input")
}

adapter_stage_agents() {
  local item id runtime version architecture artifact sha target url executable profile environment temporary verification env_sha candidate preflight_passed current_tree unsupported initialization_required initialization_spec
  architecture=$(uname -m); case "$architecture" in x86_64) architecture=amd64;; aarch64) architecture=arm64;; esac
  while IFS= read -r item; do
    id=$(jq -er .id <<< "$item"); runtime=$(jq -er .runtime <<< "$item"); version=$(jq -er .version <<< "$item")
    artifact=$(jq -c --arg runtime "$runtime" --arg version "$version" --arg arch "$architecture" '.agentArtifacts[$runtime][$version][$arch]' "$directory/manifest.$plan.json")
    sha=$(jq -er .sha256 <<< "$artifact"); url=$(jq -er .url <<< "$artifact"); target="$directory/agents/$id/artifacts/$sha"
    verification="$target.verification.json"
    profile=$(jq -er .profileDirectory <<< "$item"); environment=$(jq -er .environmentFile <<< "$item")
    env_sha=$(digest "$environment"); candidate="$directory/agents/$id/candidate.$plan.json"
    if [[ -f "$candidate" ]]; then
      [[ $(jq -r '.environmentSHA256 // empty' "$candidate") == "$env_sha" && $(jq -r '.configurationSHA256 // empty' "$candidate") == "$(jq -Sc . <<< "$item" | sha256sum | cut -d ' ' -f1)" ]] || die 'Agent configuration or environment changed during retry; restore its original inputs or review a new configurationRevision'
    fi
    install -d -m 700 "$directory/agents/$id/artifacts"
    if [[ ! -e "$target" ]]; then
      temporary="$target.partial"; [[ ! -e "$temporary" ]] || die 'Interrupted agent extraction needs inspection'
      install -d -m 700 "$temporary"
      adapter_download --output "$temporary/archive.tgz" "$url"
      [[ $(digest "$temporary/archive.tgz") == "$sha" ]] || die 'Agent artifact checksum differs'
      tar -tvzf "$temporary/archive.tgz" | awk 'substr($0,1,1)!="-" && substr($0,1,1)!="d" {bad=1} END {exit bad}' || die 'Agent archive contains unsupported links or special files'
      if tar -tzf "$temporary/archive.tgz" | awk 'tolower($0) ~ /\.(gguf|ggml|safetensors)$/ {found=1} END {exit !found}'; then die 'Native artifact includes inference model assets; retain its original archive and obtain a reviewed external-only agent bundle'; fi
      while IFS= read -r name; do [[ "$name" != /* && "$name" != *'..'* && "$name" != *\\* ]] || die 'Unsafe agent archive path'; done < <(tar -tzf "$temporary/archive.tgz")
      tar -xzf "$temporary/archive.tgz" -C "$temporary" --no-same-owner --no-same-permissions
      rm -- "$temporary/archive.tgz"
      chmod -R go-w "$temporary"
      executable=$(jq -er .executable <<< "$artifact")
      [[ -f "$temporary/$executable" && ! -L "$temporary/$executable" ]] || die 'Native launcher is absent'
      chmod 700 "$temporary/$executable"
      mv -T -- "$temporary" "$target"
      current_tree=$(tree_digest "$target") || die 'Native artifact fingerprint cannot be recorded'
      jq -n --arg sha "$sha" --arg tree "$current_tree" '{schema:1,artifactSHA256:$sha,treeSHA256:$tree}' | atomic_json "$verification"
    fi
    [[ -f "$verification" && ! -L "$verification" && ! -L "$target" ]] || die 'Existing native artifact needs review against its original archive; it has no verification receipt'
    unsupported=$(find "$target" ! -type f ! -type d -print -quit) || die 'Native artifact inventory cannot be read'
    current_tree=$(tree_digest "$target") || die 'Native artifact fingerprint cannot be verified'
    [[ -z "$unsupported" && "$current_tree" == "$(jq -er .treeSHA256 "$verification")" ]] || die 'Native artifact contents changed after verification'
    executable="$target/$(jq -er .executable <<< "$artifact")"
    preflight_passed=false
    if jq -e '.preflight!=null' <<< "$artifact" >/dev/null; then
      adapter_arguments "$(jq -c .preflight.arguments <<< "$artifact")" "$profile" "$environment" "$target"
      adapter_native_command "$profile" timeout 30 "$executable" "${HIVE_AGENT_ARGUMENTS[@]}" < /dev/null > "$directory/agents/$id/preflight.$plan.log" 2>&1 || die 'Native agent cannot run on this host; inspect its protected preflight log before activation'
      [[ $(stat -c %s "$directory/agents/$id/preflight.$plan.log") -le 4096 ]] || die 'Native preflight output exceeds its evidence bound'
      [[ $(cat "$directory/agents/$id/preflight.$plan.log") == "$(jq -er .preflight.expectedOutput <<< "$artifact")" ]] || die 'Native agent preflight version differs from the signed artifact'
      preflight_passed=true
    fi
    adapter_initialize_native "$item" "$artifact" "$target" "$executable"
    initialization_required=$(jq -c 'has("initializationArguments")' <<< "$artifact")
    initialization_spec=null
    if [[ "$initialization_required" == true && $(jq -r .authorized <<< "$item") == true ]]; then
      jq -e '.phase=="verified"' "$directory/agents/$id/initialization.$sha.json" >/dev/null || die 'Native initialization has no verified completion receipt'
      initialization_spec=$(jq -Sc .specification "$directory/agents/$id/initialization.$sha.json" | sha256sum | cut -d ' ' -f1)
    fi
    adapter_arguments "$(jq -c .arguments <<< "$artifact")" "$profile" "$environment" "$target"
    {
      printf '#!/usr/bin/env bash\nset -euo pipefail\numask 077\ncd %q\nexec env -i ' "$profile"
      printf '%q ' "PATH=$PATH" "HOME=${HOME:-$profile}" "LANG=${LANG:-C.UTF-8}" "LC_ALL=${LC_ALL:-C.UTF-8}" "XDG_RUNTIME_DIR=${XDG_RUNTIME_DIR:-/run/user/$(id -u)}"
      printf '%q ' "$executable" "${HIVE_AGENT_ARGUMENTS[@]}"
      printf '\n'
    } > "$directory/agents/$id/run.$plan.new"
    chmod 700 "$directory/agents/$id/run.$plan.new"
    mv -T "$directory/agents/$id/run.$plan.new" "$directory/agents/$id/run.$plan"
    jq -n --arg id "$id" --arg runtime "$runtime" --arg version "$version" --arg sha "$sha" --arg profile "$profile" --arg envSHA "$env_sha" --arg configSHA "$(jq -Sc . <<< "$item" | sha256sum | cut -d ' ' -f1)" --argjson preflight "$preflight_passed" --argjson initializationRequired "$initialization_required" --arg initializationSpec "$initialization_spec" --argjson authorized "$(jq -r .authorized <<< "$item")" \
      '{schema:1,id:$id,runtime:$runtime,version:$version,artifactSHA256:$sha,profileDirectory:$profile,environmentSHA256:$envSHA,configurationSHA256:$configSHA,preflightPassed:$preflight,nativeInitializationRequired:$initializationRequired,nativeInitializationSpecificationSHA256:$initializationSpec,operatorAuthorized:$authorized,installed:true,accepted:false}' | atomic_json "$candidate"
  done < <(jq -c '.agents[]' <<< "$input")
}

adapter_accept_agents() {
  local strict=${1:-false} item id runtime version architecture active_plan artifact candidate target executable proof env_file
  active_plan=$(jq -er .plan "$directory/receipt.json" 2>/dev/null || printf '%s' "$plan")
  architecture=$(uname -m); case "$architecture" in x86_64) architecture=amd64;; aarch64) architecture=arm64;; esac
  while IFS= read -r item; do
    id=$(jq -er .id <<< "$item"); runtime=$(jq -er .runtime <<< "$item"); version=$(jq -er .version <<< "$item")
    candidate="$directory/agents/$id/candidate.$active_plan.json"
    [[ -f "$candidate" && ! -L "$candidate" ]] || die 'Native agent candidate receipt is unavailable'
    artifact=$(jq -c --arg runtime "$runtime" --arg version "$version" --arg arch "$architecture" '.agentArtifacts[$runtime][$version][$arch]' "$directory/manifest.$active_plan.json")
    [[ $(jq -er .artifactSHA256 "$candidate") == "$(jq -er .sha256 <<< "$artifact")" && $(jq -er .version "$candidate") == "$version" ]] || die 'Native agent version differs from the active signed release'
    cp -- "$candidate" "$directory/agents/$id/receipt.json"
    if [[ $(jq -r .authorized <<< "$item") != true ]] || ! jq -e '.acceptanceArguments!=null' <<< "$artifact" >/dev/null; then
      printf 'Agent %s: acceptance pending operator authorization or an owned product acceptance contract\n' "$id"
      [[ "$strict" != true ]] || die 'Native agent acceptance is pending'; continue
    fi
    if [[ $(jq -r .service <<< "$item") == none && "$strict" != true ]]; then printf 'Agent %s: manual startup selected; run agents-accept after starting its prepared launcher\n' "$id"; continue; fi
    target="$directory/agents/$id/artifacts/$(jq -er .sha256 <<< "$artifact")"; env_file=$(jq -er .environmentFile <<< "$item")
    adapter_assert_agent_inputs "$item" "$candidate" "$target"
    executable="$target/$(jq -er .executable <<< "$artifact")"; proof="$directory/agents/$id/acceptance.$active_plan.json"
    adapter_arguments "$(jq -c .acceptanceArguments <<< "$artifact")" "$(jq -er .profileDirectory <<< "$item")" "$env_file" "$target"
    adapter_native_command "$(jq -er .profileDirectory <<< "$item")" timeout 330 "$executable" "${HIVE_AGENT_ARGUMENTS[@]}" < /dev/null > "$proof" 2> "$proof.log" || die 'Native agent acceptance failed; inspect its protected result and log'
    [[ $(stat -c %s "$proof") -le 65536 ]] || die 'Native acceptance response exceeds its evidence bound'
    jq -e --arg version "$version" '.ok==true and .version==$version' "$proof" >/dev/null || die 'Native agent has not passed its product acceptance contract'
    jq --arg accepted "$(date -u +%Y-%m-%dT%H:%M:%SZ)" --arg evidence "$(digest "$proof")" '.accepted=true|.acceptedAt=$accepted|.acceptanceProofSHA256=$evidence' "$candidate" | atomic_json "$directory/agents/$id/receipt.json"
  done < <(jq -c '.agents[]' <<< "$input")
}

adapter_agents_service() {
  local action=$1 item id unit launch_plan
  launch_plan=$(jq -r '.plan' "$directory/receipt.json" 2>/dev/null || printf '%s\n' "$plan")
  while IFS= read -r item; do
    id=$(jq -er .id <<< "$item"); unit="hive-$installation-$id.service"
    [[ $(jq -r .service <<< "$item") == user ]] || continue
    if [[ "$action" == stop ]]; then
      [[ ! -f "$directory/agents/$id/unit.json" ]] || systemctl --user stop "$unit"
      continue
    fi
    if [[ $(jq -r .authorized <<< "$item") != true ]]; then
      [[ ! -f "$directory/agents/$id/unit.json" ]] || systemctl --user stop "$unit"
      printf 'Agent %s: installed; explicit operator/provider authorization is pending\n' "$id"; continue
    fi
    local candidate="$directory/agents/$id/candidate.$launch_plan.json"
    adapter_assert_agent_inputs "$item" "$candidate" "$directory/agents/$id/artifacts/$(jq -er .artifactSHA256 "$candidate")"
    local units; units=${XDG_CONFIG_HOME:-${HOME:?}/.config}/systemd/user
    install -d -m 700 "$units"
    [[ ! -f "$units/$unit" || -f "$directory/agents/$id/unit.json" ]] || die 'An existing service with this name is not installer-owned'
    {
      printf '[Unit]\nDescription=Hive managed native agent\nAfter=network-online.target\n[Service]\nType=simple\n'
      printf 'ExecStart=%s/agents/%s/run.%s\nRestart=on-failure\nRestartSec=10\nUMask=0077\nNoNewPrivileges=true\n[Install]\nWantedBy=default.target\n' "$directory" "$id" "$launch_plan"
    } > "$units/$unit"
    jq -n --arg unit "$unit" '{unit:$unit}' | atomic_json "$directory/agents/$id/unit.json"
    systemctl --user daemon-reload
    systemctl --user enable "$unit"
    systemctl --user restart "$unit"
    systemctl --user is-active --quiet "$unit"
    [[ ! -f "$directory/agents/$id/candidate.$launch_plan.json" ]] || cp -- "$directory/agents/$id/candidate.$launch_plan.json" "$directory/agents/$id/receipt.json"
  done < <(jq -c '.agents[]' <<< "$input")
}

adapter_profile_digest() {
  local profile=$1
  { tree_digest "$profile"; (cd "$profile"; while IFS= read -r -d '' path; do printf '%s\0%s\0' "$path" "$(readlink -- "$path")"; done < <(find . -type l -print0 | sort -z)); } | sha256sum | cut -d ' ' -f1
}

adapter_snapshot_profiles() {
  local item id profile link resolved snapshot map='{}'
  [[ $(jq '.agents|length' <<< "$input") != 0 ]] || return 0
  install -d -m 700 "$directory/agent-profiles"
  while IFS= read -r item; do
    id=$(jq -er .id <<< "$item"); profile=$(jq -er .profileDirectory <<< "$item")
    [[ -d "$profile" && ! -L "$profile" ]] || die 'Native profile is unavailable'
    adapter_profile_boundary "$profile"
    while IFS= read -r -d '' link; do
      [[ $(readlink -- "$link") != /* ]] || die 'Profile contains an absolute link requiring explicit adoption'
      resolved=$(readlink -f -- "$link")
      [[ "$resolved" == "$profile/"* ]] || die 'A profile link escapes the selected profile'
    done < <(find "$profile" -type l -print0)
    snapshot="$directory/agent-profiles/$id.tgz"
    tar --hard-dereference -czf "$snapshot.partial" -C "$profile" .
    gzip -t "$snapshot.partial"; mv -T "$snapshot.partial" "$snapshot"
    map=$(jq --arg id "$id" --arg profile "$profile" --arg sha "$(digest "$snapshot")" --arg state "$(adapter_profile_digest "$profile")" '.+{($id):{profileDirectory:$profile,archiveSHA256:$sha,stateSHA256:$state}}' <<< "$map")
  done < <(jq -c '.agents[]' <<< "$input")
  printf '%s\n' "$map" | atomic_json "$directory/agent-profiles/profiles.json"
}

adapter_restore_profiles() {
  local restored=$1 item id profile expected staged
  [[ $(jq '.agents|length' <<< "$input") != 0 ]] || return 0
  while IFS= read -r item; do
    id=$(jq -er .id <<< "$item"); profile=$(jq -er .profileDirectory <<< "$item")
    jq -e --arg id "$id" --arg profile "$profile" '.[$id].profileDirectory==$profile' "$restored/agent-profiles/profiles.json" >/dev/null || die 'Native profile restore target differs from the original'
    [[ $(adapter_profile_digest "$profile") == "$(jq -er --arg host "$host" --arg id "$id" '.hosts[$host].currentProfileSHA256[$id]' "$directory/reconciliation.$plan.json")" ]] || die 'Native profile changed after reconciliation'
    expected=$(jq -er --arg id "$id" '.[$id].archiveSHA256' "$restored/agent-profiles/profiles.json")
    [[ $(digest "$restored/agent-profiles/$id.tgz") == "$expected" ]] || die 'Native profile archive checksum differs'
    staged="$profile.restore-$plan"
    [[ ! -e "$staged" && ! -L "$staged" ]] || die 'An interrupted profile restore requires inspection'
    install -d -m 700 "$staged"
    tar -xzf "$restored/agent-profiles/$id.tgz" -C "$staged" --no-same-owner --same-permissions
    [[ $(adapter_profile_digest "$staged") == "$(jq -er --arg id "$id" '.[$id].stateSHA256' "$restored/agent-profiles/profiles.json")" ]] || die 'Native profile restore verification failed'
    mv -T -- "$profile" "$profile.pre-restore-$plan"
    mv -T -- "$staged" "$profile"
  done < <(jq -c '.agents[]' <<< "$input")
}

adapter_inference_probe() {
  local item id endpoint model temporary
  while IFS= read -r item; do
    id=$(jq -er .id <<< "$item"); endpoint=$(jq -er .endpoint <<< "$item"); model=$(jq -er .model.id <<< "$item")
    temporary="$directory/inference-checks/$id"; install -d -m 700 "$temporary"
    local -a options=(--max-time 120)
    local ca header; ca=$(jq -r '.caFile // empty' <<< "$item"); header=$(jq -r '.authHeaderFile // empty' <<< "$item")
    [[ -z "$ca" ]] || options+=(--cacert "$ca")
    if [[ -n "$header" ]]; then
      [[ -f "$header" && ! -L "$header" ]] || die 'Protected inference credential file is missing'
      local permissions; permissions=$(stat -c %a "$header"); (( (8#$permissions & 077)==0 )) || die 'Inference credentials must be owner-only'
      [[ $(stat -c %s "$header") -le 16384 ]] || die 'Inference credential header is too large'
      local contents; contents=$(cat -- "$header")
      [[ "$contents" =~ ^Authorization:\ Bearer\ [A-Za-z0-9._~-]+$ ]] || die 'Expected a single scoped Authorization header'
      options+=(--header "@$header")
    fi
    local protocol base spec
    protocol=$(jq -r '.protocol // "openai"' <<< "$item"); base=${endpoint%/}
    # A stale successful receipt cannot survive a new failed verification attempt.
    [[ ! -e "$temporary/receipt.json" ]] || mv -T "$temporary/receipt.json" "$temporary/previous-receipt.json"
    if [[ "$protocol" == ollama ]]; then
      adapter_curl "${options[@]}" --output "$temporary/models.json" "$base/api/tags"
      jq -e --arg model "$model" '.models|any(.[];(.name // .model)==$model)' "$temporary/models.json" >/dev/null || die 'Configured external Ollama model was not discovered'
      jq -n --arg model "$model" '{model:$model,messages:[{role:"user",content:"Reply with OK."}],options:{num_predict:64,temperature:0},think:false,stream:false}' > "$temporary/request.json"
      adapter_curl "${options[@]}" --header 'Content-Type: application/json' --data-binary "@$temporary/request.json" --output "$temporary/generation.json" "$base/api/chat"
      jq -e '.message.content|type=="string" and length>0' "$temporary/generation.json" >/dev/null || die 'External Ollama generation did not return content'
      jq '.stream=true' "$temporary/request.json" > "$temporary/stream-request.json"
      adapter_curl "${options[@]}" --no-buffer --dump-header "$temporary/stream.headers" --header 'Content-Type: application/json' --data-binary "@$temporary/stream-request.json" --output "$temporary/stream.txt" "$base/api/chat"
      grep -qiE '^content-type: *application/x-ndjson' "$temporary/stream.headers" || die 'External Ollama stream has an invalid media type'
      jq -se '.[-1].done==true and any(.[];(.message.content // "")|length>0)' "$temporary/stream.txt" >/dev/null || die 'External Ollama stream did not return completed content'
    else
      [[ "$base" == */v1 ]] || base+=/v1
      adapter_curl "${options[@]}" --output "$temporary/models.json" "$base/models"
      jq -e --arg model "$model" '.data|any(.[];.id==$model)' "$temporary/models.json" >/dev/null || die 'Configured external model was not discovered'
      jq -n --arg model "$model" --arg engine "$(jq -r .engine <<< "$item")" '{model:$model,messages:[{role:"user",content:"Reply with OK."}],max_tokens:64,temperature:0,stream:false} + (if $engine=="llamacpp" then {chat_template_kwargs:{enable_thinking:false}} else {} end)' > "$temporary/request.json"
      adapter_curl "${options[@]}" --header 'Content-Type: application/json' --data-binary "@$temporary/request.json" --output "$temporary/generation.json" "$base/chat/completions"
      jq -e '.choices|any(.[]; .message.content|type=="string" and length>0)' "$temporary/generation.json" >/dev/null || die 'External model generation did not return content'
      jq '.stream=true' "$temporary/request.json" > "$temporary/stream-request.json"
      adapter_curl "${options[@]}" --no-buffer --dump-header "$temporary/stream.headers" --header 'Content-Type: application/json' --data-binary "@$temporary/stream-request.json" --output "$temporary/stream.txt" "$base/chat/completions"
      grep -qiE '^content-type: *text/event-stream' "$temporary/stream.headers" || die 'External model stream has an invalid media type'
      grep -qE '^data: *\[DONE\]' "$temporary/stream.txt" || die 'External model stream did not complete'
      sed -n 's/^data: *//p' "$temporary/stream.txt" | sed '/^\[DONE\]/d' | jq -se 'any(.[];any(.choices[]?;(.delta.content // "")|length>0))' >/dev/null || die 'External model stream returned no content'
    fi
    spec=$(jq -Sc '{engine,protocol:(.protocol // "openai"),endpoint,model}' <<< "$item" | sha256sum | cut -d ' ' -f1)
    jq -n --arg id "$id" --arg model "$model" --arg spec "$spec" '{schema:1,id:$id,model:$model,specSHA256:$spec,discovery:true,generation:true,streaming:true}' | atomic_json "$temporary/receipt.json"
  done < <(jq -c '.inference[]' <<< "$input")
}
