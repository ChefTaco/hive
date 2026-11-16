#!/usr/bin/env bash

hive_action() {
  local host=$1 file script=''
  local HIVE_HOST_LOCAL_SUDO=${HIVE_HOST_LOCAL_SUDO:-false}
  # Native discovery and recovery read root-private product state. Use the same
  # interactive sudo transport as host-agent installation, only for these known
  # lifecycle actions on the host that actually places Magnus. Remote privilege
  # remains an explicit property of its reviewed SSH transport.
  case "${HIVE_OPERATION:-}" in
    backup|upgrade|rollback|restore|rehearse)
      case "$2" in
        snapshot|native-backup-begin|backup|rehearse|restore-check|restore-preview-check|restore-preview|restore|resume-current|complete|abort|native-backup-recover|restore-recovery-check|restore-recovery-apply|restore-recovery-resume)
          if [[ $(id -u) != 0 ]] && jq -e --arg host "$host" '.hosts[$host].target=="local" and .components.magnus.host==$host' "$HIVE_CONFIG" >/dev/null; then
            HIVE_HOST_LOCAL_SUDO=true
          fi
          ;;
      esac
      ;;
  esac
  local -a files=(ownership-host.sh public-runtime.sh integrity-host.sh input-artifacts-host.sh native-initialization-host.sh adapters-host.sh native-backup-host.sh restore-recovery-host.sh inference-registration.sh initialize-migrations-host.sh rehearsal-copy-host.sh host-runtime.sh)
  [[ "$2" != snapshot ]] || files=(ownership-host.sh integrity-host.sh adapters-host.sh native-backup-host.sh snapshot-host.sh host-runtime.sh)
  for file in "${files[@]}"; do script+=$(cat "$HIVE_ROOT/scripts/suite/$file")$'\n'; done
  # The host script travels as one command-line argument, which the kernel bounds at 128 KiB.
  # The online backup ships only the definitions it runs, compressed; it is the same code.
  if [[ "$2" == snapshot || ${#script} -gt 100000 ]]; then script="eval \"\$(printf '%s' '$(printf '%s' "$script" | gzip -9n | base64 -w0)' | base64 -d | gunzip)\""; fi
  HIVE_HOST_ACTION=$2 hive_host "$host" "$script"
}

hive_all() {
  local host
  HIVE_FAILED_HOST=''
  while IFS= read -r host; do
    hive_action "$host" "$1" || { HIVE_FAILED_HOST=$host; return 1; }
  done < <(jq -r '.hosts|keys[]' "$HIVE_CONFIG")
}

hive_hold() {
  local host
  while IFS= read -r host; do
    hive_action "$host" hold || true
  done < <(jq -r '.hosts|keys[]' "$HIVE_CONFIG")
  hive_die 'Suite held for recovery; preserved receipts identify the last known step'
}

hive_stage() {
  local host temporary
  HIVE_PREPARED_HOSTS=()
  temporary=$(mktemp -d)
  hive_need tar
  hive_runtime_files > "$temporary/controller-files"
  tar --sort=name --mtime=@0 --owner=0 --group=0 --numeric-owner -czf "$temporary/controller.tar.gz" -C "$HIVE_ROOT" -T "$temporary/controller-files"
  HIVE_CONTROLLER_ARCHIVE_DIGEST=$(sha256sum "$temporary/controller.tar.gz" | cut -d ' ' -f1)
  # The directory contains Compose and public manifests only. Configuration values
  # and secrets stay on their owning hosts.
  while IFS= read -r host; do
    hive_render "$host" > "$temporary/$host.json"
    jq '(.services[]|select(has("env_file"))) |= del(.env_file)' "$temporary/$host.json" > "$temporary/$host.syntax.json"
    docker compose -f "$temporary/$host.syntax.json" config --quiet || { rm -rf -- "$temporary"; hive_die 'Compose validation failed'; }
  done < <(jq -r '.hosts|keys[]' "$HIVE_CONFIG")
  while IFS= read -r host; do
    hive_action "$host" prepare || { rm -rf -- "$temporary"; hive_die 'Host preparation failed'; }
    HIVE_PREPARED_HOSTS+=("$host")
    hive_transfer "$host" "$temporary/$host.json" "candidate.$HIVE_PLAN_DIGEST.json"
    hive_transfer "$host" "$HIVE_MANIFEST" "manifest.$HIVE_PLAN_DIGEST.json"
    hive_transfer "$host" "$HIVE_SIGNATURE" "signature.$HIVE_PLAN_DIGEST"
    hive_transfer "$host" "$HIVE_TRUST_KEY" "trust.$HIVE_PLAN_DIGEST.pub"
    hive_transfer "$host" "$temporary/controller.tar.gz" "controller.$HIVE_PLAN_DIGEST.tar.gz"
    hive_action "$host" stage || { rm -rf -- "$temporary"; hive_abort stage 'Host staging failed before quiescence'; }
    hive_action "$host" compatibility || { rm -rf -- "$temporary"; hive_abort compatibility 'Storage compatibility check failed before quiescence'; }
    hive_action "$host" adapters-preflight || { rm -rf -- "$temporary"; hive_abort adapters-preflight 'Native agent or external endpoint reference preflight failed'; }
  done < <(jq -r '.hosts|keys[]' "$HIVE_CONFIG")
  rm -rf -- "$temporary"
}

# A failure in the read-only checks before quiescence changed nothing, so the open transaction
# closes as aborted on every host it reached, and the next plan can start. A host that refuses
# keeps its transaction for recovery.
hive_abort() {
  local step=$1 message=$2 host aborted=true
  # migrate-native keeps its own staging and recovery unchanged.
  ! jq -e '.nativeMigration!=null' "$HIVE_CONFIG" >/dev/null 2>&1 || hive_die "$message"
  for host in "${HIVE_PREPARED_HOSTS[@]}"; do
    if ! HIVE_ABORT_STEP=$step hive_action "$host" abort >/dev/null 2>&1; then
      aborted=false
      printf 'Hive: the transaction on %s stays open; repeat the same command to recover\n' "$host" >&2
    fi
  done
  [[ "$aborted" == true ]] || hive_die "$message"
  hive_die "$message. Nothing was changed, so the transaction is closed as aborted; fix the cause, then run this or any other command"
}

# Native preparation stops native writers before the backup. A host that fails it before writing
# its session record has reserved and stopped nothing, so when it is the first host the whole
# transaction closes as aborted, like a failed stage, and the suite keeps serving. A failure after
# that, or on a later host (an earlier one has reserved), holds the suite for recovery.
hive_native_begin_all() {
  local host other aborted
  hive_all native-backup-begin && return 0
  host=${HIVE_FAILED_HOST:-}
  if [[ -n "$host" && "$host" == "$(jq -r '.hosts|keys[0]' "$HIVE_CONFIG")" ]] && ! jq -e '.nativeMigration!=null' "$HIVE_CONFIG" >/dev/null 2>&1 &&
     HIVE_ABORT_STEP=native-backup-begin hive_action "$host" abort >/dev/null 2>&1; then
    aborted=true
    # Every other host was prepared and has run nothing since.
    while IFS= read -r other; do
      [[ "$other" != "$host" ]] || continue
      if ! HIVE_ABORT_STEP=native-backup-begin hive_action "$other" abort >/dev/null 2>&1; then
        aborted=false
        printf 'Hive: the transaction on %s stays open; repeat the same command to recover\n' "$other" >&2
      fi
    done < <(jq -r '.hosts|keys[]' "$HIVE_CONFIG")
    [[ "$aborted" == true ]] || hive_die "Native profile preparation failed on $host"
    hive_die "Native profile preparation failed on $host before it reserved or stopped anything; see above. Nothing was changed, so the transaction is closed as aborted and the suite keeps serving; fix the cause, then run this or any other command"
  fi
  hive_hold
}

# Recovery is a separately reviewed operation, never an implicit retry of work.
# It can reconcile an old controller's pre-capture pause, without adopting its plan
# for a new backup or changing any archived/data bytes.
hive_native_recovery() {
  local file=$HIVE_NATIVE_RECOVERY_FILE permissions host
  [[ -n "$HIVE_ARCHIVE" ]] || hive_die 'Native recovery requires the original --archive ID'
  [[ -f "$file" && ! -L "$file" && $(stat -c %u "$file") == "$(id -u)" ]] || hive_die 'Native recovery approval must be an operator-owned regular file'
  permissions=$(stat -c %a "$file")
  (( (8#$permissions & 077)==0 && $(stat -c %s "$file") <= 65536 )) || hive_die 'Native recovery approval must be private and bounded'
  jq -e --slurpfile config "$HIVE_CONFIG" '
    type=="object" and keys==["hosts"] and (.hosts|type=="object" and length>0) and
    (((.hosts|keys)-($config[0].hosts|keys))|length==0)
  ' "$file" >/dev/null || hive_die 'Native recovery approval names an unknown host or has an invalid shape'
  HIVE_NATIVE_RECOVERY_INPUT=$(jq -c . "$file")
  HIVE_NATIVE_BACKUP_TOOL=$(base64 -w0 "$HIVE_ROOT/scripts/suite/native-backup-coordinator.mjs") || hive_die 'Native backup coordinator is unavailable'
  while IFS= read -r host; do
    hive_action "$host" native-backup-recover || hive_die 'Native recovery remains held; inspect its protected evidence'
  done < <(jq -r '.hosts|keys[]' "$file")
  printf 'Approved pre-capture native recovery completed. No archive was taken; run backup again with the current controller.\n' >&2
}

hive_restore_native_recovery() {
  local file=$HIVE_NATIVE_RECOVERY_FILE permissions host
  [[ -n "$HIVE_ARCHIVE" && "$HIVE_PREPARE_RECONCILIATION" != true && -z "$HIVE_RECONCILIATION" && "$HIVE_ALLOW_MIGRATIONS" != true && "$HIVE_RELAX_AUTH_LIMITS" != true ]] || hive_die 'Restore continuation needs the original archive and cannot prepare, reconcile or migrate a new plan'
  [[ -f "$file" && ! -L "$file" && $(stat -c %u "$file") == "$(id -u)" ]] || hive_die 'Restore continuation approval must be an operator-owned regular file'
  permissions=$(stat -c %a "$file")
  (( (8#$permissions & 077)==0 && $(stat -c %h "$file")==1 && $(stat -c %s "$file")<=65536 )) || hive_die 'Restore continuation approval must be private, single-link and bounded'
  jq -e --slurpfile config "$HIVE_CONFIG" 'type=="object" and keys==["hosts"] and (.hosts|type=="object" and length==1) and ($config[0].hosts|length)==1 and (.hosts|keys)==($config[0].hosts|keys) and ($config[0].agents|length)==0' "$file" >/dev/null || hive_die 'Restore continuation supports exactly one configured host and no static agents'
  HIVE_NATIVE_RECOVERY_INPUT=$(jq -c . "$file")
  HIVE_NATIVE_RECOVERY_CONFIGURATION_SHA=$(sha256sum "$HIVE_CONFIG" | cut -d ' ' -f1)
  HIVE_NATIVE_RECOVERY_MANIFEST_SEMANTIC_SHA=$(jq -Sc 'del(.controllerSHA256,.version)' "$HIVE_MANIFEST" | sha256sum | cut -d ' ' -f1)
  HIVE_NATIVE_BACKUP_TOOL=$(base64 -w0 "$HIVE_ROOT/scripts/suite/native-backup-coordinator.mjs") || hive_die 'Native backup coordinator is unavailable'
  host=$(jq -er '.hosts|keys[0]' "$file")
  hive_action "$host" restore-recovery-check || hive_die 'Restore continuation preflight failed; original state remains held'
  hive_action "$host" restore-recovery-apply || hive_die 'Restore continuation remains held; inspect its preserved evidence'
  hive_action "$host" restore-recovery-resume || hive_die 'Restored state remains held; inspect its continuation receipt'
  printf 'Approved pre-promotion restore continuation completed; original failed evidence and stage are retained.\n' >&2
}

hive_lifecycle() {
  local operation=$1
  case "$operation" in
    backup|upgrade|rollback|restore|rehearse)
      HIVE_NATIVE_BACKUP_TOOL=$(base64 -w0 "$HIVE_ROOT/scripts/suite/native-backup-coordinator.mjs") || hive_die 'Native backup coordinator is unavailable'
      ;;
  esac
  if [[ "$operation" == install ]] && jq -e '.bootstrap!=null' "$HIVE_CONFIG" >/dev/null; then hive_initialize; fi
  # Protected credentials exist before preflight and before any pre-change backup.
  case "$operation" in install|upgrade|rollback|adopt|rehearse) hive_registry_provision;; esac
  # Before the pre-change backup and the staged input pins, like the registry credentials.
  case "$operation" in install|upgrade) hive_memory_credential_provision;; esac
  # Cindertrace collects the suite audit exports with Oathweave clients declared the same way.
  case "$operation" in install|upgrade) hive_audit_collection_provision;; esac
  case "$operation" in upgrade|rollback) hive_registry_refresh_ingress;; esac
  case "$operation" in install|upgrade|rollback|adopt|rehearse) hive_doctor;; *) hive_registry_preflight;; esac
  case "$operation" in
    agents-accept) hive_all agents-accept || hive_die 'Native acceptance failed; existing suite services were not restarted';;
    install|upgrade|rollback)
      hive_stage
      hive_all adapters-stage || hive_die 'Native agent staging failed; existing suite remains active'
      if [[ "$operation" == install ]] && jq -e '.bootstrap!=null' "$HIVE_CONFIG" >/dev/null; then
        hive_all initialize-data || hive_hold
      fi
      if [[ "$operation" != install ]]; then
        HIVE_ARCHIVE=${HIVE_ARCHIVE:-"pre-$operation-$(date -u +%Y%m%d%H%M%S)-$(openssl rand -hex 4)"}
        hive_native_begin_all
        hive_all quiesce || hive_hold
        hive_all backup || hive_hold
        # The candidate, rather than the archived binary, runs on restored copies.
        hive_all rehearse || hive_hold
        [[ "$operation" != upgrade ]] || hive_all migrate || hive_hold
      fi
      hive_registry_begin || hive_hold
      hive_all activate || hive_hold
      hive_all adapters-accept || hive_hold
      # Recorded before completion: a failed write leaves the transaction open and the
      # command failed, so the installation cannot look finished with a wrong catalog.
      hive_registry_complete || hive_registry_failed "$operation"
      hive_all complete || hive_hold
      if [[ "$operation" == install ]]; then hive_install_summary; fi
      hive_checklist_report
      # Only once the upgrade completed on every host: its archive is now the installed release's.
      if [[ "$operation" == upgrade ]] && declare -F hive_retention_after_upgrade >/dev/null; then hive_retention_after_upgrade; fi
      # The daily prune follows the controller that now runs the installation.
      if declare -F hive_retention_schedule_after >/dev/null; then hive_retention_schedule_after "$operation"; fi
      ;;
    backup)
      HIVE_ARCHIVE=${HIVE_ARCHIVE:-"backup-$(date -u +%Y%m%d%H%M%S)-$(openssl rand -hex 4)"}
      hive_all prepare || hive_die 'Backup transaction could not be prepared'
      if [[ "${HIVE_BACKUP_STOPPED:-false}" == true ]]; then
        # The original backup: every container stops while its state is archived.
        hive_native_begin_all
        hive_all quiesce || hive_hold
        hive_all backup || hive_hold
        hive_all resume-current || hive_hold
      else
        local host
        # Each host reads store kinds and storage formats from the verified release manifest.
        while IFS= read -r host; do
          hive_transfer "$host" "$HIVE_MANIFEST" "manifest.$HIVE_PLAN_DIGEST.json"
        done < <(jq -r '.hosts|keys[]' "$HIVE_CONFIG")
        hive_need gzip; HIVE_SNAPSHOT_TOOL=$(base64 -w0 "$HIVE_ROOT/scripts/suite/snapshot-data.mjs")
        hive_all snapshot || hive_die 'Online backup failed; inspect the protected transaction and native recovery records before retrying. --stopped takes a backup with the suite stopped'
      fi
      printf 'Verified archive ID: %s\n' "$HIVE_ARCHIVE"
      ;;
    rehearse)
      [[ -n "$HIVE_ARCHIVE" ]] || hive_die '--archive ID is required'
      hive_stage
      hive_all rehearse || hive_die 'Rehearsal failed; original installation is unchanged'
      hive_all complete || hive_die 'Rehearsal receipt could not be finalized'
      ;;
    restore)
      [[ -n "$HIVE_ARCHIVE" ]] || hive_die 'Restore requires --archive ID'
      local host
      if [[ "${HIVE_PREPARE_RECONCILIATION:-false}" == true ]]; then
        hive_all restore-preview-check || hive_die 'Restore archive validation failed; nothing was stopped'
      else
        [[ -f "$HIVE_RECONCILIATION" && ! -L "$HIVE_RECONCILIATION" ]] || hive_die 'Restore requires --reconciliation FILE; --prepare-reconciliation holds services and prints a template for review'
        while IFS= read -r host; do
          hive_transfer "$host" "$HIVE_RECONCILIATION" "reconciliation.$HIVE_PLAN_DIGEST.json"
        done < <(jq -r '.hosts|keys[]' "$HIVE_CONFIG")
        hive_all restore-check || hive_die 'Restore acknowledgement or archive validation failed'
      fi
      hive_all prepare || hive_die 'Restore transaction could not be prepared'
      hive_all native-backup-begin || hive_hold
      hive_all quiesce || hive_hold
      if [[ "${HIVE_PREPARE_RECONCILIATION:-false}" == true ]]; then
        hive_all restore-preview || hive_hold
        printf 'Services are held for restore review. Save the host templates in a private file, reconcile subsequent writes, then set subsequentWritesReconciled to true and repeat restore with --reconciliation FILE. No data has been replaced.\n' >&2
        return
      fi
      hive_all restore || hive_hold
      hive_all resume-current || hive_hold
      ;;
    adopt)
      # Adoption never imports or reseeds native state. This operation takes custody
      # only of a reviewed Compose project with exactly the rendered resource set.
      local host temporary
      temporary=$(mktemp -d)
      while IFS= read -r host; do
        hive_render "$host" > "$temporary/$host.json"
        hive_transfer "$host" "$temporary/$host.json" "adoption.$HIVE_PLAN_DIGEST.json"
      done < <(jq -r '.hosts|keys[]' "$HIVE_CONFIG")
      rm -rf -- "$temporary"
      hive_all adopt-check || hive_die 'Existing resources do not match the explicit adoption configuration'
      hive_all prepare || hive_die 'Adoption ownership could not be recorded'
      hive_registry_refresh_ingress
      hive_stage
      hive_all adopt || hive_die 'Adoption verification failed; no service was restarted'
      # The registry joins beside the running products, which are not restarted, and
      # records them. The ingress serves its route after its next restart.
      hive_registry_begin || hive_registry_failed "$operation"
      hive_registry_complete || hive_registry_failed "$operation"
      hive_all complete || hive_die 'Adoption receipt could not be finalized'
      if declare -F hive_retention_schedule_after >/dev/null; then hive_retention_schedule_after "$operation"; fi
      ;;
  esac
}
