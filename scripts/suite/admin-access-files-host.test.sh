#!/usr/bin/env bash
set -Eeuo pipefail
umask 077
ROOT=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)
source "$ROOT/scripts/suite/admin-access-files-host.sh"
source "$ROOT/scripts/suite/input-artifacts-host.sh"
temporary=$(mktemp -d)
trap 'rm -rf -- "$temporary"' EXIT
fail() { printf 'FAIL: %s\n' "$*" >&2; exit 1; }
die() { fail "$*"; }

# Ordinary CI runs cannot chown fixtures to root. Model only the privileged identity
# and root ownership of the journal; content, metadata, links, renames and fsyncs are real.
# The same suite also runs unchanged as actual root in the isolated recovery host.
if [[ $(command id -u) != 0 ]]; then
  id() { if [[ ${1:-} == -u ]]; then printf '0\n'; else command id "$@"; fi; }
  stat() {
    local path=${*: -1}
    if [[ "$*" == '-c %u -- '* && "$path" == "$temporary/"*'/config/.admin-access'* ]]; then
      if [[ ${foreign_journal_path:-} == "$path" ]]; then printf '65534\n'; else printf '0\n'; fi
    else command stat "$@"; fi
  }
fi

fixture() {
  local name=$1 files sha
  directory="$temporary/$name"; config="$directory/config"; compose="$directory/compose.json"
  mkdir -m 700 -p "$config/.initializer" "$config/product" "$config/.admin-access/account"
  printf '# untouched comment\nUNCHANGED=literal-value\nSELECTED=\x27original\x27\n\n' > "$config/product.env"
  printf 'OTHER=fixture-value\n' > "$config/other.env"
  printf 'private fixture key\n' > "$config/product/key"
  printf 'unchanged bootstrap secret\n' > "$config/.initializer/seed"
  printf 'public runtime\n' > "$config/runtime.json"; chmod 644 "$config/runtime.json"
  jq -n --arg root "$directory" '{services:{product:{env_file:[($root+"/config/product.env")],volumes:[{source:($root+"/config/product"),read_only:true}]},other:{env_file:[{path:($root+"/config/other.env"),required:true}],volumes:[{source:($root+"/config/runtime.json"),read_only:true}]}}}' > "$compose"
  printf '{"schema":1,"installation":"fixture","host":"control"}\n' > "$directory/installation.json"
  printf '{"schema":1,"phase":"complete","operation":"install"}\n' > "$directory/transaction.json"
  files=$(for path in "$config/product.env" "$config/other.env" "$config/product/key" "$config/runtime.json" "$config/.initializer/seed"; do jq -nc --arg path "$path" --arg sha "$(admin_access_files_sha "$path")" '{key:$path,value:$sha}'; done | jq -s from_entries)
  jq -n --argjson files "$files" '{schema:1,installation:"fixture",host:"control",inputsSHA256:"original-initializer-input",phase:"complete",files:$files}' > "$config/.initializer/receipt.json"
  plan=$(printf 'a%.0s' {1..64})
  sha=$(deployment_inputs_digest "$compose")
  jq -n --arg sha "$sha" '{schema:1,sha256:$sha}' > "$directory/deployment-inputs.$plan.json"
  jq -n --arg plan "$plan" --arg sha "$sha" '{schema:1,plan:$plan,digest:"unchanged-manifest-digest",version:"1.0.0",deploymentInputSHA256:$sha}' > "$directory/receipt.json"
  journal="$config/.admin-access/account/publication"
  updates=$(jq -nc --arg path "$config/product.env" '{($path):{SELECTED:"new value",ADDED:"new key"}}')
}
verify_pins() {
  local sha
  sha=$(deployment_inputs_digest "$compose")
  [[ "$sha" == "$(admin_access_files_inputs_digest)" && "$sha" == "$(jq -r .sha256 "$directory/deployment-inputs.$plan.json")" && "$sha" == "$(jq -r .deploymentInputSHA256 "$directory/receipt.json")" ]] || fail 'Deployment inputs did not retain the canonical digest contract'
  while IFS=$'\t' read -r path sha; do [[ $(admin_access_files_sha "$path") == "$sha" ]] || fail 'Initializer did not fingerprint the published artifact'; done < <(jq -r '.files|to_entries[]|[.key,.value]|@tsv' "$config/.initializer/receipt.json")
}
must_refuse() { if "$@" > "$temporary/refusal.log" 2>&1; then fail 'An unsafe publication was accepted'; fi; }

