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
start='<!-- upgrade-matrix:start (generated from deployment/upgrade-matrix.json by scripts/release/upgrade-matrix.mjs --write) -->'
printf '%s\n<!-- upgrade-matrix:end -->\nAfter.\n' "$start" >> "$temporary/deployment/QUICKSTART.md"
matrix() { jq -n --argjson rows "$1" '{rows:$rows}' > "$temporary/deployment/upgrade-matrix.json"; }
matrix '[{"to":"1.2.2","from":"1.2.1","flag":"no","note":"Old.","upgrading":"suite-122-old"},{"to":"1.2.3","from":"1.2.2","flag":"when","when":"the installation has a fixture store","note":"A change.","upgrading":"suite-123-things"}]'
HIVE_DOCS_ROOT=$temporary node "$ROOT/scripts/release/upgrade-matrix.mjs" --write
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
# The upgrade matrix: generated, current, and with a row for the newest release.
printf '# Upgrading\n\n## Suite 1.2.3: things\n\nNo flag.\n' > "$temporary/UPGRADING.md"
grep -qF '| [1.2.3](../UPGRADING.md#suite-123-things) | 1.2.2 | Only when the installation has a fixture store | A change. |' "$temporary/deployment/QUICKSTART.md" || fail 'The upgrade matrix was not generated'
sed -i 's/A change\. |/A changed note. |/' "$temporary/deployment/QUICKSTART.md"
check && fail 'A hand-edited upgrade matrix was accepted'
grep -q 'QUICKSTART.md is stale' "$temporary/out" || fail 'A stale upgrade matrix was not explained'
HIVE_DOCS_ROOT=$temporary node "$ROOT/scripts/release/upgrade-matrix.mjs" --write
check || { cat "$temporary/out" >&2; fail 'A regenerated upgrade matrix was refused'; }
matrix '[{"to":"1.2.2","from":"1.2.1","flag":"no","note":"Old.","upgrading":"suite-122-old"}]'
HIVE_DOCS_ROOT=$temporary node "$ROOT/scripts/release/upgrade-matrix.mjs" --write 2>/dev/null && fail 'A matrix without the newest release was written'
check && fail 'An upgrade matrix without the newest release was accepted'
grep -q 'the newest release, 1.2.3, has no row' "$temporary/out" || fail 'The missing row was not explained'
for bad in '[{"to":"1.2.3","from":"1.2.2","flag":"maybe","upgrading":"x"}]' '[{"to":"1.2.3","from":"1.2.2","flag":"when","upgrading":"x"}]' '[{"to":"9.9.9","from":"1.2.2","flag":"no","upgrading":"x"},{"to":"1.2.3","from":"1.2.2","flag":"no","upgrading":"x"}]' '[{"to":"1.2.3","from":"1.2.2","flag":"no","upgrading":"x"},{"to":"1.2.2","from":"1.2.1","flag":"no","upgrading":"x"}]' '[{"to":"1.2.3","from":"a | b","flag":"no","upgrading":"x"}]'; do
  matrix "$bad"
  check && fail "An invalid upgrade matrix was accepted: $bad"
done
check_repository() { bash "$ROOT/scripts/check-release-docs.sh" >/dev/null || fail 'The repository documentation fails its own check'; }
check_repository
printf 'Passed: release docs check (install examples, CHANGELOG notes, UPGRADING section, key fingerprint, upgrade matrix).\n'
