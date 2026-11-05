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
jq --arg base "$directory" '.agents=["active","inactive","failed","unavailable","missing","transition"]|.agents |= map({id:("service-"+.),host:"control",runtime:"magnus",version:"2.0.0",profileDirectory:($base+"/profile"),environmentFile:($base+"/profile.env"),service:"user",authorized:true})' "$temporary/config.json" > "$temporary/user-services.json"
for state in active inactive failed unavailable missing transition; do
  mkdir -p "$directory/agents/service-$state"
  printf '{"installed":true,"accepted":true,"acceptedAt":"2026-01-01T00:00:00Z","operatorAuthorized":true,"privateExtra":"must-not-be-returned"}' > "$directory/agents/service-$state/receipt.json"
done
cat > "$temporary/bin/systemctl" <<'SYSTEMCTL'
#!/usr/bin/env bash
set -euo pipefail
[[ $# == 5 && $1 == --user && $2 == show && $4 == --property=LoadState && $5 == --property=ActiveState ]] || exit 90
case "$3" in
  *-service-active.service) printf 'LoadState=loaded\nActiveState=active\n';;
  *-service-inactive.service) printf 'LoadState=loaded\nActiveState=inactive\n';;
  *-service-failed.service) printf 'LoadState=loaded\nActiveState=failed\n';;
  *-service-unavailable.service) exit 1;;
  *-service-missing.service) printf 'LoadState=not-found\nActiveState=inactive\n';;
  *-service-transition.service) printf 'LoadState=loaded\nActiveState=activating\n';;
  *) exit 91;;
esac
SYSTEMCTL
chmod 700 "$temporary/bin/systemctl"
PATH="$temporary/bin:$PATH" "$ROOT/hive.sh" status --config "$temporary/user-services.json" > "$temporary/user-status.json"
jq -e '[.nativeAgents[].serviceState]==["active","inactive","failed","unavailable","unavailable","unavailable"] and all(.nativeAgents[]; .accepted==true and .acceptedAt=="2026-01-01T00:00:00Z" and (has("privateExtra")|not))' "$temporary/user-status.json" >/dev/null
jq -e '.nativeAgents[0].serviceState=="manual"' "$temporary/status.json" >/dev/null
rm -- "$temporary/called"
printf '{"installation":"status-proof","host":"different","uuid":"synthetic-installation"}' > "$directory/installation.json"
if PATH="$temporary/bin:$PATH" "$ROOT/hive.sh" status --config "$temporary/config.json" > "$temporary/result" 2>&1; then printf 'FAIL: status read another host inventory\n' >&2; exit 1; fi
[[ ! -f "$temporary/called" ]]
printf 'Passed: native acceptance stays explicit beside healthy containers, private fields are excluded and host ownership precedes Docker reads.\n'
