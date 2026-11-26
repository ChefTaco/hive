#!/usr/bin/env bash
# The daily backup prune. `backups schedule enable` writes one marked line, per installation
# file, into the crontab of the user who runs the controller; every other line stays exactly as
# it was. The line runs `backups schedule run`: `backups prune --apply` with the installation
# file's retention settings, through the same host lock and open-transaction refusal, and only
# while the installation's receipt names the controller the line runs. upgrade, rollback and
# adopt point an existing line at the controller they ran; install creates it when
# retention.schedule is set. Single-host installations only, as for `prune --apply`.
# See deployment/BACKUPS.md#daily-pruning.

hive_retention_default_schedule=03:40
hive_retention_schedule_marker='# hive-retention-schedule config='
# Paths written into the line: cron hands it to /bin/sh, so they must need no quoting, and %
# would end the command.
hive_retention_schedule_path='^/[A-Za-z0-9._/@+-]+$'
hive_retention_schedule_line='^([0-9]{1,2}) ([0-9]{1,2}) \* \* \* PATH=([^ ]+) ([^ ]+) backups schedule run --config ([^ ]+) >> ([^ ]+) 2>&1 # hive-retention-schedule config=([^ ]+)$'

hive_retention_schedule_usage='Usage: hive.sh backups schedule enable [--at HH:MM] | disable | status'

# The installation file the operator named: the line refers to it, not to a private snapshot.
hive_retention_schedule_config() {
  local config=${HIVE_OPERATOR_CONFIG:-$HIVE_CONFIG}
  realpath -e -- "$config"
}

hive_retention_schedule_state() {
  local base=${XDG_STATE_HOME:-${HOME:?HOME is required for the schedule log}/.local/state}
  printf '%s/hive/%s\n' "$base" "$(jq -r .installation "$HIVE_CONFIG")"
}

# cron starts with a short PATH: the line keeps the directories this controller found its tools
# in, in the same order, so a scheduled run uses the same jq, ssh and flock.
hive_retention_schedule_search_path() {
  local directory result='' IFS=:
  for directory in $PATH /usr/local/bin /usr/bin /bin; do
    [[ "$directory" =~ $hive_retention_schedule_path && -d "$directory" ]] || continue
    [[ ":$result:" == *":$directory:"* ]] || result+=${result:+:}$directory
  done
  printf '%s\n' "$result"
}

