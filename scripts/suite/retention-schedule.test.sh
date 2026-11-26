#!/usr/bin/env bash
# The daily backup prune: one marked crontab line per installation file, every other line kept
# byte for byte, idempotent enable/disable/status, two-phase runs on several hosts, scheduled runs through
# the host lock, the open-transaction refusal and the installed-controller check, a remote host
# with a sudo password file that never reaches the log, the line following upgrade and rollback,
# install from retention.schedule, and validation of the setting. Fake crontab and ssh; no
# containers are started and the operator's crontab is never read.
set -Eeuo pipefail
umask 077
ROOT=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)
temporary=$(mktemp -d)
trap 'rm -rf -- "$temporary"' EXIT
fail() { printf 'FAIL: %s\n' "$*" >&2; exit 1; }
export XDG_STATE_HOME="$temporary/state" HOME="$temporary/home"
mkdir -p "$HOME"
directory="$temporary/install"
store="$temporary/crontab"
password='fixture-sudo-password-not-a-secret'

mkdir -m 700 "$temporary/bin"
# A crontab that keeps one user's table in a file. FAKE_CRONTAB_FAIL makes every write fail.
cat > "$temporary/bin/crontab" <<CRONTAB
#!/usr/bin/env bash
set -euo pipefail
store='$store'
case "\${1:-}" in
  -l) if [[ -f "\$store" ]]; then cat -- "\$store"; else printf 'no crontab for %s\n' "\$(id -un)" >&2; exit 1; fi;;
  -r) rm -f -- "\$store";;
  -*) exit 2;;
  *) [[ -z "\${FAKE_CRONTAB_FAIL:-}" ]] || { printf 'crontab: permission denied\n' >&2; exit 1; }
     cp -- "\$1" "\$store.next"; mv -- "\$store.next" "\$store"; printf 'write\n' >> "\$store.writes";;
esac
CRONTAB
# An ssh that runs the fixed remote command here. sudo -S takes exactly one password line.
cat > "$temporary/bin/ssh" <<SSH
#!/usr/bin/env bash
set -euo pipefail
command=\${!#}
printf '%s\n' "\$command" >> '$temporary/ssh.log'
case "\$command" in
  "sudo -k -S -p '' "*)
    IFS= read -r supplied
    [[ "\$supplied" == '$password' ]] || { printf 'sudo: incorrect password\n' >&2; exit 1; }
    eval "\${command#"sudo -k -S -p '' "}";;
  *) eval "\$command";;
esac
SSH
cat > "$temporary/bin/docker" <<'DOCKER'
#!/usr/bin/env bash
exit 0
DOCKER
chmod 700 "$temporary/bin/crontab" "$temporary/bin/ssh" "$temporary/bin/docker"
export PATH="$temporary/bin:$PATH"

digest=$(HIVE_ROOT=$ROOT bash -c 'source "$HIVE_ROOT/scripts/suite/controller.sh"; hive_controller_digest')
printf '%s\n' "$password" > "$temporary/sudo-password"; chmod 600 "$temporary/sudo-password"
jq --arg base "$directory" --arg sudo "$temporary/sudo-password" '.hosts.control={target:"deploy@node.example.com",directory:$base,sudoPasswordFile:$sudo} | .console.runtimeFile=($base+"/config/runtime.json") | .components|=with_entries(.key as $name|if .value.envFile then .value.envFile=($base+"/config/"+$name+".env") else . end|if .value.configDirectory then .value.configDirectory=($base+"/config/"+$name) else . end)' "$ROOT/examples/installation.json" > "$temporary/config.json"
config="$temporary/config.json"

