#!/usr/bin/env bash
# Backup and restore-rehearsal retention. Every upgrade and rollback keeps a pre-change backup in
# backups/ID and its rehearsal, the restored copy that makes it restorable, in rehearsals/ID. A
# rehearsal is a full restored installation, so these add up. `backups list` shows them with what
# the retention rules decide; `backups prune` removes, only with --apply, the backup and
# rehearsal pairs the rules let go, together, on every host; a successful upgrade runs it with
# the installation's settings. See deployment/BACKUPS.md#retention.

hive_retention_default_keep=5
hive_retention_default_keep_days=14

# installation.json "retention": {"keep": N, "keepDays": D, "auto": true|false}, all optional.
hive_retention_validate() {
  jq -e 'has("retention")' "$HIVE_CONFIG" >/dev/null || return 0
  jq -e '
    .retention|type=="object" and (keys-["keep","keepDays","auto"]|length==0) and
    ((.keep // 5)|type=="number" and floor==. and .>=2 and .<=1000) and
    ((.keepDays // 14)|type=="number" and floor==. and .>=0 and .<=3650) and
    ((.auto // true)|type=="boolean")
  ' "$HIVE_CONFIG" >/dev/null || hive_die 'retention is {"keep":N,"keepDays":D,"auto":true|false}: keep the newest N restorable backup and rehearsal pairs (2 to 1000, default 5) and everything newer than D days (0 to 3650, default 14); auto (default true) prunes after each successful upgrade. See deployment/BACKUPS.md#retention'
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

hive_retention_action() {
  local host=$1 action=$2 input=$3
  HIVE_HOST_ACTION=$action HIVE_RETENTION_INPUT=$input hive_host "$host" "$(cat "$HIVE_ROOT/scripts/suite/ownership-host.sh" "$HIVE_ROOT/scripts/suite/retention-host.sh")"
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

hive_retention_size() { awk -v k="$1" 'BEGIN { if (k >= 1048576) printf "%.1f GiB", k/1048576; else printf "%.0f MiB", k/1024 }'; }

# One line per entry: what it is, when it was made, its size, and why it stays.
hive_retention_print() {
  local plans=$1 which=$2 host
  while IFS= read -r host; do
    jq -r --arg host "$host" '.[]|select(.host==$host)|"Host \(.host) (\(.directory)): keep the newest \(.keep) restorable pairs and everything newer than \(.keepDays) days; \(.entries|length) entries"' <<< "$plans"
    while IFS=$'\t' read -r decision name kind created kib reasons; do
      printf '  %-7s %-44s %-16s %s %9s%s\n' "$decision" "$name" "$kind" "$created" "$(hive_retention_size "$kib")" "${reasons:+  $reasons}"
    done < <(jq -r --arg host "$host" --arg which "$which" '.[]|select(.host==$host)|.entries[]|select($which=="all" or .remove)|
      [(if .remove then "remove" else "keep" end),.name,.kind,(if .createdAt>0 then (.createdAt|todate|.[0:10]) else "-" end),(.backupKiB+.rehearsalKiB+.historyKiB|tostring),(.reasons|join("; "))]|@tsv' <<< "$plans")
  done < <(jq -r '.[].host' <<< "$plans")
}

hive_retention_total() { jq -r '[.[].entries[]|select(.remove)|(.backupKiB+.rehearsalKiB+.historyKiB)]|add // 0' <<< "$1"; }

# Removes the merged plan's entries on every host; prints the hosts' reports with what each removed.
hive_retention_apply() {
  local input=$1 plans=$2 trigger=$3 host request result results='[]' status=0
  while IFS= read -r host; do
    request=$(jq -c --argjson plans "$plans" --arg host "$host" --arg trigger "$trigger" '.remove=[$plans[]|select(.host==$host)|.entries[]|select(.remove)|.name] | .trigger=$trigger' <<< "$input")
    if [[ $(jq '.remove|length' <<< "$request") == 0 ]]; then continue; fi
    if result=$(hive_retention_action "$host" retention-apply "$request"); then :; else status=1; fi
    [[ -z "$result" ]] || results=$(jq -c --argjson result "$result" '.+[$result]' <<< "$results")
  done < <(jq -r '.hosts|keys[]' "$HIVE_CONFIG")
  printf '%s\n' "$results"
  return "$status"
}
hive_retention_print_removed() {
  local host name kind created bytes
  while IFS=$'\t' read -r host name kind created bytes; do
    printf '  removed %s on %s (%s, %s, %s)\n' "$name" "$host" "$kind" "$created" "$(hive_retention_size "$((bytes / 1024))")"
  done < <(jq -r '.[] | .host as $host | .removed[] | [$host,.name,.kind,.createdAt[0:10],(.bytes|tostring)] | @tsv' <<< "$1")
}

hive_retention_input() {
  jq -nc --argjson keep "$1" --argjson days "$2" '{keep:$keep,keepDays:$days}'
}

# backups list | backups prune [--keep N] [--keep-days D] [--apply]
hive_backups_command() {
  local subcommand=${1:-list} keep days settings input plans total results removed
  (($# <= 1)) || hive_die 'Usage: hive.sh backups list|prune [--keep N] [--keep-days D] [--apply]'
  case "$subcommand" in list|prune) ;; *) hive_die 'Usage: hive.sh backups list|prune [--keep N] [--keep-days D] [--apply]';; esac
  [[ "$subcommand" == prune || "${HIVE_RETENTION_APPLY:-false}" != true ]] || hive_die '--apply applies only to backups prune'
  settings=$(hive_retention_settings "${HIVE_RETENTION_KEEP:-}" "${HIVE_RETENTION_KEEP_DAYS:-}"); read -r keep days <<< "$settings"
  input=$(hive_retention_input "$keep" "$days")
  plans=$(hive_retention_plans "$input") || hive_die 'Backup retention could not read every host; nothing was removed. See above'
  total=$(hive_retention_total "$plans")
  if [[ "$subcommand" == list ]]; then
    hive_retention_print "$plans" all
    printf 'The rules above remove %s entries, freeing %s: ./hive.sh backups prune shows them, and --apply removes them.\n' "$(jq '[.[].entries[]|select(.remove)]|length' <<< "$plans")" "$(hive_retention_size "$total")"
    return
  fi
  hive_retention_print "$plans" remove
  printf 'Kept: %s entries (./hive.sh backups list shows why).\n' "$(jq '[.[].entries[]|select(.remove|not)]|length' <<< "$plans")"
  if [[ "${HIVE_RETENTION_APPLY:-false}" != true && $(jq '[.[].entries[]|select(.remove)]|length' <<< "$plans") == 0 ]]; then
    printf 'Dry run: nothing would be removed.\n'
    return
  fi
  if [[ "${HIVE_RETENTION_APPLY:-false}" != true ]]; then
    printf 'Dry run: %s entries would be removed, freeing %s. Nothing was removed. Remove them with: ./hive.sh backups prune%s --apply\n' \
      "$(jq '[.[].entries[]|select(.remove)]|length' <<< "$plans")" "$(hive_retention_size "$total")" "$( [[ -z "${HIVE_RETENTION_KEEP:-}" ]] || printf ' --keep %s' "$keep"; [[ -z "${HIVE_RETENTION_KEEP_DAYS:-}" ]] || printf ' --keep-days %s' "$days")"
    return
  fi
  if [[ $(jq '[.[].entries[]|select(.remove)]|length' <<< "$plans") == 0 ]]; then printf 'Nothing to remove.\n'; return; fi
  if results=$(hive_retention_apply "$input" "$plans" prune); then :; else
    hive_retention_print_removed "$results"
    hive_die 'Backup retention stopped on a host; see above. What it removed is recorded in that host'"'"'s retention/ directory'
  fi
  hive_retention_print_removed "$results"
  removed=$(jq '[.[].removed[]]|length' <<< "$results")
  printf 'Removed %s entries, freeing %s. Each host recorded them under retention/ in its installation directory; copies kept on other machines were not touched.\n' \
    "$removed" "$(hive_retention_size "$(jq '[.[].removed[].bytes]|add // 0|./1024|floor' <<< "$results")")"
}

# After a successful upgrade: prune with the installation's settings unless retention.auto is
# false. The upgrade has already completed, so a retention problem is reported, never fatal.
hive_retention_after_upgrade() {
  local settings keep days input plans results removed
  if jq -e '.retention.auto==false' "$HIVE_CONFIG" >/dev/null; then
    printf 'Hive: backup retention after upgrades is off (retention.auto); ./hive.sh backups prune removes old backups and rehearsals\n' >&2
    return 0
  fi
  if ! settings=$( (hive_retention_settings '' '') 2>&1); then printf 'Hive: backup retention skipped: %s\n' "$settings" >&2; return 0; fi
  read -r keep days <<< "$settings"
  input=$(hive_retention_input "$keep" "$days")
  if ! plans=$( (hive_retention_plans "$input") ); then
    printf 'Hive: the upgrade is complete; backup retention did not run, see above. Run ./hive.sh backups prune later\n' >&2
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
}
