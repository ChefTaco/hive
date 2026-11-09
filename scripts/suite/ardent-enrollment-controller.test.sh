#!/usr/bin/env bash
set -Eeuo pipefail
HIVE_ROOT=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)
source "$HIVE_ROOT/scripts/suite/controller.sh"
source "$HIVE_ROOT/scripts/suite/magnus-agent.sh"
temporary=$(mktemp -d)
trap 'rm -rf -- "$temporary"' EXIT
HIVE_CONFIG="$temporary/installation.json"
printf '{"bootstrap":{},"hosts":{"control":{"target":"local"}}}\n' > "$HIVE_CONFIG"
HIVE_AGENT_HOST=control HIVE_MAGNUS_HOST=control HIVE_AGENT_ON_CONSOLE=true
mode=review
hive_magnus_agent_action() {
  printf '%s\n' "$(jq -r .mode <<< "$3")" >> "$temporary/calls"
  if [[ $(jq -r .mode <<< "$3") == apply ]]; then
    jq -e '.reviewSHA256==("a"*64)' <<< "$3" >/dev/null
    printf '{"state":"active","changed":true}\n'
  elif [[ "$mode" == active ]]; then printf '{"state":"active","changed":false}\n'
  else printf '{"state":"review","reviewSHA256":"%s"}\n' "$(printf 'a%.0s' {1..64})"; fi
}
HIVE_CONFIRMED=false
if (hive_magnus_agent_prepare_ardent '{"mode":"inspect"}') </dev/null > "$temporary/result" 2>&1; then
  printf 'FAIL: an unapproved fresh review was applied\n' >&2; exit 1
fi
[[ $(cat "$temporary/calls") == inspect ]]
: > "$temporary/calls"
HIVE_CONFIRMED=true
hive_magnus_agent_prepare_ardent '{"mode":"inspect"}' > "$temporary/result"
[[ $(cat "$temporary/calls") == $'inspect\napply' ]]
: > "$temporary/calls"
mode=active
hive_magnus_agent_prepare_ardent '{"mode":"inspect"}' > "$temporary/result"
[[ $(cat "$temporary/calls") == inspect ]]
: > "$temporary/calls"
HIVE_AGENT_HOST=fleet
if (hive_magnus_agent_prepare_ardent '{"mode":"inspect"}') > "$temporary/result" 2>&1; then
  printf 'FAIL: another fleet host was treated as a fresh local installation\n' >&2; exit 1
fi
[[ ! -s "$temporary/calls" ]]
printf 'Passed: fresh review requires approval, binds its evidence, repeats without mutation, and refuses other fleet hosts.\n'
