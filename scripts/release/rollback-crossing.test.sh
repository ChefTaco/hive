#!/usr/bin/env bash
# rollback-crossing.sh: which components a code-only rollback cannot read, on synthetic manifests
# and on the signed releases where the answer is known.
set -euo pipefail
ROOT=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)
temporary=$(mktemp -d)
trap 'rm -rf -- "$temporary"' EXIT
fail() { printf 'FAIL: %s\n' "$*" >&2; exit 1; }
crossing() { bash "$ROOT/scripts/release/rollback-crossing.sh" "$@"; }
printf '{"components":{"a":{"storageFormat":"a-v1"},"b":{"storageFormat":"b-v1","readableFormats":["b-v1","b-v2"]},"c":{"storageFormat":"c-v1"},"d":{}}}' > "$temporary/from.json"
printf '{"components":{"a":{"storageFormat":"a-v1"},"b":{"storageFormat":"b-v2"},"c":{"storageFormat":"c-v2"},"d":{},"e":{"storageFormat":"e-v1"}}}' > "$temporary/to.json"
[[ $(crossing "$temporary/from.json" "$temporary/to.json") == c ]] || fail 'Only c crosses: a is unchanged, b is readable by the older release, d is unversioned in both and e is new'
[[ -z $(crossing "$temporary/from.json" "$temporary/from.json") ]] || fail 'A release crosses nothing to itself'
if crossing "$temporary/from.json" 2>/dev/null; then fail 'A missing manifest was accepted'; fi
# Signed releases: 3.14.2 -> 3.14.3 rolls back; 3.14.3 -> 3.15.0 crosses Oathweave's and HiveSkills' formats.
[[ -z $(crossing "$ROOT/releases/3.14.2.json" "$ROOT/releases/3.14.3.json") ]] || fail '3.14.3 should roll back to 3.14.2'
[[ $(crossing "$ROOT/releases/3.14.3.json" "$ROOT/releases/3.15.0.json" | sort | tr '\n' ' ') == 'hiveskills oathweave ' ]] || fail '3.15.0 should cross the Oathweave and HiveSkills formats'
printf 'Passed: rollback crossings of synthetic and signed releases.\n'
