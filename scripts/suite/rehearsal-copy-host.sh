#!/usr/bin/env bash
# Definitions only. Transported before host-runtime.sh (rehearse) and before retention-host.sh
# (backups prune). Needs $directory, $installation, $host and $identity; host-runtime.sh also
# sets $plan and $input. Callers hold the controller lock on file descriptor 9.
#
# A passed rehearsal is a full restored copy of the installation. Once it has passed and its
# containers are gone, nothing reads that copy again: restore checks read result.json and restore
# extracts the backup archive afresh. Releasing the copy removes the restored directories listed
# below and keeps the evidence: result.json, isolated.json, resources-released.json, the
# resource-evidence directories, compose.json, receipt.json, installation.json, data-formats.json
# and the schema-upgrade and manifest records. Those stay byte-exact, so every controller since
# 2.4.0 still accepts the rehearsal (its resources-released.json matches isolated.json) and the
# backup stays restorable. copy-released.json records what went. hive.sh rehearse --archive ID
# rebuilds a full copy.

# Only these go. Anything else, including files a later release adds, is kept.
hive_rehearsal_copy_members=(data config releases agents agent-profiles native-profiles)

# Rehearsal containers that still exist (for example after an interrupted rehearsal) keep it:
# their bind mounts are its files. The next upgrade's staging releases them.
containers_remain() {
  local name=$1 rehearsal=${2:-"$directory/rehearsals/$1"} project
  [[ -d "$rehearsal" ]] || return 1
  if [[ -f "$rehearsal/isolated.json" && ! -L "$rehearsal/isolated.json" ]]; then
    project=$(jq -r '.name // empty' "$rehearsal/isolated.json" 2>/dev/null || true)
  fi
  [[ -n "${project:-}" ]] || project="rehearsal-$installation-$host-$name"
  project=$(tr 'A-Z' 'a-z' <<< "$project" | tr -cd 'a-z0-9_-')
  command -v docker >/dev/null 2>&1 || return 0
  local found; found=$(docker ps -aq --filter "label=com.docker.compose.project=$project" 2>/dev/null) || return 0
  [[ -n "$found" ]]
}

hive_rehearsal_copy_sha() { sha256sum -- "$1" | cut -d ' ' -f1; }
hive_rehearsal_copy_kib() { { du -sk --one-file-system -- "$@" 2>/dev/null || printf '0\n'; } | awk '{s+=$1} END {print s+0}'; }

# The rehearsal, or a retained attempt of it in rehearsal-history/NAME/, holds its released record.
hive_rehearsal_copy_record() { # DIR
  local record="$1/copy-released.json"
  [[ -f "$record" && ! -L "$record" ]] || return 1
  jq -e --arg uuid "$identity" '.schema==1 and .installationUUID==$uuid and (.released|type=="array")' "$record" >/dev/null 2>&1
}