hive_retention_schedule_entry() { # TIME CONTROLLER CONFIG LOG SEARCH_PATH
  local hour=${1%%:*} minute=${1##*:}
  printf '%d %d * * * PATH=%s %s backups schedule run --config %s >> %s 2>&1 %s%s\n' \
    "$((10#$minute))" "$((10#$hour))" "$5" "$2" "$3" "$4" "$hive_retention_schedule_marker" "$3"
}

# The current crontab into FILE; no crontab is an empty one.
hive_retention_crontab_read() {
  local file=$1
  command -v crontab >/dev/null || { printf 'Hive: crontab is not available on this machine; install cron to schedule pruning\n' >&2; return 1; }
  if crontab -l > "$file" 2> "$file.error"; then rm -f -- "$file.error"; return 0; fi
  if grep -qi 'no crontab for' "$file.error"; then : > "$file"; rm -f -- "$file.error"; return 0; fi
  cat -- "$file.error" >&2; rm -f -- "$file.error"
  printf 'Hive: could not read the crontab of %s\n' "$(id -un)" >&2
  return 1
}

# The marked lines of one installation file.
hive_retention_crontab_entries() { # FILE CONFIG
  local line
  while IFS= read -r line || [[ -n "$line" ]]; do
    [[ "$line" != *"$hive_retention_schedule_marker$2" ]] || printf '%s\n' "$line"
  done < "$1"
}

# Replaces the installation's marked lines with ENTRY (none when empty) and installs the result
# with crontab FILE, which replaces it atomically. Every other line is written back unchanged.
# Returns 10 when nothing changed. The caller holds the crontab lock.
hive_retention_crontab_replace() { # CURRENT CONFIG ENTRY
  local current=$1 config=$2 entry=$3 next line check
  next=$(mktemp) check=$(mktemp)
  while IFS= read -r line || [[ -n "$line" ]]; do
    [[ "$line" == *"$hive_retention_schedule_marker$config" ]] || printf '%s\n' "$line"
  done < "$current" > "$next"
  [[ -z "$entry" ]] || printf '%s\n' "$entry" >> "$next"
  if cmp -s -- "$current" "$next"; then rm -f -- "$next" "$check"; return 10; fi
  if ! crontab "$next"; then
    rm -f -- "$next" "$check"
    printf 'Hive: the crontab could not be written; it was not changed\n' >&2
    return 1
  fi
  if ! crontab -l > "$check" 2>/dev/null || ! cmp -s -- "$next" "$check"; then
    rm -f -- "$next" "$check"
    printf 'Hive: the crontab differs from what was written; review it with crontab -l\n' >&2
    return 1
  fi
  rm -f -- "$next" "$check"
}

# Serializes this controller's crontab edits; each holder re-reads the crontab under the lock.
hive_retention_crontab_lock() {
  local state
  state=$(dirname -- "$(hive_retention_schedule_state)")
  install -d -m 700 -- "$state" || return 1
  [[ ! -L "$state/crontab.lock" ]] || { printf 'Hive: unsafe crontab lock\n' >&2; return 1; }
  exec {HIVE_RETENTION_CRONTAB_LOCK}> "$state/crontab.lock" || return 1
  flock -w 60 "$HIVE_RETENTION_CRONTAB_LOCK" || { printf 'Hive: another controller is editing the crontab\n' >&2; return 1; }
}

hive_retention_schedule_rules() {
  local settings keep days
  settings=$(hive_retention_settings '' '') || return 1
  read -r keep days <<< "$settings"
  printf 'keep the newest %s restorable backup and rehearsal pairs and everything newer than %s days (%s)\n' "$keep" "$days" \
    "$(jq -e '.retention.keep!=null or .retention.keepDays!=null' "$HIVE_CONFIG" >/dev/null 2>&1 && printf 'the installation file' || printf 'the defaults')"
}

# The release and controller the installation's receipt names. Read under the host lock.
# The release and controller every host's receipt names, from the first host. Hosts that name
# different controllers have no one controller to schedule.
hive_retention_schedule_installed() {
  local host first='' record
  while IFS= read -r host; do
    record=$(hive_retention_action "$host" retention-controller "$(hive_retention_input "$hive_retention_default_keep" "$hive_retention_default_keep_days")") || return 1
    if [[ -z "$first" ]]; then first=$record
    elif [[ $(jq -r .controllerSourceSHA256 <<< "$record") != "$(jq -r .controllerSourceSHA256 <<< "$first")" ]]; then
      printf 'Hive: host %s runs another controller (%s) than host %s (%s); upgrade or roll back every host to one release first\n' \
        "$host" "$(jq -r '.controllerSourceSHA256[0:12]' <<< "$record")" "$(jq -r '.hosts|keys[0]' "$HIVE_CONFIG")" "$(jq -r '.controllerSourceSHA256[0:12]' <<< "$first")" >&2
      return 1
    fi
  done < <(jq -r '.hosts|keys[]' "$HIVE_CONFIG")
  printf '%s\n' "$first"
}

# The full-node review may leave this one installer-owned schedule outside Magnus.
# A comment alone proves nothing: require every byte of the current controller's
# configured entry and its installed-controller receipt. The root host collector
# independently reads the named operator's crontab before attesting its identity.
hive_retention_schedule_review() (
  local config time controller log expected current='' installed digest path
  trap '[[ -z "$current" ]] || rm -f -- "$current"' EXIT
  config=$(hive_retention_schedule_config) || { printf 'null\n'; exit 0; }
  time=$(jq -er '.retention.schedule // empty' "$HIVE_CONFIG") || { printf 'null\n'; exit 0; }
  [[ "$time" =~ ^([01][0-9]|2[0-3]):[0-5][0-9]$ ]] || { printf 'null\n'; exit 0; }
  controller=$(realpath -e -- "$HIVE_ROOT/hive.sh") || { printf 'null\n'; exit 0; }
  log=$(hive_retention_schedule_state)/retention-schedule.log
  for path in "$config" "$controller" "$log"; do
    [[ "$path" =~ $hive_retention_schedule_path ]] || { printf 'null\n'; exit 0; }
  done
  expected=$(hive_retention_schedule_entry "$time" "$controller" "$config" "$log" "$(hive_retention_schedule_search_path)")
  current=$(mktemp)
  hive_retention_crontab_read "$current" || { printf 'null\n'; exit 0; }
  [[ $(hive_retention_crontab_entries "$current" "$config") == "$expected" ]] || { printf 'null\n'; exit 0; }
  # Even duplicate identical entries are foreign work, not a single known source.
  [[ $(grep -cxF -- "$expected" "$current") == 1 ]] || { printf 'null\n'; exit 0; }
  installed=$(hive_retention_schedule_installed) || { printf 'null\n'; exit 0; }
  digest=$(hive_controller_digest) || { printf 'null\n'; exit 0; }
  [[ $(jq -r .controllerSourceSHA256 <<< "$installed") == "$digest" ]] || { printf 'null\n'; exit 0; }
  jq -nc --arg username "$(id -un)" --arg line "$expected" '{username:$username,line:$line}'
)

# Writes (or rewrites) the installation's line for this controller. TIME and LOG are kept by a
# rewrite; enable passes the chosen time and the default log.
hive_retention_schedule_write() { # TIME LOG
  local time=$1 log=$2 config controller search entry current status=0
  config=$(hive_retention_schedule_config) || { printf 'Hive: the installation file cannot be resolved\n' >&2; return 1; }
  controller=$(realpath -e -- "$HIVE_ROOT/hive.sh") || return 1
  search=$(hive_retention_schedule_search_path)
  local path
  for path in "$config" "$controller" "$log"; do
    [[ "$path" =~ $hive_retention_schedule_path ]] || {
      printf 'Hive: %s cannot be written into a crontab line; use paths of letters, digits and ._/@+- only\n' "$path" >&2; return 1; }
  done
  install -d -m 700 -- "$(dirname -- "$log")" || return 1
  [[ ! -L "$log" ]] || { printf 'Hive: unsafe schedule log %s\n' "$log" >&2; return 1; }
  [[ -e "$log" ]] || { : > "$log" && chmod 600 -- "$log"; } || return 1
  entry=$(hive_retention_schedule_entry "$time" "$controller" "$config" "$log" "$search")
  (
    hive_retention_crontab_lock || exit 1
    current=$(mktemp); trap 'rm -f -- "$current"' EXIT
    hive_retention_crontab_read "$current" || exit 1
    hive_retention_crontab_replace "$current" "$config" "$entry"
  ) || status=$?
  ((status == 0 || status == 10)) || return 1
  printf '%s\n' "$entry"
}

hive_retention_schedule_enable() {
  local time=${HIVE_RETENTION_AT:-} installed digest log entry rules
  hive_retention_automatic 'every day' || return 1
  if [[ -z "$time" ]]; then time=$(jq -r --arg default "$hive_retention_default_schedule" '.retention.schedule // $default' "$HIVE_CONFIG"); fi
  [[ "$time" =~ ^([01][0-9]|2[0-3]):[0-5][0-9]$ ]] || hive_die '--at is a 24-hour local time such as 03:40'
  rules=$(hive_retention_schedule_rules) || return 1
  command -v crontab >/dev/null || hive_die 'crontab is not available on this machine; install cron to schedule pruning'
  # Only the controller the installation runs may prune it on a schedule.
  installed=$(hive_retention_schedule_installed) || hive_die 'The installation could not be checked; the schedule was not changed. See above'
  digest=$(hive_controller_digest)
  if [[ $(jq -r .controllerSourceSHA256 <<< "$installed") != "$digest" ]]; then
    hive_die "This installation runs the controller of release $(jq -r '.release // "unknown"' <<< "$installed") ($(jq -r '.controllerSourceSHA256[0:12]' <<< "$installed")), not this one (${digest:0:12}). Enable the schedule with the installation's own controller; the schedule was not changed"
  fi
  log=$(hive_retention_schedule_state)/retention-schedule.log
  entry=$(hive_retention_schedule_write "$time" "$log") || hive_die "The crontab was not changed. Add this line to $(id -un)'s crontab instead: $(hive_retention_schedule_entry "$time" "$(realpath -e -- "$HIVE_ROOT/hive.sh")" "$(hive_retention_schedule_config)" "$log" "$(hive_retention_schedule_search_path)")"
  printf 'Daily backup pruning is enabled at %s, local time on this machine: %s.\n' "$time" "$rules"
  printf 'Crontab line of %s:\n  %s\n' "$(id -un)" "$entry"
  printf 'Each run is logged to %s. ./hive.sh backups schedule status shows it.\n' "$log"
}

hive_retention_schedule_disable() {
  local config status=0
  config=$(hive_retention_schedule_config) || hive_die 'The installation file cannot be resolved'
  command -v crontab >/dev/null || { printf 'No daily backup pruning is scheduled: crontab is not available on this machine.\n'; return 0; }
  (
    hive_retention_crontab_lock || exit 1
    current=$(mktemp); trap 'rm -f -- "$current"' EXIT
    hive_retention_crontab_read "$current" || exit 1
    hive_retention_crontab_replace "$current" "$config" ''
  ) || status=$?
  case "$status" in
    0) printf 'Daily backup pruning is disabled: its crontab line for %s was removed. Other crontab lines were not changed.\n' "$config";;
    10) printf 'Daily backup pruning was not enabled for %s; the crontab was not changed.\n' "$config";;
    *) hive_die "The crontab was not changed. Remove the line ending in '$hive_retention_schedule_marker$config' from $(id -un)'s crontab with crontab -e";;
  esac
  if jq -e '.retention.schedule!=null' "$HIVE_CONFIG" >/dev/null; then
    printf 'The installation file still sets retention.schedule; a later install of this file would schedule pruning again.\n'
  fi
}

