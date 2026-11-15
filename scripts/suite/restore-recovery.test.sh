#!/usr/bin/env bash
set -Eeuo pipefail
ROOT=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)
temporary=$(mktemp -d)
trap 'rm -rf -- "$temporary"' EXIT
fail() { printf 'FAIL: %s\n' "$*" >&2; exit 1; }
export FIXTURE_ROOT="$temporary" FIXTURE_CALLS="$temporary/calls"
mkdir -p "$temporary/bin" "$temporary/install"/{data,config,releases,backups/fixture,rehearsals/fixture} "$temporary/archive"/{data,config,releases,native-profiles/bundle} "$temporary/home" "$temporary/manager"
: > "$FIXTURE_CALLS"
cat > "$temporary/bin/docker" <<'DOCKER'
#!/usr/bin/env bash
set -euo pipefail
shift 3
case "$1" in
 ps) [[ ! -e "$FIXTURE_ROOT/running" ]] || printf 'fixture-container\n';;
 up) touch "$FIXTURE_ROOT/running"; printf 'suite-up\n' >> "$FIXTURE_CALLS";;
 *) exit 1;;
esac
DOCKER
chmod 700 "$temporary/bin/docker"
export PATH="$temporary/bin:$PATH"
source <(sed -n '/^tree_lines() {/,/^tree_digest()/p' "$ROOT/scripts/suite/host-runtime.sh")
sha() { sha256sum "$1" | cut -d ' ' -f1; }
put() { printf '%s\n' "$2" > "$1"; chmod 600 "$1"; }
directory="$temporary/install"
config_sha=$(printf 'configuration\n' | sha256sum | cut -d ' ' -f1)
old_controller=$(printf old-controller | sha256sum | cut -d ' ' -f1)
new_controller=$(printf new-controller | sha256sum | cut -d ' ' -f1)
put "$temporary/old-manifest.json" "$(jq -nc --arg controller "$old_controller" '{schema:1,version:"0.1.0",controllerSHA256:$controller,components:{probe:{}},profiles:{},networks:{}}')"
old_manifest=$(sha "$temporary/old-manifest.json")
semantic=$(jq -Sc 'del(.controllerSHA256,.version)' "$temporary/old-manifest.json" | sha256sum | cut -d ' ' -f1)
old_plan=$(printf '%s\n' "$config_sha" "$old_manifest" "$old_controller" | sha256sum | cut -d ' ' -f1)
new_plan=$(printf new-plan | sha256sum | cut -d ' ' -f1)
session=11111111-1111-4111-8111-111111111111
archived=22222222-2222-4222-8222-222222222222
target=$(printf target | sha256sum | cut -d ' ' -f1)
native=$(printf native-inventory | sha256sum | cut -d ' ' -f1)
restored_native=$(printf restored-inventory | sha256sum | cut -d ' ' -f1)
scope_hash=$(printf '%s\0%s\0%s' "$old_plan" restore fixture | sha256sum | cut -d ' ' -f1)
scope="$temporary/private/example-control/$old_plan/$scope_hash"
export FIXTURE_SCOPE="$scope" FIXTURE_NATIVE="$native" FIXTURE_RESTORED_NATIVE="$restored_native"
mkdir -p "$scope/state"
chmod 700 "$temporary/private" "$temporary/private/example-control" "$temporary/private/example-control/$old_plan" "$scope" "$scope/state"
put "$temporary/archive/data/value" 'archived suite data'
put "$directory/data/value" 'current suite data'
put "$temporary/archive/config/settings" 'fixture config'
cp -p "$temporary/archive/config/settings" "$directory/config/settings"
put "$temporary/archive/compose.json" '{"services":{"probe":{"image":"example.com/probe:1","volumes":[]}}}'
put "$temporary/archive/receipt.json" '{"version":"0.1.0"}'
put "$temporary/archive/installation.json" '{"installation":"example","host":"control","uuid":"fixture-uuid"}'
for file in compose.json receipt.json installation.json; do cp -p "$temporary/archive/$file" "$directory/$file"; done
put "$temporary/archive/native-profiles/bundle/manifest.json" "$(jq -nc --arg session "$archived" --arg target "$target" '{session:$session,targetSha256:$target}')"
bundle_sha=$(sha "$temporary/archive/native-profiles/bundle/manifest.json")
put "$temporary/archive/native-profiles/bundle/profile" 'archived native bytes'
put "$temporary/archive/native-profiles/coordinator.json" "$(jq -nc --arg session "$archived" --arg sha "$bundle_sha" --arg target "$target" '{schema:1,installation:"example",host:"control",nodeId:"node-a",nodeFqdn:"node.example.com",session:$session,manifestSHA256:$sha,targetSha256:$target,profiles:1}')"
tar -czf "$directory/backups/fixture/state.tar.gz" -C "$temporary/archive" data config releases compose.json receipt.json installation.json native-profiles
chmod 600 "$directory/backups/fixture/state.tar.gz"
archive_sha=$(sha "$directory/backups/fixture/state.tar.gz")
put "$directory/backups/fixture/receipt.json" "$(jq -nc --arg sha "$archive_sha" --arg data "$(tree_digest "$temporary/archive/data")" --arg config "$(tree_digest "$directory/config")" '{schema:1,uuid:"fixture-uuid",installation:"example",host:"control",verified:true,sha256:$sha,dataSHA256:$data,configSHA256:$config}')"
put "$directory/rehearsals/fixture/result.json" "$(jq -nc --arg sha "$archive_sha" '{result:"passed",isolated:true,portsPublished:false,archiveSHA256:$sha}')"
put "$directory/transaction.json" "$(jq -nc --arg plan "$old_plan" '{schema:1,plan:$plan,operation:"restore",version:"0.1.0",phase:"recovery-required"}')"
cp -p "$temporary/old-manifest.json" "$directory/manifest.$old_plan.json"
current=$(tree_digest "$directory/data")
put "$directory/reconciliation.$old_plan.json" "$(jq -nc --arg archive "$archive_sha" --arg current "$current" --arg native "$native" --arg bundle "$bundle_sha" '{hosts:{control:{installationUUID:"fixture-uuid",archiveSHA256:$archive,subsequentWritesReconciled:true,currentDataSHA256:$current,nativeProfiles:{archiveManifestSHA256:$bundle,currentInventorySHA256:$native}}}}')"
put "$scope/coordinator.json" "$(jq -nc --arg plan "$old_plan" --arg root "$temporary/manager" --arg session "$session" --arg target "$target" --arg native "$native" '{schema:1,installation:"example",host:"control",plan:$plan,operation:"restore",archive:"fixture",session:$session,fenceSession:$session,nodeId:"node-a",nodeFqdn:"node.example.com",root:$root,targetSha256:$target,stoppedInventorySHA256:$native,phase:"quiesced"}')"
put "$scope/state/journal.json" "$(jq -nc --arg session "$session" --arg target "$target" --arg native "$native" '{session:$session,targetSha256:$target,phase:"stopped",stoppedInventorySha256:$native,manifestSHA256:null,restoredInventorySha256:null,promotions:[]}')"
put "$temporary/manager/.native-snapshot-reservation.json" "$(jq -nc --arg session "$session" --arg target "$target" --arg state "$scope/state" '{session:$session,targetSha256:$target,state:$state}')"
for action in reserve verify; do put "$scope/$action.json" "$(jq -nc --arg session "$session" --arg action "$action" '{schema:1,action:$action,verified:true,closed:true,nodeId:"node-a",nodeFqdn:"node.example.com",session:$session}')"; done
put "$temporary/inventory.json" "$(jq -nc --arg sha "$native" --arg root "$temporary/home/.ardent" --arg install "$temporary/home/runtime" --arg home "$temporary/home" '{inventorySha256:$sha,target:{root:$root,install:$install,home:$home},agent:{active:false,clean:true,cgroupEmpty:true},profiles:[],safety:{active:0,unknown:0,unsupported:0}}')"
mkdir -m 700 "$directory/restore.$old_plan"
tar -xzf "$directory/backups/fixture/state.tar.gz" -C "$directory/restore.$old_plan"
approval=$(jq -nc --arg scope "$scope" --arg tx "$(sha "$directory/transaction.json")" --arg coordinator "$(sha "$scope/coordinator.json")" --arg journal "$(sha "$scope/state/journal.json")" --arg reconciliation "$(sha "$directory/reconciliation.$old_plan.json")" --arg archive "$archive_sha" --arg receipt "$(sha "$directory/backups/fixture/receipt.json")" --arg rehearsal "$(sha "$directory/rehearsals/fixture/result.json")" --arg stage "$(tree_digest "$directory/restore.$old_plan")" --arg current "$current" --arg native "$native" --arg config "$config_sha" --arg manifest "$old_manifest" --arg controller "$old_controller" '{sessionDirectory:$scope,prePromotionRestoreReviewed:true,transactionSHA256:$tx,coordinatorSHA256:$coordinator,journalSHA256:$journal,reconciliationSHA256:$reconciliation,archiveSHA256:$archive,archiveReceiptSHA256:$receipt,rehearsalSHA256:$rehearsal,stagedTreeSHA256:$stage,currentDataSHA256:$current,expectedCurrentInventorySHA256:$native,configurationSHA256:$config,manifestSHA256:$manifest,oldControllerSourceSHA256:$controller}')
script=''
for file in ownership-host.sh adapters-host.sh native-backup-host.sh restore-recovery-host.sh; do script+=$(cat "$ROOT/scripts/suite/$file")$'\n'; done
script+=$(cat <<'PRODUCT'
native_backup_guard() { return 0; }
native_backup_storage_root() { printf '%s/private\n' "$FIXTURE_ROOT"; }
native_backup_verify() { jq '{verified:true,manifestSHA256,targetSha256,session,nodeId,nodeFqdn}' "$1/coordinator.json"; }
native_backup_product() {
  local action=$1 request=$2 state source
  case "$action" in
    inspect) cat "$FIXTURE_ROOT/inventory.json";;
    verify) source=$(jq -er .source <<< "$request"); jq --arg sha "$(sha256sum "$source/manifest.json" | cut -d ' ' -f1)" '{manifestSHA256:$sha,targetSha256,profiles:["lead"]}' "$source/manifest.json";;
    restore)
      state=$(jq -er .state <<< "$request"); [[ "$state" == "$FIXTURE_SCOPE/state" ]] || return 1
      printf 'native-restore:%s\n' "$plan" >> "$FIXTURE_CALLS"
      source=$(jq -er .source <<< "$request")
      jq --arg inventory "$FIXTURE_RESTORED_NATIVE" --arg sha "$(sha256sum "$source/manifest.json" | cut -d ' ' -f1)" '.phase="restored"|.manifestSHA256=$sha|.restoredInventorySha256=$inventory|.promotions=[{phase:"promoted"}]' "$state/journal.json" > "$state/next"
      mv "$state/next" "$state/journal.json"; chmod 600 "$state/journal.json"
      jq --arg sha "$FIXTURE_RESTORED_NATIVE" '.inventorySha256=$sha' "$FIXTURE_ROOT/inventory.json" > "$FIXTURE_ROOT/inventory.next"; mv "$FIXTURE_ROOT/inventory.next" "$FIXTURE_ROOT/inventory.json"
      jq --arg sha "$(sha256sum "$source/manifest.json" | cut -d ' ' -f1)" -n '{restored:true,manifestSHA256:$sha}' ;;
    resume)
      [[ $(jq -er .state <<< "$request") == "$FIXTURE_SCOPE/state" ]] || return 1
      printf 'native-resume:%s\n' "$plan" >> "$FIXTURE_CALLS"
      jq '.phase="resumed"' "$FIXTURE_SCOPE/state/journal.json" > "$FIXTURE_SCOPE/state/next"; mv "$FIXTURE_SCOPE/state/next" "$FIXTURE_SCOPE/state/journal.json"; chmod 600 "$FIXTURE_SCOPE/state/journal.json"
      rm -- "$FIXTURE_ROOT/manager/.native-snapshot-reservation.json"
      printf '{"resumed":true}\n';;
    *) return 1;;
  esac
}
native_backup_coordinator() {
  [[ -f "$FIXTURE_ROOT/running" ]] || { printf 'coordinator called before suite startup\n' >&2; return 1; }
  printf 'coordinator-%s:%s:%s\n' "$1" "$plan" "$(jq -er .fenceSession <<< "$2")" >> "$FIXTURE_CALLS"
  jq -nc --arg action "$1" --argjson meta "$2" '{schema:1,action:$action,verified:true,closed:($action!="release"),nodeId:$meta.nodeId,nodeFqdn:$meta.nodeFqdn,session:$meta.fenceSession}'
}
PRODUCT
)
script+=$'\n'; script+=$(cat "$ROOT/scripts/suite/host-runtime.sh")
printf '%s\n' "$script" > "$temporary/host.sh"
chmod 700 "$temporary/host.sh"
run() {
  jq -nc --arg action "$1" --arg directory "$directory" --arg plan "$new_plan" --arg source "$new_controller" --arg config "$config_sha" --arg semantic "$semantic" --argjson approval "${2:-$approval}" '{directory:$directory,installation:"example",host:"control",plan:$plan,action:$action,operation:"restore",version:"0.1.0",digest:("f"*64),controllerSourceSHA256:$source,archive:"fixture",agents:[],inference:[],nativeRecovery:$approval,nativeRecoveryConfigurationSHA256:$config,nativeRecoveryManifestSemanticSHA256:$semantic}' |
    env -u NATIVE_BACKUP_SESSION -u NATIVE_BACKUP_BASE -u NATIVE_BACKUP_META -u RESTORE_RECOVERY_OLD_PLAN bash "$temporary/host.sh" > "$temporary/result" 2> "$temporary/error"
}
run restore-recovery-check || { cat "$temporary/error" >&2; fail 'Valid pre-promotion continuation refused'; }
for field in transactionSHA256 coordinatorSHA256 journalSHA256 reconciliationSHA256 archiveSHA256 archiveReceiptSHA256 rehearsalSHA256 stagedTreeSHA256 currentDataSHA256 expectedCurrentInventorySHA256 configurationSHA256 manifestSHA256 oldControllerSourceSHA256; do
  bad=$(jq --arg field "$field" '.[$field]=("0"*64)' <<< "$approval")
  if run restore-recovery-check "$bad"; then fail "Changed $field accepted"; fi