# Why a rehearsal's copy cannot be released now, or nothing when it can. These are the checks of
# host-runtime.sh's hive_release_rehearsal_resources, which every controller since 2.4.0 runs on
# each upgrade and rollback, plus: the rehearsal passed, its resources are already released (that
# record matches isolated.json), no container remains, and nothing in it is a symlink.
# QUICK=true skips hashing the archive (plans and listings); a release always hashes it.
hive_rehearsal_copy_refusal() { # DIR NAME QUICK
  local restored=$1 name=$2 quick=${3:-false} spec result backup_receipt archive_sha path member
  spec="$restored/isolated.json"; result="$restored/result.json"; backup_receipt="$directory/backups/$name/receipt.json"
  [[ "$name" =~ ^[a-zA-Z0-9][a-zA-Z0-9.-]{0,95}$ ]] || { printf 'not a rehearsal name\n'; return; }
  [[ "$restored" == "$directory/rehearsals/$name" || "$restored" == "$directory/rehearsal-history/$name/attempt."* ]] || { printf 'not a rehearsal directory\n'; return; }
  for path in "$directory/rehearsals" "$directory/rehearsal-history" "$directory/rehearsal-history/$name" "$directory/backups" "$directory/backups/$name"; do
    [[ ! -L "$path" ]] || { printf 'a symlink in its path\n'; return; }
  done
  for path in "$restored" "$spec" "$result" "$backup_receipt" "$directory/backups/$name/state.tar.gz" "$restored/resources-released.json"; do
    [[ -e "$path" && ! -L "$path" ]] || { printf '%s is missing or a symlink\n' "${path#"$directory/"}"; return; }
  done
  [[ -d "$restored" ]] || { printf 'not a directory\n'; return; }
  jq -e '.result=="passed"' "$result" >/dev/null 2>&1 || { printf 'the rehearsal did not pass\n'; return; }
  jq -e --arg uuid "$identity" --arg id "$installation" --arg host "$host" \
    '.uuid==$uuid and .installation==$id and .host==$host and .verified==true and (.sha256|test("^[a-f0-9]{64}$"))' "$backup_receipt" >/dev/null 2>&1 || { printf 'its backup receipt does not verify\n'; return; }
  archive_sha=$(jq -r .sha256 "$backup_receipt")
  if [[ "$quick" != true ]]; then
    [[ $(hive_rehearsal_copy_sha "$directory/backups/$name/state.tar.gz") == "$archive_sha" ]] || { printf 'its backup archive checksum differs\n'; return; }
  fi
  jq -e --arg uuid "$identity" --arg sha "$archive_sha" \
    '.schema==1 and .installationUUID==$uuid and .archiveSHA256==$sha and .isolated==true and .portsPublished==false and
     .result=="passed" and (.candidatePlan|test("^[a-f0-9]{64}$"))' "$result" >/dev/null 2>&1 || { printf 'its result does not match its backup\n'; return; }
  jq -e --arg name "rehearsal-$installation-$host-$name" --arg base "$directory/rehearsals/$name/" '
    .name==$name and .include==null and (.services|type=="object" and length>0) and
    (.services|all(.ports==null and .network_mode==null and .external_links==null and .links==null and .container_name==null and .extends==null and
      .environment.HIVE_REHEARSAL=="true" and
      all(.volumes[]?; .type=="bind" and (.source|startswith($base) and (split("/")|index("..")==null))) and
      all(.env_file[]?; type=="string" and startswith($base) and (split("/")|index("..")==null)))) and
    ((.volumes // {})|length==0) and (.networks|type=="object" and length>0 and
      all((keys|sort)==["driver","internal"] and .internal==true and .driver=="bridge"))' "$spec" >/dev/null 2>&1 || { printf 'its isolated Compose definition does not verify\n'; return; }
  # Without this record, the next upgrade would run docker compose on isolated.json, which names
  # the files a release removes. Its resources are released first, by that upgrade.
  jq -e --arg sha "$archive_sha" --arg uuid "$identity" --arg spec "$(hive_rehearsal_copy_sha "$spec")" \
    '.archiveSHA256==$sha and .installationUUID==$uuid and .composeSHA256==$spec and .resourcesReleased==true' \
    "$restored/resources-released.json" >/dev/null 2>&1 || { printf 'its containers have not been released yet: the next upgrade releases them\n'; return; }
  for member in "${hive_rehearsal_copy_members[@]}"; do
    [[ ! -L "$restored/$member" ]] || { printf '%s is a symlink\n' "$member"; return; }
  done
  for path in "$restored"/.integrity-* "$restored"/.releasing.*; do
    [[ ! -L "$path" ]] || { printf '%s is a symlink\n' "${path##*/}"; return; }
  done
  if containers_remain "$name" "$restored"; then printf 'rehearsal containers still exist\n'; return; fi
}

# The restored copy is still there: a listed member, a scratch directory or an unfinished release.
hive_rehearsal_copy_full() { # DIR
  local member path
  for member in "${hive_rehearsal_copy_members[@]}"; do [[ ! -e "$1/$member" ]] || return 0; done
  for path in "$1"/.integrity-* "$1"/.releasing.*; do [[ ! -e "$path" ]] || return 0; done
  return 1
}

# Releases one rehearsal's restored copy; prints one JSON line. Returns 1 when refused or failed.
# Idempotent: an unfinished release (a .releasing.* directory left by an interruption) is finished,
# and its contents count as released.
hive_release_rehearsal_copy() { # DIR NAME TRIGGER RELEASE CONTROLLER
  local restored=$1 name=$2 trigger=$3 release=$4 controller=$5 refusal trash member path kib record released at
  local -a moved=()
  record="$restored/copy-released.json"
  if hive_rehearsal_copy_record "$restored"; then
    for path in "$restored"/.releasing.*; do
      [[ -e "$path" && ! -L "$path" ]] || continue
      rm -rf --one-file-system -- "$path" || { jq -nc --arg name "$name" --arg path "${restored#"$directory/"}" '{name:$name,path:$path,status:"failed",reason:"an earlier release could not be finished"}'; return 1; }
    done
    jq -nc --arg name "$name" --arg path "${restored#"$directory/"}" '{name:$name,path:$path,status:"already-released"}'
    return 0
  fi
  [[ ! -e "$record" && ! -L "$record" ]] || { jq -nc --arg name "$name" --arg path "${restored#"$directory/"}" '{name:$name,path:$path,status:"refused",reason:"copy-released.json is not valid: review it"}'; return 1; }
  refusal=$(hive_rehearsal_copy_refusal "$restored" "$name" false)
  if [[ -n "$refusal" ]]; then
    jq -nc --arg name "$name" --arg path "${restored#"$directory/"}" --arg reason "$refusal" '{name:$name,path:$path,status:"refused",reason:$reason}'
    return 1
  fi
  # On the same file system, so each move is a rename: the copy is gone from its place at once.
  trash=$(mktemp -d "$restored/.releasing.XXXXXX") || return 1
  for member in "${hive_rehearsal_copy_members[@]}"; do
    [[ -e "$restored/$member" ]] || continue
    mv -T -- "$restored/$member" "$trash/$member" || { jq -nc --arg name "$name" --arg path "${restored#"$directory/"}" --arg member "$member" '{name:$name,path:$path,status:"failed",reason:("could not move "+$member)}'; return 1; }
  done
  for path in "$restored"/.integrity-*; do
    [[ -e "$path" ]] || continue
    mv -T -- "$path" "$trash/${path##*/}" || return 1
  done
  # Everything moved by this or an interrupted earlier pass.
  while IFS= read -r -d '' path; do moved+=("$path"); done < <(find "$restored" -mindepth 2 -maxdepth 2 -path "$restored/.releasing.*/*" -printf '%f\0')
  kib=$(hive_rehearsal_copy_kib "$restored"/.releasing.*)
  released=$(printf '%s\n' "${moved[@]}" | jq -Rsc 'split("\n")|map(select(length>0))|unique')
  at=$(date -u +%Y-%m-%dT%H:%M:%SZ)
  jq -n --arg uuid "$identity" --arg archive "$(jq -r .archiveSHA256 "$restored/result.json")" --arg compose "$(hive_rehearsal_copy_sha "$restored/isolated.json")" \
    --arg result "$(hive_rehearsal_copy_sha "$restored/result.json")" --argjson released "$released" --argjson kib "$kib" --arg at "$at" \
    --arg trigger "$trigger" --arg release "$release" --arg controller "$controller" \
    '{schema:1,installationUUID:$uuid,archiveSHA256:$archive,composeSHA256:$compose,resultSHA256:$result,released:$released,releasedKiB:$kib,releasedAt:$at,trigger:$trigger,release:$release,controllerSourceSHA256:$controller}' > "$record.tmp" || return 1
  chmod 600 "$record.tmp" && sync -f "$record.tmp" && mv -T -- "$record.tmp" "$record" && sync -f "$restored" || return 1
  for path in "$restored"/.releasing.*; do
    [[ -e "$path" && ! -L "$path" ]] || continue
    rm -rf --one-file-system -- "$path" || { jq -nc --arg name "$name" --arg path "${restored#"$directory/"}" --argjson kib "$kib" '{name:$name,path:$path,status:"released",releasedKiB:$kib,warning:"its files are only partly removed; the next prune finishes them"}'; return 0; }
  done
  jq -nc --arg name "$name" --arg path "${restored#"$directory/"}" --argjson kib "$kib" --argjson released "$released" '{name:$name,path:$path,status:"released",releasedKiB:$kib,released:$released}'
}

# The selection, one JSON line per rehearsal or retained attempt that still holds a restored copy:
# {name, path, kind: rehearsal|attempt, release: true|false, reason, kib}. The newest KEEP passed
# rehearsals (by when they finished) keep their copies; every other one that can be released is.
# A retained attempt in rehearsal-history/ was superseded by a newer rehearsal of the same backup,
# so its copy is always released. Failed and incomplete rehearsals keep theirs: they are evidence.
hive_rehearsal_copy_plan() { # KEEP
  local keep=$1 restored name attempt refusal rank=0 at
  local -a passed=()
  for restored in "$directory"/rehearsals/*; do
    [[ -d "$restored" && ! -L "$restored" ]] || continue
    hive_rehearsal_copy_full "$restored" || continue
    jq -e --arg uuid "$identity" '.result=="passed" and .installationUUID==$uuid' "$restored/result.json" >/dev/null 2>&1 || continue
    at=$(stat -c %Y -- "$restored/result.json" 2>/dev/null || printf 0)
    passed+=("$at ${restored##*/}")
  done
  while read -r at name; do
    [[ -n "$name" ]] || continue
    restored="$directory/rehearsals/$name"
    if ((rank < keep)); then
      rank=$((rank + 1))
      jq -nc --arg name "$name" --arg path "rehearsals/$name" --argjson kib "$(hive_rehearsal_copy_kib "$restored")" --argjson keep "$keep" \
        '{name:$name,path:$path,kind:"rehearsal",release:false,keep:true,reason:(if $keep==1 then "newest full restored copy" else "one of the newest \($keep) full restored copies" end),kib:$kib}'
      continue
    fi
    refusal=$(hive_rehearsal_copy_refusal "$restored" "$name" true)
    jq -nc --arg name "$name" --arg path "rehearsals/$name" --arg refusal "$refusal" --argjson kib "$(hive_rehearsal_copy_kib "$restored")" \
      '{name:$name,path:$path,kind:"rehearsal",release:($refusal==""),reason:$refusal,kib:$kib}'
  done < <(printf '%s\n' "${passed[@]}" | sort -k1,1nr -k2,2 | grep -v '^$' || true)
  for attempt in "$directory"/rehearsal-history/*/attempt.*; do
    [[ -d "$attempt" && ! -L "$attempt" ]] || continue
    name=${attempt%/attempt.*}; name=${name##*/}
    hive_rehearsal_copy_full "$attempt" || continue
    jq -e '.result=="passed"' "$attempt/result.json" >/dev/null 2>&1 || continue
    refusal=$(hive_rehearsal_copy_refusal "$attempt" "$name" true)
    jq -nc --arg name "$name" --arg path "${attempt#"$directory/"}" --arg refusal "$refusal" --argjson kib "$(hive_rehearsal_copy_kib "$attempt")" \
      '{name:$name,path:$path,kind:"attempt",release:($refusal==""),reason:$refusal,kib:$kib}'
  done
}

