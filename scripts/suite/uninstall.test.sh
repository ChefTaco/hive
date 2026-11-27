#!/usr/bin/env bash
# hive.sh uninstall and remove: the plan and confirmation, containers removed with data kept, the
# crontab line, the certificate renewal service and the hive command record removed, --purge only
# after the typed installation name, and the host refusals. Fake docker, crontab, sudo and
# systemctl; no container is started.
set -Eeuo pipefail
ROOT=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)
temporary=$(mktemp -d)
trap 'rm -rf -- "$temporary"' EXIT
fail() { printf 'FAIL: %s\n' "$*" >&2; exit 1; }
export XDG_STATE_HOME="$temporary/state" HIVE_SYSTEMD_DIRECTORY="$temporary/systemd"
mkdir -p "$temporary/bin" "$temporary/systemd"
store="$temporary/crontab"
cat > "$temporary/bin/docker" <<DOCKER
#!/usr/bin/env bash
printf '%s\n' "\$*" >> '$temporary/docker.calls'
case "\$*" in *" ps "*) printf '[]\n';; esac
exit 0
DOCKER
cat > "$temporary/bin/crontab" <<CRONTAB
#!/usr/bin/env bash
case "\${1:-}" in
  -l) if [[ -f '$store' ]]; then cat -- '$store'; else printf 'no crontab\n' >&2; exit 1; fi;;
  -*) exit 2;;
  *) cp -- "\$1" '$store';;
esac
CRONTAB
# sudo runs the command as this user and records it; systemctl only records.
printf '#!/usr/bin/env bash\nprintf "%%s\\n" "$*" >> %q\n"$@"\n' "$temporary/sudo.calls" > "$temporary/bin/sudo"
printf '#!/usr/bin/env bash\nprintf "%%s\\n" "$*" >> %q\n' "$temporary/systemctl.calls" > "$temporary/bin/systemctl"
chmod 700 "$temporary/bin/"*
export PATH="$temporary/bin:$PATH"

directory="$temporary/owned"
config="$temporary/config.json"
fixture() {
  rm -rf -- "$directory"; mkdir -p "$directory/data/oathweave" "$directory/backups/pre-1" "$directory/config"
  printf 'synthetic data\n' > "$directory/data/oathweave/store"
  printf '{"installation":"uninstall-proof","host":"control","uuid":"synthetic"}' > "$directory/installation.json"
  printf '{"services":{"oathweave":{},"hivexui":{}}}' > "$directory/compose.json"
  printf '{"version":"0.1.0"}\n' > "$directory/receipt.json"
  printf '{"phase":"complete"}\n' > "$directory/transaction.json"
  jq --arg base "$directory" '.installation="uninstall-proof" | .hosts.control.directory=$base | .agents=[] | .console.runtimeFile=($base+"/config/runtime.json") | .components["hive-registry"]+={envFile:($base+"/config/hive-registry.env"),configDirectory:($base+"/config/hive-registry")}' "$ROOT/examples/installation.json" > "$config"
  printf '40 3 * * * /opt/hive/hive.sh backups schedule run --config %s >> /tmp/x.log 2>&1 # hive-retention-schedule config=%s\n0 1 * * * /opt/other.sh\n' "$config" "$config" > "$store"
  printf '[Service]\nExecStart=/opt/hive/scripts/console-certificate.sh renew --config %s --hive /opt/hive --no-tailscale\n' "$config" > "$temporary/systemd/hive-console-certificate.service"
  printf '[Timer]\n' > "$temporary/systemd/hive-console-certificate.timer"
  mkdir -p "$XDG_STATE_HOME/hive/uninstall-proof"; printf '{}\n' > "$XDG_STATE_HOME/hive/uninstall-proof/controller.json"
  : > "$temporary/docker.calls"; : > "$temporary/systemctl.calls"; : > "$temporary/sudo.calls"
}
hive() { "$ROOT/hive.sh" "$@" --config "$config" --non-interactive; }

# Without --yes nothing changes, and the plan says what stays.
fixture
if hive uninstall < /dev/null > "$temporary/plan" 2>&1; then fail 'uninstall ran without confirmation'; fi
grep -q 'stays with its data, configuration and backups' "$temporary/plan" && grep -q 'Cancelled; nothing was changed' "$temporary/plan" || { cat "$temporary/plan" >&2; fail 'The plan or the refusal was unclear'; }
grep -q 'Remove the daily backup prune line' "$temporary/plan" && grep -q 'certificate renewal service' "$temporary/plan" || { cat "$temporary/plan" >&2; fail 'The plan omits the schedule or the certificate service'; }
! grep -q ' down ' "$temporary/docker.calls" || fail 'An unconfirmed uninstall reached Docker'