done
put "$directory/data/value" changed
if run restore-recovery-check; then fail 'Current data changed after approval'; fi
put "$directory/data/value" 'current suite data'
put "$directory/restore.$old_plan/native-profiles/bundle/profile" changed
if run restore-recovery-check; then fail 'Changed staged bytes accepted'; fi
put "$directory/restore.$old_plan/native-profiles/bundle/profile" 'archived native bytes'
cp -p "$scope/state/journal.json" "$temporary/journal.original"
jq '.promotions=[{phase:"prepared"}]' "$scope/state/journal.json" > "$scope/state/next"; mv "$scope/state/next" "$scope/state/journal.json"; chmod 600 "$scope/state/journal.json"
bad=$(jq --arg sha "$(sha "$scope/state/journal.json")" '.journalSHA256=$sha' <<< "$approval")
if run restore-recovery-check "$bad"; then fail 'Even explicitly hashed partial promotion must refuse'; fi
cp -p "$temporary/journal.original" "$scope/state/journal.json"
[[ ! -e "$scope/restore-source" && $(cat "$directory/data/value") == 'current suite data' ]] || fail 'Preflight changed held state'
run restore-recovery-apply || { cat "$temporary/error" >&2; fail 'Normal restore continuation failed'; }
history="$scope/restore-continuation.$new_plan"
[[ $(cat "$history/failed-stage/native-profiles/bundle/profile") == 'archived native bytes' && $(cat "$directory/data/value") == 'archived suite data' ]] || fail 'Failed stage or restored data missing'
[[ $(jq -r .phase "$history/delegation.json") == restored && $(jq -r .phase "$directory/transaction.json") == restored ]] || fail 'Restore continuation did not retain the old transaction lineage'
run restore-recovery-resume || { cat "$temporary/error" >&2; fail 'Fresh-process delegated normal resume failed'; }
grep -qxF "native-restore:$old_plan" "$FIXTURE_CALLS" || fail 'Restore used the new plan'
grep -qxF "native-resume:$old_plan" "$FIXTURE_CALLS" || fail 'Fresh resume lost its old plan'
grep -qxF "coordinator-release:$old_plan:$archived" "$FIXTURE_CALLS" || fail 'Resume did not release the archived fence'
[[ $(jq -r .phase "$history/delegation.json") == complete && $(jq -r .phase "$directory/transaction.json") == complete && $(jq -r .phase "$scope/coordinator.json") == released ]] || fail 'Continuation did not finish its exact held state'
printf 'Passed: strict pre-promotion restore continuation pins, tamper/partial-promotion refusal, retained failed stage, fresh normal restore/resume under old plan and exact archived-fence release.\n'
