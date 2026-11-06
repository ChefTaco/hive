#!/usr/bin/env bash
# Transported verbatim by the controller. Only JSON data crosses the SSH boundary.
set -Eeuo pipefail
umask 077
read -r input
directory=$(jq -er .directory <<< "$input")
installation=$(jq -er .installation <<< "$input")
host=$(jq -er .host <<< "$input")
action=$(jq -er .action <<< "$input")
plan=$(jq -er .plan <<< "$input")
version=$(jq -er .version <<< "$input")
archive=$(jq -r '.archive // empty' <<< "$input")
die() { printf 'Hive host: %s\n' "$*" >&2; exit 1; }
# As root on an installation an ordinary account owns, leave what this action wrote to it.
trap 'if declare -F restore_installation_owner >/dev/null; then restore_installation_owner; fi' EXIT
digest() { sha256sum -- "$1" | cut -d ' ' -f1; }
# Every file's SHA-256, as "HASH  ./PATH" records in sorted path order. Files are hashed in
# parallel, since a datastore's preallocated sparse files can reach many times its real size.
# Each parallel job writes its own file: concurrent writers to one pipe can interleave.
tree_lines() {
  local line path work status=0
  local -A sums=()
  work=$(mktemp -d)
  (cd "$1" && find . -type f -print0 | xargs -0 -r -P "$(nproc)" -n 64 sh -c 'sha256sum --zero -- "$@" > "$(mktemp "$0/sums.XXXXXX")"' "$work") || status=1
  if ((status == 0)); then
    while IFS= read -r -d '' line; do sums[${line:66}]=${line:0:64}; done < <(find "$work" -type f -name 'sums.*' -exec cat -- {} +)
  fi
  rm -rf -- "$work"
  ((status == 0)) || return 1
  while IFS= read -r -d '' path; do printf '%s  %s\0' "${sums[$path]:?}" "$path"; done < <(cd "$1" && find . -type f -print0 | sort -z)
}
tree_digest() { tree_lines "$1" | sha256sum | cut -d ' ' -f1; }
recovery_image='node:24.22.1-slim@sha256:55fb5f5a527ea2c5c4a95f963e48ef90aa38c7b346054fdc8ee9957a2b55d205'
atomic_json() { jq . > "$1.tmp"; chmod 600 "$1.tmp"; sync -f "$1.tmp"; mv -T -- "$1.tmp" "$1"; sync -f "$(dirname -- "$1")"; }
prepare_data_directories() {
  local candidate=$1 service uid gid path
    while read -r service uid gid; do
      path="$directory/data/$service"
      [[ ! -L "$path" ]] || die 'Data directory cannot be a symlink'
      if [[ -d "$path" ]]; then
        [[ $(stat -c %u "$path") == "$uid" && $(stat -c %g "$path") == "$gid" ]] || die 'Data ownership differs'
      else install -d -m 700 -o "$uid" -g "$gid" "$path"; fi
      # The approved host-key store. The gateway refuses every connection without this private directory.
      if [[ "$service" == magnus-gateway && ! -d "$path/known-hosts" ]]; then install -d -m 700 -o "$uid" -g "$gid" "$path/known-hosts"; fi
    done < <(jq -r '.services|to_entries[]|select(any(.value.volumes[]?; .target=="/data"))|[.key,(.value.user|split(":")[])]|@tsv' "$candidate")
}
save_release_artifacts() {
  local candidate=$1 file source
    install -d -m 700 "$directory/releases/$version"
    for file in manifest signature trust; do
      case "$file" in manifest) source="manifest.$plan.json";; signature) source="signature.$plan";; trust) source="trust.$plan.pub";; esac
      cp -- "$directory/$source" "$directory/releases/$version/$file"
    done
    cp -- "$candidate" "$directory/releases/$version/compose.json"
    cp -- "$directory/controller.$plan.tar.gz" "$directory/releases/$version/controller.tar.gz"
    cp -- "$directory/deployment-inputs.$plan.json" "$directory/releases/$version/configuration-inputs.json"
}
compose() { docker compose -f "$directory/compose.json" "$@"; }
# A release that adds the mandatory Hive Registry to an existing installation starts it
# empty. That is a new store, not a migration of existing data.
registry_is_new() { [[ "$1" == hive-registry && "$2" == unversioned ]]; }
[[ "$directory" =~ ^/[A-Za-z0-9_./-]+$ && "$directory" != *'/../'* && "$directory" != */.. && ${#directory} -gt 4 ]] || die 'Invalid installation path'
[[ "$installation" =~ ^[a-z][a-z0-9-]{0,47}$ && "$host" =~ ^[a-z][a-z0-9-]{0,47}$ && "$plan" =~ ^[a-f0-9]{64}$ ]] || die 'Invalid installation identity'
[[ ! -L "$directory" ]] || die 'Installation root cannot be a symlink'
# Legacy draft inference resources are never taken into lifecycle custody. This
# guard is read-only and runs before creating receipts, stopping or archiving.
if [[ -f "$directory/compose.json" ]] && jq -e '.services|to_entries|any(.[]; (.key+" "+(.value.image // ""))|test("(^inference-|(^|[/ :_-])(ollama|llama[.-]?cpp|vllm)([/ :@_-]|$))";"i"))' "$directory/compose.json" >/dev/null; then
  die 'Obsolete managed-inference Compose project: preserve all existing services, volumes and model files. Separate inference into operator-owned external services and review the suite resource inventory before retrying; no host changes were made.'
fi
if [[ -d "$directory/data" ]] && [[ -n $(find "$directory/data" -mindepth 1 -maxdepth 1 -name 'inference-*' -print -quit) ]]; then
  die 'Obsolete managed-inference data: keep existing model files in place. Review their external ownership and prepare a suite-only data directory before running lifecycle or rehearsal commands; no model files were changed.'
fi
if [[ -d "$directory/data" ]] && [[ -n $(find "$directory/data" -type f \( -iname '*.gguf' -o -iname '*.ggml' -o -iname '*.safetensors' -o -iname '*.pt' -o -iname '*.pth' \) -print -quit) ]]; then
  die 'Obsolete managed-inference model assets: preserve existing files in place and prepare a reviewed suite-only data inventory. Hive will not adopt or archive model weights; no host changes were made.'
fi
if [[ "$action" == prepare ]]; then
  install -d -m 700 "$directory" "$directory/releases" "$directory/data" "$directory/config" "$directory/backups" "$directory/rehearsals"
fi
[[ -d "$directory" && ! -L "$directory/controller.lock" ]] || die 'Installation is not initialized'
exec 9>"$directory/controller.lock"
flock -n 9 || die 'Another controller holds this host'
if [[ -e "$directory/installation.json" ]]; then
  jq -e --arg id "$installation" --arg host "$host" '.installation==$id and .host==$host' "$directory/installation.json" >/dev/null || die 'Installation or host ownership differs'
elif [[ "$action" == prepare ]]; then
  [[ ! -e "$directory/compose.json" || $(jq -r .operation <<< "$input") == adopt ]] || die 'Existing Compose requires explicit adoption'
  jq -n --arg id "$installation" --arg host "$host" --arg uuid "$(openssl rand -hex 24)" \
    '{schema:1,installation:$id,host:$host,uuid:$uuid}' | atomic_json "$directory/installation.json"
elif [[ "$action" != adopt-check ]]; then die 'Installation ownership record is missing'; fi
identity=$(jq -er .uuid "$directory/installation.json" 2>/dev/null || true)
transaction="$directory/transaction.json"
phase() { jq -r '.phase // "none"' "$transaction" 2>/dev/null || printf 'none\n'; }
# A complete transaction, or one aborted before it changed anything, lets the next plan start.
closed() { [[ $(phase) == complete || $(phase) == aborted ]]; }
record() {
  jq -n --arg plan "$plan" --arg phase "$1" --arg version "$version" --arg operation "$(jq -r '.operation' <<< "$input")" \
    '{schema:1,plan:$plan,phase:$phase,version:$version,operation:$operation}' | atomic_json "$transaction"
}
assert_transaction() {
  jq -e --arg plan "$plan" --arg operation "$(jq -r .operation <<< "$input")" '.plan==$plan and .operation==$operation' "$transaction" >/dev/null || die 'A different transaction requires recovery'
}
assert_stopped() {
  [[ -z $(compose ps --status running -q) ]] || die 'All installation containers must be stopped'
}
verify_archive() {
  [[ "$archive" =~ ^[a-zA-Z0-9][a-zA-Z0-9.-]{0,95}$ ]] || die 'Archive must be a backup ID from this installation'
  backup="$directory/backups/$archive"
  [[ -d "$backup" && ! -L "$backup" && ! -L "$backup/state.tar.gz" && ! -L "$backup/receipt.json" ]] || die 'Backup is missing'
  jq -e --arg uuid "$identity" --arg id "$installation" --arg host "$host" \
    '.uuid==$uuid and .installation==$id and .host==$host and .verified==true' "$backup/receipt.json" >/dev/null || die 'Backup belongs to another installation or is unverified'
  [[ $(digest "$backup/state.tar.gz") == "$(jq -er .sha256 "$backup/receipt.json")" ]] || die 'Backup checksum differs'
  tar -xOzf "$backup/state.tar.gz" compose.json | jq -e '.services|to_entries|all(.[]; ((.key+" "+(.value.image // ""))|test("(^inference-|(^|[/ :_-])(ollama|llama[.-]?cpp|vllm)([/ :@_-]|$))";"i")|not))' >/dev/null || die 'Obsolete managed-inference archive: retain the original archive and prepare a reviewed suite-only recovery export; external model resources must not be restored or launched by Hive'
  # Archives are produced without symlinks, hard links or special files. Reject any
  # such member before extraction, including an otherwise correctly checksummed upload.
  tar -tvzf "$backup/state.tar.gz" | awk 'substr($0,1,1)!="-" && substr($0,1,1)!="d" {bad=1} END {exit bad}' || die 'Unsafe archive member type'
  if tar -tzf "$backup/state.tar.gz" | awk 'tolower($0) ~ /\.(gguf|ggml|safetensors|pt|pth)$/ {found=1} END {exit !found}'; then
    die 'Obsolete managed-inference archive: preserve the original archive and prepare a reviewed suite-only recovery export without model assets; Hive will not extract or store model weights'
  fi
  while IFS= read -r member; do
    [[ "$member" =~ ^(data|config|releases|agents|agent-profiles)(/|$)|^(compose.json|receipt.json|installation.json|data-formats.json)$ ]] || die 'Unexpected archive member'
    [[ "$member" != /* && "$member" != *'..'* && "$member" != *\\* ]] || die 'Unsafe archive path'
  done < <(tar -tzf "$backup/state.tar.gz")
}
check_reconciliation() {
  jq -e --arg host "$host" --arg uuid "$identity" --arg sha "$(digest "$backup/state.tar.gz")" \
    '.hosts[$host] | .installationUUID==$uuid and .archiveSHA256==$sha and .subsequentWritesReconciled==true and (.currentDataSHA256|test("^[a-f0-9]{64}$"))' \
    "$directory/reconciliation.$plan.json" >/dev/null || die 'Restore requires installation-bound write reconciliation'
}
case "$action" in
  adapters-preflight) assert_transaction; adapter_preflight;;
  adapters-stage) assert_transaction; adapter_stage_agents;;
  adapters-accept) assert_transaction; adapter_inference_probe; adapter_register_inference; adapter_agents_service start; adapter_accept_agents;;
  agents-accept)
    [[ $(jq -er .digest "$directory/receipt.json") == "$(jq -er .digest <<< "$input")" ]] || die 'Native acceptance requires the active signed release manifest'
    adapter_accept_agents true;;
  prepare)
    if [[ -f "$transaction" ]] && ! closed; then
      if [[ $(jq -r .operation <<< "$input") == restore ]]; then
        verify_archive; check_reconciliation
        cp -- "$transaction" "$directory/recovery-transaction.$(date -u +%Y%m%d%H%M%S).json"
        record prepared
      else assert_transaction; fi
    fi
    if [[ -f "$directory/receipt.json" && $(jq -r .version "$directory/receipt.json") != "$version" ]]; then
      [[ $(jq -r .operation <<< "$input") =~ ^(upgrade|rollback|restore|rehearse)$ ]] || die 'Use upgrade or rollback for a different release'
    fi
    if [[ ! -f "$transaction" ]] || closed; then record prepared; fi
    ;;
  compatibility)
    assert_transaction
    [[ $(phase) != migration-started ]] || die 'A previous migration needs recovery'
    operation=$(jq -r .operation <<< "$input")
    if [[ -f "$directory/receipt.json" ]]; then
      previous=$(jq -r .version "$directory/receipt.json")
      if [[ "$previous" == "$version" ]]; then
        [[ $(jq -r .digest "$directory/receipt.json") == "$(jq -r .digest <<< "$input")" ]] || die 'Published release bytes changed'
      elif [[ "$operation" == upgrade ]]; then
        [[ $(printf '%s\n%s\n' "$previous" "$version" | sort -V | tail -1) == "$version" ]] || die 'Use rollback for an older version'
      fi
    fi
    while IFS= read -r component; do
      current=$(jq -r --arg name "$component" '.[$name] // "unversioned"' "$directory/data-formats.json" 2>/dev/null || printf 'unversioned\n')
      target=$(jq -r --arg name "$component" '.components[$name].storageFormat // "unversioned"' "$directory/manifest.$plan.json")
      if [[ "$operation" == install && ! -f "$directory/receipt.json" ]]; then continue; fi
      # Adoption verifies the exact running images, so their data is this release's format.
      if [[ "$operation" == adopt && ! -f "$directory/receipt.json" ]]; then continue; fi
      if registry_is_new "$component" "$current"; then continue; fi
      if [[ "$current" != "$target" ]]; then
        if [[ "$operation" == rollback ]]; then
          jq -e --arg name "$component" --arg current "$current" '.components[$name].readableFormats | index($current)!=null' "$directory/manifest.$plan.json" >/dev/null || die 'Binary rollback cannot read the current storage format; use rehearsed restore'
        else
          [[ $(jq -r .allowMigrations <<< "$input") == true ]] || die 'Storage transition needs --allow-migrations'
          jq -e --arg name "$component" --arg current "$current" '.components[$name].migration | .from==$current and (.command|type=="array" and length>0 and all(.[];type=="string"))' "$directory/manifest.$plan.json" >/dev/null || die 'No exact migration from the current storage format'
        fi
      fi
    done < <(jq -r '.services|keys[]' "$directory/candidate.$plan.json")
    ;;
  stage)
    assert_transaction
    candidate="$directory/candidate.$plan.json"
    [[ $(digest "$directory/manifest.$plan.json") == "$(jq -er .digest <<< "$input")" ]] || die 'Release digest differs'
    openssl pkeyutl -verify -pubin -inkey "$directory/trust.$plan.pub" -rawin -in "$directory/manifest.$plan.json" -sigfile "$directory/signature.$plan" >/dev/null 2>&1 || die 'Release signature differs'
    [[ $(digest "$directory/controller.$plan.tar.gz") == "$(jq -er .controllerArchiveSHA256 <<< "$input")" ]] || die 'Controller recovery artifact digest differs'
    docker compose -f "$candidate" config --quiet
    while IFS= read -r path; do
      [[ "$path" == "$directory/config/"* && -f "$path" && ! -L "$path" ]] || die 'Environment files must be regular files in the protected config directory'
      permissions=$(stat -c %a "$path")
      (( (8#$permissions & 077) == 0 )) || die 'Environment files must be owner-only'
    done < <(jq -r '.services[].env_file[]? | if type=="string" then . else .path end' "$candidate")
    while IFS= read -r path; do
      [[ "$path" == "$directory/config/"* && -d "$path" && ! -L "$path" ]] || die 'Configuration mounts must be owned config directories'
      [[ -z $(find "$path" -type l -print -quit) ]] || die 'Configuration cannot contain symlinks'
    done < <(jq -r '.services[].volumes[]? | select(.target=="/config") | .source' "$candidate")
    while IFS= read -r path; do
      [[ "$path" == "$directory/config/"* && -f "$path" && ! -L "$path" ]] || die 'Static runtime must be a regular public configuration file in the installation config tree'
      hive_check_public_runtime "$path" || die 'Public static runtime contains unsupported fields, credentials or incomplete product identity configuration'
    done < <(jq -r '.services[].volumes[]? | select(.target=="/usr/share/nginx/html/runtime.json") | .source' "$candidate")
    pin_deployment_inputs "$candidate"
    docker compose -f "$candidate" pull --quiet
    if [[ $(jq -r .operation <<< "$input") == install && $(jq -r '.bootstrap!=null' <<< "$input") == true ]]; then
      while IFS= read -r image; do docker pull --quiet "$image" >/dev/null; done < <(jq -r --slurpfile candidate "$candidate" '.components|to_entries[]|select(.value.initialization!=null and $candidate[0].services[.key]!=null)|.value.initialization.image' "$directory/manifest.$plan.json")
    fi
    docker pull --quiet "$recovery_image" >/dev/null
    ;;
  quiesce)
    assert_transaction
    [[ $(phase) != migration-started ]] || die 'An uncertain migration requires recovery'
    adapter_agents_service stop
    if [[ -f "$directory/compose.json" ]]; then compose stop --timeout 45; assert_stopped; fi
    record quiesced
    ;;
  backup)
    assert_transaction
    assert_stopped
    [[ "$archive" =~ ^[a-zA-Z0-9][a-zA-Z0-9.-]{0,95}$ ]] || die 'A backup ID is required'
    backup="$directory/backups/$archive"
    if [[ -e "$backup" ]]; then verify_archive; exit 0; fi
    adapter_snapshot_profiles
    [[ -z $(find "$directory/data" "$directory/config" "$directory/releases" ! -type f ! -type d -print -quit) ]] || die 'Backup tree contains unsupported links or special files'
    install -d -m 700 "$backup"
    members=(data config releases compose.json receipt.json installation.json)
    [[ ! -d "$directory/agents" ]] || members+=(agents)
    [[ ! -d "$directory/agent-profiles" ]] || members+=(agent-profiles)
    [[ ! -f "$directory/data-formats.json" ]] || members+=(data-formats.json)
    # Preserve sparse datastore/WAL extents; expanding them during recovery can
    # consume far more disk than the live store or its compressed archive.
    tar --sparse --hard-dereference -czf "$backup/state.tar.gz.partial" -C "$directory" -- "${members[@]}"
    gzip -t "$backup/state.tar.gz.partial"
    mv "$backup/state.tar.gz.partial" "$backup/state.tar.gz"
    jq -n --arg uuid "$identity" --arg id "$installation" --arg host "$host" --arg sha "$(digest "$backup/state.tar.gz")" \
      --arg dataSHA "$(tree_digest "$directory/data")" --arg configSHA "$(tree_digest "$directory/config")" \
      --slurpfile release "$directory/receipt.json" '{schema:1,uuid:$uuid,installation:$id,host:$host,sha256:$sha,dataSHA256:$dataSHA,configSHA256:$configSHA,verified:true,release:$release[0]}' | atomic_json "$backup/receipt.json"
    verify_archive
    record backed-up
    ;;
  # The default backup: every store is captured while the suite serves (snapshot-host.sh).
  snapshot) snapshot_online;;
  migrate)
    assert_transaction
    assert_deployment_inputs "$directory/candidate.$plan.json"
    [[ $(phase) != migration-started ]] || die 'Migration outcome is unknown; never replay it'
    manifest="$directory/manifest.$plan.json"
    # Each migration is claimed durably before execution. A failure holds the suite
    # stopped; the controller cannot infer whether a partially executed step committed.
    while IFS= read -r component; do
      format=$(jq -r --arg component "$component" '.components[$component].storageFormat // "unversioned"' "$manifest")
      current=$(jq -r --arg component "$component" '.[$component] // "unversioned"' "$directory/data-formats.json" 2>/dev/null || printf 'unversioned\n')
      if [[ "$current" != "$format" ]] && ! registry_is_new "$component" "$current"; then
        jq -e --arg name "$component" --arg from "$current" '.components[$name].migration | .from==$from and (.command|type=="array" and length>0 and all(.[];type=="string"))' "$manifest" >/dev/null || die 'An explicit migration is required'
        [[ $(jq -r .allowMigrations <<< "$input") == true ]] || die 'Migration execution requires --allow-migrations'
        record migration-started
        mapfile -t arguments < <(jq -r --arg name "$component" '.components[$name].migration.command[]' "$manifest")
        docker compose -f "$directory/candidate.$plan.json" run --no-deps --rm -T "$component" "${arguments[@]}"
        jq -n --arg name "$component" --arg format "$format" --slurpfile previous "$directory/data-formats.json" '$previous[0]+{($name):$format}' | atomic_json "$directory/data-formats.json"
        record migrated
      fi
    done < <(jq -r '.services|keys[]' "$directory/candidate.$plan.json")
    ;;
  initialize-data)
    assert_transaction
    assert_deployment_inputs "$directory/candidate.$plan.json"
    [[ $(jq -r .operation <<< "$input") == install && $(jq -r '.bootstrap!=null' <<< "$input") == true ]] || die 'Data initialization is restricted to explicit fresh installs'
    # A repeat install already has product-owned initialized data. Never reseed it.
    if [[ -f "$directory/receipt.json" ]]; then exit 0; fi
    candidate="$directory/candidate.$plan.json"
    initial_receipt="$directory/bootstrap.$plan.json"
    if [[ -f "$initial_receipt" ]]; then
      jq -e --arg plan "$plan" --arg digest "$(jq -er .digest <<< "$input")" '.schema==1 and .plan==$plan and .manifestDigest==$digest' "$initial_receipt" >/dev/null || die 'Fresh initialization receipt differs from the exact candidate'
      if [[ $(jq -r .phase "$initial_receipt") == ready ]]; then exit 0; fi
    else
      [[ -z $(find "$directory/data" -type f -print -quit) && -z $(docker compose -f "$candidate" ps -aq) ]] || die 'Fresh initialization cannot take custody of existing data or containers'
      jq -n --arg plan "$plan" --arg digest "$(jq -er .digest <<< "$input")" '{schema:1,plan:$plan,manifestDigest:$digest,phase:"started"}' | atomic_json "$initial_receipt"
    fi
    prepare_data_directories "$candidate"
    bootstrap_compose="$directory/bootstrap.$plan.compose.json"
    jq --slurpfile release "$directory/manifest.$plan.json" '
      .services |= with_entries(select(.key as $name|($release[0].components[$name].kind // "application")|IN("application","datastore")) |
        .value |= (del(.ports,.restart) | .environment=((.environment // {}) + {
          HIVE_AUTO_MIGRATE:"true",HIVE_AUTO_UPGRADE:"false",HIVE_UPDATE_CHECK:"false",
          HIVEMEM_WORKER_ENABLED:"false",HIVE_SKILLS_DEPLOYMENT_WORKER_ENABLED:"false",
          SECURITY_FUSION_DISPATCH_ENABLED:"false",SECURITY_FUSION_COLLECTOR_ENABLED:"false"
          ,SECURITY_DISPATCH_ENABLED:"false",SECURITY_INGEST_ENABLED:"false",SECURITY_RETENTION_ENABLED:"false",SECURITY_NOTIFICATIONS_ENABLED:"false"
        })))
    ' "$candidate" > "$bootstrap_compose"
    if jq -e '.services|length==0' "$bootstrap_compose" >/dev/null; then
      # An ingress/static-only host has no product data to seed. Retain its
      # explicit initialization receipt without launching a frontend early.
      jq '.phase="ready"' "$initial_receipt" | atomic_json "$initial_receipt"
      exit 0
    fi
    docker compose -f "$bootstrap_compose" config --quiet
    mapfile -t datastores < <(jq -r --slurpfile release "$directory/manifest.$plan.json" '.services|keys[]|. as $name|select($release[0].components[$name].kind=="datastore")' "$bootstrap_compose")
    if ((${#datastores[@]})); then docker compose -f "$bootstrap_compose" up -d --wait --wait-timeout 180 "${datastores[@]}"; fi
    hive_initialization_migrations "$candidate" "$bootstrap_compose" "$initial_receipt"
    # Only private backends/datastores start. Ingress, UI and native agents wait
    # until initialized data is ready with automatic migrations disabled again.
    docker compose -f "$bootstrap_compose" up -d --wait --wait-timeout 180
    docker compose -f "$bootstrap_compose" stop --timeout 45
    jq '.phase="ready"' "$initial_receipt" | atomic_json "$initial_receipt"
    ;;
  activate)
    assert_transaction
    assert_deployment_inputs "$directory/candidate.$plan.json"
    [[ $(phase) != migration-started ]] || die 'Migration outcome is unknown'
    candidate="$directory/candidate.$plan.json"
    if [[ ! -f "$directory/data-formats.json" ]]; then
      jq '.components|map_values(.storageFormat // "unversioned")' "$directory/manifest.$plan.json" | atomic_json "$directory/data-formats.json"
    fi
    if jq -e --slurpfile formats "$directory/data-formats.json" '.services["hive-registry"]!=null and $formats[0]["hive-registry"]==null' "$candidate" >/dev/null; then
      jq --slurpfile release "$directory/manifest.$plan.json" '.+{"hive-registry":$release[0].components["hive-registry"].storageFormat}' "$directory/data-formats.json" | atomic_json "$directory/data-formats.json"
    fi
    prepare_data_directories "$candidate"
    record activating
    docker compose -f "$candidate" up -d --wait --wait-timeout 180
    save_release_artifacts "$candidate"
    mv -T -- "$candidate" "$directory/compose.json"
    jq --slurpfile inputs "$directory/deployment-inputs.$plan.json" '{schema:1,installation,host,version,digest,plan,controllerSourceSHA256,controllerArchiveSHA256,deploymentInputSHA256:$inputs[0].sha256}' <<< "$input" | atomic_json "$directory/receipt.json"
    record ready
    ;;
  complete) assert_transaction; record complete;;
  abort)
    # Only a transaction that failed in its read-only checks (stage, compatibility, preflight)
    # closes as aborted. Those steps verify, pull images and pin this plan's inputs; nothing has
    # quiesced, stopped, paused, initialized, staged or activated, and this proves it. Anything
    # further keeps the transaction open for recovery.
    assert_transaction
    step=$(jq -r '.abortStep // ""' <<< "$input")
    [[ "$step" =~ ^(stage|compatibility|adapters-preflight)$ ]] || die 'Only a failed stage, compatibility check or preflight can abort a transaction'
    [[ $(phase) == prepared ]] || die "The transaction is in phase $(phase), past its read-only checks; it needs recovery: repeat the same command"
    [[ ! -e "$directory/bootstrap.$plan.json" ]] || die 'This plan initialized data; it needs recovery: repeat the same command'
    [[ -z $(find "$directory/agents" -mindepth 2 -maxdepth 2 \( -name "candidate.$plan.json" -o -name "run.$plan*" -o -name "preflight.$plan.log" \) -print -quit 2>/dev/null) ]] || die 'This plan staged native agents; it needs recovery: repeat the same command'
    [[ ! -f "$directory/receipt.json" || $(jq -r .plan "$directory/receipt.json") != "$plan" ]] || die 'This plan is already active; it needs recovery: repeat the same command'
    jq --arg step "$step" --arg at "$(date -u +%Y-%m-%dT%H:%M:%SZ)" '.phase="aborted" | .abortedStep=$step | .abortedAt=$at' "$transaction" | atomic_json "$transaction"
    cp -p -- "$transaction" "$directory/aborted-transaction.$plan.json"
    ;;
  hold)
    assert_transaction
    # Readiness failure on a later host must not leave earlier suite writers active.
    adapter_agents_service stop
    [[ ! -f "$directory/compose.json" ]] || compose stop --timeout 45
    [[ ! -f "$directory/candidate.$plan.json" ]] || docker compose -f "$directory/candidate.$plan.json" stop --timeout 45
    [[ $(phase) == migration-started ]] || record recovery-required
    ;;
  resume-current)
    assert_transaction
    compose up -d --wait --wait-timeout 180
    adapter_agents_service start
    record complete
    ;;
  rehearse)
    verify_archive
    rehearsal="$directory/rehearsals/$archive"
    [[ ! -e "$rehearsal" ]] || die 'A rehearsal with this ID already exists; retain it as evidence'
    install -d -m 700 "$rehearsal"
    tar --extract --gzip --file "$backup/state.tar.gz" --directory "$rehearsal" --same-owner --same-permissions
    candidate="$directory/candidate.$plan.json"
    [[ -f "$candidate" ]] || candidate="$rehearsal/compose.json"
    # An archive from before the mandatory Hive Registry has nothing of it to restore.
    registry_restored=false
    [[ ! -f "$rehearsal/config/hive-registry.env" || ! -d "$rehearsal/data/hive-registry" ]] || registry_restored=true
    # No production env, network, port, external volume, dispatcher or collector is
    # reachable. The original protected files stay byte-exact in the restored tree.
    jq --arg base "$directory" --arg restored "$rehearsal" --arg name "rehearsal-$installation-$host-$archive" --argjson registryRestored "$registry_restored" '
      (if $registryRestored then . else del(.services["hive-registry"]) end) |
      (.services|keys|map(select(test("collector|dispatcher|agent")|not))) as $selected |
      .name=$name | .services |= with_entries(
        select((.key|test("collector|dispatcher|agent"))|not) |
        .value |= (del(.ports,.network_mode,.external_links,.links,.restart) |
          (if has("depends_on") then .depends_on |= (if type=="array" then map(select(. as $name|$selected|index($name)!=null)) else with_entries(select(.key as $name|$selected|index($name)!=null)) end) else . end) |
          .environment=((.environment // {}) + {HIVE_REHEARSAL:"true",SECURITY_FUSION_DISPATCH_ENABLED:"false",SECURITY_FUSION_COLLECTOR_ENABLED:"false",SECURITY_DISPATCH_ENABLED:"false",SECURITY_INGEST_ENABLED:"false",SECURITY_RETENTION_ENABLED:"false",SECURITY_NOTIFICATIONS_ENABLED:"false",SECURITY_WRITES_ENABLED:"false",MAGNUS_AUTO_MIGRATE:"false"}) |
          .volumes |= map(if .source|startswith($base+"/") then .source=($restored+.source[($base|length):]) else error("Unowned restore mount") end) |
          if has("env_file") then .env_file |= map(if type=="string" and startswith($base+"/") then $restored+.[($base|length):] else error("Unowned restore environment") end) else . end)) |
      # Read-only in rehearsals, at the mount as well as in the service.
      (if .services["hive-registry"] then .services["hive-registry"].volumes |= map(if .target=="/data" then .read_only=true else . end) else . end) |
      .networks=((.networks // {default:{}})|map_values({internal:true,driver:"bridge"}))' "$candidate" > "$rehearsal/isolated.json"
    docker compose -f "$rehearsal/isolated.json" config --quiet
    [[ $(tree_digest "$rehearsal/data") == "$(jq -er .dataSHA256 "$backup/receipt.json")" ]] || die 'Restored data differs from the backup receipt'
    # Restore ownership only inside this disposable tree, before the non-root services run.
    while read -r service uid gid; do chown -R -- "$uid:$gid" "$rehearsal/data/$service"; done < <(jq -r '.services|to_entries[]|select(any(.value.volumes[]?; .target=="/data"))|[.key,(.value.user|split(":")[])]|@tsv' "$rehearsal/isolated.json")
    result=passed
    if ! check_data "$rehearsal" "$rehearsal/isolated.json"; then result=failed; fi
    if [[ "$result" == passed && -f "$directory/manifest.$plan.json" ]]; then
      while IFS= read -r component; do
        from=$(jq -r --arg name "$component" '.[$name] // "unversioned"' "$rehearsal/data-formats.json" 2>/dev/null || printf 'unversioned\n')
        target=$(jq -r --arg name "$component" '.components[$name].storageFormat // "unversioned"' "$directory/manifest.$plan.json")
        if registry_is_new "$component" "$from"; then continue; fi
        if [[ "$from" != "$target" && $(jq -r .operation <<< "$input") != rollback ]]; then
          mapfile -t arguments < <(jq -r --arg name "$component" '.components[$name].migration.command[]' "$directory/manifest.$plan.json")
          if ((${#arguments[@]}==0)) || ! docker compose -f "$rehearsal/isolated.json" run --no-deps --rm -T "$component" "${arguments[@]}"; then result=failed; break; fi
        fi
      done < <(jq -r '.services|keys[]' "$rehearsal/isolated.json")
    fi
    if [[ "$result" == passed ]] && ! docker compose -f "$rehearsal/isolated.json" up -d --wait --wait-timeout 180; then result=failed; fi
    docker compose -f "$rehearsal/isolated.json" stop --timeout 45
    if ! check_data "$rehearsal" "$rehearsal/isolated.json"; then result=failed; fi
    jq -n --arg result "$result" --arg sha "$(digest "$backup/state.tar.gz")" --arg uuid "$identity" --arg plan "$plan" '{schema:1,result:$result,archiveSHA256:$sha,installationUUID:$uuid,candidatePlan:$plan,isolated:true,portsPublished:false}' | atomic_json "$rehearsal/result.json"
    [[ "$result" == passed ]] || die 'Rehearsal readiness failed; isolated state and evidence retained'
    ;;
  restore-check)
    verify_archive
    check_reconciliation
    jq -e --arg sha "$(digest "$backup/state.tar.gz")" '.result=="passed" and .isolated==true and .archiveSHA256==$sha' "$directory/rehearsals/$archive/result.json" >/dev/null || die 'Restore needs a successful rehearsal of these exact archive bytes'
    ;;
  restore)
    assert_transaction
    assert_stopped
    verify_archive
    check_reconciliation
    [[ $(tree_digest "$directory/data") == "$(jq -er --arg host "$host" '.hosts[$host].currentDataSHA256' "$directory/reconciliation.$plan.json")" ]] || die 'Data changed after write reconciliation'
    [[ $(tree_digest "$directory/config") == "$(jq -er .configSHA256 "$backup/receipt.json")" ]] || die 'Secrets/configuration changed since backup; reconcile them before restoring'
    restored="$directory/restore.$plan"
    [[ ! -e "$restored" ]] || die 'An interrupted restore needs manual reconciliation'
    install -d -m 700 "$restored"
    tar -xzf "$backup/state.tar.gz" -C "$restored" --same-owner --same-permissions
    [[ $(tree_digest "$restored/data") == "$(jq -er .dataSHA256 "$backup/receipt.json")" ]] || die 'Restored data verification failed'
    record restoring
    adapter_restore_profiles "$restored"
    # Each original is retained. A crash after the first rename is a held restore,
    # never a reason to start a partly replaced installation automatically.
    mv -T "$directory/data" "$directory/pre-restore-data.$plan"
    mv -T "$restored/data" "$directory/data"
    if [[ -d "$restored/agents" ]]; then
      [[ ! -d "$directory/agents" ]] || mv -T "$directory/agents" "$directory/pre-restore-agents.$plan"
      mv -T "$restored/agents" "$directory/agents"
    fi
    for file in compose.json receipt.json data-formats.json; do
      [[ ! -f "$directory/$file" ]] || cp -- "$directory/$file" "$directory/pre-restore-$plan.$file"
      [[ ! -f "$restored/$file" ]] || mv -T -- "$restored/$file" "$directory/$file"
    done
    record restored
    ;;
  adopt-check)
    [[ -f "$directory/compose.json" && -f "$directory/adoption.$plan.json" ]] || die 'Explicit existing and expected Compose definitions are required'
    # The mandatory Hive Registry joins an adopted project, so it and its start ordering
    # are the only difference allowed from the reviewed existing definition.
    without_registry='del(.services["hive-registry"]) | .services |= map_values(if .depends_on then (.depends_on |= del(.["hive-registry"])) | (if .depends_on=={} then del(.depends_on) else . end) else . end)'
    [[ $(jq -Sc "$without_registry" "$directory/compose.json") == "$(jq -Sc "$without_registry" "$directory/adoption.$plan.json")" ]] || die 'Existing Compose differs from the reviewed deployment plan'
    expected=$(jq -r '.services|keys[]' "$directory/compose.json" | sort)
    [[ $(compose ps --status running --services | sort) == "$expected" ]] || die 'Every adopted service must already be running'
    while IFS= read -r component; do
      image=$(jq -r --arg name "$component" '.services[$name].image' "$directory/compose.json")
      container=$(compose ps -q "$component")
      [[ $(docker inspect -f '{{.Image}}' "$container") == "$(docker image inspect -f '{{.Id}}' "$image")" ]] || die 'Actual adopted image differs'
      [[ $(docker inspect -f '{{.HostConfig.ReadonlyRootfs}} {{.HostConfig.Privileged}}' "$container") == 'true false' ]] || die 'Adopted container hardening differs'
    done <<< "$expected"
    ;;
  adopt)
    assert_transaction
    save_release_artifacts "$directory/candidate.$plan.json"
    cp -- "$directory/candidate.$plan.json" "$directory/compose.json"
    jq --slurpfile inputs "$directory/deployment-inputs.$plan.json" '{schema:1,installation,host,version,digest,plan,controllerSourceSHA256,controllerArchiveSHA256,deploymentInputSHA256:$inputs[0].sha256}' <<< "$input" | atomic_json "$directory/receipt.json"
    jq '.components|map_values(.storageFormat // "unversioned")' "$directory/manifest.$plan.json" | atomic_json "$directory/data-formats.json"
    record ready
    ;;
  *) die 'Unknown host action';;
esac
