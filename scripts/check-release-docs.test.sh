#!/usr/bin/env bash
# check-release-docs.sh refuses a newest release without install examples, notes or upgrade steps.
set -Eeuo pipefail
ROOT=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
temporary=$(mktemp -d)
trap 'rm -rf -- "$temporary"' EXIT
fail() { printf 'FAIL: %s\n' "$*" >&2; exit 1; }
mkdir -p "$temporary/releases" "$temporary/deployment" "$temporary/trust"
openssl genpkey -algorithm ED25519 -out "$temporary/key" >/dev/null 2>&1
openssl pkey -in "$temporary/key" -pubout -out "$temporary/trust/publisher.pub" >/dev/null 2>&1
fingerprint=$(openssl pkey -pubin -in "$temporary/trust/publisher.pub" -outform DER | sha256sum | cut -d ' ' -f1)
printf '{}\n' > "$temporary/releases/1.2.3.json"
printf '{}\n' > "$temporary/releases/1.2.3.inputs.json"
printf '{}\n' > "$temporary/releases/1.2.2.json"
for file in README.md deployment/README.md deployment/QUICKSTART.md; do printf './hive.sh --release 1.2.3\n' > "$temporary/$file"; done
printf '%s\n' "$fingerprint" >> "$temporary/README.md"
good_changelog='# Changelog\n\n## [Unreleased]\n\n## [1.2.3] - 2026-01-01\n\n- A change.\n\n## [1.2.2] - 2025-12-01\n\n- Older.\n'
printf "$good_changelog" > "$temporary/CHANGELOG.md"
printf '# Upgrading\n\n## Suite 1.2.3: things\n\nNo flag.\n' > "$temporary/UPGRADING.md"
check() { HIVE_DOCS_ROOT=$temporary bash "$ROOT/scripts/check-release-docs.sh" > "$temporary/out" 2>&1; }
check || { cat "$temporary/out" >&2; fail 'Complete documentation was refused'; }
printf './hive.sh --release 1.2.2\n%s\n' "$fingerprint" > "$temporary/README.md"
check && fail 'An old install example was accepted'
grep -q 'README.md:1: names --release 1.2.2' "$temporary/out" || fail 'The stale example was not named'
printf './hive.sh --release 1.2.3\n' > "$temporary/README.md"
check && fail 'A README without the publisher key fingerprint was accepted'
grep -q "publisher key fingerprint $fingerprint" "$temporary/out" || fail 'The missing fingerprint was not explained'
printf '%s\n' "$fingerprint" >> "$temporary/README.md"
printf '# Changelog\n\n## [1.2.3] - 2026-01-01\n\n## [1.2.2] - 2025-12-01\n\n- Older.\n' > "$temporary/CHANGELOG.md"
check && fail 'An empty CHANGELOG section was accepted'
grep -q 'CHANGELOG.md: add release notes under "## \[1.2.3\]' "$temporary/out" || fail 'Empty notes were not explained'
printf '# Changelog\n\n## [1.2.2] - 2025-12-01\n\n- Older.\n' > "$temporary/CHANGELOG.md"
check && fail 'A missing CHANGELOG section was accepted'
printf "$good_changelog" > "$temporary/CHANGELOG.md"
printf '# Upgrading\n\n## Suite 1.2.30: other\n\n## Suite 1.2.2: old\n' > "$temporary/UPGRADING.md"
check && fail 'A missing UPGRADING section was accepted'
grep -q 'UPGRADING.md: add a "## Suite 1.2.3' "$temporary/out" || fail 'The missing UPGRADING section was not explained'
check_repository() { bash "$ROOT/scripts/check-release-docs.sh" >/dev/null || fail 'The repository documentation fails its own check'; }
check_repository
printf 'Passed: release docs check (install examples, CHANGELOG notes, UPGRADING section, key fingerprint).\n'
