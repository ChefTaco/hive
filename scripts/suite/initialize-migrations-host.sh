#!/usr/bin/env bash
# Functions are transported before host-runtime.sh; all values remain JSON data.
hive_initialization_migrations() {
  local candidate=$1 bootstrap=$2 receipt=$3 component state specification temporary
  local manifest="$directory/manifest.$plan.json"
  local -a arguments
  while IFS= read -r component; do
    specification=$(jq -c --arg name "$component" '.components[$name].initialization' "$manifest")
    state=$(jq -r --arg name "$component" '.initializations[$name].phase // "new"' "$receipt")
    temporary="$directory/bootstrap.$plan.$component.compose.json"
    jq --arg name "$component" --argjson specification "$specification" '
      .services[$name].image=$specification.image |
      .services[$name] |= (del(.ports,.restart,.depends_on) |
        if $specification.entrypoint then .entrypoint=$specification.entrypoint else . end) |
      (if $specification.workingDirectory then .services[$name].working_dir=$specification.workingDirectory else . end) |
      .services[$name].command=$specification.verificationCommand
    ' "$bootstrap" > "$temporary"
    chmod 600 "$temporary"
    docker compose -f "$temporary" config --quiet
    if [[ "$state" != new ]]; then
      jq -e --arg name "$component" --argjson specification "$specification" '.initializations[$name] | (.phase|IN("claimed","verified")) and .specification==$specification' "$receipt" >/dev/null || die 'Initial migration journal differs from the exact signed product specification'
      # A claimed migration has an uncertain outcome. Only its owning product's
      # exact completion verifier can reconcile it; never execute it again here.
      if ! docker compose -f "$temporary" run --no-deps --rm -T "$component" < /dev/null > "$directory/bootstrap.$plan.$component.verify.log" 2>&1; then
        die 'Initial migration outcome needs product-owned recovery; the exact completion verifier did not pass and no migration was replayed'
      fi
    else
      jq --arg name "$component" --argjson specification "$specification" '.initializations[$name]={phase:"claimed",specification:$specification}' "$receipt" | atomic_json "$receipt"
      mapfile -t arguments < <(jq -r '.command[]' <<< "$specification")
      if ! docker compose -f "$temporary" run --no-deps --rm -T "$component" "${arguments[@]}" < /dev/null > "$directory/bootstrap.$plan.$component.apply.log" 2>&1; then
        die 'Initial product migration failed or has an unknown outcome; preserve its protected journal and use the owning product recovery procedure'
      fi
      if ! docker compose -f "$temporary" run --no-deps --rm -T "$component" < /dev/null > "$directory/bootstrap.$plan.$component.verify.log" 2>&1; then
        die 'Initial product migration did not pass its exact completion verifier; application activation remains held'
      fi
    fi
    jq --arg name "$component" '.initializations[$name].phase="verified"' "$receipt" | atomic_json "$receipt"
  done < <(jq -r --slurpfile candidate "$candidate" '.components|to_entries[]|select(.value.initialization!=null and $candidate[0].services[.key]!=null)|.key' "$manifest")
  jq -e --slurpfile manifest "$manifest" --slurpfile candidate "$candidate" '
    . as $receipt | all($manifest[0].components|to_entries[]|select(.value.initialization!=null and $candidate[0].services[.key]!=null); .key as $name | $receipt.initializations[$name].phase=="verified")
  ' "$receipt" >/dev/null || die 'Not every selected product migration has an exact verified completion receipt; activation remains held'
}
