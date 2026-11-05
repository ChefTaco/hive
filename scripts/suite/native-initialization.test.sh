#!/usr/bin/env bash
set -Eeuo pipefail
ROOT=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)
source "$ROOT/scripts/suite/native-initialization-host.sh"
temporary=$(mktemp -d)
trap 'rm -rf -- "$temporary"' EXIT
fail() { printf 'FAIL: %s\n' "$*" >&2; exit 1; }
reject() { if ( "$@" ) > "$temporary/rejection.log" 2>&1; then fail 'Unsafe native initialization was accepted'; fi; }
die() { printf 'Held: %s\n' "$*" >&2; exit 1; }
digest() { sha256sum -- "$1" | cut -d ' ' -f1; }
tree_digest() { (cd "$1"; find . -type f -print0 | sort -z | xargs -0 -r sha256sum --zero) | sha256sum | cut -d ' ' -f1; }
adapter_profile_digest() { tree_digest "$1"; }
atomic_json() { local pending; pending=$(mktemp "$temporary/pending.XXXXXX"); jq . > "$pending"; chmod 600 "$pending"; mv -T -- "$pending" "$1"; }
adapter_arguments() { mapfile -t HIVE_AGENT_ARGUMENTS < <(jq -r '.[]' <<< "$1"); }
adapter_native_command() { local profile=$1; shift; (cd "$profile"; "$@"); }
directory=$temporary plan=$(printf '0%.0s' {1..64})
mkdir -p "$temporary/agents/synthetic" "$temporary/profile" "$temporary/artifact"
chmod 700 "$temporary/profile"
printf 'synthetic protected configuration\n' > "$temporary/profile/config.yaml"
printf 'SYNTHETIC_ENV=fixture\n' > "$temporary/environment"
chmod 600 "$temporary/environment" "$temporary/profile/config.yaml"
export HIVE_NATIVE_INITIALIZATION_FIXTURE=$temporary
cat > "$temporary/artifact/agent" <<'AGENT'
#!/usr/bin/env bash
set -Eeuo pipefail
# A native command must never inherit the controller enumeration's stdin.
cat >/dev/null
case "$1" in
  init)
    printf 'apply\n' >> "$HIVE_NATIVE_INITIALIZATION_FIXTURE/applied"
    [[ ! -e "$HIVE_NATIVE_INITIALIZATION_FIXTURE/before-commit" ]] || exit 22
    mkdir -p cron sessions logs memories
    chmod 700 cron sessions logs memories
    [[ ! -e "$HIVE_NATIVE_INITIALIZATION_FIXTURE/after-commit" ]] || exit 23
    ;;
  verify)
    for path in cron sessions logs memories; do [[ -d "$path" && ! -L "$path" ]] || exit 24; done
    [[ ! -e "$HIVE_NATIVE_INITIALIZATION_FIXTURE/verify-failure" ]] || exit 25
    ;;
  *) exit 26;;
