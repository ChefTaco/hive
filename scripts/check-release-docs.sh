#!/usr/bin/env bash
# The documentation of the newest signed release in releases/ must be in place before it ships:
# - the install examples name it, so a new user never copies an old version;
# - CHANGELOG.md has a non-empty "## [X.Y.Z]" section, which the release workflow publishes as the
#   release notes;
# - UPGRADING.md has a "## Suite X.Y.Z" section with the upgrade steps;
# - README.md publishes the fingerprint of trust/publisher.pub (SECURITY.md).
# A release commit that adds releases/X.Y.Z.json updates all three.
set -euo pipefail
ROOT=${HIVE_DOCS_ROOT:-$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)}
newest=$(find "$ROOT/releases" -maxdepth 1 -name '[0-9]*.[0-9]*.[0-9]*.json' ! -name '*.inputs.json' -printf '%f\n' | sed 's/\.json$//' | sort -V | tail -n 1)
[[ -n "$newest" ]] || { printf 'check-release-docs: no signed release in releases/\n' >&2; exit 1; }
status=0
for file in README.md deployment/README.md deployment/QUICKSTART.md; do
  while IFS=: read -r line text; do
    printf '%s:%s: names %s; the newest release is %s\n' "$file" "$line" "$text" "$newest" >&2
    status=1
  done < <(grep -noE -e "--branch v[0-9]+\.[0-9]+\.[0-9]+" -e "--release [0-9]+\.[0-9]+\.[0-9]+" -e "releases/[0-9]+\.[0-9]+\.[0-9]+\.json" -e "release \`[0-9]+\.[0-9]+\.[0-9]+\`" -e "^[0-9]+\.[0-9]+\.[0-9]+\` again" "$ROOT/$file" | grep -vF -e "v$newest" -e " $newest" -e "/$newest.json" -e "\`$newest\`" -e "$newest\` again" || true)
done
if ((status)); then printf 'Update the install examples to %s.\n' "$newest" >&2; exit 1; fi
# The same section match as the release workflow's notes extraction (suite-release.yml).
notes=$(awk -v bracketed="## [$newest]" 'index($0, bracketed)==1 {on=1; next} on && /^## / {exit} on' "$ROOT/CHANGELOG.md")
if ! grep -q '[^[:space:]]' <<< "$notes"; then
  printf 'CHANGELOG.md: add release notes under "## [%s] - YYYY-MM-DD"; the release workflow publishes them.\n' "$newest" >&2
  status=1
fi
if ! grep -qE "^## Suite ${newest//./\\.}([: ]|$)" "$ROOT/UPGRADING.md"; then
  printf 'UPGRADING.md: add a "## Suite %s: TITLE" section with its upgrade steps (or "needs no migration flag").\n' "$newest" >&2
  status=1
fi
fingerprint=$(openssl pkey -pubin -in "$ROOT/trust/publisher.pub" -outform DER 2>/dev/null | sha256sum | cut -d ' ' -f1)
if ! grep -qx "$fingerprint" "$ROOT/README.md"; then
  printf 'README.md: the Security section must give the publisher key fingerprint %s on its own line.\n' "$fingerprint" >&2
  status=1
fi
((status == 0)) || exit 1
printf 'Install examples, CHANGELOG and UPGRADING name the newest release, %s.\n' "$newest"
