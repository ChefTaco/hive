#!/usr/bin/env bash
# Restore approval is built from held state, never an implicit acknowledgement.
set -Eeuo pipefail
ROOT=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)
temporary=$(mktemp -d)
trap 'rm -rf -- "$temporary"' EXIT
fail() { printf 'FAIL: %s\n' "$*" >&2; exit 1; }
directory="$temporary/install"
mkdir -p "$directory"/{data,config,releases,backups/example,rehearsals/example} "$temporary/bin"
printf 'original suite state\n' > "$directory/data/state"
printf '{"services":{}}\n' > "$directory/compose.json"
printf '{"installation":"example","host":"control","uuid":"fixture-uuid"}\n' > "$directory/installation.json"
printf '{"version":"0.1.0"}\n' > "$directory/receipt.json"
plan=$(printf '%064d' 1)
jq -nc --arg plan "$plan" '{schema:1,plan:$plan,operation:"restore",phase:"quiesced"}' > "$directory/transaction.json"
cat > "$temporary/bin/docker" <<'DOCKER'
#!/usr/bin/env bash
printf '%s\n' "$*" >> "$STUB_CALLS"
[[ "${STUB_RUNNING:-false}" != true ]] || printf 'fixture-running-container\n'
DOCKER
chmod 700 "$temporary/bin/docker"
export PATH="$temporary/bin:$PATH" STUB_CALLS="$temporary/calls"
source <(sed -n '/^tree_lines() {/,/^tree_digest()/p' "$ROOT/scripts/suite/host-runtime.sh")
archive() {
  local members=(data config releases compose.json receipt.json installation.json)
  [[ ! -d "$directory/native-profiles" ]] || members+=(native-profiles)
  tar -czf "$directory/backups/example/state.tar.gz" -C "$directory" -- "${members[@]}"
  local sha; sha=$(sha256sum "$directory/backups/example/state.tar.gz" | cut -d ' ' -f1)
  jq -nc --arg sha "$sha" '{schema:1,uuid:"fixture-uuid",installation:"example",host:"control",verified:true,sha256:$sha}' > "$directory/backups/example/receipt.json"
  jq -nc --arg sha "$sha" '{result:"passed",isolated:true,archiveSHA256:$sha}' > "$directory/rehearsals/example/result.json"
}
script=$(cat <<'NATIVE'
native_backup_discover() {
  [[ "${STUB_DISCOVERY_FAIL:-false}" != true ]] || return 1
  jq -nc --argjson present "${STUB_HAS_NATIVE:-false}" '{present:$present}'
}
native_backup_verify() {
  printf 'native-verify\n' >> "$STUB_CALLS"
  [[ $(cat "$1/bundle/state") == 'fixture profile state' ]] || return 1
  printf '{"verified":true,"manifestSHA256":"%064d","profiles":1}\n' 2
}
native_backup_reconciliation() {
  printf 'native-reconciliation\n' >> "$STUB_CALLS"
  jq -nc --arg manifest "$1" --arg current "$(printf '%064d' 3)" '{archiveManifestSHA256:$manifest,currentInventorySHA256:$current}'
}
NATIVE
)
script+=$'\n'
for file in ownership-host.sh integrity-host.sh adapters-host.sh host-runtime.sh; do script+=$(cat "$ROOT/scripts/suite/$file")$'\n'; done
run() {
  : > "$STUB_CALLS"
  jq -nc --arg directory "$directory" --arg plan "$plan" --arg action "$1" \
    '{directory:$directory,installation:"example",host:"control",plan:$plan,action:$action,operation:"restore",version:"0.1.0",archive:"example",agents:[],inference:[]}' |
    bash <(printf '%s\n' "$script") > "$temporary/result" 2> "$temporary/error"
}
archive
before=$(tree_digest "$directory/data")
run restore-preview-check || fail 'An old rehearsed archive failed preview validation'
run restore-preview || { cat "$temporary/error" >&2; fail 'An old archive could not produce a held-state template'; }
jq -e --arg data "$before" '.hosts.control | .currentDataSHA256==$data and .subsequentWritesReconciled==false and .installationUUID=="fixture-uuid" and (has("nativeProfiles")|not)' "$temporary/result" >/dev/null || fail 'Preview approved writes or omitted exact current data'
[[ $(tree_digest "$directory/data") == "$before" ]] || fail 'Preview replaced live data'
! grep -Eq 'up|start|restart' "$STUB_CALLS" || fail 'Preview activated services'
if STUB_HAS_NATIVE=true run restore-preview-check; then fail 'A suite-only archive could orphan current native profiles'; fi
grep -q 'predates native profile capture' "$temporary/error" || fail 'Missing historical native coverage was not explained'
if STUB_DISCOVERY_FAIL=true run restore-preview-check; then fail 'Unknown current native coverage was treated as empty'; fi
[[ $(tree_digest "$directory/data") == "$before" ]] || fail 'A refused old archive changed current data'

mkdir -p "$directory/native-profiles/bundle"
printf 'fixture profile state\n' > "$directory/native-profiles/bundle/state"
archive
run restore-preview-check || { cat "$temporary/error"; fail 'Native bundle verification was omitted or failed'; }
grep -qx native-verify "$STUB_CALLS" || fail 'Native bundle was not checked before restore preparation'
run restore-preview || fail 'Native preview failed'
jq -e '.hosts.control.nativeProfiles | .archiveManifestSHA256==("0"*63+"2") and .currentInventorySHA256==("0"*63+"3")' "$temporary/result" >/dev/null || fail 'Native approval does not bind the exact bundle and held inventory'
[[ $(tree_digest "$directory/data") == "$before" ]] || fail 'Native preview replaced suite data'

printf 'corrupted profile state\n' > "$directory/native-profiles/bundle/state"
archive
if run restore-preview-check; then fail 'A correctly outer-checksummed but corrupt native bundle was accepted'; fi
grep -q 'Native profile archive verification failed' "$temporary/error" || fail 'Native verification refusal was hidden'
[[ $(tree_digest "$directory/data") == "$before" ]] || fail 'Corrupt native bundle changed suite data'
if STUB_RUNNING=true run restore-preview; then fail 'Preview accepted a running suite'; fi
grep -q 'All installation containers must be stopped' "$temporary/error" || fail 'Preview did not require held services'
printf 'Passed: restore preview verifies native bundles before preparation, binds held inventories, never approves writes or replaces data, and refuses running services.\n'
