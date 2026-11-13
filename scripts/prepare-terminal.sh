#!/usr/bin/env bash
# Prepare the optional local fleet terminal without borrowing the operator's SSH key.
set -Eeuo pipefail
umask 077
die() { printf 'prepare-terminal: %s\n' "$*" >&2; exit 1; }
[[ $# == 2 && $1 == --owner ]] || die 'Usage: sudo scripts/prepare-terminal.sh --owner USER'
owner=$2
[[ $(id -u) == 0 ]] || die 'Run with sudo'
id "$owner" >/dev/null 2>&1 || die 'Choose the account that runs Hive'
account=hive-terminal
home=/home/hive-terminal
key=/etc/hive/fleet/gateway-key
# Refuse symlinks throughout every privileged destination.
for path in /etc/hive /etc/hive/fleet "$key" "$key.pub" /home "$home" "$home/.ssh" "$home/.ssh/authorized_keys"; do
  [[ ! -L "$path" ]] || die "Refusing a symlink at $path"
done
if id "$account" >/dev/null 2>&1; then
  [[ $(getent passwd "$account" | cut -d: -f6) == "$home" && $(id -u "$account") != 0 ]] || die 'The terminal account has an unexpected home or UID'
  [[ $(id -nG "$account") == "$account" ]] || die 'The terminal account has additional groups; review it manually'
else
  # The home is named, so a host whose useradd default is elsewhere passes the check above on a repeat.
  useradd --create-home --home-dir "$home" --shell /bin/bash --comment 'Hive web terminal' "$account"
fi
install -d -m 0700 -o "$owner" -g "$(id -gn "$owner")" /etc/hive/fleet
if [[ -e "$key" ]]; then
  [[ -f "$key" && -f "$key.pub" && $(stat -c %U "$key") == "$owner" && $(stat -c %a "$key") == 600 ]] || die 'The existing gateway key needs manual review'
  public=$(runuser -u "$owner" -- ssh-keygen -y -f "$key" | cut -d' ' -f1,2)
  [[ $(cut -d' ' -f1,2 "$key.pub") == "$public" ]] || die 'The gateway public key does not match'
else
  [[ ! -e "$key.pub" ]] || die 'A gateway public key already exists without its private key'
  runuser -u "$owner" -- ssh-keygen -q -t ed25519 -N '' -C hive-fleet-gateway -f "$key"
fi
authorized="$home/.ssh/authorized_keys"
if [[ -e "$authorized" ]] && ! cmp -s "$key.pub" "$authorized"; then die 'The terminal account already has different authorized keys; nothing was overwritten'; fi
install -d -m 0700 -o "$account" -g "$account" "$home/.ssh"
install -m 0600 -o "$account" -g "$account" "$key.pub" "$authorized"
printf 'Local terminal account and dedicated key are ready. No sudo rights were granted.\n'
