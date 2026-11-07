#!/usr/bin/env bash
# The install examples name the newest signed release in releases/, so a release commit that
# adds releases/X.Y.Z.json also updates them, and a new user never copies an old version.
set -euo pipefail
ROOT=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
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
printf 'Install examples name the newest release, %s.\n' "$newest"