hive_retention_schedule_status() {
  local config current entries count line controller digest log installed rules
  config=$(hive_retention_schedule_config) || hive_die 'The installation file cannot be resolved'
  printf 'Installation %s (%s)\n' "$(jq -r .installation "$HIVE_CONFIG")" "$config"
  rules=$(hive_retention_schedule_rules) || return 1
  printf 'Rules: %s\n' "$rules"
  if ! hive_retention_automatic 'every day' 2>/dev/null; then
    printf 'Daily pruning on several hosts needs "retention": {"multiHost": true} in the installation file; scheduled runs refuse without it.\n'
  fi
  current=$(mktemp)
  if ! hive_retention_crontab_read "$current"; then rm -f -- "$current"; return 1; fi
  entries=$(hive_retention_crontab_entries "$current" "$config"); rm -f -- "$current"
  count=$(grep -c . <<< "$entries" || true)
  if ((count == 0)); then
    printf 'Daily pruning: disabled (no crontab line for this installation file)\n'
    if jq -e '.retention.schedule!=null' "$HIVE_CONFIG" >/dev/null; then printf 'The installation file sets retention.schedule %s; enable it with ./hive.sh backups schedule enable\n' "$(jq -r .retention.schedule "$HIVE_CONFIG")"; fi
    return 0
  fi
  ((count == 1)) || printf 'Warning: %s crontab lines name this installation file; backups schedule enable replaces them with one\n' "$count"
  line=$(head -1 <<< "$entries")
  printf 'Crontab line of %s:\n  %s\n' "$(id -un)" "$line"
  if [[ ! "$line" =~ $hive_retention_schedule_line ]]; then
    printf 'Daily pruning: the line was edited by hand; backups schedule enable rewrites it\n'
    return 0
  fi
  controller=${BASH_REMATCH[4]} log=${BASH_REMATCH[6]}
  printf 'Daily pruning: enabled at %02d:%02d, local time on this machine\n' "$((10#${BASH_REMATCH[2]}))" "$((10#${BASH_REMATCH[1]}))"
  if [[ ! -x "$controller" ]]; then
    printf 'Controller: %s is missing: scheduled runs fail. Enable the schedule again with the installation'"'"'s controller\n' "$controller"
  elif [[ "$controller" == "$(realpath -e -- "$HIVE_ROOT/hive.sh")" ]]; then
    printf 'Controller: %s (this controller)\n' "$controller"
  else
    printf 'Controller: %s (another controller than this one, %s)\n' "$controller" "$(realpath -e -- "$HIVE_ROOT/hive.sh")"
  fi
  if [[ "$controller" == "$(realpath -e -- "$HIVE_ROOT/hive.sh")" ]]; then
    digest=$(hive_controller_digest)
    if installed=$(hive_retention_schedule_installed 2>&1); then
      if [[ $(jq -r .controllerSourceSHA256 <<< "$installed") == "$digest" ]]; then
        printf 'Installed release %s runs this controller (%s): scheduled runs prune\n' "$(jq -r .release <<< "$installed")" "${digest:0:12}"
      else
        printf 'Installed release %s runs another controller (%s, this one is %s): scheduled runs refuse and remove nothing\n' "$(jq -r .release <<< "$installed")" "$(jq -r '.controllerSourceSHA256[0:12]' <<< "$installed")" "${digest:0:12}"
      fi
    else
      printf 'The installed controller could not be checked now: %s\n' "$(tail -1 <<< "$installed")"
    fi
  fi
  printf 'Log: %s\n' "$log"
  if [[ -f "$log" ]] && grep -q ' scheduled prune ' "$log"; then
    printf 'Last run:\n'
    grep ' scheduled prune \(start\|end\)' "$log" | tail -2 | sed 's/^/  /'
  else
    printf 'Last run: none yet\n'
  fi
}