# uninstall --yes: containers removed, data kept, every installer-owned trace removed.
hive uninstall --yes < /dev/null > "$temporary/result" 2>&1 || { cat "$temporary/result" >&2; fail 'uninstall --yes failed'; }
grep -qx -- "compose -f $directory/compose.json down --remove-orphans" "$temporary/docker.calls" || { cat "$temporary/docker.calls" >&2; fail 'The containers were not removed'; }
[[ -f "$directory/data/oathweave/store" && -d "$directory/backups/pre-1" && -f "$config" ]] || fail 'uninstall without --purge deleted data'
jq -e '.dataKept==true' "$directory/uninstalled.json" >/dev/null || fail 'uninstalled.json was not written'
! grep -q 'hive-retention-schedule' "$store" && grep -q '/opt/other.sh' "$store" || fail 'The crontab line was not removed, or another line was'
[[ ! -e "$temporary/systemd/hive-console-certificate.service" && ! -e "$temporary/systemd/hive-console-certificate.timer" ]] || fail 'The certificate renewal service was not removed'
grep -qx 'disable --now hive-console-certificate.timer' "$temporary/systemctl.calls" || fail 'The renewal timer was not stopped'
[[ ! -e "$XDG_STATE_HOME/hive/uninstall-proof/controller.json" ]] || fail 'The hive command record was kept'
grep -q 'its data is kept' "$temporary/result" || fail 'uninstall did not say the data is kept'

# The note that the installation file still sets retention.schedule is for a file that stays:
# uninstall prints it, a purge, which deletes the file right after, does not.
fixture
jq '.retention={keep:5,schedule:"03:40"}' "$config" > "$config.next"; mv -- "$config.next" "$config"
hive uninstall --yes < /dev/null > "$temporary/result" 2>&1 || { cat "$temporary/result" >&2; fail 'uninstall --yes with retention.schedule failed'; }
grep -qF "The installation file $config still sets retention.schedule" "$temporary/result" || { cat "$temporary/result" >&2; fail 'uninstall did not say that the kept file still schedules pruning'; }
fixture
jq '.retention={keep:5,schedule:"03:40"}' "$config" > "$config.next"; mv -- "$config.next" "$config"
printf 'uninstall-proof\n' | hive uninstall --purge --yes > "$temporary/result" 2>&1 || { cat "$temporary/result" >&2; fail 'A purge with retention.schedule failed'; }
grep -q 'Daily backup pruning is disabled' "$temporary/result" || { cat "$temporary/result" >&2; fail 'The purge did not remove the prune line'; }
! grep -q 'still sets retention.schedule' "$temporary/result" || { cat "$temporary/result" >&2; fail 'The purge spoke of the installation file it deletes as if it stayed'; }
[[ ! -e "$config" ]] || fail 'The purge kept the installation file'

# A certificate service for another installation is never touched.
fixture
sed -i "s#--config $config#--config /opt/other/installation.json#" "$temporary/systemd/hive-console-certificate.service"
hive uninstall --yes < /dev/null > /dev/null 2>&1 || fail 'uninstall with another installation'"'"'s certificate service failed'
[[ -f "$temporary/systemd/hive-console-certificate.service" ]] || fail 'Another installation'"'"'s certificate service was removed'

# --purge: --yes alone, or the wrong name, deletes nothing.
fixture
if hive uninstall --purge --yes < /dev/null > "$temporary/result" 2>&1; then fail 'A purge ran without the typed name'; fi
if printf 'uninstall-prooff\n' | hive uninstall --purge --yes > "$temporary/result" 2>&1; then fail 'A purge ran with the wrong name'; fi
grep -q 'The installation name was not typed; nothing was changed' "$temporary/result" || fail 'The refused purge was not explained'
[[ -f "$directory/data/oathweave/store" ]] && ! grep -q ' down ' "$temporary/docker.calls" || fail 'A refused purge changed something'
grep -q 'DELETE' <(printf 'x\n' | hive uninstall --purge --yes 2>&1) || fail 'The purge plan does not say what it deletes'
printf 'uninstall-proof\n' | hive uninstall --purge --yes > "$temporary/result" 2>&1 || { cat "$temporary/result" >&2; fail 'A confirmed purge failed'; }
[[ ! -e "$directory" && ! -e "$config" ]] || fail 'The purge kept the installation directory or file'
[[ -d "$temporary" ]] || fail 'The purge deleted the directory of the installation file'
# An installation file in a directory named after the installation, beside a file Hive did not
# write: only Hive's own files go, the sibling and the directory stay.
fixture
mkdir -p "$temporary/uninstall-proof/additions"
mv -- "$config" "$temporary/uninstall-proof/installation.json"; config="$temporary/uninstall-proof/installation.json"
sed -i "s#--config [^ ]*#--config $config#" "$temporary/systemd/hive-console-certificate.service"
printf '{}\n' > "$temporary/uninstall-proof/additions/cindertrace.json"
printf 'operator notes\n' > "$temporary/uninstall-proof/notes.txt"
printf 'uninstall-proof\n' | hive uninstall --purge --yes > "$temporary/result" 2>&1 || { cat "$temporary/result" >&2; fail 'A purge beside a foreign file failed'; }
[[ -f "$temporary/uninstall-proof/notes.txt" && ! -e "$config" && ! -e "$temporary/uninstall-proof/additions" ]] || fail 'The purge deleted a sibling file, or kept its own files'
grep -q 'holds other files and was kept' "$temporary/result" || fail 'The kept directory was not explained'
rm -rf -- "$temporary/uninstall-proof"; config="$temporary/config.json"
grep -q -- 'down --remove-orphans --volumes' "$temporary/docker.calls" || fail 'The purge did not remove the volumes'
[[ ! -e "$XDG_STATE_HOME/hive/uninstall-proof" ]] || fail 'The purge kept the state directory'