ago() { date -d "@$(( $(date +%s) - $1 * 86400 - 600 ))" '+%Y-%m-%d %H:%M:%S'; }
pair() { # NAME DAYS
  local sha
  mkdir -p "$directory/backups/$1" "$directory/rehearsals/$1"
  printf 'archive %s\n' "$1" > "$directory/backups/$1/state.tar.gz"
  sha=$(sha256sum "$directory/backups/$1/state.tar.gz" | cut -d ' ' -f1)
  jq -n --arg sha "$sha" '{schema:1,uuid:"fixture-uuid",installation:"example-suite",host:"control",sha256:$sha,verified:true}' > "$directory/backups/$1/receipt.json"
  jq -n --arg sha "$sha" '{schema:1,result:"passed",archiveSHA256:$sha,installationUUID:"fixture-uuid",candidatePlan:("1"*64),isolated:true}' > "$directory/rehearsals/$1/result.json"
  touch -d "$(ago "$2")" "$directory/backups/$1/receipt.json" "$directory/rehearsals/$1/result.json"
}
fixture() {
  rm -rf -- "$directory"; mkdir -p "$directory/backups" "$directory/rehearsals"
  printf '{"schema":1,"installation":"example-suite","host":"control","uuid":"fixture-uuid"}\n' > "$directory/installation.json"
  jq -n --arg controller "$digest" '{schema:1,installation:"example-suite",host:"control",version:"0.1.0",plan:("7"*64),controllerSourceSHA256:$controller}' > "$directory/receipt.json"
  printf '{"schema":1,"plan":"%s","phase":"complete","version":"0.1.0","operation":"upgrade"}\n' "$(printf '7%.0s' {1..64})" > "$directory/transaction.json"
  for days in 1 2 3 4 5 6 20 30; do pair "pre-$days" "$days"; done
}
snapshot() { (cd "$directory" && find backups rehearsals -print | sort | sha256sum); }
hive() { "$ROOT/hive.sh" backups "$@" --config "$config" --non-interactive; }
refused() { # MESSAGE COMMAND...
  local message=$1; shift
  if "$@" > "$temporary/result" 2>&1; then cat "$temporary/result" >&2; fail "Accepted: $*"; fi
  grep -qF -- "$message" "$temporary/result" || { cat "$temporary/result" >&2; fail "Expected refusal '$message'"; }
}
writes() { if [[ -f "$store.writes" ]]; then wc -l < "$store.writes"; else printf '0\n'; fi; }
marked() { local entry count=0; while IFS= read -r entry; do [[ "$entry" != *"# hive-retention-schedule config=$1" ]] || count=$((count + 1)); done < "$store"; printf '%s\n' "$count"; }
line() { local entry; while IFS= read -r entry; do [[ "$entry" != *"# hive-retention-schedule config=$config" ]] || printf '%s\n' "$entry"; done < "$store"; }
# The command cron runs: everything after the five time fields, through /bin/sh.
run_line() { sh -c "$(line | cut -d ' ' -f6-)"; }
log="$XDG_STATE_HOME/hive/example-suite/retention-schedule.log"

# Status before anything is scheduled, with no crontab at all.
fixture
hive schedule status > "$temporary/status" 2>&1 || { cat "$temporary/status" >&2; fail 'status failed without a crontab'; }
grep -q '^Daily pruning: disabled' "$temporary/status" || { cat "$temporary/status" >&2; fail 'status did not report disabled'; }
grep -q 'keep the newest 5 restorable backup and rehearsal pairs and everything newer than 14 days (the defaults)' "$temporary/status" || fail 'status did not name the rules'
[[ ! -e "$store" ]] || fail 'status wrote a crontab'

# Every other line survives byte for byte: comments, variables, tabs, %, trailing blanks, blank
# lines, carriage returns, and lines of other installation files, including a longer path.
printf '%s\n' '# operator crontab' 'MAILTO=""' 'SHELL=/bin/bash' '' \
  $'17\t9\t* * 0,3 /opt/tools/weekly.sh example   ' \
  '40 9 * * * date +%Y%m%d > /tmp/fixture-date' \
  $'5 4 * * * /opt/tools/crlf.sh\r' \
  "1 2 * * * /opt/other/hive.sh backups schedule run --config /x$config >> /tmp/x.log 2>&1 # hive-retention-schedule config=/x$config" \
  "1 3 * * * /opt/other/hive.sh backups schedule run --config $config.bak >> /tmp/y.log 2>&1 # hive-retention-schedule config=$config.bak" > "$store"
