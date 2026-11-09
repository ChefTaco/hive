#!/usr/bin/env bash
set -Eeuo pipefail
ROOT=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)
source "$ROOT/scripts/suite/initialize-migrations-host.sh"
temporary=$(mktemp -d)
trap 'rm -rf -- "$temporary"' EXIT
fail() { printf 'FAIL: %s\n' "$*" >&2; exit 1; }
reject() { if ( "$@" ) > "$temporary/rejection.log" 2>&1; then fail 'Unsafe initial migration was accepted'; fi; }
die() { printf 'Held: %s\n' "$*" >&2; exit 1; }
atomic_json() { [[ ! -f "$HIVE_MIGRATION_FIXTURE/journal-failure" ]] || return 1; local pending; pending=$(mktemp "$HIVE_MIGRATION_FIXTURE/atomic.XXXXXX"); jq . > "$pending"; chmod 600 "$pending"; mv -T -- "$pending" "$1"; }
directory=$temporary plan=$(printf '0%.0s' {1..64})
export HIVE_MIGRATION_FIXTURE=$temporary
mkdir "$temporary/bin"
cat > "$temporary/bin/docker" <<'DOCKER'
#!/usr/bin/env bash
set -Eeuo pipefail
[[ "$1 $2" == 'compose -f' ]]
file=$3; shift 3
if [[ "$1" == config ]]; then exit 0; fi
if [[ "$1" == up ]]; then
  printf '%s\n' "$*" >> "$HIVE_MIGRATION_FIXTURE/started"
  [[ "${@: -1}" == database ]]
  jq -e 'all(.services[]; (has("ports")|not) and .environment.MAGNUS_AUTO_MIGRATE=="false" and .environment.SECURITY_INGEST_ENABLED=="false")' "$file" >/dev/null
  exit
fi
if [[ "$1" == stop ]]; then exit 0; fi
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
# Upgrade checks do not repeat an already-current migration, and consent is required
# before a pending product schema is claimed or applied.
printf '{"phase":"started"}\n' > "$temporary/receipt.json"
count=$(wc -l < "$temporary/applied")
hive_initialization_migrations "$temporary/candidate.json" "$temporary/candidate.json" "$temporary/receipt.json" verify-first false
[[ $(wc -l < "$temporary/applied") == "$count" ]] || fail 'A current upgrade schema was migrated again'
rm "$temporary/committed"; printf '{"phase":"started"}\n' > "$temporary/receipt.json"
reject hive_initialization_migrations "$temporary/candidate.json" "$temporary/candidate.json" "$temporary/receipt.json" verify-first false
[[ $(wc -l < "$temporary/applied") == "$count" ]] || fail 'Pending schema ran without approval'
jq -e '.initializations.product==null' "$temporary/receipt.json" >/dev/null || fail 'Unapproved migration was claimed'
touch "$temporary/journal-failure"
reject hive_initialization_migrations "$temporary/candidate.json" "$temporary/candidate.json" "$temporary/receipt.json" verify-first true
[[ $(wc -l < "$temporary/applied") == "$count" ]] || fail 'Migration ran after its durable claim failed'
rm "$temporary/journal-failure"
hive_initialization_migrations "$temporary/candidate.json" "$temporary/candidate.json" "$temporary/receipt.json" verify-first true
[[ $(wc -l < "$temporary/applied") == $((count+1)) ]] || fail 'Approved pending schema did not run once'

# Missing schema consent is rejected by read-only verification before any shutdown.
count=$(wc -l < "$temporary/applied")
hive_schema_upgrade_preflight "$temporary/candidate.json" "$temporary/manifest.$plan.json"
rm "$temporary/committed"
reject hive_schema_upgrade_preflight "$temporary/candidate.json" "$temporary/manifest.$plan.json"
[[ $(wc -l < "$temporary/applied") == "$count" ]] || fail 'Schema preflight mutated product data'
touch "$temporary/committed"

# The upgrade orchestration starts private datastores only, verifies current schemas,
# and holds a changed specification or a lost completion without replay.
prepare_data_directories() { [[ -f "$1" ]]; }
jq '.services.database={image:"example.com/database@sha256:'"$plan"'",user:"1000:1000"} | .services.product.ports=["1234:9000"]' "$temporary/candidate.json" > "$temporary/next.json"; mv "$temporary/next.json" "$temporary/candidate.json"
jq '.components.database={kind:"datastore"}' "$temporary/manifest.$plan.json" > "$temporary/next.json"; mv "$temporary/next.json" "$temporary/manifest.$plan.json"
count=$(wc -l < "$temporary/applied")
hive_upgrade_schema_migrations "$temporary/candidate.json" "$temporary/manifest.$plan.json" "$temporary" false
jq -e '.phase=="ready" and .initializations.product.phase=="verified"' "$temporary/schema-upgrade.$plan.json" >/dev/null
[[ $(wc -l < "$temporary/applied") == "$count" ]] || fail 'Current upgrade schema was replayed'
grep -qx 'up -d --wait --wait-timeout 180 database' "$temporary/started" || fail 'An application listener started before schema verification'
rm "$temporary/committed"
reject hive_upgrade_schema_migrations "$temporary/candidate.json" "$temporary/manifest.$plan.json" "$temporary" true
[[ $(wc -l < "$temporary/applied") == "$count" ]] || fail 'An uncertain upgrade schema was replayed'
jq '.components.product.initialization.image="example.com/changed@sha256:'"$plan"'"' "$temporary/manifest.$plan.json" > "$temporary/next.json"; mv "$temporary/next.json" "$temporary/manifest.$plan.json"
reject hive_upgrade_schema_migrations "$temporary/candidate.json" "$temporary/manifest.$plan.json" "$temporary" true
[[ $(wc -l < "$temporary/applied") == "$count" ]] || fail 'Changed schema authority was executed'

# Promotion uses the upgrade path; a stable release cannot silently regress to its candidate.
(
  eval "$(sed -n '/^upgrade_version_allowed() {/,/^}/p' "$ROOT/scripts/suite/host-runtime.sh")"
  for pair in '2.4.0-rc.2 2.4.0 true' '2.4.0 2.4.0-rc.2 false' '2.4.0-rc.1 2.4.0-rc.2 true' '2.3.0 2.4.0-rc.1 true' '2.4.0 2.3.0 false'; do
    read -r from to expected <<< "$pair"
    if upgrade_version_allowed "$from" "$to"; then actual=true; else actual=false; fi
    [[ "$actual" == "$expected" ]] || fail 'Candidate/stable upgrade direction was wrong'
  done
)

# Production atomic writes must fail closed even in a conditional, where Bash disables errexit.
(
  eval "$(sed -n '/^atomic_json() {/,/^}/p' "$ROOT/scripts/suite/host-runtime.sh")"
  printf '{"kept":true}\n' > "$temporary/atomic.json"
  if printf 'not json' | atomic_json "$temporary/atomic.json" 2>/dev/null; then fail 'Invalid JSON was accepted'; fi
  jq -e '.kept==true' "$temporary/atomic.json" >/dev/null || fail 'A failed conditional write replaced the journal'
)
printf 'Passed: claimed initial migrations reconcile only through exact product verification, never replay unknown writes, retain protected diagnostics and reject changed journal specifications.\n'