# The command the crontab line runs. It prunes with the installation file's settings only.
hive_retention_schedule_run() (
  local digest status=0 config
  config=$(hive_retention_schedule_config) || hive_die 'The installation file cannot be resolved'
  digest=$(hive_controller_digest)
  printf '%s scheduled prune start: installation %s, %s, controller %s (%s)\n' "$(date -u +%FT%TZ)" "$(jq -r .installation "$HIVE_CONFIG")" "$config" "$(realpath -e -- "$HIVE_ROOT/hive.sh")" "${digest:0:12}"
  if ! hive_retention_automatic 'every day'; then status=1
  elif HIVE_RETENTION_APPLY=true HIVE_RETENTION_KEEP='' HIVE_RETENTION_KEEP_DAYS='' HIVE_RETENTION_KEEP_FULL='' HIVE_RETENTION_CONTROLLER=$digest HIVE_RETENTION_TRIGGER=schedule \
      hive_backups_command prune; then status=0; else status=$?; fi
  if ((status == 0)); then
    printf '%s scheduled prune end: succeeded\n' "$(date -u +%FT%TZ)"
  else
    printf '%s scheduled prune end: refused or failed (exit %s); nothing was removed except what is listed above\n' "$(date -u +%FT%TZ)" "$status"
  fi
  return "$status"
)