cp -- "$store" "$temporary/original"
hive schedule enable --at 12:10 > "$temporary/enable" 2>&1 || { cat "$temporary/enable" >&2; fail 'enable failed'; }
[[ $(marked "$config") == 1 && $(writes) == 1 ]] || { cat "$temporary/enable" "$store" >&2; fail 'enable did not write exactly one line'; }
size=$(stat -c %s "$temporary/original")
cmp -s <(head -c "$size" "$store") "$temporary/original" || fail 'enable changed other crontab lines'
expected_line="10 12 * * * PATH=$(line | sed -E 's/^.* PATH=([^ ]+) .*$/\1/') $ROOT/hive.sh backups schedule run --config $config >> $log 2>&1 # hive-retention-schedule config=$config"
[[ $(tail -c +"$((size + 1))" "$store") == "$expected_line" ]] || { cat "$store" >&2; fail 'enable wrote an unexpected line'; }
[[ $(line | sed -E 's/^.* PATH=([^ ]+) .*$/\1/') == "$temporary/bin:"*:/usr/bin* ]] || fail 'The line does not keep the PATH order'
grep -qF "$expected_line" "$temporary/enable" && grep -q 'enabled at 12:10' "$temporary/enable" || { cat "$temporary/enable" >&2; fail 'enable did not show the line'; }
[[ -f "$log" && $(stat -c %a "$log") == 600 && $(stat -c %a "$(dirname "$log")") == 700 ]] || fail 'The schedule log is not owner-only'
# Idempotent: the same enable writes nothing; another time replaces the line.
hive schedule enable --at 12:10 > /dev/null 2>&1 || fail 'A repeated enable failed'
[[ $(writes) == 1 && $(marked "$config") == 1 ]] || fail 'A repeated enable rewrote the crontab'
hive schedule enable --at 12:40 > /dev/null 2>&1 || fail 'enable with a new time failed'
[[ $(marked "$config") == 1 && $(line | cut -d ' ' -f1-2) == '40 12' ]] || fail 'A new time did not replace the line'
cmp -s <(head -c "$size" "$store") "$temporary/original" || fail 'A new time changed other crontab lines'
# Lines duplicated by hand become one again.
line > "$temporary/duplicate"; cat "$temporary/duplicate" >> "$store"; [[ $(marked "$config") == 2 ]]
hive schedule status > "$temporary/status" 2>&1; grep -q 'Warning: 2 crontab lines' "$temporary/status" || fail 'status did not warn about duplicates'
hive schedule enable --at 12:40 > /dev/null 2>&1; [[ $(marked "$config") == 1 ]] || fail 'enable left duplicate lines'
hive schedule status > "$temporary/status" 2>&1 || { cat "$temporary/status" >&2; fail 'status failed'; }
for text in 'Daily pruning: enabled at 12:40' "Controller: $ROOT/hive.sh (this controller)" 'Installed release 0.1.0 runs this controller' "Log: $log" 'Last run: none yet'; do
  grep -qF "$text" "$temporary/status" || { cat "$temporary/status" >&2; fail "status lacks: $text"; }
done
# disable restores the original crontab exactly, and a second disable changes nothing.
hive schedule disable > "$temporary/disable" 2>&1 || fail 'disable failed'
cmp -s "$store" "$temporary/original" || { diff "$temporary/original" "$store" >&2; fail 'disable did not restore the other lines exactly'; }
before=$(writes); hive schedule disable > "$temporary/disable" 2>&1 || fail 'A repeated disable failed'
grep -q 'was not enabled' "$temporary/disable" && [[ $(writes) == "$before" ]] || fail 'A repeated disable wrote the crontab'
# A crontab without a final newline gains only that newline.
printf '1 1 * * * /opt/tools/last.sh' > "$store"
hive schedule enable > /dev/null 2>&1 || fail 'enable failed on a crontab without a final newline'
[[ $(head -1 "$store") == '1 1 * * * /opt/tools/last.sh' && $(line | cut -d ' ' -f1-2) == '40 3' ]] || fail 'The default time or the last line is wrong'
hive schedule disable > /dev/null 2>&1; [[ $(cat "$store") == '1 1 * * * /opt/tools/last.sh' ]] || fail 'disable lost the last line'
# A crontab that cannot be written is reported, with the line to add by hand.
cp -- "$temporary/original" "$store"
FAKE_CRONTAB_FAIL=1 refused 'Add this line to' hive schedule enable --at 12:10
cmp -s "$store" "$temporary/original" || fail 'A failed write changed the crontab'

# The scheduled run: prune --apply with the file's settings, logged with time and outcome, over
# ssh with the sudo password file. The password never appears in the log.
fixture; before=$(snapshot); : > "$temporary/ssh.log"
hive schedule enable --at 12:10 > /dev/null 2>&1 || fail 'enable failed'
run_line || { cat "$log" >&2; fail 'The scheduled run failed'; }
grep -q '^20[0-9-]*T[0-9:]*Z scheduled prune start: installation example-suite' "$log" && grep -q 'scheduled prune end: succeeded$' "$log" || { cat "$log" >&2; fail 'The run was not logged with time and outcome'; }
for name in pre-20 pre-30; do
  [[ ! -e "$directory/backups/$name" && ! -e "$directory/rehearsals/$name" ]] || fail "The scheduled run kept $name"
  grep -q "removed $name on control" "$log" || fail "The log does not list $name"
