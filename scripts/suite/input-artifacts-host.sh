#!/usr/bin/env bash
# Definitions only. No environment file is sourced or printed.
# Files the digest reads from a staged path instead of their own (path -> staged file). Empty
# except while a controller change is staged.
declare -gA HIVE_INPUT_OVERRIDES=()
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
    elif [[ -n "${HIVE_INPUT_OVERRIDES[$path]+set}" ]]; then
      # A staged replacement counts as if it were already in place (hive_memory_identity_relink).
      local staged=${HIVE_INPUT_OVERRIDES[$path]}
      [[ -f "$staged" && ! -L "$staged" ]] || return 1
      stat -c '%a:%u:%g' "$staged" || return 1
      printf '%s  %s\0' "$(sha256sum < "$staged" | cut -d ' ' -f1)" "$path" || return 1
    elif [[ -f "$path" ]]; then stat -c '%a:%u:%g' "$path" || return 1; sha256sum --zero -- "$path" || return 1
    else return 1; fi
  done <<< "$paths" | sha256sum | cut -d ' ' -f1
}
# A journaled memory identity change of this plan (hive_identity_commit) is finished, or refused,
# before any guard compares digests: a crash between its move and its pin is not an outside edit.
# hive_identity_resume accepts only files holding their journaled original or staged content and a
# result equal to the journaled digest, against this plan's own pin.
recover_deployment_inputs() {
  local definition=$1 journal="$directory/memory-identity.$plan.json"
  [[ -e "$journal" || -L "$journal" ]] || return 0
  [[ ! -L "$journal" && -f "$journal" ]] || die 'Unsafe memory identity journal'
  declare -F hive_identity_resume >/dev/null || die 'A memory identity change of this plan is pending, and this controller cannot finish it'
  hive_identity_resume "$definition" "$journal"
}
pin_deployment_inputs() {
  local definition=$1 current receipt="$directory/deployment-inputs.$plan.json"
  [[ ! -f "$receipt" ]] || recover_deployment_inputs "$definition"
  current=$(deployment_inputs_digest "$definition") || die 'Deployment input artifacts cannot be read safely'
  if [[ -f "$receipt" ]]; then
    [[ $(jq -er .sha256 "$receipt") == "$current" ]] || die 'Deployment input artifacts changed for this plan; restore the pinned files or review a new configurationRevision'
  else jq -n --arg sha "$current" '{schema:1,sha256:$sha}' | atomic_json "$receipt"; fi
}
assert_deployment_inputs() {
  local definition=$1 current
  recover_deployment_inputs "$definition"
  current=$(deployment_inputs_digest "$definition") || die 'Deployment input artifacts cannot be verified'
  [[ "$current" == "$(jq -er .sha256 "$directory/deployment-inputs.$plan.json")" ]] || die 'Pinned deployment inputs changed; no further migrations or activation will run'
}
