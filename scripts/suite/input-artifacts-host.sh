#!/usr/bin/env bash
# Definitions only. No environment file is sourced or printed.
deployment_inputs_digest() {
  local definition=$1 path paths
  paths=$(jq -r '[.services[]|(.env_file[]? | if type=="string" then . else .path end),(.volumes[]?|select(.read_only==true)|.source)]|unique[]' "$definition") || return 1
  while IFS= read -r path; do
    [[ -n "$path" ]] || continue
    [[ ! -L "$path" ]] || return 1
    if [[ -d "$path" ]]; then
      local unsupported
      unsupported=$(find "$path" ! -type f ! -type d -print -quit) || return 1
      [[ -z "$unsupported" ]] || return 1
      printf '%s\0' "$path" || return 1
      stat -c '%a:%u:%g' "$path" || return 1
      find "$path" -mindepth 1 -type d -print0 | sort -z | while IFS= read -r -d '' path; do printf '%s\0' "$path" || return 1; stat -c '%a:%u:%g' "$path" || return 1; done || return 1
      find "$path" -type f -print0 | sort -z | while IFS= read -r -d '' path; do stat -c '%a:%u:%g' "$path" || return 1; sha256sum --zero -- "$path" || return 1; done || return 1
    elif [[ -f "$path" ]]; then stat -c '%a:%u:%g' "$path" || return 1; sha256sum --zero -- "$path" || return 1
    else return 1; fi
  done <<< "$paths" | sha256sum | cut -d ' ' -f1
}
pin_deployment_inputs() {
  local definition=$1 current receipt="$directory/deployment-inputs.$plan.json"
  current=$(deployment_inputs_digest "$definition") || die 'Deployment input artifacts cannot be read safely'
  if [[ -f "$receipt" ]]; then
    [[ $(jq -er .sha256 "$receipt") == "$current" ]] || die 'Deployment input artifacts changed for this plan; restore the pinned files or review a new configurationRevision'
  else jq -n --arg sha "$current" '{schema:1,sha256:$sha}' | atomic_json "$receipt"; fi
}
assert_deployment_inputs() {
  local definition=$1 current
  current=$(deployment_inputs_digest "$definition") || die 'Deployment input artifacts cannot be verified'
  [[ "$current" == "$(jq -er .sha256 "$directory/deployment-inputs.$plan.json")" ]] || die 'Pinned deployment inputs changed; no further migrations or activation will run'
}