done
for days in 1 2 3 4 5 6; do [[ -d "$directory/backups/pre-$days" ]] || fail "The scheduled run removed pre-$days"; done
jq -e '.trigger=="schedule" and .keep==5 and .keepDays==14' "$directory"/retention/prune-*.json >/dev/null || fail 'The audit record does not say schedule'
grep -q "^sudo -k -S -p '' " "$temporary/ssh.log" || fail 'The run did not use the sudo password file'
! grep -rqF "$password" "$log" "$XDG_STATE_HOME" || fail 'The sudo password reached the log'
hive schedule status > "$temporary/status" 2>&1; grep -q 'scheduled prune end: succeeded' "$temporary/status" || fail 'status does not show the last run'
# The installation file's settings, not command-line options, drive it.
refused 'uses the installation file' hive schedule run --keep 2
refused '--at applies only to backups schedule enable' hive schedule status --at 12:00
refused '--at applies only to backups schedule enable' hive list --at 12:00
refused '--at is a 24-hour local time' hive schedule enable --at 24:00
refused 'Usage: hive.sh backups schedule' hive schedule start
jq '.retention={keep:2,keepDays:0}' "$config" > "$temporary/tight.json"; cp "$temporary/tight.json" "$config"
run_line || { cat "$log" >&2; fail 'The run with file settings failed'; }
[[ $(find "$directory/backups" -mindepth 1 -maxdepth 1 | wc -l) == 2 ]] || fail 'The run did not use keep 2 from the file'
jq 'del(.retention)' "$config" > "$temporary/tight.json"; cp "$temporary/tight.json" "$config"

# A held lock or an open transaction: the run refuses, logs it, and removes nothing.
fixture; before=$(snapshot); : > "$log"
exec 8>"$directory/controller.lock"; flock -n 8
if run_line; then fail 'A run under a held lock succeeded'; fi
exec 8>&-
grep -q 'Another controller holds this host' "$log" && grep -q 'scheduled prune end: refused or failed' "$log" || { cat "$log" >&2; fail 'A locked run was not logged as refused'; }
for phase in prepared quiesced backed-up activating recovery-required; do
  jq --arg phase "$phase" '.phase=$phase' "$directory/transaction.json" > "$temporary/transaction"; cp "$temporary/transaction" "$directory/transaction.json"
  : > "$log"
  if run_line; then fail "A run during phase $phase succeeded"; fi
  grep -q "The transaction is in phase $phase" "$log" || { cat "$log" >&2; fail "Phase $phase was not logged"; }
done
[[ $(snapshot) == "$before" ]] || fail 'A refused run removed something'

# Another controller installed the release: the run refuses and logs it; enable refuses too.
fixture; before=$(snapshot); : > "$log"
jq '.controllerSourceSHA256=("e"*64) | .version="0.0.9"' "$directory/receipt.json" > "$temporary/receipt"; cp "$temporary/receipt" "$directory/receipt.json"
if run_line; then fail 'A run with a mismatched controller succeeded'; fi
grep -q 'This installation runs the controller of release 0.0.9 (eeeeeeeeeeee), not the one this scheduled prune runs' "$log" || { cat "$log" >&2; fail 'A mismatched controller was not logged'; }
[[ $(snapshot) == "$before" ]] || fail 'A mismatched controller removed something'
refused 'This installation runs the controller of release 0.0.9' hive schedule enable --at 12:10
hive schedule status > "$temporary/status" 2>&1; grep -q 'runs another controller (eeeeeeeeeeee' "$temporary/status" || { cat "$temporary/status" >&2; fail 'status did not show the mismatch'; }
# A receipt without a controller (an older installer) is not this controller either.
jq 'del(.controllerSourceSHA256)' "$directory/receipt.json" > "$temporary/receipt"; cp "$temporary/receipt" "$directory/receipt.json"
if run_line; then fail 'A run against a receipt without a controller succeeded'; fi
[[ $(snapshot) == "$before" ]] || fail 'A receipt without a controller allowed removal'

