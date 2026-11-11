#!/usr/bin/env bash
# Release gate: every image a suite manifest pins (components and initialization images),
# on linux/amd64 and linux/arm64, must satisfy the selected HIGH/CRITICAL policy.
# The all policy includes unfixed findings; fixable retains the historical default.
# Accepted exceptions live in deployment/trivy/<image>.trivyignore.yaml, one file per image
# repository, each entry scoped to one advisory and package with its justification.
# Usage: scripts/release/scan-suite-images.sh releases/X.Y.Z.json [REPORT_DIR]
set -Eeuo pipefail
root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)
manifest=${1:?usage: scan-suite-images.sh MANIFEST [REPORT_DIR]}
reports=${2:-$(mktemp -d)}
mode=${HIVE_IMAGE_SECURITY_MODE:-fixable}
case "$mode" in fixable|all) ;; *) echo 'HIVE_IMAGE_SECURITY_MODE must be fixable or all' >&2; exit 2;; esac
unfixed_args=()
[[ "$mode" != fixable ]] || unfixed_args=(--ignore-unfixed)
trivy=aquasec/trivy@sha256:be1190afcb28352bfddc4ddeb71470835d16462af68d310f9f4bca710961a41e # 0.70.0
cache=${TRIVY_CACHE_DIR:-${XDG_CACHE_HOME:-$HOME/.cache}/hive-trivy}
mkdir -p "$reports" "$reports/raw" "$cache"
failed=0
images=$(jq -er '[.components[]|.image,(.initialization.image // empty)]|unique|if length==0 then error("No pinned images") else .[] end' "$manifest") || { echo 'Manifest must contain pinned images' >&2; exit 1; }
while IFS= read -r image; do
  [[ "$image" =~ ^[a-zA-Z0-9._:/-]+@sha256:[a-f0-9]{64}$ ]] || { echo 'Manifest image must be pinned to a SHA256 digest' >&2; exit 1; }
done <<< "$images"
validate_report() {
  jq -e '.SchemaVersion==2 and (.Results|type=="array") and all(.Results[]; ((.Vulnerabilities // [])|type=="array") and all(.Vulnerabilities[]?; (.VulnerabilityID|type=="string" and length>0) and (.PkgName|type=="string" and length>0) and (.Severity=="HIGH" or .Severity=="CRITICAL")))' "$1" >/dev/null || { echo 'Scanner returned an invalid report' >&2; return 1; }
}
while IFS= read -r image; do
  name=${image%@*}; name=${name##*/}
  ignore=()
  if [[ -f "$root/deployment/trivy/$name.trivyignore.yaml" ]]; then ignore=(--ignorefile "/ignore/$name.trivyignore.yaml"); fi
  for platform in linux/amd64 linux/arm64; do
    report="$reports/$name-${image##*:}-${platform#linux/}.json"; report=${report//sha256:/}
    docker run --rm -v "$cache:/root/.cache/trivy" -v "$root/deployment/trivy:/ignore:ro" "$trivy" image --quiet \
      --platform "$platform" --severity HIGH,CRITICAL "${unfixed_args[@]}" "${ignore[@]}" --format json "$image" > "$report"
    validate_report "$report"
    count=$(jq '[.Results[]?.Vulnerabilities[]?]|length' "$report")
    # Retain the complete, unfiltered answer, including unfixed findings and scoped
    # exceptions. The gated answer alone cannot support remediation decisions.
    docker run --rm -v "$cache:/root/.cache/trivy" "$trivy" image --quiet --skip-db-update --platform "$platform" --severity HIGH,CRITICAL --format json "$image" > "$reports/raw/$(basename "$report")"
    validate_report "$reports/raw/$(basename "$report")"
    unfixed=$(jq '[.Results[]?.Vulnerabilities[]?|select((.FixedVersion // "")=="")|.VulnerabilityID]|unique|join(" ")' -r "$reports/raw/$(basename "$report")")
    printf '%-58s %-11s %s=%s unfixed: %s\n' "${image:0:58}" "$platform" "$mode" "$count" "${unfixed:-none}"
    (( count == 0 )) || failed=1
  done
done <<< "$images"
(( failed == 0 )) || { echo "HIGH or CRITICAL findings remain in the selected $mode policy; see the reports in $reports" >&2; exit 1; }
echo "All pinned images: 0 HIGH/CRITICAL in the $mode policy (reports in $reports)"