esac
AGENT
chmod 700 "$temporary/artifact/agent"
item=$(jq -nc --arg profile "$temporary/profile" --arg environment "$temporary/environment" '{id:"synthetic",runtime:"hermes",version:"1.0.0",profileDirectory:$profile,environmentFile:$environment,service:"none",authorized:true}')
artifact=$(jq -nc --arg sha "$plan" '{sha256:$sha,executable:"agent",initializationArguments:["init"],verificationArguments:["verify"]}')
initialize() { adapter_initialize_native "$item" "$artifact" "$temporary/artifact" "$temporary/artifact/agent"; }
state="$temporary/agents/synthetic/initialization.$plan.json"
touch "$temporary/after-commit"
reject initialize
jq -e '.phase=="claimed"' "$state" >/dev/null
[[ $(wc -l < "$temporary/applied") == 1 ]] || fail 'Initial native mutation not recorded'
rm "$temporary/after-commit"
initialize
jq -e '.phase=="verified"' "$state" >/dev/null
[[ $(wc -l < "$temporary/applied") == 1 ]] || fail 'Unknown committed native initialization was replayed'
printf 'expected later runtime state\n' > "$temporary/profile/logs/runtime.log"
initialize
[[ $(wc -l < "$temporary/applied") == 1 ]] || fail 'Verified initialization replayed after ordinary runtime writes'
touch "$temporary/verify-failure"
reject initialize
[[ $(wc -l < "$temporary/applied") == 1 ]] || fail 'Failed exact verification replayed initialization'
rm "$temporary/verify-failure"
jq '.phase="claimed"' "$state" > "$temporary/changed.json"; mv "$temporary/changed.json" "$state"
reject initialize
[[ $(wc -l < "$temporary/applied") == 1 ]] || fail 'Changed claimed profile state replayed initialization'
rm "$state"
item=$(jq '.authorized=false' <<< "$item")
initialize > "$temporary/pending.log"
[[ ! -e "$state" && $(wc -l < "$temporary/applied") == 1 ]] || fail 'Missing operator authorization mutated profile state'
item=$(jq '.authorized=true' <<< "$item")
artifact=$(jq 'del(.verificationArguments)' <<< "$artifact")
reject initialize
# A claim whose product never committed must remain held; removing a transient
# error is not proof that it is safe to replay the original mutation.
mkdir -m 700 "$temporary/profile-incomplete" "$temporary/agents/incomplete"
printf 'preserve incomplete profile config\n' > "$temporary/profile-incomplete/config.yaml"
chmod 600 "$temporary/profile-incomplete/config.yaml"
item=$(jq --arg profile "$temporary/profile-incomplete" '.id="incomplete"|.profileDirectory=$profile' <<< "$item")
artifact=$(jq '.verificationArguments=["verify"]' <<< "$artifact")
touch "$temporary/before-commit"
reject initialize
rm "$temporary/before-commit"
reject initialize
[[ $(wc -l < "$temporary/applied") == 2 ]] || fail 'Uncommitted native initialization was replayed'
jq -e '.phase=="claimed"' "$temporary/agents/incomplete/initialization.$plan.json" >/dev/null
# Simulate an explicitly completed product-owned recovery, without any installer
# mutation replay. Directory-only recovery preserves the original file baseline.
mkdir -m 700 "$temporary/profile-incomplete/cron" "$temporary/profile-incomplete/sessions" "$temporary/profile-incomplete/logs" "$temporary/profile-incomplete/memories"
initialize
[[ $(wc -l < "$temporary/applied") == 2 ]] || fail 'Native recovery verification replayed initialization'
source "$ROOT/scripts/suite/adapters.sh"
hive_die() { die "$@"; }
HIVE_CONFIG="$temporary/config.json" HIVE_MANIFEST="$temporary/release.json"
jq -nc --argjson item "$item" '{hosts:{control:{architecture:"amd64"}},agents:[($item+{host:"control"})]}' > "$HIVE_CONFIG"
jq -nc --argjson artifact "$(jq '.verificationArguments=["verify"]|.url="https://artifacts.example.com/agent.tgz"|.arguments=["run"]' <<< "$artifact")" '{components:{},agentArtifacts:{hermes:{"1.0.0":{amd64:$artifact}}}}' > "$HIVE_MANIFEST"
hive_adapter_manifest
cp "$HIVE_MANIFEST" "$temporary/valid-release.json"
for patch in 'del(.agentArtifacts.hermes["1.0.0"].amd64.verificationArguments)' '.agentArtifacts.hermes["1.0.0"].amd64.verificationArguments=[]' '.agentArtifacts.hermes["1.0.0"].amd64.initializationArguments=false' '.agentArtifacts.hermes["1.0.0"].amd64.initializationArguments=["unsafe\nargument"]'; do
  jq "$patch" "$temporary/valid-release.json" > "$HIVE_MANIFEST"
  reject hive_adapter_manifest
done
printf 'Passed: native initialization records mutation claims, reconciles committed interruptions by exact verification without replay, preserves ordinary runtime writes, rejects changed uncertain state and requires operator authorization plus a verification contract.\n'
