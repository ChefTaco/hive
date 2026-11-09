#!/usr/bin/env bash
set -Eeuo pipefail
HIVE_ROOT=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)
source "$HIVE_ROOT/scripts/suite/controller.sh"
source "$HIVE_ROOT/scripts/suite/magnus-agent.sh"
temporary=$(mktemp -d); trap 'rm -rf -- "$temporary"' EXIT
HIVE_CONFIG="$temporary/installation.json"
printf '{"bootstrap":{},"hosts":{"control":{"target":"local"}}}\n' > "$HIVE_CONFIG"
HIVE_AGENT_HOST=control HIVE_MAGNUS_HOST=control HIVE_AGENT_ON_CONSOLE=true
state=draining fail_inspect=false fixture_runtime_ready=true
hive_magnus_agent_release() { printf '{"version":"9.9.9"}\n'; }
hive_magnus_agent_enrollment_runtime() { printf 'agent-install\n' >> "$temporary/calls"; }
hive_magnus_agent_action() {
  local mode; mode=$(jq -r .mode <<< "$3"); printf '%s\n' "$mode" >> "$temporary/calls"
  case "$mode" in
    status) jq -nc --arg state "$state" --argjson ready "$fixture_runtime_ready" '{state:$state,agentRuntime:{version:(if $ready then "9.9.9" else "1.0.0" end),supervisor:$ready,terminalUser:""}}';;
    pause|resume|release) printf '{}\n';;
    inspect) [[ "$fail_inspect" != true ]] || return 1; printf '{"state":"review","reviewSHA256":"%s"}\n' "$(printf 'a%.0s' {1..64})";;
    apply) jq -e '.reviewSHA256==("a"*64)' <<< "$3" >/dev/null; printf '{"state":"enrolled"}\n';;
  esac
}
HIVE_CONFIRMED=false
if hive_magnus_agent_enroll '{"mode":"inspect"}' </dev/null > "$temporary/result" 2>&1; then exit 1; fi
[[ $(cat "$temporary/calls") == status ]]
: > "$temporary/calls"; HIVE_CONFIRMED=true
hive_magnus_agent_enroll '{"mode":"inspect"}' > "$temporary/result"
[[ $(cat "$temporary/calls") == $'status\npause\ninspect\napply\nrelease\nresume' ]]
: > "$temporary/calls"; fail_inspect=true
if hive_magnus_agent_enroll '{"mode":"inspect"}' > "$temporary/result" 2>&1; then exit 1; fi
[[ $(cat "$temporary/calls") == $'status\npause\ninspect\nrelease\nresume' ]]
: > "$temporary/calls"; state=enrolled
hive_magnus_agent_enroll '{"mode":"inspect"}' > "$temporary/result"
[[ $(cat "$temporary/calls") == $'status\nrelease\nresume' ]]
: > "$temporary/calls"; state=draining; fail_inspect=false; fixture_runtime_ready=false
hive_magnus_agent_enroll '{"mode":"inspect"}' > "$temporary/result"
[[ $(cat "$temporary/calls") == $'status\nagent-install\npause\ninspect\napply\nrelease\nresume' ]]
: > "$temporary/calls"; state=enrolled
hive_magnus_agent_enroll '{"mode":"inspect"}' > "$temporary/result"
[[ $(cat "$temporary/calls") == $'status\nagent-install\nrelease\nresume' ]]
printf 'Passed: full-node approval, pause/review/apply/resume, failed-review recovery and enrolled maintenance recovery.\n'
