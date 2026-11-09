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
