#!/usr/bin/env bash
# Backup and restore-rehearsal retention. Every upgrade and rollback keeps a pre-change backup in
# backups/ID and its rehearsal in rehearsals/ID: the record that makes the backup restorable,
# and a full restored copy of the installation. Only the newest passed rehearsals (--keep-full,
# default 1) need that copy; the rehearse step and `backups prune --apply` release the others'
# copies and keep their evidence (rehearsal-copy-host.sh), which changes nothing about what can
# be restored. `backups list` shows every pair with what the retention rules decide;
# `backups prune` removes, only with --apply, the backup and rehearsal pairs the rules let go:
# directly under the host's lock on a single host, and in three steps, each under every host's
# lock, on an installation with several hosts (hive_retention_apply_hosts). Automatic pair
# pruning is opt-in.
# See deployment/BACKUPS.md#retention.

hive_retention_default_keep=5
hive_retention_default_keep_days=14

# installation.json "retention": {"keep": N, "keepDays": D, "auto": true|false, "schedule": "HH:MM"},
# all optional. schedule is the daily prune that install sets up (retention-schedule.sh).
hive_retention_validate() {
  jq -e 'has("retention")' "$HIVE_CONFIG" >/dev/null || return 0
  jq -e '
    .retention|type=="object" and (keys-["keep","keepDays","auto","schedule","multiHost","backup"]|length==0) and
    ((has("backup")|not) or (.backup|type=="object" and (keys-["keep"]|length==0) and ((.keep // 7)|type=="number" and floor==. and .>=1 and .<=365))) and
    ((.multiHost // false)|type=="boolean") and
    ((.keep // 5)|type=="number" and floor==. and .>=2 and .<=1000) and
    ((.keepDays // 14)|type=="number" and floor==. and .>=0 and .<=3650) and
    ((.auto // false)|type=="boolean") and
    ((has("schedule")|not) or (.schedule|type=="string" and test("^([01][0-9]|2[0-3]):[0-5][0-9]$")))
  ' "$HIVE_CONFIG" >/dev/null || hive_die 'retention is {"keep":N,"keepDays":D,"auto":true|false,"schedule":"HH:MM"}: keep the newest N restorable backup and rehearsal pairs (2 to 1000, default 5) and everything newer than D days (0 to 3650, default 14); auto (default false) opts the installation into pruning after each successful upgrade; schedule (24-hour local time, for example "03:40") has install set up a daily prune; multiHost (default false) lets auto and schedule remove pairs on an installation with several hosts; backup ({"keep":N}, 1 to 365, default 7) has the daily schedule take an online backup first and keep the newest N of them. See deployment/BACKUPS.md#retention'
}

# Automatic pair removal (retention.auto, the daily prune) on an installation with several hosts
# needs its own opt-in, retention.multiHost: earlier controllers never removed pairs there, so an
# installation file written for them does not start doing so. backups prune --apply needs none.
hive_retention_automatic() { # WHAT
  [[ $(jq '.hosts|length' "$HIVE_CONFIG") == 1 ]] && return 0
  jq -e '.retention.multiHost==true' "$HIVE_CONFIG" >/dev/null && return 0
  printf 'Hive: automatic backup pruning %s is off on an installation with several hosts until installation.json sets "retention": {"multiHost": true}; ./hive.sh backups prune --apply removes old pairs by hand. See deployment/BACKUPS.md#pruning-on-several-hosts\n' "$1" >&2
  return 1
}

# The settings this run uses: the command line, then the installation file, then the defaults.
hive_retention_settings() {
  local keep=$1 days=$2
  [[ -n "$keep" ]] || keep=$(jq -r --argjson default "$hive_retention_default_keep" '.retention.keep // $default' "$HIVE_CONFIG")
  [[ -n "$days" ]] || days=$(jq -r --argjson default "$hive_retention_default_keep_days" '.retention.keepDays // $default' "$HIVE_CONFIG")
  [[ "$keep" =~ ^[0-9]{1,4}$ ]] && ((10#$keep >= 2 && 10#$keep <= 1000)) || hive_die '--keep is the number of newest restorable pairs to keep, from 2 to 1000'
  [[ "$days" =~ ^[0-9]{1,4}$ ]] && ((10#$days <= 3650)) || hive_die '--keep-days is a number of days from 0 to 3650'
  printf '%d %d\n' "$((10#$keep))" "$((10#$days))"
}

# The number of newest passed rehearsals that keep their full restored copy: --keep-full, else 1.
# Deliberately not an installation-file setting: older controllers refuse unknown retention keys.
hive_retention_keep_full() {
  local full=${1:-1}
  [[ "$full" =~ ^[0-9]{1,4}$ ]] && ((10#$full >= 1 && 10#$full <= 1000)) || hive_die '--keep-full is the number of newest passed rehearsals that keep their full restored copy, from 1 to 1000'
  printf '%d\n' "$((10#$full))"
}

hive_retention_action() {
  local host=$1 action=$2 input=$3
  HIVE_HOST_ACTION=$action HIVE_RETENTION_INPUT=$input hive_host "$host" "$(cat "$HIVE_ROOT/scripts/suite/ownership-host.sh" "$HIVE_ROOT/scripts/suite/rehearsal-copy-host.sh" "$HIVE_ROOT/scripts/suite/retention-host.sh")"
}

# Each host's plan, as a JSON array. A name every host holds is one restore point of the
# installation: a host keeps it when any other host keeps it, so the hosts never disagree.
hive_retention_plans() {
  local input=$1 host plans='[]' plan
  while IFS= read -r host; do
    plan=$(hive_retention_action "$host" retention-plan "$input") || return 1
    plans=$(jq -c --argjson plan "$plan" '.+[$plan]' <<< "$plans")
  done < <(jq -r '.hosts|keys[]' "$HIVE_CONFIG")
  hive_retention_merge "$plans"
}
hive_retention_merge() {
  jq -c '
    . as $plans |
    [$plans[] | .host as $host | .entries[] | select(.remove|not) | {name,host:$host}] as $kept |
    map(.host as $host | .entries |= map(. as $e |
      ([$kept[] | select(.name==$e.name and .host!=$host) | .host]|unique) as $others |
      if .remove and ($others|length)>0 then .remove=false | .reasons+=["kept on host "+($others|join(", "))] else . end))' <<< "$1"
}

hive_retention_size() { awk -v k="$1" 'BEGIN { if (k >= 1048576) printf "%.1f GiB", k/1048576; else if (k >= 1024) printf "%.0f MiB", k/1024; else printf "%d KiB", k }'; }

# One line per entry: what it is, when it was made, its size, and why it stays. "release" keeps
# the pair and releases its restored copy. which=all lists every entry, which=changes only those
# that this prune removes or releases.
hive_retention_print() {
  local plans=$1 which=$2 host decision name kind created kib reasons copy_kib copy_at note text
  while IFS= read -r host; do
    jq -r --arg host "$host" '.[]|select(.host==$host)|"Host \(.host) (\(.directory)): keep the newest \(.keep) restorable pairs and everything newer than \(.keepDays) days, and the newest \(.keepFull // 1) full restored copies; \(.entries|length) entries"' <<< "$plans"
    while IFS=$'\t' read -r decision name kind created kib reasons copy_kib copy_at note; do
      text=$reasons
      case "$decision" in
        release) text="release copy, frees $(hive_retention_size "$copy_kib"); evidence and backup kept${reasons:+; pair kept: $reasons}";;
        keep)
          [[ "$copy_at" == - ]] || text="${text:+$text; }restored copy released ${copy_at:0:10}; evidence kept"
          [[ "$note" == - ]] || text="${text:+$text; }$note";;
      esac
      printf '  %-7s %-44s %-16s %s %9s%s\n' "$decision" "$name" "$kind" "$created" "$(hive_retention_size "$kib")" "${text:+  $text}"
    done < <(jq -r --arg host "$host" --arg which "$which" '.[]|select(.host==$host)|.entries[]|select($which=="all" or .remove or (.releaseCopy // false))|
      [(if .remove then "remove" elif (.releaseCopy // false) then "release" else "keep" end),.name,.kind,(if .createdAt>0 then (.createdAt|todate|.[0:10]) else "-" end),(.backupKiB+.rehearsalKiB+.historyKiB|tostring),(.reasons|join("; ")),
       ((.releaseCopyKiB // 0)|tostring),(.copyReleasedAt // "-"),(if (.copyNote // "")=="" then "-" else .copyNote end)]|@tsv' <<< "$plans")
  done < <(jq -r '.[].host' <<< "$plans")
}

hive_retention_total() { jq -r '[.[].entries[]|select(.remove)|(.backupKiB+.rehearsalKiB+.historyKiB)]|add // 0' <<< "$1"; }
# The copies this run releases: of every entry it keeps.
hive_retention_copies() { jq -c '[.[].entries[]|select((.releaseCopy // false) and (.remove|not))]' <<< "$1"; }

# Removes the plan's entries; prints the hosts' removal reports. One host removes them directly
# under its lock. With several hosts, a merged plan releases each host's lock before the next one
# is read, so protection may change on any host meanwhile: hive_retention_apply_hosts removes
# in steps instead.
hive_retention_apply() (
  local input=$1 plans=$2 trigger=$3 host request result results='[]' status=0
  local configuration
  configuration=$(hive_retention_snapshot_configuration) || { printf '[]\n'; return 1; }
  trap 'rm -f -- "$configuration"' EXIT
  local HIVE_CONFIG=$configuration
  if ! jq -e --slurpfile config "$HIVE_CONFIG" 'length==($config[0].hosts|length) and all(.[]; . as $plan | $config[0].hosts[$plan.host]!=null and $config[0].hosts[$plan.host].directory==$plan.directory)' <<< "$plans" >/dev/null; then
    printf 'Hive: backup retention host placement differs from its plan; nothing was removed.\n' >&2
    printf '[]\n'
    return 1
  fi
  if [[ $(jq '.hosts|length' "$HIVE_CONFIG") != 1 ]]; then hive_retention_apply_hosts "$input" "$plans" "$trigger"; return; fi
  while IFS= read -r host; do
    request=$(jq -c --argjson plans "$plans" --arg host "$host" --arg trigger "$trigger" '.remove=[$plans[]|select(.host==$host)|.entries[]|select(.remove)|.name] | .trigger=$trigger' <<< "$input")
    if [[ $(jq '.remove|length' <<< "$request") == 0 ]]; then continue; fi
    if result=$(hive_retention_action "$host" retention-apply "$request"); then :; else status=1; fi
    [[ -z "$result" ]] || results=$(jq -c --argjson result "$result" '.+[$result]' <<< "$results")
  done < <(jq -r '.hosts|keys[]' "$HIVE_CONFIG")
  printf '%s\n' "$results"
  return "$status"
)
# Pair removal on several hosts, in host order, each step under that host's lock:
#   1. hold:   each host sets aside the requested names that it still finds removable itself, so
#              that no other command finds them, and reports them. A name is committed only when
#              every host whose plan holds it set it aside; a host that refuses or fails commits
#              nothing anywhere, and every host puts back what it set aside.
#   2. decide: each host records the committed names in its hold record before any host removes
#              anything. From then on the prune only finishes forwards.
#   3. commit: each host removes the committed names and puts every other one back.
# A prune that stops after step 1 is put back, and one that stops after a host recorded the
# decision is finished, by hive_retention_finish at the next prune. Prints the hosts' reports;
# runs inside hive_retention_apply, on its configuration snapshot.
hive_retention_apply_hosts() {
  local input=$1 plans=$2 trigger=$3 token host request result held='{}' failed=false committed results='[]' status=0
  token=$(openssl rand -hex 8)
  while IFS= read -r host; do
    request=$(jq -c --argjson plans "$plans" --arg host "$host" --arg token "$token" --arg trigger "$trigger" \
      '.hold=[$plans[]|select(.host==$host)|.entries[]|select(.remove)|.name] | .token=$token | .trigger=$trigger' <<< "$input")
    [[ $(jq '.hold|length' <<< "$request") != 0 ]] || continue
    if result=$(hive_retention_action "$host" retention-hold "$request") && jq -e '.held|type=="array"' <<< "$result" >/dev/null 2>&1; then
      held=$(jq -c --arg host "$host" --argjson result "$result" '.[$host]=$result.held' <<< "$held")
      if [[ $(jq '.refused|length' <<< "$result") != 0 ]]; then
        printf 'Hive: host %s now keeps %s; they stay on every host.\n' "$host" "$(jq -r '.refused|join(", ")' <<< "$result")" >&2
      fi
    else
      # A host that may have set aside part of its request puts it back below.
      held=$(jq -c --arg host "$host" '.[$host]=(.[$host] // [])' <<< "$held")
      failed=true
      printf 'Hive: host %s could not set its backups aside (see above); nothing is removed on any host.\n' "$host" >&2
      break
    fi
  done < <(jq -r '.hosts|keys[]' "$HIVE_CONFIG")
  committed='[]'
  if [[ "$failed" != true ]]; then
    committed=$(jq -c --argjson held "$held" '
      [.[] | .host as $host | .entries[] | select(.remove) | {name, host:$host}] | group_by(.name) |
      map(select(all(.[]; . as $e | ($held[$e.host] // []) | index($e.name) != null)) | .[0].name)' <<< "$plans")
  fi
  if [[ $(jq length <<< "$committed") != 0 ]]; then
    while IFS= read -r host; do
      request=$(jq -c --arg token "$token" --argjson committed "$committed" '.token=$token | .commit=$committed' <<< "$input")
      if ! hive_retention_action "$host" retention-decide "$request" > /dev/null; then
        printf 'Hive: host %s did not record the prune decision (see above); nothing more is removed now. Repeat ./hive.sh backups prune --apply to finish it on every host.\n' "$host" >&2
        printf '[]\n'
        return 1
      fi
    done < <(jq -r 'keys[]' <<< "$held")
  fi
  while IFS= read -r host; do
    request=$(jq -c --arg token "$token" --arg trigger "$trigger" '.token=$token | .trigger=$trigger' <<< "$input")
    if result=$(hive_retention_action "$host" retention-commit "$request"); then :; else
      status=1
      printf 'Hive: host %s did not finish the prune (see above). Repeat ./hive.sh backups prune --apply to finish it; the decision is recorded on every host.\n' "$host" >&2
    fi
    [[ -z "$result" ]] || results=$(jq -c --argjson result "$result" '.+[$result]' <<< "$results")
  done < <(jq -r 'keys[]' <<< "$held")
  printf '%s\n' "$results"
  [[ "$failed" != true ]] || status=1
  return "$status"
}

# Finishes every unfinished prune that PLANS (hive_retention_plans) report: forwards on every host
# when any host recorded its decision, otherwise by putting everything back. Prints the hosts'
# reports; fails when a host did not finish.
hive_retention_finish() { # INPUT PLANS
  local input=$1 plans=$2 token committed host request result results='[]' status=0
  while IFS= read -r token; do
    [[ "$token" =~ ^[a-f0-9]{16}$ ]] || { printf 'Hive: an unreadable retention hold record (%s) needs review\n' "$token" >&2; status=1; continue; }
    committed=$(jq -c --arg token "$token" '[.[].holds[]?|select(.token==$token and .decided)|.committed]|first // null' <<< "$plans")
    if [[ "$committed" != null ]]; then
      printf 'Hive: finishing an interrupted prune: removing %s on every host that holds it.\n' "$(jq -r 'join(", ")' <<< "$committed")" >&2
    else
      printf 'Hive: putting back what an interrupted prune set aside (%s).\n' "$(jq -r --arg token "$token" '[.[].holds[]?|select(.token==$token)|.names[]]|unique|join(", ")' <<< "$plans")" >&2
    fi
    while IFS= read -r host; do
      if [[ "$committed" != null ]]; then
        request=$(jq -c --arg token "$token" --argjson committed "$committed" '.token=$token | .commit=$committed' <<< "$input")
        hive_retention_action "$host" retention-decide "$request" > /dev/null || { status=1; continue; }
      fi
      request=$(jq -c --arg token "$token" '.token=$token' <<< "$input")
      if result=$(hive_retention_action "$host" retention-commit "$request"); then :; else status=1; fi
      [[ -z "$result" ]] || results=$(jq -c --argjson result "$result" '.+[$result]' <<< "$results")
    done < <(jq -r --arg token "$token" '.[]|select(any(.holds[]?; .token==$token))|.host' <<< "$plans")
  done < <(jq -r '[.[].holds[]?.token]|unique[]' <<< "$plans")
  printf '%s\n' "$results"
  return "$status"
}

hive_retention_print_removed() {
  local host name kind created bytes
  while IFS=$'\t' read -r host name kind created bytes; do
    printf '  removed %s on %s (%s, %s, %s)\n' "$name" "$host" "$kind" "$created" "$(hive_retention_size "$((bytes / 1024))")"
  done < <(jq -r '.[] | .host as $host | .removed[] | [$host,.name,.kind,.createdAt[0:10],(.bytes|tostring)] | @tsv' <<< "$1")
}

# A scheduled prune adds the digest of the controller it runs; each host refuses unless its
# receipt names that controller.
hive_retention_input() {
  jq -nc --argjson keep "$1" --argjson days "$2" --argjson full "${3:-1}" --arg controller "${HIVE_RETENTION_CONTROLLER:-}" --arg source "$( (hive_controller_digest) 2>/dev/null || true)" \
    --argjson backupKeep "$(hive_retention_backup_keep)" \
    '{keep:$keep,keepDays:$days,keepFull:$full,backupKeep:$backupKeep,controllerSourceSHA256:$source} + (if $controller!="" then {controller:$controller} else {} end)'
}
# The number of scheduled backups (backups/scheduled-*) retention keeps: retention.backup.keep,
# 7 with retention.backup alone, and 0, keep them all, without retention.backup.
hive_retention_backup_keep() { jq -r 'if .retention.backup then (.retention.backup.keep // 7) else 0 end' "$HIVE_CONFIG" 2>/dev/null || printf '0\n'; }

# Releases the plan's restored copies on every host, each under its own lock. This never changes
# what can be restored. Prints the hosts' results.
hive_retention_release_copies() (
  local input=$1 plans=$2 trigger=$3 host request result results='[]' status=0
  local configuration
  configuration=$(hive_retention_snapshot_configuration) || { printf '[]\n'; return 1; }
  trap 'rm -f -- "$configuration"' EXIT
  local HIVE_CONFIG=$configuration
  if ! jq -e --slurpfile config "$HIVE_CONFIG" 'length==($config[0].hosts|length) and all(.[]; . as $plan | $config[0].hosts[$plan.host]!=null and $config[0].hosts[$plan.host].directory==$plan.directory)' <<< "$plans" >/dev/null; then
    printf 'Hive: backup retention host placement differs from its plan; no restored copy was released.\n' >&2
    printf '[]\n'
    return 1
  fi
  while IFS= read -r host; do
    request=$(jq -c --argjson plans "$plans" --arg host "$host" --arg trigger "$trigger" \
      '.release=[$plans[]|select(.host==$host)|.entries[]|select((.releaseCopy // false) and (.remove|not))|.name] | .trigger=$trigger' <<< "$input")
    if [[ $(jq '.release|length' <<< "$request") == 0 ]]; then continue; fi
    if result=$(hive_retention_action "$host" retention-release "$request"); then :; else status=1; fi
    [[ -z "$result" ]] || results=$(jq -c --argjson result "$result" '.+[$result]' <<< "$results")
  done < <(jq -r '.hosts|keys[]' "$HIVE_CONFIG")
  printf '%s\n' "$results"
  return "$status"
)
hive_retention_print_released() {
  local host path kib reason
  while IFS=$'\t' read -r host path kib; do
    printf '  released the restored copy of %s on %s (%s); its evidence and backup are kept\n' "$path" "$host" "$(hive_retention_size "$kib")"
  done < <(jq -r '.[] | .host as $host | .released[] | [$host,.path,(.releasedKiB|tostring)] | @tsv' <<< "$1")
  while IFS=$'\t' read -r host path reason; do
    printf '  kept the restored copy of %s on %s: %s\n' "$path" "$host" "$reason"
  done < <(jq -r '.[] | .host as $host | .refused[]? | [$host,(.path // "-"),(.reason // "refused")] | @tsv' <<< "$1")
}

# The operator may edit the installation file while a command runs. Keep planning,
# the final write guard and host transport bound to one private parsed snapshot.
# Callers own the returned file and install their cleanup trap in a subshell.
hive_retention_snapshot_configuration() {
  local snapshot
  snapshot=$(mktemp) || return 1
  if ! jq -ce 'if type=="object" then . else error("Installation configuration must be an object") end' "$HIVE_CONFIG" > "$snapshot"; then
    rm -f -- "$snapshot"
    printf 'Hive: backup retention could not snapshot the installation configuration; nothing was removed.\n' >&2
    return 1
  fi
  printf '%s\n' "$snapshot"
}

# backups list | backups prune [--keep N] [--keep-days D] [--keep-full N] [--apply] | backups schedule ...
hive_backups_command() (
  local subcommand=${1:-list} host keep days full settings input plans total results removed copies copy_count copy_total status=0 options usage
  local configuration
  usage='Usage: hive.sh backups list|prune [--keep N] [--keep-days D] [--keep-full N] [--apply] | backups schedule enable|disable|status [--at HH:MM] | backups export ARCHIVE --to DESTINATION [--encrypt RECIPIENT] | backups import --from DIRECTORY [--identity FILE]'
  if [[ "$subcommand" == schedule ]]; then shift; hive_retention_schedule_command "$@"; return; fi
  if [[ "$subcommand" == export ]]; then (($# <= 2)) || hive_die 'Use: backups export ARCHIVE --to DESTINATION'; hive_backups_export "${2:-}"; return; fi
  if [[ "$subcommand" == import ]]; then (($# == 1)) || hive_die 'Use: backups import --from DIRECTORY'; hive_backups_import; return; fi
  [[ -z "${HIVE_BACKUP_TO:-}${HIVE_BACKUP_ENCRYPT:-}${HIVE_BACKUP_FROM:-}${HIVE_BACKUP_IDENTITY:-}" ]] || hive_die '--to, --encrypt, --from and --identity apply only to backups export and import'
  [[ -z "${HIVE_RETENTION_AT:-}" ]] || hive_die '--at applies only to backups schedule enable'
  configuration=$(hive_retention_snapshot_configuration) || return 1
  trap 'rm -f -- "$configuration"' EXIT
  local HIVE_CONFIG=$configuration
  (($# <= 1)) || hive_die "$usage"
  case "$subcommand" in list|prune) ;; *) hive_die "$usage";; esac
  [[ "$subcommand" == prune || "${HIVE_RETENTION_APPLY:-false}" != true ]] || hive_die '--apply applies only to backups prune'
  settings=$(hive_retention_settings "${HIVE_RETENTION_KEEP:-}" "${HIVE_RETENTION_KEEP_DAYS:-}"); read -r keep days <<< "$settings"
  full=$(hive_retention_keep_full "${HIVE_RETENTION_KEEP_FULL:-}")
  input=$(hive_retention_input "$keep" "$days" "$full")
  plans=$(hive_retention_plans "$input") || hive_die 'Backup retention could not read every host; nothing was removed. See above'
  if [[ $(jq '[.[].holds[]?]|length' <<< "$plans") != 0 ]]; then
    printf 'Hive: an interrupted prune set aside %s on %s.\n' \
      "$(jq -r '[.[].held[]?]|unique|join(", ")' <<< "$plans")" "$(jq -r '[.[]|select((.holds // [])|length>0)|.host]|join(", ")' <<< "$plans")" >&2
    if [[ "$subcommand" == prune && "${HIVE_RETENTION_APPLY:-false}" == true ]]; then
      results=$(hive_retention_finish "$input" "$plans") || { hive_retention_print_removed "${results:-[]}"; hive_die 'The interrupted prune could not be finished on every host; nothing else was changed. See above, then repeat the command'; }
      hive_retention_print_removed "$results"
      plans=$(hive_retention_plans "$input") || hive_die 'Backup retention could not read every host; nothing else was removed. See above'
    else
      printf 'Hive: backups prune --apply finishes it before it decides again.\n' >&2
    fi
  fi
  total=$(hive_retention_total "$plans")
  copies=$(hive_retention_copies "$plans")
  copy_count=$(jq length <<< "$copies"); copy_total=$(jq '[.[].releaseCopyKiB]|add // 0' <<< "$copies")
  options=$( [[ -z "${HIVE_RETENTION_KEEP:-}" ]] || printf ' --keep %s' "$keep"; [[ -z "${HIVE_RETENTION_KEEP_DAYS:-}" ]] || printf ' --keep-days %s' "$days"; [[ -z "${HIVE_RETENTION_KEEP_FULL:-}" ]] || printf ' --keep-full %s' "$full")
  if [[ "$subcommand" == list ]]; then
    hive_retention_print "$plans" all
    printf 'The rules above remove %s entries, freeing %s: ./hive.sh backups prune shows them, and --apply removes them.\n' "$(jq '[.[].entries[]|select(.remove)]|length' <<< "$plans")" "$(hive_retention_size "$total")"
    if ((copy_count > 0)); then printf 'They also release %s restored copies, freeing %s; their backups stay restorable.\n' "$copy_count" "$(hive_retention_size "$copy_total")"; fi
    if declare -F hive_backup_exports_print >/dev/null; then hive_backup_exports_print; fi
    return
  fi
  hive_retention_print "$plans" changes
  printf 'Kept: %s entries (./hive.sh backups list shows why).\n' "$(jq '[.[].entries[]|select(.remove|not)]|length' <<< "$plans")"
  if [[ "${HIVE_RETENTION_APPLY:-false}" != true ]]; then
    if [[ $(jq '[.[].entries[]|select(.remove)]|length' <<< "$plans") == 0 && "$copy_count" == 0 ]]; then
      printf 'Dry run: nothing would be removed.\n'
      return
    fi
    if [[ $(jq '[.[].entries[]|select(.remove)]|length' <<< "$plans") != 0 ]]; then
      printf 'Dry run: %s entries would be removed, freeing %s. Nothing was removed. Remove them with: ./hive.sh backups prune%s --apply\n' \
        "$(jq '[.[].entries[]|select(.remove)]|length' <<< "$plans")" "$(hive_retention_size "$total")" "$options"
    fi
    if ((copy_count > 0)); then
      printf 'Dry run: %s restored copies would be released, freeing %s; their backups stay restorable and their evidence is kept. Nothing was released. Release them with: ./hive.sh backups prune%s --apply\n' \
        "$copy_count" "$(hive_retention_size "$copy_total")" "$options"
    fi
    return
  fi
  if [[ $(jq '[.[].entries[]|select(.remove)]|length' <<< "$plans") == 0 && "$copy_count" == 0 ]]; then printf 'Nothing to remove.\n'; return; fi
  if [[ $(jq '[.[].entries[]|select(.remove)]|length' <<< "$plans") != 0 ]]; then
    if results=$(hive_retention_apply "$input" "$plans" "${HIVE_RETENTION_TRIGGER:-prune}"); then :; else
      hive_retention_print_removed "$results"
      hive_die 'Backup retention stopped on a host; see above. What it removed is recorded in that host'"'"'s retention/ directory'
    fi
    hive_retention_print_removed "$results"
    removed=$(jq '[.[].removed[]]|length' <<< "$results")
    printf 'Removed %s entries, freeing %s. Each host recorded them under retention/ in its installation directory; copies kept on other machines were not touched.\n' \
      "$removed" "$(hive_retention_size "$(jq '[.[].removed[].bytes]|add // 0|./1024|floor' <<< "$results")")"
  fi
  if ((copy_count > 0)); then
    if results=$(hive_retention_release_copies "$input" "$plans" "${HIVE_RETENTION_TRIGGER:-prune}"); then :; else status=1; fi
    [[ -n "$results" ]] || results='[]'
    hive_retention_print_released "$results"
    printf 'Released %s restored copies, freeing %s. Their backups stay restorable; ./hive.sh rehearse --archive ID rebuilds a full copy. Each host recorded them under retention/.\n' \
      "$(jq '[.[].released[]]|length' <<< "$results")" "$(hive_retention_size "$(jq '[.[].released[].releasedKiB]|add // 0' <<< "$results")")"
    ((status == 0)) || printf 'Hive: a restored copy could not be released; it is kept unchanged (see above).\n' >&2
  fi
  return "$status"
)

# After a successful upgrade: prune only with explicit opt-in (retention.auto). The
# upgrade has already completed, so a retention problem is reported, never fatal.
hive_retention_after_upgrade() (
  local settings keep days input plans results removed
  local configuration
  configuration=$(hive_retention_snapshot_configuration) || return 0
  trap 'rm -f -- "$configuration"' EXIT
  local HIVE_CONFIG=$configuration
  if ! jq -e '.retention.auto==true' "$HIVE_CONFIG" >/dev/null; then
    printf 'Hive: backup retention after upgrades is off by default (retention.auto); ./hive.sh backups prune previews old backups and rehearsals\n' >&2
    return 0
  fi
  hive_retention_automatic "after upgrades" || return 0
  if ! settings=$( (hive_retention_settings '' '') 2>&1); then printf 'Hive: backup retention skipped: %s\n' "$settings" >&2; return 0; fi
  read -r keep days <<< "$settings"
  input=$(hive_retention_input "$keep" "$days")
  if ! plans=$( (hive_retention_plans "$input") ); then
    printf 'Hive: the upgrade is complete; backup retention did not run, see above. Run ./hive.sh backups prune later\n' >&2
    return 0
  fi
  if [[ $(jq '[.[].holds[]?]|length' <<< "$plans") != 0 ]]; then
    printf 'Hive: the upgrade is complete; an interrupted prune is unfinished, so backup retention did not run. Run ./hive.sh backups prune --apply to finish it\n' >&2
    return 0
  fi
  if [[ $(jq '[.[].entries[]|select(.remove)]|length' <<< "$plans") == 0 ]]; then
    printf 'Backup retention: nothing to remove (keep the newest %s restorable pairs and everything newer than %s days).\n' "$keep" "$days"
    return 0
  fi
  if ! results=$( (hive_retention_apply "$input" "$plans" upgrade) ); then
    printf 'Hive: the upgrade is complete; backup retention stopped on a host, see above. Run ./hive.sh backups list\n' >&2
  fi
  [[ -n "$results" ]] || results='[]'
  printf 'Backup retention after the upgrade (keep the newest %s restorable pairs and everything newer than %s days):\n' "$keep" "$days"
  hive_retention_print_removed "$results"
  removed=$(jq '[.[].removed[]]|length' <<< "$results")
  printf 'Removed %s entries, freeing %s; recorded under retention/ on each host. Copies kept on other machines were not touched.\n' \
    "$removed" "$(hive_retention_size "$(jq '[.[].removed[].bytes]|add // 0|./1024|floor' <<< "$results")")"
)
