#!/usr/bin/env bash
# Every residual risk in deployment/residual-risks.json still matches the upstream pin it was
# reviewed for. A changed pin fails until the entry is re-reviewed: resolved (removed) or
# confirmed for the new pin (reviewedPin and reviewed updated).
set -Eeuo pipefail
root=${HIVE_RISKS_ROOT:-$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)}
risks=$root/deployment/residual-risks.json images=$root/deployment/images.json
jq -e '.schema==1 and (.risks|type=="array") and all(.risks[];
  (.id|type=="string" and test("^[a-z0-9][a-z0-9.-]*$")) and (.advisory|type=="string") and (.image|type=="string") and
  (.buildArg|type=="string") and (.reviewedPin|type=="string" and test("@sha256:[a-f0-9]{64}$")) and
  (.reviewed|type=="string" and test("^[0-9]{4}-[0-9]{2}-[0-9]{2}$")) and (.summary|type=="string") and (.resolveWhen|type=="string"))
  and ([.risks[].id]|length==(unique|length))' "$risks" >/dev/null || { echo 'deployment/residual-risks.json is malformed' >&2; exit 1; }
status=0
while IFS=$'\t' read -r id advisory image argument reviewed; do
  current=$(jq -r --arg image "$image" --arg argument "$argument" '[.images[]|select(.image==$image)]|last|.buildArgs[$argument] // empty' "$images")
  if [[ -z "$current" ]]; then
    printf 'Residual risk %s (%s): %s has no %s in deployment/images.json; remove or update the entry\n' "$id" "$advisory" "$image" "$argument" >&2; status=1
  elif [[ "$current" != "$reviewed" ]]; then
    printf 'Residual risk %s (%s): %s now pins %s, reviewed for %s. Check whether the new pin resolves it (see resolveWhen) and remove the entry, or confirm it and update reviewedPin and reviewed\n' "$id" "$advisory" "$image" "$current" "$reviewed" >&2; status=1
  else
    printf 'residual risk %s (%s): still present in %s, reviewed\n' "$id" "$advisory" "$image"
  fi
done < <(jq -r '.risks[]|[.id,.advisory,.image,.buildArg,.reviewedPin]|@tsv' "$risks")
exit "$status"
