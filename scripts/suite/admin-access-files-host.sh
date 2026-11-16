#!/usr/bin/env bash
# Definitions only. Publication never sources environment text or recreates services.
admin_access_files_error() { printf 'Hive: administrator configuration publication refused: %s\n' "$1" >&2; return 1; }
admin_access_files_sha() {
  local record
  record=$(sha256sum -- "$1") || return 1; record=${record%% *}
  [[ "$record" =~ ^[a-f0-9]{64}$ ]] || return 1
  printf '%s\n' "$record"
}
admin_access_files_path() {
  local path=$1 part current=/
  local -a parts
  [[ "$path" =~ ^/[A-Za-z0-9_./-]+$ && "$path" != */ && "$path" != *'//'* && "$path" != *'/./'* && "$path" != */. && "$path" != *'/../'* && "$path" != */.. ]] || return 1
  IFS=/ read -r -a parts <<< "${path#/}"
  for part in "${parts[@]}"; do
    current=${current%/}/$part
    [[ ! -L "$current" ]] || return 1
    if [[ -e "$current" ]]; then
      local mode uid attributes
      attributes=$(stat -c '%a:%u' -- "$current") || return 1; mode=${attributes%:*}; uid=${attributes##*:}
      # A root sticky temporary ancestor is safe for an exclusively created private test/root directory.
      (( (8#$mode & 022)==0 )) || { [[ -d "$current" && "$uid" == 0 ]] && (( (8#$mode & 01000)!=0 )); } || return 1
    fi
  done
}
admin_access_files_regular() {
  local path=$1 private=${2:-false} mode
  admin_access_files_path "$path" && [[ -f "$path" && ! -L "$path" && $(stat -c %h -- "$path") == 1 ]] || return 1
  mode=$(stat -c %a -- "$path") || return 1
  [[ "$private" != true ]] || (( (8#$mode & 077)==0 ))
}
admin_access_files_root_file() {
  admin_access_files_regular "$1" true && [[ $(stat -c %u -- "$1") == 0 && $(stat -c %a -- "$1") == 600 ]]
}
admin_access_files_root_dir() {
  admin_access_files_path "$1" && [[ -d "$1" && $(stat -c %u -- "$1") == 0 && $(stat -c %a -- "$1") == 700 ]]
}
admin_access_files_control() {
  admin_access_files_regular "$1" true || return 1
  local uid owner
  uid=$(stat -c %u -- "$1"); owner=$(stat -c %u -- "$directory")
  [[ "$uid" == 0 || "$uid" == "$owner" ]]
}
admin_access_files_context() {
  [[ $(id -u) == 0 ]] || { admin_access_files_error 'sudo is required'; return 1; }
  [[ -n ${directory:-} && ${config:-} == "$directory/config" && ${compose:-} == "$directory/compose.json" ]] || return 1
  admin_access_files_path "$directory" && [[ -d "$directory" ]] || return 1
  admin_access_files_path "$config" && [[ -d "$config" ]] || return 1
  admin_access_files_control "$compose" || return 1
  admin_access_files_control "$directory/transaction.json" || return 1
  jq -e '.schema==1 and (.phase=="complete" or .phase=="aborted")' "$directory/transaction.json" >/dev/null || { admin_access_files_error 'a lifecycle transaction still requires recovery'; return 1; }
}
admin_access_files_journal_path() {
  local path=$1 root="$config/.admin-access" current part
  local -a parts
  [[ "$path" == "$root/"* ]] && admin_access_files_path "$path" || return 1
  current=$root
  if [[ -e "$current" ]]; then admin_access_files_root_dir "$current" || return 1; fi
  IFS=/ read -r -a parts <<< "${path#"$root/"}"
  for part in "${parts[@]}"; do
    current=$current/$part
    if [[ -e "$current" ]]; then admin_access_files_root_dir "$current" || return 1; fi
  done
}
admin_access_files_record() {
  local path=$1 kind sha=null attributes mode uid gid
  admin_access_files_path "$path" || return 1
  if [[ -d "$path" ]]; then kind=directory
  else admin_access_files_regular "$path" || return 1; kind=file; sha=$(admin_access_files_sha "$path") || return 1; fi
  attributes=$(stat -c '%a:%u:%g' -- "$path") || return 1
  mode=${attributes%%:*}; attributes=${attributes#*:}; uid=${attributes%%:*}; gid=${attributes#*:}
  jq -nc --arg path "$path" --arg kind "$kind" --arg sha "$sha" --arg mode "$mode" --arg uid "$uid" --arg gid "$gid" \
    '{path:$path,kind:$kind,mode:$mode,uid:$uid,gid:$gid} + (if $kind=="file" then {sha256:$sha} else {} end)'
}
admin_access_files_input_paths() {
  jq -er '[.services[]|(.env_file[]? | if type=="string" then . else .path end),(.volumes[]?|select(.read_only==true)|.source)]|unique[]' "$compose"
}
admin_access_files_inventory() (
  set -o pipefail
  local path item rows
  rows=$(admin_access_files_input_paths) || return 1
  while IFS= read -r path; do
    admin_access_files_record "$path" || return 1
    if [[ -d "$path" ]]; then
      find "$path" -mindepth 1 -print0 | sort -z | while IFS= read -r -d '' item; do admin_access_files_record "$item" || exit 1; done || return 1
    fi
  done <<< "$rows"
)
# The same path/metadata/content stream as deployment_inputs_digest, with optional staged file bytes.
admin_access_files_inputs_digest() (
  set -o pipefail
  local journal=${1:-} path item source index mode uid gid rows
  rows=$(admin_access_files_input_paths) || return 1
  while IFS= read -r path; do
    [[ -n "$path" ]] || continue
    admin_access_files_path "$path" || return 1
    if [[ -d "$path" ]]; then
      printf '%s\0' "$path"; stat -c '%a:%u:%g' -- "$path" || return 1
      find "$path" -mindepth 1 -type d -print0 | sort -z | while IFS= read -r -d '' item; do printf '%s\0' "$item"; stat -c '%a:%u:%g' -- "$item" || exit 1; done || return 1
      find "$path" -type f -print0 | sort -z | while IFS= read -r -d '' item; do admin_access_files_input_file "$item" "$journal" || exit 1; done || return 1
    else admin_access_files_input_file "$path" "$journal" || return 1; fi
  done <<< "$rows" | sha256sum | cut -d ' ' -f1
)
admin_access_files_input_file() {
  local path=$1 journal=$2 source=$1 index sha
  admin_access_files_regular "$path" || return 1
  if [[ -n "$journal" ]]; then
    index=$(jq -r --arg path "$path" '.files[]|select(.path==$path)|.index' "$journal/manifest.json") || return 1
    [[ -z "$index" ]] || source="$journal/after/$index"
  fi
  stat -c '%a:%u:%g' -- "$path" || return 1
  sha=$(admin_access_files_sha "$source") || return 1
  printf '%s  %s\0' "$sha" "$path"
}
# Selected-key parser. Double quotes use the writer's JSON codec, then undo Compose $$ escaping.
admin_access_env_value() {
  local file=$1 key=$2
  admin_access_files_regular "$file" true && [[ "$key" =~ ^[A-Z][A-Z0-9_]*$ ]] || return 1
  jq -Rrs --arg key "$key" '
    [split("\n")[]|select(test("^[ \\t]*(export[ \\t]+)?"+$key+"[ \\t]*="))] as $lines |
    if ($lines|length)==0 then "" elif ($lines|length)>1 then error("Selected environment key is duplicated") else
      ($lines[0]|sub("^[ \\t]*(export[ \\t]+)?"+$key+"[ \\t]*=";"")|sub("^[ \\t]+";"")|sub("[ \\t\\r]+$";"")) as $raw |
      if ($raw|startswith("\"")) then ($raw|fromjson|if type=="string" then gsub("\\$\\$";"$") else error("Invalid quoted value") end)
      elif ($raw|startswith("\u0027")) then
        if ($raw|endswith("\u0027")) and ($raw|length)>=2 and ($raw[1:-1]|contains("\u0027")|not) then $raw[1:-1] else error("Invalid quoted value") end
      else $raw end end' "$file"
}
admin_access_files_render() {
  local file=$1 updates=$2
  jq -Rrjs --slurpfile updates "$updates" '
    . as $raw|$updates[0] as $changes|($raw|split("\n")) as $lines |
    reduce ($changes|keys[]) as $key ({lines:$lines,add:[]};
      ([range(0;(.lines|length)) as $i|select(.lines[$i]|test("^[ \\t]*(export[ \\t]+)?"+$key+"[ \\t]*="))|$i]) as $matches |
      if ($matches|length)>1 then error("Duplicate selected environment key")
      else ($changes[$key]|gsub("\\$";"$$")|@json) as $encoded |
        if ($matches|length)==1 then .lines[$matches[0]]=($key+"="+$encoded)
        else .add += [$key+"="+$encoded] end end) |
    (.lines|join("\n")) + (if (.add|length)>0 then (if ($raw|length)>0 and ($raw|endswith("\n")|not) then "\n" else "" end)+(.add|join("\n"))+"\n" else "" end)
  ' "$file"
}
admin_access_files_checkpoint() { :; }
admin_access_files_write_json() {
  local path=$1
  (umask 077; cat > "$path") && chmod 600 "$path" && sync -f "$path" && sync -f "${path%/*}"
}
admin_access_files_lock() {
  local root="$config/.admin-access"
  if [[ ! -e "$root" ]]; then mkdir -m 700 -- "$root" && sync -f "$config" || return 1; fi
  admin_access_files_root_dir "$root" || return 1
  [[ ! -e "$root/.files.lock" ]] || admin_access_files_root_file "$root/.files.lock" || return 1
  if [[ ! -e "$root/.files.lock" ]]; then (umask 077; set -o noclobber; : > "$root/.files.lock") || return 1; fi
  exec 91>>"$root/.files.lock"; flock -n 91 || { admin_access_files_error 'another configuration publication is active'; return 1; }
}
admin_access_files_journal_metadata() {
  local journal=$1 path record current expected index
  admin_access_files_root_dir "$journal" && admin_access_files_root_file "$journal/state.json" && admin_access_files_root_file "$journal/manifest.json" && admin_access_files_root_file "$journal/updates.json" || return 1
  admin_access_files_root_dir "$journal/before" && admin_access_files_root_dir "$journal/after" || return 1
  jq -e --arg root "$directory" '.schema==1 and .directory==$root and (.files|type=="array") and (.watch|type=="array") and
    (.inputsBeforeSHA256|test("^[a-f0-9]{64}$")) and (.inputsAfterSHA256|test("^[a-f0-9]{64}$")) and
    all(.files[]; (.before.sha256|test("^[a-f0-9]{64}$")) and (.after.sha256|test("^[a-f0-9]{64}$")))' "$journal/manifest.json" >/dev/null || return 1
  jq -e --arg sha "$(admin_access_files_sha "$journal/manifest.json")" --arg updates "$(admin_access_files_sha "$journal/updates.json")" \
    '.schema==1 and .manifestSHA256==$sha and .updatesSHA256==$updates and (.phase=="prepared" or .phase=="complete")' "$journal/state.json" >/dev/null || return 1
  while IFS= read -r index; do
    [[ "$index" =~ ^[0-9]+$ ]] && admin_access_files_root_file "$journal/before/$index" && admin_access_files_root_file "$journal/after/$index" || return 1
    [[ $(admin_access_files_sha "$journal/before/$index") == "$(jq -r --argjson index "$index" '.files[]|select(.index==$index)|.before.sha256' "$journal/manifest.json")" \
      && $(admin_access_files_sha "$journal/after/$index") == "$(jq -r --argjson index "$index" '.files[]|select(.index==$index)|.after.sha256' "$journal/manifest.json")" ]] || return 1
  done < <(jq -r '.files[].index' "$journal/manifest.json")
}
admin_access_files_validate_journal() {
  local journal=$1 require_after=${2:-false} path record current expected index
  admin_access_files_journal_metadata "$journal" || return 1
  while IFS= read -r record; do
    path=$(jq -r .path <<< "$record") || return 1
    current=$(admin_access_files_record "$path") || return 1
    expected=$(jq -c --arg path "$path" '.files[]?|select(.path==$path)' "$journal/manifest.json") || return 1
    if [[ -z "$expected" ]]; then
      [[ $(jq -cS . <<< "$record") == "$(jq -cS . <<< "$current")" ]] || { admin_access_files_error 'unrelated protected input changed'; return 1; }
    else
      jq -e --argjson current "$current" '.before==$current or .after==$current' <<< "$expected" >/dev/null || { admin_access_files_error 'a publication target differs from both retained versions'; return 1; }
      if [[ "$require_after" == true ]]; then jq -e --argjson current "$current" '.after==$current' <<< "$expected" >/dev/null || return 1; fi
    fi
  done < <(jq -c '.watch[]' "$journal/manifest.json")
  # Inventory membership catches added or removed files and directories in read-only mounts.
  current=$(admin_access_files_inventory | jq -scS 'sort_by(.path)|unique_by(.path)|map(.path)') || return 1
  expected=$(jq -cS '.inputPaths' "$journal/manifest.json") || return 1
  [[ "$current" == "$expected" ]] || { admin_access_files_error 'read-only input membership changed'; return 1; }
}
admin_access_files_apply() {
  local journal=$1 record path index tmp kind uid gid mode
  admin_access_files_journal_metadata "$journal" || return 1
  if [[ $(jq -r .phase "$journal/state.json") != complete ]]; then
    admin_access_files_validate_journal "$journal" || return 1
    while IFS= read -r record; do
      path=$(jq -r .path <<< "$record"); index=$(jq -r .index <<< "$record"); kind=$(jq -r .kind <<< "$record")
      [[ $(admin_access_files_sha "$path") != "$(jq -r .after.sha256 <<< "$record")" ]] || continue
      if [[ "$kind" == pin ]]; then admin_access_files_validate_journal "$journal" || return 1; fi
      local current
      current=$(admin_access_files_record "$path") || return 1
      jq -e --argjson current "$current" '.before==$current or .after==$current' <<< "$record" >/dev/null || return 1
      uid=$(jq -r .after.uid <<< "$record"); gid=$(jq -r .after.gid <<< "$record"); mode=$(jq -r .after.mode <<< "$record")
      tmp=$(mktemp "$journal/.ready.XXXXXX") || return 1
      cat "$journal/after/$index" > "$tmp" && chown "$uid:$gid" "$tmp" && chmod "$mode" "$tmp" && sync -f "$tmp" || return 1
      [[ $(stat -c %d "$tmp") == "$(stat -c %d "${path%/*}")" ]] || return 1
      mv -T -- "$tmp" "$path" && sync -f "${path%/*}" || return 1
      admin_access_files_checkpoint "$kind" "$path" || return 1
    done < <(jq -c '.files[]' "$journal/manifest.json")
    [[ $(admin_access_files_inputs_digest) == "$(jq -r .inputsAfterSHA256 "$journal/manifest.json")" ]] || return 1
    admin_access_files_validate_journal "$journal" true || return 1
    jq '.phase="complete"' "$journal/state.json" | admin_access_files_write_json "$journal/state.next" || return 1
    mv -T "$journal/state.next" "$journal/state.json" && sync -f "$journal" || return 1
  fi
  jq '{changedFiles:[.files[]|select(.kind=="environment")|.path],journal:$journal,phase:"complete",inputsBeforeSHA256,inputsAfterSHA256}' --arg journal "$journal" "$journal/manifest.json"
}
admin_access_recover() (
  set -o pipefail
  local journal=$1
  admin_access_files_context && admin_access_files_journal_path "$journal" || return 1
  if [[ ! -e "$journal" ]]; then printf '{"changedFiles":[],"phase":"absent"}\n'; return 0; fi
  admin_access_files_lock && admin_access_files_apply "$journal"
)
admin_access_publish() (
  set -o pipefail
  local updates=$1 journal=$2 parent stage active initializer pin plan path sha index=0 file_updates after before record watch inputs_before inputs_after target kind metadata controls
  umask 077
  admin_access_files_context && admin_access_files_journal_path "$journal" || return 1
  jq -e 'type=="object" and length<=64 and all(to_entries[]; (.key|test("^/[A-Za-z0-9_./-]+$")) and (.value|type=="object" and length>0 and length<=128 and all(to_entries[]; (.key|test("^[A-Z][A-Z0-9_]*$")) and (.value|type=="string" and length<=1048576 and (contains("\u0000")|not)))))' <<< "$updates" >/dev/null || return 1
  if [[ ! -e "$journal" ]] && [[ $(jq length <<< "$updates") == 0 ]]; then printf '{"changedFiles":[],"phase":"unchanged"}\n'; return 0; fi
  admin_access_files_lock || return 1
  sha=$(jq -cS . <<< "$updates" | sha256sum | cut -d ' ' -f1) || return 1
  if [[ -e "$journal" ]]; then
    admin_access_files_journal_metadata "$journal" || return 1
    if [[ $(jq -r .phase "$journal/state.json") == complete && $(jq length <<< "$updates") == 0 ]]; then admin_access_files_apply "$journal"; return $?; fi
    [[ $(admin_access_files_sha "$journal/updates.json") == "$sha" ]] || { admin_access_files_error 'the retained publication has different requested values'; return 1; }
    admin_access_files_apply "$journal"; return $?
  fi
  parent=${journal%/*}; admin_access_files_root_dir "$parent" || return 1
  active="$directory/receipt.json"; initializer="$config/.initializer/receipt.json"
  admin_access_files_control "$active" && admin_access_files_control "$initializer" || return 1
  plan=$(jq -er '.plan|select(test("^[a-f0-9]{64}$"))' "$active") || return 1
  pin="$directory/deployment-inputs.$plan.json"
  admin_access_files_control "$pin" || return 1
  jq -e '.schema==1 and .phase=="complete" and (.files|type=="object" and length>0)' "$initializer" >/dev/null || return 1
  controls=$(for path in "$compose" "$directory/installation.json" "$active" "$initializer" "$pin"; do admin_access_files_record "$path" || exit 1; done | jq -sc .) || return 1
  inputs_before=$(admin_access_files_inputs_digest) || return 1
  [[ "$inputs_before" == "$(jq -er .sha256 "$pin")" && "$inputs_before" == "$(jq -er .deploymentInputSHA256 "$active")" ]] || { admin_access_files_error 'active deployment inputs changed'; return 1; }
  while IFS=$'\t' read -r path sha; do
    [[ "$path" == "$config/"* ]] && admin_access_files_regular "$path" && [[ $(admin_access_files_sha "$path") == "$sha" ]] || { admin_access_files_error 'an initializer fingerprint changed'; return 1; }
  done < <(jq -r '.files|to_entries[]|[.key,.value]|@tsv' "$initializer")
  while IFS= read -r path; do
    [[ "$path" != "$journal" && "$journal" != "$path/"* && "$path" != "$initializer" && "$initializer" != "$path/"* && "$path" != "$pin" && "$path" != "$active" ]] || return 1
  done < <(admin_access_files_input_paths)
  stage=$(mktemp -d "$parent/.publication.XXXXXXXX") || return 1
  chmod 700 "$stage" && mkdir -m 700 "$stage/before" "$stage/after" || return 1
  jq -cS . <<< "$updates" | admin_access_files_write_json "$stage/updates.json" || return 1
  : > "$stage/files.jsonl"; : > "$stage/watch.jsonl"; chmod 600 "$stage/files.jsonl" "$stage/watch.jsonl"
  admin_access_files_inventory > "$stage/input-inventory.jsonl" || return 1
  cat "$stage/input-inventory.jsonl" >> "$stage/watch.jsonl" || return 1
  jq -c '.[]' <<< "$controls" >> "$stage/watch.jsonl" || return 1
  while IFS= read -r path; do admin_access_files_record "$path" >> "$stage/watch.jsonl" || return 1; done < <(jq -r '.files|keys[]' "$initializer")
  while IFS= read -r path; do
    [[ "$path" == "$config/"*.env ]] && admin_access_files_regular "$path" true || return 1
    jq -e --arg path "$path" '.files[$path]!=null' "$initializer" >/dev/null || return 1
    file_updates="$stage/keys.json"; jq --arg path "$path" '.[$path]' <<< "$updates" > "$file_updates" || return 1
    admin_access_files_render "$path" "$file_updates" > "$stage/after/$index" || return 1
    if cmp -s "$path" "$stage/after/$index"; then rm -- "$stage/after/$index"; continue; fi
    cp -- "$path" "$stage/before/$index" && chmod 600 "$stage/before/$index" "$stage/after/$index" || return 1
    before=$(admin_access_files_record "$path") || return 1
    after=$(jq -c --arg sha "$(admin_access_files_sha "$stage/after/$index")" '.sha256=$sha' <<< "$before") || return 1
    jq -nc --arg path "$path" --argjson index "$index" --argjson before "$before" --argjson after "$after" '{path:$path,index:$index,kind:"environment",before:$before,after:$after}' >> "$stage/files.jsonl" || return 1
    ((index+=1))
  done < <(jq -r 'keys[]' <<< "$updates")
  # A temporary manifest supplies virtual environment bytes to the exact digest stream.
  jq -s '{files:.}' "$stage/files.jsonl" | admin_access_files_write_json "$stage/manifest.json" || return 1
  inputs_after=$(admin_access_files_inputs_digest "$stage") || return 1
  if (( index>0 )); then for kind in initializer pin receipt; do
    case $kind in
      initializer) path=$initializer; jq --slurpfile records "$stage/files.jsonl" 'reduce $records[] as $row (.; .files[$row.path]=$row.after.sha256)' "$path" > "$stage/after/$index";;
      pin) path=$pin; jq --arg sha "$inputs_after" '.sha256=$sha' "$path" > "$stage/after/$index";;
      receipt) path=$active; jq --arg sha "$inputs_after" '.deploymentInputSHA256=$sha' "$path" > "$stage/after/$index";;
    esac || return 1
    if cmp -s "$path" "$stage/after/$index"; then rm -- "$stage/after/$index"; continue; fi
    cp -- "$path" "$stage/before/$index" && chmod 600 "$stage/before/$index" "$stage/after/$index" || return 1
    before=$(admin_access_files_record "$path") || return 1
    after=$(jq -c --arg sha "$(admin_access_files_sha "$stage/after/$index")" '.sha256=$sha' <<< "$before") || return 1
    jq -nc --arg path "$path" --arg kind "$kind" --argjson index "$index" --argjson before "$before" --argjson after "$after" '{path:$path,index:$index,kind:$kind,before:$before,after:$after}' >> "$stage/files.jsonl" || return 1
    ((index+=1))
  done; fi
  jq -n --arg root "$directory" --arg before "$inputs_before" --arg after "$inputs_after" --slurpfile files "$stage/files.jsonl" --slurpfile watch "$stage/watch.jsonl" --slurpfile inventory "$stage/input-inventory.jsonl" \
    '{schema:1,directory:$root,files:$files,watch:($watch|sort_by(.path)|unique_by(.path)),inputPaths:($inventory|map(.path)|sort|unique),inputsBeforeSHA256:$before,inputsAfterSHA256:$after}' | admin_access_files_write_json "$stage/manifest.json" || return 1
  # Preparation is read-only. Never adopt a change that arrived while snapshots were staged.
  admin_access_files_checkpoint staged "$stage" || return 1
  [[ $(admin_access_files_inputs_digest) == "$inputs_before" ]] || return 1
  while IFS= read -r record; do
    path=$(jq -r .path <<< "$record") || return 1
    [[ $(admin_access_files_record "$path" | jq -cS .) == "$(jq -cS . <<< "$record")" ]] || return 1
  done < <(jq -c '.[]' <<< "$controls")
  while IFS=$'\t' read -r path sha; do
    admin_access_files_regular "$path" && [[ $(admin_access_files_sha "$path") == "$sha" ]] || return 1
  done < <(jq -r '.files|to_entries[]|[.key,.value]|@tsv' "$initializer")
  jq -n --arg sha "$(admin_access_files_sha "$stage/manifest.json")" --arg updates "$(admin_access_files_sha "$stage/updates.json")" '{schema:1,phase:"prepared",manifestSHA256:$sha,updatesSHA256:$updates}' | admin_access_files_write_json "$stage/state.json" || return 1
  chmod 600 "$stage/"*.jsonl "$stage/keys.json" 2>/dev/null || return 1
  find "$stage" -type f -exec sync -f {} \; && sync -f "$stage/before" && sync -f "$stage/after" && sync -f "$stage" || return 1
  mv -T -- "$stage" "$journal" && sync -f "$parent" || return 1
  admin_access_files_checkpoint prepared "$journal" && admin_access_files_apply "$journal"
)
