#!/usr/bin/env bash
# Backup and rehearsal retention on one host, transported verbatim by the controller after
# ownership-host.sh and rehearsal-copy-host.sh. Only JSON crosses the SSH boundary.
# retention-plan and retention-controller read only; retention-apply removes, under the
# controller lock, only the names the controller passes that this host still finds removable, and
# records what it removed under retention/. retention-release releases the restored copies of
# passed rehearsals (rehearsal-copy-host.sh) for the names the controller passes, keeping the
# newest keepFull; it never removes a backup or a rehearsal's evidence.
# On an installation with several hosts, pairs are removed in phases instead of retention-apply,
# each under this host's lock. retention-hold sets aside the names that this host still finds
# removable (renamed to .held-TOKEN-NAME beside them, where no command finds them) and records
# them in retention/hold-TOKEN.json. retention-decide records there the names the controller
# commits, once every host has set its names aside. retention-commit then removes the committed
# names and puts every other one back; without a recorded decision it only puts back. A decided
# hold is never put back and an undecided one never removed, so every host of one prune ends the
# same way. The report lists unfinished holds; the controller finishes them before a new prune,
# and retention-hold refuses while one exists.
set -Eeuo pipefail
umask 077
read -r input
directory=$(jq -er .directory <<< "$input")
installation=$(jq -er .installation <<< "$input")
host=$(jq -er .host <<< "$input")
action=$(jq -er .action <<< "$input")
die() { printf 'Hive host: %s\n' "$*" >&2; exit 1; }
trap 'if declare -F restore_installation_owner >/dev/null; then restore_installation_owner; fi' EXIT
[[ "$directory" =~ ^/[A-Za-z0-9_./-]+$ && "$directory" != *'/../'* && "$directory" != */.. && ${#directory} -gt 4 && ! -L "$directory" ]] || die 'Invalid installation path'
[[ "$installation" =~ ^[a-z][a-z0-9-]{0,47}$ && "$host" =~ ^[a-z][a-z0-9-]{0,47}$ ]] || die 'Invalid installation identity'
[[ -d "$directory" && -f "$directory/installation.json" && ! -L "$directory/installation.json" ]] || die 'Installation is not initialized'
[[ ! -L "$directory/controller.lock" ]] || die 'Unsafe controller lock'
# The lock every lifecycle step holds: nothing is listed or removed while one runs.
exec 9>"$directory/controller.lock"
flock -n 9 || die 'Another controller holds this host; backup retention runs once it finishes'
jq -e --arg id "$installation" --arg host "$host" '.installation==$id and .host==$host' "$directory/installation.json" >/dev/null || die 'Installation or host ownership differs'
identity=$(jq -er .uuid "$directory/installation.json")
keep=$(jq -er '.retention.keep' <<< "$input")
keep_days=$(jq -er '.retention.keepDays' <<< "$input")
keep_full=$(jq -r '.retention.keepFull // 1' <<< "$input")
[[ "$keep" =~ ^[0-9]+$ && "$keep" -ge 2 && "$keep_days" =~ ^[0-9]+$ && "$keep_full" =~ ^[0-9]+$ && "$keep_full" -ge 1 ]] || die 'Invalid retention settings'
declare -F hive_rehearsal_copy_plan >/dev/null || die 'Rehearsal copy definitions are missing'
name_pattern='^[a-zA-Z0-9][a-zA-Z0-9.-]{0,95}$'

# A lifecycle step between two host actions (upgrade, rollback, backup, restore, rehearse)
# leaves its transaction open; recovery may need any archive, so nothing is removed then.
if [[ -f "$directory/transaction.json" ]]; then
  phase=$(jq -r '.phase // "none"' "$directory/transaction.json" 2>/dev/null || printf 'unreadable\n')
  [[ "$phase" == complete || "$phase" == aborted ]] || die "The transaction is in phase $phase: finish or recover it first; backup retention removes nothing while one is open"
fi

# A scheduled prune names the controller it runs. It must be the one that installed the current
# release, checked here under the lock, so a stale schedule never prunes with other code.
installed_release=$(jq -r '.version // ""' "$directory/receipt.json" 2>/dev/null || true)
installed_controller=$(jq -r '.controllerSourceSHA256 // ""' "$directory/receipt.json" 2>/dev/null || true)
expected_controller=$(jq -r '.retention.controller // ""' <<< "$input")
if [[ -n "$expected_controller" ]]; then
  [[ "$expected_controller" =~ ^[a-f0-9]{64}$ ]] || die 'Invalid scheduled retention controller'
  [[ "$installed_controller" == "$expected_controller" ]] ||
    die "This installation runs the controller of release ${installed_release:-unknown} (${installed_controller:0:12}), not the one this scheduled prune runs (${expected_controller:0:12}). Nothing was removed. Point the schedule at the installation's controller with its ./hive.sh backups schedule enable"
fi

kib() { { du -sk --one-file-system -- "$1" 2>/dev/null || printf '0\n'; } | cut -f1; }
mtime() { stat -c %Y -- "$1" 2>/dev/null || printf '0\n'; }

# Every string in the installation's state files: transactions, receipts, recovery and
# supersession records, reconciliations, schema-upgrade and any other top-level JSON. A name,
# backup digest or path in any of them protects that archive. Plans protect a rehearsal only
# from the receipt, the transaction and the recovery records: every schema-upgrade record names
# its own plan, and would otherwise keep every rehearsal for ever.
references=$(mktemp); plans=$(mktemp)
trap 'rm -f -- "$references" "$plans"; if declare -F restore_installation_owner >/dev/null; then restore_installation_owner; fi' EXIT
for file in "$directory"/*.json; do
  [[ -f "$file" && ! -L "$file" ]] || continue
  jq -r --arg file "${file##*/}" '..|strings|select(test("[\t\n]")|not)|$file+"\t"+.' "$file" >> "$references" 2>/dev/null || true
  case ${file##*/} in
    receipt.json|transaction.json|recovery-transaction.*.json|recovery-supersession.*.json)
      jq -r --arg file "${file##*/}" '..|strings|select(test("^[a-f0-9]{64}$"))|$file+"\t"+.' "$file" >> "$plans" 2>/dev/null || true;;
  esac
done
current_plan=$(jq -r '.plan // empty' "$directory/receipt.json" 2>/dev/null || true)

# One JSON line per name in backups/, rehearsals/ and rehearsal-history/.
inventory() {
  local name backup rehearsal history created kind result sha plan uuid released receipt_ok restorable copy_released copy_at
  local -A names=()
  for name in "$directory"/backups/* "$directory"/rehearsals/* "$directory"/rehearsal-history/*; do
    [[ -e "$name" || -L "$name" ]] || continue
    names[${name##*/}]=1
  done
  for name in "${!names[@]}"; do
    backup="$directory/backups/$name" rehearsal="$directory/rehearsals/$name" history="$directory/rehearsal-history/$name"
    if [[ ! "$name" =~ $name_pattern || -L "$backup" || -L "$rehearsal" || -L "$history" || -L "$directory/backups" || -L "$directory/rehearsals" || -L "$directory/rehearsal-history" ]] ||
       [[ -e "$backup" && ! -d "$backup" ]] || [[ -e "$rehearsal" && ! -d "$rehearsal" ]] || [[ -e "$history" && ! -d "$history" ]]; then
      jq -nc --arg name "$name" '{name:$name,kind:"unrecognised",createdAt:0,backupKiB:0,rehearsalKiB:0,historyKiB:0}'
      continue
    fi
    receipt_ok=false sha='' result=none plan='' uuid='' released=false created=0 restorable=false copy_released=false copy_at=''
    if [[ -d "$backup" ]]; then
      if [[ -f "$backup/receipt.json" && ! -L "$backup/receipt.json" ]] && jq -e --arg uuid "$identity" --arg id "$installation" --arg host "$host" \
        '.uuid==$uuid and .installation==$id and .host==$host and .verified==true and (.sha256|test("^[a-f0-9]{64}$"))' "$backup/receipt.json" >/dev/null 2>&1; then
        receipt_ok=true; sha=$(jq -r .sha256 "$backup/receipt.json"); created=$(mtime "$backup/receipt.json")
      else created=$(mtime "$backup"); fi
    fi
    if [[ -d "$rehearsal" ]]; then
      if [[ -f "$rehearsal/result.json" && ! -L "$rehearsal/result.json" ]] && jq -e '(.result=="passed" or .result=="failed")' "$rehearsal/result.json" >/dev/null 2>&1; then
        result=$(jq -r .result "$rehearsal/result.json"); plan=$(jq -r '.candidatePlan // ""' "$rehearsal/result.json"); uuid=$(jq -r '.installationUUID // ""' "$rehearsal/result.json")
        [[ -d "$backup" ]] || created=$(mtime "$rehearsal/result.json")
        if [[ "$result" == passed && "$receipt_ok" == true ]] && jq -e --arg sha "$sha" --arg uuid "$identity" '.archiveSHA256==$sha and .installationUUID==$uuid and .isolated==true' "$rehearsal/result.json" >/dev/null; then restorable=true; else restorable=false; fi
      else result=incomplete; [[ -d "$backup" ]] || created=$(mtime "$rehearsal"); fi
      [[ ! -f "$rehearsal/resources-released.json" || -L "$rehearsal/resources-released.json" ]] || released=true
      if hive_rehearsal_copy_record "$rehearsal"; then copy_released=true; copy_at=$(jq -r '.releasedAt // ""' "$rehearsal/copy-released.json"); fi
    fi
    if [[ ! -d "$backup" && ! -d "$rehearsal" ]]; then created=$(mtime "$history"); fi
    if [[ -d "$backup" && -d "$rehearsal" && "$result" == passed && "$restorable" == true ]]; then kind=restorable
    elif [[ -d "$rehearsal" && "$result" == incomplete ]]; then kind=incomplete
    elif [[ -d "$backup" && -d "$rehearsal" && "$result" == failed ]]; then kind=failed
    # A passed rehearsal of other bytes, or of a backup that no longer verifies, restores nothing.
    elif [[ -d "$backup" && -d "$rehearsal" ]]; then kind=mismatched
    elif [[ -d "$backup" ]]; then kind=backup-only
    elif [[ -d "$rehearsal" ]]; then kind=orphan-rehearsal
    else kind=orphan-history; fi
    jq -nc --arg name "$name" --arg kind "$kind" --arg result "$result" --arg sha "$sha" --arg rehearsalSha "$(jq -r '.archiveSHA256 // ""' "$rehearsal/result.json" 2>/dev/null || true)" --arg plan "$plan" \
      --argjson created "$created" --argjson released "$released" --argjson copyReleased "$copy_released" --arg copyReleasedAt "$copy_at" --argjson backupKiB "$( [[ -d "$backup" ]] && kib "$backup" || printf 0)" \
      --argjson rehearsalKiB "$( [[ -d "$rehearsal" ]] && kib "$rehearsal" || printf 0)" --argjson historyKiB "$( [[ -d "$history" ]] && kib "$history" || printf 0)" \
      '{name:$name,kind:$kind,rehearsal:$result,backupSHA256:$sha,rehearsalArchiveSHA256:$rehearsalSha,candidatePlan:$plan,createdAt:$created,resourcesReleased:$released,copyReleased:$copyReleased,copyReleasedAt:(if $copyReleasedAt=="" then null else $copyReleasedAt end),backupKiB:$backupKiB,rehearsalKiB:$rehearsalKiB,historyKiB:$historyKiB}'
  done
}

