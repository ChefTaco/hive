#!/usr/bin/env bash
# Real account and SSH-key checks, isolated in the existing disposable Ubuntu host fixture.
set -Eeuo pipefail
root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
if [[ ${HIVE_SUDO_HOST:-} != 1 ]]; then
  scratch=$(mktemp -d)
  trap 'rm -rf -- "$scratch"' EXIT
  exec_status=0
  "$root/scripts/suite/sudo-host.sh" --scratch "$scratch" -- bash "$root/scripts/prepare-terminal.test.sh" || exec_status=$?
  exit "$exec_status"
fi
[[ $(id -u) == 0 && -f /run/hive-sudo-password ]] || { echo 'Run through the disposable host fixture' >&2; exit 1; }
script=$root/scripts/prepare-terminal.sh
bash "$script" --owner deploy
[[ $(id -nG hive-terminal) == hive-terminal && $(id -u hive-terminal) != 0 ]]
[[ $(stat -c '%U:%a' /etc/hive/fleet/gateway-key) == deploy:600 ]]
[[ $(stat -c '%U:%a' /home/hive-terminal/.ssh/authorized_keys) == hive-terminal:600 ]]
before=$(sha256sum /etc/hive/fleet/gateway-key)
bash "$script" --owner deploy
[[ "$before" == "$(sha256sum /etc/hive/fleet/gateway-key)" ]]
cp /etc/hive/fleet/gateway-key.pub /run/original.pub
printf 'different authorized keys\n' > /home/hive-terminal/.ssh/authorized_keys
if bash "$script" --owner deploy > /run/refusal.log 2>&1; then exit 1; fi
grep -q 'different authorized keys' /run/refusal.log
grep -qx 'different authorized keys' /home/hive-terminal/.ssh/authorized_keys
cp /run/original.pub /home/hive-terminal/.ssh/authorized_keys
rm /home/hive-terminal/.ssh/authorized_keys
ln -s /run/original.pub /home/hive-terminal/.ssh/authorized_keys
if bash "$script" --owner deploy > /run/refusal.log 2>&1; then exit 1; fi
grep -q 'Refusing a symlink' /run/refusal.log
rm /home/hive-terminal/.ssh/authorized_keys
cp /run/original.pub /home/hive-terminal/.ssh/authorized_keys
usermod -aG sudo hive-terminal
if bash "$script" --owner deploy > /run/refusal.log 2>&1; then exit 1; fi
grep -q 'additional groups' /run/refusal.log
[[ "$before" == "$(sha256sum /etc/hive/fleet/gateway-key)" ]]
printf 'Passed: restricted terminal account, protected dedicated key, repeat stability, existing-key preservation, symlink and privilege refusals.\n'
