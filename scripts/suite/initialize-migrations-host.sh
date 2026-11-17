#!/usr/bin/env bash
# Functions are transported before host-runtime.sh; all values remain JSON data.
hive_initialization_migrations() {
  local candidate=$1 bootstrap=$2 receipt=$3 mode=${4:-apply} allow=${5:-true} component state specification temporary
  [[ "$mode" == apply || "$mode" == verify-first ]] || die 'Unknown product migration mode'
  local manifest="$directory/manifest.$plan.json"
  local -a arguments
  while IFS= read -r component; do
    specification=$(jq -c --arg name "$component" '.components[$name].initialization' "$manifest") || die 'Signed schema specification could not be read'
    state=$(jq -r --arg name "$component" '.initializations[$name].phase // "new"' "$receipt") || die 'Schema journal could not be read'
    temporary="$directory/bootstrap.$plan.$component.compose.json"
    jq --arg name "$component" --argjson specification "$specification" '
      .services[$name].image=$specification.image |
      .services[$name] |= (del(.ports,.restart,.depends_on) |
        if $specification.entrypoint then .entrypoint=$specification.entrypoint else . end) |
      (if $specification.workingDirectory then .services[$name].working_dir=$specification.workingDirectory else . end) |
      .services[$name].command=$specification.verificationCommand
    ' "$bootstrap" > "$temporary" || die 'Schema migration composition could not be prepared'
    chmod 600 "$temporary" || die 'Schema migration composition could not be protected'
    docker compose -f "$temporary" config --quiet || die 'Schema migration composition is invalid'
    if [[ "$state" != new ]]; then
      jq -e --arg name "$component" --argjson specification "$specification" '.initializations[$name] | (.phase|IN("claimed","verified")) and .specification==$specification' "$receipt" >/dev/null || die 'Initial migration journal differs from the exact signed product specification'
      # A claimed migration has an uncertain outcome. Only its owning product's
      # exact completion verifier can reconcile it; never execute it again here.
      if ! docker compose -f "$temporary" run --no-deps --rm -T "$component" < /dev/null > "$directory/bootstrap.$plan.$component.verify.log" 2>&1; then
        die 'Initial migration outcome needs product-owned recovery; the exact completion verifier did not pass and no migration was replayed'
      fi
    elif [[ "$mode" == verify-first ]] && docker compose -f "$temporary" run --no-deps --rm -T "$component" < /dev/null > "$directory/bootstrap.$plan.$component.verify.log" 2>&1; then
      # A current schema needs no mutation, even when only the suite version changed.
      jq --arg name "$component" --argjson specification "$specification" '.initializations[$name]={phase:"verified",specification:$specification}' "$receipt" | atomic_json "$receipt" || die 'Schema migration journal could not be saved; no further migration was started'
    else
      [[ "$allow" == true ]] || die 'Pending product schema changes require --allow-migrations; no schema migration was started'
      jq --arg name "$component" --argjson specification "$specification" '.initializations[$name]={phase:"claimed",specification:$specification}' "$receipt" | atomic_json "$receipt" || die 'Schema migration journal could not be saved; no further migration was started'
      mapfile -t arguments < <(jq -r '.command[]' <<< "$specification")
      ((${#arguments[@]})) || die 'Signed schema migration command is missing'
      if ! docker compose -f "$temporary" run --no-deps --rm -T "$component" "${arguments[@]}" < /dev/null > "$directory/bootstrap.$plan.$component.apply.log" 2>&1; then
        die 'Initial product migration failed or has an unknown outcome; preserve its protected journal and use the owning product recovery procedure'
      fi
      if ! docker compose -f "$temporary" run --no-deps --rm -T "$component" < /dev/null > "$directory/bootstrap.$plan.$component.verify.log" 2>&1; then
        die 'Initial product migration did not pass its exact completion verifier; application activation remains held'
      fi
    fi
    jq --arg name "$component" '.initializations[$name].phase="verified"' "$receipt" | atomic_json "$receipt" || die 'Schema migration journal could not be saved; no further migration was started'
  done < <(jq -r --slurpfile candidate "$candidate" '.components|to_entries[]|select(.value.initialization!=null and $candidate[0].services[.key]!=null)|.key' "$manifest")
  jq -e --slurpfile manifest "$manifest" --slurpfile candidate "$candidate" '
    . as $receipt | all($manifest[0].components|to_entries[]|select(.value.initialization!=null and $candidate[0].services[.key]!=null); .key as $name | $receipt.initializations[$name].phase=="verified")
  ' "$receipt" >/dev/null || die 'Not every selected product migration has an exact verified completion receipt; activation remains held'
}

# Schema migrations can change without a storage-format change. Verify the exact signed
# product in restored copies and again on the stopped live stores. Only private datastores
# start; application listeners and workers remain stopped until all verifiers pass.
hive_upgrade_schema_migrations() (
  local candidate=$1 manifest=$2 directory=$3 allow=$4 journal bootstrap component
  local -a datastores
  [[ $(jq '[.components[]|select(.initialization!=null)]|length' "$manifest") != 0 ]] || return 0
  if [[ "$manifest" != "$directory/manifest.$plan.json" ]]; then cp -- "$manifest" "$directory/manifest.$plan.json" || die 'Schema manifest could not be staged'; fi
  journal="$directory/schema-upgrade.$plan.json"
  bootstrap="$directory/schema-upgrade.$plan.compose.json"
  if [[ -f "$journal" ]]; then
    jq -e --arg plan "$plan" --arg sha "$(sha256sum "$manifest" | cut -d ' ' -f1)" '.schema==1 and .plan==$plan and .manifestSHA256==$sha' "$journal" >/dev/null || die 'Schema migration journal differs from the exact signed candidate'
  else
    jq -n --arg plan "$plan" --arg sha "$(sha256sum "$manifest" | cut -d ' ' -f1)" '{schema:1,plan:$plan,manifestSHA256:$sha,phase:"started"}' | atomic_json "$journal" || die 'Schema upgrade journal could not be saved'
  fi
  prepare_data_directories "$candidate"
  jq '.services|=map_values(del(.ports,.restart) | .environment=((.environment // {}) + {
    HIVE_AUTO_MIGRATE:"false",HIVE_AUTO_UPGRADE:"false",HIVE_UPDATE_CHECK:"false",MAGNUS_AUTO_MIGRATE:"false",
    HIVEMEM_WORKER_ENABLED:"false",HIVE_SKILLS_DEPLOYMENT_WORKER_ENABLED:"false",
    SECURITY_FUSION_DISPATCH_ENABLED:"false",SECURITY_FUSION_COLLECTOR_ENABLED:"false",
    SECURITY_DISPATCH_ENABLED:"false",SECURITY_INGEST_ENABLED:"false",SECURITY_RETENTION_ENABLED:"false",SECURITY_NOTIFICATIONS_ENABLED:"false"
  }))' "$candidate" > "$bootstrap" || die 'Schema upgrade composition could not be rendered'
  chmod 600 "$bootstrap" || die 'Schema upgrade composition could not be protected'
  docker compose -f "$bootstrap" config --quiet || die 'Schema upgrade composition is invalid'
  mapfile -t datastores < <(jq -r --slurpfile release "$manifest" '.services|keys[]|. as $name|select($release[0].components[$name].kind=="datastore")' "$bootstrap")
  if ((${#datastores[@]})); then docker compose -f "$bootstrap" up -d --wait --wait-timeout 180 "${datastores[@]}" || die 'Schema migration datastores are not ready'; fi
  hive_initialization_migrations "$candidate" "$bootstrap" "$journal" verify-first "$allow"
  docker compose -f "$bootstrap" stop --timeout 45 || die 'Schema migration datastores did not stop'
  jq '.phase="ready"' "$journal" | atomic_json "$journal" || die 'Schema upgrade journal could not be saved'
)

# Read-only preflight before quiescence: a missing approval must not take the suite down.
hive_schema_upgrade_preflight() {
  local candidate=$1 manifest=$2 component specification temporary
  while IFS= read -r component; do
    specification=$(jq -c --arg name "$component" '.components[$name].initialization' "$manifest") || die 'Schema verifier specification could not be read'
    temporary="$directory/schema-preflight.$plan.$component.compose.json"
    jq --arg name "$component" --argjson specification "$specification" '
      .services[$name].image=$specification.image |
      .services[$name] |= (del(.ports,.restart,.depends_on) |
        .environment=((.environment // {}) + {MAGNUS_AUTO_MIGRATE:"false",HIVE_AUTO_MIGRATE:"false",HIVE_AUTO_UPGRADE:"false",HIVE_UPDATE_CHECK:"false"}) |
        if $specification.entrypoint then .entrypoint=$specification.entrypoint else . end) |
      (if $specification.workingDirectory then .services[$name].working_dir=$specification.workingDirectory else . end) |
      .services[$name].command=$specification.verificationCommand
    ' "$candidate" > "$temporary" || die 'Schema verifier composition could not be prepared'
    chmod 600 "$temporary" || die 'Schema verifier composition could not be protected'
    docker compose -f "$temporary" config --quiet || die 'Schema verifier composition is invalid'
    if ! docker compose -f "$temporary" run --no-deps --rm -T "$component" < /dev/null > "$directory/schema-preflight.$plan.$component.log" 2>&1; then
      die 'Pending or unverified product schema needs --allow-migrations; no schema migration was started'
    fi
  done < <(jq -r --slurpfile candidate "$candidate" '.components|to_entries[]|select(.value.initialization!=null and $candidate[0].services[.key]!=null)|.key' "$manifest")
}

# Environment files: compose and systemd semantics, the last assignment wins and one pair of
# quotes is removed (the same reader as memory-credential-host.sh).
hive_identity_env_get() {
  jq -Rrs --arg key "$2" --arg sq "'" 'split("\n")|map(select(startswith($key+"="))|.[($key|length)+1:]|
    if length>1 and ((startswith("\"") and endswith("\"")) or (startswith($sq) and endswith($sq))) then .[1:-1] else . end)|last // empty' "$1"
}
# Replaces one KEY='VALUE' line, keeping every other line, the owner and the mode, and the
# initializer's record of the file.
hive_identity_env_set() {
  local file=$1 key=$2 value=$3 temporary receipt="$directory/config/.initializer/receipt.json"
  [[ "$key" =~ ^[A-Z][A-Z0-9_]*$ && "$value" != *"'"* && "$value" != *$'\n'* && "$value" != *$'\r'* ]] || die 'A value cannot be represented in an environment file'
  temporary=$(mktemp "$directory/config/.memory-identity.XXXXXX") || die 'The environment file could not be staged'
  { grep -vE "^$key=" -- "$file" || true; printf "%s='%s'\n" "$key" "$value"; } > "$temporary"
  chown --reference="$file" -- "$temporary" && chmod 600 -- "$temporary" && sync -f "$temporary" && mv -T -- "$temporary" "$file" || die 'The environment file could not be replaced'
  hive_identity_inputs_changed=true
  if [[ -f "$receipt" && ! -L "$receipt" ]] && jq -e --arg path "$file" '.files[$path]!=null' "$receipt" >/dev/null; then
    jq --arg path "$file" --arg sha "$(sha256sum -- "$file" | cut -d ' ' -f1)" '.files[$path]=$sha' "$receipt" > "$receipt.new" && chmod 600 -- "$receipt.new" && mv -T -- "$receipt.new" "$receipt" || die 'The initializer receipt could not be updated'
  fi
}
hive_identity_jwt_claims() { jq -Rr 'split(".")[1] // ""|gsub("-";"+")|gsub("_";"/")|.+("="*((4-length%4)%4))|@base64d|fromjson?|objects' <<< "$1" 2>/dev/null || true; }

# HiveMem's signed initialization can rename an agent ID (release-contracts.mjs,
# MEMORY_IDENTITY_RENAME: Emberpath's former memory principal hive-router becomes emberpath).
# Once that rename is verified on the stopped live store, and before any service starts, the
# credentials on this host follow the data:
#   - config/.memory-identity-renames.json records it; memory-credential-host.sh maps a link
#     request for the old ID through it, also when Emberpath's record lives on another host
#   - every HIVEMEM_OATHWEAVE_SERVICES_JSON link to the old ID names the new one
#   - with Emberpath on this host: its credential record names the new ID, and its static
#     fallback HIVE_ROUTER_MEMORY_PROXY_TOKEN for the old ID is re-issued by HiveMem for the new
#     one with the same role, scope and remaining lifetime (an expired one is left as it is)
# Every step is idempotent. Old-ID tokens left anywhere are refused: the rename disables it.
# The environment files are deployment inputs pinned for this plan: they are checked unchanged
# first, and pinned again after this controller's own change, so activation still refuses any
# other edit.
hive_memory_identity_relink() {
  hive_identity_inputs_changed=false
  hive_memory_identity_relink_files "$@"
  if [[ "$hive_identity_inputs_changed" == true ]]; then
    local sha
    sha=$(deployment_inputs_digest "$1") || die 'Deployment input artifacts cannot be read safely'
    jq -n --arg sha "$sha" '{schema:1,sha256:$sha}' | atomic_json "$directory/deployment-inputs.$plan.json" || die 'The changed memory credential could not be pinned'
  fi
}
hive_memory_identity_relink_files() {
  local candidate=$1 manifest=$2 spec from to config="$directory/config" memory ember services renames record legacy claims remaining token issued
  jq -e '.placements.hivemem!=null' <<< "$input" >/dev/null || return 0
  spec=$(jq -c '.components.hivemem.initialization // empty' "$manifest") || die 'The HiveMem specification could not be read'
  [[ -n "$spec" ]] && jq -e '.command|length==5 and .[0]=="rename-agent" and .[1]=="--from" and .[3]=="--to"' <<< "$spec" >/dev/null || return 0
  from=$(jq -r '.command[2]' <<< "$spec"); to=$(jq -r '.command[4]' <<< "$spec")
  [[ "$from" =~ ^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$ && "$to" =~ ^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$ ]] || die 'Unsupported memory identity rename'
  jq -e --argjson spec "$spec" '.initializations.hivemem.phase=="verified" and .initializations.hivemem.specification==$spec' "$directory/schema-upgrade.$plan.json" >/dev/null 2>&1 ||
    die 'The HiveMem identity rename has no verified completion receipt; its credentials were not re-linked'
  [[ ! -L "$config" && ! -L "$config/.credentials" ]] || die 'Unsafe configuration path'
  assert_deployment_inputs "$candidate"
  renames="$config/.memory-identity-renames.json"
  [[ ! -L "$renames" ]] || die 'Unsafe memory identity record'
  if [[ ! -f "$renames" ]] || ! jq -e --arg from "$from" --arg to "$to" '.schema==1 and .renames[$from]==$to' "$renames" >/dev/null 2>&1; then
    { if [[ -f "$renames" ]]; then cat -- "$renames"; else printf '{"schema":1,"renames":{}}\n'; fi; } |
      jq --arg from "$from" --arg to "$to" '.schema=1|.renames[$from]=$to' | atomic_json "$renames" || die 'The memory identity record could not be saved'
  fi
  memory="$config/hivemem.env"
  if [[ -f "$memory" && ! -L "$memory" ]]; then
    services=$(hive_identity_env_get "$memory" HIVEMEM_OATHWEAVE_SERVICES_JSON)
    if [[ -n "$services" ]] && jq -e --arg from "$from" 'type=="array" and any(.[]; .localId==$from)' <<< "$services" >/dev/null 2>&1; then
      hive_identity_env_set "$memory" HIVEMEM_OATHWEAVE_SERVICES_JSON "$(jq -c --arg from "$from" --arg to "$to" 'map(if .localId==$from then .localId=$to else . end)' <<< "$services")"
      printf 'Memory identity: HiveMem service links now act as %s\n' "$to" >&2
    fi
  fi
  ember="$config/emberpath.env"
  if ! jq -e '.placements.emberpath!=null' <<< "$input" >/dev/null || [[ ! -f "$ember" || -L "$ember" ]]; then
    printf 'Memory identity: HiveMem data moved from %s to %s. Emberpath runs on another host: a HIVE_ROUTER_MEMORY_PROXY_TOKEN issued for %s is now refused; re-issue it with hivemem-server issue-token --subject %s --role admin\n' "$from" "$to" "$from" "$to" >&2
    return 0
  fi
  record="$config/.credentials/emberpath-hivemem.json"
  if [[ -f "$record" && ! -L "$record" ]] && jq -e --arg from "$from" '.localId==$from' "$record" >/dev/null 2>&1; then
    jq --arg to "$to" '.localId=$to' "$record" | atomic_json "$record" || die 'The memory credential record could not be saved'
  fi
  legacy=$(hive_identity_env_get "$ember" HIVE_ROUTER_MEMORY_PROXY_TOKEN)
  [[ -n "$legacy" ]] || return 0
  claims=$(hive_identity_jwt_claims "$legacy")
  jq -e --arg from "$from" '.sub==$from' <<< "${claims:-null}" >/dev/null 2>&1 || return 0
  remaining=$(jq -r '((.exp // 0)|floor) - now|floor' <<< "$claims")
  if (( remaining < 120 )); then
    printf 'Memory identity: the expired HIVE_ROUTER_MEMORY_PROXY_TOKEN for %s was left as it is; Emberpath uses its self-renewing credential\n' "$from" >&2
    return 0
  fi
  (( remaining <= 2592000 )) || remaining=2592000
  local -a arguments=(issue-token --subject "$to" --role "$(jq -r 'if .role=="admin" then "admin" else "agent" end' <<< "$claims")" --ttl "$remaining")
  if jq -e '.scope|type=="string" and length>0' <<< "$claims" >/dev/null; then arguments+=(--scope "$(jq -r .scope <<< "$claims")"); fi
  token=$(docker compose -f "$candidate" run --no-deps --rm -T hivemem "${arguments[@]}" < /dev/null 2>/dev/null) || die 'HiveMem could not re-issue the static memory token; the renamed data is complete, rerun the upgrade'
  [[ "$token" =~ ^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$ ]] || die 'HiveMem returned no token'
  issued=$(hive_identity_jwt_claims "$token")
  jq -e --arg to "$to" '.sub==$to' <<< "${issued:-null}" >/dev/null 2>&1 || die 'HiveMem re-issued the static memory token for another subject'
  hive_identity_env_set "$ember" HIVE_ROUTER_MEMORY_PROXY_TOKEN "$token"
  printf 'Memory identity: HIVE_ROUTER_MEMORY_PROXY_TOKEN re-issued for %s with its remaining lifetime\n' "$to" >&2
}
