#!/usr/bin/env bash
set -Eeuo pipefail
ROOT=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)
temporary=$(mktemp -d)
trap 'rm -rf -- "$temporary"' EXIT
fail() { printf 'FAIL: %s\n' "$*" >&2; exit 1; }
bash "$ROOT/scripts/release/check-residual-risks.sh" >/dev/null || fail 'The repository residual risks do not match their pins'
mkdir -p "$temporary/deployment"
cp "$ROOT/deployment/residual-risks.json" "$temporary/deployment/"
jq '(.images[]|select(.image=="hive-qdrant")|.buildArgs.QDRANT_IMAGE)="qdrant/qdrant:v9.9.9@sha256:'"$(printf 'a%.0s' {1..64})"'"' "$ROOT/deployment/images.json" > "$temporary/deployment/images.json"
if HIVE_RISKS_ROOT=$temporary bash "$ROOT/scripts/release/check-residual-risks.sh" 2> "$temporary/err"; then fail 'A changed Qdrant pin passed without re-review'; fi
grep -q 'qdrant-bundled-zstd-1.5 (CVE-2026-124851): hive-qdrant now pins qdrant/qdrant:v9.9.9' "$temporary/err" || fail 'The re-review message is unclear'
jq '.risks[0].id="BAD id"' "$ROOT/deployment/residual-risks.json" > "$temporary/deployment/residual-risks.json"
if HIVE_RISKS_ROOT=$temporary bash "$ROOT/scripts/release/check-residual-risks.sh" 2>/dev/null; then fail 'A malformed register passed'; fi
printf 'Passed: residual risks are bound to their reviewed upstream pins.\n'