hive_retention_schedule_command() {
  local subcommand=${1:-status}
  (($# <= 1)) || hive_die "$hive_retention_schedule_usage"
  [[ -z "${HIVE_RETENTION_KEEP:-}${HIVE_RETENTION_KEEP_DAYS:-}${HIVE_RETENTION_KEEP_FULL:-}" && "${HIVE_RETENTION_APPLY:-false}" != true ]] ||
    hive_die 'backups schedule uses the installation file'"'"'s retention settings; --keep, --keep-days, --keep-full and --apply apply only to backups prune'
  [[ -z "${HIVE_RETENTION_AT:-}" || "$subcommand" == enable ]] || hive_die '--at applies only to backups schedule enable'
  case "$subcommand" in
    enable) hive_retention_schedule_enable;;
    disable) hive_retention_schedule_disable;;
    status) hive_retention_schedule_status;;
    run) hive_retention_schedule_run;;
    *) hive_die "$hive_retention_schedule_usage";;
  esac
}

# After a successful install, upgrade, rollback or adoption: the line follows the controller
# that ran it, and install creates it when the installation file asks. The operation has
# completed, so a problem here is reported, never fatal.
hive_retention_schedule_after() (
  local operation=$1 config current entries line controller time log entry
  config=$(hive_retention_schedule_config 2>/dev/null) || exit 0
  if ! command -v crontab >/dev/null; then
    if jq -e '.retention.schedule!=null' "$HIVE_CONFIG" >/dev/null; then printf 'Hive: retention.schedule is set, but crontab is not available on this machine; daily pruning was not scheduled\n' >&2; fi
    exit 0
  fi
  current=$(mktemp); trap 'rm -f -- "$current"' EXIT
  hive_retention_crontab_read "$current" 2>/dev/null || { printf 'Hive: the crontab could not be read; check daily pruning with ./hive.sh backups schedule status\n' >&2; exit 0; }
  entries=$(hive_retention_crontab_entries "$current" "$config")
  controller=$(realpath -e -- "$HIVE_ROOT/hive.sh")
  if [[ -z "$entries" ]]; then
    jq -e '.retention.schedule!=null' "$HIVE_CONFIG" >/dev/null || exit 0
    if [[ "$operation" == install ]]; then
      (HIVE_RETENTION_AT=$(jq -r .retention.schedule "$HIVE_CONFIG"); hive_retention_schedule_enable) ||
        printf 'Hive: the installation is complete; daily pruning was not scheduled, see above. Retry with: %s backups schedule enable --config %s\n' "$controller" "$config" >&2
    else
      printf 'Hive: the installation file sets retention.schedule, but no daily pruning is scheduled. Enable it with: %s backups schedule enable --config %s\n' "$controller" "$config" >&2
    fi
    exit 0
  fi
  line=$(head -1 <<< "$entries")
  if [[ $(grep -c . <<< "$entries") != 1 || ! "$line" =~ $hive_retention_schedule_line ]]; then
    printf 'Hive: the daily pruning crontab line for %s was edited by hand and was not changed; scheduled runs refuse unless it runs this controller. Rewrite it with: %s backups schedule enable --config %s\n' "$config" "$controller" "$config" >&2
    exit 0
  fi
  printf -v time '%02d:%02d' "$((10#${BASH_REMATCH[2]}))" "$((10#${BASH_REMATCH[1]}))"
  log=${BASH_REMATCH[6]}
  entry=$(hive_retention_schedule_entry "$time" "$controller" "$config" "$log" "$(hive_retention_schedule_search_path)")
  [[ "$line" != "$entry" ]] || exit 0
  if entry=$(hive_retention_schedule_write "$time" "$log"); then
    printf 'Daily backup pruning at %s now runs this controller after the %s:\n  %s\n' "$time" "$operation" "$entry"
  else
    printf 'Hive: the %s is complete, but daily pruning still names another controller, so its runs refuse. Point it here with: %s backups schedule enable --config %s --at %s\n' "$operation" "$controller" "$config" "$time" >&2
  fi
  exit 0
)
