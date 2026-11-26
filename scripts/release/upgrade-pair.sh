#!/usr/bin/env bash
# The release pair of the upgrade round trip (release-upgrade.yml), printed as "FROM TO".
#   upgrade-pair.sh [--to VERSION|vVERSION] [--from VERSION|vVERSION]
# TO defaults to the newest eligible release, FROM to the newest eligible release older than TO.
# Eligible: a signed manifest in releases/ with its tag, that the newest manifest does not
# withdraw and that was published (3.2.1 and 3.12.8 were tagged but never published). A release
# named with --to or --from must be signed and tagged. HIVE_PAIR_ROOT points at another tree.
set -euo pipefail
root=${HIVE_PAIR_ROOT:-$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)}
to='' from=''
while (($#)); do
  case $1 in
    --to) to=${2#v}; shift 2;;
    --from) from=${2#v}; shift 2;;
    *) printf 'Use: upgrade-pair.sh [--to VERSION] [--from VERSION]\n' >&2; exit 2;;
  esac
done
die() { printf 'upgrade-pair: %s\n' "$*" >&2; exit 1; }
version='^[0-9]+\.[0-9]+\.[0-9]+$'
[[ -z "$to" || "$to" =~ $version ]] || die "Invalid --to $to"
[[ -z "$from" || "$from" =~ $version ]] || die "Invalid --from $from"
mapfile -t all < <(find "$root/releases" -maxdepth 1 -name '[0-9]*.[0-9]*.[0-9]*.json' ! -name '*.inputs.json' -printf '%f\n' | sed 's/\.json$//' | grep -E "$version" | sort -V)
((${#all[@]})) || die 'No signed release in releases/'
tagged() { git -C "$root" rev-parse -q --verify "refs/tags/v$1^{commit}" >/dev/null; }
signed() { [[ -f "$root/releases/$1.json" ]]; }
skip=$( { jq -r '(.withdrawn // [])[].version' "$root/releases/${all[-1]}.json" 2>/dev/null || true; printf '3.2.1\n3.12.8\n'; } | sort -u)
eligible=()
for release in "${all[@]}"; do
  grep -qxF -- "$release" <<< "$skip" && continue
  tagged "$release" && eligible+=("$release")
done
older() { [[ "$1" != "$2" && $(printf '%s\n%s\n' "$1" "$2" | sort -V | head -n 1) == "$1" ]]; }
if [[ -n "$to" ]]; then signed "$to" && tagged "$to" || die "Release $to is not signed and tagged here"
else ((${#eligible[@]})) || die 'No eligible release'; to=${eligible[-1]}; fi
if [[ -n "$from" ]]; then signed "$from" && tagged "$from" || die "Release $from is not signed and tagged here"
else
  for release in "${eligible[@]}"; do older "$release" "$to" && from=$release; done
  [[ -n "$from" ]] || die "No eligible release before $to"
fi
older "$from" "$to" || die "$from is not older than $to"
printf '%s %s\n' "$from" "$to"
