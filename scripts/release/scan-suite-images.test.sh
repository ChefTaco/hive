#!/usr/bin/env bash
set -Eeuo pipefail
root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
mkdir "$work/bin"
cat > "$work/bin/docker" <<'STUB'
#!/usr/bin/env bash
set -eu
printf '%s\n' "$*" >> "$SCAN_CALLS"
if [[ ${SCAN_MALFORMED:-false} == true ]]; then printf '{}'; exit 0; fi
if [[ ${SCAN_FAIL:-false} == true ]]; then exit 23; fi
if [[ " $* " == *' --ignore-unfixed '* ]]; then
 printf '{"SchemaVersion":2,"Results":[{"Vulnerabilities":[]}]}'
else
 printf '{"SchemaVersion":2,"Results":[{"Vulnerabilities":[{"VulnerabilityID":"CVE-2099-12345","PkgName":"fixture","Severity":"HIGH","FixedVersion":""}]}]}'
fi
STUB
chmod +x "$work/bin/docker"
export PATH="$work/bin:$PATH" SCAN_CALLS="$work/calls" TRIVY_CACHE_DIR="$work/cache"
printf '{"components":{"fixture":{"image":"example.com/fixture@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}}}' > "$work/manifest.json"
HIVE_IMAGE_SECURITY_MODE=fixable bash "$root/scripts/release/scan-suite-images.sh" "$work/manifest.json" "$work/fixable" > "$work/fixable.log"
[[ $(find "$work/fixable/raw" -type f | wc -l) == 2 ]]
for file in "$work/fixable/raw/"*.json; do jq -e '.Results[0].Vulnerabilities[0].VulnerabilityID=="CVE-2099-12345"' "$file" >/dev/null; done
if HIVE_IMAGE_SECURITY_MODE=all bash "$root/scripts/release/scan-suite-images.sh" "$work/manifest.json" "$work/all" > "$work/all.log" 2>&1; then echo 'Unfixed finding was accepted by all policy' >&2; exit 1; fi
[[ $(find "$work/all/raw" -type f | wc -l) == 2 ]]
for file in "$work/all/"*.json; do jq -e '.Results[0].Vulnerabilities|length==1' "$file" >/dev/null; done
before=$(wc -l < "$SCAN_CALLS")
if HIVE_IMAGE_SECURITY_MODE=unknown bash "$root/scripts/release/scan-suite-images.sh" "$work/manifest.json" "$work/invalid" > "$work/invalid.log" 2>&1; then echo 'Unknown policy was accepted' >&2; exit 1; fi
[[ $(wc -l < "$SCAN_CALLS") == "$before" ]]
if SCAN_FAIL=true HIVE_IMAGE_SECURITY_MODE=all bash "$root/scripts/release/scan-suite-images.sh" "$work/manifest.json" "$work/error" > "$work/error.log" 2>&1; then echo 'Scanner failure was accepted' >&2; exit 1; fi
printf '{"components":{}}' > "$work/empty.json"
if bash "$root/scripts/release/scan-suite-images.sh" "$work/empty.json" "$work/empty" > "$work/empty.log" 2>&1; then echo 'Empty manifest was accepted' >&2; exit 1; fi
if SCAN_MALFORMED=true bash "$root/scripts/release/scan-suite-images.sh" "$work/manifest.json" "$work/malformed" > "$work/malformed.log" 2>&1; then echo 'Malformed scanner report was accepted' >&2; exit 1; fi
printf 'PASS: retained full reports, unfixed finding refusal, both architectures, invalid policy, empty manifest, malformed report and scanner failure\n'
