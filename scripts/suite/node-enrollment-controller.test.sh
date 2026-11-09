#!/usr/bin/env bash
set -Eeuo pipefail
HIVE_ROOT=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)
source "$HIVE_ROOT/scripts/suite/controller.sh"
source "$HIVE_ROOT/scripts/suite/magnus-agent.sh"
temporary=$(mktemp -d); trap 'rm -rf -- "$temporary"' EXIT
HIVE_CONFIG="$temporary/installation.json"
printf '{"bootstrap":{},"hosts":{"control":{"target":"local"}}}\n' > "$HIVE_CONFIG"
HIVE_AGENT_HOST=control HIVE_MAGNUS_HOST=control HIVE_AGENT_ON_CONSOLE=true
state=draining fail_inspect=false fail_apply=false fail_terminal_preflight=false fixture_runtime_ready=true
hive_magnus_agent_release() { printf '{"version":"9.9.9"}\n'; }
hive_magnus_agent_enrollment_runtime() { printf 'agent-install\n' >> "$temporary/calls"; fixture_runtime_ready=true; }
hive_magnus_agent_action() {
  if [[ "$2" == magnus-agent-terminal-preflight ]]; then
    printf 'terminal-preflight\n' >> "$temporary/calls"
    [[ "$fail_terminal_preflight" != true ]] || return 1
    return 0
  fi
  local mode; mode=$(jq -r .mode <<< "$3"); printf '%s\n' "$mode" >> "$temporary/calls"
  case "$mode" in
    status)
      if [[ ${fail_status_readback:-false} == true && $(awk '$0=="status"{n++} END{print n+0}' "$temporary/calls") -gt 1 ]]; then return 1; fi
      jq -nc --arg state "$state" --argjson ready "$fixture_runtime_ready" '{state:$state,agentRuntime:{version:(if $ready then "9.9.9" else "1.0.0" end),supervisor:$ready,terminalUser:""}}';;
    pause|resume|release) printf '{}\n';;
    inspect)
      local count; count=$(awk '$0=="inspect"{n++} END{print n+0}' "$temporary/calls")
      [[ "$fail_inspect" != true && !( "$fail_inspect" == final && "$count" == 2 ) ]] || return 1
      # First discovery starts an allowed helper; only the subsequent snapshot is approved.
      if [[ "$count" == 1 ]]; then printf '{"state":"review","reviewSHA256":"%s"}\n' "$(printf 'a%.0s' {1..64})"
      else printf '{"state":"review","reviewSHA256":"%s"}\n' "$(printf 'b%.0s' {1..64})"; fi;;
    apply) jq -e '.reviewSHA256==("b"*64)' <<< "$3" >/dev/null; [[ "$fail_apply" != true ]] || return 1; printf '{"state":"enrolled"}\n';;
  esac
}
HIVE_CONFIRMED=false
if hive_magnus_agent_enroll '{"mode":"inspect"}' </dev/null > "$temporary/result" 2>&1; then exit 1; fi
[[ $(cat "$temporary/calls") == status ]]
: > "$temporary/calls"; HIVE_CONFIRMED=true
hive_magnus_agent_enroll '{"mode":"inspect"}' > "$temporary/result"
[[ $(cat "$temporary/calls") == $'status\npause\ninspect\ninspect\napply\nrelease\nresume' ]]
: > "$temporary/calls"; fail_inspect=true
if hive_magnus_agent_enroll '{"mode":"inspect"}' > "$temporary/result" 2>&1; then exit 1; fi
[[ $(cat "$temporary/calls") == $'status\npause\ninspect\nrelease\nresume' ]]
# A failed final snapshot or changed post-approval evidence stays held and resumes profiles.
: > "$temporary/calls"; fail_inspect=final
if hive_magnus_agent_enroll '{"mode":"inspect"}' > "$temporary/result" 2>&1; then exit 1; fi
[[ $(cat "$temporary/calls") == $'status\npause\ninspect\ninspect\nrelease\nresume' ]]
: > "$temporary/calls"; fail_inspect=false; fail_apply=true
if hive_magnus_agent_enroll '{"mode":"inspect"}' > "$temporary/result" 2>&1; then exit 1; fi
[[ $(cat "$temporary/calls") == $'status\npause\ninspect\ninspect\napply\nrelease\nresume' ]]
fail_apply=false
: > "$temporary/calls"; state=enrolled
hive_magnus_agent_enroll '{"mode":"inspect"}' > "$temporary/result"
[[ $(cat "$temporary/calls") == $'status\nrelease\nresume\nstatus' ]]
: > "$temporary/calls"; state=draining; fail_inspect=false; fixture_runtime_ready=false
hive_magnus_agent_enroll '{"mode":"inspect"}' > "$temporary/result"
[[ $(cat "$temporary/calls") == $'status\nagent-install\npause\ninspect\ninspect\napply\nrelease\nresume' ]]
: > "$temporary/calls"; state=enrolled
hive_magnus_agent_enroll '{"mode":"inspect"}' > "$temporary/result"
[[ $(cat "$temporary/calls") == $'status\nagent-install\nrelease\nresume\nstatus' ]]
jq -e '.agentRuntime.version=="9.9.9" and .agentRuntime.supervisor==true' "$temporary/result" >/dev/null
# Do not return a stale success when the repaired runtime cannot be read back.
: > "$temporary/calls"; fail_status_readback=true
if hive_magnus_agent_enroll '{"mode":"inspect"}' > "$temporary/result" 2>&1; then exit 1; fi
[[ $(cat "$temporary/calls") == $'status\nagent-install\nrelease\nresume\nstatus' ]]
fail_status_readback=false
# A selected gateway's machine routes must validate before profiles pause.
: > "$temporary/calls"; state=draining; fixture_runtime_ready=true
hive_magnus_agent_enroll '{"mode":"inspect","gatewaySelected":true}' > "$temporary/result"
[[ $(cat "$temporary/calls") == $'status\nterminal-preflight\npause\ninspect\ninspect\napply\nrelease\nresume' ]]
: > "$temporary/calls"; fail_terminal_preflight=true
if hive_magnus_agent_enroll '{"mode":"inspect","gatewaySelected":true}' > "$temporary/result" 2>&1; then exit 1; fi
[[ $(cat "$temporary/calls") == $'status\nterminal-preflight' ]]
: > "$temporary/calls"; state=enrolled
if hive_magnus_agent_enroll '{"mode":"inspect","gatewaySelected":true}' > "$temporary/result" 2>&1; then exit 1; fi
[[ $(cat "$temporary/calls") == $'status\nrelease\nresume\nterminal-preflight' ]]
printf 'Passed: discovery preparation, exact final-snapshot approval, pause/review/apply/resume, failed-review recovery and enrolled maintenance recovery.\n'