# Several hosts: enable checks every host's controller, and each run removes a pair only after
# every host set it aside (retention.test.sh covers the refusals).
jq --arg base "$temporary/multi/a" --arg other "$temporary/multi/b" '.hosts={a:{target:"deploy@a.example.com",directory:$base},b:{target:"deploy@b.example.com",directory:$other}} | .console.host="a" | .console.runtimeFile=($base+"/config/runtime.json") | .components|=with_entries(.key as $name|.value.host="a"|if .value.envFile then .value.envFile=($base+"/config/"+$name+".env") else . end|if .value.configDirectory then .value.configDirectory=($base+"/config/"+$name) else . end) | .retention={keep:2,keepDays:0}' "$config" > "$temporary/multi.json"
for host in a b; do
  directory="$temporary/multi/$host"
  fixture
  jq --arg host "$host" '.host=$host' "$directory/installation.json" > "$temporary/next.json"; mv "$temporary/next.json" "$directory/installation.json"
  jq --arg host "$host" '.host=$host' "$directory/receipt.json" > "$temporary/next.json"; mv "$temporary/next.json" "$directory/receipt.json"
  for receipt in "$directory"/backups/*/receipt.json; do jq --arg host "$host" '.host=$host' "$receipt" > "$temporary/next.json"; touch -r "$receipt" "$temporary/next.json"; mv "$temporary/next.json" "$receipt"; done
done
directory="$temporary/install"
: > "$temporary/ssh.log"
"$ROOT/hive.sh" backups schedule enable --at 12:20 --config "$temporary/multi.json" --non-interactive > "$temporary/result" 2>&1 || { cat "$temporary/result" >&2; fail 'A multi-host enable failed'; }
grep -q 'deploy@a.example.com\|retention' "$temporary/ssh.log" || true
[[ $(marked "$temporary/multi.json") == 1 ]] || fail 'A multi-host enable did not write its line'
"$ROOT/hive.sh" backups schedule status --config "$temporary/multi.json" --non-interactive > "$temporary/status" 2>&1 || fail 'Multi-host status failed'
! grep -q 'not available' "$temporary/status" || fail 'Multi-host status still calls daily pruning unavailable'
"$ROOT/hive.sh" backups schedule run --config "$temporary/multi.json" --non-interactive > "$temporary/result" 2>&1 || { cat "$temporary/result" >&2; fail 'A multi-host scheduled run failed'; }
grep -q 'scheduled prune end: succeeded' "$temporary/result" || fail 'A multi-host run did not log its outcome'
for host in a b; do
  [[ -d "$temporary/multi/$host/backups/pre-2" && ! -e "$temporary/multi/$host/backups/pre-30" && ! -e "$temporary/multi/$host/rehearsals/pre-30" ]] || fail "The multi-host schedule did not prune host $host"
  jq -e '.trigger=="schedule"' "$temporary/multi/$host"/retention/prune-*.json >/dev/null || fail "Host $host did not record the scheduled prune"
done
# A host that runs another controller stops enable before the crontab changes.
jq '.controllerSourceSHA256=("e"*64)' "$temporary/multi/b/receipt.json" > "$temporary/next.json"; mv "$temporary/next.json" "$temporary/multi/b/receipt.json"
cp -- "$store" "$temporary/before-multi"
refused 'host b runs another controller' "$ROOT/hive.sh" backups schedule enable --at 12:30 --config "$temporary/multi.json" --non-interactive
cmp -s "$store" "$temporary/before-multi" || fail 'A multi-host enable with mixed controllers changed the crontab'
"$ROOT/hive.sh" backups schedule disable --config "$temporary/multi.json" --non-interactive > /dev/null 2>&1 || fail 'Multi-host disable failed'

# upgrade, rollback and adopt point the line at the controller they ran; its time and log stay.
other="$temporary/controller-v2"; mkdir -p "$other"; cp -- "$ROOT/hive.sh" "$other/hive.sh"
fixture; cp -- "$temporary/original" "$store"
hive schedule enable --at 12:10 > /dev/null 2>&1 || fail 'enable failed'
after() { # ROOT OPERATION [CONFIG]
  (
    source "$ROOT/scripts/suite/controller.sh"; source "$ROOT/scripts/suite/retention.sh"; source "$ROOT/scripts/suite/retention-schedule.sh"
    HIVE_CONFIG=${3:-$config} HIVE_OPERATOR_CONFIG=${3:-$config} HIVE_ID=example-suite HIVE_VERSION=0.1.0
    HIVE_ROOT=$1 hive_retention_schedule_after "$2"; printf 'continued\n'
  ) > "$temporary/after.log" 2>&1
}
for operation in upgrade rollback adopt; do
  after "$other" "$operation" || fail "The $operation hook failed"
  [[ $(marked "$config") == 1 ]] && line | grep -qF " $other/hive.sh backups schedule run --config $config >> $log 2>&1 " || { cat "$store" >&2; fail "$operation did not point the line at its controller"; }
  [[ $(line | cut -d ' ' -f1-2) == '10 12' ]] || fail "$operation changed the time"
  grep -q "now runs this controller after the $operation" "$temporary/after.log" || { cat "$temporary/after.log" >&2; fail "$operation did not report the new line"; }
  cmp -s <(head -c "$size" "$store") "$temporary/original" || fail "$operation changed other crontab lines"
  after "$ROOT" "$operation" || fail "The $operation hook failed"
  line | grep -qF " $ROOT/hive.sh backups schedule run" || fail "$operation back to the first controller did not rewrite the line"
done
# Already pointing here: nothing is written.
before=$(writes); after "$ROOT" upgrade; [[ $(writes) == "$before" ]] || fail 'An unchanged controller rewrote the crontab'
# A line that still names the earlier controller refuses rather than prunes with it.
after "$other" upgrade; jq --arg c "$(printf 'd%.0s' {1..64})" '.controllerSourceSHA256=$c' "$directory/receipt.json" > "$temporary/receipt"; cp "$temporary/receipt" "$directory/receipt.json"
before=$(snapshot); : > "$log"
"$ROOT/hive.sh" backups schedule run --config "$config" --non-interactive >> "$log" 2>&1 && fail 'A stale controller pruned'
grep -q 'This installation runs the controller of release' "$log" && [[ $(snapshot) == "$before" ]] || fail 'A stale controller was not refused'
# A failed rewrite never fails the completed operation, and says what to run.
fixture; after "$ROOT" upgrade
FAKE_CRONTAB_FAIL=1 after "$other" rollback || fail 'A crontab failure failed the rollback'
grep -q 'the rollback is complete, but daily pruning still names another controller' "$temporary/after.log" && grep -q "backups schedule enable --config $config --at 12:10" "$temporary/after.log" && grep -q '^continued$' "$temporary/after.log" || { cat "$temporary/after.log" >&2; fail 'A failed rewrite was not reported'; }
# A hand-edited line is reported and kept.
sed -i "s|>> $log 2>&1 # hive|>> /tmp/elsewhere.log # hive|" "$store"; cp -- "$store" "$temporary/edited"
after "$other" upgrade; grep -q 'was edited by hand' "$temporary/after.log" && cmp -s "$store" "$temporary/edited" || fail 'A hand-edited line was rewritten'
# Without a line, upgrade adds none; with retention.schedule it says how to enable it.
cp -- "$temporary/original" "$store"
after "$ROOT" upgrade; cmp -s "$store" "$temporary/original" || fail 'An upgrade scheduled pruning without a line'
jq '.retention={schedule:"02:15"}' "$config" > "$temporary/scheduled.json"
after "$ROOT" upgrade "$temporary/scheduled.json"; grep -q 'sets retention.schedule, but no daily pruning is scheduled' "$temporary/after.log" && cmp -s "$store" "$temporary/original" || fail 'An upgrade did not leave enabling to the operator'
# install creates the line from retention.schedule, and only for one host.
after "$ROOT" install "$temporary/scheduled.json" || fail 'The install hook failed'
[[ $(marked "$temporary/scheduled.json") == 1 ]] && grep -F "config=$temporary/scheduled.json" "$store" | grep -v "config=$temporary/scheduled.json." | grep -q '^15 2 \* \* \* ' || { cat "$temporary/after.log" "$store" >&2; fail 'install did not schedule pruning'; }
# With several hosts it does so once every host runs the same controller.
jq '.retention={schedule:"02:15"}' "$temporary/multi.json" > "$temporary/multi-scheduled.json"
after "$ROOT" install "$temporary/multi-scheduled.json"
[[ $(marked "$temporary/multi-scheduled.json") == 0 ]] && grep -q 'host b runs another controller' "$temporary/after.log" || { cat "$temporary/after.log" >&2; fail 'install scheduled pruning on hosts with different controllers'; }
jq --arg controller "$digest" '.controllerSourceSHA256=$controller' "$temporary/multi/b/receipt.json" > "$temporary/next.json"; mv "$temporary/next.json" "$temporary/multi/b/receipt.json"
after "$ROOT" install "$temporary/multi-scheduled.json"
[[ $(marked "$temporary/multi-scheduled.json") == 1 ]] || { cat "$temporary/after.log" >&2; fail 'install did not schedule pruning on several hosts'; }

# The lifecycle calls the hook only after install, upgrade, rollback or adoption completed.
lifecycle() { # OPERATION [FAILING_STEP]
  (
    source "$ROOT/scripts/suite/controller.sh"; source "$ROOT/scripts/suite/lifecycle.sh"; source "$ROOT/scripts/suite/retention.sh"; source "$ROOT/scripts/suite/retention-schedule.sh"
    HIVE_ROOT=$ROOT HIVE_CONFIG=$config HIVE_ARCHIVE=fixture HIVE_PLAN_DIGEST=fixture
    for stub in hive_registry_provision hive_memory_credential_provision hive_audit_collection_provision hive_registry_refresh_ingress hive_doctor hive_stage hive_registry_begin hive_registry_complete hive_checklist_report hive_install_summary hive_initialize hive_render hive_transfer hive_registry_preflight hive_retention_after_upgrade; do eval "$stub() { :; }"; done
    hive_all() { printf '%s\n' "$1" >> "$steps"; [[ "$1" != "$failing" ]]; }
    hive_hold() { hive_die 'held'; }
    hive_retention_schedule_after() { printf 'schedule %s\n' "$1" >> "$steps"; }
    steps=$temporary/steps failing=${2:-}
    hive_lifecycle "$1"
  ) > "$temporary/lifecycle.log" 2>&1
}
for operation in install upgrade rollback adopt; do
  : > "$temporary/steps"; lifecycle "$operation" || { cat "$temporary/lifecycle.log" >&2; fail "The stubbed $operation failed"; }
  [[ $(tail -1 "$temporary/steps") == "schedule $operation" ]] && grep -q '^complete$' "$temporary/steps" || { cat "$temporary/steps" >&2; fail "$operation did not update the schedule after completing"; }
done
for step in activate complete; do
  : > "$temporary/steps"; if lifecycle upgrade "$step"; then fail "An upgrade with a failed $step passed"; fi
  ! grep -q '^schedule' "$temporary/steps" || fail "The schedule changed after a failed $step"
done
for operation in backup restore rehearse; do
  : > "$temporary/steps"; lifecycle "$operation" > /dev/null 2>&1 || true
  ! grep -q '^schedule' "$temporary/steps" || fail "$operation changed the schedule"
done

# retention.schedule: a 24-hour time, in the controller and in the published schema alike.
for value in '"3:40"' '"24:00"' '"12:60"' '"12:10:00"' '""' '1210' 'true' 'null'; do
  jq ".retention={schedule:$value}" "$config" > "$temporary/bad.json"
  refused 'retention is {"keep":N' "$ROOT/hive.sh" backups list --config "$temporary/bad.json" --non-interactive
done
for value in 00:00 03:40 23:59; do
  jq --arg time "$value" '.retention={keep:5,keepDays:14,auto:false,schedule:$time}' "$config" > "$temporary/good.json"
  "$ROOT/hive.sh" backups schedule status --config "$temporary/good.json" --non-interactive > /dev/null 2>&1 || fail "retention.schedule $value was refused"
done
jq -e '.properties.retention.properties.schedule | .type=="string" and .pattern=="^([01][0-9]|2[0-3]):[0-5][0-9]$"' "$ROOT/examples/installation.schema.json" >/dev/null || fail 'The schema does not define retention.schedule as the controller validates it'
grep -qF 'test("^([01][0-9]|2[0-3]):[0-5][0-9]$")' "$ROOT/scripts/suite/retention.sh" || fail 'The controller and the schema disagree on retention.schedule'
printf 'Passed: the daily prune keeps one marked crontab line per installation file and every other line byte for byte, prunes several hosts in two phases, prunes only through the host lock with no open transaction and the installed controller, logs each run without secrets, follows upgrade, rollback and adopt, and is set up by install from retention.schedule.\n'
