#!/usr/bin/env bash
# Definitions only. The interpreter runs in a restricted, pinned container.
check_data() {
  local base=$1 definition=$2 service uid gid scratch code
  code=$(jq -er .integrityScript <<< "$input" | base64 -d)
  code+=$'\nconsole.log(JSON.stringify(checkData("/data","/scratch")));'
  while read -r service uid gid; do
    scratch=$(mktemp -d "$base/.integrity-$service.XXXXXX") || return 1
    chown -- "$uid:$gid" "$scratch" || return 1
    # Return immediately on any failed product. A later healthy datastore must
    # never mask an earlier database integrity failure in the shell loop.
    docker run --rm --read-only --cap-drop ALL --security-opt no-new-privileges:true --network none --user "$uid:$gid" \
      --mount "type=bind,source=$base/data/$service,target=/data,readonly" \
      --mount "type=bind,source=$scratch,target=/scratch" \
      --entrypoint node "$recovery_image" --input-type=module -e "$code" || return 1
    rm -rf -- "$scratch"
  done < <(jq -r '.services|to_entries[]|select(any(.value.volumes[]?; .target=="/data"))|[.key,(.value.user|split(":")[])]|@tsv' "$definition")
}