# Why each entry stays, or none when the rules let it go.
decide() {
  local now=$1
  jq -sc --argjson keep "$keep" --argjson days "$keep_days" --argjson now "$now" --arg current "$current_plan" \
    --rawfile references "$references" --rawfile plans "$plans" '
    ($references|split("\n")|map(select(length>0)|split("\t")|{file:.[0],value:(.[1:]|join("\t"))})) as $refs |
    ($plans|split("\n")|map(select(length>0)|split("\t")|{file:.[0],value:.[1]})) as $plans |
    def named($e): [$refs[] | select(.value==$e.name or (.value|contains("/backups/"+$e.name+"/") or endswith("/backups/"+$e.name) or contains("/rehearsals/"+$e.name+"/") or endswith("/rehearsals/"+$e.name))
      or ($e.backupSHA256!="" and .value==$e.backupSHA256) or ($e.rehearsalArchiveSHA256!="" and .value==$e.rehearsalArchiveSHA256)) | .file] | unique;
    def planned($e): if $e.candidatePlan=="" then [] else [$plans[] | select(.value==$e.candidatePlan) | .file] | unique end;
    (map(select(.kind=="restorable"))|sort_by(-.createdAt, .name)|map(.name)) as $restorable |
    map(. as $e | ($restorable|index($e.name)) as $rank |
      .reasons = ([
        (if .kind=="backup-only" then "not rehearsed: retention keeps backups that have no rehearsal" else empty end),
        (if .kind=="incomplete" then "rehearsal has no result: review it" else empty end),
        (if .kind=="unrecognised" then "not an archive this controller wrote: review it" else empty end),
        (if $rank==0 then "newest restorable pair" elif $rank!=null and $rank<$keep then "one of the newest \($keep) restorable pairs" else empty end),
        (if $current!="" and .candidatePlan==$current then "the upgrade archive of the installed release (receipt.json)" else empty end),
        (planned($e)[] | select((.=="receipt.json" or .=="transaction.json") and $e.candidatePlan==$current|not) | "its plan is named by \(.)"),
        (named($e)[] | "named by \(.)"),
        (if .kind!="unrecognised" and ($now - .createdAt) < ($days*86400) then "newer than \($days) days" else empty end)
      ]))'
}

