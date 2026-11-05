#!/usr/bin/env bash
# Definitions only. The interpreter runs in a restricted, pinned container.
check_data() {
  local base=$1 definition=$2 service uid gid scratch code image
  code=$(jq -er .integrityScript <<< "$input" | base64 -d)
  code+=$'\nconsole.log(JSON.stringify(checkData("/data","/scratch")));'
  while read -r service uid gid; do
    if [[ -f "$base/data/$service/pgdata/PG_VERSION" ]]; then
      jq -e --arg name "$service" '.services[$name].environment.PGDATA=="/data/pgdata"' "$definition" >/dev/null || return 1
      image=$(jq -er --arg name "$service" '.services[$name].image' "$definition") || return 1
      [[ "$image" =~ @sha256:[a-f0-9]{64}$ ]] || return 1
      # Run the exact datastore version's offline verifier on a read-only mount.
      # A cluster without checksums needs its product-owned logical recovery
      # adapter; disabling verification is never an automatic migration step.
      docker run --rm --read-only --cap-drop ALL --security-opt no-new-privileges:true --network none --user "$uid:$gid" \
        --mount "type=bind,source=$base/data/$service,target=/data,readonly" \
        --entrypoint pg_checksums "$image" --check --pgdata=/data/pgdata || return 1
      continue
    fi
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