# A purge on this machine asks for root when the operator cannot remove the directory itself
# (setup created it with sudo in a root-owned parent), even when every file in it is the operator's.
(
  source "$ROOT/scripts/suite/controller.sh"; source "$ROOT/scripts/suite/uninstall.sh"
  mkdir -p "$temporary/rootparent/inst"; printf 'x\n' > "$temporary/rootparent/inst/file"
  ! hive_uninstall_needs_sudo "$temporary/rootparent/inst" || exit 1
  chmod 555 "$temporary/rootparent"
  hive_uninstall_needs_sudo "$temporary/rootparent/inst" || { chmod 755 "$temporary/rootparent"; exit 2; }
  chmod 755 "$temporary/rootparent"
  ! hive_uninstall_needs_sudo "$temporary/rootparent/missing" || exit 3
) || fail "The purge root decision is wrong (status $?)"
# A purge interrupted after the directory was emptied leaves it empty: repeating the purge
# finishes (the containers count as gone, the directory and the installation file are removed).
fixture
rm -rf -- "$directory"; mkdir -p "$directory"
printf 'uninstall-proof\n' | hive uninstall --purge --yes > "$temporary/result" 2>&1 || { cat "$temporary/result" >&2; fail 'A repeated purge of an emptied directory failed'; }
[[ ! -e "$directory" && ! -e "$config" ]] || fail 'A repeated purge kept the emptied directory or the installation file'
fixture
rm -rf -- "$directory"; mkdir -p "$directory"
hive uninstall --yes < /dev/null > "$temporary/result" 2>&1 || { cat "$temporary/result" >&2; fail 'uninstall of an emptied directory failed'; }
[[ -d "$directory" ]] || fail 'uninstall without --purge removed an emptied directory'

# The host refuses a directory of another installation, and an open transaction.
fixture
printf '{"installation":"other","host":"control","uuid":"x"}' > "$directory/installation.json"
if hive uninstall --yes < /dev/null > "$temporary/result" 2>&1; then fail 'uninstall acted on another installation'"'"'s directory'; fi
fixture
printf '{"phase":"recovery-required"}\n' > "$directory/transaction.json"
if hive uninstall --yes < /dev/null > "$temporary/result" 2>&1; then fail 'uninstall ran with an open transaction'; fi
grep -q 'transaction is in phase recovery-required' "$temporary/result" || { cat "$temporary/result" >&2; fail 'The open transaction was not explained'; }
! grep -q ' down ' "$temporary/docker.calls" || fail 'A refused uninstall reached Docker'
if hive uninstall --purge --keep 3 < /dev/null > /dev/null 2>&1; then fail 'An unrelated option was accepted'; fi
if hive backups list --purge < /dev/null > /dev/null 2>&1; then fail '--purge was accepted by another command'; fi

# remove: only what it supports, only when installed; the host removes just the named containers.
fixture
if hive remove cindertrace --yes > "$temporary/result" 2>&1; then fail 'remove accepted an unsupported product'; fi
grep -q 'remove supports cindertrace-collector so far' "$temporary/result" || { cat "$temporary/result" >&2; fail 'An unsupported product was not explained'; }
(
  source "$ROOT/scripts/suite/controller.sh"; source "$ROOT/scripts/suite/uninstall.sh"
  HIVE_CONFIG=$config HIVE_ROOT=$ROOT HIVE_ID=uninstall-proof HIVE_OPERATOR_CONFIG=$config HIVE_VERSION=0.1.0
  if (hive_remove_product cindertrace-collector) > "$temporary/result" 2>&1; then exit 1; fi
  grep -q 'is not in this installation' "$temporary/result" || exit 2
  printf '{"services":{"oathweave":{},"cindertrace-collector":{}}}' > "$directory/compose.json"
  hive_uninstall_action control remove-component '{"components":["cindertrace-collector"]}' > "$temporary/removed" || exit 3
  grep -qx -- "compose -f $directory/compose.json rm --stop --force -- cindertrace-collector" "$temporary/docker.calls" || exit 4
  [[ -f "$directory/data/oathweave/store" ]] || exit 5
) || fail "remove did not refuse or remove as expected (status $?)"
printf 'Passed: uninstall shows its plan, removes containers, the prune line (noting a retention.schedule only in a file it keeps), the renewal service and the command record while keeping data; --purge deletes only after the typed name; hosts refuse foreign directories and open transactions; remove refuses what it does not support.\n'