plan_entries() {
  local entries line name
  entries=$(inventory | decide "$(date +%s)")
  # Only an entry the rules would remove is checked for leftover containers.
  while IFS= read -r name; do
    [[ -n "$name" ]] || continue
    if containers_remain "$name"; then
      entries=$(jq -c --arg name "$name" 'map(if .name==$name then .reasons+=["rehearsal containers still exist: the next upgrade releases them"] else . end)' <<< "$entries")
    fi
  done < <(jq -r '.[]|select((.reasons|length)==0 and (.kind|IN("restorable","failed","mismatched","orphan-rehearsal","orphan-history")))|.name' <<< "$entries")
  entries=$(jq -c 'map(.remove=((.reasons|length)==0 and (.kind|IN("restorable","failed","mismatched","orphan-rehearsal","orphan-history"))))|sort_by(.createdAt,.name)' <<< "$entries")
  # Restored copies: releasing one never changes what is restorable, so it does not depend on the
  # rules above. The controller releases copies only of entries that it does not remove.
  jq -c --argjson copies "$(hive_rehearsal_copy_plan "$keep_full" | jq -sc .)" '
    map(. as $e | ([$copies[]|select(.name==$e.name)]) as $mine |
      .releaseCopy=([$mine[]|select(.release)]|length>0) |
      .releaseCopyKiB=([$mine[]|select(.release)|.kib]|add // 0) |
      .copyNote=([$mine[]|select(.release|not)|.reason|select(.!="")]|unique|join("; ")))' <<< "$entries"
}

# The set-aside path of NAME in PARENT (backups, rehearsals, rehearsal-history) under TOKEN.
token_pattern='^[a-f0-9]{16}$'
held_path() { printf '%s/%s/.held-%s-%s\n' "$directory" "$1" "$2" "$3"; }
hold_record() { printf '%s/retention/hold-%s.json\n' "$directory" "$1"; }
# Every unfinished hold on this host: [{token,names,decided,committed}].
holds() {
  local record
  for record in "$directory"/retention/hold-*.json; do
    [[ -f "$record" && ! -L "$record" ]] || continue
    jq -c '{token,names:(.names // []),decided:(.decided // false),committed:(.committed // [])}' "$record" 2>/dev/null ||
      jq -nc --arg file "${record##*/}" '{token:$file,names:[],decided:false,committed:[],unreadable:true}'
  done | jq -sc .
}
# Puts back what the hold TOKEN set aside, except the names in COMMITTED (already removed), and
# removes its record. A name whose original path exists again is left set aside and reported.
put_back() { # TOKEN [COMMITTED]
  local token=$1 committed=${2:-[]} record name parent held original kept=0
  record=$(hold_record "$token")
  [[ -f "$record" && ! -L "$record" ]] || return 0
  while IFS= read -r name; do
    [[ "$name" =~ $name_pattern ]] || continue
    jq -e --arg name "$name" 'index($name)!=null' <<< "$committed" >/dev/null && continue
    # The backup first: a rehearsal back before its backup would claim a pair that is not there.
    for parent in backups rehearsal-history rehearsals; do
      held=$(held_path "$parent" "$token" "$name"); original="$directory/$parent/$name"
      [[ -e "$held" && ! -L "$held" ]] || continue
      if [[ -e "$original" || -L "$original" ]]; then
        printf 'Hive host: %s exists again; the set-aside %s is kept for review\n' "$original" "$held" >&2; kept=1; continue
      fi
      mv -T -- "$held" "$original"
    done
  done < <(jq -r '.names[]?' "$record")
  ((kept == 0)) || return 1
  rm -f -- "$record"
}

report() {
  jq -c --arg host "$host" --arg directory "$directory" --argjson keep "$keep" --argjson days "$keep_days" --arg release "$(jq -r '.version // ""' "$directory/receipt.json" 2>/dev/null || true)" \
    --argjson free "$(df -Pk -- "$directory" | awk 'NR==2 {print $4}')" \
    --argjson keepFull "$keep_full" --argjson holds "$(holds)" '{schema:1,host:$host,directory:$directory,release:$release,keep:$keep,keepDays:$days,keepFull:$keepFull,freeKiB:$free,holds:$holds,held:([$holds[].names[]]|unique),entries:.}'
}

# Writes the prune record of REMOVED (a JSON array) under retention/.
prune_record() { # REMOVED
  local removed=$1 record
  [[ $(jq length <<< "$removed") != 0 ]] || return 0
  [[ ! -L "$directory/retention" ]] || die 'Unsafe retention record directory'
  install -d -m 700 "$directory/retention"
  record="$directory/retention/prune-$(date -u +%Y%m%dT%H%M%SZ)-$(openssl rand -hex 4).json"
  jq -n --argjson removed "$removed" --arg at "$(date -u +%FT%TZ)" --arg host "$host" --arg installation "$installation" --arg release "$(jq -r '.version // ""' "$directory/receipt.json" 2>/dev/null || true)" \
    --arg trigger "$(jq -r '.retention.trigger // "prune"' <<< "$input")" --argjson keep "$keep" --argjson days "$keep_days" \
    '{schema:1,at:$at,trigger:$trigger,installation:$installation,host:$host,release:$release,keep:$keep,keepDays:$days,removed:$removed,freedBytes:([$removed[].bytes]|add // 0),offHostCopies:"not touched"}' > "$record.tmp"
  chmod 600 "$record.tmp"; mv -T -- "$record.tmp" "$record"
}

case "$action" in
  retention-controller) jq -nc --arg release "$installed_release" --arg controller "$installed_controller" '{release:$release,controllerSourceSHA256:$controller}';;
  retention-plan) plan_entries | report;;
  retention-apply)
    requested=$(jq -c '.retention.remove // []' <<< "$input")
    jq -e 'type=="array" and all(.[]; type=="string")' <<< "$requested" >/dev/null || die 'Invalid retention request'
    entries=$(plan_entries)
    removed='[]' status=0
    # The controller's merged plan, reduced to what this host still finds removable now.
    while IFS= read -r name; do
      [[ "$name" =~ $name_pattern ]] || continue
      entry=$(jq -c --arg name "$name" '.[]|select(.name==$name)' <<< "$entries")
      # The rehearsal goes first: a backup left alone is never removed by retention, so an
      # interruption leaves nothing that claims to be restorable without being so.
      for path in "$directory/rehearsals/$name" "$directory/rehearsal-history/$name" "$directory/backups/$name"; do
        [[ ! -L "$path" ]] || { status=1; break; }
        [[ -e "$path" ]] || continue
        rm -rf --one-file-system -- "$path" || { status=1; break; }
      done
      ((status == 0)) || { printf 'Hive host: %s could not be removed completely; review it\n' "$name" >&2; break; }
      removed=$(jq -c --argjson entry "$entry" '.+[$entry|{name,kind,rehearsal,backupSHA256,createdAt:(.createdAt|todate),bytes:((.backupKiB+.rehearsalKiB+.historyKiB)*1024)}]' <<< "$removed")
    done < <(jq -r --argjson requested "$requested" '.[]|select(.remove and (.name as $name|$requested|index($name)!=null))|.name' <<< "$entries")
    prune_record "$removed"
    jq -c --argjson removed "$removed" '.removed=$removed' <<< "$(plan_entries | report)"
    exit "$status";;
  retention-hold)
    token=$(jq -r '.retention.token // ""' <<< "$input")
    [[ "$token" =~ $token_pattern ]] || die 'Invalid retention hold'
    requested=$(jq -c '.retention.hold // []' <<< "$input")
    jq -e 'type=="array" and all(.[]; type=="string")' <<< "$requested" >/dev/null || die 'Invalid retention request'
    # One prune at a time: an unfinished one is finished by the controller first, never here.
    [[ $(holds | jq length) == 0 ]] || die "An unfinished prune holds archives on this host ($(holds | jq -r '[.[].token]|join(", ")')); ./hive.sh backups prune --apply finishes it first. Nothing was set aside"
    entries=$(plan_entries)
    # The controller's merged plan, reduced to what this host still finds removable now.
    selected=$(jq -c --argjson requested "$requested" '[.[]|select(.remove and (.name as $name|$requested|index($name)!=null))]' <<< "$entries")
    [[ ! -L "$directory/retention" ]] || die 'Unsafe retention record directory'
    install -d -m 700 "$directory/retention"
    record=$(hold_record "$token")
    # The record comes first, so an interruption leaves nothing set aside that put_back cannot find.
    jq -n --arg token "$token" --arg at "$(date -u +%FT%TZ)" --argjson entries "$selected" \
      '{schema:1,token:$token,at:$at,names:[$entries[].name],decided:false,entries:$entries}' > "$record.tmp"
    chmod 600 "$record.tmp"; sync -- "$record.tmp" 2>/dev/null || true; mv -T -- "$record.tmp" "$record"
    status=0
    while IFS= read -r name; do
      [[ "$name" =~ $name_pattern ]] || continue
      # The rehearsal first, as retention-apply removes it first.
      for parent in rehearsals rehearsal-history backups; do
        path="$directory/$parent/$name"
        [[ ! -L "$path" ]] || { status=1; break; }
        [[ -e "$path" ]] || continue
        mv -T -- "$path" "$(held_path "$parent" "$token" "$name")" || { status=1; break; }
      done
      ((status == 0)) || { printf 'Hive host: %s could not be set aside; review it\n' "$name" >&2; break; }
    done < <(jq -r '.[].name' <<< "$selected")
    if ((status != 0)); then put_back "$token" || true; die 'Nothing was set aside on this host'; fi
    jq -nc --arg host "$host" --argjson requested "$requested" --argjson selected "$selected" \
      '{host:$host,held:[$selected[].name],refused:[$requested[]|select(. as $name|[$selected[].name]|index($name)|not)]}'
    ;;
  retention-decide)
    # The decision of the whole prune, recorded before any host removes anything. Repeating it
    # with the same names is harmless; another decision for the same hold is refused.
    token=$(jq -r '.retention.token // ""' <<< "$input")
    [[ "$token" =~ $token_pattern ]] || die 'Invalid retention hold'
    committed=$(jq -c '.retention.commit // []' <<< "$input")
    jq -e 'type=="array" and all(.[]; type=="string")' <<< "$committed" >/dev/null || die 'Invalid retention request'
    record=$(hold_record "$token")
    [[ -f "$record" && ! -L "$record" ]] || die "No hold $token on this host"
    if jq -e '.decided==true' "$record" >/dev/null; then
      jq -e --argjson committed "$committed" '(.committed|sort)==($committed|sort)' "$record" >/dev/null || die "Hold $token is already decided differently"
    else
      jq --argjson committed "$committed" --arg at "$(date -u +%FT%TZ)" '.decided=true | .decidedAt=$at | .committed=$committed' "$record" > "$record.tmp"
      chmod 600 "$record.tmp"; sync -- "$record.tmp" 2>/dev/null || true; mv -T -- "$record.tmp" "$record"
    fi
    jq -nc --arg host "$host" --arg token "$token" '{host:$host,token:$token,decided:true}'
    ;;
  retention-commit)
    token=$(jq -r '.retention.token // ""' <<< "$input")
    [[ "$token" =~ $token_pattern ]] || die 'Invalid retention hold'
    record=$(hold_record "$token")
    removed='[]' status=0 committed='[]'
    if [[ -f "$record" && ! -L "$record" ]]; then
      # Only a recorded decision removes; without one, everything goes back.
      if jq -e '.decided==true' "$record" >/dev/null; then committed=$(jq -c '.committed // []' "$record"); fi
      while IFS= read -r name; do
        [[ "$name" =~ $name_pattern ]] || continue
        for parent in rehearsals rehearsal-history backups; do
          path=$(held_path "$parent" "$token" "$name")
          [[ ! -L "$path" ]] || { status=1; break; }
          [[ -e "$path" ]] || continue
          rm -rf --one-file-system -- "$path" || { status=1; break; }
        done
        ((status == 0)) || { printf 'Hive host: the set-aside %s could not be removed completely; repeat backups prune --apply to finish\n' "$name" >&2; break; }
        removed=$(jq -c --argjson entry "$(jq -c --arg name "$name" '.entries[]|select(.name==$name)' "$record")" '.+[$entry|{name,kind,rehearsal,backupSHA256,createdAt:(.createdAt|todate),bytes:((.backupKiB+.rehearsalKiB+.historyKiB)*1024)}]' <<< "$removed")
      done < <(jq -r --argjson committed "$committed" '.names[]|select(. as $name|$committed|index($name)!=null)' "$record")
      # A decided hold stays until every committed name is gone, so a repeat finishes it.
      if ((status == 0)); then
        prune_record "$removed"
        put_back "$token" "$committed" || status=1
      fi
    fi
    jq -c --argjson removed "$removed" '.removed=$removed' <<< "$(plan_entries | report)"
    exit "$status";;
  retention-release)
    requested=$(jq -c '.retention.release // []' <<< "$input")
    jq -e 'type=="array" and all(.[]; type=="string")' <<< "$requested" >/dev/null || die 'Invalid retention request'
    trigger=$(jq -r '.retention.trigger // "prune"' <<< "$input")
    [[ "$trigger" =~ ^(prune|schedule|upgrade)$ ]] || die 'Invalid retention trigger'
    status=0
    if results=$(hive_release_rehearsal_copies "$keep_full" "$trigger" false "$requested"); then :; else status=1; fi
    [[ -n "$results" ]] || results='[]'
    released=$(jq -c '[.[]|select(.status=="released")]' <<< "$results")
    if [[ $(jq length <<< "$released") != 0 ]]; then
      [[ ! -L "$directory/retention" ]] || die 'Unsafe retention record directory'
      install -d -m 700 "$directory/retention"
      record="$directory/retention/release-$(date -u +%Y%m%dT%H%M%SZ)-$(openssl rand -hex 4).json"
      jq -n --argjson released "$released" --arg at "$(date -u +%FT%TZ)" --arg host "$host" --arg installation "$installation" --arg release "$(jq -r '.version // ""' "$directory/receipt.json" 2>/dev/null || true)" \
        --arg trigger "$trigger" --argjson keepFull "$keep_full" \
        '{schema:1,at:$at,trigger:$trigger,installation:$installation,host:$host,release:$release,keepFull:$keepFull,releasedCopies:$released,freedBytes:([$released[].releasedKiB]|add // 0|.*1024),backupsKept:true}' > "$record.tmp"
      chmod 600 "$record.tmp"; mv -T -- "$record.tmp" "$record"
    fi
    jq -nc --arg host "$host" --argjson results "$results" '{host:$host,released:[$results[]|select(.status=="released")],refused:[$results[]|select(.status!="released" and .status!="already-released")]}'
    exit "$status";;
  *) die 'Unknown retention action';;
esac
