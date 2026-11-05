#!/usr/bin/env bash
# Release gate: every image a suite manifest pins (components and initialization images),
# on linux/amd64 and linux/arm64, must have no CRITICAL or HIGH finding with a fix available.
# Accepted exceptions live in deployment/trivy/<image>.trivyignore.yaml, one file per image
# repository, each entry scoped to one advisory and package with its justification.
# Usage: scripts/release/scan-suite-images.sh releases/X.Y.Z.json [REPORT_DIR]
set -Eeuo pipefail
root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)
manifest=${1:?usage: scan-suite-images.sh MANIFEST [REPORT_DIR]}
reports=${2:-$(mktemp -d)}
trivy=aquasec/trivy@sha256:be1190afcb28352bfddc4ddeb71470835d16462af68d310f9f4bca710961a41e # 0.70.0
cache=${TRIVY_CACHE_DIR:-${XDG_CACHE_HOME:-$HOME/.cache}/hive-trivy}
mkdir -p "$reports" "$cache"
failed=0
while IFS= read -r image; do
  name=${image%@*}; name=${name##*/}
  ignore=()
  if [[ -f "$root/deployment/trivy/$name.trivyignore.yaml" ]]; then ignore=(--ignorefile "/ignore/$name.trivyignore.yaml"); fi
  for platform in linux/amd64 linux/arm64; do
    report="$reports/$name-${image##*:}-${platform#linux/}.json"; report=${report//sha256:/}
    docker run --rm -v "$cache:/root/.cache/trivy" -v "$root/deployment/trivy:/ignore:ro" "$trivy" image --quiet \
      --platform "$platform" --severity HIGH,CRITICAL --ignore-unfixed "${ignore[@]}" --format json "$image" > "$report"
    count=$(jq '[.Results[]?.Vulnerabilities[]?]|length' "$report")
    unfixed=$(docker run --rm -v "$cache:/root/.cache/trivy" "$trivy" image --quiet --skip-db-update --platform "$platform" --severity HIGH,CRITICAL --format json "$image" | jq '[.Results[]?.Vulnerabilities[]?|select((.FixedVersion // "")=="")|.VulnerabilityID]|unique|join(" ")' -r)
    printf '%-58s %-11s fixable=%s unfixed: %s\n' "${image:0:58}" "$platform" "$count" "${unfixed:-none}"
    (( count == 0 )) || failed=1
  done
done < <(jq -r '[.components[]|.image,(.initialization.image // empty)]|unique[]' "$manifest")
(( failed == 0 )) || { echo 'Fixable HIGH or CRITICAL findings remain; see the reports in '"$reports" >&2; exit 1; }
echo "All pinned images: 0 fixable HIGH/CRITICAL (reports in $reports)"
