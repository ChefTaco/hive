#!/usr/bin/env bash
# Backup and rehearsal retention on one host, transported verbatim by the controller after
# ownership-host.sh. Only JSON crosses the SSH boundary. retention-plan reads only;
# retention-apply removes, under the controller lock, only the names the controller passes that
# this host still finds removable, and records what it removed under retention/.
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
[[ "$keep" =~ ^[0-9]+$ && "$keep" -ge 2 && "$keep_days" =~ ^[0-9]+$ ]] || die 'Invalid retention settings'
name_pattern='^[a-zA-Z0-9][a-zA-Z0-9.-]{0,95}$'

# A lifecycle step between two host actions (upgrade, rollback, backup, restore, rehearse)
# leaves its transaction open; recovery may need any archive, so nothing is removed then.
if [[ -f "$directory/transaction.json" ]]; then
  phase=$(jq -r '.phase // "none"' "$directory/transaction.json" 2>/dev/null || printf 'unreadable\n')
  [[ "$phase" == complete || "$phase" == aborted ]] || die "The transaction is in phase $phase: finish or recover it first; backup retention removes nothing while one is open"
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
  local name backup rehearsal history created kind result sha plan uuid released receipt_ok restorable
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
    receipt_ok=false sha='' result=none plan='' uuid='' released=false created=0 restorable=false
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
      --argjson created "$created" --argjson released "$released" --argjson backupKiB "$( [[ -d "$backup" ]] && kib "$backup" || printf 0)" \
      --argjson rehearsalKiB "$( [[ -d "$rehearsal" ]] && kib "$rehearsal" || printf 0)" --argjson historyKiB "$( [[ -d "$history" ]] && kib "$history" || printf 0)" \
      '{name:$name,kind:$kind,rehearsal:$result,backupSHA256:$sha,rehearsalArchiveSHA256:$rehearsalSha,candidatePlan:$plan,createdAt:$created,resourcesReleased:$released,backupKiB:$backupKiB,rehearsalKiB:$rehearsalKiB,historyKiB:$historyKiB}'
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

# Rehearsal containers that still exist (for example after an interrupted rehearsal) keep it:
# their bind mounts are its files. The next upgrade's staging releases them.
containers_remain() {
  local name=$1 rehearsal="$directory/rehearsals/$1" project
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
  jq -c 'map(.remove=((.reasons|length)==0 and (.kind|IN("restorable","failed","mismatched","orphan-rehearsal","orphan-history"))))|sort_by(.createdAt,.name)' <<< "$entries"
}

report() {
  jq -c --arg host "$host" --arg directory "$directory" --argjson keep "$keep" --argjson days "$keep_days" --arg release "$(jq -r '.version // ""' "$directory/receipt.json" 2>/dev/null || true)" \
    --argjson free "$(df -Pk -- "$directory" | awk 'NR==2 {print $4}')" \
    '{schema:1,host:$host,directory:$directory,release:$release,keep:$keep,keepDays:$days,freeKiB:$free,entries:.}'
}

case "$action" in
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
    if [[ $(jq length <<< "$removed") != 0 ]]; then
      [[ ! -L "$directory/retention" ]] || die 'Unsafe retention record directory'
      install -d -m 700 "$directory/retention"
      at=$(date -u +%Y%m%dT%H%M%SZ)
      record="$directory/retention/prune-$at-$(openssl rand -hex 4).json"
      jq -n --argjson removed "$removed" --arg at "$(date -u +%FT%TZ)" --arg host "$host" --arg installation "$installation" --arg release "$(jq -r '.version // ""' "$directory/receipt.json" 2>/dev/null || true)" \
        --arg trigger "$(jq -r '.retention.trigger // "prune"' <<< "$input")" --argjson keep "$keep" --argjson days "$keep_days" \
        '{schema:1,at:$at,trigger:$trigger,installation:$installation,host:$host,release:$release,keep:$keep,keepDays:$days,removed:$removed,freedBytes:([$removed[].bytes]|add // 0),offHostCopies:"not touched"}' > "$record.tmp"
      chmod 600 "$record.tmp"; mv -T -- "$record.tmp" "$record"
    fi
    jq -c --argjson removed "$removed" '.removed=$removed' <<< "$(plan_entries | report)"
    exit "$status";;
  *) die 'Unknown retention action';;
esac
