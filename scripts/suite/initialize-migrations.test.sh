#!/usr/bin/env bash
set -Eeuo pipefail
ROOT=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)
source "$ROOT/scripts/suite/initialize-migrations-host.sh"
temporary=$(mktemp -d)
trap 'rm -rf -- "$temporary"' EXIT
fail() { printf 'FAIL: %s\n' "$*" >&2; exit 1; }
reject() { if ( "$@" ) > "$temporary/rejection.log" 2>&1; then fail 'Unsafe initial migration was accepted'; fi; }
die() { printf 'Held: %s\n' "$*" >&2; exit 1; }
atomic_json() { local pending; pending=$(mktemp "$HIVE_MIGRATION_FIXTURE/atomic.XXXXXX"); jq . > "$pending"; chmod 600 "$pending"; mv -T -- "$pending" "$1"; }
directory=$temporary plan=$(printf '0%.0s' {1..64})
export HIVE_MIGRATION_FIXTURE=$temporary
mkdir "$temporary/bin"
cat > "$temporary/bin/docker" <<'DOCKER'
#!/usr/bin/env bash
set -Eeuo pipefail
[[ "$1 $2" == 'compose -f' ]]
file=$3; shift 3
if [[ "$1" == config ]]; then exit 0; fi
[[ "$1 $2 $3 $4" == 'run --no-deps --rm -T' ]]; export component=$5; shift 5
# Compose forwards non-TTY stdin too; a migrator must never consume the host
# controller loop that enumerates the remaining product migrations.
cat >/dev/null
committed="$HIVE_MIGRATION_FIXTURE/committed"; [[ "$component" == product ]] || committed+="-$component"
if (($#)); then
  printf 'applied\n' >> "$HIVE_MIGRATION_FIXTURE/applied"
  [[ ! -f "$HIVE_MIGRATION_FIXTURE/interruption-before-commit" ]] || exit 23
  touch "$committed"
  [[ ! -f "$HIVE_MIGRATION_FIXTURE/interruption-after-commit" ]] || exit 23
else
  [[ $(jq -r '.services[env.component].command[0]' "$file") == verify-current ]]
  [[ -e "$committed" ]] || exit 24
fi
DOCKER
chmod +x "$temporary/bin/docker"
export PATH="$temporary/bin:$PATH"
jq -n '{services:{product:{image:"example.com/app@sha256:'"$plan"'",command:["serve"],user:"1000:1000",read_only:true,cap_drop:["ALL"]}}}' > "$temporary/candidate.json"
jq -n '{components:{product:{initialization:{image:"example.com/migrator@sha256:'"$plan"'",command:["migrate"],verificationCommand:["verify-current"]}}}}' > "$temporary/manifest.$plan.json"
run_initialization() { hive_initialization_migrations "$temporary/candidate.json" "$temporary/candidate.json" "$temporary/receipt.json"; }
printf '{"phase":"started"}\n' > "$temporary/receipt.json"
touch "$temporary/interruption-after-commit"
reject run_initialization
jq -e '.initializations.product.phase=="claimed"' "$temporary/receipt.json" >/dev/null
rm "$temporary/interruption-after-commit"
run_initialization
[[ $(wc -l < "$temporary/applied") == 1 ]] || fail 'Claimed migration was replayed after verification'
jq -e '.initializations.product.phase=="verified"' "$temporary/receipt.json" >/dev/null
run_initialization
[[ $(wc -l < "$temporary/applied") == 1 ]] || fail 'Verified migration was replayed'
rm "$temporary/committed"
reject run_initialization
[[ $(wc -l < "$temporary/applied") == 1 ]] || fail 'An uncertain verified state was migrated again'
printf '{"phase":"started"}\n' > "$temporary/receipt.json"
touch "$temporary/interruption-before-commit"
reject run_initialization
rm "$temporary/interruption-before-commit"
reject run_initialization
[[ $(wc -l < "$temporary/applied") == 2 ]] || fail 'Unverified claimed migration was replayed'
touch "$temporary/committed"
run_initialization
jq '.initializations.product.specification.image="changed"' "$temporary/receipt.json" > "$temporary/changed.json"; mv "$temporary/changed.json" "$temporary/receipt.json"
reject run_initialization
[[ $(wc -l < "$temporary/applied") == 2 ]] || fail 'A changed journal triggered migration replay'
jq '.services.second=.services.product' "$temporary/candidate.json" > "$temporary/next.json"; mv "$temporary/next.json" "$temporary/candidate.json"
jq '.components.second=.components.product' "$temporary/manifest.$plan.json" > "$temporary/next.json"; mv "$temporary/next.json" "$temporary/manifest.$plan.json"
printf '{"phase":"started"}\n' > "$temporary/receipt.json"
run_initialization
jq -e '.initializations.product.phase=="verified" and .initializations.second.phase=="verified"' "$temporary/receipt.json" >/dev/null
[[ $(wc -l < "$temporary/applied") == 4 ]] || fail 'Migration stdin consumed a later product instead of executing every initial migration'
printf 'Passed: claimed initial migrations reconcile only through exact product verification, never replay unknown writes, retain protected diagnostics and reject changed journal specifications.\n'
