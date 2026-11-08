#!/usr/bin/env bash
# An upgrade that adds a component to an existing installation whose recorded storage formats
# predate it (such as Ardent Project Studio on an installation set up before Studio existed):
# with no store yet, the component starts at the release's format; data without a recorded
# format is still a transition that needs an explicit migration. No containers are started.
set -Eeuo pipefail
ROOT=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)
temporary=$(mktemp -d)
trap 'rm -rf -- "$temporary"' EXIT
fail() { printf 'FAIL: %s\n' "$*" >&2; exit 1; }
directory="$temporary/install"
mkdir -p "$directory" "$temporary/bin"
printf '#!/usr/bin/env bash\nprintf "%%s\\n" "$*" >> "%s/docker.log"\nexit 0\n' "$temporary" > "$temporary/bin/docker"; chmod 700 "$temporary/bin/docker"
export PATH="$temporary/bin:$PATH"
script=''
for file in ownership-host.sh public-runtime.sh integrity-host.sh input-artifacts-host.sh native-initialization-host.sh adapters-host.sh inference-registration.sh initialize-migrations-host.sh host-runtime.sh; do
  script+=$(cat "$ROOT/scripts/suite/$file")$'\n'
done
plan=$(printf '%064d' 7)
user="$(id -u):$(id -g)"
host() { # ACTION
  jq -nc --arg directory "$directory" --arg action "$1" --arg plan "$plan" --arg digest "$(printf '%064d' 2)" \
    '{directory:$directory,installation:"example-suite",host:"control",action:$action,plan:$plan,version:"0.2.0",digest:$digest,archive:"",operation:"upgrade",allowMigrations:false,abortStep:"",agents:[],inference:[],placements:{}}' |
    bash -c "$script" > "$temporary/host.log" 2>&1
}
service() { jq -nc --arg name "$1" --arg base "$directory" --arg user "$user" '{($name):{image:("example.com/"+$name+"@sha256:"+("0"*64)),user:$user,volumes:[{type:"bind",source:($base+"/data/"+$name),target:"/data"}]}}'; }
# The active deployment and the formats it recorded: Emberpath only. The release offers Studio
# now, which the installation's first release did not, so no Studio format is recorded.
reset() {
  rm -rf -- "$directory"; mkdir -p "$directory/data/emberpath"
  printf '{"installation":"example-suite","host":"control","uuid":"fixture"}' > "$directory/installation.json"
  service emberpath | jq '{name:"example-suite-control",services:.}' > "$directory/compose.json"
  printf '{"version":"0.1.0","digest":"%064d","plan":"%064d"}' 1 1 > "$directory/receipt.json"
  printf '{"emberpath":"emberpath-v1"}' > "$directory/data-formats.json"
  jq -n '{schema:1,version:"0.2.0",components:{emberpath:{storageFormat:"emberpath-v1"},ardentstudio:{storageFormat:"ardentstudio-v1"},cindertrace:{storageFormat:"cindertrace-v3"}}}' > "$directory/manifest.$plan.json"
  jq -n --argjson a "$(service emberpath)" --argjson b "$(service ardentstudio)" '{name:"example-suite-control",services:($a+$b)}' > "$directory/candidate.$plan.json"
  for file in signature."$plan" trust."$plan".pub controller."$plan".tar.gz; do : > "$directory/$file"; done
  ( directory=$directory plan=$plan; die() { exit 1; }; atomic_json() { jq . > "$1"; }; source "$ROOT/scripts/suite/input-artifacts-host.sh"; pin_deployment_inputs "$directory/candidate.$plan.json" )
  host prepare || { cat "$temporary/host.log" >&2; fail 'prepare failed'; }
}

# Studio is new here: no format, not deployed, no store. Compatibility and the migration step
# pass without --allow-migrations, and activation records the release's format before the store.
reset
host compatibility || { cat "$temporary/host.log" >&2; fail 'A new component without data was treated as a storage transition'; }
host migrate || { cat "$temporary/host.log" >&2; fail 'The migration step tried to migrate a new component'; }
if grep -q ' run ' "$temporary/docker.log" 2>/dev/null; then fail 'A migration command ran for a component with no data'; fi
host activate || { cat "$temporary/host.log" >&2; fail 'Activation of a new component failed'; }
jq -e '.=={"emberpath":"emberpath-v1","ardentstudio":"ardentstudio-v1"}' "$directory/data-formats.json" >/dev/null || fail "Activation did not record the new component's format: $(cat "$directory/data-formats.json")"
[[ -d "$directory/data/ardentstudio" && $(stat -c '%a %u:%g' "$directory/data/ardentstudio") == "700 $user" ]] || fail 'The new store was not created owned by its service'
jq -e '.services|has("ardentstudio")' "$directory/compose.json" >/dev/null || fail 'The new component was not activated'

# An empty store left from an earlier attempt is still nothing to migrate.
reset; mkdir -p "$directory/data/ardentstudio"
host compatibility || { cat "$temporary/host.log" >&2; fail 'An empty store was treated as a storage transition'; }

# Data without a recorded format is a real transition: refused without an explicit migration.
reset; mkdir -p "$directory/data/ardentstudio"; printf 'existing' > "$directory/data/ardentstudio/studio.sqlite"
if host compatibility; then fail 'Existing data without a recorded format skipped its transition'; fi
grep -q 'Storage transition needs --allow-migrations' "$temporary/host.log" || { cat "$temporary/host.log" >&2; fail 'Existing data lacks the transition refusal'; }

# A component already deployed without a recorded format is not new either.
reset; jq --argjson b "$(service ardentstudio)" '.services+=$b' "$directory/compose.json" > "$directory/next.json"; mv "$directory/next.json" "$directory/compose.json"
if host compatibility; then fail 'A deployed component without a recorded format skipped its transition'; fi
grep -q 'Storage transition needs --allow-migrations' "$temporary/host.log" || fail 'A deployed component lacks the transition refusal'

# A symlinked store is never taken as empty.
reset; ln -s "$temporary" "$directory/data/ardentstudio"
if host compatibility; then fail 'A symlinked store was taken as new'; fi

# A recorded format that differs is unchanged: still a transition.
reset; printf '{"emberpath":"emberpath-v1","ardentstudio":"ardentstudio-v0"}' > "$directory/data-formats.json"
if host compatibility; then fail 'A recorded older format skipped its transition'; fi
printf 'Passed: a component added by upgrade with no store starts at its release format, and existing, deployed, linked or recorded data still needs an explicit migration.\n'