# May a copy be released now? Under the host lock, never while another operation's transaction is
# open; OWN=true lets the rehearse step of this host action's own plan go ahead.
hive_rehearsal_copy_allowed() { # OWN
  local phase request
  [[ /proc/$BASHPID/fd/9 -ef "$directory/controller.lock" ]] && flock -n 9 || { printf 'the controller lock is not held\n'; return 1; }
  [[ -f "$directory/transaction.json" ]] || return 0
  phase=$(jq -r '.phase // "none"' "$directory/transaction.json" 2>/dev/null || printf 'unreadable\n')
  [[ "$phase" != complete && "$phase" != aborted ]] || return 0
  request=${input:-}; [[ -n "$request" ]] || request='{}'
  if [[ "$1" == true ]] && jq -e --arg plan "${plan:-}" --arg operation "$(jq -r '.operation // ""' <<< "$request")" \
      '.plan==$plan and .operation==$operation' "$directory/transaction.json" >/dev/null 2>&1; then return 0; fi
  printf 'the transaction is in phase %s\n' "$phase"; return 1
}

# Releases what the selection lets go: every copy with KEEP="all", or only the names in NAMES (a
# JSON array) for a prune that the controller planned. Prints a JSON array of results; returns 1
# when any requested release failed or was refused.
hive_release_rehearsal_copies() { # KEEP TRIGGER OWN [NAMES]
  local keep=$1 trigger=$2 own=$3 names=${4:-null} line status=0 result results='[]' why release controller request=${input:-}
  [[ -n "$request" ]] || request='{}'
  if ! why=$(hive_rehearsal_copy_allowed "$own"); then
    jq -nc --arg reason "$why" '[{status:"refused",reason:$reason}]'; return 1
  fi
  release=$(jq -r '.version // ""' "$directory/receipt.json" 2>/dev/null || true)
  controller=$(jq -r '(.controllerSourceSHA256 // "" | select(. != "")) // .retention.controllerSourceSHA256 // ""' <<< "$request" 2>/dev/null || true)
  [[ "$trigger" != rehearse ]] || release=${version:-$release}
  while IFS= read -r line; do
    [[ -n "$line" ]] || continue
    if [[ "$names" != null ]] && ! jq -e --arg name "$(jq -r .name <<< "$line")" 'index($name)!=null' <<< "$names" >/dev/null; then continue; fi
    if ! jq -e '.release' <<< "$line" >/dev/null; then
      # Kept by the selection, or held by a check: reported, not an error.
      jq -e '.keep==true' <<< "$line" >/dev/null || results=$(jq -c --argjson line "$line" '.+[$line|{name,path,status:"kept",reason}]' <<< "$results")
      continue
    fi
    if result=$(hive_release_rehearsal_copy "$directory/$(jq -r .path <<< "$line")" "$(jq -r .name <<< "$line")" "$trigger" "$release" "$controller"); then :; else status=1; fi
    [[ -z "$result" ]] || results=$(jq -c --argjson result "$result" '.+[$result]' <<< "$results")
  done < <(hive_rehearsal_copy_plan "$keep")
  printf '%s\n' "$results"
  return "$status"
}
