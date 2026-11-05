#!/usr/bin/env bash
# Builds every suite image from a clean sibling checkout as NAME:candidate, labelled
# with its exact source revision. Refuses dirty trees so a tag always maps to source.
#   HIVE_PRODUCTS_ROOT  directory holding the product checkouts (default: parent of Hive)
set -Eeuo pipefail
hive_root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)
products=${HIVE_PRODUCTS_ROOT:-$(dirname -- "$hive_root")}
# image | checkout | dockerfile | target
images=(
  'emberpath|Emberpath|Dockerfile|'
  'oathweave|Oathweave|Dockerfile|'
  'hivemem|HiveMem|Dockerfile|'
  'hiveskills|HiveSkills|Dockerfile|'
  'hivexui|HiveXUI|Dockerfile|'
  'cindertrace|Cindertrace|Dockerfile|'
  'chattermost|ChatterMost|deploy/Dockerfile|application'
  'chattermost-migrator|ChatterMost|deploy/Dockerfile|migrator'
  'emberfold|Emberfold|Dockerfile|'
  'magnus-server|Magnus|services/control-api/Dockerfile|'
  'magnus-agent|Magnus|packages/agent/Dockerfile|'
  'hive-ingress|Hive/deployment|ingress.Dockerfile|'
  'hive-registry|Hive/services/hive-registry|Dockerfile|'
)
selected=("$@")
for entry in "${images[@]}"; do
  IFS='|' read -r image checkout dockerfile target <<<"$entry"
  if ((${#selected[@]})); then
    wanted=false; for name in "${selected[@]}"; do [[ $name == "$image" ]] && wanted=true; done
    [[ $wanted == true ]] || continue
  fi
  context="$products/$checkout"
  if [[ -n $(git -C "$context" status --porcelain -- .) ]]; then
    printf 'Refusing to build %s: %s has uncommitted changes\n' "$image" "$checkout" >&2; exit 1
  fi
  revision=$(git -C "$context" rev-parse HEAD)
  printf '==> %s @ %s\n' "$image" "${revision:0:12}"
  args=(build -q -f "$context/$dockerfile" -t "$image:candidate"
    --label "org.opencontainers.image.revision=$revision"
    --label "org.opencontainers.image.title=$image")
  [[ -z $target ]] || args+=(--target "$target")
  docker "${args[@]}" "$context"
done
