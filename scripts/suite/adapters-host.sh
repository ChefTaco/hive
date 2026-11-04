#!/usr/bin/env bash
# Definitions are transported with host-runtime.sh, never sourced from user input.
adapter_curl() { curl --fail --silent --show-error --proto '=https' --connect-timeout 10 --max-time 1800 --max-redirs 0 "$@"; }
adapter_download() { curl --fail --silent --show-error --proto '=https' --proto-redir '=https' --location --max-redirs 5 --connect-timeout 10 --max-time 7200 "$@"; }
adapter_atomic() { printf '%s\n' "$2" | atomic_json "$1"; }
adapter_preflight() {
  local item id runtime profile environment artifact architecture path permissions
  architecture=$(uname -m); case "$architecture" in x86_64) architecture=amd64;; aarch64) architecture=arm64;; *) die 'Unsupported host architecture';; esac
  while IFS= read -r item; do
    id=$(jq -er .id <<< "$item"); runtime=$(jq -er .runtime <<< "$item")
    profile=$(jq -er .profileDirectory <<< "$item"); environment=$(jq -er .environmentFile <<< "$item")
    [[ -d "$profile" && ! -L "$profile" && -f "$environment" && ! -L "$environment" ]] || die 'Agent profile or protected environment is missing'
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
  local item id runtime version architecture artifact sha target url executable argument profile environment temporary
  architecture=$(uname -m); case "$architecture" in x86_64) architecture=amd64;; aarch64) architecture=arm64;; esac
  while IFS= read -r item; do
    id=$(jq -er .id <<< "$item"); runtime=$(jq -er .runtime <<< "$item"); version=$(jq -er .version <<< "$item")
    artifact=$(jq -c --arg runtime "$runtime" --arg version "$version" --arg arch "$architecture" '.agentArtifacts[$runtime][$version][$arch]' "$directory/manifest.$plan.json")
    sha=$(jq -er .sha256 <<< "$artifact"); url=$(jq -er .url <<< "$artifact"); target="$directory/agents/$id/artifacts/$sha"
    install -d -m 700 "$directory/agents/$id/artifacts"
    if [[ ! -e "$target" ]]; then
      temporary="$target.partial"; [[ ! -e "$temporary" ]] || die 'Interrupted agent extraction needs inspection'
      install -d -m 700 "$temporary"
      adapter_download --output "$temporary/archive.tgz" "$url"
      [[ $(digest "$temporary/archive.tgz") == "$sha" ]] || die 'Agent artifact checksum differs'
      tar -tvzf "$temporary/archive.tgz" | awk 'substr($0,1,1)!="-" && substr($0,1,1)!="d" {bad=1} END {exit bad}' || die 'Agent archive contains unsupported links or special files'
      while IFS= read -r name; do [[ "$name" != /* && "$name" != *'..'* && "$name" != *\\* ]] || die 'Unsafe agent archive path'; done < <(tar -tzf "$temporary/archive.tgz")
      tar -xzf "$temporary/archive.tgz" -C "$temporary" --no-same-owner --no-same-permissions
      rm -- "$temporary/archive.tgz"
      chmod -R go-w "$temporary"
      executable=$(jq -er .executable <<< "$artifact")
      [[ -f "$temporary/$executable" && ! -L "$temporary/$executable" ]] || die 'Native launcher is absent'
      chmod 700 "$temporary/$executable"
      mv -T -- "$temporary" "$target"
    fi
    executable="$target/$(jq -er .executable <<< "$artifact")"
    profile=$(jq -er .profileDirectory <<< "$item"); environment=$(jq -er .environmentFile <<< "$item")
    local -a arguments=()
    while IFS= read -r argument; do
      case "$argument" in '@PROFILE@') argument=$profile;; '@ENV_FILE@') argument=$environment;; '@ARTIFACT@/'*) argument="$target/${argument#@ARTIFACT@/}";; esac
      arguments+=("$argument")
    done < <(jq -r '.arguments[]' <<< "$artifact")
    {
      printf '#!/usr/bin/env bash\nset -euo pipefail\ncd %q\nexec ' "$profile"
      printf '%q ' "$executable" "${arguments[@]}"
      printf '\n'
    } > "$directory/agents/$id/run.$plan.new"
    chmod 700 "$directory/agents/$id/run.$plan.new"
    mv -T "$directory/agents/$id/run.$plan.new" "$directory/agents/$id/run.$plan"
    jq -n --arg id "$id" --arg runtime "$runtime" --arg version "$version" --arg sha "$sha" --arg profile "$profile" --argjson authorized "$(jq -r .authorized <<< "$item")" \
      '{schema:1,id:$id,runtime:$runtime,version:$version,artifactSHA256:$sha,profileDirectory:$profile,operatorAuthorized:$authorized,installed:true,accepted:false}' | atomic_json "$directory/agents/$id/candidate.$plan.json"
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
