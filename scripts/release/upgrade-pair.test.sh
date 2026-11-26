#!/usr/bin/env bash
# upgrade-pair.sh: the release pair of the upgrade round trip, in a synthetic tree.
set -Eeuo pipefail
ROOT=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)
temporary=$(mktemp -d)
trap 'rm -rf -- "$temporary"' EXIT
fail() { printf 'FAIL: %s\n' "$*" >&2; exit 1; }
git -C "$temporary" init -q; git -C "$temporary" -c user.email=ci@example.com -c user.name=ci commit -q --allow-empty -m start
mkdir "$temporary/releases"
for release in 3.12.7 3.12.8 3.12.9 3.12.10 3.13.0 3.14.0 3.14.1; do printf '{}\n' > "$temporary/releases/$release.json"; printf '{}\n' > "$temporary/releases/$release.inputs.json"; done
for release in 3.12.7 3.12.8 3.12.9 3.12.10 3.13.0 3.14.0; do git -C "$temporary" tag "v$release"; done
pair() { HIVE_PAIR_ROOT=$temporary bash "$ROOT/scripts/release/upgrade-pair.sh" "$@"; }
# The newest tagged release and the one before it; 3.14.1 is signed but not tagged yet.
[[ $(pair) == '3.13.0 3.14.0' ]] || fail "Default pair: $(pair)"
# The release being published: the one before it, in version order (3.12.10 after 3.12.9).
[[ $(pair --to v3.13.0) == '3.12.10 3.13.0' ]] || fail "Pair into 3.13.0: $(pair --to v3.13.0)"
[[ $(pair --to 3.12.10) == '3.12.9 3.12.10' ]] || fail 'Numeric order'
# A never-published release is skipped as FROM.
[[ $(pair --to 3.12.9) == '3.12.7 3.12.9' ]] || fail 'An unpublished release was used'
# A release the newest manifest withdraws is skipped too.
git -C "$temporary" tag v3.14.1
printf '{"withdrawn":[{"version":"3.14.0","action":"refuse","reason":"test"}]}\n' > "$temporary/releases/3.14.1.json"
[[ $(pair) == '3.13.0 3.14.1' ]] || fail "A withdrawn release was used: $(pair)"
[[ $(pair --from 3.12.9 --to 3.14.1) == '3.12.9 3.14.1' ]] || fail 'An explicit pair was changed'
# Refusals: an untagged or unsigned release, a FROM that is not older, bad input.
printf '{}\n' > "$temporary/releases/3.15.0.json"
if pair --to 3.15.0 2>/dev/null; then fail 'An untagged release was accepted'; fi
if pair --to 9.9.9 2>/dev/null; then fail 'An unsigned release was accepted'; fi
if pair --from 3.14.1 --to 3.13.0 2>/dev/null; then fail 'A FROM newer than TO was accepted'; fi
if pair --to 'latest' 2>/dev/null; then fail 'An invalid version was accepted'; fi
printf 'Passed: the round-trip pair is the newest tagged, published, unwithdrawn release and its predecessor, or exactly the named release.\n'
