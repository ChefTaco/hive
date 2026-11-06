#!/usr/bin/env bash
# Definitions only. A host side that runs as root (sudoPasswordFile) on an installation an
# ordinary account owns gives what it wrote back to that account, as a run as that account
# would have left it: backups, rehearsals, transactions, receipts, manifests and the lock. The
# installation directory's owner decides; a root-owned installation, as on production hosts, is
# left exactly as it is. Modes are kept. Service data under data/ keeps its service owners.
restore_installation_owner() {
  local root=${1:-${directory:-}} owner group
  [[ -n "$root" && $(id -u) == 0 && -d "$root" && ! -L "$root" ]] || return 0
  owner=$(stat -c %u -- "$root"); group=$(stat -c %g -- "$root")
  [[ "$owner" != 0 ]] || return 0
  find "$root" -xdev -path "$root/data/*" -prune -o -uid 0 -print0 2>/dev/null | xargs -0 -r chown -h -- "$owner:$group" 2>/dev/null || true
}
