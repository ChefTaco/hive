#!/usr/bin/env bash
set -Eeuo pipefail
ROOT=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)
temporary=$(mktemp -d)
trap 'rm -rf -- "$temporary"' EXIT
directory="$temporary/owned"
mkdir -p "$directory/agents/synthetic-agent" "$temporary/bin"
jq --arg base "$directory" '.installation="status-proof" | .hosts.control.directory=$base | .agents=[{id:"synthetic-agent",host:"control",runtime:"magnus",version:"2.0.0",profileDirectory:($base+"/profile"),environmentFile:($base+"/profile.env"),service:"none",authorized:true}] | .console.runtimeFile=($base+"/config/runtime.json")' "$ROOT/examples/installation.json" > "$temporary/config.json"
printf '{"installation":"status-proof","host":"control","uuid":"synthetic-installation"}' > "$directory/installation.json"
printf '{"installed":true,"accepted":false,"operatorAuthorized":true,"preflightPassed":true,"runtime":"magnus","version":"2.0.0","privateExtra":"must-not-be-returned"}' > "$directory/agents/synthetic-agent/receipt.json"
printf '#!/usr/bin/env bash\ntouch %q\nprintf '\''[{"Service":"example","State":"running","Health":"healthy"}]\\n'\''\n' "$temporary/called" > "$temporary/bin/docker"
chmod 700 "$temporary/bin/docker"
PATH="$temporary/bin:$PATH" "$ROOT/hive.sh" status --config "$temporary/config.json" > "$temporary/status.json"
jq -e '.schema==1 and .host=="control" and .containers[0].Health=="healthy" and .nativeAgents[0].installed==true and .nativeAgents[0].accepted==false and (.nativeAgents[0]|has("privateExtra")|not)' "$temporary/status.json" >/dev/null
rm -- "$temporary/called"
printf '{"installation":"status-proof","host":"different","uuid":"synthetic-installation"}' > "$directory/installation.json"
if PATH="$temporary/bin:$PATH" "$ROOT/hive.sh" status --config "$temporary/config.json" > "$temporary/result" 2>&1; then printf 'FAIL: status read another host inventory\n' >&2; exit 1; fi
[[ ! -f "$temporary/called" ]]
printf 'Passed: native acceptance stays explicit beside healthy containers, private fields are excluded and host ownership precedes Docker reads.\n'