fixture normal
[[ -z $(admin_access_env_value "$config/product.env" OPTIONAL_NEW_KEY) ]] || fail 'An absent optional key must read as empty'
original_meta=$(stat -c '%u:%g:%a' "$config/product.env")
key_sha=$(admin_access_files_sha "$config/product/key")
admin_access_publish "$updates" "$journal" > "$temporary/result.json"
[[ $(admin_access_env_value "$config/product.env" SELECTED) == 'new value' && $(admin_access_env_value "$config/product.env" ADDED) == 'new key' ]] || fail 'Environment values were not updated'
[[ $(stat -c '%u:%g:%a' "$config/product.env") == "$original_meta" ]] || fail 'Environment ownership or mode changed'
[[ $(admin_access_files_sha "$config/product/key") == "$key_sha" ]] || fail 'Unrelated mounted credentials changed'
grep -q '^# untouched comment$' "$config/product.env" && grep -q '^UNCHANGED=literal-value$' "$config/product.env" || fail 'Unselected bytes changed'
[[ $(tail -c 2 "$journal/before/0" | od -An -t x1 | tr -d ' \n') == 0a0a ]] || fail 'Fixture lost its original trailing whitespace'
verify_pins
before=$(find "$directory" -type f -printf '%p %T@\n' | sort)
admin_access_publish '{}' "$journal" >/dev/null; admin_access_recover "$journal" >/dev/null
[[ $(find "$directory" -type f -printf '%p %T@\n' | sort) == "$before" ]] || fail 'A completed publication wrote files again'

fixture quotes
value=$'apostrophe\x27 dollar$USER literal$(command) double" slash\\ newline\nlast'
updates=$(jq -nc --arg path "$config/product.env" --arg value "$value" '{($path):{SELECTED:$value}}')
admin_access_publish "$updates" "$journal" >/dev/null
[[ $(admin_access_env_value "$config/product.env" SELECTED) == "$value" ]] || fail 'JSON/Compose quote codec did not round-trip'
grep -qF '$$USER' "$config/product.env" || fail 'Compose interpolation was not escaped'
[[ $(admin_access_env_value "$journal/before/0" SELECTED) == original ]] || fail 'Single-quoted parser failed'
verify_pins
if command -v docker >/dev/null && docker compose version >/dev/null 2>&1; then
  jq '.services|=with_entries(.value.image="example.com/fixture:local"|.value.volumes|=map(.target="/config"|.type="bind"))' "$compose" > "$temporary/codec-compose.json"
  docker compose -f "$temporary/codec-compose.json" config --format json > "$temporary/codec-result.json"
  # Compose escapes dollar signs again when serializing a reusable configuration.
  jq -e --arg value "$value" '(.services.product.environment.SELECTED|gsub("\\$\\$";"$"))==$value' "$temporary/codec-result.json" >/dev/null || fail 'Compose did not preserve the exact quoted value'
fi

for phase in prepared environment initializer pin receipt; do
  fixture "crash-$phase"
  admin_access_files_checkpoint() { [[ $1 != "$phase" ]] || return 73; }
  must_refuse admin_access_publish "$updates" "$journal"
  [[ $(jq -r .phase "$journal/state.json") == prepared ]] || fail 'Interrupted publication lost its retained intent'
  admin_access_files_checkpoint() { :; }
  admin_access_recover "$journal" >/dev/null
  [[ $(admin_access_env_value "$config/product.env" SELECTED) == 'new value' ]] || fail 'Recovery did not finish the exact intent'
  verify_pins
done

fixture drift-before
printf 'unreviewed drift\n' >> "$config/other.env"
original=$(admin_access_files_sha "$config/product.env")
must_refuse admin_access_publish "$updates" "$journal"
[[ $(admin_access_files_sha "$config/product.env") == "$original" && ! -e "$journal" ]] || fail 'A refused preflight changed configuration'

fixture prepare-race
admin_access_files_checkpoint() { if [[ $1 == staged ]]; then printf 'concurrent unrelated change\n' >> "$config/.initializer/seed"; fi; }
original=$(admin_access_files_sha "$config/product.env")
must_refuse admin_access_publish "$updates" "$journal"
[[ $(admin_access_files_sha "$config/product.env") == "$original" && ! -e "$journal" ]] || fail 'A race during preparation rebased unrelated configuration'
admin_access_files_checkpoint() { :; }

