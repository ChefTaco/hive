#!/usr/bin/env bash
# Explicit continuation of a reviewed restore which failed before any promotion.
# New controller code runs the ordinary restore and resume actions, scoped to one old plan.
restore_recovery_file() {
  local file=$1 owner=${2:-$(id -u)} mode
  [[ -f "$file" && ! -L "$file" && $(stat -c %h "$file") == 1 ]] || return 1
  [[ $(stat -c %u "$file") == "$owner" || $(stat -c %u "$file") == "$(id -u)" ]] || return 1
  mode=$(stat -c %a "$file"); (( (8#$mode & 077)==0 ))
}
restore_recovery_hash() { [[ $(digest "$1") == "$2" ]]; }
restore_recovery_shape() {
  jq -e 'type=="object" and
    (keys==(["sessionDirectory","prePromotionRestoreReviewed","transactionSHA256","coordinatorSHA256","journalSHA256","reconciliationSHA256","archiveSHA256","archiveReceiptSHA256","rehearsalSHA256","stagedTreeSHA256","currentDataSHA256","expectedCurrentInventorySHA256","configurationSHA256","manifestSHA256","oldControllerSourceSHA256"]|sort)) and
    .prePromotionRestoreReviewed==true and (.sessionDirectory|type=="string" and length<=4096) and
    all(to_entries[]|select(.key|endswith("SHA256"))|.value;type=="string" and test("^[a-f0-9]{64}$"))' <<< "$1" >/dev/null
}
restore_recovery_paths() {
  local approval=$1 relative old expected path
  native_backup_guard && restore_recovery_shape "$approval" || return 1
  [[ $(jq -r .operation <<< "$input") == restore && $(jq '.agents|length' <<< "$input") == 0 ]] || return 1
  native_backup_context || return 1
  relative=$(jq -er .sessionDirectory <<< "$approval")
  [[ "$relative" == "$NATIVE_BACKUP_BASE/"* ]] || return 1
  relative=${relative#"$NATIVE_BACKUP_BASE/"}; old=${relative%%/*}
  [[ "$old" =~ ^[a-f0-9]{64}$ && "${relative#*/}" =~ ^[a-f0-9]{64}$ ]] || return 1
  expected=$(printf '%s\n' "$(jq -er .configurationSHA256 <<< "$approval")" "$(jq -er .manifestSHA256 <<< "$approval")" "$(jq -er .oldControllerSourceSHA256 <<< "$approval")" | sha256sum | cut -d ' ' -f1)
  [[ "$old" == "$expected" && $(jq -er .nativeRecoveryConfigurationSHA256 <<< "$input") == "$(jq -er .configurationSHA256 <<< "$approval")" ]] || return 1
  RESTORE_RECOVERY_NEW_PLAN=$plan
  RESTORE_RECOVERY_NEW_INPUT=$input
  RESTORE_RECOVERY_OLD_PLAN=$old
  plan=$old; input=$(jq -c --arg plan "$old" '.plan=$plan' <<< "$input")
  native_backup_context || return 1
  [[ "$NATIVE_BACKUP_SESSION" == "$(jq -er .sessionDirectory <<< "$approval")" ]] || return 1
  RESTORE_RECOVERY_ROOT="$NATIVE_BACKUP_SESSION/restore-continuation.$RESTORE_RECOVERY_NEW_PLAN"
  RESTORE_RECOVERY_RECEIPT="$RESTORE_RECOVERY_ROOT/delegation.json"
  RESTORE_RECOVERY_APPROVAL_SHA=$(jq -Sc . <<< "$approval" | sha256sum | cut -d ' ' -f1)
  native_backup_plain_path "$NATIVE_BACKUP_SESSION" || return 1
  for path in "$(native_backup_storage_root)" "$NATIVE_BACKUP_BASE" "$NATIVE_BACKUP_PLAN_ROOT" "$NATIVE_BACKUP_SESSION" "$NATIVE_BACKUP_SESSION/state"; do
    [[ -d "$path" && ! -L "$path" && $(stat -c %u "$path") == "$(id -u)" && $(stat -c %a "$path") == 700 ]] || return 1
  done
}
restore_recovery_source() {
  local approval=$1 owner old_manifest semantic
  owner=$(stat -c %u "$directory")
  for file in "$transaction" "$directory/reconciliation.$plan.json" "$directory/backups/$archive/receipt.json" "$directory/rehearsals/$archive/result.json"; do restore_recovery_file "$file" "$owner" || return 1; done
  old_manifest="$directory/manifest.$plan.json"
  [[ -f "$old_manifest" && ! -L "$old_manifest" && $(stat -c %h "$old_manifest") == 1 ]] || return 1
  restore_recovery_hash "$old_manifest" "$(jq -er .manifestSHA256 <<< "$approval")" || return 1
  semantic=$(jq -Sc 'del(.controllerSHA256,.version)' "$old_manifest" | sha256sum | cut -d ' ' -f1)
  [[ "$semantic" == "$(jq -er .nativeRecoveryManifestSemanticSHA256 <<< "$input")" ]] || return 1
  [[ $(jq -er .version "$transaction") == "$version" ]] || return 1
  verify_archive && check_reconciliation || return 1
  restore_recovery_hash "$backup/state.tar.gz" "$(jq -er .archiveSHA256 <<< "$approval")" &&
    restore_recovery_hash "$backup/receipt.json" "$(jq -er .archiveReceiptSHA256 <<< "$approval")" &&
    restore_recovery_hash "$directory/rehearsals/$archive/result.json" "$(jq -er .rehearsalSHA256 <<< "$approval")" &&
    restore_recovery_hash "$directory/reconciliation.$plan.json" "$(jq -er .reconciliationSHA256 <<< "$approval")" || return 1
  jq -e --arg sha "$(jq -er .archiveSHA256 <<< "$approval")" '.result=="passed" and .isolated==true and .portsPublished==false and .archiveSHA256==$sha' "$directory/rehearsals/$archive/result.json" >/dev/null || return 1
  [[ $(tree_digest "$directory/config") == "$(jq -er .configSHA256 "$backup/receipt.json")" ]] || return 1
  assert_stopped || return 1
}
restore_recovery_native_stopped() {
  local meta=$1 inventory
  inventory=$(native_backup_product inspect '{}' "$(jq -er .root <<< "$meta")") || return 1
  jq -e '(.agent.active==false and .agent.clean==true and .agent.cgroupEmpty==true) and all(.profiles[].service;.active==false and .clean==true and .cgroupEmpty==true) and .safety.active==0 and .safety.unknown==0 and .safety.unsupported==0' <<< "$inventory" >/dev/null || return 1
  printf '%s\n' "$inventory"
}
restore_recovery_stage() {
  local stage=$1 expected=$2 owner mode stored_owner size day clock member actual normalized
  native_backup_plain_path "$stage" && [[ -d "$stage" && ! -L "$stage" ]] || return 1
  owner=$(stat -c %u "$directory")
  [[ $(stat -c %u "$stage") == "$owner" || $(stat -c %u "$stage") == "$(id -u)" ]] || return 1
  mode=$(stat -c %a "$stage"); (( (8#$mode & 077)==0 )) || return 1
  [[ -z $(find "$stage" \( \( ! -type f ! -type d \) -o \( -type f -links +1 \) \) -print -quit) ]] || return 1
  [[ $(tree_digest "$stage") == "$expected" ]] || return 1
  cmp -s <(tar -tzf "$backup/state.tar.gz" | sed 's:/$::' | LC_ALL=C sort) <(cd "$stage" && find . -mindepth 1 -printf '%P\n' | LC_ALL=C sort) || return 1
  normalized="$(stat -c %u "$directory")/$(stat -c %g "$directory")"
  while read -r mode stored_owner size day clock member; do
    member=${member%/}; [[ -n "$member" ]] || return 1
    [[ $(stat -c %A "$stage/$member") == "$mode" ]] || return 1
    actual=$(stat -c '%u/%g' "$stage/$member")
    [[ "$actual" == "$stored_owner" || ( "$stored_owner" == 0/0 && "$actual" == "$normalized" ) ]] || return 1
    [[ "${mode:0:1}" != - || $(stat -c %s "$stage/$member") == "$size" ]] || return 1
  done < <(tar --numeric-owner -tvzf "$backup/state.tar.gz")
  # Ownership may have been mapped by the installation's EXIT cleanup. Compare
  # every archived byte in one streaming pass, without executing archived code.
  cmp -s <(tar -xzf "$backup/state.tar.gz" --to-command='value=$(sha256sum | cut -d " " -f1); printf "%s  ./%s\0" "$value" "$TAR_FILENAME"' | LC_ALL=C sort -z) <(tree_lines "$stage" | LC_ALL=C sort -z)
}
restore_recovery_preflight() {
  local approval=$1 meta journal reservation inventory stage path file
  restore_recovery_paths "$approval" && restore_recovery_source "$approval" || return 1
  restore_recovery_hash "$transaction" "$(jq -er .transactionSHA256 <<< "$approval")" || return 1
  jq -e --arg plan "$plan" '.schema==1 and .operation=="restore" and .plan==$plan and .phase=="recovery-required"' "$transaction" >/dev/null || return 1
  meta=$(native_backup_load) || return 1
  [[ $(jq -er .phase <<< "$meta") == quiesced && $(jq -er .session <<< "$meta") == "$(jq -er .fenceSession <<< "$meta")" ]] || return 1
  journal="$NATIVE_BACKUP_SESSION/state/journal.json"; reservation="$(jq -er .root <<< "$meta")/.native-snapshot-reservation.json"
  for file in "$NATIVE_BACKUP_META" "$journal" "$reservation" "$NATIVE_BACKUP_SESSION/reserve.json" "$NATIVE_BACKUP_SESSION/verify.json"; do restore_recovery_file "$file" || return 1; done
  restore_recovery_hash "$NATIVE_BACKUP_META" "$(jq -er .coordinatorSHA256 <<< "$approval")" && restore_recovery_hash "$journal" "$(jq -er .journalSHA256 <<< "$approval")" || return 1
  jq -e --argjson meta "$meta" '.phase=="stopped" and .session==$meta.session and .targetSha256==$meta.targetSha256 and .stoppedInventorySha256==$meta.stoppedInventorySHA256 and .manifestSHA256==null and .restoredInventorySha256==null and .promotions==[]' "$journal" >/dev/null || return 1
  jq -e --argjson meta "$meta" --arg state "$NATIVE_BACKUP_SESSION/state" '.session==$meta.session and .targetSha256==$meta.targetSha256 and .state==$state' "$reservation" >/dev/null || return 1
  for file in reserve verify; do jq -e --argjson meta "$meta" --arg action "$file" '.schema==1 and .verified==true and .closed==true and .nodeId==$meta.nodeId and .nodeFqdn==$meta.nodeFqdn and .session==$meta.session and .action==$action' "$NATIVE_BACKUP_SESSION/$file.json" >/dev/null || return 1; done
  [[ ! -e "$NATIVE_BACKUP_SESSION/restore-source" && ! -L "$NATIVE_BACKUP_SESSION/restore-source" ]] || return 1
  [[ -z $(find "$directory" -mindepth 1 -maxdepth 1 -name 'pre-restore-*' -print -quit) ]] || return 1
  native_backup_stopped_inventory "$meta" >/dev/null || return 1
  inventory=$(restore_recovery_native_stopped "$meta") || return 1
  [[ $(jq -er .inventorySha256 <<< "$inventory") == "$(jq -er .expectedCurrentInventorySHA256 <<< "$approval")" && $(jq -er .stoppedInventorySHA256 <<< "$meta") == "$(jq -er .expectedCurrentInventorySHA256 <<< "$approval")" ]] || return 1
  for path in $(jq -r '[.target.root,.target.install]|.[]' <<< "$inventory"); do
    [[ -z $(find "$(dirname -- "$path")" -mindepth 1 -maxdepth 1 -name "$(basename -- "$path").native-snapshot-*" -print -quit) ]] || return 1
  done
  path=$(jq -er .target.home <<< "$inventory")/.config/systemd/user
  [[ ! -d "$path" || -z $(find "$path" -mindepth 1 -maxdepth 1 -name '*.native-snapshot-*' -print -quit) ]] || return 1
  [[ $(tree_digest "$directory/data") == "$(jq -er .currentDataSHA256 <<< "$approval")" && $(jq -er --arg host "$host" '.hosts[$host].currentDataSHA256' "$directory/reconciliation.$plan.json") == "$(jq -er .currentDataSHA256 <<< "$approval")" ]] || return 1
  jq -e --arg host "$host" --arg sha "$(jq -er .expectedCurrentInventorySHA256 <<< "$approval")" '.hosts[$host].nativeProfiles.currentInventorySHA256==$sha' "$directory/reconciliation.$plan.json" >/dev/null || return 1
  stage="$directory/restore.$plan"
  restore_recovery_stage "$stage" "$(jq -er .stagedTreeSHA256 <<< "$approval")" || return 1
  [[ ! -e "$RESTORE_RECOVERY_ROOT" && ! -L "$RESTORE_RECOVERY_ROOT" ]] || return 1
}
restore_recovery_apply() {
  local approval=$1 record file
  restore_recovery_preflight "$approval" || return 1
  native_backup_private_dir "$RESTORE_RECOVERY_ROOT" || return 1
  for file in "$transaction" "$NATIVE_BACKUP_META" "$NATIVE_BACKUP_SESSION/state/journal.json" "$directory/reconciliation.$plan.json"; do cp -p -- "$file" "$RESTORE_RECOVERY_ROOT/$(basename -- "$file").before" || return 1; done
  native_backup_write "$RESTORE_RECOVERY_ROOT/approval.json" "$approval" || return 1
  record=$(jq -nc --arg old "$plan" --arg new "$RESTORE_RECOVERY_NEW_PLAN" --arg source "$(jq -er .controllerSourceSHA256 <<< "$input")" --arg manifest "$(jq -er .digest <<< "$input")" --arg approval "$RESTORE_RECOVERY_APPROVAL_SHA" --arg session "$(jq -er .session "$NATIVE_BACKUP_META")" '{schema:1,oldPlan:$old,newPlan:$new,controllerSourceSHA256:$source,manifestSHA256:$manifest,approvalSHA256:$approval,session:$session,phase:"continuing"}')
  native_backup_write "$RESTORE_RECOVERY_RECEIPT" "$record" || return 1
  mv -T -- "$directory/restore.$plan" "$RESTORE_RECOVERY_ROOT/failed-stage" || return 1
}
restore_recovery_record_restored() {
  local record
  record=$(jq '.phase="restored"' "$RESTORE_RECOVERY_RECEIPT") || return 1
  native_backup_write "$RESTORE_RECOVERY_RECEIPT" "$record"
}
restore_recovery_resume() {
  local approval=$1 meta journal receipt archive_session current
  restore_recovery_paths "$approval" && restore_recovery_source "$approval" || return 1
  restore_recovery_file "$RESTORE_RECOVERY_RECEIPT" || return 1
  receipt=$(cat "$RESTORE_RECOVERY_RECEIPT")
  jq -e --arg old "$plan" --arg new "$RESTORE_RECOVERY_NEW_PLAN" --arg source "$(jq -er .controllerSourceSHA256 <<< "$input")" --arg manifest "$(jq -er .digest <<< "$input")" --arg approval "$RESTORE_RECOVERY_APPROVAL_SHA" '.schema==1 and .oldPlan==$old and .newPlan==$new and .controllerSourceSHA256==$source and .manifestSHA256==$manifest and .approvalSHA256==$approval and .phase=="restored"' <<< "$receipt" >/dev/null || return 1
  jq -e --arg plan "$plan" '.plan==$plan and .operation=="restore" and .phase=="restored"' "$transaction" >/dev/null || return 1
  [[ $(tree_digest "$directory/data") == "$(jq -er .dataSHA256 "$backup/receipt.json")" ]] || return 1
  meta=$(native_backup_load) || return 1; journal="$NATIVE_BACKUP_SESSION/state/journal.json"
  restore_recovery_file "$NATIVE_BACKUP_META" && restore_recovery_file "$journal" || return 1
  archive_session=$(tar -xOzf "$backup/state.tar.gz" native-profiles/coordinator.json | jq -er .session) || return 1
  jq -e --arg session "$(jq -er .session <<< "$receipt")" --arg archived "$archive_session" '.phase=="restored" and .session==$session and .fenceSession==$archived' <<< "$meta" >/dev/null || return 1
  tar -xOzf "$backup/state.tar.gz" native-profiles/coordinator.json | jq -e --argjson meta "$meta" '.nodeId==$meta.nodeId and .nodeFqdn==$meta.nodeFqdn and .manifestSHA256==$meta.manifestSHA256' >/dev/null || return 1
  jq -e --argjson meta "$meta" '.phase=="restored" and .session==$meta.session and .targetSha256==$meta.targetSha256 and .manifestSHA256==$meta.manifestSHA256 and (.restoredInventorySha256|test("^[a-f0-9]{64}$")) and (.promotions|length)>0 and all(.promotions[];.phase=="promoted")' "$journal" >/dev/null || return 1
  current=$(restore_recovery_native_stopped "$meta") || return 1
  jq -e '.safety.active==0 and .safety.unknown==0 and .safety.unsupported==0' <<< "$current" >/dev/null || return 1
  [[ $(jq -er .inventorySha256 <<< "$current") == "$(jq -er .restoredInventorySha256 "$journal")" ]] || return 1
  # Magnus is still stopped here. The pinned restored data carries its archived
  # fence; ordinary resume-current starts Magnus, then native_backup_finish
  # verifies that exact fence before starting native services or releasing it.
}
restore_recovery_record_complete() {
  local record
  [[ $(jq -er .phase "$transaction") == complete && $(jq -er .phase "$NATIVE_BACKUP_META") == released ]] || return 1
  record=$(jq '.phase="complete"' "$RESTORE_RECOVERY_RECEIPT") || return 1
  native_backup_write "$RESTORE_RECOVERY_RECEIPT" "$record"
}
