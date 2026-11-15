#!/usr/bin/env bash
set -Eeuo pipefail
umask 077
ROOT=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)
source "$ROOT/scripts/suite/native-backup-host.sh"
eval "$(declare -f native_backup_coordinator | sed '1s/native_backup_coordinator/real_native_backup_coordinator/')"
eval "$(declare -f native_backup_discover | sed '1s/native_backup_discover/real_native_backup_discover/')"
eval "$(declare -f native_backup_suite_serving | sed '1s/native_backup_suite_serving/real_native_backup_suite_serving/')"
temporary=$(mktemp -d); trap 'rm -rf -- "$temporary"' EXIT
fail() { printf 'FAIL: %s\n' "$*" >&2; exit 1; }
installation=example-suite host=control plan=$(printf 'a%.0s' {1..64}) archive=first
directory="$temporary/installation"; mkdir -p "$directory" "$temporary/agent"
input='{"operation":"backup","agents":[],"nativeBackupTool":"ZmFrZQ=="}'
live=$(printf '1%.0s' {1..64}); stopped=$(printf '2%.0s' {1..64}); restored_sha=$(printf '3%.0s' {1..64}); target_sha=$(printf '4%.0s' {1..64})
printf live > "$temporary/product-phase"; : > "$temporary/calls"
printf '[]\n' > "$temporary/inventory-padding.json"
native_backup_storage_root() { printf '%s/storage\n' "$temporary"; }
native_backup_guard() { :; }
native_backup_free_kib() { if [[ -e "$temporary/no-space" ]]; then printf '1\n'; else printf '1000000\n'; fi; }
native_backup_discover() {
  local present=true; [[ ! -e "$temporary/no-profiles" ]] || present=false
  jq -nc --arg root "$temporary/agent" --argjson present "$present" '{available:true,present:$present,root:$root,nodeId:"node-one",nodeFqdn:"node-1.example.com"}'
}
native_backup_coordinator() {
  local action=$1 meta=$2 session
  printf 'coordinator:%s\n' "$action" >> "$temporary/calls"
  [[ ! -e "$temporary/api-down" ]] || return 1
  session=$(jq -er '.fenceSession // .session' <<< "$meta")
  case "$action" in
    reserve) [[ ! -e "$temporary/fence" ]] || [[ $(cat "$temporary/fence") == "$session" ]] || return 1; printf '%s' "$session" > "$temporary/fence";;
    verify|release) [[ -e "$temporary/fence" && $(cat "$temporary/fence") == "$session" ]] || return 1;;
  esac
  [[ "$action" != release ]] || rm "$temporary/fence"
  jq -nc --arg action "$action" --arg session "$session" '{schema:1,action:$action,session:$session,verified:true,closed:($action!="release"),nodeId:"node-one",nodeFqdn:"node-1.example.com"}'
}
native_backup_product() {
  local action=$1 request=$2 root=$3 state destination phase sha manifest session active=false previous history journal_sha
  printf 'product:%s\n' "$action" >> "$temporary/calls"
  case "$action" in
    inspect)
      [[ ! -e "$temporary/unsupported-cli" ]] || return 1
      phase=$(cat "$temporary/product-phase"); sha=$live
      [[ "$phase" != stopped ]] || sha=$stopped; [[ "$phase" != restored ]] || sha=$restored_sha
      [[ "$phase" != live ]] || active=true
      jq -nc --arg inventory "$sha" --arg target "$target_sha" --arg root "$temporary/native-root" --arg install "$temporary/runtime" --argjson active "$active" \
        '{schemaVersion:1,target:{uid:1001,root:$root,install:$install},targetSha256:$target,inventorySha256:$inventory,agent:{unit:"magnus-agent.service",scope:"system",active:$active,enabled:"enabled",clean:true,cgroupEmpty:($active|not)},profiles:[{id:"active",service:{unit:"ardent@active.service",scope:"user",active:$active,enabled:"enabled",clean:true,cgroupEmpty:($active|not)}},{id:"inactive",service:{unit:"ardent@inactive.service",scope:"user",active:false,enabled:"disabled",clean:true,cgroupEmpty:true}}],safety:{active:0,unknown:0,unsupported:0},trees:[{entries:[{kind:"file",size:1024}]}]}' |
        jq --slurpfile padding "$temporary/inventory-padding.json" '.trees[0].entries += $padding[0]' ;;
    quiesce)
      state=$(jq -er .state <<< "$request"); session=$(jq -er .session <<< "$request")
      [[ $(jq -er .expectedInventorySha256 <<< "$request") == "$live" ]]
      mkdir -m 700 "$state"
      jq -nc --arg session "$session" --arg target "$target_sha" --arg stopped "$stopped" '{session:$session,targetSha256:$target,phase:"stopped",stoppedInventorySha256:$stopped,promotions:[],manifestSHA256:null,activation:[{unit:"magnus-agent.service",scope:"system",active:true,enabled:"enabled"},{unit:"ardent@active.service",scope:"user",active:true,enabled:"enabled"},{unit:"ardent@inactive.service",scope:"user",active:false,enabled:"disabled"}]}' > "$state/journal.json"
      jq -nc --arg session "$session" --arg state "$state" --arg target "$target_sha" '{session:$session,state:$state,targetSha256:$target}' > "$root/.native-snapshot-reservation.json"
      printf stopped > "$temporary/product-phase"
      if [[ -e "$temporary/quiesce-failure" ]]; then
        jq '.phase="held"|.stoppedInventorySha256=null|.failure="Inventory changed after shutdown"' "$state/journal.json" > "$state/next"; mv "$state/next" "$state/journal.json"
        printf '{"success":false,"error":{"code":"NATIVE_SNAPSHOT_REFUSED","message":"Inventory changed after shutdown"}}\n'; return 1
      fi
      jq -nc --arg session "$session" --arg stopped "$stopped" '{schemaVersion:1,session:$session,stoppedInventorySha256:$stopped}';;
    recover-quiesce)
      state=$(jq -er .state <<< "$request"); session=$(jq -er .session <<< "$request")
      previous=$(sha256sum "$state/journal.json" | cut -d ' ' -f1)
      [[ $(jq -er .expectedCurrent <<< "$request") == "$stopped" && $(jq -er .expectedJournalSHA256 <<< "$request") == "$previous" && $(jq -er .session "$state/journal.json") == "$session" ]]
      mkdir -m 700 "$state/history"; history="$state/history/journal-$previous.json"; cp "$state/journal.json" "$history"
      jq --arg stopped "$stopped" '.phase="stopped"|.stoppedInventorySha256=$stopped' "$state/journal.json" > "$state/next"; mv "$state/next" "$state/journal.json"
      journal_sha=$(sha256sum "$state/journal.json" | cut -d ' ' -f1)
      jq -nc --arg state "$state" --arg session "$session" --arg target "$target_sha" --arg stopped "$stopped" --arg previous "$previous" --arg journal "$journal_sha" --arg history "$history" '{schemaVersion:1,recovered:true,state:$state,session:$session,targetSha256:$target,stoppedInventorySha256:$stopped,safety:{active:0,unknown:0,unsupported:0},previousJournalSHA256:$previous,journalSHA256:$journal,historyPath:$history,historySHA256:$previous}';;
    capture)
      state=$(jq -er .state <<< "$request"); destination=$(jq -er .destination <<< "$request"); session=$(jq -er .session "$state/journal.json")
      mkdir -m 700 "$destination"
      jq -nc --arg session "$session" --arg target "$target_sha" '{session:$session,targetSha256:$target,profiles:["active","inactive"]}' > "$destination/manifest.json"
      mkdir -m 700 "$destination/files"
      printf 'synthetic native private payload\n' > "$destination/files/payload"
      sha=$(sha256sum "$destination/manifest.json" | cut -d ' ' -f1)
      jq -nc --arg sha "$sha" --arg target "$target_sha" --arg session "$session" '{manifestSHA256:$sha,targetSha256:$target,session:$session,profiles:["active","inactive"]}' |
        jq --slurpfile padding "$temporary/inventory-padding.json" '.+{diagnostic:$padding[0]}';;
    verify)
      destination=$(jq -er .source <<< "$request"); [[ -f "$destination/manifest.json" && -f "$destination/files/payload" ]] || return 1
      [[ "$destination" == "$(native_backup_storage_root)/"* ]] || fail 'Untrusted bundle was not copied to private storage'
      sha=$(sha256sum "$destination/manifest.json" | cut -d ' ' -f1)
      jq -nc --arg sha "$sha" --arg target "$target_sha" '{manifestSHA256:$sha,targetSha256:$target,profiles:["active","inactive"]}' |
        jq --slurpfile padding "$temporary/inventory-padding.json" '.+{diagnostic:$padding[0]}';;
    restore)
      [[ $(jq -er .expectedCurrent <<< "$request") == "$stopped" ]]
      destination=$(jq -er .source <<< "$request"); [[ "$destination" == "$NATIVE_BACKUP_SESSION/restore-source/bundle" ]] || fail 'Restore used a mutable installation copy'
      state=$(jq -er .state <<< "$request"); sha=$(sha256sum "$destination/manifest.json" | cut -d ' ' -f1)
      printf restored > "$temporary/product-phase"
      jq '.phase="restored"' "$state/journal.json" > "$state/next"; mv "$state/next" "$state/journal.json"
      jq -nc --arg sha "$sha" '{restored:true,manifestSHA256:$sha}';;
    resume)
      [[ ! -e "$temporary/unknown-work" ]] || return 1
      state=$(jq -er .state <<< "$request"); session=$(jq -er .session "$state/journal.json")
      [[ $(jq -er .session "$root/.native-snapshot-reservation.json") == "$session" ]]
      rm "$root/.native-snapshot-reservation.json"; printf live > "$temporary/product-phase"
      jq '.phase="resumed"' "$state/journal.json" > "$state/next"; mv "$state/next" "$state/journal.json"
      jq -nc '{resumed:true,profiles:["ardent@active.service"]}';;
    *) fail "Unexpected product action $action";;
  esac
}
# Each SSH action starts with transport variables and definitions, but no state
# context from a previous action. A command substitution cannot initialize it.
restore_in_fresh_context() (
  unset NATIVE_BACKUP_BASE NATIVE_BACKUP_OPERATION NATIVE_BACKUP_PLAN_ROOT NATIVE_BACKUP_SESSION NATIVE_BACKUP_META
  native_backup_restore "$1"
)
touch "$temporary/no-profiles"
native_backup_begin
native_backup_capture "$directory/no-native-profiles"
[[ ! -e "$directory/no-native-profiles" && ! -s "$temporary/calls" ]] || fail 'Empty discovery adopted old state or called the product'
mkdir "$directory/no-native-profiles"
if native_backup_capture "$directory/no-native-profiles"; then fail 'No-op inherited a prior bundle'; fi
rmdir "$directory/no-native-profiles"; rm "$temporary/no-profiles"
touch "$temporary/unsupported-cli"
if native_backup_begin > "$temporary/refused" 2>&1; then fail 'Unknown CLI accepted existing profiles'; fi
! grep -qE 'quiesce|coordinator:reserve' "$temporary/calls" || fail 'Unsupported CLI stopped or fenced anything'
rm "$temporary/unsupported-cli"; : > "$temporary/calls"
touch "$temporary/no-space"
if native_backup_begin > "$temporary/refused" 2>&1; then fail 'Insufficient space accepted'; fi
! grep -q quiesce "$temporary/calls" || fail 'Disk refusal occurred after stopping'
rm "$temporary/no-space"
# Real runtime inventories exceed the per-argument kernel limit; all large JSON stays on stdin.
jq -n '[range(0;12000)|{kind:"file",size:1,path:((tostring)+"/"+("runtime-entry/"*16))}]' > "$temporary/inventory-padding.json"
inventory=$(native_backup_product inspect '{}' "$temporary/agent")
(( ${#inventory} > 2097152 )) || fail 'Large inventory fixture is too small'
native_backup_overlap "$inventory"
input=$(jq --arg path "$temporary/native-root/profiles/manual" '.agents=[{profileDirectory:$path}]' <<< "$input")
if native_backup_begin > "$temporary/refused" 2>&1; then fail 'Duplicate native custody accepted'; fi
input=$(jq '.agents=[]' <<< "$input"); : > "$temporary/calls"
native_backup_begin
session_path=$NATIVE_BACKUP_SESSION; first_session=$(jq -er .session "$NATIVE_BACKUP_META")
[[ $(cat "$temporary/calls") == $'product:inspect\ncoordinator:reserve\nproduct:quiesce\ncoordinator:verify' ]] || fail 'Discovery/fence/quiesce order differs'
native_backup_capture "$directory/native-profiles"
printf '[]\n' > "$temporary/inventory-padding.json"
receipt=$(native_backup_verify "$directory/native-profiles")
jq -e '.verified==true and .profiles==2' <<< "$receipt" >/dev/null
native_backup_capture "$directory/native-profiles" # Exact retry checks the existing bundle.
touch "$temporary/api-down"
native_backup_begin # Durable stopped owner permits retry with API intentionally stopped.
native_backup_capture "$directory/native-profiles" # Stopped backups only verify the exact prior capture.
[[ $(jq -er .phase "$NATIVE_BACKUP_META") == captured ]] || fail 'Offline verification changed the captured journal'
ack=$(native_backup_reconciliation "$(jq -er .manifestSHA256 <<< "$receipt")")
jq -e --arg stopped "$stopped" '.currentInventorySHA256==$stopped' <<< "$ack" >/dev/null
rm "$temporary/api-down"
cp -a "$directory/native-profiles" "$directory/invalid"
rm "$directory/invalid/bundle/manifest.json"
if native_backup_verify "$directory/invalid" > "$temporary/refused" 2>&1; then fail 'Missing manifest accepted'; fi
rm -rf "$directory/invalid"
cp -a "$directory/native-profiles" "$directory/invalid"
jq '.padding=("x"*20000)' "$directory/invalid/coordinator.json" > "$directory/invalid/next"; mv "$directory/invalid/next" "$directory/invalid/coordinator.json"
if native_backup_verify "$directory/invalid" > "$temporary/refused" 2>&1; then fail 'Padded untrusted coordinator record accepted'; fi
rm -rf "$directory/invalid"
touch "$temporary/unknown-work"
if native_backup_finish > "$temporary/refused" 2>&1; then fail 'Unknown work was resumed'; fi
[[ -e "$temporary/fence" ]] || fail 'Unknown work released its fence'
[[ -f "$NATIVE_BACKUP_SESSION/bundle/files/payload" ]] || fail 'Held cleanup deleted recovery payloads'
if native_backup_compact "$(native_backup_load)" > "$temporary/refused" 2>&1; then fail 'An unreleased session was compacted'; fi
rm "$temporary/unknown-work"
mkdir -m 700 "$NATIVE_BACKUP_SESSION/state/previous-checkpoint"
printf retained > "$NATIVE_BACKUP_SESSION/state/previous-checkpoint/payload"
native_backup_finish
[[ ! -e "$temporary/fence" && $(jq -er .phase "$NATIVE_BACKUP_META") == released ]] || fail 'Clean session did not finish'
[[ ! -e "$NATIVE_BACKUP_SESSION/bundle/files" && -f "$NATIVE_BACKUP_SESSION/bundle/manifest.json" && -f "$NATIVE_BACKUP_SESSION/release.json" && -f "$NATIVE_BACKUP_SESSION/state/journal.json" && -f "$NATIVE_BACKUP_SESSION/state/previous-checkpoint/payload" ]] || fail 'Released compaction removed evidence/checkpoints or retained payloads'
[[ $(grep -c '^product:resume$' "$temporary/calls") == 2 ]] || fail 'Host bypassed product resume state handling'
native_backup_finish # No duplicate starts or releases.
mkdir "$NATIVE_BACKUP_SESSION/bundle/files"; ln -s "$temporary" "$NATIVE_BACKUP_SESSION/bundle/files/foreign"
if native_backup_compact "$(native_backup_load)" > "$temporary/refused" 2>&1; then fail 'Compaction accepted a symlink payload'; fi
[[ -L "$NATIVE_BACKUP_SESSION/bundle/files/foreign" ]] || fail 'Unsafe compaction changed the payload tree'
native_backup_finish > "$temporary/cleanup.stdout" 2> "$temporary/cleanup.stderr" || fail 'A cleanup warning became a false service hold'
[[ $(jq -er .phase "$NATIVE_BACKUP_META") == released && ! -e "$temporary/fence" && -L "$NATIVE_BACKUP_SESSION/bundle/files/foreign" ]] || fail 'Cleanup refusal changed released service/fence state or deleted payload'
jq -e '.required==true and .phase=="released"' "$NATIVE_BACKUP_SESSION/cleanup-required.json" >/dev/null || fail 'Cleanup warning was not recorded durably'
[[ -s "$temporary/cleanup.stderr" ]] || fail 'Cleanup refusal was not reported'
rm "$NATIVE_BACKUP_SESSION/bundle/files/foreign"; rmdir "$NATIVE_BACKUP_SESSION/bundle/files"
native_backup_finish
jq -e '.required==false' "$NATIVE_BACKUP_SESSION/cleanup-required.json" >/dev/null || fail 'Successful cleanup retry left a stale warning'
ln -s "$temporary" "$NATIVE_BACKUP_SESSION/restore-source"
if native_backup_compact "$(native_backup_load)" > "$temporary/refused" 2>&1; then fail 'Compaction accepted an aliased storage ancestor'; fi
rm "$NATIVE_BACKUP_SESSION/restore-source"
before=$(wc -l < "$temporary/calls")
if native_backup_capture "$directory/after-release" > "$temporary/refused" 2>&1; then fail 'Released capture silently omitted native profiles'; fi
[[ ! -e "$directory/after-release" ]] || fail 'Released capture created an inherited bundle'
# Verified completed repeats never start a second session or inherit staging.
mkdir -p "$directory/backups/$archive"
tar -czf "$directory/backups/$archive/state.tar.gz" -C "$directory" native-profiles
verify_archive() { [[ -f "$directory/backups/$archive/state.tar.gz" && ! -e "$temporary/corrupt-archive" ]]; }
native_backup_begin
native_backup_capture "$directory/after-release"
[[ $(wc -l < "$temporary/calls") == "$before" && ! -e "$directory/after-release" ]] || fail 'Completed archive repeat changed service state'
touch "$temporary/corrupt-archive"
if native_backup_begin > "$temporary/refused" 2>&1; then fail 'Unverified completed archive accepted'; fi
rm "$temporary/corrupt-archive"; rm -rf "$directory/backups/$archive"
# A clean failed online attempt can retain its evidence and acquire a fresh session.
native_backup_begin
[[ $(jq -er .session "$NATIVE_BACKUP_META") != "$first_session" && -d "$session_path.previous-$first_session" ]] || fail 'Clean retry reused or discarded its released journal'
native_backup_capture "$directory/retried-native-profiles"
native_backup_finish
archive=second; native_backup_begin
[[ "$NATIVE_BACKUP_SESSION" != "$session_path" ]] || fail 'Different archive reused old journal'
if native_backup_capture "$directory/native-profiles" > "$temporary/refused" 2>&1; then fail 'A new archive inherited an old session bundle'; fi
native_backup_capture "$directory/second-native-profiles"
ln -s "$temporary" "$NATIVE_BACKUP_SESSION/bundle/files/foreign"
native_backup_finish > "$temporary/cleanup.stdout" 2> "$temporary/cleanup.stderr" || fail 'Cleanup refusal after release failed a successful backup'
[[ $(jq -er .phase "$NATIVE_BACKUP_META") == released && ! -e "$temporary/fence" && -f "$NATIVE_BACKUP_SESSION/bundle/files/payload" ]] || fail 'Post-release cleanup refusal lost payload or falsely held services'
jq -e '.required==true' "$NATIVE_BACKUP_SESSION/cleanup-required.json" >/dev/null
rm "$NATIVE_BACKUP_SESSION/bundle/files/foreign"
native_backup_finish
input=$(jq '.operation="restore"' <<< "$input"); archive=first
native_backup_begin
[[ "$NATIVE_BACKUP_SESSION" != "$session_path" ]] || fail 'Restore reused backup journal'
before=$(grep -c '^product:restore$' "$temporary/calls" || true)
if restore_in_fresh_context "$directory" > "$temporary/refused" 2>&1; then fail 'Missing reconciliation accepted'; fi
jq -nc --arg sha "$(jq -er .manifestSHA256 <<< "$receipt")" --arg live "$live" '{hosts:{control:{nativeProfiles:{archiveManifestSHA256:$sha,currentInventorySHA256:$live}}}}' > "$directory/reconciliation.$plan.json"
if restore_in_fresh_context "$directory" > "$temporary/refused" 2>&1; then fail 'Stale reconciliation accepted'; fi
[[ $(grep -c '^product:restore$' "$temporary/calls" || true) == "$before" ]] || fail 'Reconciliation refusal occurred after promotion'
jq -nc --argjson ack "$ack" '{hosts:{control:{nativeProfiles:$ack}}}' > "$directory/reconciliation.$plan.json"
touch "$temporary/api-down"
native_backup_begin
restore_in_fresh_context "$directory"
[[ $(jq -er .fenceSession "$NATIVE_BACKUP_META") == "$first_session" ]] || fail 'Archived fence owner was lost after restore'
rm "$temporary/api-down"
printf '%s' "$first_session" > "$temporary/fence" # Suite DB restore reinstates the archived fence.
native_backup_finish
[[ ! -e "$temporary/fence" ]] || fail 'Restored exact fence was not released'
[[ ! -e "$NATIVE_BACKUP_SESSION/restore-source/bundle/files" && -f "$NATIVE_BACKUP_SESSION/restore-source/bundle/manifest.json" ]] || fail 'Restored temporary payload was not compacted with manifest retained'
archive=foreign; input=$(jq '.operation="backup"' <<< "$input"); native_backup_begin
printf 'another-session' > "$temporary/fence"
before=$(grep -c '^product:resume$' "$temporary/calls")
if native_backup_finish > "$temporary/refused" 2>&1; then fail 'Foreign fence was released'; fi
[[ $(cat "$temporary/fence") == another-session && $(grep -c '^product:resume$' "$temporary/calls") == "$before" ]] || fail 'Foreign fence changed native services'
ln -s "$temporary" "$temporary/link"
if native_backup_private_dir "$temporary/link/private"; then fail 'Symlink ancestor accepted'; fi
# Explicit recovery can cross controller plans only with exact reviewed old scope.
rm "$temporary/fence" "$temporary/agent/.native-snapshot-reservation.json"
printf live > "$temporary/product-phase"
archive=recovery-only; plan=$(printf 'c%.0s' {1..64})
input=$(jq --arg source "$(printf 'd%.0s' {1..64})" '.controllerSourceSHA256=$source' <<< "$input")
touch "$temporary/quiesce-failure"
if native_backup_begin > "$temporary/refused" 2>&1; then fail 'Recovery fixture did not hold its failed shutdown'; fi
rm "$temporary/quiesce-failure"
old_scope=$NATIVE_BACKUP_SESSION; old_meta=$NATIVE_BACKUP_META; old_plan=$plan
jq -nc --arg plan "$plan" '{schema:1,plan:$plan,operation:"backup",phase:"recovery-required",version:"1.0.0"}' > "$directory/transaction.json"
approval=$(jq -nc --arg scope "$old_scope" --arg current "$stopped" --arg coordinator "$(sha256sum "$old_meta" | cut -d ' ' -f1)" --arg journal "$(sha256sum "$old_scope/state/journal.json" | cut -d ' ' -f1)" '{sessionDirectory:$scope,expectedCurrentInventorySHA256:$current,coordinatorSHA256:$coordinator,journalSHA256:$journal,quiescenceEffectsReviewed:true}')
plan=$(printf 'e%.0s' {1..64})
native_backup_suite_serving() { [[ ! -e "$temporary/suite-down" ]]; }
recover_count=$(grep -c '^product:recover-quiesce$' "$temporary/calls" || true)
for field in coordinatorSHA256 journalSHA256 expectedCurrentInventorySHA256; do
  bad=$(jq --arg field "$field" --arg sha "$(printf '0%.0s' {1..64})" '.[$field]=$sha' <<< "$approval")
  if native_backup_recover "$bad" > "$temporary/refused" 2>&1; then fail "Recovery accepted a stale $field"; fi
done
bad=$(jq '.sessionDirectory|="/var/lib/another-installation/session"' <<< "$approval")
if native_backup_recover "$bad" > "$temporary/refused" 2>&1; then fail 'Recovery adopted another installation scope'; fi
bad=$(jq '.quiescenceEffectsReviewed=false' <<< "$approval")
if native_backup_recover "$bad" > "$temporary/refused" 2>&1; then fail 'Recovery skipped explicit effect review'; fi
mkdir -p "$directory/backups/$archive"
if native_backup_recover "$approval" > "$temporary/refused" 2>&1; then fail 'Pre-capture recovery accepted an existing archive'; fi
rmdir "$directory/backups/$archive"
touch "$temporary/suite-down"
if native_backup_recover "$approval" > "$temporary/refused" 2>&1; then fail 'Recovery resumed with a stopped suite'; fi
rm "$temporary/suite-down"
original_fence=$(cat "$temporary/fence"); printf another-session > "$temporary/fence"
if native_backup_recover "$approval" > "$temporary/refused" 2>&1; then fail 'Recovery changed a foreign fence'; fi
[[ $(cat "$temporary/fence") == another-session ]] || fail 'Foreign fence changed during refusal'
printf '%s' "$original_fence" > "$temporary/fence"
cp "$directory/transaction.json" "$temporary/old-transaction.json"
jq '.phase="migration-started"' "$directory/transaction.json" > "$directory/tx-next"; mv "$directory/tx-next" "$directory/transaction.json"
if native_backup_recover "$approval" > "$temporary/refused" 2>&1; then fail 'Recovery adopted another failed operation phase'; fi
cp "$temporary/old-transaction.json" "$directory/transaction.json"
cp "$old_scope/state/journal.json" "$temporary/held-journal.json"
jq '.phase="restoring"' "$old_scope/state/journal.json" > "$old_scope/state/next"; mv "$old_scope/state/next" "$old_scope/state/journal.json"
bad=$(jq --arg sha "$(sha256sum "$old_scope/state/journal.json" | cut -d ' ' -f1)" '.journalSHA256=$sha' <<< "$approval")
if native_backup_recover "$bad" > "$temporary/refused" 2>&1; then fail 'Recovery replayed a journal from a different mutation phase'; fi
cp "$temporary/held-journal.json" "$old_scope/state/journal.json"
[[ $(grep -c '^product:recover-quiesce$' "$temporary/calls" || true) == "$recover_count" ]] || fail 'A recovery refusal mutated the product journal'
recovered=$(native_backup_recover "$approval")
jq -e '.recovered==true and .archiveCreated==false' <<< "$recovered" >/dev/null
[[ "$plan" != "$old_plan" && $(jq -er .phase "$old_meta") == released && ! -e "$temporary/fence" ]] || fail 'Recovery changed current controller scope or did not release the old exact session'
jq -e --arg plan "$old_plan" '.phase=="complete" and .plan==$plan and .nativeRecovery.recovered==true' "$directory/transaction.json" >/dev/null || fail 'Recovery did not close only the old failed transaction'
history="$old_scope/recovery-$(jq -er .journalSHA256 <<< "$approval")"
[[ $(sha256sum "$history/coordinator.before.json" | cut -d ' ' -f1) == "$(jq -er .coordinatorSHA256 <<< "$approval")" && $(sha256sum "$history/journal.before.json" | cut -d ' ' -f1) == "$(jq -er .journalSHA256 <<< "$approval")" ]] || fail 'Recovery did not retain exact failure evidence'
[[ ! -e "$directory/backups/$archive" && -f "$history/transaction.before.json" && -f "$history/product-recovery.json" ]] || fail 'Recovery claimed an archive or discarded its original transaction/receipt'
docker() {
  cat > "$temporary/coordinator-request"
  jq -nc '{schema:1,action:"release",verified:true,closed:false,nodeId:"node-one",nodeFqdn:"node-1.example.com",session:"00000000-0000-4000-8000-000000000000"}'
}
if real_native_backup_coordinator release "$(cat "$old_meta")" > "$temporary/refused" 2>&1; then fail 'A coordinator response for another session was accepted'; fi
printf '{"services":{"alpha":{},"beta":{}}}\n' > "$directory/compose.json"
printf '[{"Service":"alpha","State":"running","Health":"healthy"},{"Service":"beta","State":"running","Health":""}]\n' > "$temporary/compose-status.json"
docker() { cat "$temporary/compose-status.json"; }
real_native_backup_suite_serving || fail 'Healthy complete suite refused recovery preflight'
jq '.[1].State="exited"' "$temporary/compose-status.json" > "$temporary/next"; mv "$temporary/next" "$temporary/compose-status.json"
if real_native_backup_suite_serving; then fail 'Stopped suite service accepted for recovery'; fi
jq '.[1].State="running"|.[1].Service="foreign"' "$temporary/compose-status.json" > "$temporary/next"; mv "$temporary/next" "$temporary/next-status.json"; mv "$temporary/next-status.json" "$temporary/compose-status.json"
if real_native_backup_suite_serving; then fail 'Different suite membership accepted for recovery'; fi
input='{"origin":"https://console.example.com","placements":{"magnus":"control"},"console":{"nativeListeners":[{"component":"magnus","port":7443}]}}'
printf '%s\n' 'HOST_FQDN=node-1.example.com' 'CONTROL_API_URL=https://console.example.com:7443' > "$temporary/agent/.env"
native_backup_cli() { printf '{"state":"bound","nodeId":"node-one","origin":"enrollment-token"}\n'; }
binding=$(native_backup_binding "$temporary/agent")
jq -e '.nodeId=="node-one" and .nodeFqdn=="node-1.example.com"' <<< "$binding" >/dev/null || fail 'Custom console origin replaced canonical node FQDN'
printf '%s\n' 'HOST_FQDN=node-1.example.com' 'CONTROL_API_URL=https://another.example.com:7443' > "$temporary/agent/.env"
if native_backup_binding "$temporary/agent" > "$temporary/refused" 2>&1; then fail 'Unrelated Magnus endpoint adopted'; fi
printf '%s\n' 'HOST_FQDN=node-1.example.com' 'CONTROL_API_URL=https://console.example.com:7443' > "$temporary/agent/.env"
native_backup_cli() { printf '{"state":"unbound","nodeId":"node-one"}\n'; }
if native_backup_binding "$temporary/agent" > "$temporary/refused" 2>&1; then fail 'Unbound node adopted'; fi
# A known service needs privilege before protected-file absence can imply no profiles.
systemctl() { if [[ "$*" == *WorkingDirectory* ]]; then printf '%s/nonexistent-agent\n' "$temporary"; else printf 'loaded\n'; fi; }
native_backup_guard() { printf 'guard\n' >> "$temporary/guard-calls"; return 1; }
if real_native_backup_discover > "$temporary/refused" 2>&1; then fail 'Known installer root bypassed privilege through absent/inaccessible files'; fi
[[ -s "$temporary/guard-calls" ]] || fail 'Service discovery checked private absence before root guard'
mkdir "$temporary/inaccessible"; chmod 000 "$temporary/inaccessible"
if [[ $(id -u) != 0 ]] && native_backup_searchable_parent "$temporary/inaccessible/agent"; then fail 'Unsearchable parent treated as absent'; fi
chmod 700 "$temporary/inaccessible"
printf 'Passed: owned native discovery, large inventories, no-profile no-op, preflight/disk/overlap refusals, exact fence ordering, private bundles, stopped retries, archive/operation isolation, reconciliation, release cleanup, explicit old-session recovery, and foreign/unknown holds.\n'