fixture failed-enumeration
find() { if [[ $1 == "$config/product" ]]; then return 39; fi; command find "$@"; }
must_refuse admin_access_files_inventory
must_refuse admin_access_files_inputs_digest
unset -f find

fixture failed-hash
sha256sum() { if [[ ${*: -1} == "$config/product/key" ]]; then return 39; fi; command sha256sum "$@"; }
must_refuse admin_access_files_inputs_digest
must_refuse admin_access_publish "$updates" "$journal"
unset -f sha256sum

for drift in bytes mode added missing target compose; do
  fixture "drift-$drift"
  admin_access_files_checkpoint() { [[ $1 != environment ]] || return 73; }
  must_refuse admin_access_publish "$updates" "$journal"
  admin_access_files_checkpoint() { :; }
  case $drift in
    bytes) printf changed >> "$config/product/key";;
    mode) chmod 640 "$config/product/key";;
    added) printf unexpected > "$config/product/new-input";;
    missing) rm "$config/product/key";;
    target) printf 'SELECTED=unreviewed\n' > "$config/product.env";;
    compose) printf ' ' >> "$compose";;
  esac
  state=$(admin_access_files_sha "$journal/state.json")
  must_refuse admin_access_recover "$journal"
  [[ $(admin_access_files_sha "$journal/state.json") == "$state" ]] || fail 'Drift rewrote the retained journal'
done

fixture late-closed
admin_access_files_checkpoint() { [[ $1 != environment ]] || return 73; }
must_refuse admin_access_publish "$updates" "$journal"
admin_access_files_checkpoint() { :; }
printf '{"schema":1,"phase":"quiesced"}\n' > "$directory/transaction.json"
must_refuse admin_access_recover "$journal"

fixture links
ln "$config/product.env" "$config/alias.env"
must_refuse admin_access_publish "$updates" "$journal"
rm "$config/alias.env"; mv "$config/product.env" "$config/real.env"; ln -s real.env "$config/product.env"
must_refuse admin_access_env_value "$config/product.env" SELECTED
must_refuse admin_access_publish "$updates" "$journal"

fixture journal-link
ln -s "$config/product" "$journal"
must_refuse admin_access_publish "$updates" "$journal"
must_refuse admin_access_recover "$journal"

fixture duplicate
printf 'SELECTED=second\n' >> "$config/product.env"
must_refuse admin_access_env_value "$config/product.env" SELECTED
admin_access_files_render "$config/product.env" <(printf '{"OTHER":"new"}') >/dev/null || fail 'An unrelated duplicate should remain untouched'
must_refuse admin_access_files_render "$config/product.env" <(printf '{"SELECTED":"new"}')

fixture later-authorized
admin_access_publish "$updates" "$journal" >/dev/null
second="$config/.admin-access/account/second-publication"
next_updates=$(jq -nc --arg path "$config/product.env" '{($path):{SELECTED:"later authorized value"}}')
admin_access_publish "$next_updates" "$second" >/dev/null
admin_access_recover "$journal" >/dev/null
admin_access_publish '{}' "$journal" >/dev/null
[[ $(admin_access_env_value "$config/product.env" SELECTED) == 'later authorized value' ]] || fail 'Completed recovery reverted a later authorized change'
must_refuse admin_access_publish "$next_updates" "$journal"
verify_pins

fixture empty
admin_access_publish '{}' "$journal" | jq -e '.changedFiles==[] and .phase=="unchanged"' >/dev/null
[[ ! -e "$journal" ]] || fail 'An empty publication created a journal'
admin_access_recover "$journal" | jq -e '.changedFiles==[] and .phase=="absent"' >/dev/null

fixture root-guard
if [[ $(command id -u) != 0 ]]; then
  (unset -f id; must_refuse admin_access_publish "$updates" "$journal")
  admin_access_publish "$updates" "$journal" >/dev/null
  foreign_journal_path="$journal/state.json"
  must_refuse admin_access_recover "$journal"
else
  admin_access_publish "$updates" "$journal" >/dev/null
  chown 65534:65534 "$journal/state.json"
  must_refuse admin_access_recover "$journal"
fi
printf 'Passed: environment quote codec, exact canonical pins, crash recovery at every publication boundary, unrelated drift refusal, protected paths, ownership and completed idempotency.\n'
