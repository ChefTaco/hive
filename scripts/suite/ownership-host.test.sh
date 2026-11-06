#!/usr/bin/env bash
# Run as root (scripts/suite/online-backup-sudo.sh runs it in the sudo host). What a root host
# side writes in an installation an ordinary account owns goes back to that account, with its
# mode; service data and root-owned, production-style installations are left alone.
#   ownership-host.test.sh SCRATCH_DIRECTORY
set -Eeuo pipefail
ROOT=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)
[[ $(id -u) == 0 ]] || { printf 'ownership-host test: run as root\n' >&2; exit 2; }
base=$1
fail() { printf 'FAIL: %s\n' "$*" >&2; exit 1; }
source "$ROOT/scripts/suite/ownership-host.sh"
owner=4242 group=4243 service=4244
umask 077
fixture() {
  local root=$1
  rm -rf -- "$root"; install -d -m 700 "$root"
  install -d -m 700 "$root/backups/first" "$root/rehearsals/first/data/svc" "$root/data" "$root/config"
  install -d -m 700 -o "$service" -g "$service" "$root/data/svc"
  printf 'archive\n' > "$root/backups/first/state.tar.gz"; chmod 600 "$root/backups/first/state.tar.gz"
  printf '{}\n' > "$root/transaction.json"; chmod 600 "$root/transaction.json"
  printf 'service\n' > "$root/data/svc/store"; chown "$service:$service" "$root/data/svc/store"
  printf 'root\n' > "$root/data/svc/root-store"
  printf 'copy\n' > "$root/rehearsals/first/data/svc/store"; chown "$service:$service" "$root/rehearsals/first/data/svc/store"
  printf 'outside\n' > "$base/outside"; ln -sfn "$base/outside" "$root/config/link"
}
mkdir -p "$base"

# An installation an ordinary account owns.
fixture "$base/user"; chown "$owner:$group" "$base/user"
restore_installation_owner "$base/user"
for path in transaction.json backups backups/first backups/first/state.tar.gz rehearsals rehearsals/first data config config/link; do
  [[ $(stat -c %u:%g -- "$base/user/$path") == "$owner:$group" ]] || fail "$path was not given back to the installation owner"
done
[[ $(stat -c %a "$base/user/backups/first/state.tar.gz") == 600 && $(stat -c %a "$base/user/backups/first") == 700 && $(stat -c %a "$base/user/transaction.json") == 600 ]] || fail 'Modes changed'
[[ $(stat -c %u "$base/user/data/svc") == "$service" && $(stat -c %u "$base/user/data/svc/store") == "$service" ]] || fail 'Service data changed owner'
[[ $(stat -c %u "$base/user/data/svc/root-store") == 0 ]] || fail 'A file inside service data changed owner'
[[ $(stat -c %u "$base/user/rehearsals/first/data/svc/store") == "$service" ]] || fail 'Rehearsal data owned by a service changed owner'
[[ $(stat -c %u "$base/outside") == 0 ]] || fail 'A symlink target outside the installation changed owner'

# A root-owned installation, as production hosts have, keeps every owner.
fixture "$base/root"
before=$(find "$base/root" -printf '%u:%g %m %p\n' | sort)
restore_installation_owner "$base/root"
[[ $(find "$base/root" -printf '%u:%g %m %p\n' | sort) == "$before" ]] || fail 'A root-owned installation changed'
printf 'Passed: a root host side gives an ordinary owner its installation files back, keeps modes, service data and root-owned installations.\n'
