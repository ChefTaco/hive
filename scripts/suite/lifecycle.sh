#!/usr/bin/env bash

hive_action() {
  local host=$1 file script=''
  local -a files=(public-runtime.sh integrity-host.sh input-artifacts-host.sh native-initialization-host.sh adapters-host.sh inference-registration.sh initialize-migrations-host.sh host-runtime.sh)
  [[ "$2" != snapshot ]] || files=(integrity-host.sh adapters-host.sh snapshot-host.sh host-runtime.sh)
  for file in "${files[@]}"; do script+=$(cat "$HIVE_ROOT/scripts/suite/$file")$'\n'; done
  # The host script travels as one command-line argument, which the kernel bounds at 128 KiB.
  # The online backup ships only the definitions it runs, compressed; it is the same code.
  if [[ "$2" == snapshot ]]; then script="eval \"\$(printf '%s' '$(printf '%s' "$script" | gzip -9n | base64 -w0)' | base64 -d | gunzip)\""; fi
  HIVE_HOST_ACTION=$2 hive_host "$host" "$script"
}

hive_all() {
  local host
  while IFS= read -r host; do
    hive_action "$host" "$1" || return 1
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
    hive_transfer "$host" "$temporary/$host.json" "candidate.$HIVE_PLAN_DIGEST.json"
    hive_transfer "$host" "$HIVE_MANIFEST" "manifest.$HIVE_PLAN_DIGEST.json"
    hive_transfer "$host" "$HIVE_SIGNATURE" "signature.$HIVE_PLAN_DIGEST"
    hive_transfer "$host" "$HIVE_TRUST_KEY" "trust.$HIVE_PLAN_DIGEST.pub"
    hive_transfer "$host" "$temporary/controller.tar.gz" "controller.$HIVE_PLAN_DIGEST.tar.gz"
    hive_action "$host" stage || { rm -rf -- "$temporary"; hive_die 'Host staging failed before quiescence'; }
    hive_action "$host" compatibility || { rm -rf -- "$temporary"; hive_die 'Storage compatibility check failed before quiescence'; }
    hive_action "$host" adapters-preflight || { rm -rf -- "$temporary"; hive_die 'Native agent or external endpoint reference preflight failed'; }
  done < <(jq -r '.hosts|keys[]' "$HIVE_CONFIG")
  rm -rf -- "$temporary"
}

hive_lifecycle() {
  local operation=$1
  if [[ "$operation" == install ]] && jq -e '.bootstrap!=null' "$HIVE_CONFIG" >/dev/null; then hive_initialize; fi
  # Protected credentials exist before preflight and before any pre-change backup.
  case "$operation" in install|upgrade|rollback|adopt|rehearse) hive_registry_provision;; esac
  # Before the pre-change backup and the staged input pins, like the registry credentials.
  case "$operation" in install|upgrade) hive_memory_credential_provision;; esac
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
      ;;
    backup)
      HIVE_ARCHIVE=${HIVE_ARCHIVE:-"backup-$(date -u +%Y%m%d%H%M%S)-$(openssl rand -hex 4)"}
      hive_all prepare || hive_die 'Backup transaction could not be prepared'
      if [[ "${HIVE_BACKUP_STOPPED:-false}" == true ]]; then
        # The original backup: every container stops while its state is archived.
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
        hive_all snapshot || hive_die 'Online backup failed; the suite kept serving and no archive was kept on the failed host. --stopped takes the backup with the suite stopped'
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
      [[ -n "$HIVE_ARCHIVE" && -f "$HIVE_RECONCILIATION" && ! -L "$HIVE_RECONCILIATION" ]] || hive_die 'Restore requires --archive ID and --reconciliation FILE tied to the current data digest'
      local host
      while IFS= read -r host; do
        hive_transfer "$host" "$HIVE_RECONCILIATION" "reconciliation.$HIVE_PLAN_DIGEST.json"
      done < <(jq -r '.hosts|keys[]' "$HIVE_CONFIG")
      hive_all restore-check || hive_die 'Restore acknowledgement or archive validation failed'
      hive_all prepare || hive_die 'Restore transaction could not be prepared'
      hive_all quiesce || hive_hold
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
      ;;
  esac
}
